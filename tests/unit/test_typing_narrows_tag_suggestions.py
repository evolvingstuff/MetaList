"""Typing in the tag bar only narrows the suggestions, at any length (docs/ui/tag-bar.md,
"Tag Suggestions"): `q` → `qu` → `que` removes the tags that stop matching and keeps
the rest in order. A tag that already applies (`question`, from the parent) stayed
first after `q` but dropped to the bottom after `qu` (2026-10-21)."""

from __future__ import annotations

import pytest

import app.services.tag_suggestions as tag_suggestions_module
from app.models.database import SafeSession
from app.security.encryption import clear_encryption_key, set_encryption_required
from app.services import auth_service
from app.services.content_cache import clear_cache
from app.services.file_registry import file_registry
from app.services.note_store import store
from app.services.ontology_rules_store import bootstrap_ontology_rules_store
from app.services.tag_suggestions import suggest_tags_for_note
from app.services.tag_term_matching import tag_term_matches_prefix
from app.usecases.create_note import apply_insert_note

_LIMIT = 20
# Used this often on other notes, so the usage order is fixed.
_USES = (("quote", 9), ("questions", 7), ("QQQ", 5), ("Quanta-Magazine", 4), ("air-quality", 1),
         ("beg-the-question", 1), ("code-quality", 1), ("conditional-quantiles", 1), ("question", 3))
_QUESTION = "should we require customers to have their own AI plans?"


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
    apply_insert_note(note_id, parent_id, None, None, "", content=f"<div>{content}</div>", tags=tags,
                      proposed_tags="")


def _business_notes(*, text: str) -> None:
    for tag, uses in _USES:
        for index in range(uses):
            _note(f"{tag}-{index}", None, content="other", tags=tag)
    # `question` applies to the note through its parent.
    _note("plans", None, content="ML3 business questions", tags="question")
    _note("ask", "plans", content=text, tags="ML3-business")


def _typed(prefix: str) -> list[str]:
    """The tag bar sends what is typed as its last token."""
    return suggest_tags_for_note(
        note_id="ask", anchors=["ML3-business"], explicit_tags=["ML3-business", prefix], prefix=prefix,
        content_html=store.get_note("ask").content, limit=_LIMIT,
    )


def _narrowed(shorter: list[str], prefix: str) -> list[str]:
    return [tag for tag in shorter if tag_term_matches_prefix(term=tag, prefix=prefix)]


def test_each_letter_only_narrows_and_a_tag_that_already_applies_stays_first(live_database) -> None:
    _business_notes(text=_QUESTION)

    after_q = _typed("q")
    after_qu = _typed("qu")
    after_que = _typed("que")

    assert after_q == ["question", "quote", "questions", "QQQ", "Quanta-Magazine", "air-quality",
                       "beg-the-question", "code-quality", "conditional-quantiles"]
    assert after_qu == ["question", "quote", "questions", "Quanta-Magazine", "air-quality",
                        "beg-the-question", "code-quality", "conditional-quantiles"]
    assert after_que == ["question", "questions", "beg-the-question"]
    assert after_qu == _narrowed(after_q, "qu")
    assert after_que == _narrowed(after_qu, "que")


def test_a_tag_the_note_names_comes_before_one_that_already_applies_at_every_length(live_database) -> None:
    _business_notes(text=f"{_QUESTION} Compare conditional quantiles.")

    after_q = _typed("q")
    after_qu = _typed("qu")
    after_quan = _typed("quan")

    assert after_q[:3] == ["conditional-quantiles", "question", "quote"]
    assert after_qu[:3] == ["conditional-quantiles", "question", "quote"]
    assert after_quan == ["conditional-quantiles", "Quanta-Magazine"]
    assert after_qu == _narrowed(after_q, "qu")
    assert after_quan == _narrowed(after_qu, "quan")


def test_backspacing_gives_the_shorter_list_back(live_database) -> None:
    _business_notes(text=_QUESTION)

    first = _typed("qu")
    _typed("que")

    assert _typed("qu") == first


def test_a_change_to_the_namespace_while_typing_reaches_the_next_letter(live_database) -> None:
    _business_notes(text=_QUESTION)
    assert "quiche" not in _typed("qu")

    # Used more often than `quote`.
    for index in range(10):
        _note(f"quiche-{index}", None, content="other", tags="quiche")

    assert _typed("qu")[:3] == ["question", "quiche", "quote"]


def test_typing_ranks_the_empty_bar_once_per_tag(live_database, monkeypatch) -> None:
    # Each further letter only filters: typing costs one ranking, not one per letter.
    _business_notes(text=_QUESTION)
    rankings = []
    rank = tag_suggestions_module._suggest_tags

    def counted(**kwargs):
        rankings.append(kwargs["note_id"])
        return rank(**kwargs)

    monkeypatch.setattr(tag_suggestions_module, "_suggest_tags", counted)
    for prefix in ("q", "qu", "que", "qu"):
        _typed(prefix)
    assert rankings == ["ask"]

    _note("quiche-0", None, content="other", tags="quiche")
    _typed("qu")
    assert rankings == ["ask", "ask"]
