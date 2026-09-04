from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.api.deps import get_db
from app.db.notes_sql import fetch_note, insert_note
from app.db.session import begin_request_transaction, begin_writer, get_request_session
from app.models.database import SafeSession


def _insert_minimal_note(note_id: str) -> None:
    now = datetime.now(timezone.utc)
    with begin_writer() as connection:
        insert_note(
            connection,
            note_id=note_id,
            content="content",
            encryption_nonce=None,
            encryption_tag=None,
            tags="",
            tags_encryption_nonce=None,
            tags_encryption_tag=None,
            proposed_tags="",
            proposed_tags_encryption_nonce=None,
            proposed_tags_encryption_tag=None,
            parent_id=None,
            prev_id=None,
            next_id=None,
            is_collapsed=False,
            created_at=now,
            updated_at=now,
        )


def test_request_transaction_rolls_back_nested_begin_writer_blocks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    try:
        with pytest.raises(RuntimeError, match="boom"):
            with begin_request_transaction():
                _insert_minimal_note("rolled-back-note")

                request_session = get_request_session()
                assert request_session is not None
                with SafeSession.allow_reads("tests:request_transaction:inside"):
                    assert fetch_note(request_session.connection(), "rolled-back-note") is not None

                raise RuntimeError("boom")

        session = SafeSession()
        try:
            with SafeSession.allow_reads("tests:request_transaction:after_rollback"):
                assert fetch_note(session.connection(), "rolled-back-note") is None
        finally:
            session.close()
    finally:
        SafeSession.use_file_db()


def test_get_db_and_begin_writer_share_request_transaction_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    try:
        dependency = get_db()
        with begin_request_transaction():
            db = next(dependency)
            assert db is get_request_session()

            _insert_minimal_note("committed-note")

            with SafeSession.allow_reads("tests:request_transaction:before_commit"):
                assert fetch_note(db.connection(), "committed-note") is not None

        with pytest.raises(StopIteration):
            next(dependency)

        session = SafeSession()
        try:
            with SafeSession.allow_reads("tests:request_transaction:after_commit"):
                stored = fetch_note(session.connection(), "committed-note")
            assert stored is not None
            assert stored["id"] == "committed-note"
        finally:
            session.close()
    finally:
        SafeSession.use_file_db()
