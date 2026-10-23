"""Find in the list (docs/ui/find.md): how notes read, what one step returns, and the
note a find opens for the view without saving its collapse."""

from __future__ import annotations

from typing import Dict, List, Optional

import pytest

import app.services.snapshot as snapshot
from app.services.find_text import count_occurrences, read_comment_text, read_visible_text
from app.services.search_index import SearchIndex, SearchRecord, extract_tags_for_search
from app.services.snapshot import build_view_state, find_in_view
from tests.unit.snapshot_note_fixture import SnapshotTestNote as _Note

HOST_ID = "11111111-1111-4111-8111-111111111111"
SOURCE_ID = "22222222-2222-4222-8222-222222222222"


class _FakeNoteStore:
    def __init__(self, notes: Dict[str, _Note], referrers: Dict[str, frozenset[str]]):
        self._notes = notes
        self._referrers = referrers

    def has_backlinks(self, note_id: str) -> bool:
        return note_id in self._referrers

    def has_note(self, note_id: str) -> bool:
        return note_id in self._notes

    def get_note(self, note_id: str) -> _Note:
        return self._notes[note_id]

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        children = {note.prev_id: note for note in self._notes.values() if note.parent_id == parent_id}
        ordered: List[str] = []
        previous_id: Optional[str] = None
        while previous_id in children:
            previous_id = children[previous_id].id
            ordered.append(previous_id)
        assert len(ordered) == len(children)
        return ordered

    def list_note_ids(self) -> List[str]:
        return list(self._notes)

    def get_referrer_ids(self, note_id: str) -> frozenset[str]:
        assert note_id in self._notes
        return self._referrers.get(note_id, frozenset())

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> frozenset[str]:
        assert note_id in self._notes
        return frozenset()


def _siblings(parent_id: Optional[str], specs: List[tuple[str, bool, str, str]]) -> Dict[str, _Note]:
    """Notes under one parent, in order: (id, is_collapsed, content, tags)."""
    ids: List[Optional[str]] = [None, *(spec[0] for spec in specs), None]
    notes: Dict[str, _Note] = {}
    for index, (note_id, is_collapsed, content, tags) in enumerate(specs, start=1):
        notes[note_id] = _Note(note_id, parent_id, ids[index - 1], ids[index + 1], is_collapsed, content, tags)
    return notes


def _install(monkeypatch: pytest.MonkeyPatch, notes: Dict[str, _Note], referrers: Dict[str, frozenset[str]]) -> None:
    index = SearchIndex()
    index.rebuild(
        [
            SearchRecord(note_id=note.id, content_text=note.content, tags=note.tags,
                         tag_terms=extract_tags_for_search(note.tags))
            for note in notes.values()
        ],
        raw_tag_terms_by_id={note.id: extract_tags_for_search(note.tags) for note in notes.values()},
        progress_update=lambda _: None,
        progress_interval=1000,
    )
    monkeypatch.setattr(snapshot, "note_store", _FakeNoteStore(notes, referrers))
    monkeypatch.setattr(snapshot, "search_index", index)
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})


def _find(text: str, *, from_root_index: int, direction: str, search: str) -> snapshot.FindWindow:
    return find_in_view(
        find_text=text, search=search, sort_mode="normal", date_filter=None, is_untagged_view=False,
        from_root_index=from_root_index, direction=direction,
    )


def _summary(window: snapshot.FindWindow) -> List[tuple]:
    return [
        (match.note_id, match.root_index, match.content_count, match.comment_count, match.preview_count,
         match.is_under_folded_note)
        for match in window.matches
    ]


def test_a_note_reads_as_the_browser_marks_read_it() -> None:
    # A block's end is a space, as in the browser's reading.
    assert read_visible_text("<div>One</div><div>two&amp;three</div>") == "One two&three "
    assert read_visible_text("<p>a  \n b<br>c</p>") == "a b c "
    assert read_visible_text("<span>in</span><b>line</b>") == "inline"
    assert read_comment_text("/*  a   comment */") == "/* a comment */"


def test_occurrences_are_counted_in_any_case_inside_words_and_overlapping() -> None:
    assert count_occurrences("The theme of them", "the") == 3
    assert count_occurrences("aaaa", "aa") == 3
    assert count_occurrences("father fat", "fat ") == 1
    with pytest.raises(ValueError):
        count_occurrences("text", "   ")


def test_a_step_lists_the_matches_in_list_order_with_what_shows_without_opening(monkeypatch) -> None:
    notes = _siblings(None, [
        ("a", False, "<div>apple pie, apple tart</div>", ""),
        ("b", False, "<div>nothing here</div>", "/* an apple */"),
        ("c", True, "<div>first line</div><div>an apple below</div>", ""),
        ("d", True, "<div>parent</div>", ""),
    ])
    notes.update(_siblings("d", [("d1", False, "<div>child apple</div>", "")]))
    _install(monkeypatch, notes, {})

    window = _find("apple", from_root_index=0, direction="forward", search="")

    assert _summary(window) == [
        ("a", 0, 2, 0, 2, False),
        ("b", 1, 0, 1, 0, False),
        # Folded: its first line shows no apple, so the one below needs opening.
        ("c", 2, 1, 0, 0, False),
        # Under a folded note.
        ("d1", 3, 1, 0, 1, True),
    ]
    assert (window.first_root_index, window.end_root_index, window.root_count) == (0, 4, 4)


def test_a_step_stops_after_the_root_where_enough_notes_matched(monkeypatch) -> None:
    notes = _siblings(None, [(f"r{index}", False, f"<div>word {index}</div>", "") for index in range(6)])
    _install(monkeypatch, notes, {})
    monkeypatch.setattr(snapshot, "FIND_WINDOW_MATCHED_NOTES", 2)

    first = _find("word", from_root_index=0, direction="forward", search="")
    assert [match.note_id for match in first.matches] == ["r0", "r1"]
    assert (first.first_root_index, first.end_root_index) == (0, 2)

    following = _find("word", from_root_index=first.end_root_index, direction="forward", search="")
    assert [match.note_id for match in following.matches] == ["r2", "r3"]
    assert (following.first_root_index, following.end_root_index) == (2, 4)

    # Backward from the list's end: the last matches, still in list order.
    last = _find("word", from_root_index=6, direction="backward", search="")
    assert [match.note_id for match in last.matches] == ["r4", "r5"]
    assert (last.first_root_index, last.end_root_index) == (4, 6)

    # A position the list has shrunk past is its end.
    assert _find("word", from_root_index=9, direction="forward", search="").matches == ()


def test_notes_without_the_text_are_never_rendered(monkeypatch) -> None:
    notes = _siblings(None, [("hit", False, "<div>rare word</div>", ""), ("miss", False, "<div>other</div>", "")])
    _install(monkeypatch, notes, {})
    rendered: List[str] = []
    real_render = snapshot._render_note_content_html

    def recording_render(rec, *, is_collapsed, context):
        rendered.append(rec.id)
        return real_render(rec, is_collapsed=is_collapsed, context=context)

    monkeypatch.setattr(snapshot, "_render_note_content_html", recording_render)
    assert [match.note_id for match in _find("rare", from_root_index=0, direction="forward", search="").matches] == ["hit"]
    assert rendered == ["hit"]


def test_a_search_placeholder_and_what_is_under_it_are_no_match(monkeypatch) -> None:
    notes = _siblings(None, [("root", False, "<div>apple root</div>", "fruit")])
    notes.update(_siblings("root", [
        ("kept", False, "<div>apple kept</div>", "fruit"),
        ("redacted", False, "<div>apple hidden</div>", ""),
    ]))
    notes.update(_siblings("redacted", [("deep", False, "<div>apple deep</div>", "")]))
    _install(monkeypatch, notes, {})

    window = _find("apple", from_root_index=0, direction="forward", search="fruit")

    assert [match.note_id for match in window.matches] == ["root", "kept"]


def test_an_embed_counts_its_source_text_in_the_note_showing_it(monkeypatch) -> None:
    notes = _siblings(None, [
        (HOST_ID, False, f"<div>host</div><div>![[{SOURCE_ID}]]</div>", ""),
        (SOURCE_ID, False, "<div>embedded apple</div>", ""),
    ])
    _install(monkeypatch, notes, {SOURCE_ID: frozenset({HOST_ID})})

    window = _find("apple", from_root_index=0, direction="forward", search="")

    assert [(match.note_id, match.content_count) for match in window.matches] == [(HOST_ID, 1), (SOURCE_ID, 1)]


def test_the_note_find_opened_shows_open_for_the_view_only(monkeypatch) -> None:
    notes = _siblings(None, [("top", True, "<div>top</div>", ""), ("after", False, "<div>after</div>", "")])
    notes.update(_siblings("top", [("middle", True, "<div>middle line</div><div>apple</div>", "")]))
    notes.update(_siblings("middle", [("leaf", False, "<div>leaf</div>", "")]))
    _install(monkeypatch, notes, {})

    def view(find_reveal_note_id):
        return build_view_state(
            editing_note_id=None, find_reveal_note_id=find_reveal_note_id, search=None, sort_mode="normal", date_filter=None,
            client_known_note_ids=set(), previous_root_ids=[], visible_top_root_id=None,
            visible_bottom_root_id=None, is_untagged_view=False, start_at_list_end=False,
        )

    folded = view(None)
    assert [entry["id"] for entry in folded.structure] == ["top", "after"]

    opened = view("middle")
    assert [entry["id"] for entry in opened.structure] == ["top", "middle", "leaf", "after"]
    assert opened.payloads["top"]["flags"]["isCollapsed"] is False
    assert opened.payloads["middle"]["flags"]["isCollapsed"] is False
    assert "apple" in opened.payloads["middle"]["content"]
    # Saved collapse is untouched.
    assert notes["top"].is_collapsed is True and notes["middle"].is_collapsed is True

    # A note that is gone opens nothing.
    assert [entry["id"] for entry in view("gone").structure] == ["top", "after"]
