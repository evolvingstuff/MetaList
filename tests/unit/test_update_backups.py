from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile

import pytest

from app.services import update_backups
from app.services.backup_service import restore_backup_to_paths


def _create_namespace(root: Path, namespace: str, *, encrypted: bool) -> sqlite3.Connection:
    directory = root / namespace
    directory.mkdir(parents=True)
    connection = sqlite3.connect(directory / f"{namespace}.metalist.db")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("CREATE TABLE app_settings (id INTEGER PRIMARY KEY, encryption_enabled INTEGER, vault_metadata BLOB)")
    connection.execute("INSERT INTO app_settings VALUES (1, ?, ?)", (int(encrypted), b"retained vault metadata"))
    connection.execute("CREATE TABLE notes (id TEXT PRIMARY KEY, content BLOB, nonce BLOB, tag BLOB)")
    connection.execute("INSERT INTO notes VALUES ('latest', ?, ?, ?)", (b"saved payload", b"nonce", b"tag"))
    connection.execute("PRAGMA user_version=7")
    connection.commit()
    return connection


def test_update_imports_do_not_initialize_namespace_runtime() -> None:
    completed = subprocess.run(
        [sys.executable, "-c", "import sys; import app.services.self_update; assert 'app.config' not in sys.modules; assert 'app.main' not in sys.modules"],
        cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True,
    )
    assert completed.returncode == 0, completed.stderr


def test_all_namespaces_include_wal_data_settings_files_sounds_and_legacy_sidecar(tmp_path: Path) -> None:
    namespaces = tmp_path / "namespaces"
    plain = _create_namespace(namespaces, "default", encrypted=False)
    locked = _create_namespace(namespaces, "locked", encrypted=True)
    try:
        # Neither namespace has a saved launch profile or a password/DEK in process memory.
        locked.execute("UPDATE notes SET content = ? WHERE id = 'latest'", (b"opaque encrypted content from WAL",))
        locked.commit()
        directory = namespaces / "locked"
        with sqlite3.connect(directory / "locked.metalist.files.db") as files:
            files.execute("CREATE TABLE files (payload BLOB)")
            files.execute("INSERT INTO files VALUES (?)", (b"encrypted attachment",))
            files.execute("CREATE TABLE sounds (payload BLOB)")
            files.execute("INSERT INTO sounds VALUES (?)", (b"encrypted sound",))
        with sqlite3.connect(directory / "locked.metalist.search-history.db") as history:
            history.execute("CREATE TABLE history (payload BLOB)")
            history.execute("INSERT INTO history VALUES (?)", (b"old history",))
        old_backup = directory / "backups" / "locked-20260801-000000-000000.metalist-backup.tar.gz"
        old_backup.parent.mkdir()
        with old_backup.open("xb") as handle:
            handle.write(b"immutable historical backup")
        before = {path: path.read_bytes() for path in (old_backup, directory / "locked.metalist.db")}

        archives = update_backups.backup_all_namespaces_for_update(namespaces_directory=namespaces)

        assert len(archives) == 2
        assert {archive.parent.parent.name for archive in archives} == {"default", "locked"}
        assert all(archive.is_absolute() and archive.parent.name == "backups" for archive in archives)
        assert all(path.read_bytes() == contents for path, contents in before.items())
        archive_path = next(path for path in archives if path.parent.parent.name == "locked")
        with tarfile.open(archive_path, "r:gz") as archive:
            manifest_stream = archive.extractfile("manifest.json")
            assert manifest_stream is not None
            manifest = json.load(manifest_stream)
            assert manifest["encryption_enabled"] is True
            assert {entry["database_role"] for entry in manifest["files"]} == {"notes", "files", "search_history"}
            for entry in manifest["files"]:
                stream = archive.extractfile(entry["archive_name"])
                assert stream is not None
                payload = stream.read()
                assert hashlib.sha256(payload).hexdigest() == entry["sha256"]
                assert len(payload) == entry["size_bytes"]
        archive_bytes = archive_path.read_bytes()
        restored = tmp_path / "restore" / "locked.metalist.db"
        restore_backup_to_paths(archive_path, restored)
        with sqlite3.connect(restored) as notes:
            assert notes.execute("SELECT content, nonce, tag FROM notes").fetchone() == (b"opaque encrypted content from WAL", b"nonce", b"tag")
            assert notes.execute("SELECT vault_metadata FROM app_settings").fetchone() == (b"retained vault metadata",)
            assert notes.execute("PRAGMA user_version").fetchone() == (7,)
        with sqlite3.connect(restored.with_name("locked.metalist.files.db")) as files:
            assert files.execute("SELECT payload FROM files").fetchone() == (b"encrypted attachment",)
            assert files.execute("SELECT payload FROM sounds").fetchone() == (b"encrypted sound",)
        assert archive_path.read_bytes() == archive_bytes
    finally:
        locked.close()
        plain.close()


def test_backup_collision_leaves_existing_archive_untouched(tmp_path: Path, monkeypatch) -> None:
    connection = _create_namespace(tmp_path, "default", encrypted=False)
    connection.close()

    class FixedDatetime:
        @staticmethod
        def now(tz):
            assert tz is timezone.utc
            return datetime(2026, 9, 11, tzinfo=timezone.utc)

    monkeypatch.setattr(update_backups, "datetime", FixedDatetime)
    archive = tmp_path / "default" / "backups" / "default-20260911-000000-000000.metalist-backup.tar.gz"
    archive.parent.mkdir()
    with archive.open("xb") as handle:
        handle.write(b"original backup")
    with pytest.raises(FileExistsError, match="already exists"):
        update_backups.backup_all_namespaces_for_update(namespaces_directory=tmp_path)
    assert archive.read_bytes() == b"original backup"


def test_legacy_settings_are_backed_up_without_schema_changes(tmp_path: Path) -> None:
    connection = _create_namespace(tmp_path, "legacy", encrypted=True)
    connection.execute("ALTER TABLE app_settings RENAME TO settings")
    connection.execute("UPDATE settings SET id = 9")
    connection.commit()
    connection.close()
    database = tmp_path / "legacy" / "legacy.metalist.db"
    original_bytes = database.read_bytes()

    archives = update_backups.backup_all_namespaces_for_update(namespaces_directory=tmp_path)

    assert database.read_bytes() == original_bytes
    with tarfile.open(archives[0], "r:gz") as archive:
        stream = archive.extractfile("manifest.json")
        assert stream is not None
        with stream:
            assert json.load(stream)["encryption_enabled"] is True


def test_checksum_verification_failure_is_fatal(tmp_path: Path, monkeypatch) -> None:
    connection = _create_namespace(tmp_path, "default", encrypted=False)
    connection.close()
    monkeypatch.setattr(update_backups, "_sha256", lambda _path: "0" * 64)
    with pytest.raises(RuntimeError, match="checksum verification failed"):
        update_backups.backup_all_namespaces_for_update(namespaces_directory=tmp_path)


def test_corrupt_database_prevents_backup_success(tmp_path: Path) -> None:
    directory = tmp_path / "broken"
    directory.mkdir()
    with (directory / "broken.metalist.db").open("xb") as source:
        source.write(b"not a SQLite database")
    with pytest.raises(sqlite3.DatabaseError):
        update_backups.backup_all_namespaces_for_update(namespaces_directory=tmp_path)


def test_missing_namespace_database_is_not_silently_skipped(tmp_path: Path) -> None:
    (tmp_path / "missing").mkdir()
    with pytest.raises(RuntimeError, match="database is missing"):
        update_backups.backup_all_namespaces_for_update(namespaces_directory=tmp_path)


def test_no_saved_namespaces_needs_no_backups(tmp_path: Path) -> None:
    assert update_backups.backup_all_namespaces_for_update(namespaces_directory=tmp_path / "absent") == ()
