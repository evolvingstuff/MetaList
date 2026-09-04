from __future__ import annotations

from types import SimpleNamespace

import pytest

import app.services.undo_state as undo_state


def test_proposal_acceptance_round_trips_through_complete_undo_redo_cycle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    note_state = {
        "content": "<div>note</div>",
        "tags": "scratchpad",
        "proposed_tags": "",
    }

    def get_note(note_id: str) -> SimpleNamespace:
        assert note_id == "note-1"
        return SimpleNamespace(
            id=note_id,
            parent_id=None,
            content=note_state["content"],
            tags=note_state["tags"],
            proposed_tags=note_state["proposed_tags"],
        )

    def apply_sources(**payload: object) -> None:
        assert payload["note_id"] == "note-1"
        assert payload["content"] == note_state["content"]
        note_state["tags"] = payload["tags"]
        note_state["proposed_tags"] = payload["proposed_tags"]

    monkeypatch.setattr(undo_state, "store", SimpleNamespace(get=get_note))
    monkeypatch.setattr(undo_state, "apply_update_note_sources", apply_sources)
    monkeypatch.setattr(undo_state, "generate_new_uuid", lambda: "update-uuid")
    undo_state.reset_all_undo_state()

    viewport = {"scrollY": 0, "scrollAnchor": None}
    transitions = [
        ("scratchpad", "", "scratchpad", "one two three"),
        ("scratchpad", "one two three", "scratchpad one", "two three"),
        ("scratchpad one", "two three", "scratchpad one two", "three"),
        ("scratchpad one two", "three", "scratchpad one two three", ""),
    ]
    for before_tags, before_proposals, after_tags, after_proposals in transitions:
        undo_state.record_tag_sources(
            "client-1",
            "tab:one|search:|epoch:0",
            "note-1",
            before_tags=before_tags,
            before_proposed_tags=before_proposals,
            after_tags=after_tags,
            after_proposed_tags=after_proposals,
            viewport=viewport,
        )
        note_state["tags"] = after_tags
        note_state["proposed_tags"] = after_proposals

    undo_state.undo("client-1", "token")
    assert note_state["proposed_tags"] == "three"
    undo_state.undo("client-1", "token")
    assert note_state["proposed_tags"] == "two three"
    undo_state.undo("client-1", "token")
    assert note_state["proposed_tags"] == "one two three"
    undo_state.undo("client-1", "token")
    assert note_state == {
        "content": "<div>note</div>",
        "tags": "scratchpad",
        "proposed_tags": "",
    }

    undo_state.redo("client-1", "token")
    assert note_state["proposed_tags"] == "one two three"
    undo_state.redo("client-1", "token")
    assert note_state["proposed_tags"] == "two three"
    undo_state.redo("client-1", "token")
    assert note_state["proposed_tags"] == "three"
    undo_state.redo("client-1", "token")
    assert note_state == {
        "content": "<div>note</div>",
        "tags": "scratchpad one two three",
        "proposed_tags": "",
    }
