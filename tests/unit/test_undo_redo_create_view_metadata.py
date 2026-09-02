from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
from types import SimpleNamespace
from typing import Iterator

import pytest

from app.services import snapshot
from app.services import undo_state
from app.usecases import create_note
from app.usecases import delete_subtree


class _RoundTripStore:
    def __init__(self) -> None:
        self._record: SimpleNamespace | None = None

    def children(self, parent_id: str | None) -> list[str]:
        if parent_id is None and self._record is not None:
            return [self._record.id]
        return []

    def insert_after(
        self,
        note: SimpleNamespace,
        parent_id: str | None,
        prev_id: str | None,
    ) -> None:
        assert self._record is None
        self._record = SimpleNamespace(
            id=note.id,
            parent_id=parent_id,
            prev_id=prev_id,
            next_id=None,
            is_collapsed=note.is_collapsed,
            content=note.content,
            tags=note.tags,
            created_at=note.created_at,
            updated_at=note.updated_at,
        )

    def get(self, note_id: str) -> SimpleNamespace:
        assert self._record is not None
        assert self._record.id == note_id
        return self._record

    def delete_subtree(self, note_id: str) -> None:
        assert self._record is not None
        assert self._record.id == note_id
        self._record = None

    def restore_subtree(self, records: list[SimpleNamespace]) -> None:
        assert self._record is None
        assert len(records) == 1
        self._record = records[0]

    def get_note(self, note_id: str) -> SimpleNamespace:
        return self.get(note_id)

    def get_children(self, parent_id: str | None) -> list[str]:
        return self.children(parent_id)

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> frozenset[str]:
        self.get(note_id)
        return frozenset()


@contextmanager
def _writer() -> Iterator[object]:
    yield object()


def _configure_round_trip_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    store: _RoundTripStore,
) -> None:
    monkeypatch.setattr(create_note, "store", store)
    monkeypatch.setattr(delete_subtree, "store", store)
    monkeypatch.setattr(undo_state, "store", store)
    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(create_note, "begin_writer", _writer)
    monkeypatch.setattr(delete_subtree, "begin_writer", _writer)
    monkeypatch.setattr(create_note, "db_insert_note", lambda _connection, **_kwargs: None)
    monkeypatch.setattr(
        create_note,
        "db_update_links_preserving_updated_at",
        lambda _connection, _note_id, **_kwargs: None,
    )
    monkeypatch.setattr(delete_subtree, "db_delete_notes", lambda _connection, _note_ids: None)
    monkeypatch.setattr(
        delete_subtree,
        "db_insert_note",
        lambda _connection, **_kwargs: None,
    )
    monkeypatch.setattr(
        delete_subtree,
        "db_update_links_preserving_updated_at",
        lambda _connection, _note_id, **_kwargs: None,
    )
    monkeypatch.setattr(create_note, "encrypt", lambda _value, _token: (b"c", b"n", b"t"))
    monkeypatch.setattr(delete_subtree, "encrypt", lambda _value, _token: (b"c", b"n", b"t"))
    monkeypatch.setattr(create_note, "generate_new_uuid", lambda: "sync-create")
    monkeypatch.setattr(undo_state, "generate_new_uuid", lambda: "sync-history")


def test_create_undo_redo_preserves_timestamp_metadata_for_next_view(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    undo_state.reset_all_undo_state()
    store = _RoundTripStore()
    _configure_round_trip_dependencies(monkeypatch, store)

    command = create_note.CmdCreateNote(
        first_visible_note_id=None,
        search_query=None,
        token="token",
        client_id="client-1",
        undo_context="tab:main|search:|epoch:0",
        viewport={"scrollY": 0, "scrollAnchor": None},
    )
    created = command.execute()
    note_id = created["id"]
    original = store.get(note_id)
    assert isinstance(original.created_at, datetime)
    assert isinstance(original.updated_at, datetime)

    undo_payload = undo_state.undo("client-1", "token")
    assert undo_payload is not None
    assert undo_payload["opType"] == "create_note"

    redo_payload = undo_state.redo("client-1", "token")
    assert redo_payload is not None
    assert redo_payload["opType"] == "create_note"

    metadata = snapshot._SnapshotTraversalCache().build_metadata(note_id)
    assert metadata["createdAt"] == original.created_at.isoformat()
    assert metadata["updatedAt"] == original.updated_at.isoformat()
