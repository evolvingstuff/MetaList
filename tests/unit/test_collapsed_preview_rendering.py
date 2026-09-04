from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Optional

import app.services.snapshot as snapshot_module
import pytest

from app.services.embedded_references import extract_collapsed_preview_source_html
from app.services.snapshot import build_view_state


@dataclass
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
        if parent_id in self._children_by_parent:
            return list(self._children_by_parent[parent_id])
        return []

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> frozenset[str]:
        assert note_id in self._notes
        return frozenset()


def _state_for(
    *,
    monkeypatch: pytest.MonkeyPatch,
    notes: Dict[str, _Note],
    children_by_parent: Dict[Optional[str], List[str]],
    editing_note_id: str | None,
):
    store = _FakeNoteStore(notes=notes, children_by_parent=children_by_parent)
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "get_all_locks", lambda: {})
    return build_view_state(
        editing_note_id=editing_note_id,
        search=None,
        sort_mode="normal",
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )


def test_extract_collapsed_preview_source_skips_leading_blank_lines() -> None:
    content = "<div><br></div><div>\u00a0</div><div>Yep, this is real</div><div>Hidden later</div>"

    preview = extract_collapsed_preview_source_html(content)

    assert preview == "<div>Yep, this is real</div>"


def test_extract_collapsed_preview_source_keeps_first_image_line() -> None:
    content = '<div><br></div><div><img src="data:image/png;base64,abc" alt="A"></div><div>Hidden later</div>'

    preview = extract_collapsed_preview_source_html(content)

    assert '<img src="data:image/png;base64,abc" alt="A">' in preview
    assert "Hidden later" not in preview


def test_proposal_counts_roll_up_only_to_nearest_visible_collapsed_note(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "root": _Note(
            "root",
            None,
            None,
            None,
            False,
            "<div>Root</div>",
            "",
            proposed_tags="root-proposal",
            proposed_tag_terms=frozenset({"root-proposal"}),
        ),
        "child": _Note(
            "child",
            "root",
            None,
            None,
            True,
            "<div>Child</div>",
            "",
            proposed_tags="child-a child-b",
            proposed_tag_terms=frozenset({"child-a", "child-b"}),
        ),
        "grandchild": _Note(
            "grandchild",
            "child",
            None,
            None,
            False,
            "<div>Grandchild</div>",
            "",
            proposed_tags="grandchild-proposal",
            proposed_tag_terms=frozenset({"grandchild-proposal"}),
        ),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={
            None: ["root"],
            "root": ["child"],
            "child": ["grandchild"],
        },
        editing_note_id=None,
    )

    assert set(state.payloads) == {"root", "child"}
    assert state.payloads["root"]["flags"]["proposalCount"] == 1
    assert state.payloads["child"]["flags"]["proposalCount"] == 3


def test_trailing_blank_html_does_not_make_note_collapsible(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "a": _Note("a", None, None, None, False, "<div>Only meaningful line</div><div><br></div>", ""),
    }

    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        editing_note_id=None,
    )

    assert state.payloads["a"]["flags"]["isCollapsible"] is False


def test_second_meaningful_html_line_makes_note_collapsible(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "a": _Note("a", None, None, None, False, "<div>First line</div><div>Second line</div>", ""),
    }

    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        editing_note_id=None,
    )

    assert state.payloads["a"]["flags"]["isCollapsible"] is True


def test_inline_image_note_is_collapsible_even_when_image_is_entire_note(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "a": _Note(
            "a",
            None,
            None,
            None,
            False,
            '<div><img src="data:image/png;base64,abc" alt="A"></div>',
            "",
        ),
    }

    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        editing_note_id=None,
    )

    assert state.payloads["a"]["flags"]["isCollapsible"] is True


def test_inline_image_first_note_is_collapsible_with_following_text(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "a": _Note(
            "a",
            None,
            None,
            None,
            False,
            '<div><img src="data:image/png;base64,abc" alt="A"></div><div>arbitrary text after image</div>',
            "",
        ),
    }

    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        editing_note_id=None,
    )

    assert state.payloads["a"]["flags"]["isCollapsible"] is True


def test_collapsed_snapshot_sends_first_meaningful_line_only(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "a": _Note(
            "a",
            None,
            None,
            None,
            True,
            "\n\nTimestamps:\n(0:00) - Intro\n(0:18) - Next",
            "",
        ),
    }

    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        editing_note_id=None,
    )

    rendered = state.payloads["a"]["content"]
    assert rendered == "Timestamps:"
    assert state.payloads["a"]["flags"]["isCollapsible"] is True
    assert "(0:00)" not in rendered


def test_collapsed_editing_note_hides_children_but_keeps_full_content(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "a": _Note("a", None, None, None, True, "<div>A</div><div>second line</div>", ""),
        "b": _Note("b", "a", None, None, False, "<div>B</div>", ""),
    }

    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"], "a": ["b"]},
        editing_note_id="a",
    )

    assert {entry["id"] for entry in state.structure} == {"a"}
    assert state.payloads["a"]["content"] == "<div>A</div><div>second line</div>"
    assert state.payloads["a"]["flags"]["isCollapsed"] is True
    assert state.payloads["a"]["flags"]["isEditing"] is True
    assert state.payloads["a"]["flags"]["hasChildren"] is True
    assert "b" not in state.payloads


def test_blank_collapsed_note_without_children_is_not_collapsible(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "a": _Note("a", None, None, None, True, "<div><br></div>", ""),
    }

    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        editing_note_id=None,
    )

    assert state.payloads["a"]["content"] == ""
    assert state.payloads["a"]["flags"]["isCollapsible"] is False


def test_blank_collapsed_note_with_children_is_collapsible(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "a": _Note("a", None, None, None, True, "<div><br></div>", ""),
        "b": _Note("b", "a", None, None, False, "child", ""),
    }

    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"], "a": ["b"]},
        editing_note_id=None,
    )

    assert state.payloads["a"]["flags"]["hasChildren"] is True
    assert state.payloads["a"]["flags"]["isCollapsible"] is True
    assert "b" not in state.payloads
