"""SQLite helpers for encrypted backup settings stored in app_settings."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from .engine import GuardedConnection
from .raw_connection import raw_sqlite_connection
from .schema import APP_SETTINGS_TABLE


def _conn(connection: GuardedConnection | sqlite3.Connection) -> sqlite3.Connection:
    return raw_sqlite_connection(connection)


def _serialize_datetime(value: datetime | None) -> str:
    if value is None:
        value = datetime.now(timezone.utc)
    return value.isoformat()


def fetch_backup_settings_row(connection: GuardedConnection | sqlite3.Connection) -> dict[str, object] | None:
    conn = _conn(connection)
    row = conn.execute(
        f"""
        SELECT backup_settings_json,
               backup_settings_encryption_nonce,
               backup_settings_encryption_tag
        FROM {APP_SETTINGS_TABLE}
        WHERE id = 1
        """
    ).fetchone()
    if row is None:
        return None
    return {
        "backup_settings_json": row["backup_settings_json"],
        "backup_settings_encryption_nonce": row["backup_settings_encryption_nonce"],
        "backup_settings_encryption_tag": row["backup_settings_encryption_tag"],
    }


def upsert_backup_settings_row(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    backup_settings_json: str,
    backup_settings_encryption_nonce: bytes | None,
    backup_settings_encryption_tag: bytes | None,
    updated_at: datetime,
) -> None:
    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {APP_SETTINGS_TABLE}
        SET backup_settings_json = ?,
            backup_settings_encryption_nonce = ?,
            backup_settings_encryption_tag = ?,
            updated_at = ?
        WHERE id = 1
        """,
        (
            backup_settings_json,
            backup_settings_encryption_nonce,
            backup_settings_encryption_tag,
            _serialize_datetime(updated_at),
        ),
    )
