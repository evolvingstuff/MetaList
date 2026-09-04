from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

import pytest

from app.services.search_index import SearchIndex, SearchRecord, extract_tags_for_search
from app.services.snapshot import build_view_state


@dataclass(frozen=True)
class _Note:
    id: str
    parent_id: Optional[str]
    prev_id: Optional[str]
    next_id: Optional[str]
    is_collapsed: bool
    content: str
    tags: str
    created_at: datetime = datetime(2026, 1, 1, tzinfo=timezone.utc)
    updated_at: datetime = datetime(2026, 1, 2, tzinfo=timezone.utc)
    proposed_tags: str = ""
    proposed_tag_terms: frozenset[str] = frozenset()


class _FakeNoteStore:
    def __init__(self, *, notes: Dict[str, _Note], children_by_parent: Dict[Optional[str], List[str]]):
        self._notes = notes
        self._children_by_parent = children_by_parent

    def has_note(self, note_id: str) -> bool:
        return note_id in self._notes

    def get_note(self, note_id: str) -> _Note:
        return self._notes[note_id]

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        return list(self._children_by_parent.get(parent_id, []))

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> frozenset[str]:
        assert note_id in self._notes
        return frozenset()


def _visible_ids(state) -> set[str]:
    return {entry["id"] for entry in state.structure}


def test_untagged_view_shows_notes_without_non_meta_effective_tags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "untagged": _Note("untagged", None, None, "tagged", False, "<div>One</div>", "@markdown"),
        "tagged": _Note("tagged", None, "untagged", None, False, "<div>Two</div>", "journal"),
    }
    store = _FakeNoteStore(notes=notes, children_by_parent={None: ["untagged", "tagged"]})
    index = SearchIndex()
    index.rebuild(
        [
            SearchRecord(
                note_id=note.id,
                content_text=note.content,
                tags=note.tags,
                tag_terms=extract_tags_for_search(note.tags),
            )
            for note in notes.values()
        ],
        raw_tag_terms_by_id={
            note.id: extract_tags_for_search(note.tags)
            for note in notes.values()
        },
        progress_update=lambda _: None,
        progress_interval=1000,
    )

    import app.services.snapshot as snapshot

    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "search_index", index)
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})

    state = build_view_state(
        editing_note_id=None,
        search="journal",
        sort_mode="normal",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=True,
    )

    assert _visible_ids(state) == {"untagged"}
    assert state.metadata["isUntaggedView"] is True


def test_search_redacts_descendants_of_matching_root(monkeypatch: pytest.MonkeyPatch) -> None:
    # Tree:
    # r1(asdf)
    #   c1
    #     g1
    #   c2
    # r2
    notes = {
        "r1": _Note("r1", None, None, "r2", False, "<div>r1</div>", "asdf"),
        "c1": _Note("c1", "r1", None, "c2", False, "<div>c1</div>", ""),
        "g1": _Note("g1", "c1", None, None, False, "<div>g1</div>", ""),
        "c2": _Note("c2", "r1", "c1", None, False, "<div>c2</div>", ""),
        "r2": _Note("r2", None, "r1", None, False, "<div>r2</div>", ""),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["r1", "r2"], "r1": ["c1", "c2"], "c1": ["g1"]},
    )

    index = SearchIndex()
    index.rebuild(
        [
            SearchRecord(
                note_id=n.id,
                content_text=n.content,
                tags=n.tags,
                tag_terms=extract_tags_for_search(n.tags),
            )
            for n in notes.values()
        ],
        raw_tag_terms_by_id={
            note.id: extract_tags_for_search(note.tags)
            for note in notes.values()
        },
        progress_update=lambda _: None,
        progress_interval=1000,
    )

    import app.services.snapshot as snapshot

    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "search_index", index)
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})

    state = build_view_state(
        editing_note_id=None,
        search="asdf",
        sort_mode="normal",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )

    assert "resultApproximateTokenCount" not in state.metadata

    assert _visible_ids(state) == {"r1", "c1", "g1", "c2"}
    assert not state.payloads["r1"]["flags"]["searchRedacted"]
    assert state.payloads["c1"]["flags"]["searchRedacted"]
    assert state.payloads["g1"]["flags"]["searchRedacted"]
    assert state.payloads["c2"]["flags"]["searchRedacted"]


def test_search_snapshot_does_not_include_children_of_collapsed_root(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "r1": _Note("r1", None, None, None, True, "<div>r1</div>", "asdf"),
        "c1": _Note("c1", "r1", None, None, False, "<div>c1</div>", ""),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["r1"], "r1": ["c1"]},
    )

    index = SearchIndex()
    index.rebuild(
        [
            SearchRecord(
                note_id=n.id,
                content_text=n.content,
                tags=n.tags,
                tag_terms=extract_tags_for_search(n.tags),
            )
            for n in notes.values()
        ],
        raw_tag_terms_by_id={
            note.id: extract_tags_for_search(note.tags)
            for note in notes.values()
        },
        progress_update=lambda _: None,
        progress_interval=1000,
    )

    import app.services.snapshot as snapshot

    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "search_index", index)
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})

    state = build_view_state(
        editing_note_id=None,
        search="asdf",
        sort_mode="normal",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )

    assert _visible_ids(state) == {"r1"}
    assert state.payloads["r1"]["flags"]["isCollapsible"] is True
    assert "c1" not in state.payloads


def test_search_redacts_descendants_of_matching_non_root(monkeypatch: pytest.MonkeyPatch) -> None:
    # Tree:
    # r1
    #   c1(asdf)
    #     g1
    #   c2
    notes = {
        "r1": _Note("r1", None, None, None, False, "<div>r1</div>", ""),
        "c1": _Note("c1", "r1", None, "c2", False, "<div>c1</div>", "asdf"),
        "g1": _Note("g1", "c1", None, None, False, "<div>g1</div>", ""),
        "c2": _Note("c2", "r1", "c1", None, False, "<div>c2</div>", ""),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["r1"], "r1": ["c1", "c2"], "c1": ["g1"]},
    )

    index = SearchIndex()
    index.rebuild(
        [
            SearchRecord(
                note_id=n.id,
                content_text=n.content,
                tags=n.tags,
                tag_terms=extract_tags_for_search(n.tags),
            )
            for n in notes.values()
        ],
        raw_tag_terms_by_id={
            note.id: extract_tags_for_search(note.tags)
            for note in notes.values()
        },
        progress_update=lambda _: None,
        progress_interval=1000,
    )

    import app.services.snapshot as snapshot

    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "search_index", index)
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})

    state = build_view_state(
        editing_note_id=None,
        search="asdf",
        sort_mode="normal",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )

    assert _visible_ids(state) == {"r1", "c1", "g1", "c2"}
    assert not state.payloads["r1"]["flags"]["searchRedacted"]
    assert not state.payloads["c1"]["flags"]["searchRedacted"]
    assert state.payloads["g1"]["flags"]["searchRedacted"]
    assert state.payloads["c2"]["flags"]["searchRedacted"]


def test_or_query_for_two_child_uuids_redacts_unrelated_same_root_sibling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root_id = "10000000-0000-4000-8000-000000000000"
    first_match_id = "20000000-0000-4000-8000-000000000001"
    second_match_id = "20000000-0000-4000-8000-000000000002"
    unrelated_id = "20000000-0000-4000-8000-000000000003"
    notes = {
        root_id: _Note(root_id, None, None, None, False, "<div>Medications</div>", ""),
        first_match_id: _Note(
            first_match_id,
            root_id,
            None,
            second_match_id,
            False,
            "<div>TRT?</div>",
            "",
        ),
        second_match_id: _Note(
            second_match_id,
            root_id,
            first_match_id,
            unrelated_id,
            False,
            "<div>testosterone notes</div>",
            "",
        ),
        unrelated_id: _Note(
            unrelated_id,
            root_id,
            second_match_id,
            None,
            False,
            "<div>alcohol</div>",
            "",
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={
            None: [root_id],
            root_id: [first_match_id, second_match_id, unrelated_id],
        },
    )
    index = SearchIndex()
    index.rebuild(
        [
            SearchRecord(
                note_id=note.id,
                content_text=note.content,
                tags=note.tags,
                tag_terms=extract_tags_for_search(note.tags),
            )
            for note in notes.values()
        ],
        raw_tag_terms_by_id={
            note.id: extract_tags_for_search(note.tags)
            for note in notes.values()
        },
        progress_update=lambda _: None,
        progress_interval=1000,
    )

    import app.services.snapshot as snapshot

    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "search_index", index)
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})

    state = build_view_state(
        editing_note_id=None,
        search=f"{first_match_id} OR {second_match_id}",
        sort_mode="normal",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )

    assert _visible_ids(state) == {
        root_id,
        first_match_id,
        second_match_id,
        unrelated_id,
    }
    assert not state.payloads[first_match_id]["flags"]["searchRedacted"]
    assert not state.payloads[second_match_id]["flags"]["searchRedacted"]
    assert state.payloads[unrelated_id]["flags"]["searchRedacted"]


def test_search_does_not_force_include_nonmatching_editing_root(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "r1": _Note("r1", None, None, "r2", False, "<div>r1</div>", "scratchpad"),
        "r2": _Note("r2", None, "r1", None, False, "<div>r2</div>", "vocab"),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["r1", "r2"]},
    )

    index = SearchIndex()
    index.rebuild(
        [
            SearchRecord(
                note_id=n.id,
                content_text=n.content,
                tags=n.tags,
                tag_terms=extract_tags_for_search(n.tags),
            )
            for n in notes.values()
        ],
        raw_tag_terms_by_id={
            note.id: extract_tags_for_search(note.tags)
            for note in notes.values()
        },
        progress_update=lambda _: None,
        progress_interval=1000,
    )

    import app.services.snapshot as snapshot

    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "search_index", index)
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})

    state = build_view_state(
        editing_note_id="r2",
        search="scratchpad",
        sort_mode="normal",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )

    assert _visible_ids(state) == {"r1"}
