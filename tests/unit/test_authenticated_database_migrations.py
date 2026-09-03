from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from app.db.migrations import CURRENT_DATABASE_VERSION
from app.db.migrations import read_database_version
from app.db.schema import initialize_schema
from app.models.database import SafeSession
from app.services.auth_service import AuthService
from app.services.auth_service import migrate_restored_database_if_unlocked
from app.services.backup_service import create_timestamped_backup_for_paths
from app.services.encryption import EncryptionService


_NOW = "2026-08-01T00:00:00+00:00"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class _DatabaseHandle:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def connection(self) -> sqlite3.Connection:
        return self._connection


def _encrypted_legacy_connection(database_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    initialize_schema(connection)
    connection.execute(
        """
        INSERT INTO app_settings (
            id,
            encryption_enabled,
            client_preferences_json,
            command_palette_usage_json,
            created_at,
            updated_at
        ) VALUES (1, 1, ?, ?, ?, ?)
        """,
        (
            '{"pref.theme":"dark"}',
            '{"lastQueryTokens":["private"]}',
            _NOW,
            _NOW,
        ),
    )
    connection.commit()
    return connection


def test_authenticated_migration_backs_up_before_rewriting(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database_path = tmp_path / "namespace.db"
    connection = _encrypted_legacy_connection(database_path)
    backup_observations: list[str] = []

    def _create_backup():
        row = connection.execute(
            "SELECT client_preferences_json FROM app_settings WHERE id = 1"
        ).fetchone()
        backup_observations.append(row[0])
        return object()

    monkeypatch.setattr(
        "app.services.auth_service.create_timestamped_backup",
        _create_backup,
    )
    auth = AuthService(_DatabaseHandle(connection))

    result = auth.run_authenticated_database_migrations(dek=b"d" * 32)

    assert backup_observations == ['{"pref.theme":"dark"}']
    assert result.applied_versions == (1, 2, 3, 4, 5, 6)
    assert result.rewritten_payload_count == 2
    assert read_database_version(connection) == CURRENT_DATABASE_VERSION
    stored_on_migration_connection = connection.execute(
        "SELECT client_preferences_json FROM app_settings WHERE id = 1"
    ).fetchone()[0]
    assert "dark" not in stored_on_migration_connection

    observer_connection = sqlite3.connect(database_path)
    try:
        assert read_database_version(observer_connection) == CURRENT_DATABASE_VERSION
        stored_on_observer_connection = observer_connection.execute(
            "SELECT client_preferences_json FROM app_settings WHERE id = 1"
        ).fetchone()[0]
        assert "dark" not in stored_on_observer_connection
    finally:
        observer_connection.close()
    connection.close()


def test_current_database_does_not_create_redundant_migration_backup(
    tmp_path: Path,
    monkeypatch,
) -> None:
    connection = _encrypted_legacy_connection(tmp_path / "current.db")
    connection.execute(f"PRAGMA user_version = {CURRENT_DATABASE_VERSION}")
    connection.commit()
    backup_calls: list[bool] = []
    monkeypatch.setattr(
        "app.services.auth_service.create_timestamped_backup",
        lambda: backup_calls.append(True),
    )
    auth = AuthService(_DatabaseHandle(connection))

    result = auth.run_authenticated_database_migrations(dek=b"d" * 32)

    assert result.applied_versions == ()
    assert backup_calls == []
    connection.close()


def test_restored_plaintext_database_migrates_only_after_installing_live_copy(
    tmp_path: Path,
) -> None:
    connection = _encrypted_legacy_connection(tmp_path / "restored-live.db")
    connection.execute("UPDATE app_settings SET encryption_enabled = 0 WHERE id = 1")
    connection.commit()

    final_version = migrate_restored_database_if_unlocked(
        connection=connection,
        password_required=False,
    )

    assert final_version == CURRENT_DATABASE_VERSION
    assert read_database_version(connection) == CURRENT_DATABASE_VERSION
    connection.close()


def test_restored_encrypted_database_defers_migration_until_unlock(
    tmp_path: Path,
) -> None:
    connection = _encrypted_legacy_connection(tmp_path / "restored-encrypted-live.db")

    locked_version = migrate_restored_database_if_unlocked(
        connection=connection,
        password_required=True,
    )

    assert locked_version == 0
    assert read_database_version(connection) == 0
    connection.close()


def test_authenticated_migration_does_not_rewrite_historical_backups(
    tmp_path: Path,
    monkeypatch,
) -> None:
    connection = _encrypted_legacy_connection(tmp_path / "namespace.db")
    internal_backup = tmp_path / "backups" / "namespace-old.metalist-backup.tar.gz"
    configured_backup = tmp_path / "Downloads" / "namespace-old.metalist-backup.tar.gz"
    internal_backup.parent.mkdir()
    configured_backup.parent.mkdir()
    internal_backup.write_bytes(b"immutable-internal-backup")
    configured_backup.write_bytes(b"immutable-configured-folder-backup")
    before_hashes = (_sha256(internal_backup), _sha256(configured_backup))
    monkeypatch.setattr(
        "app.services.auth_service.create_timestamped_backup",
        lambda: object(),
    )
    auth = AuthService(_DatabaseHandle(connection))

    result = auth.run_authenticated_database_migrations(dek=b"d" * 32)

    assert result.applied_versions == (1, 2, 3, 4, 5, 6)
    assert read_database_version(connection) == CURRENT_DATABASE_VERSION
    assert (_sha256(internal_backup), _sha256(configured_backup)) == before_hashes
    connection.close()


def test_authenticated_migration_never_opens_backup_from_different_dek_lineage(
    tmp_path: Path,
    monkeypatch,
) -> None:
    old_database_path = tmp_path / "old-lineage" / "namespace.metalist.db"
    old_database_path.parent.mkdir()
    old_connection = _encrypted_legacy_connection(old_database_path)
    old_encryption = EncryptionService()
    old_encryption.dek = b"o" * 32
    encrypted_preferences, nonce, tag = old_encryption.encrypt_for_storage('{"pref.theme":"old"}')
    old_connection.execute(
        """
        UPDATE app_settings
        SET client_preferences_json = ?,
            client_preferences_encryption_nonce = ?,
            client_preferences_encryption_tag = ?
        WHERE id = 1
        """,
        (encrypted_preferences, nonce, tag),
    )
    old_connection.commit()
    old_connection.close()
    configured_backup_directory = tmp_path / "Downloads"
    backup = create_timestamped_backup_for_paths(
        old_database_path,
        configured_backup_directory,
    )
    historical_backup = configured_backup_directory / backup.filename
    historical_backup_hash = _sha256(historical_backup)

    live_connection = _encrypted_legacy_connection(tmp_path / "current-lineage.db")
    monkeypatch.setattr(
        "app.services.auth_service.create_timestamped_backup",
        lambda: object(),
    )
    auth = AuthService(_DatabaseHandle(live_connection))

    result = auth.run_authenticated_database_migrations(dek=b"n" * 32)

    assert result.final_version == CURRENT_DATABASE_VERSION
    assert _sha256(historical_backup) == historical_backup_hash
    live_connection.close()


def test_authenticated_migration_rolls_back_all_rewrites_when_a_payload_is_invalid(
    tmp_path: Path,
    monkeypatch,
) -> None:
    database_path = tmp_path / "invalid.db"
    connection = _encrypted_legacy_connection(database_path)
    historical_backup = tmp_path / "Downloads" / "invalid-old.metalist-backup.tar.gz"
    historical_backup.parent.mkdir()
    historical_backup.write_bytes(b"immutable-even-when-live-migration-fails")
    historical_backup_hash = _sha256(historical_backup)
    connection.execute(
        """
        UPDATE app_settings
        SET tag_prefix_settings_json = ?,
            tag_prefix_settings_encryption_nonce = ?,
            tag_prefix_settings_encryption_tag = NULL
        WHERE id = 1
        """,
        ('{"prefix":"private"}', b"n" * 12),
    )
    connection.commit()
    monkeypatch.setattr(
        "app.services.auth_service.create_timestamped_backup",
        lambda: object(),
    )
    auth = AuthService(_DatabaseHandle(connection))

    with pytest.raises(RuntimeError, match="incomplete encryption metadata"):
        auth.run_authenticated_database_migrations(dek=b"d" * 32)

    assert _sha256(historical_backup) == historical_backup_hash
    observer_connection = sqlite3.connect(database_path)
    try:
        assert read_database_version(observer_connection) == 0
        stored_preferences = observer_connection.execute(
            "SELECT client_preferences_json FROM app_settings WHERE id = 1"
        ).fetchone()[0]
        assert stored_preferences == '{"pref.theme":"dark"}'
    finally:
        observer_connection.close()
        connection.close()
