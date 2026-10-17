from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

import app.api.routes.notes as notes_route
import app.usecases.reset_updated_at as reset_module
from app.usecases.reset_updated_at import CmdResetUpdatedAtToCreatedAt


@dataclass
class _FakeRecord:
    id: str
    parent_id: str | None
    created_at: datetime
    updated_at: datetime


class _FakeStore:
    def __init__(self, records: list[_FakeRecord]) -> None:
        self._records = {record.id: record for record in records}
        self.root_ids = [record.id for record in records if record.parent_id is None]
        self.children_by_parent: dict[str | None, list[str]] = {}
        for record in records:
            self.children_by_parent.setdefault(record.parent_id, []).append(record.id)
        self.updated_at_writes: list[str] = []

    def get(self, note_id: str) -> _FakeRecord:
        return self._records[note_id]

    def children(self, parent_id: str | None) -> list[str]:
        return list(self.children_by_parent.get(parent_id, []))

    def set_updated_ats(self, updated_ats) -> None:
        for note_id, updated_at in updated_ats.items():
            self.updated_at_writes.append(note_id)
            self._records[note_id].updated_at = updated_at


def _install_db_fakes(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    changed_ids: list[str] = []

    @contextmanager
    def fake_begin_writer():
        yield object()

    def fake_reset_updated_at(connection, note_ids: list[str]) -> int:
        assert connection is not None
        changed_ids.extend(note_ids)
        return len(note_ids)

    monkeypatch.setattr(reset_module, "begin_writer", fake_begin_writer)
    monkeypatch.setattr(reset_module, "db_reset_updated_at_to_created_at", fake_reset_updated_at)
    return changed_ids


def test_reset_updated_at_updates_changed_notes_in_current_search_root_subtrees(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = datetime(2026, 1, 1, tzinfo=timezone.utc)
    damaged = datetime(2026, 5, 10, tzinfo=timezone.utc)
    fake_store = _FakeStore(
        [
            _FakeRecord("root-a", None, created, damaged),
            _FakeRecord("child-a", "root-a", created, damaged),
            _FakeRecord("root-b", None, created, created),
            _FakeRecord("child-b", "root-b", created, damaged),
            _FakeRecord("root-c", None, created, damaged),
        ]
    )
    monkeypatch.setattr(reset_module, "store", fake_store)
    changed_ids = _install_db_fakes(monkeypatch)
    monkeypatch.setattr(
        reset_module,
        "resolve_search_scope",
        lambda **kwargs: SimpleNamespace(
            search_active=True,
            search_root_ids_ordered=["root-a", "root-b"],
        ),
    )
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        reset_module,
        "reset_undo_stack",
        lambda client_id, undo_context: captured.update(client_id=client_id, undo_context=undo_context),
    )
    monkeypatch.setattr(reset_module, "generate_new_uuid", lambda: "uuid-reset-updated")

    result = CmdResetUpdatedAtToCreatedAt(
        search_query="journal",
        client_id="client-1",
        undo_context="undo-1",
        viewport={"scrollY": 0},
    ).execute()

    assert changed_ids == ["root-a", "child-a", "child-b"]
    assert fake_store.updated_at_writes == ["root-a", "child-a", "child-b"]
    assert fake_store.get("root-a").updated_at == created
    assert fake_store.get("child-a").updated_at == created
    assert fake_store.get("child-b").updated_at == created
    assert fake_store.get("root-c").updated_at == damaged
    assert captured == {"client_id": "client-1", "undo_context": "undo-1"}
    assert result == {
        "status": "updated",
        "rootCount": 2,
        "noteCount": 4,
        "changedNoteCount": 3,
        "updateUUID": "uuid-reset-updated",
    }


def test_reset_updated_at_noops_when_all_context_roots_already_match(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = datetime(2026, 1, 1, tzinfo=timezone.utc)
    fake_store = _FakeStore(
        [
            _FakeRecord("root-a", None, created, created),
            _FakeRecord("root-b", None, created, created),
        ]
    )
    monkeypatch.setattr(reset_module, "store", fake_store)
    changed_ids = _install_db_fakes(monkeypatch)

    called = {"undo": False}
    monkeypatch.setattr(reset_module, "reset_undo_stack", lambda *args, **kwargs: called.update(undo=True))

    result = CmdResetUpdatedAtToCreatedAt(
        search_query=None,
        client_id="client-1",
        undo_context="undo-1",
        viewport={"scrollY": 0},
    ).execute()

    assert changed_ids == []
    assert called["undo"] is False
    assert result == {
        "status": "noop",
        "reason": "already_reset",
        "rootCount": 2,
        "noteCount": 2,
        "changedNoteCount": 0,
    }


def test_reset_updated_at_route_normalizes_empty_search_query(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notes_route, "_require_viewport", lambda body: {"scrollY": 0})

    captured: dict[str, object] = {}

    class _FakeCmdResetUpdatedAt:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

        def execute(self) -> dict[str, str]:
            return {"status": "updated"}

    monkeypatch.setattr(notes_route, "CmdResetUpdatedAtToCreatedAt", _FakeCmdResetUpdatedAt)

    result = notes_route.reset_updated_at_to_created_at_endpoint(
        {
            "search_query": "",
            "clientId": "client-1",
            "undoContext": "undo-1",
            "viewport": {"scrollY": 0},
        }
    )

    assert captured == {
        "search_query": None,
        "client_id": "client-1",
        "undo_context": "undo-1",
        "viewport": {"scrollY": 0},
    }
    assert result == {"status": "updated"}
