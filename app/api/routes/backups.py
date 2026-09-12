from __future__ import annotations

import secrets
import shutil
import sqlite3
import subprocess
import sys
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from typing import Annotated
from pathlib import Path

from app.api.transactions import transactional_route
from app.config import ACTIVE_NAMESPACE
from app.config import KDF_ALGORITHM
from app.config import KDF_MAX_MEMORY_COST_KIB
from app.config import KDF_MAX_PARALLELISM
from app.config import KDF_MAX_TIME_COST
from app.config import KDF_MIN_MEMORY_COST_KIB
from app.config import KDF_MIN_PARALLELISM
from app.config import KDF_MIN_TIME_COST
from app.config import VAULT_VERSION
from app.db.schema import APP_SETTINGS_TABLE
from app.services.backup_service import (
    BackupLaunchProfile,
    create_timestamped_backup_for_paths,
    delete_oldest_backups_in_directory,
    list_backups_in_directory,
    parse_backup_namespace_from_filename,
    read_backup_launch_profile,
    restore_backup_to_paths,
    restore_backup_to_paths_from_namespace,
)
from app.server_runtime import NamespaceLaunchProfile
from app.server_runtime import _DEFAULT_HTTP_PORT
from app.server_runtime import load_all_namespace_launch_profiles
from app.server_runtime import load_namespace_launch_profile
from app.server_runtime import resolve_namespace_directory
from app.server_runtime import resolve_namespaced_database_path
from app.server_runtime import resolve_namespaces_directory
from app.server_runtime import save_namespace_launch_profile
from app.server_runtime import validate_namespace
from app.services.backup_settings_service import (
    load_backup_settings,
    update_backup_settings,
)
from app.api.request_auth import get_request_auth_token
from app.services.tokens import token_service
from app.services.maintenance_mode import maintenance_service
from app.services.namespace_switcher import stop_namespace_for_restore
from app.api.routes.auth import _reset_runtime_state_after_restore, _schedule_server_restart_after_restore
from app.services.encryption import EncryptionService


router = APIRouter(prefix="/backup", tags=["backup2"])
_FOLDER_PATH_REQUIRED_MESSAGE = "Folder backups require an absolute folder path."


class BackupSettingsResponse(BaseModel):
    folder_path: str
    selected_namespaces: list[str]
    available_namespaces: list[str]
    retention_count: int


class BackupSettingsUpdateRequest(BaseModel):
    folder_path: str
    selected_namespaces: list[str] = Field(..., min_length=1)
    retention_count: int = Field(..., gt=0)


class BackupFolderPickResponse(BaseModel):
    selected: bool
    folder_path: str


class BackupListEntryResponse(BaseModel):
    backup_id: str
    source: str
    filename: str
    namespace: str
    created_at: str
    size_bytes: int


class BackupListResponse(BaseModel):
    backups: list[BackupListEntryResponse]


class BackupRunDestinationResponse(BaseModel):
    namespace: str
    destination: str
    success: bool
    created_filename: str
    size_bytes: int
    deleted_count: int
    remaining_count: int
    message: str


class BackupRunResponse(BaseModel):
    results: list[BackupRunDestinationResponse]


class BackupRestoreRequest(BaseModel):
    backup_id: str
    source: str
    backup_filename: str
    backup_namespace: str
    target_namespace: str


class BackupRestoreLaunchProfileRequest(BaseModel):
    port: int
    https_port: int | None


class BackupRestoreLaunchProfileResponse(BaseModel):
    port: int
    https_port: int | None


class BackupRestorePreflightResponse(BaseModel):
    backup_namespace: str
    target_namespace: str
    same_namespace: bool
    target_is_active: bool
    target_exists: bool
    target_requires_password: bool
    restored_profile: BackupRestoreLaunchProfileResponse | None
    suggested_profile: BackupRestoreLaunchProfileResponse | None
    port_conflicts: list[str]


class BackupRestoreImportRequest(BaseModel):
    backup_id: str
    source: str
    backup_filename: str
    backup_namespace: str
    target_namespace: str
    overwrite_existing_target: bool
    target_password: str
    launch_profile: BackupRestoreLaunchProfileRequest


class BackupRestoreResponse(BaseModel):
    backup_id: str
    source: str
    backup_filename: str
    backup_namespace: str
    target_namespace: str
    active_namespace_restarted: bool
    open_namespace_suggested: bool
    message: str


def _require_tab_id(
    x_metalist_tab_id: Annotated[str, Header(alias="X-Metalist-Tab-Id")],
) -> str:
    return x_metalist_tab_id


def _verify_token(
    request: Request,
    tab_id: Annotated[str, Depends(_require_tab_id)],
) -> str | None:
    token = get_request_auth_token(request)
    if token is None:
        return None
    if token_service.verify_token_for_tab(token, tab_id):
        return token
    return None


def _require_auth(token: Annotated[str | None, Depends(_verify_token)]) -> str:
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    return token


def _serialize_settings_response(settings: dict[str, object]) -> BackupSettingsResponse:
    folder_path = settings["folder_path"]
    if not isinstance(folder_path, str):
        raise RuntimeError("backup settings folder_path must be a string")
    selected_namespaces = settings["selected_namespaces"]
    if not isinstance(selected_namespaces, list):
        raise RuntimeError("backup settings selected_namespaces must be a list")
    normalized_selected_namespaces: list[str] = []
    for selected_namespace in selected_namespaces:
        if not isinstance(selected_namespace, str):
            raise RuntimeError("backup settings selected_namespaces entries must be strings")
        normalized_selected_namespaces.append(validate_namespace(namespace=selected_namespace))
    available_namespaces = _list_available_namespaces()
    available_namespace_set = set(available_namespaces)
    existing_selected_namespaces = [
        namespace
        for namespace in normalized_selected_namespaces
        if namespace in available_namespace_set
    ]
    return BackupSettingsResponse(
        folder_path=folder_path,
        selected_namespaces=_order_namespaces(namespaces=existing_selected_namespaces),
        available_namespaces=available_namespaces,
        retention_count=int(settings["retention_count"]),
    )


def _serialize_backup_entry(
    *,
    backup_id: str,
    source: str,
    filename: str,
    namespace: str,
    created_at: str,
    size_bytes: int,
) -> BackupListEntryResponse:
    return BackupListEntryResponse(
        backup_id=backup_id,
        source=source,
        filename=filename,
        namespace=namespace,
        created_at=created_at,
        size_bytes=size_bytes,
    )


def _normalize_folder_backup_path(*, folder_path: str) -> Path:
    if not isinstance(folder_path, str):
        raise TypeError("folder_path must be a string")
    stripped_folder_path = folder_path.strip()
    if stripped_folder_path == "":
        raise HTTPException(status_code=400, detail=_FOLDER_PATH_REQUIRED_MESSAGE)
    normalized_path = Path(stripped_folder_path).expanduser()
    if not normalized_path.is_absolute():
        raise HTTPException(status_code=400, detail=_FOLDER_PATH_REQUIRED_MESSAGE)
    return normalized_path


def _prepare_folder_backup_directory_for_settings(*, folder_path: str) -> str:
    if not isinstance(folder_path, str):
        raise TypeError("folder_path must be a string")
    folder_directory = _normalize_folder_backup_path(folder_path=folder_path)
    folder_directory.mkdir(parents=True, exist_ok=True)
    if not folder_directory.is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"Folder backup path is not a directory: {folder_directory}",
        )
    return str(folder_directory)


def _order_namespaces(*, namespaces: list[str]) -> list[str]:
    if not isinstance(namespaces, list):
        raise TypeError("namespaces must be a list")
    normalized_namespaces: list[str] = []
    seen_namespaces: set[str] = set()
    for namespace in namespaces:
        if not isinstance(namespace, str):
            raise TypeError("namespaces entries must be strings")
        normalized_namespace = validate_namespace(namespace=namespace)
        if normalized_namespace in seen_namespaces:
            continue
        seen_namespaces.add(normalized_namespace)
        normalized_namespaces.append(normalized_namespace)
    normalized_namespaces.sort()
    if "default" in normalized_namespaces:
        normalized_namespaces.remove("default")
        normalized_namespaces.insert(0, "default")
    return normalized_namespaces


def _list_available_namespaces() -> list[str]:
    discovered_namespaces: list[str] = []
    namespaces_directory = resolve_namespaces_directory()
    if namespaces_directory.exists():
        if not namespaces_directory.is_dir():
            raise RuntimeError(f"namespaces directory is not a directory: {namespaces_directory}")
        for child in namespaces_directory.iterdir():
            if not child.is_dir():
                continue
            namespace = validate_namespace(namespace=child.name)
            database_path = resolve_namespaced_database_path(namespace=namespace)
            if database_path.is_file():
                discovered_namespaces.append(namespace)
    return _order_namespaces(namespaces=discovered_namespaces)


def _normalize_selected_namespaces(*, selected_namespaces: list[str]) -> list[str]:
    if not isinstance(selected_namespaces, list):
        raise TypeError("selected_namespaces must be a list")
    normalized_selected_namespaces = _order_namespaces(namespaces=selected_namespaces)
    if len(normalized_selected_namespaces) == 0:
        raise HTTPException(status_code=400, detail="Select at least one namespace to back up")
    return normalized_selected_namespaces


def _require_existing_selected_namespaces(*, selected_namespaces: list[str]) -> list[str]:
    normalized_selected_namespaces = _normalize_selected_namespaces(selected_namespaces=selected_namespaces)
    for namespace in normalized_selected_namespaces:
        database_path = resolve_namespaced_database_path(namespace=namespace)
        if not database_path.is_file():
            raise HTTPException(status_code=400, detail=f"Selected namespace has no database yet: {namespace}")
    return normalized_selected_namespaces


def _filter_deleted_selected_namespaces(*, selected_namespaces: list[str]) -> list[str]:
    normalized_selected_namespaces = _normalize_selected_namespaces(selected_namespaces=selected_namespaces)
    existing_selected_namespaces: list[str] = []
    for namespace in normalized_selected_namespaces:
        database_path = resolve_namespaced_database_path(namespace=namespace)
        if database_path.is_file():
            existing_selected_namespaces.append(namespace)
    if len(existing_selected_namespaces) == 0:
        raise HTTPException(
            status_code=400,
            detail="None of the selected backup namespaces still exist",
        )
    return existing_selected_namespaces


def _run_native_folder_picker_command(*, command: list[str]) -> str | None:
    if not isinstance(command, list) or len(command) == 0:
        raise TypeError("command must be a non-empty list")
    completed = subprocess.run(
        command,
        capture_output=True,
        check=False,
        text=True,
    )
    stdout = completed.stdout.strip()
    stderr = completed.stderr.strip()
    if completed.returncode == 0:
        if stdout == "":
            return None
        return stdout
    if completed.returncode == 1 and (stderr == "" or "User canceled" in stderr or "(-128)" in stderr):
        return None
    raise RuntimeError(
        f"Native folder picker failed: exit={completed.returncode} stdout={stdout!r} stderr={stderr!r}"
    )


def _pick_backup_folder_path() -> str | None:
    if sys.platform == "darwin":
        osascript_path = shutil.which("osascript")
        if osascript_path is None:
            raise RuntimeError("`osascript` is required for the macOS folder picker")
        return _run_native_folder_picker_command(
            command=[
                osascript_path,
                "-e",
                'POSIX path of (choose folder with prompt "Choose a backup folder for MetaList")',
            ]
        )

    if sys.platform.startswith("linux"):
        zenity_path = shutil.which("zenity")
        if zenity_path is not None:
            return _run_native_folder_picker_command(
                command=[
                    zenity_path,
                    "--file-selection",
                    "--directory",
                    "--title=Choose a backup folder for MetaList",
                ]
            )
        kdialog_path = shutil.which("kdialog")
        if kdialog_path is not None:
            return _run_native_folder_picker_command(
                command=[
                    kdialog_path,
                    "--getexistingdirectory",
                    "",
                    "--title",
                    "Choose a backup folder for MetaList",
                ]
            )
        raise RuntimeError("No supported Linux folder picker was found (`zenity` or `kdialog`)")

    if sys.platform == "win32":
        powershell_path = shutil.which("powershell")
        if powershell_path is None:
            powershell_path = shutil.which("pwsh")
        if powershell_path is None:
            raise RuntimeError("PowerShell is required for the Windows folder picker")
        script = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; "
            "$dialog.Description = 'Choose a backup folder for MetaList'; "
            "$dialog.ShowNewFolderButton = $true; "
            "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { "
            "Write-Output $dialog.SelectedPath; exit 0 }; "
            "exit 1"
        )
        return _run_native_folder_picker_command(
            command=[powershell_path, "-NoProfile", "-Command", script]
        )

    raise RuntimeError(f"Native folder picker is not supported on platform: {sys.platform}")


def _folder_backup_id(*, namespace: str, filename: str) -> str:
    return f"folder::{namespace}::{filename}"


def _parse_folder_backup_id(backup_id: str) -> tuple[str, str]:
    if not isinstance(backup_id, str) or backup_id == "":
        raise HTTPException(status_code=400, detail="backup_id must be a non-empty string")
    parts = backup_id.split("::", 2)
    if len(parts) != 3 or parts[0] != "folder":
        raise HTTPException(status_code=400, detail="Invalid folder backup_id")
    namespace = validate_namespace(namespace=parts[1])
    filename = parts[2]
    if filename == "":
        raise HTTPException(status_code=400, detail="Invalid folder backup_id filename")
    return namespace, filename


def _backup_profile_ports(*, profile: BackupLaunchProfile) -> list[tuple[str, int]]:
    service_pairs = [
        ("HTTP", profile.port),
        ("HTTPS", profile.https_port),
    ]
    ports: list[tuple[str, int]] = []
    for service, port in service_pairs:
        if port is None:
            continue
        ports.append((service, port))
    return ports


def _runtime_profile_ports(*, profile: NamespaceLaunchProfile) -> list[tuple[str, int]]:
    service_pairs = [
        ("HTTP", profile.port),
        ("HTTPS", profile.https_port),
    ]
    ports: list[tuple[str, int]] = []
    for service, port in service_pairs:
        if port is None:
            continue
        ports.append((service, port))
    return ports


def _restore_target_exists(*, target_namespace: str) -> bool:
    target_directory = resolve_namespace_directory(namespace=target_namespace)
    target_database_path = resolve_namespaced_database_path(namespace=target_namespace)
    if target_directory.exists():
        return True
    if target_database_path.exists():
        return True
    return False


def _read_target_auth_settings(*, target_namespace: str) -> dict[str, object] | None:
    target_database_path = resolve_namespaced_database_path(namespace=target_namespace)
    if not target_database_path.exists():
        return None
    if not target_database_path.is_file():
        raise RuntimeError(f"Target namespace database path is not a file: {target_database_path}")

    connection = sqlite3.connect(target_database_path)
    connection.row_factory = sqlite3.Row
    try:
        table_row = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?",
            ("table", APP_SETTINGS_TABLE),
        ).fetchone()
        if table_row is None:
            raise RuntimeError(f"Target namespace database has no {APP_SETTINGS_TABLE} table: {target_namespace}")
        row = connection.execute(
            f"""
            SELECT
                auth_verifier,
                auth_salt,
                auth_iterations,
                kek_iterations,
                vault_version,
                kdf_algorithm,
                kdf_memory_cost_kib,
                kdf_parallelism,
                encryption_enabled
            FROM {APP_SETTINGS_TABLE}
            WHERE id = 1
            """
        ).fetchone()
        if row is None:
            raise RuntimeError(f"Target namespace database has no app_settings row: {target_namespace}")
        return {
            "auth_verifier": row["auth_verifier"],
            "auth_salt": row["auth_salt"],
            "auth_iterations": row["auth_iterations"],
            "kek_iterations": row["kek_iterations"],
            "vault_version": row["vault_version"],
            "kdf_algorithm": row["kdf_algorithm"],
            "kdf_memory_cost_kib": row["kdf_memory_cost_kib"],
            "kdf_parallelism": row["kdf_parallelism"],
            "encryption_enabled": row["encryption_enabled"],
        }
    finally:
        connection.close()


def _target_auth_settings_have_password(*, settings: dict[str, object] | None) -> bool:
    if settings is None:
        return False
    encryption_enabled = settings["encryption_enabled"]
    if encryption_enabled not in (0, 1, False, True):
        raise RuntimeError(f"Invalid encryption_enabled value in target namespace: {encryption_enabled!r}")
    if not bool(encryption_enabled):
        return False
    _assert_supported_target_vault_profile(settings=settings)
    if settings["auth_verifier"] is None:
        raise RuntimeError("Target namespace encryption is enabled but auth_verifier is missing")
    if settings["auth_salt"] is None:
        raise RuntimeError("Target namespace auth_verifier is set but auth_salt is NULL")
    if settings["auth_iterations"] is None:
        raise RuntimeError("Target namespace auth_verifier is set but auth_iterations is NULL")
    return True


def _target_namespace_requires_password(*, target_namespace: str) -> bool:
    settings = _read_target_auth_settings(target_namespace=target_namespace)
    return _target_auth_settings_have_password(settings=settings)


def _assert_supported_target_vault_profile(*, settings: dict[str, object]) -> None:
    vault_version = settings["vault_version"]
    if vault_version is None:
        raise RuntimeError("Target namespace encryption is enabled but vault_version is NULL")
    if vault_version != VAULT_VERSION:
        raise RuntimeError(f"Unsupported target namespace vault version: {vault_version}")
    kdf_algorithm = settings["kdf_algorithm"]
    if kdf_algorithm is None:
        raise RuntimeError("Target namespace encryption is enabled but kdf_algorithm is NULL")
    if kdf_algorithm != KDF_ALGORITHM:
        raise RuntimeError(f"Unsupported target namespace kdf_algorithm: {kdf_algorithm}")
    auth_iterations = settings["auth_iterations"]
    if auth_iterations is None:
        raise RuntimeError("Target namespace encryption is enabled but auth_iterations is NULL")
    if not isinstance(auth_iterations, int):
        raise RuntimeError(f"Target namespace auth_iterations is not an integer: {auth_iterations!r}")
    if not (KDF_MIN_TIME_COST <= auth_iterations <= KDF_MAX_TIME_COST):
        raise RuntimeError(f"Target namespace auth_iterations out of range: {auth_iterations}")
    kek_iterations = settings["kek_iterations"]
    if kek_iterations is None:
        raise RuntimeError("Target namespace encryption is enabled but kek_iterations is NULL")
    if not isinstance(kek_iterations, int):
        raise RuntimeError(f"Target namespace kek_iterations is not an integer: {kek_iterations!r}")
    if not (KDF_MIN_TIME_COST <= kek_iterations <= KDF_MAX_TIME_COST):
        raise RuntimeError(f"Target namespace kek_iterations out of range: {kek_iterations}")
    memory_cost_kib = settings["kdf_memory_cost_kib"]
    if memory_cost_kib is None:
        raise RuntimeError("Target namespace encryption is enabled but kdf_memory_cost_kib is NULL")
    if not isinstance(memory_cost_kib, int):
        raise RuntimeError(f"Target namespace kdf_memory_cost_kib is not an integer: {memory_cost_kib!r}")
    if not (KDF_MIN_MEMORY_COST_KIB <= memory_cost_kib <= KDF_MAX_MEMORY_COST_KIB):
        raise RuntimeError(f"Target namespace kdf_memory_cost_kib out of range: {memory_cost_kib}")
    parallelism = settings["kdf_parallelism"]
    if parallelism is None:
        raise RuntimeError("Target namespace encryption is enabled but kdf_parallelism is NULL")
    if not isinstance(parallelism, int):
        raise RuntimeError(f"Target namespace kdf_parallelism is not an integer: {parallelism!r}")
    if not (KDF_MIN_PARALLELISM <= parallelism <= KDF_MAX_PARALLELISM):
        raise RuntimeError(f"Target namespace kdf_parallelism out of range: {parallelism}")


def _verify_target_namespace_password(*, target_namespace: str, password: str) -> None:
    if not isinstance(password, str):
        raise TypeError("target password must be a string")
    settings = _read_target_auth_settings(target_namespace=target_namespace)
    if not _target_auth_settings_have_password(settings=settings):
        return
    if password == "":
        raise HTTPException(status_code=400, detail="Target namespace password is required")

    assert settings is not None
    auth_salt = settings["auth_salt"]
    auth_iterations = settings["auth_iterations"]
    memory_cost_kib = settings["kdf_memory_cost_kib"]
    parallelism = settings["kdf_parallelism"]
    auth_verifier = settings["auth_verifier"]
    if not isinstance(auth_salt, bytes):
        raise RuntimeError("Target namespace auth_salt is not bytes")
    if not isinstance(auth_iterations, int):
        raise RuntimeError("Target namespace auth_iterations is not an integer")
    if not isinstance(memory_cost_kib, int):
        raise RuntimeError("Target namespace kdf_memory_cost_kib is not an integer")
    if not isinstance(parallelism, int):
        raise RuntimeError("Target namespace kdf_parallelism is not an integer")
    if not isinstance(auth_verifier, str):
        raise RuntimeError("Target namespace auth_verifier is not a string")

    candidate = EncryptionService().derive_master_key(
        password,
        auth_salt,
        auth_iterations,
        memory_cost_kib,
        parallelism,
    ).hex()
    if not secrets.compare_digest(candidate, auth_verifier):
        raise HTTPException(status_code=403, detail="Target namespace password is incorrect")


def _collect_import_profile_port_conflicts(
    *,
    target_namespace: str,
    launch_profile: BackupLaunchProfile | None,
) -> list[str]:
    if launch_profile is None:
        return []
    conflicts: list[str] = []
    existing_profiles = load_all_namespace_launch_profiles()
    occupied_ports: dict[int, tuple[str, str]] = {}
    for existing_profile in existing_profiles:
        if existing_profile.namespace == target_namespace:
            continue
        for service, port in _runtime_profile_ports(profile=existing_profile):
            occupied_ports[port] = (existing_profile.namespace, service)
    for service, port in _backup_profile_ports(profile=launch_profile):
        if port not in occupied_ports:
            continue
        conflict_namespace, conflict_service = occupied_ports[port]
        conflicts.append(
            f"{service} port {port} conflicts with {conflict_service} port reserved for namespace {conflict_namespace}"
        )
    return conflicts


def _assert_import_profile_ports_do_not_conflict(
    *,
    target_namespace: str,
    launch_profile: BackupLaunchProfile | None,
) -> None:
    conflicts = _collect_import_profile_port_conflicts(
        target_namespace=target_namespace,
        launch_profile=launch_profile,
    )
    if len(conflicts) == 0:
        return
    first_conflict = conflicts[0]
    raise HTTPException(
        status_code=409,
        detail=first_conflict.replace(" conflicts with ", " from backup conflicts with ", 1),
    )


def _next_available_port(*, start_port: int, occupied_ports: set[int]) -> int:
    port = start_port
    while port in occupied_ports:
        port += 1
    if port > 65535:
        raise HTTPException(
            status_code=409,
            detail=f"No available port found at or above {start_port}",
        )
    return port


def _build_occupied_import_ports(*, target_namespace: str) -> set[int]:
    occupied_ports: set[int] = set()
    for existing_profile in load_all_namespace_launch_profiles():
        if existing_profile.namespace == target_namespace:
            continue
        for _, port in _runtime_profile_ports(profile=existing_profile):
            occupied_ports.add(port)
    return occupied_ports


def _suggest_import_launch_profile(
    *,
    target_namespace: str,
    restored_profile: BackupLaunchProfile | None,
) -> BackupRestoreLaunchProfileResponse:
    occupied_ports = _build_occupied_import_ports(target_namespace=target_namespace)
    if restored_profile is None or restored_profile.port is None:
        http_start = _DEFAULT_HTTP_PORT
    else:
        http_start = restored_profile.port
    port = _next_available_port(start_port=http_start, occupied_ports=occupied_ports)
    occupied_ports.add(port)

    https_port = None
    if restored_profile is not None and restored_profile.https_port is not None:
        https_port = _next_available_port(
            start_port=restored_profile.https_port,
            occupied_ports=occupied_ports,
        )
        occupied_ports.add(https_port)
    elif restored_profile is None:
        https_port = None
    elif restored_profile.https_port is None:
        https_port = None

    return BackupRestoreLaunchProfileResponse(
        port=port,
        https_port=https_port,
    )


def _response_profile_from_backup_profile(
    *,
    profile: BackupLaunchProfile | None,
) -> BackupRestoreLaunchProfileResponse | None:
    if profile is None:
        return None
    if profile.port is None:
        return None
    return BackupRestoreLaunchProfileResponse(
        port=profile.port,
        https_port=profile.https_port,
    )


def _required_existing_target_launch_profile(*, target_namespace: str) -> BackupLaunchProfile:
    profile = load_namespace_launch_profile(namespace=target_namespace)
    if profile is None:
        raise RuntimeError(f"Existing target namespace has no saved launch profile: {target_namespace}")
    if profile.port is None:
        raise RuntimeError(f"Existing target namespace has no saved HTTP port: {target_namespace}")
    return BackupLaunchProfile(
        namespace=target_namespace,
        port=profile.port,
        https_port=profile.https_port,
        mcp_port=profile.mcp_port,
    )


def _resolve_same_name_restore_launch_profile(
    *,
    backup_path: Path,
    target_namespace: str,
    target_exists: bool,
) -> BackupLaunchProfile:
    if target_exists:
        return _required_existing_target_launch_profile(
            target_namespace=target_namespace,
        )
    restored_profile = read_backup_launch_profile(
        backup_path,
        expected_namespace=target_namespace,
    )
    suggested_profile = _suggest_import_launch_profile(
        target_namespace=target_namespace,
        restored_profile=restored_profile,
    )
    return BackupLaunchProfile(
        namespace=target_namespace,
        port=suggested_profile.port,
        https_port=suggested_profile.https_port,
        mcp_port=None,
    )


def _backup_profile_from_request(
    *,
    namespace: str,
    profile: BackupRestoreLaunchProfileRequest,
) -> BackupLaunchProfile:
    return BackupLaunchProfile(
        namespace=namespace,
        port=profile.port,
        https_port=profile.https_port,
        mcp_port=None,
    )


def _assert_import_profile_has_no_internal_overlap(*, profile: BackupLaunchProfile) -> None:
    seen_ports: dict[int, str] = {}
    for service, port in _backup_profile_ports(profile=profile):
        if port not in seen_ports:
            seen_ports[port] = service
            continue
        other_service = seen_ports[port]
        raise HTTPException(
            status_code=400,
            detail=f"{service} port {port} conflicts with {other_service} port in the import profile",
        )


def _restore_import_to_target(
    *,
    backup_path: Path,
    target_database_path: Path,
    backup_namespace: str,
    target_namespace: str,
    launch_profile: BackupLaunchProfile,
) -> None:
    restore_backup_to_paths_from_namespace(
        backup_path,
        target_database_path,
        source_namespace=backup_namespace,
    )
    save_namespace_launch_profile(
        namespace=target_namespace,
        port=launch_profile.port,
        https_port=launch_profile.https_port,
        mcp_port=launch_profile.mcp_port,
    )


@router.get("/settings", response_model=BackupSettingsResponse)
def get_backup_settings(token: Annotated[str, Depends(_require_auth)]):
    settings = load_backup_settings(token=token)
    return _serialize_settings_response(settings)


@router.put("/settings", response_model=BackupSettingsResponse)
@transactional_route
def put_backup_settings(
    payload: BackupSettingsUpdateRequest,
    token: Annotated[str, Depends(_require_auth)],
):
    normalized_folder_path = _prepare_folder_backup_directory_for_settings(
        folder_path=payload.folder_path,
    )
    normalized_selected_namespaces = _require_existing_selected_namespaces(
        selected_namespaces=payload.selected_namespaces,
    )
    settings = update_backup_settings(
        token=token,
        folder_path=normalized_folder_path,
        selected_namespaces=normalized_selected_namespaces,
        retention_count=payload.retention_count,
    )
    return _serialize_settings_response(settings)


@router.post("/folder/pick", response_model=BackupFolderPickResponse)
@transactional_route
def pick_backup_folder(token: Annotated[str, Depends(_require_auth)]):
    del token
    selected_folder_path = _pick_backup_folder_path()
    if selected_folder_path is None:
        return BackupFolderPickResponse(
            selected=False,
            folder_path="",
        )
    normalized_folder_path = str(_normalize_folder_backup_path(folder_path=selected_folder_path))
    return BackupFolderPickResponse(
        selected=True,
        folder_path=normalized_folder_path,
    )


@router.get("/list", response_model=BackupListResponse)
def list_backups(token: Annotated[str, Depends(_require_auth)]):
    backups: list[BackupListEntryResponse] = []
    settings = load_backup_settings(token=token)
    folder_path = settings["folder_path"]
    if not isinstance(folder_path, str):
        raise RuntimeError("backup settings folder_path must be a string")
    if folder_path != "":
        folder_directory = _normalize_folder_backup_path(folder_path=folder_path)
        folder_backups = list_backups_in_directory(folder_directory, database_path=None)
        for backup in folder_backups:
            backup_namespace = parse_backup_namespace_from_filename(backup.filename)
            backups.append(
                _serialize_backup_entry(
                    backup_id=_folder_backup_id(namespace=backup_namespace, filename=backup.filename),
                    source="folder",
                    filename=backup.filename,
                    namespace=backup_namespace,
                    created_at=backup.created_at,
                    size_bytes=backup.size_bytes,
                )
            )
    backups.sort(key=lambda entry: entry.created_at, reverse=True)
    return BackupListResponse(backups=backups)


@router.post("/run", response_model=BackupRunResponse)
@transactional_route
def run_backup(
    payload: BackupSettingsUpdateRequest,
    token: Annotated[str, Depends(_require_auth)],
):
    folder_path = _prepare_folder_backup_directory_for_settings(
        folder_path=payload.folder_path,
    )
    normalized_selected_namespaces = _filter_deleted_selected_namespaces(
        selected_namespaces=payload.selected_namespaces,
    )
    update_backup_settings(
        token=token,
        folder_path=folder_path,
        selected_namespaces=normalized_selected_namespaces,
        retention_count=payload.retention_count,
    )

    folder_directory = _normalize_folder_backup_path(folder_path=folder_path)
    folder_directory.mkdir(parents=True, exist_ok=True)
    if not folder_directory.is_dir():
        raise RuntimeError(f"Folder backup path is not a directory: {folder_directory}")

    results: list[BackupRunDestinationResponse] = []
    for namespace in normalized_selected_namespaces:
        database_path = resolve_namespaced_database_path(namespace=namespace)
        backup_info = create_timestamped_backup_for_paths(database_path, folder_directory)
        current_folder_backups = list_backups_in_directory(folder_directory, database_path=database_path)
        folder_delete_count = len(current_folder_backups) - payload.retention_count
        deleted_folder_count = 0
        if folder_delete_count > 0:
            deleted_folder_count = len(
                delete_oldest_backups_in_directory(
                    folder_directory,
                    folder_delete_count,
                    database_path=database_path,
                )
            )
        remaining_folder_backups = list_backups_in_directory(folder_directory, database_path=database_path)
        results.append(
            BackupRunDestinationResponse(
                namespace=namespace,
                destination="folder",
                success=True,
                created_filename=backup_info.filename,
                size_bytes=backup_info.size_bytes,
                deleted_count=deleted_folder_count,
                remaining_count=len(remaining_folder_backups),
                message=f"Folder backup completed: {folder_directory}",
            )
        )

    return BackupRunResponse(results=results)


@router.post("/restore/preflight", response_model=BackupRestorePreflightResponse)
@transactional_route
def restore_backup_preflight(
    payload: BackupRestoreRequest,
    token: Annotated[str, Depends(_require_auth)],
):
    if payload.source != "folder":
        raise HTTPException(status_code=400, detail="source must be folder")
    backup_namespace = validate_namespace(namespace=payload.backup_namespace)
    target_namespace = validate_namespace(namespace=payload.target_namespace)

    folder_namespace, folder_filename = _parse_folder_backup_id(payload.backup_id)
    if folder_namespace != backup_namespace:
        raise HTTPException(status_code=400, detail="folder backup namespace does not match payload")
    if folder_filename != payload.backup_filename:
        raise HTTPException(status_code=400, detail="folder backup filename does not match payload")
    settings = load_backup_settings(token=token)
    folder_path = settings["folder_path"]
    if not isinstance(folder_path, str):
        raise RuntimeError("backup settings folder_path must be a string")
    folder_directory = _normalize_folder_backup_path(folder_path=folder_path)
    backup_path = folder_directory / folder_filename
    if not backup_path.exists():
        raise HTTPException(status_code=404, detail=f"Backup not found: {folder_filename}")

    restored_profile = read_backup_launch_profile(
        backup_path,
        expected_namespace=backup_namespace,
    )
    target_exists = _restore_target_exists(target_namespace=target_namespace)
    suggested_profile = None
    port_conflicts: list[str] = []
    if target_exists:
        target_profile = _required_existing_target_launch_profile(
            target_namespace=target_namespace,
        )
        suggested_profile = _response_profile_from_backup_profile(profile=target_profile)
        assert suggested_profile is not None
    else:
        if restored_profile is not None:
            port_conflicts = _collect_import_profile_port_conflicts(
                target_namespace=target_namespace,
                launch_profile=restored_profile,
            )
        suggested_profile = _suggest_import_launch_profile(
            target_namespace=target_namespace,
            restored_profile=restored_profile,
        )

    return BackupRestorePreflightResponse(
        backup_namespace=backup_namespace,
        target_namespace=target_namespace,
        same_namespace=target_namespace == backup_namespace,
        target_is_active=target_namespace == ACTIVE_NAMESPACE,
        target_exists=target_exists,
        target_requires_password=_target_namespace_requires_password(target_namespace=target_namespace),
        restored_profile=_response_profile_from_backup_profile(profile=restored_profile),
        suggested_profile=suggested_profile,
        port_conflicts=port_conflicts,
    )


@router.post("/restore", response_model=BackupRestoreResponse)
@transactional_route
def restore_backup(
    payload: BackupRestoreRequest,
    token: Annotated[str, Depends(_require_auth)],
):
    if payload.source != "folder":
        raise HTTPException(status_code=400, detail="source must be folder")
    backup_namespace = validate_namespace(namespace=payload.backup_namespace)
    target_namespace = validate_namespace(namespace=payload.target_namespace)
    if target_namespace != backup_namespace:
        raise HTTPException(
            status_code=400,
            detail="Different-name restore must use /api2/backup/restore/import",
        )

    target_database_path = resolve_namespaced_database_path(namespace=target_namespace)
    active_namespace_restarted = False
    open_namespace_suggested = target_namespace != ACTIVE_NAMESPACE

    folder_namespace, folder_filename = _parse_folder_backup_id(payload.backup_id)
    if folder_namespace != backup_namespace:
        raise HTTPException(status_code=400, detail="folder backup namespace does not match payload")
    if folder_filename != payload.backup_filename:
        raise HTTPException(status_code=400, detail="folder backup filename does not match payload")
    settings = load_backup_settings(token=token)
    folder_path = settings["folder_path"]
    if not isinstance(folder_path, str):
        raise RuntimeError("backup settings folder_path must be a string")
    folder_directory = _normalize_folder_backup_path(folder_path=folder_path)
    backup_path = folder_directory / folder_filename
    if not backup_path.exists():
        raise HTTPException(status_code=404, detail=f"Backup not found: {folder_filename}")
    target_exists = _restore_target_exists(target_namespace=target_namespace)
    launch_profile = _resolve_same_name_restore_launch_profile(
        backup_path=backup_path,
        target_namespace=target_namespace,
        target_exists=target_exists,
    )
    if target_namespace == ACTIVE_NAMESPACE:
        maintenance_service.enter_maintenance("Restoring backup")
        try:
            restore_backup_to_paths(backup_path, target_database_path)
            save_namespace_launch_profile(
                namespace=target_namespace,
                port=launch_profile.port,
                https_port=launch_profile.https_port,
                mcp_port=launch_profile.mcp_port,
            )
            _reset_runtime_state_after_restore()
        finally:
            maintenance_service.exit_maintenance()
        _schedule_server_restart_after_restore(delay_seconds=0.5)
        active_namespace_restarted = True
        open_namespace_suggested = False
    else:
        stop_namespace_for_restore(namespace=target_namespace)
        restore_backup_to_paths(backup_path, target_database_path)
        save_namespace_launch_profile(
            namespace=target_namespace,
            port=launch_profile.port,
            https_port=launch_profile.https_port,
            mcp_port=launch_profile.mcp_port,
        )
    return BackupRestoreResponse(
        backup_id=payload.backup_id,
        source=payload.source,
        backup_filename=payload.backup_filename,
        backup_namespace=backup_namespace,
        target_namespace=target_namespace,
        active_namespace_restarted=active_namespace_restarted,
        open_namespace_suggested=open_namespace_suggested,
        message="Backup restored successfully",
    )


@router.post("/restore/import", response_model=BackupRestoreResponse)
@transactional_route
def import_backup(
    payload: BackupRestoreImportRequest,
    token: Annotated[str, Depends(_require_auth)],
):
    if payload.source != "folder":
        raise HTTPException(status_code=400, detail="source must be folder")
    backup_namespace = validate_namespace(namespace=payload.backup_namespace)
    target_namespace = validate_namespace(namespace=payload.target_namespace)
    if target_namespace == backup_namespace:
        raise HTTPException(status_code=400, detail="Same-name restore must use /api2/backup/restore")

    target_exists = _restore_target_exists(target_namespace=target_namespace)
    if target_exists and not payload.overwrite_existing_target:
        raise HTTPException(
            status_code=409,
            detail=f"Target namespace already exists: {target_namespace}",
        )
    if target_exists:
        _verify_target_namespace_password(
            target_namespace=target_namespace,
            password=payload.target_password,
        )

    target_database_path = resolve_namespaced_database_path(namespace=target_namespace)
    folder_namespace, folder_filename = _parse_folder_backup_id(payload.backup_id)
    if folder_namespace != backup_namespace:
        raise HTTPException(status_code=400, detail="folder backup namespace does not match payload")
    if folder_filename != payload.backup_filename:
        raise HTTPException(status_code=400, detail="folder backup filename does not match payload")
    settings = load_backup_settings(token=token)
    folder_path = settings["folder_path"]
    if not isinstance(folder_path, str):
        raise RuntimeError("backup settings folder_path must be a string")
    folder_directory = _normalize_folder_backup_path(folder_path=folder_path)
    backup_path = folder_directory / folder_filename
    if not backup_path.exists():
        raise HTTPException(status_code=404, detail=f"Backup not found: {folder_filename}")

    if target_exists:
        launch_profile = _required_existing_target_launch_profile(
            target_namespace=target_namespace,
        )
    else:
        launch_profile = _backup_profile_from_request(
            namespace=target_namespace,
            profile=payload.launch_profile,
        )
        _assert_import_profile_has_no_internal_overlap(profile=launch_profile)
        _assert_import_profile_ports_do_not_conflict(
            target_namespace=target_namespace,
            launch_profile=launch_profile,
        )

    target_is_active = target_namespace == ACTIVE_NAMESPACE
    if target_is_active:
        maintenance_service.enter_maintenance("Importing backup")
        try:
            _restore_import_to_target(
                backup_path=backup_path,
                target_database_path=target_database_path,
                backup_namespace=backup_namespace,
                target_namespace=target_namespace,
                launch_profile=launch_profile,
            )
            _reset_runtime_state_after_restore()
        finally:
            maintenance_service.exit_maintenance()
        _schedule_server_restart_after_restore(delay_seconds=0.5)
    else:
        stop_namespace_for_restore(namespace=target_namespace)
        _restore_import_to_target(
            backup_path=backup_path,
            target_database_path=target_database_path,
            backup_namespace=backup_namespace,
            target_namespace=target_namespace,
            launch_profile=launch_profile,
        )

    return BackupRestoreResponse(
        backup_id=payload.backup_id,
        source=payload.source,
        backup_filename=payload.backup_filename,
        backup_namespace=backup_namespace,
        target_namespace=target_namespace,
        active_namespace_restarted=target_is_active,
        open_namespace_suggested=not target_is_active,
        message="Backup imported successfully",
    )
