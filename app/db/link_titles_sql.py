"""SQLite helpers for cached link titles."""

from __future__ import annotations

from datetime import datetime
import sqlite3

from app.db.engine import GuardedConnection
from .raw_connection import raw_sqlite_connection
from app.db.schema import LINK_TITLES_TABLE


def _conn(connection: GuardedConnection | sqlite3.Connection) -> GuardedConnection | sqlite3.Connection:
    if isinstance(connection, GuardedConnection):
        return connection
    return raw_sqlite_connection(connection)


def _serialize_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, datetime):
        raise TypeError("value must be a datetime or None")
    return value.isoformat()


def _parse_datetime(value: object, *, field_name: str) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a datetime string or None")
    return datetime.fromisoformat(value)


def fetch_all_link_title_rows(
    connection: GuardedConnection | sqlite3.Connection,
) -> list[dict[str, object]]:
    conn = _conn(connection)
    rows = conn.execute(
        f"""
        SELECT
            id,
            url,
            url_encryption_nonce,
            url_encryption_tag,
            title,
            title_encryption_nonce,
            title_encryption_tag,
            status,
            last_error_kind,
            last_checked_at,
            last_success_at,
            last_failure_at,
            next_check_after,
            failure_count,
            created_at,
            updated_at
        FROM {LINK_TITLES_TABLE}
        ORDER BY id ASC
        """,
    ).fetchall()

    out: list[dict[str, object]] = []
    for row in rows:
        out.append(
            {
                "id": row["id"],
                "url": row["url"],
                "url_encryption_nonce": row["url_encryption_nonce"],
                "url_encryption_tag": row["url_encryption_tag"],
                "title": row["title"],
                "title_encryption_nonce": row["title_encryption_nonce"],
                "title_encryption_tag": row["title_encryption_tag"],
                "status": row["status"],
                "last_error_kind": row["last_error_kind"],
                "last_checked_at": _parse_datetime(
                    row["last_checked_at"],
                    field_name="link_titles.last_checked_at",
                ),
                "last_success_at": _parse_datetime(
                    row["last_success_at"],
                    field_name="link_titles.last_success_at",
                ),
                "last_failure_at": _parse_datetime(
                    row["last_failure_at"],
                    field_name="link_titles.last_failure_at",
                ),
                "next_check_after": _parse_datetime(
                    row["next_check_after"],
                    field_name="link_titles.next_check_after",
                ),
                "failure_count": row["failure_count"],
                "created_at": _parse_datetime(row["created_at"], field_name="link_titles.created_at"),
                "updated_at": _parse_datetime(row["updated_at"], field_name="link_titles.updated_at"),
            }
        )
    return out


def insert_link_title_row(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    url: str,
    url_encryption_nonce: bytes | None,
    url_encryption_tag: bytes | None,
    title: str | None,
    title_encryption_nonce: bytes | None,
    title_encryption_tag: bytes | None,
    status: str,
    last_error_kind: str | None,
    last_checked_at: datetime,
    last_success_at: datetime | None,
    last_failure_at: datetime | None,
    next_check_after: datetime | None,
    failure_count: int,
    created_at: datetime,
    updated_at: datetime,
) -> int:
    conn = _conn(connection)
    cursor = conn.execute(
        f"""
        INSERT INTO {LINK_TITLES_TABLE} (
            url,
            url_encryption_nonce,
            url_encryption_tag,
            title,
            title_encryption_nonce,
            title_encryption_tag,
            status,
            last_error_kind,
            last_checked_at,
            last_success_at,
            last_failure_at,
            next_check_after,
            failure_count,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            url_encryption_nonce,
            url_encryption_tag,
            title,
            title_encryption_nonce,
            title_encryption_tag,
            status,
            last_error_kind,
            _serialize_datetime(last_checked_at),
            _serialize_datetime(last_success_at),
            _serialize_datetime(last_failure_at),
            _serialize_datetime(next_check_after),
            failure_count,
            _serialize_datetime(created_at),
            _serialize_datetime(updated_at),
        ),
    )
    row_id = cursor.lastrowid
    if not isinstance(row_id, int):
        raise RuntimeError("Expected sqlite lastrowid to be int")
    return row_id


def update_link_title_row(
    connection: GuardedConnection | sqlite3.Connection,
    row_id: int,
    *,
    url: str,
    url_encryption_nonce: bytes | None,
    url_encryption_tag: bytes | None,
    title: str | None,
    title_encryption_nonce: bytes | None,
    title_encryption_tag: bytes | None,
    status: str,
    last_error_kind: str | None,
    last_checked_at: datetime,
    last_success_at: datetime | None,
    last_failure_at: datetime | None,
    next_check_after: datetime | None,
    failure_count: int,
    updated_at: datetime,
) -> None:
    if not isinstance(row_id, int):
        raise TypeError("row_id must be an int")
    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {LINK_TITLES_TABLE}
        SET url = ?,
            url_encryption_nonce = ?,
            url_encryption_tag = ?,
            title = ?,
            title_encryption_nonce = ?,
            title_encryption_tag = ?,
            status = ?,
            last_error_kind = ?,
            last_checked_at = ?,
            last_success_at = ?,
            last_failure_at = ?,
            next_check_after = ?,
            failure_count = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (
            url,
            url_encryption_nonce,
            url_encryption_tag,
            title,
            title_encryption_nonce,
            title_encryption_tag,
            status,
            last_error_kind,
            _serialize_datetime(last_checked_at),
            _serialize_datetime(last_success_at),
            _serialize_datetime(last_failure_at),
            _serialize_datetime(next_check_after),
            failure_count,
            _serialize_datetime(updated_at),
            row_id,
        ),
    )
