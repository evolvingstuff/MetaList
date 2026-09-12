from __future__ import annotations

from dataclasses import dataclass
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import tarfile
import tempfile
from threading import Lock

from app.db.session import recoverable_database_change
from app.db.version import CURRENT_DATABASE_VERSION
from app.db.file_schema import initialize_file_schema
from app.db.file_schema import FILES_TABLE
from app.db.file_session import resolve_file_database_path
from app.db.schema import NAMESPACE_LAUNCH_PROFILE_TABLE
from app.models.database import SafeSession


_BACKUP_LOCK = Lock()
_ARCHIVE_BACKUP_FORMAT_VERSION = 1
_MANIFEST_SCHEMA_VERSION = 1
_MANIFEST_FILENAME = "manifest.json"
_SUPPORTED_ARCHIVE_BACKUP_FORMAT_VERSIONS = {_ARCHIVE_BACKUP_FORMAT_VERSION}
_ARCHIVE_BACKUP_FILENAME_RE = re.compile(
    r"^(?P<namespace>.+)-(?P<timestamp>[0-9]{8}-[0-9]{6}-[0-9]{6})\.metalist-backup\.tar\.gz$"
)
_LEGACY_PRIMARY_BACKUP_FILENAME_RE = re.compile(
    r"^(?P<timestamp>[0-9]{8}-[0-9]{6}-[0-9]{6})\.(?P<database_name>.+)\.bak$"
)
_DATABASE_ROLE_NOTES = "notes"
_DATABASE_ROLE_FILES = "files"
_DATABASE_ROLE_SEARCH_HISTORY = "search_history"
_SUPPORTED_DATABASE_ROLES = {
    _DATABASE_ROLE_NOTES,
    _DATABASE_ROLE_FILES,
    _DATABASE_ROLE_SEARCH_HISTORY,
}


@dataclass(frozen=True)
class BackupFileInfo:
    filename: str
    created_at: str
    size_bytes: int


@dataclass(frozen=True)
class BackupLaunchProfile:
    namespace: str
    port: int | None
    https_port: int | None
    mcp_port: int | None


def _coerce_optional_db_port(*, value: object) -> int | None:
    if value is None:
        return None
    return int(value)


def _derive_namespace_name(database_path: Path) -> str:
    if not isinstance(database_path, Path):
        raise TypeError(f"database_path must be a Path, got {type(database_path)}")
    filename = database_path.name
    if filename.endswith(".metalist.db"):
        namespace = filename[: -len(".metalist.db")]
        if namespace == "":
            raise ValueError(f"database_path must include namespace prefix: {database_path}")
        return namespace
    stem = database_path.stem
    if stem == "":
        raise ValueError(f"database_path must include a filename stem: {database_path}")
    return stem


def _format_archive_backup_filename(*, namespace: str, now_utc: datetime) -> str:
    if not isinstance(namespace, str):
        raise TypeError(f"namespace must be a string, got {type(namespace)}")
    if namespace == "":
        raise ValueError("namespace must be non-empty")
    if now_utc.tzinfo is None:
        raise ValueError("now_utc must be timezone-aware")
    timestamp = now_utc.strftime("%Y%m%d-%H%M%S-%f")
    return f"{namespace}-{timestamp}.metalist-backup.tar.gz"


def parse_backup_namespace_from_filename(filename: str) -> str:
    if not isinstance(filename, str) or filename == "":
        raise ValueError("filename must be a non-empty string")
    archive_match = _match_archive_backup_filename(filename)
    if archive_match is not None:
        return archive_match.group("namespace")
    legacy_match = _match_legacy_primary_backup_filename(filename)
    if legacy_match is None:
        raise ValueError(f"Unsupported backup filename: {filename}")
    database_name = legacy_match.group("database_name")
    if database_name.endswith(".metalist.db"):
        namespace = database_name[: -len(".metalist.db")]
        if namespace == "":
            raise RuntimeError(f"Legacy backup filename has empty namespace: {filename}")
        return namespace
    stem = Path(database_name).stem
    if stem == "":
        raise RuntimeError(f"Legacy backup filename has empty stem: {filename}")
    return stem


def _stat_to_backup_info(path: Path) -> BackupFileInfo:
    if not path.exists():
        raise FileNotFoundError(f"Backup file not found: {path}")
    if not path.is_file():
        raise ValueError(f"Backup path is not a file: {path}")

    stat_result = path.stat()
    created_at = datetime.fromtimestamp(stat_result.st_mtime, tz=timezone.utc).isoformat()
    return BackupFileInfo(
        filename=path.name,
        created_at=created_at,
        size_bytes=stat_result.st_size,
    )


def _match_archive_backup_filename(filename: str) -> re.Match[str] | None:
    return _ARCHIVE_BACKUP_FILENAME_RE.fullmatch(filename)


def _match_legacy_primary_backup_filename(filename: str) -> re.Match[str] | None:
    match = _LEGACY_PRIMARY_BACKUP_FILENAME_RE.fullmatch(filename)
    if match is None:
        return None
    database_name = match.group("database_name")
    if (
        not database_name.endswith(".db")
        or database_name.endswith(".files.db")
        or database_name.endswith(".search-history.db")
    ):
        return None
    return match


def _is_archive_backup_filename(filename: str) -> bool:
    return _match_archive_backup_filename(filename) is not None


def _is_legacy_primary_backup_filename(filename: str) -> bool:
    return _match_legacy_primary_backup_filename(filename) is not None


def _validate_archive_backup_filename(*, filename: str, database_path: Path) -> str:
    if not isinstance(filename, str):
        raise TypeError(f"filename must be a string, got {type(filename)}")
    if not isinstance(database_path, Path):
        raise TypeError(f"database_path must be a Path, got {type(database_path)}")
    if filename == "":
        raise ValueError("filename must be non-empty")
    if Path(filename).name != filename:
        raise ValueError("filename must not contain path separators")

    match = _match_archive_backup_filename(filename)
    expected_namespace = _derive_namespace_name(database_path)
    if match is None or match.group("namespace") != expected_namespace:
        raise ValueError("filename must match the active database archive backup naming convention")
    return filename


def _validate_legacy_backup_filename(*, filename: str, database_path: Path) -> str:
    if not isinstance(filename, str):
        raise TypeError(f"filename must be a string, got {type(filename)}")
    if not isinstance(database_path, Path):
        raise TypeError(f"database_path must be a Path, got {type(database_path)}")
    if filename == "":
        raise ValueError("filename must be non-empty")
    if Path(filename).name != filename:
        raise ValueError("filename must not contain path separators")

    match = _match_legacy_primary_backup_filename(filename)
    if match is None or match.group("database_name") != database_path.name:
        raise ValueError("filename must match the active database backup naming convention")
    return filename


def _derive_file_backup_filename(*, filename: str, database_path: Path) -> str:
    validated_filename = _validate_legacy_backup_filename(filename=filename, database_path=database_path)
    match = _match_legacy_primary_backup_filename(validated_filename)
    assert match is not None
    database_name = match.group("database_name")
    file_database_name = f"{database_name[:-len('.db')]}.files.db"
    return f"{match.group('timestamp')}.{file_database_name}.bak"


def _derive_any_file_backup_filename(filename: str) -> str:
    match = _match_legacy_primary_backup_filename(filename)
    if match is None:
        raise ValueError(f"Unsupported legacy primary backup filename: {filename}")
    database_name = match.group("database_name")
    file_database_name = f"{database_name[:-len('.db')]}.files.db"
    return f"{match.group('timestamp')}.{file_database_name}.bak"


def _derive_search_history_backup_filename(*, filename: str, database_path: Path) -> str:
    validated_filename = _validate_legacy_backup_filename(filename=filename, database_path=database_path)
    match = _match_legacy_primary_backup_filename(validated_filename)
    assert match is not None
    database_name = match.group("database_name")
    search_history_database_name = f"{database_name[:-len('.db')]}.search-history.db"
    return f"{match.group('timestamp')}.{search_history_database_name}.bak"


def _derive_any_search_history_backup_filename(filename: str) -> str:
    match = _match_legacy_primary_backup_filename(filename)
    if match is None:
        raise ValueError(f"Unsupported legacy primary backup filename: {filename}")
    database_name = match.group("database_name")
    search_history_database_name = f"{database_name[:-len('.db')]}.search-history.db"
    return f"{match.group('timestamp')}.{search_history_database_name}.bak"


def _resolve_related_file_database_path(database_path: Path) -> Path:
    return resolve_file_database_path(database_path)


def _resolve_related_file_backup_path(
    backup_directory: Path,
    filename: str,
    *,
    database_path: Path,
) -> Path:
    return backup_directory / _derive_file_backup_filename(filename=filename, database_path=database_path)


def _copy_database(source_path: Path, target_path: Path) -> None:
    source_connection = sqlite3.connect(str(source_path), check_same_thread=False)
    target_connection = sqlite3.connect(str(target_path), check_same_thread=False)
    try:
        source_connection.execute("PRAGMA wal_checkpoint(FULL)")
        source_connection.backup(target_connection)
        target_connection.commit()
    finally:
        target_connection.close()
        source_connection.close()


def _copy_immutable_database_source(source_path: Path, target_path: Path) -> None:
    if not source_path.exists():
        raise FileNotFoundError(f"Immutable database source not found: {source_path}")
    if not source_path.is_file():
        raise ValueError(f"Immutable database source must be a file: {source_path}")
    source_uri = f"{source_path.resolve().as_uri()}?mode=ro&immutable=1"
    source_connection = sqlite3.connect(
        source_uri,
        uri=True,
        check_same_thread=False,
    )
    target_connection = sqlite3.connect(str(target_path), check_same_thread=False)
    try:
        source_connection.backup(target_connection)
        target_connection.commit()
    finally:
        target_connection.close()
        source_connection.close()


def _checkpoint_database(database_path: Path) -> None:
    connection = sqlite3.connect(str(database_path), check_same_thread=False)
    try:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        connection.close()


def _reset_file_database_to_empty(file_database_path: Path) -> None:
    file_database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(file_database_path), check_same_thread=False)
    try:
        initialize_file_schema(connection)
        connection.execute(f"DELETE FROM {FILES_TABLE}")
        connection.commit()
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        connection.close()


def _copy_file_from_archive(archive_handle: tarfile.TarFile, *, archive_name: str, target_path: Path) -> None:
    if Path(archive_name).name != archive_name:
        raise RuntimeError(f"Archive member must be a basename: {archive_name}")
    member = archive_handle.getmember(archive_name)
    if not member.isfile():
        raise RuntimeError(f"Archive member is not a file: {archive_name}")
    extracted = archive_handle.extractfile(member)
    if extracted is None:
        raise RuntimeError(f"Archive member could not be read: {archive_name}")
    target_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with target_path.open("wb") as handle:
            shutil.copyfileobj(extracted, handle)
    finally:
        extracted.close()


def _sha256_for_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_launch_profile_from_database(
    *,
    database_path: Path,
    namespace: str,
) -> BackupLaunchProfile | None:
    connection = sqlite3.connect(str(database_path), check_same_thread=False)
    try:
        table_row = connection.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = ?
            LIMIT 1
            """,
            (NAMESPACE_LAUNCH_PROFILE_TABLE,),
        ).fetchone()
        if table_row is None:
            return None
        row = connection.execute(
            f"""
            SELECT namespace, port, https_port, mcp_port
            FROM {NAMESPACE_LAUNCH_PROFILE_TABLE}
            WHERE namespace = ?
            """,
            (namespace,),
        ).fetchone()
    finally:
        connection.close()
    if row is None:
        return None
    stored_namespace = str(row[0])
    if stored_namespace != namespace:
        raise RuntimeError(
            f"Backup launch profile namespace mismatch: expected {namespace}, got {stored_namespace}"
        )
    return BackupLaunchProfile(
        namespace=stored_namespace,
        port=_coerce_optional_db_port(value=row[1]),
        https_port=_coerce_optional_db_port(value=row[2]),
        mcp_port=_coerce_optional_db_port(value=row[3]),
    )


def _rewrite_launch_profile_namespace(
    *,
    database_path: Path,
    source_namespace: str,
    target_namespace: str,
) -> None:
    if source_namespace == target_namespace:
        return
    connection = sqlite3.connect(str(database_path), check_same_thread=False)
    try:
        table_row = connection.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = ?
            LIMIT 1
            """,
            (NAMESPACE_LAUNCH_PROFILE_TABLE,),
        ).fetchone()
        if table_row is None:
            return
        now_text = datetime.now(timezone.utc).isoformat()
        connection.execute(
            f"""
            UPDATE {NAMESPACE_LAUNCH_PROFILE_TABLE}
            SET namespace = ?, updated_at = ?
            WHERE namespace = ?
            """,
            (target_namespace, now_text, source_namespace),
        )
        connection.commit()
        _checkpoint_database(database_path)
    finally:
        connection.close()


def read_backup_launch_profile(
    backup_path: Path,
    *,
    expected_namespace: str,
) -> BackupLaunchProfile | None:
    if not isinstance(backup_path, Path):
        raise TypeError(f"backup_path must be a Path, got {type(backup_path)}")
    if not isinstance(expected_namespace, str) or expected_namespace == "":
        raise ValueError("expected_namespace must be a non-empty string")
    if not backup_path.exists():
        raise FileNotFoundError(f"Backup file not found: {backup_path}")
    if not backup_path.is_file():
        raise ValueError(f"Backup path is not a file: {backup_path}")
    if not _is_archive_backup_filename(backup_path.name):
        return None

    validated_manifest = _validate_archive_contents(
        backup_path,
        expected_namespace=expected_namespace,
    )
    raw_files = validated_manifest["files"]
    assert isinstance(raw_files, list)
    notes_archive_name: str | None = None
    for raw_entry in raw_files:
        if not isinstance(raw_entry, dict):
            raise RuntimeError("validated manifest files entries must be dictionaries")
        database_role = raw_entry["database_role"]
        assert isinstance(database_role, str)
        if database_role != _DATABASE_ROLE_NOTES:
            continue
        archive_name = raw_entry["archive_name"]
        assert isinstance(archive_name, str)
        notes_archive_name = archive_name
        break
    if notes_archive_name is None:
        raise RuntimeError("Archive manifest must include the notes database")

    with tempfile.TemporaryDirectory(prefix="metalist-profile-read-") as temp_directory:
        temp_database_path = Path(temp_directory) / notes_archive_name
        with tarfile.open(backup_path, mode="r:gz") as archive_handle:
            _copy_file_from_archive(
                archive_handle,
                archive_name=notes_archive_name,
                target_path=temp_database_path,
            )
        return _read_launch_profile_from_database(
            database_path=temp_database_path,
            namespace=expected_namespace,
        )


def _detect_encryption_enabled(database_path: Path) -> bool:
    connection = sqlite3.connect(str(database_path), check_same_thread=False)
    try:
        table_rows = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('app_settings', 'settings')"
        ).fetchall()
        table_names = {str(row[0]) for row in table_rows}
        settings_table = "app_settings"
        if settings_table not in table_names:
            settings_table = "settings"
        if settings_table not in table_names:
            return False
        settings_row = connection.execute(
            f"SELECT encryption_enabled FROM {settings_table} ORDER BY id ASC LIMIT 1"
        ).fetchone()
        if settings_row is None:
            return False
        encryption_enabled = settings_row[0]
        if encryption_enabled not in (0, 1):
            raise RuntimeError(
                f"{settings_table}.encryption_enabled must be 0 or 1, got {encryption_enabled!r}"
            )
        return bool(encryption_enabled)
    finally:
        connection.close()


def _build_manifest_file_entry(*, archive_name: str, database_role: str, path: Path) -> dict[str, object]:
    if database_role not in _SUPPORTED_DATABASE_ROLES:
        raise ValueError(f"Unsupported database role: {database_role}")
    size_bytes = path.stat().st_size
    return {
        "archive_name": archive_name,
        "database_role": database_role,
        "size_bytes": size_bytes,
        "sha256": _sha256_for_file(path),
    }


def _validate_manifest_file_entry(raw_entry: object) -> dict[str, object]:
    if not isinstance(raw_entry, dict):
        raise RuntimeError("manifest files entries must be objects")
    if "archive_name" not in raw_entry:
        raise RuntimeError("manifest file entry missing archive_name")
    archive_name = raw_entry["archive_name"]
    if not isinstance(archive_name, str) or archive_name == "":
        raise RuntimeError("manifest file entry missing archive_name")
    if Path(archive_name).name != archive_name:
        raise RuntimeError(f"manifest archive_name must be a basename: {archive_name}")
    if "database_role" not in raw_entry:
        raise RuntimeError("manifest file entry missing database_role")
    database_role = raw_entry["database_role"]
    if database_role not in _SUPPORTED_DATABASE_ROLES:
        raise RuntimeError(f"manifest file entry has unsupported database_role: {database_role!r}")
    if "size_bytes" not in raw_entry:
        raise RuntimeError("manifest file entry missing valid size_bytes")
    size_bytes = raw_entry["size_bytes"]
    if not isinstance(size_bytes, int) or size_bytes < 0:
        raise RuntimeError("manifest file entry missing valid size_bytes")
    if "sha256" not in raw_entry:
        raise RuntimeError("manifest file entry missing valid sha256")
    sha256 = raw_entry["sha256"]
    if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise RuntimeError("manifest file entry missing valid sha256")
    return {
        "archive_name": archive_name,
        "database_role": database_role,
        "size_bytes": size_bytes,
        "sha256": sha256,
    }


def _read_archive_manifest(backup_path: Path) -> dict[str, object]:
    with tarfile.open(backup_path, mode="r:gz") as archive_handle:
        members_by_name = {member.name: member for member in archive_handle.getmembers()}
        if _MANIFEST_FILENAME not in members_by_name:
            raise RuntimeError(f"Archive is missing {_MANIFEST_FILENAME}")
        member = members_by_name[_MANIFEST_FILENAME]
        if not member.isfile():
            raise RuntimeError(f"Archive member is not a file: {_MANIFEST_FILENAME}")
        manifest_handle = archive_handle.extractfile(member)
        if manifest_handle is None:
            raise RuntimeError(f"Archive member could not be read: {_MANIFEST_FILENAME}")
        try:
            manifest_payload = manifest_handle.read()
        finally:
            manifest_handle.close()

    manifest = json.loads(manifest_payload)
    if not isinstance(manifest, dict):
        raise RuntimeError("Archive manifest root must be an object")
    return manifest


def _validate_archive_manifest(
    manifest: dict[str, object],
    *,
    expected_namespace: str | None,
) -> dict[str, object]:
    if "backup_format_version" not in manifest:
        raise RuntimeError("Archive manifest missing integer backup_format_version")
    backup_format_version = manifest["backup_format_version"]
    if not isinstance(backup_format_version, int):
        raise RuntimeError("Archive manifest missing integer backup_format_version")
    if backup_format_version not in _SUPPORTED_ARCHIVE_BACKUP_FORMAT_VERSIONS:
        raise RuntimeError(f"Unsupported backup format version: {backup_format_version}")

    if "manifest_schema_version" not in manifest:
        raise RuntimeError("Unsupported manifest schema version: missing")
    manifest_schema_version = manifest["manifest_schema_version"]
    if manifest_schema_version != _MANIFEST_SCHEMA_VERSION:
        raise RuntimeError(f"Unsupported manifest schema version: {manifest_schema_version!r}")

    if "namespace" not in manifest:
        raise RuntimeError("Archive manifest missing namespace")
    namespace = manifest["namespace"]
    if not isinstance(namespace, str) or namespace == "":
        raise RuntimeError("Archive manifest missing namespace")
    if expected_namespace is not None and namespace != expected_namespace:
        raise RuntimeError(
            f"Archive namespace {namespace!r} does not match expected namespace {expected_namespace!r}"
        )

    if "created_at" not in manifest:
        raise RuntimeError("Archive manifest missing created_at")
    created_at = manifest["created_at"]
    if not isinstance(created_at, str) or created_at == "":
        raise RuntimeError("Archive manifest missing created_at")

    if "encryption_enabled" not in manifest:
        raise RuntimeError("Archive manifest missing boolean encryption_enabled")
    encryption_enabled = manifest["encryption_enabled"]
    if not isinstance(encryption_enabled, bool):
        raise RuntimeError("Archive manifest missing boolean encryption_enabled")

    if "files" not in manifest:
        raise RuntimeError("Archive manifest missing files list")
    raw_files = manifest["files"]
    if not isinstance(raw_files, list) or len(raw_files) == 0:
        raise RuntimeError("Archive manifest missing files list")

    files: list[dict[str, object]] = []
    seen_archive_names: set[str] = set()
    seen_roles: set[str] = set()
    for raw_entry in raw_files:
        entry = _validate_manifest_file_entry(raw_entry)
        archive_name = entry["archive_name"]
        assert isinstance(archive_name, str)
        if archive_name in seen_archive_names:
            raise RuntimeError(f"Archive manifest has duplicate archive_name: {archive_name}")
        seen_archive_names.add(archive_name)

        database_role = entry["database_role"]
        assert isinstance(database_role, str)
        if database_role in seen_roles:
            raise RuntimeError(f"Archive manifest has duplicate database_role: {database_role}")
        seen_roles.add(database_role)
        files.append(entry)

    if _DATABASE_ROLE_NOTES not in seen_roles:
        raise RuntimeError("Archive manifest must include the notes database")

    return {
        "backup_format_version": backup_format_version,
        "manifest_schema_version": manifest_schema_version,
        "namespace": namespace,
        "created_at": created_at,
        "encryption_enabled": encryption_enabled,
        "files": files,
    }


def _validate_archive_contents(
    backup_path: Path,
    *,
    expected_namespace: str | None,
) -> dict[str, object]:
    manifest = _read_archive_manifest(backup_path)
    validated_manifest = _validate_archive_manifest(manifest, expected_namespace=expected_namespace)
    files = validated_manifest["files"]
    assert isinstance(files, list)

    with tarfile.open(backup_path, mode="r:gz") as archive_handle:
        member_names = {member.name: member for member in archive_handle.getmembers()}
        for raw_entry in files:
            if not isinstance(raw_entry, dict):
                raise RuntimeError("validated manifest files entries must be dictionaries")
            archive_name = raw_entry["archive_name"]
            assert isinstance(archive_name, str)
            if archive_name not in member_names:
                raise RuntimeError(f"Archive is missing member: {archive_name}")

            member = member_names[archive_name]
            if not member.isfile():
                raise RuntimeError(f"Archive member is not a file: {archive_name}")

            extracted = archive_handle.extractfile(member)
            if extracted is None:
                raise RuntimeError(f"Archive member could not be read: {archive_name}")
            digest = hashlib.sha256()
            size_bytes = 0
            try:
                for chunk in iter(lambda: extracted.read(1024 * 1024), b""):
                    digest.update(chunk)
                    size_bytes += len(chunk)
            finally:
                extracted.close()

            expected_size_bytes = raw_entry["size_bytes"]
            assert isinstance(expected_size_bytes, int)
            if size_bytes != expected_size_bytes:
                raise RuntimeError(
                    f"Archive member size mismatch for {archive_name}: "
                    f"expected {expected_size_bytes}, got {size_bytes}"
                )

            expected_sha256 = raw_entry["sha256"]
            assert isinstance(expected_sha256, str)
            actual_sha256 = digest.hexdigest()
            if actual_sha256 != expected_sha256:
                raise RuntimeError(
                    f"Archive member checksum mismatch for {archive_name}: "
                    f"expected {expected_sha256}, got {actual_sha256}"
                )

    return validated_manifest


def _collect_existing_database_sources(database_path: Path) -> list[tuple[str, Path]]:
    if not database_path.exists():
        raise FileNotFoundError(f"Database file not found: {database_path}")
    if not database_path.is_file():
        raise ValueError(f"Database path is not a file: {database_path}")

    sources: list[tuple[str, Path]] = [(_DATABASE_ROLE_NOTES, database_path)]

    related_file_database_path = _resolve_related_file_database_path(database_path)
    if related_file_database_path.exists():
        if not related_file_database_path.is_file():
            raise ValueError(f"Related file database path is not a file: {related_file_database_path}")
        sources.append((_DATABASE_ROLE_FILES, related_file_database_path))

    return sources


def _create_archive_backup_for_paths(database_path: Path, backup_directory: Path) -> BackupFileInfo:
    if not isinstance(database_path, Path):
        raise TypeError(f"database_path must be a Path, got {type(database_path)}")
    if not isinstance(backup_directory, Path):
        raise TypeError(f"backup_directory must be a Path, got {type(backup_directory)}")

    backup_directory.mkdir(parents=True, exist_ok=True)

    with _BACKUP_LOCK:
        now_utc = datetime.now(timezone.utc)
        namespace = _derive_namespace_name(database_path)
        filename = _format_archive_backup_filename(namespace=namespace, now_utc=now_utc)
        backup_path = backup_directory / filename
        if backup_path.exists():
            raise FileExistsError(f"Backup already exists: {backup_path}")

        with tempfile.TemporaryDirectory(prefix="metalist-backup-") as temp_directory:
            temp_directory_path = Path(temp_directory)
            snapshot_entries: list[tuple[str, Path]] = []
            for database_role, source_path in _collect_existing_database_sources(database_path):
                snapshot_path = temp_directory_path / source_path.name
                _copy_database(source_path, snapshot_path)
                snapshot_entries.append((database_role, snapshot_path))

            notes_snapshot_path = None
            for database_role, snapshot_path in snapshot_entries:
                if database_role == _DATABASE_ROLE_NOTES:
                    notes_snapshot_path = snapshot_path
                    break
            assert notes_snapshot_path is not None

            manifest = {
                "backup_format_version": _ARCHIVE_BACKUP_FORMAT_VERSION,
                "manifest_schema_version": _MANIFEST_SCHEMA_VERSION,
                "namespace": namespace,
                "created_at": now_utc.isoformat(),
                "encryption_enabled": _detect_encryption_enabled(notes_snapshot_path),
                "files": [
                    _build_manifest_file_entry(
                        archive_name=snapshot_path.name,
                        database_role=database_role,
                        path=snapshot_path,
                    )
                    for database_role, snapshot_path in snapshot_entries
                ],
            }
            manifest_path = temp_directory_path / _MANIFEST_FILENAME
            manifest_path.write_text(
                json.dumps(manifest, indent=2, sort_keys=True),
                encoding="utf-8",
            )

            with tarfile.open(backup_path, mode="x:gz") as archive_handle:
                archive_handle.add(manifest_path, arcname=_MANIFEST_FILENAME)
                for _, snapshot_path in snapshot_entries:
                    archive_handle.add(snapshot_path, arcname=snapshot_path.name)

    return _stat_to_backup_info(backup_path)


def _restore_archive_backup_to_paths(
    backup_path: Path,
    database_path: Path,
    *,
    source_namespace: str | None,
) -> None:
    target_namespace = _derive_namespace_name(database_path)
    expected_namespace = target_namespace
    if source_namespace is not None:
        expected_namespace = source_namespace
    validated_manifest = _validate_archive_contents(
        backup_path,
        expected_namespace=expected_namespace,
    )
    raw_files = validated_manifest["files"]
    assert isinstance(raw_files, list)
    files = [entry for entry in raw_files if isinstance(entry, dict)]

    file_entry_by_role: dict[str, dict[str, object]] = {}
    for entry in files:
        database_role = entry["database_role"]
        assert isinstance(database_role, str)
        file_entry_by_role[database_role] = entry

    database_path.parent.mkdir(parents=True, exist_ok=True)

    with _BACKUP_LOCK:
        with tempfile.TemporaryDirectory(prefix="metalist-restore-") as temp_directory:
            temp_directory_path = Path(temp_directory)
            with tarfile.open(backup_path, mode="r:gz") as archive_handle:
                notes_entry = file_entry_by_role[_DATABASE_ROLE_NOTES]
                notes_archive_name = notes_entry["archive_name"]
                assert isinstance(notes_archive_name, str)
                notes_temp_path = temp_directory_path / notes_archive_name
                _copy_file_from_archive(
                    archive_handle,
                    archive_name=notes_archive_name,
                    target_path=notes_temp_path,
                )

                _validate_staged_database(notes_temp_path)
                file_database_path = _resolve_related_file_database_path(database_path)
                file_temp_path = temp_directory_path / 'staged-files.sqlite'
                if _DATABASE_ROLE_FILES in file_entry_by_role:
                    file_entry = file_entry_by_role[_DATABASE_ROLE_FILES]
                    file_archive_name = file_entry["archive_name"]
                    assert isinstance(file_archive_name, str)
                    _copy_file_from_archive(
                        archive_handle,
                        archive_name=file_archive_name,
                        target_path=file_temp_path,
                    )
                    _validate_staged_database(file_temp_path)
                else:
                    _reset_file_database_to_empty(file_temp_path)
                _copy_database(notes_temp_path, database_path)
                _checkpoint_database(database_path)
                _copy_database(file_temp_path, file_database_path)
                _checkpoint_database(file_database_path)
        _rewrite_launch_profile_namespace(
            database_path=database_path,
            source_namespace=expected_namespace,
            target_namespace=target_namespace,
        )


def _validate_staged_database(path: Path) -> None:
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)) as connection:
        if connection.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            raise RuntimeError('Restored database failed its integrity check')
        version = connection.execute('PRAGMA user_version').fetchone()[0]
        if version > CURRENT_DATABASE_VERSION:
            raise RuntimeError('Restored database is newer than this application')


def _restore_legacy_backup_to_paths(backup_path: Path, database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with _BACKUP_LOCK:
        with tempfile.TemporaryDirectory(prefix="metalist-restore-") as directory:
            notes_stage = Path(directory) / 'notes.sqlite'
            files_stage = Path(directory) / 'files.sqlite'
            _copy_immutable_database_source(backup_path, notes_stage)
            _validate_staged_database(notes_stage)
            file_source = _resolve_related_file_backup_path(
                backup_path.parent, backup_path.name, database_path=database_path,
            )
            if file_source.exists():
                _copy_immutable_database_source(file_source, files_stage)
                _validate_staged_database(files_stage)
            else:
                _reset_file_database_to_empty(files_stage)
            _copy_database(notes_stage, database_path)
            _copy_database(files_stage, _resolve_related_file_database_path(database_path))



def resolve_live_database_path() -> Path:
    if SafeSession._use_memory:  # type: ignore[attr-defined]
        raise RuntimeError("Backups are unavailable when using the in-memory database")

    db_path = SafeSession._db_path  # type: ignore[attr-defined]
    if not isinstance(db_path, Path):
        raise TypeError(f"SafeSession._db_path must be a Path, got {type(db_path)}")
    return db_path


def resolve_backup_directory_for_database(database_path: Path) -> Path:
    if not isinstance(database_path, Path):
        raise TypeError(f"database_path must be a Path, got {type(database_path)}")
    if database_path.name == "":
        raise ValueError("database_path must be a file path")
    return database_path.parent / "backups"


def list_backups_in_directory(
    backup_directory: Path,
    *,
    database_path: Path | None,
) -> list[BackupFileInfo]:
    if not isinstance(backup_directory, Path):
        raise TypeError(f"backup_directory must be a Path, got {type(backup_directory)}")
    if not backup_directory.exists():
        return []
    if not backup_directory.is_dir():
        raise ValueError(f"backup_directory is not a directory: {backup_directory}")

    expected_namespace = None
    expected_database_name = None
    if database_path is not None:
        expected_namespace = _derive_namespace_name(database_path)
        expected_database_name = database_path.name

    candidates = list(backup_directory.iterdir())
    candidates.sort(key=lambda candidate: candidate.stat().st_mtime, reverse=True)

    entries: list[BackupFileInfo] = []
    for candidate in candidates:
        if not candidate.is_file():
            continue

        archive_match = _match_archive_backup_filename(candidate.name)
        if archive_match is not None:
            if expected_namespace is not None and archive_match.group("namespace") != expected_namespace:
                continue
            entries.append(_stat_to_backup_info(candidate))
            continue

        legacy_match = _match_legacy_primary_backup_filename(candidate.name)
        if legacy_match is None:
            continue
        if expected_database_name is not None and legacy_match.group("database_name") != expected_database_name:
            continue
        entries.append(_stat_to_backup_info(candidate))

    return entries


def create_timestamped_backup_for_paths(
    database_path: Path,
    backup_directory: Path,
) -> BackupFileInfo:
    return _create_archive_backup_for_paths(database_path, backup_directory)


def _restore_source_paths(*, backup_path: Path, database_path: Path) -> tuple[Path, ...]:
    if _is_archive_backup_filename(backup_path.name):
        return (backup_path,)
    if not _is_legacy_primary_backup_filename(backup_path.name):
        raise ValueError(f"Unsupported backup file: {backup_path.name}")

    source_paths = [backup_path]
    related_file_path = _resolve_related_file_backup_path(
        backup_path.parent,
        backup_path.name,
        database_path=database_path,
    )
    if related_file_path.exists():
        source_paths.append(related_file_path)
    related_search_history_path = backup_path.parent / _derive_search_history_backup_filename(
        filename=backup_path.name,
        database_path=database_path,
    )
    if related_search_history_path.exists():
        source_paths.append(related_search_history_path)
    return tuple(source_paths)


def _restore_backup_to_paths(
    backup_path: Path,
    database_path: Path,
    *,
    source_namespace: str | None,
) -> None:
    if not isinstance(backup_path, Path):
        raise TypeError(f"backup_path must be a Path, got {type(backup_path)}")
    if not isinstance(database_path, Path):
        raise TypeError(f"database_path must be a Path, got {type(database_path)}")
    if not backup_path.exists():
        raise FileNotFoundError(f"Backup file not found: {backup_path}")
    if not backup_path.is_file():
        raise ValueError(f"Backup path is not a file: {backup_path}")
    if backup_path.resolve() == database_path.resolve():
        raise ValueError("Backup source and live database destination must differ")

    immutable_source_paths = _restore_source_paths(
        backup_path=backup_path,
        database_path=database_path,
    )
    source_hashes = [
        (source_path, _sha256_for_file(source_path))
        for source_path in immutable_source_paths
    ]
    with recoverable_database_change(database_path):
        try:
            if _is_archive_backup_filename(backup_path.name):
                _restore_archive_backup_to_paths(
                    backup_path,
                    database_path,
                    source_namespace=source_namespace,
                )
            elif _is_legacy_primary_backup_filename(backup_path.name):
                _restore_legacy_backup_to_paths(backup_path, database_path)
            else:
                raise ValueError(f"Unsupported backup file: {backup_path.name}")
        finally:
            for source_path, expected_hash in source_hashes:
                if not source_path.exists():
                    raise RuntimeError(f"Restore source disappeared during restore: {source_path}")
                actual_hash = _sha256_for_file(source_path)
                if actual_hash != expected_hash:
                    raise RuntimeError(f"Restore source was modified during restore: {source_path}")


def restore_backup_to_paths(backup_path: Path, database_path: Path) -> None:
    _restore_backup_to_paths(
        backup_path,
        database_path,
        source_namespace=None,
    )


def restore_backup_to_paths_from_namespace(
    backup_path: Path,
    database_path: Path,
    *,
    source_namespace: str,
) -> None:
    if not isinstance(source_namespace, str) or source_namespace == "":
        raise ValueError("source_namespace must be a non-empty string")
    _restore_backup_to_paths(
        backup_path,
        database_path,
        source_namespace=source_namespace,
    )


def create_timestamped_backup() -> BackupFileInfo:
    database_path = resolve_live_database_path()
    backup_directory = resolve_backup_directory_for_database(database_path)
    return create_timestamped_backup_for_paths(database_path, backup_directory)


def list_backups() -> list[BackupFileInfo]:
    database_path = resolve_live_database_path()
    backup_directory = resolve_backup_directory_for_database(database_path)
    return list_backups_in_directory(backup_directory, database_path=database_path)


def delete_oldest_backups_in_directory(
    backup_directory: Path,
    count: int,
    *,
    database_path: Path | None,
) -> list[BackupFileInfo]:
    if not isinstance(backup_directory, Path):
        raise TypeError(f"backup_directory must be a Path, got {type(backup_directory)}")
    if not isinstance(count, int):
        raise TypeError(f"count must be an int, got {type(count)}")
    if count <= 0:
        raise ValueError("count must be greater than zero")
    if not backup_directory.exists():
        return []
    if not backup_directory.is_dir():
        raise ValueError(f"backup_directory is not a directory: {backup_directory}")

    with _BACKUP_LOCK:
        backups_newest_first = list_backups_in_directory(backup_directory, database_path=database_path)
        backups_oldest_first = list(reversed(backups_newest_first))
        backups_to_delete = backups_oldest_first[:count]
        deleted_backups: list[BackupFileInfo] = []

        for backup in backups_to_delete:
            backup_path = backup_directory / backup.filename
            if not backup_path.exists():
                raise FileNotFoundError(f"Backup file not found: {backup_path}")
            if not backup_path.is_file():
                raise ValueError(f"Backup path is not a file: {backup_path}")
            backup_path.unlink()

            if _is_archive_backup_filename(backup.filename):
                deleted_backups.append(backup)
                continue

            if database_path is None:
                related_file_backup_filename = _derive_any_file_backup_filename(backup.filename)
            else:
                related_file_backup_filename = _derive_file_backup_filename(
                    filename=backup.filename,
                    database_path=database_path,
                )
            related_file_backup_path = backup_directory / related_file_backup_filename
            if related_file_backup_path.exists():
                if not related_file_backup_path.is_file():
                    raise ValueError(f"Backup path is not a file: {related_file_backup_path}")
                related_file_backup_path.unlink()

            if database_path is None:
                related_search_history_backup_filename = _derive_any_search_history_backup_filename(
                    backup.filename
                )
            else:
                related_search_history_backup_filename = _derive_search_history_backup_filename(
                    filename=backup.filename,
                    database_path=database_path,
                )
            related_search_history_backup_path = backup_directory / related_search_history_backup_filename
            if related_search_history_backup_path.exists():
                if not related_search_history_backup_path.is_file():
                    raise ValueError(f"Backup path is not a file: {related_search_history_backup_path}")
                related_search_history_backup_path.unlink()

            deleted_backups.append(backup)

        return deleted_backups


def delete_oldest_backups(count: int) -> list[BackupFileInfo]:
    database_path = resolve_live_database_path()
    backup_directory = resolve_backup_directory_for_database(database_path)
    return delete_oldest_backups_in_directory(
        backup_directory,
        count,
        database_path=database_path,
    )


def resolve_backup_path_by_filename(filename: str) -> Path:
    database_path = resolve_live_database_path()
    backup_directory = resolve_backup_directory_for_database(database_path)

    if _is_archive_backup_filename(filename):
        validated_filename = _validate_archive_backup_filename(filename=filename, database_path=database_path)
    elif _is_legacy_primary_backup_filename(filename):
        validated_filename = _validate_legacy_backup_filename(filename=filename, database_path=database_path)
    else:
        raise ValueError(f"Unsupported backup filename: {filename}")

    backup_path = backup_directory / validated_filename
    if not backup_path.exists():
        raise FileNotFoundError(f"Backup file not found: {validated_filename}")
    return backup_path


def restore_backup(filename: str) -> BackupFileInfo:
    backup_path = resolve_backup_path_by_filename(filename)
    database_path = resolve_live_database_path()
    restore_backup_to_paths(backup_path, database_path)
    return _stat_to_backup_info(backup_path)
