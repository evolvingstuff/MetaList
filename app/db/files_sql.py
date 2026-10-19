"""Composable sqlite helpers for the encrypted files table."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Iterable, Optional

from app.db.file_schema import FILE_PREVIEW_VARIANTS, FILE_PREVIEWS_TABLE, FILES_TABLE


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

    content_revision = row["content_revision"]
    if not isinstance(content_revision, int) or content_revision < 1:
        raise TypeError(f"files.content_revision must be a positive integer | file_id={file_id} value={content_revision!r}")

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
        "content_revision": content_revision,
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


_METADATA_COLUMNS = "id, title, title_encryption_nonce, title_encryption_tag, metadata_json, metadata_encryption_nonce, metadata_encryption_tag, created_at, updated_at, content_revision, X'' AS blob_data, blob_encryption_nonce, blob_encryption_tag"


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


def replace_file_content_fields(
    connection: sqlite3.Connection,
    *,
    file_id: str,
    metadata_json: str,
    metadata_encryption_nonce: Optional[bytes],
    metadata_encryption_tag: Optional[bytes],
    blob_data: bytes,
    blob_encryption_nonce: Optional[bytes],
    blob_encryption_tag: Optional[bytes],
    expected_revision: int,
    updated_at: datetime,
) -> int:
    """Replace a file's content when it is still at expected_revision; returns the updated row count."""
    if not isinstance(expected_revision, int) or expected_revision < 1:
        raise TypeError(f"expected_revision must be a positive integer, got {expected_revision!r}")
    cursor = connection.execute(
        f"""
        UPDATE {FILES_TABLE}
        SET
            metadata_json = ?,
            metadata_encryption_nonce = ?,
            metadata_encryption_tag = ?,
            blob_data = ?,
            blob_encryption_nonce = ?,
            blob_encryption_tag = ?,
            updated_at = ?,
            content_revision = content_revision + 1
        WHERE id = ? AND content_revision = ?
        """,
        (
            metadata_json,
            metadata_encryption_nonce,
            metadata_encryption_tag,
            blob_data,
            blob_encryption_nonce,
            blob_encryption_tag,
            _serialize_datetime(updated_at),
            file_id,
            expected_revision,
        ),
    )
    return int(cursor.rowcount)


def _require_preview_variant(variant: str) -> None:
    if variant not in FILE_PREVIEW_VARIANTS:
        raise ValueError(f"file preview variant must be one of {FILE_PREVIEW_VARIANTS}, got {variant!r}")


def _deserialize_preview_row(row: sqlite3.Row) -> dict[str, object]:
    file_id = row["file_id"]
    content_revision = row["content_revision"]
    if not isinstance(content_revision, int) or content_revision < 1:
        raise TypeError(f"file_previews.content_revision invalid | file_id={file_id} value={content_revision!r}")
    updated_at = row["updated_at"]
    if not isinstance(updated_at, str):
        raise TypeError(f"file_previews.updated_at must be a string | file_id={file_id}")
    return {
        "file_id": file_id,
        "variant": row["variant"],
        "mime_type": row["mime_type"],
        "preview_data": row["preview_data"],
        "preview_encryption_nonce": row["preview_encryption_nonce"],
        "preview_encryption_tag": row["preview_encryption_tag"],
        "content_revision": content_revision,
        "updated_at": datetime.fromisoformat(updated_at),
    }


def upsert_file_preview(
    connection: sqlite3.Connection,
    *,
    file_id: str,
    variant: str,
    mime_type: str,
    preview_data: bytes,
    preview_encryption_nonce: Optional[bytes],
    preview_encryption_tag: Optional[bytes],
    content_revision: int,
    updated_at: datetime,
) -> None:
    _require_preview_variant(variant)
    connection.execute(
        f"""
        INSERT INTO {FILE_PREVIEWS_TABLE} (
            file_id, variant, mime_type, preview_data, preview_encryption_nonce,
            preview_encryption_tag, content_revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_id, variant) DO UPDATE SET
            mime_type = excluded.mime_type,
            preview_data = excluded.preview_data,
            preview_encryption_nonce = excluded.preview_encryption_nonce,
            preview_encryption_tag = excluded.preview_encryption_tag,
            content_revision = excluded.content_revision,
            updated_at = excluded.updated_at
        """,
        (
            file_id,
            variant,
            mime_type,
            preview_data,
            preview_encryption_nonce,
            preview_encryption_tag,
            content_revision,
            _serialize_datetime(updated_at),
        ),
    )


def delete_file_previews(connection: sqlite3.Connection, file_id: str) -> int:
    cursor = connection.execute(f"DELETE FROM {FILE_PREVIEWS_TABLE} WHERE file_id = ?", (file_id,))
    return cursor.rowcount


def fetch_file_preview(connection: sqlite3.Connection, file_id: str, variant: str) -> Optional[dict[str, object]]:
    _require_preview_variant(variant)
    row = connection.execute(
        f"SELECT * FROM {FILE_PREVIEWS_TABLE} WHERE file_id = ? AND variant = ?",
        (file_id, variant),
    ).fetchone()
    if row is None:
        return None
    return _deserialize_preview_row(row)


def fetch_all_file_previews(connection: sqlite3.Connection) -> list[dict[str, object]]:
    rows = connection.execute(f"SELECT * FROM {FILE_PREVIEWS_TABLE} ORDER BY file_id ASC, variant ASC").fetchall()
    return [_deserialize_preview_row(row) for row in rows]


def update_file_preview_storage_fields(
    connection: sqlite3.Connection,
    *,
    file_id: str,
    variant: str,
    preview_data: bytes,
    preview_encryption_nonce: Optional[bytes],
    preview_encryption_tag: Optional[bytes],
) -> None:
    """Rewrite preview ciphertext during encryption migrations without changing its revision."""
    _require_preview_variant(variant)
    cursor = connection.execute(
        f"""
        UPDATE {FILE_PREVIEWS_TABLE}
        SET preview_data = ?, preview_encryption_nonce = ?, preview_encryption_tag = ?
        WHERE file_id = ? AND variant = ?
        """,
        (preview_data, preview_encryption_nonce, preview_encryption_tag, file_id, variant),
    )
    if cursor.rowcount != 1:
        raise RuntimeError(f"file preview rewrite expected one row | file_id={file_id} variant={variant}")
