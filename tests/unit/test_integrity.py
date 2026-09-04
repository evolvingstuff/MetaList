from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.db.notes_sql import insert_note
from app.db.session import begin_writer
from app.models.database import SafeSession
from app.models.list_traversal import ListTraversal
import app.services.integrity as integrity


def _insert_note(
    *,
    note_id: str,
    parent_id: str | None,
    prev_id: str | None,
    next_id: str | None,
) -> None:
    now = datetime.now(timezone.utc)
    with begin_writer() as connection:
        insert_note(
            connection,
            note_id=note_id,
            content="",
            encryption_nonce=None,
            encryption_tag=None,
            tags="",
            tags_encryption_nonce=None,
            tags_encryption_tag=None,
            proposed_tags="",
            proposed_tags_encryption_nonce=None,
            proposed_tags_encryption_tag=None,
            parent_id=parent_id,
            prev_id=prev_id,
            next_id=next_id,
            is_collapsed=False,
            created_at=now,
            updated_at=now,
        )


def test_assert_linked_list_integrity_validates_nested_lists_in_one_pass(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    monkeypatch.setattr(
        ListTraversal,
        "validate_list",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("assert_linked_list_integrity must not run one query per parent")
        ),
    )
    try:
        _insert_note(note_id="root-1", parent_id=None, prev_id=None, next_id="root-2")
        _insert_note(note_id="root-2", parent_id=None, prev_id="root-1", next_id=None)
        _insert_note(note_id="child-1", parent_id="root-1", prev_id=None, next_id="child-2")
        _insert_note(note_id="child-2", parent_id="root-1", prev_id="child-1", next_id=None)

        session = SafeSession()
        try:
            integrity.assert_linked_list_integrity(session, "test")
        finally:
            session.close()
    finally:
        SafeSession.use_file_db()


def test_assert_linked_list_integrity_rejects_broken_bidirectional_link(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    try:
        _insert_note(note_id="root-1", parent_id=None, prev_id=None, next_id="root-2")
        _insert_note(note_id="root-2", parent_id=None, prev_id=None, next_id=None)

        session = SafeSession()
        try:
            with pytest.raises(RuntimeError, match="Linked list integrity check failed"):
                integrity.assert_linked_list_integrity(session, "test")
        finally:
            session.close()
    finally:
        SafeSession.use_file_db()
