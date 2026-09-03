"""Composable sqlite helpers for the notes table."""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime
from typing import Iterable, Optional, Any

from .engine import GuardedConnection
from .schema import NOTES_TABLE


def _conn(connection: GuardedConnection | sqlite3.Connection) -> sqlite3.Connection:
    raw_connection = getattr(connection, "raw_connection", None)
    if isinstance(raw_connection, sqlite3.Connection):
        return raw_connection
    assert isinstance(connection, sqlite3.Connection)
    return connection


def _serialize_datetime(value: datetime) -> str:
    assert isinstance(value, datetime)
    return value.isoformat()


def _deserialize_row(row: sqlite3.Row) -> dict:
    note_id = row["id"]

    def _parse_datetime(field: str) -> datetime:
        raw = row[field]
        if not isinstance(raw, str):
            raise TypeError(f"notes.{field} must be a string | note_id={note_id} value={raw!r}")
        return datetime.fromisoformat(raw)

    return {
        "id": note_id,
        "content": row["content"],
        "tags": row["tags"],
        "proposed_tags": row["proposed_tags"],
        "encryption_nonce": row["encryption_nonce"],
        "encryption_tag": row["encryption_tag"],
        "tags_encryption_nonce": row["tags_encryption_nonce"],
        "tags_encryption_tag": row["tags_encryption_tag"],
        "proposed_tags_encryption_nonce": row["proposed_tags_encryption_nonce"],
        "proposed_tags_encryption_tag": row["proposed_tags_encryption_tag"],
        "parent_id": row["parent_id"],
        "prev_id": row["prev_id"],
        "next_id": row["next_id"],
        "is_collapsed": bool(row["is_collapsed"]),
        "created_at": _parse_datetime("created_at"),
        "updated_at": _parse_datetime("updated_at"),
    }


def insert_note(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    note_id: str,
    content: str,
    encryption_nonce: Optional[bytes],
    encryption_tag: Optional[bytes],
    tags: str,
    tags_encryption_nonce: Optional[bytes],
    tags_encryption_tag: Optional[bytes],
    proposed_tags: str,
    proposed_tags_encryption_nonce: Optional[bytes],
    proposed_tags_encryption_tag: Optional[bytes],
    parent_id: Optional[str],
    prev_id: Optional[str],
    next_id: Optional[str],
    is_collapsed: bool,
    created_at: datetime,
    updated_at: datetime,
) -> None:
    conn = _conn(connection)
    conn.execute(
        f"""
        INSERT INTO {NOTES_TABLE} (
            id,
            content,
            tags,
            proposed_tags,
            encryption_nonce,
            encryption_tag,
            tags_encryption_nonce,
            tags_encryption_tag,
            proposed_tags_encryption_nonce,
            proposed_tags_encryption_tag,
            parent_id,
            prev_id,
            next_id,
            is_collapsed,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            note_id,
            content,
            tags,
            proposed_tags,
            encryption_nonce,
            encryption_tag,
            tags_encryption_nonce,
            tags_encryption_tag,
            proposed_tags_encryption_nonce,
            proposed_tags_encryption_tag,
            parent_id,
            prev_id,
            next_id,
            int(is_collapsed),
            _serialize_datetime(created_at),
            _serialize_datetime(updated_at),
        ),
    )


def update_note_content(
    connection: GuardedConnection | sqlite3.Connection,
    note_id: str,
    *,
    content: str,
    encryption_nonce: Optional[bytes],
    encryption_tag: Optional[bytes],
    updated_at: datetime,
) -> None:
    update_note_fields(
        connection,
        note_id,
        content=content,
        encryption_nonce=encryption_nonce,
        encryption_tag=encryption_tag,
        updated_at=updated_at,
    )


def update_note_tags(
    connection: GuardedConnection | sqlite3.Connection,
    note_id: str,
    *,
    tags: str,
    tags_encryption_nonce: Optional[bytes],
    tags_encryption_tag: Optional[bytes],
    updated_at: datetime,
) -> None:
    update_note_fields(
        connection,
        note_id,
        tags=tags,
        tags_encryption_nonce=tags_encryption_nonce,
        tags_encryption_tag=tags_encryption_tag,
        updated_at=updated_at,
    )


_LINK_FIELDS = {"parent_id", "prev_id", "next_id", "is_collapsed"}


def update_links(
    connection: GuardedConnection | sqlite3.Connection,
    note_id: str,
    **updates: Any,
) -> None:
    if "updated_at" not in updates:
        raise ValueError("update_links requires updated_at")
    updated_at = updates.pop("updated_at")
    if not isinstance(updated_at, datetime):
        raise TypeError("update_links updated_at must be a datetime")

    fields: list[str] = ["updated_at = ?"]
    values: list = [_serialize_datetime(updated_at)]

    for key in updates:
        if key not in _LINK_FIELDS:
            raise ValueError(f"update_links received unexpected field: {key}")

    if "parent_id" in updates:
        fields.append("parent_id = ?")
        values.append(updates["parent_id"])
    if "prev_id" in updates:
        fields.append("prev_id = ?")
        values.append(updates["prev_id"])
    if "next_id" in updates:
        fields.append("next_id = ?")
        values.append(updates["next_id"])
    if "is_collapsed" in updates:
        is_collapsed = updates["is_collapsed"]
        if not isinstance(is_collapsed, bool):
            raise TypeError("update_links is_collapsed must be a bool")
        fields.append("is_collapsed = ?")
        values.append(int(is_collapsed))

    values.append(note_id)

    conn = _conn(connection)
    sql = f"UPDATE {NOTES_TABLE} SET " + ", ".join(fields) + " WHERE id = ?"
    conn.execute(sql, tuple(values))


def update_links_preserving_updated_at(
    connection: GuardedConnection | sqlite3.Connection,
    note_id: str,
    **updates: Any,
) -> None:
    fields: list[str] = []
    values: list = []

    for key in updates:
        if key not in _LINK_FIELDS:
            raise ValueError(f"update_links_preserving_updated_at received unexpected field: {key}")

    if "parent_id" in updates:
        fields.append("parent_id = ?")
        values.append(updates["parent_id"])
    if "prev_id" in updates:
        fields.append("prev_id = ?")
        values.append(updates["prev_id"])
    if "next_id" in updates:
        fields.append("next_id = ?")
        values.append(updates["next_id"])
    if "is_collapsed" in updates:
        is_collapsed = updates["is_collapsed"]
        if not isinstance(is_collapsed, bool):
            raise TypeError("update_links_preserving_updated_at is_collapsed must be a bool")
        fields.append("is_collapsed = ?")
        values.append(int(is_collapsed))

    if len(fields) == 0:
        raise ValueError("update_links_preserving_updated_at requires at least one link field")

    values.append(note_id)

    conn = _conn(connection)
    sql = f"UPDATE {NOTES_TABLE} SET " + ", ".join(fields) + " WHERE id = ?"
    conn.execute(sql, tuple(values))


def reset_updated_at_to_created_at(
    connection: GuardedConnection | sqlite3.Connection,
    note_ids: list[str],
) -> int:
    if not isinstance(note_ids, list):
        raise TypeError("note_ids must be a list")
    if len(note_ids) == 0:
        return 0

    conn = _conn(connection)
    changed_count = 0
    for note_id in note_ids:
        if not isinstance(note_id, str) or note_id == "":
            raise ValueError("note_ids entries must be non-empty strings")
        cursor = conn.execute(
            f"""
            UPDATE {NOTES_TABLE}
            SET updated_at = created_at
            WHERE id = ?
              AND updated_at != created_at
            """,
            (note_id,),
        )
        changed_count += cursor.rowcount
    return changed_count


def update_note_fields(
    connection: GuardedConnection | sqlite3.Connection,
    note_id: str,
    **updates: Any,
) -> None:
    if "updated_at" not in updates:
        raise ValueError("update_note_fields requires updated_at")
    updated_at = updates.pop("updated_at")
    if not isinstance(updated_at, datetime):
        raise TypeError("update_note_fields updated_at must be a datetime")

    fields: list[str] = ["updated_at = ?"]
    values: list = [_serialize_datetime(updated_at)]

    allowed_fields = {
        "content",
        "encryption_nonce",
        "encryption_tag",
        "tags",
        "tags_encryption_nonce",
        "tags_encryption_tag",
        "proposed_tags",
        "proposed_tags_encryption_nonce",
        "proposed_tags_encryption_tag",
    }

    for key in updates:
        if key not in allowed_fields:
            raise ValueError(f"update_note_fields received unexpected field: {key}")

    if "content" in updates:
        fields.append("content = ?")
        values.append(updates["content"])
    if "encryption_nonce" in updates:
        fields.append("encryption_nonce = ?")
        values.append(updates["encryption_nonce"])
    if "encryption_tag" in updates:
        fields.append("encryption_tag = ?")
        values.append(updates["encryption_tag"])
    if "tags" in updates:
        fields.append("tags = ?")
        values.append(updates["tags"])
    if "tags_encryption_nonce" in updates:
        fields.append("tags_encryption_nonce = ?")
        values.append(updates["tags_encryption_nonce"])
    if "tags_encryption_tag" in updates:
        fields.append("tags_encryption_tag = ?")
        values.append(updates["tags_encryption_tag"])
    if "proposed_tags" in updates:
        fields.append("proposed_tags = ?")
        values.append(updates["proposed_tags"])
    if "proposed_tags_encryption_nonce" in updates:
        fields.append("proposed_tags_encryption_nonce = ?")
        values.append(updates["proposed_tags_encryption_nonce"])
    if "proposed_tags_encryption_tag" in updates:
        fields.append("proposed_tags_encryption_tag = ?")
        values.append(updates["proposed_tags_encryption_tag"])

    values.append(note_id)

    conn = _conn(connection)
    sql = f"UPDATE {NOTES_TABLE} SET " + ", ".join(fields) + " WHERE id = ?"
    conn.execute(sql, tuple(values))


def update_note_fields_preserving_updated_at(
    connection: GuardedConnection | sqlite3.Connection,
    note_id: str,
    **updates: Any,
) -> None:
    fields: list[str] = []
    values: list = []

    allowed_fields = {
        "content",
        "encryption_nonce",
        "encryption_tag",
        "tags",
        "tags_encryption_nonce",
        "tags_encryption_tag",
        "proposed_tags",
        "proposed_tags_encryption_nonce",
        "proposed_tags_encryption_tag",
    }

    for key in updates:
        if key not in allowed_fields:
            raise ValueError(f"update_note_fields_preserving_updated_at received unexpected field: {key}")

    if "content" in updates:
        fields.append("content = ?")
        values.append(updates["content"])
    if "encryption_nonce" in updates:
        fields.append("encryption_nonce = ?")
        values.append(updates["encryption_nonce"])
    if "encryption_tag" in updates:
        fields.append("encryption_tag = ?")
        values.append(updates["encryption_tag"])
    if "tags" in updates:
        fields.append("tags = ?")
        values.append(updates["tags"])
    if "tags_encryption_nonce" in updates:
        fields.append("tags_encryption_nonce = ?")
        values.append(updates["tags_encryption_nonce"])
    if "tags_encryption_tag" in updates:
        fields.append("tags_encryption_tag = ?")
        values.append(updates["tags_encryption_tag"])
    if "proposed_tags" in updates:
        fields.append("proposed_tags = ?")
        values.append(updates["proposed_tags"])
    if "proposed_tags_encryption_nonce" in updates:
        fields.append("proposed_tags_encryption_nonce = ?")
        values.append(updates["proposed_tags_encryption_nonce"])
    if "proposed_tags_encryption_tag" in updates:
        fields.append("proposed_tags_encryption_tag = ?")
        values.append(updates["proposed_tags_encryption_tag"])

    if len(fields) == 0:
        raise ValueError("update_note_fields_preserving_updated_at requires at least one field")

    values.append(note_id)

    conn = _conn(connection)
    sql = f"UPDATE {NOTES_TABLE} SET " + ", ".join(fields) + " WHERE id = ?"
    conn.execute(sql, tuple(values))


def delete_notes(
    connection: GuardedConnection | sqlite3.Connection,
    note_ids: Iterable[str],
) -> None:
    identifiers = list(note_ids)
    if not identifiers:
        return
    placeholders = ",".join(["?"] * len(identifiers))
    sql = f"DELETE FROM {NOTES_TABLE} WHERE id IN ({placeholders})"
    print('DEBUG CHECKPOINT 1')
    t1 = time.perf_counter()
    conn = _conn(connection)
    conn.execute(sql, tuple(identifiers))
    t2 = time.perf_counter()
    print(f'DEBUG CHECKPOINT 2 took {(t2-t1)} seconds')


def fetch_note(
    connection: GuardedConnection | sqlite3.Connection,
    note_id: str,
) -> Optional[dict]:
    conn = _conn(connection)
    row = conn.execute(
        f"SELECT * FROM {NOTES_TABLE} WHERE id = ?",
        (note_id,),
    ).fetchone()
    if row is None:
        return None
    return _deserialize_row(row)


def fetch_children_ordered(
    connection: GuardedConnection | sqlite3.Connection,
    parent_id: Optional[str],
) -> list[dict]:
    conn = _conn(connection)
    if parent_id is None:
        rows = conn.execute(
            f"SELECT * FROM {NOTES_TABLE} WHERE parent_id IS NULL",
        ).fetchall()
    else:
        rows = conn.execute(
            f"SELECT * FROM {NOTES_TABLE} WHERE parent_id = ?",
            (parent_id,),
        ).fetchall()

    if not rows:
        return []

    notes = [_deserialize_row(row) for row in rows]
    by_id = {note["id"]: note for note in notes}
    head = next((note for note in notes if note["prev_id"] is None))
    if not head:
        return list(notes)

    ordered: list[dict] = []
    current = head
    seen: set[str] = set()
    while current["id"] not in seen:
        ordered.append(current)
        seen.add(current["id"])
        next_id = current["next_id"]
        if next_id is None:
            break
        current = by_id.get(next_id)
        if current is None:
            break
    return ordered


def fetch_all_for_cache(connection: GuardedConnection | sqlite3.Connection) -> list[dict]:
    conn = _conn(connection)
    rows = conn.execute(f"SELECT * FROM {NOTES_TABLE}").fetchall()
    return [_deserialize_row(row) for row in rows]


def clear_encryption_metadata_for_empty_notes(
    connection: GuardedConnection | sqlite3.Connection,
) -> int:
    """Clear encryption metadata for notes whose content/tag sources are empty strings.

    AES-GCM encryption of an empty plaintext produces an empty ciphertext, so
    we can safely clear nonce/tag without losing content. This is used as a
    targeted integrity repair when password protection has been removed.
    """

    conn = _conn(connection)
    cursor = conn.execute(
        f"""
        UPDATE {NOTES_TABLE}
        SET encryption_nonce = CASE WHEN content = '' THEN NULL ELSE encryption_nonce END,
            encryption_tag = CASE WHEN content = '' THEN NULL ELSE encryption_tag END,
            tags_encryption_nonce = CASE WHEN tags = '' THEN NULL ELSE tags_encryption_nonce END,
            tags_encryption_tag = CASE WHEN tags = '' THEN NULL ELSE tags_encryption_tag END,
            proposed_tags_encryption_nonce = CASE
                WHEN proposed_tags = '' THEN NULL ELSE proposed_tags_encryption_nonce END,
            proposed_tags_encryption_tag = CASE
                WHEN proposed_tags = '' THEN NULL ELSE proposed_tags_encryption_tag END
        WHERE (
            content = ''
            AND encryption_nonce IS NOT NULL
            AND encryption_tag IS NOT NULL
        ) OR (
            tags = ''
            AND tags_encryption_nonce IS NOT NULL
            AND tags_encryption_tag IS NOT NULL
        ) OR (
            proposed_tags = ''
            AND proposed_tags_encryption_nonce IS NOT NULL
            AND proposed_tags_encryption_tag IS NOT NULL
        )
        """,
    )
    rowcount = cursor.rowcount
    if rowcount is None:
        return 0
    return int(rowcount)
