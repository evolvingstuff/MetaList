"""Ordered, transactional database migrations for namespace databases."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import sqlite3
import re

from app.db.version import CURRENT_DATABASE_VERSION
from app.db.retire_sounds import retire_sounds
from app.db.schema import create_namespace_content_migrations_table
from app.services.encryption import EncryptionService


@dataclass(frozen=True, slots=True)
class MigrationResult:
    initial_version: int
    final_version: int
    applied_versions: tuple[int, ...]
    rewritten_payload_count: int


_CLIENT_STATE_PAYLOADS = (
    (
        "client_preferences_json",
        "client_preferences_encryption_nonce",
        "client_preferences_encryption_tag",
    ),
    (
        "command_palette_usage_json",
        "command_palette_usage_encryption_nonce",
        "command_palette_usage_encryption_tag",
    ),
    (
        "tag_prefix_settings_json",
        "tag_prefix_settings_encryption_nonce",
        "tag_prefix_settings_encryption_tag",
    ),
)


def read_database_version(connection: sqlite3.Connection) -> int:
    row = connection.execute("PRAGMA user_version").fetchone()
    if row is None:
        raise RuntimeError("Database user_version PRAGMA returned no row")
    version = row[0]
    if not isinstance(version, int) or version < 0:
        raise RuntimeError(f"Invalid database user_version: {version!r}")
    return version


def _table_columns(connection: sqlite3.Connection, *, table: str) -> set[str]:
    return {
        str(row[1])
        for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
    }


def _assert_client_state_schema(connection: sqlite3.Connection) -> None:
    columns = _table_columns(connection, table="app_settings")
    required = {column for payload in _CLIENT_STATE_PAYLOADS for column in payload}
    missing = sorted(required - columns)
    if missing:
        raise RuntimeError(f"Database migration requires missing columns: {missing}")


def _rewrite_payload_for_encrypted_namespace(
    *,
    connection: sqlite3.Connection,
    encryption_service: EncryptionService,
    value_column: str,
    nonce_column: str,
    tag_column: str,
) -> int:
    row = connection.execute(
        f"SELECT {value_column}, {nonce_column}, {tag_column} FROM app_settings WHERE id = 1"
    ).fetchone()
    if row is None:
        raise RuntimeError("Database migration requires app_settings row id=1")
    value, nonce, tag = row
    if (nonce is None) != (tag is None):
        raise RuntimeError(f"{value_column} has incomplete encryption metadata")
    if value is None or value == "":
        if nonce is not None:
            raise RuntimeError(f"{value_column} has encryption metadata without a payload")
        return 0
    if not isinstance(value, str):
        raise RuntimeError(f"{value_column} must be stored as text")
    if nonce is not None:
        encryption_service.decrypt_from_storage(value, nonce, tag)
        return 0
    ciphertext, next_nonce, next_tag = encryption_service.encrypt_for_storage(value)
    connection.execute(
        f"""
        UPDATE app_settings
        SET {value_column} = ?, {nonce_column} = ?, {tag_column} = ?
        WHERE id = 1
        """,
        (ciphertext, next_nonce, next_tag),
    )
    return 1


def _migration_0_to_1(
    *,
    connection: sqlite3.Connection,
    encryption_enabled: bool,
    encryption_service: EncryptionService | None,
) -> int:
    _assert_client_state_schema(connection)
    if not encryption_enabled:
        return 0
    if encryption_service is None or encryption_service.dek is None:
        raise RuntimeError("Database migration 0→1 requires the namespace DEK")
    rewritten_count = 0
    for value_column, nonce_column, tag_column in _CLIENT_STATE_PAYLOADS:
        rewritten_count += _rewrite_payload_for_encrypted_namespace(
            connection=connection,
            encryption_service=encryption_service,
            value_column=value_column,
            nonce_column=nonce_column,
            tag_column=tag_column,
        )
    return rewritten_count


def _migration_1_to_2(
    *,
    connection: sqlite3.Connection,
    encryption_enabled: bool,  # noqa: ARG001
    encryption_service: EncryptionService | None,  # noqa: ARG001
) -> int:
    create_namespace_content_migrations_table(connection)
    return 0


_LEGACY_SEARCH_HISTORY_COLUMNS = {
    "query_hash",
    "query_key",
    "query_key_encryption_nonce",
    "query_key_encryption_tag",
    "root_tag",
    "root_tag_encryption_nonce",
    "root_tag_encryption_tag",
    "tags_json",
    "tags_json_encryption_nonce",
    "tags_json_encryption_tag",
    "score",
    "created_at",
    "last_interacted_at",
    "updated_at",
}
_OPAQUE_SEARCH_HISTORY_COLUMNS = {
    "storage_id",
    "payload_json",
    "payload_encryption_nonce",
    "payload_encryption_tag",
}


def _migration_2_to_3(
    *,
    connection: sqlite3.Connection,
    encryption_enabled: bool,  # noqa: ARG001
    encryption_service: EncryptionService | None,  # noqa: ARG001
) -> int:
    columns = _table_columns(connection, table="search_interaction_history")
    if columns == _OPAQUE_SEARCH_HISTORY_COLUMNS:
        return 0
    if columns != _LEGACY_SEARCH_HISTORY_COLUMNS:
        raise RuntimeError(
            "Database migration 2→3 found unexpected search history schema: "
            f"{sorted(columns)}"
        )
    legacy_row = connection.execute(
        "SELECT COUNT(*) FROM search_interaction_history"
    ).fetchone()
    if legacy_row is None:
        raise RuntimeError("Database migration 2→3 could not count legacy search history")
    deleted_count = int(legacy_row[0])

    connection.execute("DROP TABLE IF EXISTS search_interaction_history_v3")
    connection.execute(
        """
        CREATE TABLE search_interaction_history_v3 (
            storage_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL,
            payload_encryption_nonce BLOB,
            payload_encryption_tag BLOB
        )
        """
    )
    connection.execute("DROP TABLE search_interaction_history")
    connection.execute(
        "ALTER TABLE search_interaction_history_v3 RENAME TO search_interaction_history"
    )
    return deleted_count


def _migration_3_to_4(
    *,
    connection: sqlite3.Connection,
    encryption_enabled: bool,  # noqa: ARG001
    encryption_service: EncryptionService | None,  # noqa: ARG001
) -> int:
    columns = _table_columns(connection, table="search_interaction_history")
    if columns != _OPAQUE_SEARCH_HISTORY_COLUMNS:
        raise RuntimeError(
            "Database migration 3→4 found unexpected search history schema: "
            f"{sorted(columns)}"
        )
    row = connection.execute("SELECT COUNT(*) FROM search_interaction_history").fetchone()
    if row is None:
        raise RuntimeError("Database migration 3→4 could not count query-score rows")
    deleted_count = int(row[0])
    connection.execute("DELETE FROM search_interaction_history")
    return deleted_count


def _migration_4_to_5(
    *,
    connection: sqlite3.Connection,
    encryption_enabled: bool,  # noqa: ARG001
    encryption_service: EncryptionService | None,  # noqa: ARG001
) -> int:
    columns = _table_columns(connection, table="app_settings")
    additions = (
        ("openai_api_key_ciphertext", "TEXT"),
        ("openai_api_key_encryption_nonce", "BLOB"),
        ("openai_api_key_encryption_tag", "BLOB"),
    )
    existing_additions = {column for column, _sql_type in additions} & columns
    if existing_additions == {column for column, _sql_type in additions}:
        return 0
    if existing_additions:
        raise RuntimeError(
            "Database migration 4→5 found a partial OpenAI credential schema: "
            f"{sorted(existing_additions)}"
        )
    for column, sql_type in additions:
        connection.execute(f"ALTER TABLE app_settings ADD COLUMN {column} {sql_type}")
    return 0


def _migration_5_to_6(
    *,
    connection: sqlite3.Connection,
    encryption_enabled: bool,
    encryption_service: EncryptionService | None,
) -> int:
    columns = _table_columns(connection, table="notes")
    additions = (
        ("proposed_tags", "TEXT NOT NULL DEFAULT ''"),
        ("proposed_tags_encryption_nonce", "BLOB"),
        ("proposed_tags_encryption_tag", "BLOB"),
    )
    addition_names = {column for column, _sql_type in additions}
    existing_additions = addition_names & columns
    if existing_additions and existing_additions != addition_names:
        raise RuntimeError(
            "Database migration 5→6 found a partial proposed-tag schema: "
            f"{sorted(existing_additions)}"
        )
    if not existing_additions:
        for column, sql_type in additions:
            connection.execute(f"ALTER TABLE notes ADD COLUMN {column} {sql_type}")

    if not encryption_enabled:
        return 0
    if encryption_service is None or encryption_service.dek is None:
        raise RuntimeError("Database migration 5→6 requires the namespace DEK")

    rows = connection.execute(
        "SELECT id, proposed_tags, proposed_tags_encryption_nonce, "
        "proposed_tags_encryption_tag FROM notes"
    ).fetchall()
    rewritten_count = 0
    for row in rows:
        note_id, proposed_tags, nonce, tag = row
        if not isinstance(note_id, str) or note_id == "":
            raise RuntimeError("Database migration 5→6 found invalid note id")
        if not isinstance(proposed_tags, str):
            raise RuntimeError(
                f"Database migration 5→6 requires text proposed_tags: note_id={note_id}"
            )
        if (nonce is None) != (tag is None):
            raise RuntimeError(
                "Database migration 5→6 found incomplete proposed-tag encryption metadata: "
                f"note_id={note_id}"
            )
        if nonce is not None:
            encryption_service.decrypt_from_storage(proposed_tags, nonce, tag)
            continue
        ciphertext, next_nonce, next_tag = encryption_service.encrypt_for_storage(
            proposed_tags
        )
        connection.execute(
            "UPDATE notes SET proposed_tags = ?, proposed_tags_encryption_nonce = ?, "
            "proposed_tags_encryption_tag = ? WHERE id = ?",
            (ciphertext, next_nonce, next_tag, note_id),
        )
        rewritten_count += 1
    return rewritten_count


def _migration_6_to_7(
    *,
    connection: sqlite3.Connection,
    encryption_enabled: bool,
    encryption_service: EncryptionService | None,
) -> int:
    # Retain the historical step so upgrades remain ordered and transactional.
    connection.execute(
        "CREATE TABLE IF NOT EXISTS embedded_documents ("
        "id TEXT PRIMARY KEY, payload TEXT NOT NULL, nonce BLOB, tag BLOB)"
    )
    return 0


def _remove_retired_document_references(
    *, connection: sqlite3.Connection, document_ids: set[str],
    encryption_enabled: bool, encryption_service: EncryptionService | None,
) -> int:
    if encryption_enabled and (encryption_service is None or encryption_service.dek is None):
        raise RuntimeError("Database migration 7→8 requires the namespace DEK")
    token_pattern = re.compile(r"!?\[\[([0-9a-fA-F-]{36})\]\]")
    rewritten_count = 0
    rows = connection.execute("SELECT id, content, encryption_nonce, encryption_tag FROM notes").fetchall()
    for note_id, content, nonce, tag in rows:
        if (nonce is None) != (tag is None):
            raise RuntimeError("Note has incomplete encryption metadata during migration 7→8")
        plaintext = content
        if nonce is not None:
            if encryption_service is None or encryption_service.dek is None:
                raise RuntimeError("Encrypted note requires the namespace DEK during migration 7→8")
            plaintext = encryption_service.decrypt_from_storage(content, nonce, tag)
        cleaned = token_pattern.sub(
            lambda match: "" if match.group(1).lower() in document_ids else match.group(0),
            plaintext,
        )
        if cleaned == plaintext:
            continue
        fields = (cleaned, None, None)
        if encryption_enabled:
            assert encryption_service is not None
            fields = encryption_service.encrypt_for_storage(cleaned)
        connection.execute(
            "UPDATE notes SET content = ?, encryption_nonce = ?, encryption_tag = ? WHERE id = ?",
            (*fields, note_id),
        )
        rewritten_count += 1
    return rewritten_count


def _migration_7_to_8(
    *, connection: sqlite3.Connection, encryption_enabled: bool,
    encryption_service: EncryptionService | None,
) -> int:
    """Remove retired diagrams and their placements from the installed live DB only."""
    document_ids = {row[0] for row in connection.execute("SELECT id FROM embedded_documents")}
    rewritten_count = 0
    if document_ids:
        rewritten_count = _remove_retired_document_references(
            connection=connection, document_ids=document_ids,
            encryption_enabled=encryption_enabled, encryption_service=encryption_service,
        )
    connection.execute("DROP TABLE embedded_documents")
    return rewritten_count


_MIGRATIONS: dict[
    int,
    Callable[..., int],
] = {
    0: _migration_0_to_1,
    1: _migration_1_to_2,
    2: _migration_2_to_3,
    3: _migration_3_to_4,
    4: _migration_4_to_5,
    5: _migration_5_to_6,
    6: _migration_6_to_7,
    7: _migration_7_to_8,
    8: retire_sounds,
}


def run_database_migrations(
    *,
    connection: sqlite3.Connection,
    encryption_enabled: bool,
    encryption_service: EncryptionService | None,
) -> MigrationResult:
    initial_version = read_database_version(connection)
    if initial_version > CURRENT_DATABASE_VERSION:
        raise RuntimeError(
            f"Database version {initial_version} is newer than supported version "
            f"{CURRENT_DATABASE_VERSION}"
        )
    version = initial_version
    applied_versions: list[int] = []
    rewritten_payload_count = 0
    while version < CURRENT_DATABASE_VERSION:
        if version not in _MIGRATIONS:
            raise RuntimeError(f"No database migration registered from version {version}")
        rewritten_payload_count += _MIGRATIONS[version](
            connection=connection,
            encryption_enabled=encryption_enabled,
            encryption_service=encryption_service,
        )
        version += 1
        connection.execute(f"PRAGMA user_version = {version}")
        applied_versions.append(version)
    return MigrationResult(
        initial_version=initial_version,
        final_version=version,
        applied_versions=tuple(applied_versions),
        rewritten_payload_count=rewritten_payload_count,
    )


def purge_migration_residue(connection: sqlite3.Connection) -> None:
    """Remove pre-migration values from SQLite pages and the WAL."""
    if connection.in_transaction:
        raise RuntimeError("Database residue purge requires a committed connection")
    connection.execute("PRAGMA secure_delete=ON")
    checkpoint = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    if checkpoint is None or int(checkpoint[0]) != 0:
        raise RuntimeError(f"Database WAL checkpoint could not complete: {checkpoint!r}")
    connection.execute("VACUUM")
    checkpoint = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    if checkpoint is None or int(checkpoint[0]) != 0:
        raise RuntimeError(f"Database WAL truncation could not complete: {checkpoint!r}")
