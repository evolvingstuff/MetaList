"""Verified pre-update archives without importing app configuration or opening a namespace."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile

from app.server_runtime import validate_namespace


def _namespace_database_paths(namespaces_directory: Path) -> tuple[Path, ...]:
    if not namespaces_directory.exists():
        return ()
    if not namespaces_directory.is_dir():
        raise RuntimeError(f"Namespace root is not a directory: {namespaces_directory}")
    databases = []
    for directory in sorted(namespaces_directory.iterdir()):
        if not directory.is_dir():
            continue
        namespace = validate_namespace(namespace=directory.name)
        database = directory / f"{namespace}.metalist.db"
        if not database.is_file():
            raise RuntimeError(f"Namespace database is missing or not a file: {database}")
        databases.append(database)
    return tuple(databases)


def _database_sources(database_path: Path) -> tuple[tuple[str, Path], ...]:
    sources = [("notes", database_path)]
    for role, suffix in (("files", "files"), ("search_history", "search-history")):
        sidecar = database_path.with_name(f"{database_path.stem}.{suffix}.db")
        if not sidecar.exists():
            continue
        if not sidecar.is_file():
            raise RuntimeError(f"Namespace database sidecar is not a file: {sidecar}")
        sources.append((role, sidecar))
    return tuple(sources)


def _snapshot_database(source_path: Path, snapshot_path: Path) -> None:
    # mode=ro includes committed WAL pages; immutable=1 would omit them.
    source = sqlite3.connect(f"{source_path.as_uri()}?mode=ro", uri=True)
    try:
        target = sqlite3.connect(snapshot_path)
        try:
            source.backup(target)
            target.commit()
            integrity = target.execute("PRAGMA integrity_check").fetchall()
            if integrity != [("ok",)]:
                raise RuntimeError(f"Backup database integrity check failed: {source_path}")
        finally:
            target.close()
    finally:
        source.close()


def _read_encryption_enabled(snapshot_path: Path) -> bool:
    connection = sqlite3.connect(f"{snapshot_path.as_uri()}?mode=ro", uri=True)
    try:
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('app_settings', 'settings')"
        )}
        if "app_settings" in tables:
            settings_table = "app_settings"
        elif "settings" in tables:
            settings_table = "settings"
        else:
            raise RuntimeError("Namespace backup requires a recognized settings table")
        row = connection.execute(
            f"SELECT encryption_enabled FROM {settings_table} ORDER BY id ASC LIMIT 1"
        ).fetchone()
        if row is None or row[0] not in (0, 1):
            raise RuntimeError("Namespace backup requires a valid encryption setting")
        return bool(row[0])
    finally:
        connection.close()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_archive(archive_path: Path, manifest: dict) -> None:
    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = archive.getmembers()
        expected_names = {"manifest.json", *(entry["archive_name"] for entry in manifest["files"])}
        if len(members) != len(expected_names) or {member.name for member in members} != expected_names:
            raise RuntimeError(f"Backup archive membership verification failed: {archive_path}")
        if not all(member.isfile() for member in members):
            raise RuntimeError(f"Backup archive contains a non-file member: {archive_path}")
        manifest_stream = archive.extractfile("manifest.json")
        assert manifest_stream is not None
        with manifest_stream:
            if json.load(manifest_stream) != manifest:
                raise RuntimeError(f"Backup manifest verification failed: {archive_path}")
        for entry in manifest["files"]:
            member = archive.getmember(entry["archive_name"])
            stream = archive.extractfile(member)
            assert stream is not None
            digest = hashlib.sha256()
            with stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if member.size != entry["size_bytes"] or digest.hexdigest() != entry["sha256"]:
                raise RuntimeError(f"Backup checksum verification failed: {archive_path}")


def _backup_namespace(database_path: Path) -> Path:
    namespace = database_path.parent.name
    now = datetime.now(timezone.utc)
    backup_directory = database_path.parent / "backups"
    backup_directory.mkdir(parents=True, exist_ok=True)
    archive_path = backup_directory / f"{namespace}-{now:%Y%m%d-%H%M%S-%f}.metalist-backup.tar.gz"
    if archive_path.exists():
        raise FileExistsError(f"Backup already exists: {archive_path}")
    with tempfile.TemporaryDirectory(prefix="metalist-pre-update-") as temporary_directory:
        snapshot_directory = Path(temporary_directory)
        entries = []
        for role, source_path in _database_sources(database_path):
            snapshot = snapshot_directory / source_path.name
            _snapshot_database(source_path, snapshot)
            entries.append({
                "archive_name": snapshot.name, "database_role": role,
                "size_bytes": snapshot.stat().st_size, "sha256": _sha256(snapshot),
            })
        # Same versioned manifest as ordinary MetaList backups, so existing restore works.
        manifest = {
            "backup_format_version": 1, "manifest_schema_version": 1,
            "namespace": namespace, "created_at": now.isoformat(),
            "encryption_enabled": _read_encryption_enabled(snapshot_directory / database_path.name),
            "files": entries,
        }
        manifest_path = snapshot_directory / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
        with tarfile.open(archive_path, mode="x:gz") as archive:
            archive.add(manifest_path, arcname="manifest.json")
            for entry in entries:
                archive.add(snapshot_directory / entry["archive_name"], arcname=entry["archive_name"])
        _verify_archive(archive_path, manifest)
    return archive_path


def backup_all_namespaces_for_update(*, namespaces_directory: Path) -> tuple[Path, ...]:
    """Back up all saved namespace data after writers stop; never prune old archives."""
    if not isinstance(namespaces_directory, Path):
        raise TypeError("namespaces_directory must be a Path")
    databases = _namespace_database_paths(namespaces_directory.resolve())
    archives = []
    for database in databases:
        print(f"Backing up namespace {database.parent.name}...", flush=True)
        archive = _backup_namespace(database)
        archives.append(archive)
        print(f"Verified backup: {archive}", flush=True)
    return tuple(archives)
