"""The Memory Usage dialog's numbers: the server process's memory, and the notes it holds."""

import pytest

import app.api.routes.notes as notes_routes
from app.models.database import SafeSession
from app.process_memory import BYTES_PER_MEGABYTE
from app.security.encryption import clear_encryption_key, set_encryption_required
from app.services import auth_service
from app.services.content_cache import clear_cache
from app.services.file_registry import file_registry
from app.services.memory_usage import describe_memory_usage
from app.services.note_store import store
from app.services.ontology_rules_store import bootstrap_ontology_rules_store
from app.usecases.create_note import apply_insert_note


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
    }
