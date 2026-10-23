from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

import pytest

from app.services.snapshot import build_view_state, keep_edited_root_in_place


@dataclass(frozen=True)
class _Note:
    id: str
    parent_id: Optional[str]
    prev_id: Optional[str]
    next_id: Optional[str]
    is_collapsed: bool
    content: str
    tags: str
    created_at: datetime
    updated_at: datetime
    proposed_tags: str = ""
    proposed_tag_terms: frozenset[str] = frozenset()


class _FakeNoteStore:
    revision = 0

    def snapshot(self):
        return dict(self._notes)

    def __init__(self, *, notes: Dict[str, _Note], children_by_parent: Dict[Optional[str], List[str]]):
        self._notes = notes
        self._children_by_parent = children_by_parent

    def has_backlinks(self, note_id: str) -> bool:
        return False

    def has_note(self, note_id: str) -> bool:
        return note_id in self._notes

    def get_note(self, note_id: str) -> _Note:
        return self._notes[note_id]

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        return list(self._children_by_parent.get(parent_id, []))

    def list_note_ids(self) -> List[str]:
        return list(self._notes.keys())

    def get_inherited_non_meta_tag_terms(self, note_id: str):
        if note_id not in self._notes:
            raise KeyError(note_id)
        return frozenset()


def _patch_fake_store(monkeypatch: pytest.MonkeyPatch, store: _FakeNoteStore) -> None:
    import app.services.snapshot as snapshot
    import app.services.root_sorting as root_sorting

    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})
    monkeypatch.setattr(root_sorting, "note_store", store)


def test_build_view_state_uses_root_creation_timestamp_despite_newer_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "root-old": _Note(
            id="root-old",
            parent_id=None,
            prev_id=None,
            next_id="root-new",
            is_collapsed=False,
            content="<div>old</div>",
            tags="",
            created_at=datetime(2025, 4, 7, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2025, 4, 8, 20, 0, tzinfo=timezone.utc),
        ),
        "root-new": _Note(
            id="root-new",
            parent_id=None,
            prev_id="root-old",
            next_id=None,
            is_collapsed=False,
            content="<div>new</div>",
            tags="",
            created_at=datetime(2026, 4, 17, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 4, 18, 20, 0, tzinfo=timezone.utc),
        ),
        "child-new": _Note(
            id="child-new",
            parent_id="root-old",
            prev_id=None,
            next_id=None,
            is_collapsed=False,
            content="<div>child</div>",
            tags="",
            created_at=datetime(2026, 4, 18, 20, 5, tzinfo=timezone.utc),
            updated_at=datetime(2026, 4, 18, 20, 5, tzinfo=timezone.utc),
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["root-old", "root-new"], "root-old": ["child-new"]},
    )
    _patch_fake_store(monkeypatch, store)

    state = build_view_state(
        editing_note_id=None, find_reveal_note_id=None,
        search=None,
        sort_mode="created", date_filter=None,
        client_known_note_ids=set(), previous_root_ids=[],
        visible_top_root_id=None,
        visible_bottom_root_id=None,
        is_untagged_view=False,
        start_at_list_end=False,
    )

    assert state.children_by_parent[None] == ["root-new", "root-old"]
    assert state.children_by_parent["root-old"] == ["child-new"]
    assert state.metadata["sortMode"] == "created"
    assert state.metadata["rootSortBuckets"] == {
        "root-old": {"key": "2025-04-07", "label": "2025/04/07 - Monday"},
        "root-new": {"key": "2026-04-17", "label": "2026/04/17 - Friday"},
    }


def test_build_view_state_uses_newest_updated_timestamp_in_root_subtree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "root-stale": _Note(
            id="root-stale",
            parent_id=None,
            prev_id=None,
            next_id="root-fresh",
            is_collapsed=False,
            content="<div>stale</div>",
            tags="",
            created_at=datetime(2025, 4, 7, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2025, 4, 8, 20, 0, tzinfo=timezone.utc),
        ),
        "root-fresh": _Note(
            id="root-fresh",
            parent_id=None,
            prev_id="root-stale",
            next_id=None,
            is_collapsed=False,
            content="<div>fresh</div>",
            tags="",
            created_at=datetime(2026, 4, 10, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 4, 18, 20, 0, tzinfo=timezone.utc),
        ),
        "child-freshest": _Note(
            id="child-freshest",
            parent_id="root-stale",
            prev_id=None,
            next_id=None,
            is_collapsed=False,
            content="<div>child</div>",
            tags="",
            created_at=datetime(2026, 4, 11, 20, 5, tzinfo=timezone.utc),
            updated_at=datetime(2026, 4, 19, 20, 5, tzinfo=timezone.utc),
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["root-stale", "root-fresh"], "root-stale": ["child-freshest"]},
    )
    _patch_fake_store(monkeypatch, store)

    state = build_view_state(
        editing_note_id=None, find_reveal_note_id=None,
        search=None,
        sort_mode="updated", date_filter=None,
        client_known_note_ids=set(), previous_root_ids=[],
        visible_top_root_id=None,
        visible_bottom_root_id=None,
        is_untagged_view=False,
        start_at_list_end=False,
    )

    assert state.children_by_parent[None] == ["root-stale", "root-fresh"]
    assert state.metadata["sortMode"] == "updated"
    assert state.metadata["rootSortBuckets"] == {
        "root-stale": {"key": "2026-04-19", "label": "2026/04/19 - Sunday"},
        "root-fresh": {"key": "2026-04-18", "label": "2026/04/18 - Saturday"},
    }


def test_build_view_state_sorts_roots_alphabetically_by_root_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 4, 18, 20, 0, tzinfo=timezone.utc)
    notes = {
        "root-zebra": _Note(
            id="root-zebra",
            parent_id=None,
            prev_id=None,
            next_id="root-apple",
            is_collapsed=False,
            content="<div>Zebra</div>",
            tags="",
            created_at=now,
            updated_at=now,
        ),
        "root-apple": _Note(
            id="root-apple",
            parent_id=None,
            prev_id="root-zebra",
            next_id="root-banana",
            is_collapsed=False,
            content="<div>apple</div>",
            tags="",
            created_at=now,
            updated_at=now,
        ),
        "root-banana": _Note(
            id="root-banana",
            parent_id=None,
            prev_id="root-apple",
            next_id=None,
            is_collapsed=False,
            content="<div>Banana</div>",
            tags="",
            created_at=now,
            updated_at=now,
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["root-zebra", "root-apple", "root-banana"]},
    )
    _patch_fake_store(monkeypatch, store)

    state = build_view_state(
        editing_note_id=None, find_reveal_note_id=None,
        search=None,
        sort_mode="alphabetical", date_filter=None,
        client_known_note_ids=set(), previous_root_ids=[],
        visible_top_root_id=None,
        visible_bottom_root_id=None,
        is_untagged_view=False,
        start_at_list_end=False,
    )

    assert state.children_by_parent[None] == ["root-apple", "root-banana", "root-zebra"]
    assert state.metadata["sortMode"] == "alphabetical"
    assert state.metadata["rootSortBuckets"] == {}


def test_build_view_state_sorts_roots_by_plain_text_volume_across_subtree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = datetime(2026, 8, 7, 20, 0, tzinfo=timezone.utc)
    notes = {
        "root-own-long": _Note(
            id="root-own-long",
            parent_id=None,
            prev_id=None,
            next_id="root-subtree-large",
            is_collapsed=False,
            content="<div>1234567890</div>",
            tags="",
            created_at=now,
            updated_at=now,
        ),
        "root-subtree-large": _Note(
            id="root-subtree-large",
            parent_id=None,
            prev_id="root-own-long",
            next_id="root-tied",
            is_collapsed=False,
            content="<h1>X</h1>",
            tags="",
            created_at=now,
            updated_at=now,
        ),
        "child-large": _Note(
            id="child-large",
            parent_id="root-subtree-large",
            prev_id=None,
            next_id=None,
            is_collapsed=False,
            content="<p><strong>abcdefghijklmnop</strong></p>",
            tags="",
            created_at=now,
            updated_at=now,
        ),
        "root-tied": _Note(
            id="root-tied",
            parent_id=None,
            prev_id="root-subtree-large",
            next_id=None,
            is_collapsed=False,
            content="<section>abcdefghij</section>",
            tags="",
            created_at=now,
            updated_at=now,
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={
            None: ["root-own-long", "root-subtree-large", "root-tied"],
            "root-subtree-large": ["child-large"],
        },
    )
    _patch_fake_store(monkeypatch, store)

    state = build_view_state(
        editing_note_id=None, find_reveal_note_id=None,
        search=None,
        sort_mode="content-volume", date_filter=None,
        client_known_note_ids=set(), previous_root_ids=[],
        visible_top_root_id=None,
        visible_bottom_root_id=None,
        is_untagged_view=False,
        start_at_list_end=False,
    )

    assert state.children_by_parent[None] == [
        "root-subtree-large",
        "root-own-long",
        "root-tied",
    ]
    assert state.metadata["sortMode"] == "content-volume"
    assert state.metadata["rootSortBuckets"] == {}


# --- Sorted tabs keep the edited note's root in place while editing ---------


def test_keep_edited_root_in_place_follows_its_previous_earlier_neighbour() -> None:
    # The edited root "c" grew and now sorts first; the tab showed it after "b".
    assert keep_edited_root_in_place(["c", "a", "b", "d"], "c", ["a", "b", "c", "d"]) == ["a", "b", "c", "d"]


def test_keep_edited_root_in_place_skips_neighbours_no_longer_listed() -> None:
    # "b" was deleted (or filtered out): "c" stays after "a", the nearest earlier root still listed.
    assert keep_edited_root_in_place(["c", "a", "d"], "c", ["a", "b", "c", "d"]) == ["a", "c", "d"]


def test_keep_edited_root_in_place_first_shown_root_stays_before_its_later_neighbour() -> None:
    # The tab's band started at "c" (roots above it were not loaded).
    assert keep_edited_root_in_place(["x", "a", "b", "d", "c"], "c", ["c", "d"]) == ["x", "a", "b", "c", "d"]


def test_keep_edited_root_in_place_leaves_roots_the_tab_never_showed() -> None:
    # A root the tab did not show (e.g. just created) takes its sorted place.
    assert keep_edited_root_in_place(["a", "b", "new"], "new", ["a", "b"]) == ["a", "b", "new"]
    assert keep_edited_root_in_place(["a", "b"], "gone", ["a", "gone", "b"]) == ["a", "b"]
    assert keep_edited_root_in_place(["a", "b"], "a", []) == ["a", "b"]


def _updated_sort_store() -> _FakeNoteStore:
    def note(note_id: str, parent_id: Optional[str], updated_day: int) -> _Note:
        return _Note(
            id=note_id, parent_id=parent_id, prev_id=None, next_id=None, is_collapsed=False,
            content=f"<div>{note_id}</div>", tags="",
            created_at=datetime(2026, 4, 1, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 4, updated_day, 20, 0, tzinfo=timezone.utc),
        )
    # "root-edited" was last shown second; its child was just saved, so the
    # updated sort now puts it first.
    notes = {
        "root-top": note("root-top", None, 10),
        "root-edited": note("root-edited", None, 5),
        "child-edited": note("child-edited", "root-edited", 19),
        "root-bottom": note("root-bottom", None, 3),
    }
    return _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["root-top", "root-edited", "root-bottom"], "root-edited": ["child-edited"]},
    )


def _updated_view(editing_note_id: Optional[str]):
    return build_view_state(
        editing_note_id=editing_note_id, find_reveal_note_id=None,
        search=None,
        sort_mode="updated", date_filter=None,
        client_known_note_ids={"root-top", "root-edited", "child-edited", "root-bottom"},
        previous_root_ids=["root-top", "root-edited", "root-bottom"],
        visible_top_root_id=None,
        visible_bottom_root_id=None,
        is_untagged_view=False,
        start_at_list_end=False,
    )


def test_sorted_view_keeps_edited_root_in_place_while_a_child_is_edited(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_fake_store(monkeypatch, _updated_sort_store())

    state = _updated_view("child-edited")

    assert state.children_by_parent[None] == ["root-top", "root-edited", "root-bottom"]
    # Held in place, it shows under its neighbour's date header meanwhile.
    assert state.metadata["rootSortBuckets"]["root-edited"] == state.metadata["rootSortBuckets"]["root-top"]


def test_sorted_view_moves_edited_root_to_its_sorted_place_after_editing(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_fake_store(monkeypatch, _updated_sort_store())

    state = _updated_view(None)

    assert state.children_by_parent[None] == ["root-edited", "root-top", "root-bottom"]
    assert state.metadata["rootSortBuckets"]["root-edited"]["key"] == "2026-04-19"
