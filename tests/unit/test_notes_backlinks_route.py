from __future__ import annotations

import pytest
from starlette.requests import Request

import app.api.routes.notes as notes_route
from app.services.snapshot import SearchScope


class _FakeStore:
    def __init__(self, note_ids: set[str]) -> None:
        self._note_ids = note_ids

    def has_note(self, note_id: str) -> bool:
        return note_id in self._note_ids


def test_backlinks_search_scope_does_not_build_full_view_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    monkeypatch.setattr(notes_route, "note_store", _FakeStore({target_id}))
    monkeypatch.setattr(
        notes_route,
        "build_view_state",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("build_view_state should not be used")),
    )
    monkeypatch.setattr(
        notes_route,
        "resolve_search_scope",
        lambda *, search, editing_note_id, sort_mode, ordered_root_ids: SearchScope(
            search_active=True,
            allowed_note_ids={"source-a", target_id},
            search_root_ids_ordered=["source-a", target_id],
            search_root_count_total=2,
            matched_note_ids=None,
        ),
    )

    captured: dict[str, object] = {}

    def _fake_list_backlinks_for_note(note_id: str, source_note_ids: set[str] | None):
        captured["note_id"] = note_id
        captured["source_note_ids"] = source_note_ids
        return [{"id": "source-a", "preview": "hello"}]

    monkeypatch.setattr(notes_route, "list_backlinks_for_note", _fake_list_backlinks_for_note)

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": f"/api2/notes/{target_id}/backlinks",
            "headers": [],
            "query_string": b"search=journal",
        }
    )
    payload = notes_route.backlinks(request, target_id)

    assert captured["note_id"] == target_id
    assert captured["source_note_ids"] == {"source-a", target_id}
    assert payload == {
        "targetNoteId": target_id,
        "backlinks": [{"id": "source-a", "preview": "hello"}],
    }
