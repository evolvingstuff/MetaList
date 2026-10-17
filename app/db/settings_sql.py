"""SQLite helpers for the app_settings table."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Optional

from .engine import GuardedConnection
from .raw_connection import raw_sqlite_connection
from .schema import APP_SETTINGS_TABLE


def _conn(connection: GuardedConnection | sqlite3.Connection) -> sqlite3.Connection:
    return raw_sqlite_connection(connection)


def _serialize_datetime(value: Optional[datetime]) -> str:
    if value is None:
        value = datetime.now(timezone.utc)
    return value.isoformat()


def fetch_settings(connection: GuardedConnection | sqlite3.Connection) -> Optional[dict]:
    conn = _conn(connection)
    row = conn.execute(
        f"SELECT * FROM {APP_SETTINGS_TABLE} WHERE id = 1",
    ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "auth_verifier": row["auth_verifier"],
        "auth_salt": row["auth_salt"],
        "auth_iterations": row["auth_iterations"],
        "kek_salt": row["kek_salt"],
        "kek_iterations": row["kek_iterations"],
        "vault_version": row["vault_version"],
        "kdf_algorithm": row["kdf_algorithm"],
        "kdf_memory_cost_kib": row["kdf_memory_cost_kib"],
        "kdf_parallelism": row["kdf_parallelism"],
        "encryption_enabled": bool(row["encryption_enabled"]),
        "encryption_algorithm": row["encryption_algorithm"],
        "encrypted_dek": row["encrypted_dek"],
        "dek_nonce": row["dek_nonce"],
        "dek_tag": row["dek_tag"],
        "backup_settings_json": row["backup_settings_json"],
        "backup_settings_encryption_nonce": row["backup_settings_encryption_nonce"],
        "backup_settings_encryption_tag": row["backup_settings_encryption_tag"],
        "client_preferences_json": row["client_preferences_json"],
        "client_preferences_encryption_nonce": row["client_preferences_encryption_nonce"],
        "client_preferences_encryption_tag": row["client_preferences_encryption_tag"],
        "command_palette_usage_json": row["command_palette_usage_json"],
        "command_palette_usage_encryption_nonce": row[
            "command_palette_usage_encryption_nonce"
        ],
        "command_palette_usage_encryption_tag": row[
            "command_palette_usage_encryption_tag"
        ],
        "tag_prefix_settings_json": row["tag_prefix_settings_json"],
        "tag_prefix_settings_encryption_nonce": row[
            "tag_prefix_settings_encryption_nonce"
        ],
        "tag_prefix_settings_encryption_tag": row[
            "tag_prefix_settings_encryption_tag"
        ],
        "openai_api_key_ciphertext": row["openai_api_key_ciphertext"],
        "openai_api_key_encryption_nonce": row["openai_api_key_encryption_nonce"],
        "openai_api_key_encryption_tag": row["openai_api_key_encryption_tag"],
        "session_timeout_minutes": row["session_timeout_minutes"],
        "created_at": datetime.fromisoformat(row["created_at"]),
        "updated_at": datetime.fromisoformat(row["updated_at"]),
    }


def insert_default_settings(connection: GuardedConnection | sqlite3.Connection) -> None:
    conn = _conn(connection)
    now = datetime.now(timezone.utc)
    conn.execute(
        f"""
        INSERT OR IGNORE INTO {APP_SETTINGS_TABLE} (
            id,
            encryption_enabled,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?)
        """,
        (
            1,
            0,
            _serialize_datetime(now),
            _serialize_datetime(now),
        ),
    )


def update_password_settings(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    auth_verifier: str,
    auth_salt: bytes,
    auth_iterations: int,
    kek_salt: bytes,
    kek_iterations: int,
    vault_version: int,
    kdf_algorithm: str,
    kdf_memory_cost_kib: int,
    kdf_parallelism: int,
    encrypted_dek: bytes,
    dek_nonce: bytes,
    dek_tag: bytes,
    encryption_algorithm: str,
) -> None:
    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {APP_SETTINGS_TABLE}
        SET auth_verifier = ?,
            auth_salt = ?,
            auth_iterations = ?,
            kek_salt = ?,
            kek_iterations = ?,
            vault_version = ?,
            kdf_algorithm = ?,
            kdf_memory_cost_kib = ?,
            kdf_parallelism = ?,
            encrypted_dek = ?,
            dek_nonce = ?,
            dek_tag = ?,
            encryption_enabled = 1,
            encryption_algorithm = ?,
            updated_at = ?
        WHERE id = 1
        """,
        (
            auth_verifier,
            auth_salt,
            auth_iterations,
            kek_salt,
            kek_iterations,
            vault_version,
            kdf_algorithm,
            kdf_memory_cost_kib,
            kdf_parallelism,
            encrypted_dek,
            dek_nonce,
            dek_tag,
            encryption_algorithm,
            _serialize_datetime(datetime.now(timezone.utc)),
        ),
    )


def clear_password_settings(connection: GuardedConnection | sqlite3.Connection) -> None:
    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {APP_SETTINGS_TABLE}
        SET auth_verifier = NULL,
            auth_salt = NULL,
            auth_iterations = NULL,
            kek_salt = NULL,
            kek_iterations = NULL,
            vault_version = NULL,
            kdf_algorithm = NULL,
            kdf_memory_cost_kib = NULL,
            kdf_parallelism = NULL,
            encrypted_dek = NULL,
            dek_nonce = NULL,
            dek_tag = NULL,
            openai_api_key_ciphertext = NULL,
            openai_api_key_encryption_nonce = NULL,
            openai_api_key_encryption_tag = NULL,
            encryption_enabled = 0,
            encryption_algorithm = NULL,
            updated_at = ?
        WHERE id = 1
        """,
        (
            _serialize_datetime(datetime.now(timezone.utc)),
        ),
    )


def update_openai_api_key(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    ciphertext: str,
    nonce: bytes,
    tag: bytes,
) -> None:
    if not isinstance(ciphertext, str) or ciphertext == "":
        raise TypeError("OpenAI API key ciphertext must be non-empty text")
    if not isinstance(nonce, bytes) or len(nonce) == 0:
        raise TypeError("OpenAI API key nonce must be non-empty bytes")
    if not isinstance(tag, bytes) or len(tag) == 0:
        raise TypeError("OpenAI API key tag must be non-empty bytes")
    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {APP_SETTINGS_TABLE}
        SET openai_api_key_ciphertext = ?,
            openai_api_key_encryption_nonce = ?,
            openai_api_key_encryption_tag = ?,
            updated_at = ?
        WHERE id = 1
        """,
        (ciphertext, nonce, tag, _serialize_datetime(datetime.now(timezone.utc))),
    )


def clear_openai_api_key(
    connection: GuardedConnection | sqlite3.Connection,
) -> None:
    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {APP_SETTINGS_TABLE}
        SET openai_api_key_ciphertext = NULL,
            openai_api_key_encryption_nonce = NULL,
            openai_api_key_encryption_tag = NULL,
            updated_at = ?
        WHERE id = 1
        """,
        (_serialize_datetime(datetime.now(timezone.utc)),),
    )


def update_client_preferences_json(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    client_preferences_json: str,
    client_preferences_encryption_nonce: bytes | None,
    client_preferences_encryption_tag: bytes | None,
) -> None:
    if not isinstance(client_preferences_json, str):
        raise TypeError("client_preferences_json must be a string")

    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {APP_SETTINGS_TABLE}
        SET client_preferences_json = ?,
            client_preferences_encryption_nonce = ?,
            client_preferences_encryption_tag = ?,
            updated_at = ?
        WHERE id = 1
        """,
        (
            client_preferences_json,
            client_preferences_encryption_nonce,
            client_preferences_encryption_tag,
            _serialize_datetime(datetime.now(timezone.utc)),
        ),
    )


def update_command_palette_usage_json(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    command_palette_usage_json: str,
    command_palette_usage_encryption_nonce: bytes | None,
    command_palette_usage_encryption_tag: bytes | None,
) -> None:
    if not isinstance(command_palette_usage_json, str):
        raise TypeError("command_palette_usage_json must be a string")

    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {APP_SETTINGS_TABLE}
        SET command_palette_usage_json = ?,
            command_palette_usage_encryption_nonce = ?,
            command_palette_usage_encryption_tag = ?,
            updated_at = ?
        WHERE id = 1
        """,
        (
            command_palette_usage_json,
            command_palette_usage_encryption_nonce,
            command_palette_usage_encryption_tag,
            _serialize_datetime(datetime.now(timezone.utc)),
        ),
    )


def update_tag_prefix_settings_json(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    tag_prefix_settings_json: str,
    tag_prefix_settings_encryption_nonce: bytes | None,
    tag_prefix_settings_encryption_tag: bytes | None,
) -> None:
    if not isinstance(tag_prefix_settings_json, str):
        raise TypeError("tag_prefix_settings_json must be a string")

    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {APP_SETTINGS_TABLE}
        SET tag_prefix_settings_json = ?,
            tag_prefix_settings_encryption_nonce = ?,
            tag_prefix_settings_encryption_tag = ?,
            updated_at = ?
        WHERE id = 1
        """,
        (
            tag_prefix_settings_json,
            tag_prefix_settings_encryption_nonce,
            tag_prefix_settings_encryption_tag,
            _serialize_datetime(datetime.now(timezone.utc)),
        ),
    )


def update_session_timeout_minutes(
    connection: GuardedConnection | sqlite3.Connection,
    *,
    session_timeout_minutes: int,
) -> None:
    if not isinstance(session_timeout_minutes, int):
        raise TypeError("session_timeout_minutes must be an integer")

    conn = _conn(connection)
    conn.execute(
        f"""
        UPDATE {APP_SETTINGS_TABLE}
        SET session_timeout_minutes = ?,
            updated_at = ?
        WHERE id = 1
        """,
        (
            session_timeout_minutes,
            _serialize_datetime(datetime.now(timezone.utc)),
        ),
    )
