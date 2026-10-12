"""About a tag already in a note's tag bar or in the search box (right-click).

Facts, not reasons: each case checks the exact lines for one kind of fact.
"""

from __future__ import annotations

from datetime import date

import pytest

import app.api.routes.notes as notes_route
import app.services.tag_details as tag_details_module
from app.services.search_history import TagActivityWindowSelection
from tests.unit.test_segment_aware_tag_suggestions import _EmptyOntology
from tests.unit.test_segment_aware_tag_suggestions import _FakeHierarchyNoteStore
from tests.unit.test_segment_aware_tag_suggestions import _build_index
from tests.unit.test_segment_aware_tag_suggestions import _build_note_record
from tests.unit.test_segment_aware_tag_suggestions import _build_ontology


def _use(monkeypatch: pytest.MonkeyPatch, *, notes, inherited, ontology) -> None:
    """notes: (id, parent, text, tags); `current` is the note right-clicked."""
    store = _FakeHierarchyNoteStore(
        records=[
            _build_note_record(note_id=note_id, parent_id=parent, content=text, tags=tags)
            for note_id, parent, text, tags in notes
        ],
        inherited_non_meta_by_note={"current": frozenset(inherited)},
    )
    monkeypatch.setattr(tag_details_module, "note_store", store)
    monkeypatch.setattr(tag_details_module, "search_index", _build_index([(note_id, tags) for note_id, _p, _t, tags in notes]))
    monkeypatch.setattr(tag_details_module, "get_ontology", lambda: ontology)
    monkeypatch.setattr(tag_details_module, "count_recent_tag_activity", lambda *, tag, window_days, token, today: [])


def _about(*, tag: str, tags_text: str, text: str) -> tuple[str, ...]:
    return tag_details_module.describe_tag_bar_tag(
        note_id="current", tag=tag, tags_text=tags_text, content_html=f"<p>{text}</p>",
    )


def _about_search(*, query: str, tag: str) -> tuple[str, ...]:
    start = query.index(tag)
    is_excluded = start > 0 and query[start - 1] == "-"
    if is_excluded:
        start -= 1
    return tag_details_module.describe_search_tag(
        query=query, tag=tag, start=start, end=query.index(tag) + len(tag), is_excluded=is_excluded,
        window_days=(1, 7, 30), token="token", today=date(2026, 10, 12),
    )


_SLEEP_NOTES = [
    ("current", None, "slept poorly", "sleep slept-poorly"),
    ("a", None, "night", "sleep slept-poorly"),
    ("b", None, "night", "sleep slept-poorly"),
    ("c", None, "night", "sleep"),
]


def test_a_tag_named_in_the_note_and_going_with_its_other_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, notes=_SLEEP_NOTES, inherited=(), ontology=_EmptyOntology())
    assert _about(tag="slept-poorly", tags_text="sleep slept-poorly", text="slept poorly") == (
        'Named in this note: "slept poorly"',
        'On 2 other notes together with "sleep"',
        "You've tagged 3 notes with it",
    )


def test_a_tag_only_this_note_has(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, notes=[("current", None, "night", "sleep zlept"), ("c", None, "x", "sleep")], inherited=(),
         ontology=_EmptyOntology())
    assert _about(tag="zlept", tags_text="sleep zlept", text="night") == ("Only on this note",)


def test_a_tag_just_typed(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, notes=[("current", None, "night", "sleep")], inherited=(), ontology=_EmptyOntology())
    assert _about(tag="brandnew", tags_text="sleep brandnew", text="night") == ("Not on any saved note yet",)


def test_a_tag_a_parent_already_gives(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = [("parent", None, "trip", "japan"), ("current", "parent", "day 1", "japan"), ("d", None, "x", "japan")]
    _use(monkeypatch, notes=notes, inherited=("japan",), ontology=_EmptyOntology())
    assert _about(tag="japan", tags_text="japan", text="day 1") == (
        "Also inherited from a parent note", "You've tagged 3 notes with it",
    )


def test_tag_relationships(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = [("current", None, "a walk", "maple tree mood"), ("e", None, "x", "emotion")]
    _use(monkeypatch, notes=notes, inherited=(), ontology=_build_ontology(text="maple => tree\nmood = emotion\n"))
    assert _about(tag="tree", tags_text="maple tree mood", text="a walk") == (
        'Also implied by "maple"', "Only on this note",
    )
    assert _about(tag="maple", tags_text="maple tree mood", text="a walk")[-2:] == ('Implies "tree"', "Only on this note")
    assert _about(tag="mood", tags_text="maple tree mood", text="a walk")[-2:] == (
        'A synonym of "emotion"', "Only on this note",
    )


def test_a_meta_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, notes=[("current", None, "x", "@todo"), ("t", None, "y", "@todo")], inherited=(),
         ontology=_EmptyOntology())
    assert _about(tag="@todo", tags_text="@todo", text="x") == ("A built-in tag", "You've tagged 2 notes with it")


_TRAVEL_NOTES = [
    ("current", None, "x", "other"),
    ("k1", None, "x", "travel kyoto"),
    ("k2", None, "x", "travel kyoto"),
    ("k3", None, "x", "kyoto"),
    ("t1", None, "x", "travel"),
    ("t2", None, "x", "travel"),
]


def test_a_search_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, notes=_TRAVEL_NOTES, inherited=(), ontology=_EmptyOntology())
    assert _about_search(query="kyoto", tag="kyoto") == ("Searching for it finds 3 notes",)
    assert _about_search(query="travel kyoto", tag="kyoto") == (
        "Searching for it finds 3 notes", 'On 2 notes together with "travel"',
    )
    assert _about_search(query="kyotoo", tag="kyotoo") == ("No note has this tag",)


def test_an_excluded_search_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, notes=_TRAVEL_NOTES, inherited=(), ontology=_EmptyOntology())
    assert _about_search(query="travel -kyoto", tag="kyoto") == (
        "Leaving it out removes 2 of the 4 notes the rest of your search finds",
    )
    assert _about_search(query="-kyoto", tag="kyoto") == ("Leaving it out removes 3 of your 6 notes",)


def test_a_search_tag_also_finds_its_synonyms_and_the_tags_implying_it(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = [("current", None, "x", "maple"), ("t", None, "x", "tree"), ("m", None, "x", "mood emotion")]
    _use(monkeypatch, notes=notes, inherited=(), ontology=_build_ontology(text="maple => tree\nmood = emotion\n"))
    assert _about_search(query="tree", tag="tree") == (
        "Searching for it finds 1 note", 'Also finds notes tagged "maple", which implies it',
    )
    assert _about_search(query="mood", tag="mood") == (
        "Searching for it finds 1 note", 'Also finds notes tagged "emotion"',
    )


def test_recent_work_with_a_search_tag(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, notes=_TRAVEL_NOTES, inherited=(), ontology=_EmptyOntology())
    monkeypatch.setattr(
        tag_details_module, "count_recent_tag_activity",
        lambda *, tag, window_days, token, today: [
            TagActivityWindowSelection(tag=tag, window_days=7, activity_count=12),
            TagActivityWindowSelection(tag=tag, window_days=30, activity_count=40),
        ],
    )
    assert _about_search(query="kyoto", tag="kyoto") == (
        "Searching for it finds 3 notes", "You've worked with it 12 times in the last 7 days",
    )


def test_the_routes_pass_the_tag_and_return_its_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(notes_route, "_require_note_present", lambda note_id, *, context: None)
    monkeypatch.setattr(notes_route, "_require_bearer_token", lambda request: "session-token")
    monkeypatch.setattr(notes_route, "current_local_date", lambda: date(2026, 10, 12))
    monkeypatch.setattr(
        notes_route, "describe_tag_bar_tag",
        lambda **kwargs: captured.update(tag_bar=kwargs) or ("Only on this note",),
    )
    monkeypatch.setattr(
        notes_route, "describe_search_tag",
        lambda **kwargs: captured.update(search=kwargs) or ("Searching for it finds 3 notes",),
    )

    assert notes_route.tag_details(
        {"note_id": "note-1", "tag": "zlept", "tags_text": "sleep zlept", "content_html": "<p>night</p>"},
    ) == {"lines": ["Only on this note"]}
    assert captured["tag_bar"] == {
        "note_id": "note-1", "tag": "zlept", "tags_text": "sleep zlept", "content_html": "<p>night</p>",
    }
    assert notes_route.search_tag_details(
        object(),
        {"query": "travel -kyoto", "tag": "kyoto", "start": 7, "end": 13, "excluded": True, "windowDays": [1, 7]},
    ) == {"lines": ["Searching for it finds 3 notes"]}
    assert captured["search"] == {
        "query": "travel -kyoto", "tag": "kyoto", "start": 7, "end": 13, "is_excluded": True,
        "window_days": (1, 7), "token": "session-token", "today": date(2026, 10, 12),
    }
