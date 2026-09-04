from __future__ import annotations

from types import SimpleNamespace

import app.api.routes.notes as notes_route


def test_view_diff_does_not_use_cached_anchor_without_client_render_state(monkeypatch) -> None:
    captured: dict[str, object] = {}

    cached_state = SimpleNamespace(
        children_by_parent={None: ["root-a", "deep-root"]},
        hash_by_id={"root-a": "old-hash", "deep-root": "deep-hash"},
        locks={},
    )
    fresh_state = SimpleNamespace(
        children_by_parent={None: ["root-a"]},
        metadata={
            "rootCountTotal": 1,
            "searchRootCountTotal": 1,
            "rootSortBuckets": [],
        },
        hash_by_id={"root-a": "new-hash"},
        payloads={"root-a": {"hash": "new-hash", "content": "Root A"}},
        structure=[{"id": "root-a", "parentId": None, "hash": "new-hash"}],
        locks={},
    )

    monkeypatch.setattr(notes_route, "_resolve_tab_sort_mode", lambda tab_id: "normal")
    monkeypatch.setattr(notes_route, "maybe_reset_on_context", lambda client_id, undo_context: None)
    monkeypatch.setattr(notes_route, "get_current_sync_uuid", lambda: "uuid-view")
    monkeypatch.setattr(notes_route.view_cache, "get", lambda **kwargs: cached_state)
    monkeypatch.setattr(notes_route.view_cache, "set", lambda **kwargs: None)

    def fake_build_view_state(**kwargs):
        captured.update(kwargs)
        return fresh_state

    monkeypatch.setattr(notes_route, "build_view_state", fake_build_view_state)

    result = notes_route.view_diff(
        {
            "clientId": "client-1",
            "editingNoteId": None,
            "search": "journal",
            "tabId": "0",
            "undoContext": "tab:0|search:journal|epoch:0",
            "clientNoteUuidHashes": {},
            "visibleRootAnchorId": None,
            "isUntaggedView": False,
        }
    )

    assert captured["anchor_root_id"] is None
    assert result["snapshot"]["structure"] == [{"id": "root-a", "parentId": None, "hash": "new-hash"}]
    assert "resultApproximateTokenCount" not in result["snapshot"]


def test_view_diff_can_use_cached_anchor_when_client_has_render_state(monkeypatch) -> None:
    captured: dict[str, object] = {}

    cached_state = SimpleNamespace(
        children_by_parent={None: ["root-a", "deep-root"]},
        hash_by_id={"root-a": "old-hash", "deep-root": "deep-hash"},
        locks={},
    )
    fresh_state = SimpleNamespace(
        children_by_parent={None: ["root-a", "deep-root"]},
        metadata={
            "rootCountTotal": 2,
            "searchRootCountTotal": 2,
            "rootSortBuckets": [],
        },
        hash_by_id={"root-a": "new-hash", "deep-root": "deep-hash"},
        payloads={
            "root-a": {"hash": "new-hash", "content": "Root A"},
            "deep-root": {"hash": "deep-hash", "content": "Deep Root"},
        },
        structure=[
            {"id": "root-a", "parentId": None, "hash": "new-hash"},
            {"id": "deep-root", "parentId": None, "hash": "deep-hash"},
        ],
        locks={},
    )

    monkeypatch.setattr(notes_route, "_resolve_tab_sort_mode", lambda tab_id: "normal")
    monkeypatch.setattr(notes_route, "maybe_reset_on_context", lambda client_id, undo_context: None)
    monkeypatch.setattr(notes_route, "get_current_sync_uuid", lambda: "uuid-view")
    monkeypatch.setattr(notes_route.view_cache, "get", lambda **kwargs: cached_state)
    monkeypatch.setattr(notes_route.view_cache, "set", lambda **kwargs: None)

    def fake_build_view_state(**kwargs):
        captured.update(kwargs)
        return fresh_state

    monkeypatch.setattr(notes_route, "build_view_state", fake_build_view_state)
    monkeypatch.setattr(notes_route, "generate_diff_ops", lambda cached, current: [])

    result = notes_route.view_diff(
        {
            "clientId": "client-1",
            "editingNoteId": None,
            "search": "journal",
            "tabId": "0",
            "undoContext": "tab:0|search:journal|epoch:0",
            "clientNoteUuidHashes": {"root-a": "old-hash"},
            "visibleRootAnchorId": None,
            "isUntaggedView": False,
        }
    )

    assert captured["anchor_root_id"] == "deep-root"
    assert result["snapshot"]["diffOps"] == []
    assert "resultApproximateTokenCount" not in result["snapshot"]
