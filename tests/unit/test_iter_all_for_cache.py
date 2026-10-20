"""Unlocking reads every note row through iter_all_for_cache: plain tuples made into
dicts, faster than reading a sqlite3.Row by name, and exactly what _deserialize_row
gives for the same rows."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import pytest

from app.db.notes_sql import _deserialize_row, insert_note, iter_all_for_cache
from app.db.schema import initialize_schema

_CREATED = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
_UPDATED = datetime(2026, 6, 7, 8, 9, 10, tzinfo=timezone.utc)


def _database() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    for note_id, prev_id, next_id, collapsed, nonce in (
        ("a", None, "b", True, b"n" * 12), ("b", "a", None, False, None),
    ):
        insert_note(
            connection, note_id=note_id, content=f"<div>{note_id}</div>", encryption_nonce=nonce,
            encryption_tag=nonce, tags="trip", tags_encryption_nonce=None, tags_encryption_tag=None,
            proposed_tags="", proposed_tags_encryption_nonce=None, proposed_tags_encryption_tag=None,
            parent_id=None, prev_id=prev_id, next_id=next_id, is_collapsed=collapsed,
            created_at=_CREATED, updated_at=_UPDATED,
        )
    return connection


def test_rows_are_exactly_what_deserialize_row_gives() -> None:
    connection = _database()
    expected = [_deserialize_row(row) for row in connection.execute("SELECT * FROM notes")]
    assert list(iter_all_for_cache(connection)) == expected
    assert expected[0]["is_collapsed"] is True and expected[0]["created_at"] == _CREATED


def test_a_row_with_a_broken_timestamp_fails_loudly() -> None:
    connection = _database()
    connection.execute("UPDATE notes SET updated_at = X'00' WHERE id = 'b'")
    with pytest.raises(TypeError, match="notes.updated_at"):
        list(iter_all_for_cache(connection))
