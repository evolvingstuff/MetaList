from __future__ import annotations

from typing import Dict, List, Optional

import app.services.snapshot as snapshot_module
import pytest

from app.services.embedded_references import extract_collapsed_preview_source_html
from app.services.search_index import SearchIndex
from app.services.snapshot import build_view_state
from tests.unit.snapshot_note_fixture import SnapshotTestNote as _Note


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
        client_known_note_ids=set(), previous_root_ids=[],
        visible_top_root_id=None,
        visible_bottom_root_id=None,
        is_untagged_view=False,
        start_at_list_end=False,
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


@pytest.mark.parametrize(
    ("content", "first_line"),
    [
        ("Kyoto hotel<div>3 nights</div><div>Breakfast</div>", "Kyoto hotel"),
        ("<b>Bold</b> start<p>next paragraph</p>", "<b>Bold</b> start"),
        ("Groceries<ul><li>milk</li></ul>", "Groceries"),
    ],
)
def test_a_block_opening_after_the_first_line_starts_the_second_line(content: str, first_line: str) -> None:
    # Editors write "first line<div>second line</div>" when Enter follows unwrapped text.
    assert extract_collapsed_preview_source_html(content) == first_line


def test_collapsed_note_starting_with_a_reference_hides_its_later_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    source_id = "1c9e7b52-3f4a-4d8e-a6b0-7e2f9d1c5a38"
    notes = {
        "host": _Note("host", None, None, source_id, True, f"![[{source_id}]]<div>second line</div>", ""),
        source_id: _Note(source_id, None, "host", None, False, "Kyoto hotel<div>3 nights</div>", ""),
    }

    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["host", source_id]},
        editing_note_id=None,
    )

    rendered = state.payloads["host"]["content"]
    assert "second line" not in rendered
    assert '<span class="note-reference-link-title">Kyoto hotel</span>' in rendered
    assert "3 nights" not in rendered
    assert state.payloads["host"]["flags"]["isCollapsible"] is True


def test_backlink_previews_use_only_the_first_line() -> None:
    from app.services.backlinks import _extract_preview

    assert _extract_preview("Kyoto hotel<div>3 nights</div>") == "Kyoto hotel"
    assert _extract_preview("<div>alpha</div><div>beta</div>") == "alpha"


def test_snapshot_marks_proposals_for_tags_no_note_has_yet(monkeypatch: pytest.MonkeyPatch) -> None:
    index = SearchIndex()
    # "kyoto" is written on another note; "sakura" is only proposed, so accepting it creates a tag.
    index.upsert(note_id="other", content_text="Gion", tags="Kyoto",
                 raw_tag_terms=frozenset({"Kyoto"}), tag_terms=frozenset({"Kyoto"}))
    index.upsert(note_id="trip", content_text="Trip", tags="",
                 raw_tag_terms=frozenset({"sakura", "kyoto"}), tag_terms=frozenset({"sakura", "kyoto"}))
    monkeypatch.setattr(snapshot_module, "search_index", index)
    notes = {
        "trip": _Note(
            "trip", None, None, None, False, "<div>Trip</div>", "",
            proposed_tags="sakura kyoto",
            proposed_tag_terms=frozenset({"sakura", "kyoto"}),
        ),
        "plain": _Note("plain", None, None, None, False, "<div>Plain</div>", "Kyoto"),
    }
    notes["trip"].next_id = "plain"
    notes["plain"].prev_id = "trip"

    state = _state_for(
        monkeypatch=monkeypatch, notes=notes,
        children_by_parent={None: ["trip", "plain"]}, editing_note_id=None,
    )

    assert state.payloads["trip"]["flags"]["newProposedTags"] == "sakura"
    assert state.payloads["plain"]["flags"]["newProposedTags"] == ""
