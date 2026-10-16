"""SQLite helpers for the ontology_rules table."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Iterable, Optional

from app.db.engine import GuardedConnection
from .raw_connection import raw_sqlite_connection
from app.db.schema import ONTOLOGY_RULES_TABLE


def _conn(connection: GuardedConnection | sqlite3.Connection) -> GuardedConnection | sqlite3.Connection:
    if isinstance(connection, GuardedConnection):
        return connection
    return raw_sqlite_connection(connection)


def _serialize_datetime(value: datetime) -> str:
    if not isinstance(value, datetime):
        raise TypeError("value must be a datetime")
    return value.isoformat()


def fetch_all_rules(connection: GuardedConnection | sqlite3.Connection) -> list[dict[str, object]]:
    conn = _conn(connection)
    rows = conn.execute(
        f"""
        SELECT id, rule_text, rule_encryption_nonce, rule_encryption_tag, created_at, updated_at
        FROM {ONTOLOGY_RULES_TABLE}
        ORDER BY id ASC
        """,
    ).fetchall()
    out: list[dict[str, object]] = []
    for row in rows:
        out.append(
            {
                "id": row["id"],
                "rule_text": row["rule_text"],
                "rule_encryption_nonce": row["rule_encryption_nonce"],
                "rule_encryption_tag": row["rule_encryption_tag"],
                "created_at": datetime.fromisoformat(row["created_at"]),
                "updated_at": datetime.fromisoformat(row["updated_at"]),
            }
        )
    return out


def insert_rule(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    rule_text: str,
    rule_encryption_nonce: Optional[bytes],
    rule_encryption_tag: Optional[bytes],
    created_at: datetime,
    updated_at: datetime,
) -> int:
    conn = _conn(connection)
    cursor = conn.execute(
        f"""
        INSERT INTO {ONTOLOGY_RULES_TABLE} (
            rule_text,
            rule_encryption_nonce,
            rule_encryption_tag,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            rule_text,
            rule_encryption_nonce,
            rule_encryption_tag,
            _serialize_datetime(created_at),
            _serialize_datetime(updated_at),
        ),
    )
    rule_id = cursor.lastrowid
    if not isinstance(rule_id, int):
        raise RuntimeError("Expected sqlite lastrowid to be int")
    return rule_id


def update_rule(
    connection: GuardedConnection | sqlite3.Connection,
    rule_id: int,
    *,
    rule_text: str,
    rule_encryption_nonce: Optional[bytes],
    rule_encryption_tag: Optional[bytes],
    updated_at: datetime,
) -> None:
    if not isinstance(rule_id, int):
        raise TypeError("rule_id must be an int")
    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {ONTOLOGY_RULES_TABLE}
        SET rule_text = ?,
            rule_encryption_nonce = ?,
            rule_encryption_tag = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (
            rule_text,
            rule_encryption_nonce,
            rule_encryption_tag,
            _serialize_datetime(updated_at),
            rule_id,
        ),
    )


def delete_rule(connection: GuardedConnection | sqlite3.Connection, rule_id: int) -> None:
    if not isinstance(rule_id, int):
        raise TypeError("rule_id must be an int")
    conn = _conn(connection)
    conn.execute(
        f"DELETE FROM {ONTOLOGY_RULES_TABLE} WHERE id = ?",
        (rule_id,),
    )


def update_rules_bulk(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    updates: Iterable[tuple[int, str, Optional[bytes], Optional[bytes], datetime]],
) -> None:
    """Bulk update rules.

    Each update is (rule_id, rule_text, nonce, tag, updated_at).
    """
    conn = _conn(connection)
    payload = []
    for rule_id, rule_text, nonce, tag, updated_at in updates:
        if not isinstance(rule_id, int):
            raise TypeError("rule_id must be int")
        payload.append((rule_text, nonce, tag, _serialize_datetime(updated_at), rule_id))
    conn.executemany(
        f"""
        UPDATE {ONTOLOGY_RULES_TABLE}
        SET rule_text = ?,
            rule_encryption_nonce = ?,
            rule_encryption_tag = ?,
            updated_at = ?
        WHERE id = ?
        """,
        payload,
    )
