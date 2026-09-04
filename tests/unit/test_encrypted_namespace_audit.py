from __future__ import annotations

import sqlite3
from pathlib import Path
import subprocess
import sys

from app.db.file_schema import initialize_file_schema
from app.db.file_session import resolve_file_database_path
from app.db.schema import initialize_schema
from app.encryption_audit import audit_all_namespaces, main


_NOW = "2026-08-01T00:00:00+00:00"
_PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_importing_encryption_audit_does_not_initialize_runtime_config() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; "
                "import app.encryption_audit; "
                "assert 'app.config' not in sys.modules"
            ),
        ],
        cwd=_PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def _create_namespace_database(
    namespaces_directory: Path,
    *,
    namespace: str,
    encryption_enabled: bool,
) -> Path:
    namespace_directory = namespaces_directory / namespace
    namespace_directory.mkdir(parents=True)
    database_path = namespace_directory / f"{namespace}.metalist.db"
    connection = sqlite3.connect(database_path)
    initialize_schema(connection)
    connection.execute(
        """
        INSERT INTO app_settings (
            id,
            auth_verifier,
            auth_salt,
            auth_iterations,
            kek_salt,
            kek_iterations,
            vault_version,
            kdf_algorithm,
            kdf_memory_cost_kib,
            kdf_parallelism,
            encryption_enabled,
            encryption_algorithm,
            encrypted_dek,
            dek_nonce,
            dek_tag,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            1,
            "verifier" if encryption_enabled else None,
            b"a" * 32 if encryption_enabled else None,
            3 if encryption_enabled else None,
            b"k" * 32 if encryption_enabled else None,
            3 if encryption_enabled else None,
            3 if encryption_enabled else None,
            "ARGON2ID" if encryption_enabled else None,
            65_536 if encryption_enabled else None,
            4 if encryption_enabled else None,
            int(encryption_enabled),
            "AES-256-GCM" if encryption_enabled else None,
            b"d" * 32 if encryption_enabled else None,
            b"n" * 12 if encryption_enabled else None,
            b"t" * 16 if encryption_enabled else None,
            _NOW,
            _NOW,
        ),
    )
    connection.commit()
    connection.close()
    return database_path


def _insert_encrypted_note(database_path: Path, *, note_id: str, nonce_byte: bytes) -> None:
    connection = sqlite3.connect(database_path)
    connection.execute(
        """
        INSERT INTO notes (
            id, content, tags, proposed_tags, is_collapsed,
            encryption_nonce, encryption_tag,
            tags_encryption_nonce, tags_encryption_tag,
            proposed_tags_encryption_nonce, proposed_tags_encryption_tag,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            note_id,
            "Y2lwaGVydGV4dA==",
            "dGFnLWNpcGhlcnRleHQ=",
            "cHJvcG9zZWQtY2lwaGVydGV4dA==",
            nonce_byte * 12,
            b"c" * 16,
            bytes([nonce_byte[0] + 1]) * 12,
            b"g" * 16,
            bytes([nonce_byte[0] + 2]) * 12,
            b"p" * 16,
            _NOW,
            _NOW,
        ),
    )
    connection.commit()
    connection.close()


def _replace_with_legacy_search_history(database_path: Path) -> None:
    connection = sqlite3.connect(database_path)
    try:
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
        connection.execute(
            """
            INSERT INTO search_interaction_history VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
            (
                "deterministic-query-hash",
                "YQ==",
                b"1" * 12,
                b"a" * 16,
                "Yg==",
                b"2" * 12,
                b"b" * 16,
                "Yw==",
                b"3" * 12,
                b"c" * 16,
                1.0,
                _NOW,
                _NOW,
                _NOW,
            ),
        )
        connection.execute("PRAGMA user_version = 2")
        connection.commit()
    finally:
        connection.close()


def _downgrade_to_version_4_schema(database_path: Path) -> None:
    connection = sqlite3.connect(database_path)
    try:
        for column in (
            "openai_api_key_ciphertext",
            "openai_api_key_encryption_nonce",
            "openai_api_key_encryption_tag",
        ):
            connection.execute(f"ALTER TABLE app_settings DROP COLUMN {column}")
        connection.execute("PRAGMA user_version = 4")
        connection.commit()
    finally:
        connection.close()


def test_audit_allows_encrypted_version_4_namespace_before_migration(
    tmp_path: Path,
) -> None:
    namespaces_directory = tmp_path / "namespaces"
    database_path = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    _downgrade_to_version_4_schema(database_path)

    report = audit_all_namespaces(namespaces_directory=namespaces_directory)

    assert report.startup_allowed is True
    assert report.findings == ()


def test_audit_scans_all_namespaces_and_skips_plaintext_namespaces(tmp_path: Path) -> None:
    namespaces_directory = tmp_path / "namespaces"
    encrypted_database = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    _insert_encrypted_note(encrypted_database, note_id="note-1", nonce_byte=b"1")
    _create_namespace_database(
        namespaces_directory,
        namespace="public",
        encryption_enabled=False,
    )

    report = audit_all_namespaces(namespaces_directory=namespaces_directory)

    assert report.namespace_count == 2
    assert report.encrypted_namespace_count == 1
    assert report.checked_payload_count == 3
    assert report.findings == ()
    assert [result.namespace for result in report.results] == ["private", "public"]
    assert report.results[0].is_encrypted is True
    assert report.results[1].is_encrypted is False
    rendered = report.render_text()
    assert "- private: PASS" in rendered
    assert "- public: SKIPPED (not encrypted)" in rendered


def test_audit_reports_plaintext_without_disclosing_values(tmp_path: Path) -> None:
    namespaces_directory = tmp_path / "namespaces"
    database_path = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    connection = sqlite3.connect(database_path)
    connection.execute(
        """
        INSERT INTO notes (id, content, tags, is_collapsed, created_at, updated_at)
        VALUES ('note-secret', 'TOP SECRET NOTE', '@private', 0, ?, ?)
        """,
        (_NOW, _NOW),
    )
    connection.execute(
        "UPDATE app_settings SET command_palette_usage_json = ? WHERE id = 1",
        ('{"lastQueryTokens":["TOP SECRET SEARCH"]}',),
    )
    connection.commit()
    connection.close()

    report = audit_all_namespaces(namespaces_directory=namespaces_directory)
    rendered = report.render_text()

    assert len(report.findings) == 4
    assert "notes.content" in rendered
    assert "notes.tags" in rendered
    assert "app_settings.command_palette_usage_json" in rendered
    assert "- private: FAIL" in rendered
    assert "TOP SECRET" not in rendered
    assert "note-secret" not in rendered
    assert report.startup_allowed is False


def test_audit_requires_authenticated_migration_for_legacy_search_history_schema(
    tmp_path: Path,
) -> None:
    namespaces_directory = tmp_path / "namespaces"
    database_path = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    _replace_with_legacy_search_history(database_path)

    report = audit_all_namespaces(namespaces_directory=namespaces_directory)

    assert report.startup_allowed is True
    assert report.fatal_findings == ()
    assert len(report.migration_findings) == 1
    assert report.migration_findings[0].table == "search_interaction_history"
    assert "deterministic" in report.migration_findings[0].message


def test_startup_allows_only_known_password_dependent_migration_payloads(
    tmp_path: Path,
) -> None:
    namespaces_directory = tmp_path / "namespaces"
    database_path = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    connection = sqlite3.connect(database_path)
    connection.execute(
        "UPDATE app_settings SET client_preferences_json = ? WHERE id = 1",
        ('{"pref.theme":"dark"}',),
    )
    connection.execute("PRAGMA user_version = 0")
    connection.commit()
    connection.close()

    report = audit_all_namespaces(namespaces_directory=namespaces_directory)

    assert report.passed is False
    assert report.startup_allowed is True
    assert len(report.migration_findings) == 1
    assert report.fatal_findings == ()
    assert report.migration_findings[0].field == "client_preferences_json"


def test_current_database_plaintext_is_fatal_even_for_a_former_migration_field(
    tmp_path: Path,
) -> None:
    namespaces_directory = tmp_path / "namespaces"
    database_path = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    connection = sqlite3.connect(database_path)
    connection.execute(
        "UPDATE app_settings SET client_preferences_json = ? WHERE id = 1",
        ('{"pref.theme":"dark"}',),
    )
    connection.execute("PRAGMA user_version = 1")
    connection.commit()
    connection.close()

    report = audit_all_namespaces(namespaces_directory=namespaces_directory)

    assert report.startup_allowed is False
    assert len(report.fatal_findings) == 1
    assert report.migration_findings == ()


def test_incomplete_migration_field_encryption_metadata_is_fatal(
    tmp_path: Path,
) -> None:
    namespaces_directory = tmp_path / "namespaces"
    database_path = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    connection = sqlite3.connect(database_path)
    connection.execute(
        """
        UPDATE app_settings
        SET client_preferences_json = ?,
            client_preferences_encryption_nonce = ?,
            client_preferences_encryption_tag = NULL
        WHERE id = 1
        """,
        ('{"pref.theme":"dark"}', b"n" * 12),
    )
    connection.execute("PRAGMA user_version = 0")
    connection.commit()
    connection.close()

    report = audit_all_namespaces(namespaces_directory=namespaces_directory)

    assert report.startup_allowed is False
    assert len(report.fatal_findings) == 1
    assert "incomplete encryption metadata" in report.fatal_findings[0].message


def test_audit_checks_file_database_and_nonce_reuse_across_databases(tmp_path: Path) -> None:
    namespaces_directory = tmp_path / "namespaces"
    database_path = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    _insert_encrypted_note(database_path, note_id="note-1", nonce_byte=b"1")
    file_database_path = resolve_file_database_path(database_path)
    connection = sqlite3.connect(file_database_path)
    initialize_file_schema(connection)
    connection.execute(
        """
        INSERT INTO files (
            id, title, title_encryption_nonce, title_encryption_tag,
            metadata_json, metadata_encryption_nonce, metadata_encryption_tag,
            blob_data, blob_encryption_nonce, blob_encryption_tag,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "file-1",
            "dGl0bGU=",
            b"1" * 12,
            b"a" * 16,
            "bWV0YWRhdGE=",
            b"3" * 12,
            b"b" * 16,
            b"encrypted-blob",
            b"4" * 12,
            b"c" * 16,
            _NOW,
            _NOW,
        ),
    )
    connection.commit()
    connection.close()

    report = audit_all_namespaces(namespaces_directory=namespaces_directory)

    assert any("AES-GCM nonce is reused" in finding.message for finding in report.findings)
    assert any(finding.field == "title" for finding in report.findings)


def test_audit_fails_closed_for_unknown_tables_and_columns(tmp_path: Path) -> None:
    namespaces_directory = tmp_path / "namespaces"
    database_path = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    connection = sqlite3.connect(database_path)
    connection.execute("ALTER TABLE notes ADD COLUMN future_payload TEXT")
    connection.execute("CREATE TABLE plugin_secrets (secret TEXT NOT NULL)")
    connection.execute("INSERT INTO plugin_secrets (secret) VALUES ('plaintext')")
    connection.commit()
    connection.close()

    report = audit_all_namespaces(namespaces_directory=namespaces_directory)
    messages = [finding.message for finding in report.findings]

    assert any("unknown table" in message for message in messages)
    assert any("unknown column" in message for message in messages)


def test_audit_reports_missing_contract_columns_without_crashing(tmp_path: Path) -> None:
    namespaces_directory = tmp_path / "namespaces"
    database_path = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    replacement_path = database_path.with_suffix(".replacement")
    connection = sqlite3.connect(replacement_path)
    connection.execute(
        """
        CREATE TABLE app_settings (
            id INTEGER PRIMARY KEY,
            encryption_enabled INTEGER NOT NULL
        )
        """
    )
    connection.execute("INSERT INTO app_settings (id, encryption_enabled) VALUES (1, 1)")
    connection.commit()
    connection.close()
    replacement_path.replace(database_path)

    report = audit_all_namespaces(namespaces_directory=namespaces_directory)

    assert report.namespace_count == 1
    assert any("expected column is missing" in finding.message for finding in report.findings)


def test_audit_reports_missing_namespace_directory_as_configuration_failure(tmp_path: Path) -> None:
    missing_directory = tmp_path / "not-created"

    report = audit_all_namespaces(namespaces_directory=missing_directory)

    assert report.namespace_count == 0
    assert len(report.findings) == 1
    assert "does not exist" in report.findings[0].message


def test_cli_returns_nonzero_and_does_not_print_plaintext(
    tmp_path: Path,
    capsys,
) -> None:
    namespaces_directory = tmp_path / "namespaces"
    database_path = _create_namespace_database(
        namespaces_directory,
        namespace="private",
        encryption_enabled=True,
    )
    connection = sqlite3.connect(database_path)
    connection.execute(
        """
        INSERT INTO notes (id, content, tags, is_collapsed, created_at, updated_at)
        VALUES ('secret-id', 'SECRET BODY', '@secret', 0, ?, ?)
        """,
        (_NOW, _NOW),
    )
    connection.commit()
    connection.close()

    exit_code = main(["--namespaces-dir", str(namespaces_directory)])
    output = capsys.readouterr().out

    assert exit_code == 1
    assert "Encrypted namespace audit: FAIL" in output
    assert "SECRET BODY" not in output
    assert "secret-id" not in output
