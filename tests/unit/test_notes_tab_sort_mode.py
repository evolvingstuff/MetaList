from __future__ import annotations

from dataclasses import dataclass

import pytest
from fastapi import HTTPException

import app.api.routes.notes as notes_route


@dataclass
class _FakeNote:
    parent_id: str | None


def test_update_tab_sort_mode_resets_undo_stack_when_changed(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        notes_route.tab_state_store,
        "set_sort_mode",
        lambda *, tab_id, sort_mode: {
            "activeTabId": tab_id,
            "tabs": {tab_id: {"searchQuery": "", "scrollY": 0, "scrollAnchor": None, "sortMode": sort_mode}},
            "tabOrder": [tab_id],
            "version": 1,
            "changed": True,
        },
    )
    monkeypatch.setattr(
        notes_route,
        "reset_undo_stack",
        lambda client_id, undo_context: captured.update(client_id=client_id, undo_context=undo_context),
    )

    result = notes_route.update_tab_sort_mode(
        {
            "tabId": "tab-1",
            "sortMode": "updated",
            "clientId": "client-1",
            "undoContext": "undo-1",
        }
    )

    assert result["changed"] is True
    assert captured == {"client_id": "client-1", "undo_context": "undo-1"}


def test_view_diff_returns_400_for_invalid_search_before_undo_reset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called: dict[str, bool] = {}
    monkeypatch.setattr(notes_route, "_resolve_tab_sort_mode", lambda tab_id: "normal")
    monkeypatch.setattr(
        notes_route,
        "maybe_reset_on_context",
        lambda client_id, undo_context: called.update(reset=True),
    )

    with pytest.raises(HTTPException) as exc_info:
        notes_route.view_diff(
            {
                "clientId": "client-1",
                "editingNoteId": None,
                "search": "-",
                "tabId": "tab-1",
                "undoContext": "tab:tab-1|search:|epoch:0",
                "clientNoteUuidHashes": {},
                "visibleRootAnchorId": None,
                "isUntaggedView": False,
            }
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Dangling prefix in search query"
    assert called == {}


def test_move_note_endpoint_blocks_root_reorder_when_sort_locked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notes_route, "_require_viewport", lambda body: {"scrollY": 0})
    monkeypatch.setattr(notes_route, "_require_note_present", lambda note_id, *, context: None)
    monkeypatch.setattr(notes_route.tab_state_store, "get_sort_mode", lambda *, tab_id: "updated")
    monkeypatch.setattr(notes_route, "note_store", type("Store", (), {"get_note": lambda self, note_id: _FakeNote(parent_id=None)})())

    with pytest.raises(HTTPException) as exc_info:
        notes_route.move_note_endpoint(
            "root-a",
            {
                "sibling_id": "root-b",
                "position": "BEFORE",
                "new_parent_id": None,
                "tab_id": "tab-1",
                "clientId": "client-1",
                "undoContext": "undo-1",
                "viewport": {"scrollY": 0},
            },
        )

    assert exc_info.value.status_code == 409
    assert "Root-note reordering" in exc_info.value.detail


def test_prioritize_endpoint_blocks_root_reorder_when_sort_locked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(notes_route, "_require_viewport", lambda body: {"scrollY": 0})
    monkeypatch.setattr(notes_route.tab_state_store, "get_sort_mode", lambda *, tab_id: "created")

    with pytest.raises(HTTPException) as exc_info:
        notes_route.prioritize_in_view_endpoint(
            {
                "tag": "foo",
                "direction": "front",
                "search_query": "journal",
                "tab_id": "tab-1",
                "clientId": "client-1",
                "undoContext": "undo-1",
                "viewport": {"scrollY": 0},
            }
        )

    assert exc_info.value.status_code == 409
    assert "Root-note reordering" in exc_info.value.detail
