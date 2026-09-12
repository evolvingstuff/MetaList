"""Composable sqlite helpers for the encrypted files table."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Iterable, Optional

from app.db.file_schema import FILES_TABLE


def _serialize_datetime(value: datetime) -> str:
    if not isinstance(value, datetime):
        raise TypeError(f"value must be a datetime, got {type(value)}")
    return value.isoformat()


def _deserialize_row(row: sqlite3.Row) -> dict[str, object]:
    file_id = row["id"]

    def _parse_datetime(field: str) -> datetime:
        raw = row[field]
        if not isinstance(raw, str):
            raise TypeError(f"files.{field} must be a string | file_id={file_id} value={raw!r}")
        return datetime.fromisoformat(raw)

    return {
        "id": file_id,
        "title": row["title"],
        "title_encryption_nonce": row["title_encryption_nonce"],
        "title_encryption_tag": row["title_encryption_tag"],
        "metadata_json": row["metadata_json"],
        "metadata_encryption_nonce": row["metadata_encryption_nonce"],
        "metadata_encryption_tag": row["metadata_encryption_tag"],
        "blob_data": row["blob_data"],
        "blob_encryption_nonce": row["blob_encryption_nonce"],
        "blob_encryption_tag": row["blob_encryption_tag"],
        "created_at": _parse_datetime("created_at"),
        "updated_at": _parse_datetime("updated_at"),
    }


def insert_file(
    connection: sqlite3.Connection,
    *,
    file_id: str,
    title: str,
    title_encryption_nonce: Optional[bytes],
    title_encryption_tag: Optional[bytes],
    metadata_json: str,
    metadata_encryption_nonce: Optional[bytes],
    metadata_encryption_tag: Optional[bytes],
    blob_data: bytes,
    blob_encryption_nonce: Optional[bytes],
    blob_encryption_tag: Optional[bytes],
    created_at: datetime,
    updated_at: datetime,
) -> None:
    connection.execute(
        f"""
        INSERT INTO {FILES_TABLE} (
            id,
            title,
            title_encryption_nonce,
            title_encryption_tag,
            metadata_json,
            metadata_encryption_nonce,
            metadata_encryption_tag,
            blob_data,
            blob_encryption_nonce,
            blob_encryption_tag,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            file_id,
            title,
            title_encryption_nonce,
            title_encryption_tag,
            metadata_json,
            metadata_encryption_nonce,
            metadata_encryption_tag,
            blob_data,
            blob_encryption_nonce,
            blob_encryption_tag,
            _serialize_datetime(created_at),
            _serialize_datetime(updated_at),
        ),
    )


_METADATA_COLUMNS = "id, title, title_encryption_nonce, title_encryption_tag, metadata_json, metadata_encryption_nonce, metadata_encryption_tag, created_at, updated_at, X'' AS blob_data, blob_encryption_nonce, blob_encryption_tag"


class AttachmentSizeExceeded(ValueError):
    pass


def fetch_file_metadata(connection: sqlite3.Connection, file_id: str):
    row = connection.execute(f"SELECT {_METADATA_COLUMNS} FROM {FILES_TABLE} WHERE id=?", (file_id,)).fetchone()
    if row is None:
        return None
    return _deserialize_row(row)


def fetch_all_file_metadata(connection: sqlite3.Connection):
    return [_deserialize_row(row) for row in connection.execute(f"SELECT {_METADATA_COLUMNS} FROM {FILES_TABLE} ORDER BY created_at ASC")]


def require_file_size(connection: sqlite3.Connection, file_id: str, limit: int) -> None:
    row = connection.execute(f"SELECT length(blob_data) FROM {FILES_TABLE} WHERE id=?", (file_id,)).fetchone()
    if row is not None and row[0] > limit:
        raise AttachmentSizeExceeded('Attachment exceeds the configured size limit')


def fetch_file(connection: sqlite3.Connection, file_id: str) -> Optional[dict[str, object]]:
    row = connection.execute(
        f"SELECT * FROM {FILES_TABLE} WHERE id = ?",
        (file_id,),
    ).fetchone()
    if row is None:
        return None
    return _deserialize_row(row)


def fetch_all_file_ids(connection: sqlite3.Connection) -> list[str]:
    rows = connection.execute(f"SELECT id FROM {FILES_TABLE} ORDER BY created_at ASC").fetchall()
    ids: list[str] = []
    for row in rows:
        file_id = row["id"]
        if not isinstance(file_id, str):
            raise TypeError(f"files.id must be a string, got {type(file_id)}")
        ids.append(file_id)
    return ids


def fetch_all_files(connection: sqlite3.Connection) -> list[dict[str, object]]:
    rows = connection.execute(f"SELECT * FROM {FILES_TABLE} ORDER BY created_at ASC").fetchall()
    records: list[dict[str, object]] = []
    for row in rows:
        records.append(_deserialize_row(row))
    return records


def update_file_storage_fields(
    connection: sqlite3.Connection,
    *,
    file_id: str,
    title: str,
    title_encryption_nonce: Optional[bytes],
    title_encryption_tag: Optional[bytes],
    metadata_json: str,
    metadata_encryption_nonce: Optional[bytes],
    metadata_encryption_tag: Optional[bytes],
    blob_data: bytes,
    blob_encryption_nonce: Optional[bytes],
    blob_encryption_tag: Optional[bytes],
    updated_at: datetime,
) -> None:
    connection.execute(
        f"""
        UPDATE {FILES_TABLE}
        SET
            title = ?,
            title_encryption_nonce = ?,
            title_encryption_tag = ?,
            metadata_json = ?,
            metadata_encryption_nonce = ?,
            metadata_encryption_tag = ?,
            blob_data = ?,
            blob_encryption_nonce = ?,
            blob_encryption_tag = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (
            title,
            title_encryption_nonce,
            title_encryption_tag,
            metadata_json,
            metadata_encryption_nonce,
            metadata_encryption_tag,
            blob_data,
            blob_encryption_nonce,
            blob_encryption_tag,
            _serialize_datetime(updated_at),
            file_id,
        ),
    )


def delete_files(connection: sqlite3.Connection, file_ids: Iterable[str]) -> int:
    identifiers = list(file_ids)
    if not identifiers:
        return 0
    placeholders = ",".join(["?"] * len(identifiers))
    cursor = connection.execute(
        f"DELETE FROM {FILES_TABLE} WHERE id IN ({placeholders})",
        tuple(identifiers),
    )
    return int(cursor.rowcount)
