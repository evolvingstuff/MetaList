from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

import pytest

from app.services.search_index import SearchIndex, SearchRecord, extract_tags_for_search
from app.services.snapshot import build_activity_summary, build_view_state
from app.services.snapshot import resolve_view_scope_membership


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
    def __init__(self, *, notes: Dict[str, _Note], children_by_parent: Dict[Optional[str], List[str]]):
        self._notes = notes
        self._children_by_parent = children_by_parent

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


def _patch_fake_search_index(monkeypatch: pytest.MonkeyPatch, notes: Dict[str, _Note]) -> None:
    import app.services.snapshot as snapshot

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
    monkeypatch.setattr(snapshot, "search_index", index)


def test_build_view_state_uses_newest_created_timestamp_in_root_subtree(
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
        editing_note_id=None,
        search=None,
        sort_mode="created",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )

    assert state.children_by_parent[None] == ["root-old", "root-new"]
    assert state.children_by_parent["root-old"] == ["child-new"]
    assert state.metadata["sortMode"] == "created"
    assert state.metadata["rootSortBuckets"] == {
        "root-old": {"key": "2026-04-18", "label": "2026/04/18 - Saturday"},
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
        editing_note_id=None,
        search=None,
        sort_mode="updated",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
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
        editing_note_id=None,
        search=None,
        sort_mode="alphabetical",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
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
        editing_note_id=None,
        search=None,
        sort_mode="content-volume",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )

    assert state.children_by_parent[None] == [
        "root-subtree-large",
        "root-own-long",
        "root-tied",
    ]
    assert state.metadata["sortMode"] == "content-volume"
    assert state.metadata["rootSortBuckets"] == {}


def test_build_view_state_filters_by_updated_date_range(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "root-a": _Note(
            id="root-a",
            parent_id=None,
            prev_id=None,
            next_id="root-b",
            is_collapsed=False,
            content="<div>A</div>",
            tags="",
            created_at=datetime(2026, 5, 1, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 5, 10, 20, 0, tzinfo=timezone.utc),
        ),
        "child-a": _Note(
            id="child-a",
            parent_id="root-a",
            prev_id=None,
            next_id=None,
            is_collapsed=False,
            content="<div>A child</div>",
            tags="",
            created_at=datetime(2026, 5, 1, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 5, 18, 20, 0, tzinfo=timezone.utc),
        ),
        "root-b": _Note(
            id="root-b",
            parent_id=None,
            prev_id="root-a",
            next_id=None,
            is_collapsed=False,
            content="<div>B</div>",
            tags="",
            created_at=datetime(2026, 5, 1, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 5, 20, 20, 0, tzinfo=timezone.utc),
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["root-a", "root-b"], "root-a": ["child-a"]},
    )
    _patch_fake_store(monkeypatch, store)

    state = build_view_state(
        editing_note_id=None,
        search=None,
        sort_mode="normal",
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
        date_filter={"metric": "updated", "startDate": "2026-05-18", "endDate": "2026-05-18"},
    )

    assert state.children_by_parent[None] == ["root-a"]
    assert state.children_by_parent["root-a"] == ["child-a"]
    assert state.payloads["root-a"]["flags"]["searchRedacted"] is False
    assert state.payloads["child-a"]["flags"]["searchRedacted"] is False
    assert state.metadata["dateFilter"]["metric"] == "updated"
    assert state.metadata["searchRootCountTotal"] == 1


def test_date_filtered_scope_keeps_ancestor_for_rendering_but_not_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "root-a": _Note(
            id="root-a",
            parent_id=None,
            prev_id=None,
            next_id=None,
            is_collapsed=False,
            content="<div>A</div>",
            tags="",
            created_at=datetime(2026, 5, 1, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 5, 10, 20, 0, tzinfo=timezone.utc),
        ),
        "child-a": _Note(
            id="child-a",
            parent_id="root-a",
            prev_id=None,
            next_id=None,
            is_collapsed=False,
            content="<div>A child</div>",
            tags="",
            created_at=datetime(2026, 5, 1, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 5, 18, 20, 0, tzinfo=timezone.utc),
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["root-a"], "root-a": ["child-a"]},
    )
    _patch_fake_store(monkeypatch, store)

    resolved = resolve_view_scope_membership(
        search="",
        sort_mode="normal",
        date_filter={
            "metric": "updated",
            "startDate": "2026-05-18",
            "endDate": "2026-05-18",
        },
        is_untagged_view=False,
    )

    assert resolved.allowed_note_ids == frozenset({"root-a", "child-a"})
    assert resolved.matched_note_ids == frozenset({"child-a"})
    assert resolved.ordered_root_ids == ("root-a",)


def test_activity_summary_includes_created_and_updated_dates_for_all_notes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "old-arxiv": _Note(
            id="old-arxiv",
            parent_id=None,
            prev_id=None,
            next_id="new-arxiv",
            is_collapsed=False,
            content="<div>old arXiv</div>",
            tags="",
            created_at=datetime(2019, 1, 5, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2020, 2, 6, 20, 0, tzinfo=timezone.utc),
        ),
        "new-arxiv": _Note(
            id="new-arxiv",
            parent_id=None,
            prev_id="old-arxiv",
            next_id=None,
            is_collapsed=False,
            content="<div>new arXiv</div>",
            tags="",
            created_at=datetime(2026, 5, 18, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 5, 18, 20, 0, tzinfo=timezone.utc),
        ),
        "child-arxiv": _Note(
            id="child-arxiv",
            parent_id="new-arxiv",
            prev_id=None,
            next_id=None,
            is_collapsed=False,
            content="<div>child arXiv detail</div>",
            tags="",
            created_at=datetime(2026, 5, 19, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 5, 19, 20, 0, tzinfo=timezone.utc),
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["old-arxiv", "new-arxiv"], "new-arxiv": ["child-arxiv"]},
    )
    _patch_fake_store(monkeypatch, store)

    created = build_activity_summary(search=None, sort_mode="normal", metric="created")
    updated = build_activity_summary(search=None, sort_mode="normal", metric="updated")

    assert created["rangeStart"] == "2019-01-05"
    assert created["rangeEnd"] == "2026-05-19"
    assert created["buckets"] == {"2019-01-05": 1, "2026-05-18": 1, "2026-05-19": 1}
    assert created["total"] == 3
    assert updated["rangeStart"] == "2020-02-06"
    assert updated["rangeEnd"] == "2026-05-19"
    assert updated["buckets"] == {"2020-02-06": 1, "2026-05-18": 1, "2026-05-19": 1}
    assert updated["total"] == 3


def test_activity_summary_counts_matching_child_notes_in_search(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "journal-root": _Note(
            id="journal-root",
            parent_id=None,
            prev_id=None,
            next_id="plain-root",
            is_collapsed=False,
            content="<div>2026.05 - May</div>",
            tags="journal",
            created_at=datetime(2025, 1, 1, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2025, 1, 1, 20, 0, tzinfo=timezone.utc),
        ),
        "journal-child": _Note(
            id="journal-child",
            parent_id="journal-root",
            prev_id=None,
            next_id=None,
            is_collapsed=False,
            content="<div>2026.05.19 - Tues: Palantir meeting</div>",
            tags="journal",
            created_at=datetime(2026, 5, 19, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 5, 20, 20, 0, tzinfo=timezone.utc),
        ),
        "plain-root": _Note(
            id="plain-root",
            parent_id=None,
            prev_id="journal-root",
            next_id=None,
            is_collapsed=False,
            content="<div>plain</div>",
            tags="",
            created_at=datetime(2026, 5, 21, 20, 0, tzinfo=timezone.utc),
            updated_at=datetime(2026, 5, 22, 20, 0, tzinfo=timezone.utc),
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["journal-root", "plain-root"], "journal-root": ["journal-child"]},
    )
    _patch_fake_store(monkeypatch, store)
    _patch_fake_search_index(monkeypatch, notes)

    created = build_activity_summary(search="journal", sort_mode="normal", metric="created")
    updated = build_activity_summary(search="journal", sort_mode="normal", metric="updated")

    assert created["buckets"] == {"2025-01-01": 1, "2026-05-19": 1}
    assert created["total"] == 2
    assert updated["buckets"] == {"2025-01-01": 1, "2026-05-20": 1}
    assert updated["total"] == 2
