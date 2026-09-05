from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from app.db.migrations import CURRENT_DATABASE_VERSION
from app.db.migrations import read_database_version
from app.db.migrations import run_database_migrations
from app.db.schema import initialize_schema
from app.services.encryption import EncryptionService


_NOW = "2026-08-01T00:00:00+00:00"


def _connection(database_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    return connection


def _insert_settings(
    connection: sqlite3.Connection,
    *,
    encryption_enabled: bool,
    preferences_json: str,
    usage_json: str,
    tag_prefix_json: str,
) -> None:
    connection.execute(
        """
        INSERT INTO app_settings (
            id,
            encryption_enabled,
            client_preferences_json,
            command_palette_usage_json,
            tag_prefix_settings_json,
            created_at,
            updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        """,
        (
            int(encryption_enabled),
            preferences_json,
            usage_json,
            tag_prefix_json,
            _NOW,
            _NOW,
        ),
    )


def _encryption_service() -> EncryptionService:
    service = EncryptionService()
    service.dek = b"d" * 32
    return service


@pytest.mark.parametrize("encryption_enabled", [False, True])
def test_v6_document_upgrade_creates_table_transactionally(tmp_path: Path, encryption_enabled: bool) -> None:
    connection = _connection(tmp_path / "pre-diagrams.db")
    connection.execute("DROP TABLE embedded_documents")
    connection.execute("PRAGMA user_version = 6")
    connection.commit()
    connection.execute("BEGIN")
    result = run_database_migrations(connection=connection, encryption_enabled=encryption_enabled,
                                     encryption_service=_encryption_service())
    assert result.applied_versions == (7,)
    assert result.rewritten_payload_count == 0
    assert {row[1] for row in connection.execute("PRAGMA table_info(embedded_documents)")} == {"id", "payload", "nonce", "tag"}
    connection.rollback()
    assert read_database_version(connection) == 6
    assert connection.execute("PRAGMA table_info(embedded_documents)").fetchall() == []
    with connection:
        run_database_migrations(connection=connection, encryption_enabled=encryption_enabled,
                                encryption_service=_encryption_service())
    assert read_database_version(connection) == 7
    assert connection.execute("SELECT COUNT(*) FROM embedded_documents").fetchone()[0] == 0
    connection.close()


def _replace_search_history_with_legacy_schema(connection: sqlite3.Connection) -> None:
    connection.execute("DROP TABLE search_interaction_history")
    connection.execute(
        """
        CREATE TABLE search_interaction_history (
            query_hash TEXT PRIMARY KEY,
            query_key TEXT NOT NULL,
            query_key_encryption_nonce BLOB,
            query_key_encryption_tag BLOB,
            root_tag TEXT NOT NULL,
            root_tag_encryption_nonce BLOB,
            root_tag_encryption_tag BLOB,
            tags_json TEXT NOT NULL,
            tags_json_encryption_nonce BLOB,
            tags_json_encryption_tag BLOB,
            score REAL NOT NULL,
            created_at TEXT NOT NULL,
            last_interacted_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )


def test_plaintext_namespace_advances_through_migrations_without_rewriting(tmp_path: Path) -> None:
    connection = _connection(tmp_path / "plain.db")
    _insert_settings(
        connection,
        encryption_enabled=False,
        preferences_json='{"pref.theme":"dark"}',
        usage_json="{}",
        tag_prefix_json="{}",
    )

    result = run_database_migrations(
        connection=connection,
        encryption_enabled=False,
        encryption_service=None,
    )

    assert result.initial_version == 0
    assert result.final_version == CURRENT_DATABASE_VERSION
    assert result.applied_versions == (1, 2, 3, 4, 5, 6, 7)
    assert result.rewritten_payload_count == 0
    assert read_database_version(connection) == CURRENT_DATABASE_VERSION
    row = connection.execute(
        "SELECT client_preferences_json FROM app_settings WHERE id = 1"
    ).fetchone()
    assert row[0] == '{"pref.theme":"dark"}'
    connection.close()


def test_encrypted_namespace_migration_rewrites_every_nonempty_client_payload(
    tmp_path: Path,
) -> None:
    connection = _connection(tmp_path / "encrypted.db")
    _insert_settings(
        connection,
        encryption_enabled=True,
        preferences_json='{"pref.theme":"dark"}',
        usage_json='{"lastQueryTokens":["secret"]}',
        tag_prefix_json='{"prefix":"private"}',
    )
    service = _encryption_service()

    result = run_database_migrations(
        connection=connection,
        encryption_enabled=True,
        encryption_service=service,
    )

    assert result.rewritten_payload_count == 3
    row = connection.execute("SELECT * FROM app_settings WHERE id = 1").fetchone()
    for value_column, nonce_column, tag_column, expected_plaintext in (
        (
            "client_preferences_json",
            "client_preferences_encryption_nonce",
            "client_preferences_encryption_tag",
            '{"pref.theme":"dark"}',
        ),
        (
            "command_palette_usage_json",
            "command_palette_usage_encryption_nonce",
            "command_palette_usage_encryption_tag",
            '{"lastQueryTokens":["secret"]}',
        ),
        (
            "tag_prefix_settings_json",
            "tag_prefix_settings_encryption_nonce",
            "tag_prefix_settings_encryption_tag",
            '{"prefix":"private"}',
        ),
    ):
        assert row[value_column] != expected_plaintext
        assert service.decrypt_from_storage(
            row[value_column],
            row[nonce_column],
            row[tag_column],
        ) == expected_plaintext
    connection.close()


def test_migrations_are_idempotent_after_version_advances(tmp_path: Path) -> None:
    connection = _connection(tmp_path / "idempotent.db")
    _insert_settings(
        connection,
        encryption_enabled=True,
        preferences_json='{"pref.theme":"dark"}',
        usage_json="{}",
        tag_prefix_json="{}",
    )
    service = _encryption_service()
    run_database_migrations(
        connection=connection,
        encryption_enabled=True,
        encryption_service=service,
    )

    second_result = run_database_migrations(
        connection=connection,
        encryption_enabled=True,
        encryption_service=service,
    )

    assert second_result.applied_versions == ()
    assert second_result.rewritten_payload_count == 0
    connection.close()


def test_database_version_two_adds_namespace_content_migration_ledger(
    tmp_path: Path,
) -> None:
    connection = _connection(tmp_path / "content-migrations.db")
    _insert_settings(
        connection,
        encryption_enabled=False,
        preferences_json="{}",
        usage_json="{}",
        tag_prefix_json="{}",
    )
    initialized_columns = {
        row[1]
        for row in connection.execute(
            "PRAGMA table_info(namespace_content_migrations)"
        ).fetchall()
    }
    assert "migration_id" in initialized_columns

    result = run_database_migrations(
        connection=connection,
        encryption_enabled=False,
        encryption_service=None,
    )

    assert CURRENT_DATABASE_VERSION == 7
    assert result.applied_versions == (1, 2, 3, 4, 5, 6, 7)
    columns = {
        row[1]
        for row in connection.execute(
            "PRAGMA table_info(namespace_content_migrations)"
        ).fetchall()
    }
    assert columns == {
        "migration_id",
        "status",
        "converted_count",
        "unresolved_count",
        "last_attempt_at",
        "completed_at",
        "created_at",
        "updated_at",
    }
    connection.close()


def test_database_version_four_discards_legacy_query_scores(
    tmp_path: Path,
) -> None:
    connection = _connection(tmp_path / "search-history-v3.db")
    _insert_settings(
        connection,
        encryption_enabled=True,
        preferences_json="{}",
        usage_json="{}",
        tag_prefix_json="{}",
    )
    service = _encryption_service()
    _replace_search_history_with_legacy_schema(connection)
    query_key = "private-tag"
    query_ciphertext, query_nonce, query_tag = service.encrypt_for_storage(query_key)
    root_ciphertext, root_nonce, root_tag = service.encrypt_for_storage(query_key)
    tags_ciphertext, tags_nonce, tags_tag = service.encrypt_for_storage('["private-tag"]')
    connection.execute(
        """
        INSERT INTO search_interaction_history (
            query_hash,
            query_key,
            query_key_encryption_nonce,
            query_key_encryption_tag,
            root_tag,
            root_tag_encryption_nonce,
            root_tag_encryption_tag,
            tags_json,
            tags_json_encryption_nonce,
            tags_json_encryption_tag,
            score,
            created_at,
            last_interacted_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            hashlib.sha256(query_key.encode("utf-8")).hexdigest(),
            query_ciphertext,
            query_nonce,
            query_tag,
            root_ciphertext,
            root_nonce,
            root_tag,
            tags_ciphertext,
            tags_nonce,
            tags_tag,
            7.5,
            _NOW,
            _NOW,
            _NOW,
        ),
    )
    connection.execute("PRAGMA user_version = 2")

    result = run_database_migrations(
        connection=connection,
        encryption_enabled=True,
        encryption_service=service,
    )

    assert result.applied_versions == (3, 4, 5, 6, 7)
    columns = {
        str(row["name"])
        for row in connection.execute(
            "PRAGMA table_info(search_interaction_history)"
        ).fetchall()
    }
    assert columns == {
        "storage_id",
        "payload_json",
        "payload_encryption_nonce",
        "payload_encryption_tag",
    }
    row = connection.execute("SELECT * FROM search_interaction_history").fetchone()
    assert row is None
    connection.close()


def test_database_version_five_adds_openai_credential_columns(
    tmp_path: Path,
) -> None:
    connection = sqlite3.connect(tmp_path / "openai-credentials-v4.db")
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE app_settings (
            id INTEGER PRIMARY KEY,
            encryption_enabled INTEGER NOT NULL
        )
        """
    )
    connection.execute(
        "INSERT INTO app_settings (id, encryption_enabled) VALUES (1, 0)"
    )
    connection.execute("CREATE TABLE notes (id TEXT PRIMARY KEY)")
    connection.execute("PRAGMA user_version = 4")

    result = run_database_migrations(
        connection=connection,
        encryption_enabled=False,
        encryption_service=None,
    )

    assert result.applied_versions == (5, 6, 7)
    columns = {
        str(row["name"])
        for row in connection.execute("PRAGMA table_info(app_settings)").fetchall()
    }
    assert {
        "openai_api_key_ciphertext",
        "openai_api_key_encryption_nonce",
        "openai_api_key_encryption_tag",
    } <= columns
    note_columns = {
        str(row["name"])
        for row in connection.execute("PRAGMA table_info(notes)").fetchall()
    }
    assert {
        "proposed_tags",
        "proposed_tags_encryption_nonce",
        "proposed_tags_encryption_tag",
    } <= note_columns
    row = connection.execute("SELECT * FROM app_settings WHERE id = 1").fetchone()
    assert row is not None
    assert row["openai_api_key_ciphertext"] is None
    assert row["openai_api_key_encryption_nonce"] is None
    assert row["openai_api_key_encryption_tag"] is None
    connection.close()


def test_database_version_six_encrypts_new_proposal_storage_for_encrypted_notes(
    tmp_path: Path,
) -> None:
    connection = sqlite3.connect(tmp_path / "encrypted-proposals-v5.db")
    connection.row_factory = sqlite3.Row
    connection.execute("CREATE TABLE notes (id TEXT PRIMARY KEY)")
    connection.execute("INSERT INTO notes (id) VALUES ('note-1')")
    connection.execute("PRAGMA user_version = 5")
    service = _encryption_service()

    result = run_database_migrations(
        connection=connection,
        encryption_enabled=True,
        encryption_service=service,
    )

    assert result.applied_versions == (6, 7)
    assert result.rewritten_payload_count == 1
    row = connection.execute(
        "SELECT proposed_tags, proposed_tags_encryption_nonce, "
        "proposed_tags_encryption_tag FROM notes WHERE id = 'note-1'"
    ).fetchone()
    assert row is not None
    assert row["proposed_tags_encryption_nonce"] is not None
    assert row["proposed_tags_encryption_tag"] is not None
    assert service.decrypt_from_storage(
        row["proposed_tags"],
        row["proposed_tags_encryption_nonce"],
        row["proposed_tags_encryption_tag"],
    ) == ""
    connection.close()


def test_migration_rejects_incomplete_existing_encryption_metadata(tmp_path: Path) -> None:
    connection = _connection(tmp_path / "invalid.db")
    _insert_settings(
        connection,
        encryption_enabled=True,
        preferences_json='{"pref.theme":"dark"}',
        usage_json="{}",
        tag_prefix_json="{}",
    )
    connection.execute(
        "UPDATE app_settings SET client_preferences_encryption_nonce = ? WHERE id = 1",
        (b"n" * 12,),
    )

    with pytest.raises(RuntimeError, match="incomplete encryption metadata"):
        run_database_migrations(
            connection=connection,
            encryption_enabled=True,
            encryption_service=_encryption_service(),
        )

    assert read_database_version(connection) == 0
    connection.close()


def test_migration_rejects_database_from_newer_application(tmp_path: Path) -> None:
    connection = _connection(tmp_path / "future.db")
    connection.execute(f"PRAGMA user_version = {CURRENT_DATABASE_VERSION + 1}")

    with pytest.raises(RuntimeError, match="newer than supported"):
        run_database_migrations(
            connection=connection,
            encryption_enabled=False,
            encryption_service=None,
        )
    connection.close()
