"""Suggestions leave out another spelling of a tag the note has: with `egg` on the
note, neither the tag bar nor the AI offers `eggs` (docs/ui/tag-bar.md, "Tag
Suggestions"). Anything that matches typed text is still offered."""

from __future__ import annotations

import pytest

import app.usecases.tag_proposals as proposal_module
from app.models.database import SafeSession
from app.security.encryption import clear_encryption_key, set_encryption_required
from app.services import auth_service
from app.services.content_cache import clear_cache
from app.services.file_registry import file_registry
from app.services.note_store import store
from app.services.ontology_rules_store import bootstrap_ontology_rules_store
from app.services.tag_plural_variants import PluralSpellings
from app.services.tag_suggestions import suggest_tags_for_note
from app.usecases.bulk_tag_proposals import prepare_proposal_changes
from app.usecases.create_note import apply_insert_note

_LIMIT = 20
_VIEWPORT = {"scrollY": 0, "scrollAnchor": None}


@pytest.mark.parametrize(
    ("tag", "variant"),
    (
        ("egg", "eggs"),
        ("eggs", "egg"),
        ("Egg", "EGGS"),
        ("berry", "berries"),
        ("day", "days"),
        ("tie", "ties"),
        ("box", "boxes"),
        ("church", "churches"),
        ("potato", "potatoes"),
        ("knife", "knives"),
        ("leaf", "leaves"),
        ("analysis", "analyses"),
        ("fireman", "firemen"),
        ("cactus", "cacti"),
        ("child", "children"),
        ("mouse", "mice"),
        ("easter-egg", "easter-eggs"),
        ("eggs/benedict", "egg/benedict"),
    ),
)
def test_singular_and_plural_spellings_are_one_tag(tag: str, variant: str) -> None:
    assert PluralSpellings([tag]).covers(variant)


@pytest.mark.parametrize(
    ("tag", "other"),
    (
        ("egg", "egg"),
        ("egg", "Egg"),
        ("egg", "eggplant"),
        ("easter-egg", "easter_eggs"),
        ("berry", "berrys-ies"),
        ("ty", "ties"),
        ("ai", "ais"),
        ("1990", "1990s"),
        ("abc=xyz", "abc=xyzs"),
        ("@red", "@reds"),
        ("bus", "bi"),
    ),
)
def test_other_differences_are_not_singular_and_plural(tag: str, other: str) -> None:
    assert not PluralSpellings([tag]).covers(other)


def test_a_tag_among_them_is_still_another_spelling_of_one_of_the_others() -> None:
    # The note has `avocado`; its synonym `avocados` applies through the rules, so it is among them.
    assert PluralSpellings(["avocado", "avocados"]).covers("avocados")
    assert not PluralSpellings(["avocados"]).covers("avocados")


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
    clear_encryption_key()
    set_encryption_required(False)


def _note(note_id: str, parent_id: str | None, *, content: str, tags: str) -> None:
    apply_insert_note(note_id, parent_id, None, None, "", content=content, tags=tags, proposed_tags="")


def _suggest(note_id: str, *, tags: list[str], prefix: str) -> list[str]:
    return suggest_tags_for_note(
        note_id=note_id, anchors=tags, explicit_tags=tags, prefix=prefix,
        content_html=store.get_note(note_id).content, limit=_LIMIT,
    )


@pytest.fixture
def breakfast_notes(live_database):
    # `eggs` and `toast` both come with `breakfast` on other notes.
    _note("omelette", None, content="<div>Omelette</div>", tags="breakfast eggs toast")
    _note("frittata", None, content="<div>Frittata</div>", tags="breakfast eggs toast")
    _note("scramble", None, content="<div>Scrambled</div>", tags="breakfast egg")


def test_the_empty_tag_bar_leaves_out_the_plural_of_a_tag_the_note_has(breakfast_notes) -> None:
    suggestions = _suggest("scramble", tags=["breakfast", "egg"], prefix="")

    assert "toast" in suggestions
    assert "eggs" not in suggestions


def test_the_empty_tag_bar_still_offers_it_without_the_singular(breakfast_notes) -> None:
    assert "eggs" in _suggest("scramble", tags=["breakfast"], prefix="")


def test_typed_text_offers_every_spelling_that_matches_it(breakfast_notes) -> None:
    assert "eggs" in _suggest("scramble", tags=["breakfast", "egg"], prefix="eg")


def test_a_tag_inherited_from_a_parent_also_hides_its_plural(live_database) -> None:
    _note("omelette", None, content="<div>Omelette</div>", tags="breakfast eggs toast")
    _note("frittata", None, content="<div>Frittata</div>", tags="breakfast eggs toast")
    _note("recipes", None, content="<div>Recipes</div>", tags="egg")
    _note("scramble", "recipes", content="<div>Scrambled</div>", tags="breakfast")

    suggestions = _suggest("scramble", tags=["breakfast"], prefix="")

    assert "toast" in suggestions
    assert "eggs" not in suggestions


def test_ai_proposals_leave_out_spellings_of_tags_the_note_has_or_proposes(live_database, monkeypatch) -> None:
    _note("scramble", None, content="<div>Scrambled</div>", tags="egg")
    monkeypatch.setattr(proposal_module, "record_tag_sources_batch", lambda *args, **kwargs: None)

    def add(tags: tuple[str, ...]) -> dict[str, object]:
        return proposal_module.CmdAddTagProposals(
            note_id="scramble", proposals={"scramble": tags}, token="", client_id="client",
            undo_context="context", viewport=_VIEWPORT,
        ).execute()

    assert add(("eggs", "berries", "toast", "berry"))["added"] == {"scramble": ["berries", "toast"]}
    assert store.get_note("scramble").proposed_tags == "berries toast"
    # A pending proposal counts as the note's too.
    assert add(("berry", "Toasts"))["status"] == "unchanged"


def test_bulk_ai_proposals_leave_out_spellings_of_tags_the_note_has(live_database) -> None:
    _note("scramble", None, content="<div>Scrambled</div>", tags="egg")

    changes, count, affected = prepare_proposal_changes(
        ("scramble",), "generate", "", {"scramble": ("eggs", "toast", "toasts")},
    )

    assert changes == {"scramble": ("egg", "toast")}
    assert (count, affected) == (1, {"scramble": ("toast",)})
