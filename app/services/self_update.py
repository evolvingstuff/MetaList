from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import subprocess
import tarfile

import httpx

from app.server_runtime import resolve_namespaces_directory
from app.services.exception_capture import CapturedExceptionContext
from app.services.namespace_switcher import stop_all_namespace_processes_for_update
from app.services.update_backups import backup_all_namespaces_for_update


_WINDOWS_CREATE_NEW_CONSOLE = 0x00000010
_PYPI_PROJECT_URL = "https://pypi.org/pypi/metalist/json"
_PYPI_REQUEST_TIMEOUT_SECONDS = 10.0
_RELEASE_VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


@dataclass(frozen=True)
class SelfUpdateScheduleResult:
    current_version: str
    target_version: str
    update_scheduled: bool
    stopped_process_count: int
    platform_name: str
    message: str


def schedule_self_update(
    *,
    current_version: str,
    metalist_executable: str,
    current_pid: int,
    platform_name: str,
    environ: Mapping[str, str],
) -> SelfUpdateScheduleResult:
    _validate_schedule_inputs(
        current_version=current_version,
        metalist_executable=metalist_executable,
        current_pid=current_pid,
        platform_name=platform_name,
    )
    target_version = _fetch_latest_pypi_version()
    current_version_key = _release_version_key(current_version)
    target_version_key = _release_version_key(target_version)
    if current_version_key >= target_version_key:
        if current_version_key == target_version_key:
            message = f"MetaList is already up to date (v{current_version})."
        else:
            message = (
                f"MetaList v{current_version} is newer than the latest PyPI release "
                f"(v{target_version}); no update was performed."
            )
        return SelfUpdateScheduleResult(
            current_version=current_version,
            target_version=target_version,
            update_scheduled=False,
            stopped_process_count=0,
            platform_name=platform_name,
            message=message,
        )

    uv_executable = shutil.which("uv")
    if uv_executable is None:
        raise RuntimeError("uv executable was not found on PATH; MetaList was not stopped")

    updater_command: list[str]
    updater_options: dict[str, object]
    if platform_name == "win32":
        powershell_executable = _resolve_windows_powershell()
        updater_command = _build_windows_updater_command(
            powershell_executable=powershell_executable,
            uv_executable=uv_executable,
            metalist_executable=metalist_executable,
            current_pid=current_pid,
            target_version=target_version,
        )
        updater_options = {
            "creationflags": _WINDOWS_CREATE_NEW_CONSOLE,
            "cwd": str(Path.home()),
            "env": dict(environ),
        }
    else:
        shell_path = Path("/bin/sh")
        if not shell_path.is_file():
            raise RuntimeError("/bin/sh is required for MetaList self-update; MetaList was not stopped")
        updater_command = _build_posix_updater_command(
            shell_executable=str(shell_path),
            uv_executable=uv_executable,
            metalist_executable=metalist_executable,
            current_pid=current_pid,
            target_version=target_version,
        )
        updater_options = {
            "start_new_session": True,
            "cwd": str(Path.home()),
            "env": dict(environ),
        }

    stopped_process_count = stop_all_namespace_processes_for_update()
    backup_paths = _back_up_namespaces_before_update()
    subprocess.Popen(updater_command, **updater_options)
    return SelfUpdateScheduleResult(
        current_version=current_version,
        target_version=target_version,
        update_scheduled=True,
        stopped_process_count=stopped_process_count,
        platform_name=platform_name,
        message=(
            f"Updating MetaList from v{current_version} to v{target_version}. "
            f"Stopped {stopped_process_count} MetaList process(es); "
            f"created and verified {len(backup_paths)} namespace backup(s); "
            "the updater will finish installation and restart MetaList."
        ),
    )


def _back_up_namespaces_before_update() -> tuple[Path, ...]:
    print("Backing up all namespaces before updating MetaList...", flush=True)
    backup_capture = CapturedExceptionContext(
        OSError, sqlite3.Error, tarfile.TarError, ValueError, RuntimeError,
    )
    with backup_capture:
        backup_paths = backup_all_namespaces_for_update(
            namespaces_directory=resolve_namespaces_directory(),
        )
    if backup_capture.captured_exception is not None:
        raise RuntimeError(
            f"MetaList backup failed; update aborted: {backup_capture.captured_exception}. "
            "The current version is intact and servers are stopped; "
            "run metalist to restart."
        ) from backup_capture.captured_exception
    return backup_paths


def _fetch_latest_pypi_version() -> str:
    response = httpx.get(
        _PYPI_PROJECT_URL,
        follow_redirects=False,
        timeout=_PYPI_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()

    if not isinstance(payload, dict):
        raise RuntimeError("PyPI returned invalid MetaList release metadata; MetaList was not stopped")
    project_info = payload.get("info")
    if not isinstance(project_info, dict):
        raise RuntimeError("PyPI returned invalid MetaList release metadata; MetaList was not stopped")
    target_version = project_info.get("version")
    if (
        not isinstance(target_version, str)
        or _RELEASE_VERSION_PATTERN.fullmatch(target_version) is None
    ):
        raise RuntimeError(
            "PyPI returned an invalid MetaList release version; MetaList was not stopped"
        )
    return target_version


def _release_version_key(version: object) -> tuple[int, int, int]:
    if not isinstance(version, str) or _RELEASE_VERSION_PATTERN.fullmatch(version) is None:
        raise ValueError("MetaList release versions must use the MAJOR.MINOR.PATCH format")
    major, minor, patch = version.split(".")
    return int(major), int(minor), int(patch)


def _validate_schedule_inputs(
    *,
    current_version: str,
    metalist_executable: str,
    current_pid: int,
    platform_name: str,
) -> None:
    _release_version_key(current_version)
    if not isinstance(metalist_executable, str) or metalist_executable.strip() == "":
        raise ValueError("metalist_executable must be a non-empty string")
    if not isinstance(current_pid, int) or current_pid <= 0:
        raise ValueError("current_pid must be a positive integer")
    if platform_name not in {"darwin", "linux", "win32"}:
        raise RuntimeError(f"MetaList self-update does not support platform: {platform_name}")


def _resolve_windows_powershell() -> str:
    powershell_executable = shutil.which("powershell.exe")
    if powershell_executable is not None:
        return powershell_executable
    pwsh_executable = shutil.which("pwsh.exe")
    if pwsh_executable is not None:
        return pwsh_executable
    raise RuntimeError("PowerShell is required for MetaList self-update; MetaList was not stopped")


def _quote_powershell_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _build_windows_updater_command(
    *,
    powershell_executable: str,
    uv_executable: str,
    metalist_executable: str,
    current_pid: int,
    target_version: str,
) -> list[str]:
    quoted_uv = _quote_powershell_literal(uv_executable)
    quoted_metalist = _quote_powershell_literal(metalist_executable)
    quoted_package = _quote_powershell_literal(f"metalist=={target_version}")
    script = (
        f"while (Get-Process -Id {current_pid} -ErrorAction SilentlyContinue) "
        "{ Start-Sleep -Milliseconds 100 }; "
        f"& {quoted_uv} tool install --force --reinstall --refresh {quoted_package}; "
        "if ($LASTEXITCODE -ne 0) { "
        "Write-Host 'MetaList update failed. Review the uv output above.' -ForegroundColor Red; "
        "Start-Sleep -Seconds 10; exit $LASTEXITCODE }; "
        f"& {quoted_metalist}; "
        "if ($LASTEXITCODE -ne 0) { "
        f"Write-Host 'MetaList updated to v{target_version}, but restart failed.' "
        "-ForegroundColor Red; "
        "Start-Sleep -Seconds 10; exit $LASTEXITCODE }; "
        f"Write-Host 'MetaList updated to v{target_version}.' -ForegroundColor Green; "
        "Start-Sleep -Seconds 3"
    )
    return [
        powershell_executable,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]


def _build_posix_updater_command(
    *,
    shell_executable: str,
    uv_executable: str,
    metalist_executable: str,
    current_pid: int,
    target_version: str,
) -> list[str]:
    uv_command = shlex.join(
        [
            uv_executable,
            "tool",
            "install",
            "--force",
            "--reinstall",
            "--refresh",
            f"metalist=={target_version}",
        ]
    )
    metalist_command = shlex.join([metalist_executable])
    script = (
        f"while kill -0 {current_pid} 2>/dev/null; do sleep 0.1; done\n"
        f"if ! {uv_command}; then\n"
        "  echo 'MetaList update failed. Review the uv output above.' >&2\n"
        "  exit 1\n"
        "fi\n"
        f"if ! {metalist_command}; then\n"
        f"  echo 'MetaList updated to v{target_version}, but restart failed.' >&2\n"
        "  exit 1\n"
        "fi\n"
        f"echo 'MetaList updated to v{target_version}.'\n"
    )
    return [shell_executable, "-c", script]
