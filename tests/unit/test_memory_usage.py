"""The Memory Usage dialog's numbers: the server process's memory, and the notes it holds."""

import gc
import sys

import pytest

import app.api.routes.notes as notes_routes
from app.models.database import SafeSession
from app.process_memory import BYTES_PER_MEGABYTE
from app.security.encryption import clear_encryption_key, set_encryption_required
from app.services import auth_service
from app.services.content_cache import clear_cache
from app.services.file_registry import file_registry
from app.services import memory_breakdown
from app.services.memory_usage import describe_memory_usage
from app.services.note_store import store
from app.services.ontology_rules_store import bootstrap_ontology_rules_store
from app.usecases.create_note import apply_insert_note

SHARED_TEXT_LENGTH = 1000


@pytest.fixture
def live_database(tmp_path, monkeypatch):
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "fixture.metalist.db")
    monkeypatch.setattr(SafeSession, "_use_memory", False)
    clear_encryption_key()
    set_encryption_required(False)
    clear_cache()
    store.reset()
    file_registry.reset()
    session = SafeSession()
    auth_service.AuthService(session).initialize_settings()
    bootstrap_ontology_rules_store(connection=session.connection())
    store.load_from_db(None, prefetched_rows=[])
    yield session
    session.close()
    store.reset()
    clear_cache()
    file_registry.reset()


def test_the_notes_held_and_their_text_are_counted(live_database) -> None:
    apply_insert_note("a", None, None, None, "", content="<p>Héllo</p>", tags="trip", proposed_tags="")
    apply_insert_note("b", None, "a", None, "", content="<p>Two</p>", tags="", proposed_tags="")
    usage = describe_memory_usage()
    assert usage["notesLoaded"] is True
    assert usage["noteCount"] == 2
    held = "<p>Héllo</p>trip<p>Two</p>"
    assert usage["noteTextBytes"] == len(held.encode("utf-8"))
    assert usage["residentBytes"] > 0 and usage["peakResidentBytes"] >= usage["residentBytes"] - BYTES_PER_MEGABYTE
    assert usage["uptimeSeconds"] >= 0


def test_a_locked_namespace_reports_no_notes_held() -> None:
    store.reset()
    usage = describe_memory_usage()
    assert (usage["notesLoaded"], usage["noteCount"], usage["noteTextBytes"]) == (False, 0, 0)


def test_the_route_requires_a_session(monkeypatch) -> None:
    calls = []

    def require_token(request):
        calls.append(request)
        return "token"

    monkeypatch.setattr(notes_routes, "_require_bearer_token", require_token)
    usage = notes_routes.get_memory_usage(request="request")
    assert calls == ["request"] and set(usage) == {
        "residentBytes", "peakResidentBytes", "notesLoaded", "noteCount", "noteTextBytes", "uptimeSeconds",
        "lastUnlock",
    }


def test_the_breakdown_counts_a_shared_object_once_and_finishes_on_cycles() -> None:
    shared = "x" * SHARED_TEXT_LENGTH
    first = {"a": shared}
    second = {"b": shared, "loop": None}
    second["loop"] = second
    counted = memory_breakdown._PackedIdSet()
    first_size = memory_breakdown._deep_size(first, counted)
    second_size = memory_breakdown._deep_size(second, counted)
    assert first_size >= sys.getsizeof(shared)
    # The second holds the same string, already counted, and a reference to itself.
    assert second_size < sys.getsizeof(shared)


def test_the_breakdown_gives_no_dataclass_a_dict_it_did_not_have(live_database) -> None:
    apply_insert_note("a", None, None, None, "", content="<p>One</p>", tags="trip", proposed_tags="")
    record = store.get_note("a")
    assert not _has_materialized_dict(record)
    memory_breakdown.measure_memory_breakdown()
    assert not _has_materialized_dict(record)


def _has_materialized_dict(obj: object) -> bool:
    # gc.get_referents lists an instance's dict only once something has created it.
    return any(isinstance(referent, dict) for referent in gc.get_referents(obj))


def test_the_breakdown_measures_every_part_of_a_loaded_namespace(live_database) -> None:
    previous = None
    for index in range(20):
        apply_insert_note(f"n{index}", None, previous, None, "", content=f"<p>Note {index}</p>", tags="trip", proposed_tags="")
        previous = f"n{index}"
    breakdown = memory_breakdown.measure_memory_breakdown()
    labels = [part["label"] for part in breakdown["parts"]]
    assert labels == [
        "Note text cache", "Note store (tree, tags, references)", "Search index", "Rendered note views",
        "Open views per tab", "Link titles", "Attachments index", "Undo history",
    ]
    sizes = {part["label"]: part["bytes"] for part in breakdown["parts"]}
    assert sizes["Note store (tree, tags, references)"] > 0 and sizes["Search index"] > 0
    assert breakdown["seconds"] >= 0
    # The note store and search index list their fields, largest first, within their total.
    fields = {part["label"]: part["fields"] for part in breakdown["parts"]}
    for label in ("Note store (tree, tags, references)", "Search index"):
        field_sizes = [field["bytes"] for field in fields[label]]
        assert field_sizes == sorted(field_sizes, reverse=True) and 0 < sum(field_sizes) <= sizes[label]
    assert "tag_notes_casefold" in {field["label"] for field in fields["Search index"]}
    assert fields["Note text cache"] == [] and fields["Undo history"] == []


def test_the_breakdown_route_requires_a_session(monkeypatch) -> None:
    calls = []

    def require_token(request):
        calls.append(request)
        return "token"

    monkeypatch.setattr(notes_routes, "_require_bearer_token", require_token)
    breakdown = notes_routes.get_memory_breakdown(request="request")
    assert calls == ["request"] and set(breakdown) == {"parts", "seconds"}


@pytest.mark.parametrize("holders", [
    lambda shared: {"list": [shared], "tuple": (shared,)},
    lambda shared: {"set": {shared}, "list": [shared]},
    lambda shared: {"key": shared, "values": [shared]},
])
def test_an_object_two_containers_share_is_counted_once_whatever_they_are(holders) -> None:
    # A list's items once reached the walk with one reference fewer than a set's, so
    # an object a list and a tuple both held was counted twice.
    # Built at run time: a literal "y" * 1000 is a constant of the compiled test, one
    # more reference.
    shared = "y" * SHARED_TEXT_LENGTH
    string_size = sys.getsizeof(shared)
    held = holders(shared)
    # Only the two containers may hold it: a local name would be one more reference.
    del shared
    counted = memory_breakdown._PackedIdSet()
    assert memory_breakdown._deep_size(held, counted) < 2 * string_size
