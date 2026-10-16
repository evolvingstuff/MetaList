"""SQLite helpers for reminder payload rows."""

from __future__ import annotations

from datetime import datetime
import sqlite3
from typing import Optional

from app.db.engine import GuardedConnection
from .raw_connection import raw_sqlite_connection
from app.db.schema import REMINDERS_TABLE


def _conn(connection: GuardedConnection | sqlite3.Connection) -> GuardedConnection | sqlite3.Connection:
    if isinstance(connection, GuardedConnection):
        return connection
    return raw_sqlite_connection(connection)


def _serialize_datetime(value: datetime) -> str:
    if not isinstance(value, datetime):
        raise TypeError("value must be a datetime")
    return value.isoformat()


def fetch_all_reminder_rows(
    connection: GuardedConnection | sqlite3.Connection,
) -> list[dict[str, object]]:
    conn = _conn(connection)
    rows = conn.execute(
        f"""
        SELECT
            id,
            payload_json,
            payload_encryption_nonce,
            payload_encryption_tag,
            created_at,
            updated_at
        FROM {REMINDERS_TABLE}
        ORDER BY created_at ASC, id ASC
        """,
    ).fetchall()
    out: list[dict[str, object]] = []
    for row in rows:
        out.append(
            {
                "id": row["id"],
                "payload_json": row["payload_json"],
                "payload_encryption_nonce": row["payload_encryption_nonce"],
                "payload_encryption_tag": row["payload_encryption_tag"],
                "created_at": datetime.fromisoformat(row["created_at"]),
                "updated_at": datetime.fromisoformat(row["updated_at"]),
            }
        )
    return out


def upsert_reminder_row(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    reminder_id: str,
    payload_json: str,
    payload_encryption_nonce: Optional[bytes],
    payload_encryption_tag: Optional[bytes],
    created_at: datetime,
    updated_at: datetime,
) -> None:
    if not isinstance(reminder_id, str) or reminder_id == "":
        raise ValueError("reminder_id must be a non-empty string")
    if not isinstance(payload_json, str) or payload_json == "":
        raise ValueError("payload_json must be a non-empty string")
    conn = _conn(connection)
    conn.execute(
        f"""
        INSERT INTO {REMINDERS_TABLE} (
            id,
            payload_json,
            payload_encryption_nonce,
            payload_encryption_tag,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            payload_json = excluded.payload_json,
            payload_encryption_nonce = excluded.payload_encryption_nonce,
            payload_encryption_tag = excluded.payload_encryption_tag,
            updated_at = excluded.updated_at
        """,
        (
            reminder_id,
            payload_json,
            payload_encryption_nonce,
            payload_encryption_tag,
            _serialize_datetime(created_at),
            _serialize_datetime(updated_at),
        ),
    )


def delete_reminder_row(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    reminder_id: str,
) -> None:
    if not isinstance(reminder_id, str) or reminder_id == "":
        raise ValueError("reminder_id must be a non-empty string")
    conn = _conn(connection)
    conn.execute(
        f"DELETE FROM {REMINDERS_TABLE} WHERE id = ?",
        (reminder_id,),
    )


def delete_all_reminder_rows(connection: GuardedConnection | sqlite3.Connection) -> None:
    conn = _conn(connection)
    conn.execute(f"DELETE FROM {REMINDERS_TABLE}")
