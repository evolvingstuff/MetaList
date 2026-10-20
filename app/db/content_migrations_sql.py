"""The namespace's record of one-time content passes (namespace_content_migrations):
each pass's id, and whether it completed in this database."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from .engine import GuardedConnection
from .raw_connection import raw_sqlite_connection
from .schema import NAMESPACE_CONTENT_MIGRATIONS_TABLE

_COMPLETE = "complete"


def _conn(connection: GuardedConnection | sqlite3.Connection) -> sqlite3.Connection:
    return raw_sqlite_connection(connection)


def is_content_migration_complete(connection: GuardedConnection | sqlite3.Connection, migration_id: str) -> bool:
    row = _conn(connection).execute(
        f"SELECT status FROM {NAMESPACE_CONTENT_MIGRATIONS_TABLE} WHERE migration_id = ?",
        (migration_id,),
    ).fetchone()
    return row is not None and row[0] == _COMPLETE


def record_content_migration_complete(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    migration_id: str,
    converted_count: int,
    superseded_prefix: str,
) -> None:
    """Records migration_id as complete, replacing the records of the passes it
    supersedes (their ids start with superseded_prefix)."""
    assert migration_id.startswith(superseded_prefix), "a pass supersedes its own earlier versions"
    assert converted_count >= 0
    now = datetime.now(timezone.utc).isoformat()
    raw = _conn(connection)
    raw.execute(
        f"DELETE FROM {NAMESPACE_CONTENT_MIGRATIONS_TABLE} WHERE substr(migration_id, 1, ?) = ?",
        (len(superseded_prefix), superseded_prefix),
    )
    raw.execute(
        f"INSERT INTO {NAMESPACE_CONTENT_MIGRATIONS_TABLE} (migration_id, status, converted_count, "
        "unresolved_count, last_attempt_at, completed_at, created_at, updated_at) "
        "VALUES (?, ?, ?, 0, ?, ?, ?, ?)",
        (migration_id, _COMPLETE, converted_count, now, now, now, now),
    )
