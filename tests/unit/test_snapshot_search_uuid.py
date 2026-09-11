from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

import pytest

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

    def has_backlinks(self, note_id: str) -> bool:
        return False

    def has_note(self, note_id: str) -> bool:
        return note_id in self._notes

    def get_note(self, note_id: str) -> _Note:
        return self._notes[note_id]

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        return list(self._children_by_parent.get(parent_id, []))

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> frozenset[str]:
        assert note_id in self._notes
        return frozenset()


class _FakeSearchIndex:
    def query_clause_note_ids(self, clause: object) -> set[str]:
        del clause
        return set()


def test_search_with_uuid_target_includes_direct_note_and_descendants(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    notes = {
        "root": _Note("root", None, None, None, False, "<div>root</div>", ""),
        target_id: _Note(target_id, "root", None, "sibling", False, "<div>target</div>", ""),
        "target-child": _Note("target-child", target_id, None, None, False, "<div>child</div>", ""),
        "sibling": _Note("sibling", "root", target_id, None, False, "<div>sibling</div>", ""),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={
            None: ["root"],
            "root": [target_id, "sibling"],
            target_id: ["target-child"],
        },
    )

    import app.services.snapshot as snapshot

    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "search_index", _FakeSearchIndex())
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})

    state = build_view_state(
        editing_note_id=None,
        search=f"[[{target_id}]]",
        sort_mode="normal",
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )

    assert state.payloads["root"]["flags"]["searchRedacted"] is False
    assert state.payloads[target_id]["flags"]["searchRedacted"] is False
    assert state.payloads["target-child"]["flags"]["searchRedacted"] is False
    assert state.payloads["sibling"]["flags"]["searchRedacted"] is True
