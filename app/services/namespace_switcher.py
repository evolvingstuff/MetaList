from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from http.client import HTTPConnection
from pathlib import Path
import json
import os
import signal
import socket
import subprocess
import sys
import time
import shutil
from urllib.parse import urlencode, urlsplit, urlunsplit

import app.server_runtime as server_runtime
from app.server_runtime import NamespaceLaunchProfile
from app.server_runtime import load_all_namespace_launch_profiles
from app.server_runtime import load_all_namespace_launch_profiles_read_only
from app.server_runtime import resolve_api_prefix
from app.server_runtime import resolve_backend_connect_host
from app.server_runtime import resolve_local_browser_host
from app.server_runtime import resolve_main_server_config
from app.server_runtime import resolve_namespaced_database_path
from app.server_runtime import resolve_namespaces_directory
from app.server_runtime import resolve_namespace_launch_defaults
from app.server_runtime import resolve_runtime_logs_directory
from app.server_runtime import save_namespace_launch_profile
from app.server_runtime import validate_namespace
from app.security.shell_execution import is_shell_execution_enabled_for_environ
from app.services.diagnostics import recycle_direct_append_log_file
from app.services.exception_capture import CapturedExceptionContext
from app.services.namespace_deletion_jobs import create_namespace_deletion_job
from app.services.namespace_rename_jobs import create_namespace_rename_job
from app.services.windows_process_control import find_listening_pids_for_port as find_windows_listening_pids_for_port
from app.services.windows_process_control import is_process_running as is_windows_process_running
from app.services.windows_process_control import stop_process as stop_windows_process
from app.services.input_errors import NamespaceInputRejected


_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_PLACEHOLDER_NEW_NAMESPACE = "new-namespace"
_LAUNCH_READY_TIMEOUT_SECONDS = 12.0
_PORT_PROBE_TIMEOUT_SECONDS = 0.75
_READY_POLL_INTERVAL_SECONDS = 0.25
_PROCESS_WAIT_POLL_INTERVAL_SECONDS = 0.25
_TERMINATE_GRACE_SECONDS = 5.0
_KILL_GRACE_SECONDS = 5.0
_PROBE_TAB_ID = "namespace-switcher-probe"
_LAUNCH_LOG_TAIL_BYTES = 4 * 1024
_LAUNCH_LOG_TAIL_LINES = 20
ORCHESTRATED_CHILD_ENV_NAME = "METALIST_ORCHESTRATED_CHILD"


@dataclass(frozen=True)
class NamespacePortReservation:
    namespace: str
    service: str
    port: int
    source: str


@dataclass(frozen=True)
class NamespaceCatalogEntry:
    namespace: str
    is_current: bool
    database_exists: bool
    has_launch_profile: bool
    saved_profile: NamespaceLaunchProfile | None
    default_profile: NamespaceLaunchProfile


@dataclass(frozen=True)
class NamespaceOpenResult:
    namespace: str
    action: str
    url: str
    saved_profile: NamespaceLaunchProfile
    saved_for_next_launch: bool
    message: str


@dataclass(frozen=True)
class NamespaceLaunchProcess:
    process: subprocess.Popen[bytes]
    log_path: Path
    log_start_offset: int


@dataclass(frozen=True)
class NamespaceDeleteResult:
    deleted_namespace: str
    redirect_url: str
    delete_job_id: str
    active_namespace_deleted: bool
    message: str


@dataclass(frozen=True)
class NamespaceRenameResult:
    source_namespace: str
    target_namespace: str
    redirect_url: str
    rename_job_id: str
    message: str


@dataclass(frozen=True)
class NamespacePortsSaveResult:
    saved_profiles: list[NamespaceLaunchProfile]
    message: str


def _resolve_main_launch_command(*, environ: Mapping[str, str]) -> list[str]:
    recorded_entrypoint = environ.get("METALIST_SELF_EXECUTABLE")
    if recorded_entrypoint is not None:
        stripped_entrypoint = recorded_entrypoint.strip()
        if stripped_entrypoint == "":
            raise NamespaceInputRejected("METALIST_SELF_EXECUTABLE must not be empty")
        entrypoint_path = Path(stripped_entrypoint).expanduser()
        if entrypoint_path.suffix.casefold() == ".py":
            if entrypoint_path.name == "main.py":
                namespace_entrypoint = entrypoint_path.with_name("serve_namespace.py")
                return [sys.executable, str(namespace_entrypoint)]
            return [sys.executable, str(entrypoint_path)]
        return [str(entrypoint_path)]

    namespace_main = _PROJECT_ROOT / "serve_namespace.py"
    if namespace_main.is_file():
        return [sys.executable, str(namespace_main)]
    source_main = _PROJECT_ROOT / "main.py"
    if source_main.is_file():
        return [sys.executable, str(source_main)]
    return [sys.executable, "-m", "main"]


def _resolve_delete_worker_command() -> list[str]:
    worker_path = Path(__file__).resolve().with_name("namespace_deletion_worker.py")
    return [sys.executable, str(worker_path)]


def _resolve_rename_worker_command() -> list[str]:
    worker_path = Path(__file__).resolve().with_name("namespace_rename_worker.py")
    return [sys.executable, str(worker_path)]


def build_namespace_catalog(
    *,
    environ: Mapping[str, str],
    current_namespace: str | None,
) -> dict[str, object]:
    current_profile = _build_current_profile(
        environ=environ,
        current_namespace=current_namespace,
    )
    saved_profiles = _load_saved_profiles_by_namespace()
    known_namespaces = _discover_namespaces(
        saved_profiles=saved_profiles,
        current_namespace=current_namespace,
    )
    supports_https = _supports_https(environ=environ)
    entries: list[dict[str, object]] = []
    for namespace in known_namespaces:
        occupied_ports = _occupied_ports(
            saved_profiles=saved_profiles,
            current_profile=current_profile,
            ignore_namespace=namespace,
        )
        saved_profile = saved_profiles.get(namespace)
        default_profile = _build_default_profile(
            namespace=namespace,
            saved_profile=saved_profile,
            current_profile=current_profile,
            occupied_ports=occupied_ports,
            supports_https=supports_https,
        )
        entry = NamespaceCatalogEntry(
            namespace=namespace,
            is_current=namespace == current_namespace,
            database_exists=resolve_namespaced_database_path(namespace=namespace).is_file(),
            has_launch_profile=saved_profile is not None,
            saved_profile=saved_profile,
            default_profile=default_profile,
        )
        entries.append(_serialize_catalog_entry(entry=entry))
    current_profile_port = None
    if current_profile is not None:
        current_profile_port = current_profile.port
    current_url = _build_browser_url(
        environ=environ,
        port=current_profile_port,
    )
    new_namespace_profile = _suggest_profile(
        namespace=_PLACEHOLDER_NEW_NAMESPACE,
        occupied_ports=_occupied_ports(
            saved_profiles=saved_profiles,
            current_profile=current_profile,
            ignore_namespace=None,
        ),
        supports_https=supports_https,
    )
    return {
        "current_namespace": current_namespace,
        "current_profile": None if current_profile is None else _serialize_profile(profile=current_profile),
        "current_url": current_url,
        "supports_https": supports_https,
        "reserved_ports": [
            _serialize_reservation(reservation=reservation)
            for reservation in _reserved_ports(
                saved_profiles=saved_profiles,
                current_profile=current_profile,
                ignore_namespace=None,
            )
        ],
        "new_namespace_profile": _serialize_profile(profile=new_namespace_profile),
        "namespaces": entries,
    }


def open_or_launch_namespace(
    *,
    environ: Mapping[str, str],
    current_namespace: str | None,
    namespace: str,
    port: int,
    https_port: int | None,
) -> NamespaceOpenResult:
    normalized_namespace = validate_namespace(namespace=namespace)
    current_profile = _build_current_profile(
        environ=environ,
        current_namespace=current_namespace,
    )
    supports_https = _supports_https(environ=environ)
    saved_profiles = _load_saved_profiles_by_namespace()
    saved_profile = saved_profiles.get(normalized_namespace)
    if saved_profile is None:
        legacy_mcp_port = None
    else:
        legacy_mcp_port = saved_profile.mcp_port
    chosen_profile = _build_requested_profile(
        namespace=normalized_namespace,
        port=port,
        https_port=https_port,
        legacy_mcp_port=legacy_mcp_port,
        supports_https=supports_https,
    )
    _assert_profile_is_conflict_free(
        chosen_profile=chosen_profile,
        saved_profiles=saved_profiles,
        current_profile=current_profile,
    )
    if current_profile is not None and current_profile.namespace == normalized_namespace:
        running_url = _build_browser_url(environ=environ, port=current_profile.port)
        assert running_url is not None
        saved_for_next_launch = _save_profile_if_needed(
            chosen_profile=chosen_profile,
            saved_profile=saved_profile,
        )
        if saved_for_next_launch:
            message = (
                f"Namespace {normalized_namespace} is already running. "
                "Saved the new ports for the next launch."
            )
        else:
            message = f"Namespace {normalized_namespace} is already running."
        return NamespaceOpenResult(
            namespace=normalized_namespace,
            action="opened-running",
            url=running_url,
            saved_profile=chosen_profile,
            saved_for_next_launch=saved_for_next_launch,
            message=message,
        )
    running_port = _find_running_namespace_port(
        environ=environ,
        namespace=normalized_namespace,
        chosen_profile=chosen_profile,
        saved_profile=saved_profile,
        current_profile=current_profile,
    )
    saved_for_next_launch = _save_profile_if_needed(
        chosen_profile=chosen_profile,
        saved_profile=saved_profile,
    )
    if running_port is not None:
        if not saved_for_next_launch and running_port == chosen_profile.port:
            running_url = _build_browser_url(environ=environ, port=running_port)
            assert running_url is not None
            return NamespaceOpenResult(
                namespace=normalized_namespace,
                action="opened-running",
                url=running_url,
                saved_profile=chosen_profile,
                saved_for_next_launch=False,
                message=f"Namespace {normalized_namespace} is already running with a warm cache.",
            )
        _restart_running_namespace_process(
            environ=environ,
            namespace=normalized_namespace,
            chosen_profile=chosen_profile,
            running_port=running_port,
        )
        running_url = _build_browser_url(environ=environ, port=chosen_profile.port)
        assert running_url is not None
        return NamespaceOpenResult(
            namespace=normalized_namespace,
            action="restarted",
            url=running_url,
            saved_profile=chosen_profile,
            saved_for_next_launch=saved_for_next_launch,
            message=f"Restarted namespace {normalized_namespace}.",
        )
    _assert_ports_are_available_for_launch(
        environ=environ,
        namespace=normalized_namespace,
        chosen_profile=chosen_profile,
        allowed_listener_pids=frozenset(),
    )
    launched_process = _launch_namespace_process(
        environ=environ,
        chosen_profile=chosen_profile,
    )
    _wait_for_namespace_ready(
        environ=environ,
        namespace=normalized_namespace,
        port=chosen_profile.port,
        launched_process=launched_process,
    )
    launched_url = _build_browser_url(environ=environ, port=chosen_profile.port)
    assert launched_url is not None
    return NamespaceOpenResult(
        namespace=normalized_namespace,
        action="launched",
        url=launched_url,
        saved_profile=chosen_profile,
        saved_for_next_launch=saved_for_next_launch,
        message=f"Started namespace {normalized_namespace}.",
    )


def open_or_launch_all_namespaces(
    *,
    environ: Mapping[str, str],
) -> list[NamespaceOpenResult]:
    catalog = build_namespace_catalog(
        environ=environ,
        current_namespace=None,
    )
    raw_namespaces = catalog["namespaces"]
    if not isinstance(raw_namespaces, list):
        raise NamespaceInputRejected("Namespace catalog missing namespaces")

    profiles = _resolve_conflict_free_profiles_for_all_namespaces(
        raw_namespaces=raw_namespaces,
    )
    saved_profiles = _load_saved_profiles_by_namespace()
    for profile in profiles:
        saved_profile = saved_profiles.get(profile.namespace)
        if saved_profile is None:
            raise NamespaceInputRejected(f"Namespace {profile.namespace} launch profile disappeared")
        if saved_profile == profile:
            continue
        save_namespace_launch_profile(
            namespace=profile.namespace,
            port=profile.port,
            https_port=profile.https_port,
            mcp_port=profile.mcp_port,
        )
        print(
            f"[startup] WARNING: adjusted namespace {profile.namespace} ports to resolve "
            f"a saved conflict: HTTP {saved_profile.port} -> {profile.port}, "
            f"HTTPS {saved_profile.https_port} -> {profile.https_port}.",
            file=sys.stderr,
            flush=True,
        )

    results: list[NamespaceOpenResult] = []
    for profile in profiles:
        result = open_or_launch_namespace(
            environ=environ,
            current_namespace=None,
            namespace=profile.namespace,
            port=profile.port,
            https_port=profile.https_port,
        )
        if result.action == "opened-running":
            _restart_running_namespace_process(
                environ=environ,
                namespace=result.namespace,
                chosen_profile=result.saved_profile,
                running_port=result.saved_profile.port,
            )
            result = NamespaceOpenResult(
                namespace=result.namespace,
                action="restarted",
                url=result.url,
                saved_profile=result.saved_profile,
                saved_for_next_launch=result.saved_for_next_launch,
                message=f"Restarted namespace {result.namespace}.",
            )
        results.append(result)
    return results


def stop_namespace_for_restore(*, namespace: str) -> None:
    """Stop a verified target server before replacing its live databases."""
    profiles = load_all_namespace_launch_profiles_read_only()
    for profile in profiles:
        if profile.namespace != namespace:
            continue
        running_port = _find_running_namespace_port(
            environ=os.environ,
            namespace=namespace,
            chosen_profile=profile,
            saved_profile=profile,
            current_profile=None,
        )
        if running_port is not None:
            _stop_processes_listening_on_port(port=running_port)
        elif _find_listening_pids_for_port(port=profile.port):
            raise RuntimeError(f"Cannot verify the server on namespace {namespace}'s port; stop it before restoring.")
        return


def stop_all_namespace_processes_for_update() -> int:
    profiles = load_all_namespace_launch_profiles_read_only()
    reserved_ports: set[int] = set()
    for profile in profiles:
        for _, port in _profile_service_ports(profile=profile):
            reserved_ports.add(port)

    listener_pids: set[int] = set()
    for port in sorted(reserved_ports):
        listener_pids.update(_find_listening_pids_for_port(port=port))
    current_pid = os.getpid()
    listener_pids.discard(current_pid)
    for pid in sorted(listener_pids):
        _stop_process(pid=pid)
    return len(listener_pids)


def _resolve_conflict_free_profiles_for_all_namespaces(
    *,
    raw_namespaces: Sequence[object],
) -> list[NamespaceLaunchProfile]:
    occupied_ports: set[int] = set()
    saved_profiles = _load_saved_profiles_by_namespace()
    profiles: list[NamespaceLaunchProfile] = []
    for entry in raw_namespaces:
        _assert_catalog_entry_has_launch_profile(entry=entry)
        catalog_profile = _catalog_default_profile(entry=entry)
        persisted_profile = saved_profiles.get(catalog_profile.namespace)
        legacy_mcp_port = None
        if persisted_profile is not None:
            legacy_mcp_port = persisted_profile.mcp_port
        saved_profile = NamespaceLaunchProfile(
            namespace=catalog_profile.namespace,
            port=catalog_profile.port,
            https_port=catalog_profile.https_port,
            mcp_port=legacy_mcp_port,
        )
        profile = _repair_profile_port_conflicts(
            profile=saved_profile,
            occupied_ports=occupied_ports,
        )
        profiles.append(profile)
        for _, port in _profile_service_ports(profile=profile):
            occupied_ports.add(port)
    return profiles


def _repair_profile_port_conflicts(
    *,
    profile: NamespaceLaunchProfile,
    occupied_ports: set[int],
) -> NamespaceLaunchProfile:
    working_ports = set(occupied_ports)
    http_port = _keep_or_replace_port(
        preferred_port=profile.port,
        replacement_start=server_runtime._DEFAULT_HTTP_PORT,
        occupied_ports=working_ports,
    )
    working_ports.add(http_port)

    https_port = profile.https_port
    if https_port is not None:
        https_port = _keep_or_replace_port(
            preferred_port=https_port,
            replacement_start=server_runtime._DEFAULT_HTTPS_PORT,
            occupied_ports=working_ports,
        )
        working_ports.add(https_port)

    return NamespaceLaunchProfile(
        namespace=profile.namespace,
        port=http_port,
        https_port=https_port,
        mcp_port=profile.mcp_port,
    )


def _keep_or_replace_port(
    *,
    preferred_port: int,
    replacement_start: int,
    occupied_ports: set[int],
) -> int:
    if preferred_port not in occupied_ports:
        return preferred_port
    return _next_free_port(
        start_port=replacement_start,
        occupied_ports=occupied_ports,
    )


def save_namespace_port_profiles(
    *,
    environ: Mapping[str, str],
    current_namespace: str | None,
    requested_profiles: Sequence[NamespaceLaunchProfile],
) -> NamespacePortsSaveResult:
    if not isinstance(requested_profiles, Sequence):
        raise TypeError(f"requested_profiles must be a sequence, got {type(requested_profiles)}")
    if len(requested_profiles) == 0:
        raise RuntimeError("At least one namespace port profile is required")

    supports_https = _supports_https(environ=environ)
    current_profile = _build_current_profile(
        environ=environ,
        current_namespace=current_namespace,
    )
    saved_profiles = _load_saved_profiles_by_namespace()
    normalized_profiles: list[NamespaceLaunchProfile] = []
    seen_namespaces: set[str] = set()
    for requested_profile in requested_profiles:
        if not isinstance(requested_profile, NamespaceLaunchProfile):
            raise TypeError("requested_profiles must contain NamespaceLaunchProfile values")
        requested_namespace = validate_namespace(namespace=requested_profile.namespace)
        saved_profile = saved_profiles.get(requested_namespace)
        legacy_mcp_port = None
        if saved_profile is not None:
            legacy_mcp_port = saved_profile.mcp_port
        normalized_profile = _build_requested_profile(
            namespace=requested_namespace,
            port=requested_profile.port,
            https_port=requested_profile.https_port,
            legacy_mcp_port=legacy_mcp_port,
            supports_https=supports_https,
        )
        if normalized_profile.namespace in seen_namespaces:
            raise RuntimeError(f"Duplicate namespace profile: {normalized_profile.namespace}")
        seen_namespaces.add(normalized_profile.namespace)
        normalized_profiles.append(normalized_profile)

    _assert_requested_profiles_are_conflict_free(
        requested_profiles=normalized_profiles,
        saved_profiles=saved_profiles,
        current_profile=current_profile,
    )

    saved_results: list[NamespaceLaunchProfile] = []
    for profile in normalized_profiles:
        saved_results.append(
            save_namespace_launch_profile(
                namespace=profile.namespace,
                port=profile.port,
                https_port=profile.https_port,
                mcp_port=profile.mcp_port,
            )
        )
    return NamespacePortsSaveResult(
        saved_profiles=saved_results,
        message=f"Saved ports for {len(saved_results)} namespace(s).",
    )


def build_login_namespace_catalog(
    *,
    environ: Mapping[str, str],
    current_namespace: str | None,
) -> dict[str, object]:
    catalog = build_namespace_catalog(
        environ=environ,
        current_namespace=current_namespace,
    )
    raw_current_namespace = catalog["current_namespace"]
    if not isinstance(raw_current_namespace, str) or raw_current_namespace == "":
        raise RuntimeError("Namespace catalog missing current_namespace")

    raw_namespaces = catalog["namespaces"]
    if not isinstance(raw_namespaces, list):
        raise RuntimeError("Namespace catalog missing namespaces")

    namespaces: list[str] = []
    seen_namespaces: set[str] = set()
    for entry in raw_namespaces:
        if not isinstance(entry, dict):
            raise RuntimeError("Namespace catalog entry must be an object")
        namespace = entry.get("namespace")
        if not isinstance(namespace, str) or namespace == "":
            raise RuntimeError("Namespace catalog entry missing namespace")
        if namespace in seen_namespaces:
            raise RuntimeError(f"Namespace catalog contains duplicate namespace {namespace}")
        seen_namespaces.add(namespace)
        namespaces.append(namespace)

    if raw_current_namespace not in seen_namespaces:
        raise RuntimeError(f"Current namespace {raw_current_namespace} missing from namespace catalog")

    return {
        "current_namespace": raw_current_namespace,
        "namespaces": namespaces,
    }


def open_login_namespace(
    *,
    environ: Mapping[str, str],
    current_namespace: str | None,
    namespace: str,
) -> NamespaceOpenResult:
    chosen_profile = _resolve_catalog_profile(
        environ=environ,
        current_namespace=current_namespace,
        namespace=namespace,
    )
    return open_or_launch_namespace(
        environ=environ,
        current_namespace=current_namespace,
        namespace=chosen_profile.namespace,
        port=chosen_profile.port,
        https_port=chosen_profile.https_port,
    )


def rename_current_namespace(
    *,
    environ: Mapping[str, str],
    current_namespace: str | None,
    target_namespace: str,
) -> NamespaceRenameResult:
    if current_namespace is None:
        raise RuntimeError("Current namespace is unavailable")
    normalized_source = validate_namespace(namespace=current_namespace)
    normalized_target = validate_namespace(namespace=target_namespace)
    if normalized_target == normalized_source:
        raise NamespaceInputRejected("New namespace name must differ from the current name")
    target_directory = server_runtime.resolve_namespace_directory(namespace=normalized_target)
    if target_directory.exists():
        raise NamespaceInputRejected(f"Namespace {normalized_target} already exists")
    source_directory = server_runtime.resolve_namespace_directory(namespace=normalized_source)
    if not source_directory.is_dir():
        raise NamespaceInputRejected(f"Namespace {normalized_source} is unavailable")

    current_profile = _build_current_profile(
        environ=environ,
        current_namespace=normalized_source,
    )
    if current_profile is None:
        raise RuntimeError("Current namespace launch profile is unavailable")
    if current_profile.port is None:
        raise RuntimeError("Current namespace launch profile is missing HTTP port")
    renamed_profile = NamespaceLaunchProfile(
        namespace=normalized_target,
        port=current_profile.port,
        https_port=current_profile.https_port,
        mcp_port=current_profile.mcp_port,
    )
    current_url = _build_browser_url(environ=environ, port=current_profile.port)
    if current_url is None:
        raise RuntimeError("Current namespace URL is unavailable")
    job_record = create_namespace_rename_job(
        source_namespace=normalized_source,
        target_namespace=normalized_target,
    )
    redirect_url = _build_namespace_renamed_page_url(
        url=current_url,
        job_id=job_record["job_id"],
    )
    _spawn_namespace_rename_worker(
        environ=environ,
        source_namespace=normalized_source,
        target_namespace=normalized_target,
        current_pid=os.getpid(),
        job_id=job_record["job_id"],
        profile=renamed_profile,
    )
    return NamespaceRenameResult(
        source_namespace=normalized_source,
        target_namespace=normalized_target,
        redirect_url=redirect_url,
        rename_job_id=job_record["job_id"],
        message=f"Renaming namespace {normalized_source} to {normalized_target}.",
    )


def delete_namespace(
    *,
    environ: Mapping[str, str],
    current_namespace: str | None,
    target_namespace: str,
    confirmed_namespace: str,
    redirect_namespace: str,
) -> NamespaceDeleteResult:
    normalized_target_namespace = validate_namespace(namespace=target_namespace)
    if current_namespace is None:
        raise RuntimeError("Current namespace is unavailable")
    normalized_current_namespace = validate_namespace(namespace=current_namespace)
    if normalized_target_namespace == normalized_current_namespace:
        return _delete_active_namespace(
            environ=environ,
            current_namespace=normalized_current_namespace,
            confirmed_namespace=confirmed_namespace,
            redirect_namespace=redirect_namespace,
        )
    return _delete_inactive_namespace(
        target_namespace=normalized_target_namespace,
        confirmed_namespace=confirmed_namespace,
    )


def delete_current_namespace(
    *,
    environ: Mapping[str, str],
    current_namespace: str | None,
    confirmed_namespace: str,
    redirect_namespace: str,
) -> NamespaceDeleteResult:
    if current_namespace is None:
        raise RuntimeError("Current namespace is unavailable")
    return _delete_active_namespace(
        environ=environ,
        current_namespace=validate_namespace(namespace=current_namespace),
        confirmed_namespace=confirmed_namespace,
        redirect_namespace=redirect_namespace,
    )


def _delete_active_namespace(
    *,
    environ: Mapping[str, str],
    current_namespace: str,
    confirmed_namespace: str,
    redirect_namespace: str,
) -> NamespaceDeleteResult:
    normalized_namespace = validate_namespace(namespace=current_namespace)
    _assert_namespace_deletion_confirmation(
        namespace=normalized_namespace,
        confirmed_namespace=confirmed_namespace,
    )
    normalized_redirect_namespace = validate_namespace(namespace=redirect_namespace)
    catalog = build_namespace_catalog(
        environ=environ,
        current_namespace=normalized_namespace,
    )
    raw_entries = catalog["namespaces"]
    if not isinstance(raw_entries, list):
        raise RuntimeError("Namespace catalog missing namespaces")
    remaining_namespaces: list[str] = []
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            raise RuntimeError("Namespace catalog entry must be an object")
        entry_namespace = raw_entry["namespace"]
        if not isinstance(entry_namespace, str) or entry_namespace == "":
            raise RuntimeError("Namespace catalog entry missing namespace")
        if entry_namespace != normalized_namespace:
            remaining_namespaces.append(entry_namespace)

    recreate_default = len(remaining_namespaces) == 0
    if recreate_default:
        if normalized_redirect_namespace != server_runtime._DEFAULT_NAMESPACE:
            raise RuntimeError("Deleting the final namespace must redirect to a fresh default namespace")
        current_profile = _build_current_profile(
            environ=environ,
            current_namespace=normalized_namespace,
        )
        if current_profile is None:
            raise RuntimeError("Current namespace launch profile is unavailable")
        replacement_profile = NamespaceLaunchProfile(
            namespace=server_runtime._DEFAULT_NAMESPACE,
            port=current_profile.port,
            https_port=current_profile.https_port,
            mcp_port=current_profile.mcp_port,
        )
        current_url = _build_browser_url(environ=environ, port=current_profile.port)
        if current_url is None:
            raise RuntimeError("Current namespace URL is unavailable")
        redirect_base_url = current_url
    else:
        if normalized_redirect_namespace not in remaining_namespaces:
            raise RuntimeError(
                f"Redirect namespace must be one of: {', '.join(sorted(remaining_namespaces))}"
            )
        replacement_profile = _resolve_fallback_profile(
            environ=environ,
            current_namespace=normalized_namespace,
            fallback_namespace=normalized_redirect_namespace,
        )
        fallback_result = open_or_launch_namespace(
            environ=environ,
            current_namespace=normalized_namespace,
            namespace=replacement_profile.namespace,
            port=replacement_profile.port,
            https_port=replacement_profile.https_port,
        )
        redirect_base_url = fallback_result.url
    job_record = create_namespace_deletion_job(
        deleted_namespace=normalized_namespace,
        redirect_namespace=replacement_profile.namespace,
    )
    redirect_url = _build_namespace_deleted_page_url(
        url=redirect_base_url,
        job_id=job_record["job_id"],
    )
    _spawn_namespace_deletion_worker(
        namespace=normalized_namespace,
        current_pid=os.getpid(),
        job_id=job_record["job_id"],
        recreate_default=recreate_default,
        replacement_profile=replacement_profile,
    )
    return NamespaceDeleteResult(
        deleted_namespace=normalized_namespace,
        redirect_url=redirect_url,
        delete_job_id=job_record["job_id"],
        active_namespace_deleted=True,
        message=(
            f"Deleting namespace {normalized_namespace}. "
            "Opening the namespace removal page."
        ),
    )


def _delete_inactive_namespace(
    *,
    target_namespace: str,
    confirmed_namespace: str,
) -> NamespaceDeleteResult:
    normalized_namespace = validate_namespace(namespace=target_namespace)
    _assert_namespace_deletion_confirmation(
        namespace=normalized_namespace,
        confirmed_namespace=confirmed_namespace,
    )

    namespace_directory = server_runtime.resolve_namespace_directory(namespace=normalized_namespace)
    if not namespace_directory.exists():
        raise NamespaceInputRejected(f"Namespace {normalized_namespace} is unavailable")
    if not namespace_directory.is_dir():
        raise RuntimeError(f"Namespace path is not a directory: {namespace_directory}")

    saved_profiles = _load_saved_profiles_by_namespace()
    saved_profile = saved_profiles.get(normalized_namespace)
    if saved_profile is not None:
        _stop_processes_for_namespace_profile(profile=saved_profile)
    shutil.rmtree(namespace_directory)
    if namespace_directory.exists():
        raise RuntimeError(
            f"Namespace {normalized_namespace} directory still exists after deletion"
        )
    return NamespaceDeleteResult(
        deleted_namespace=normalized_namespace,
        redirect_url="",
        delete_job_id="",
        active_namespace_deleted=False,
        message=f"{normalized_namespace} namespace successfully deleted.",
    )


def _assert_namespace_deletion_confirmation(
    *,
    namespace: str,
    confirmed_namespace: str,
) -> None:
    normalized_namespace = validate_namespace(namespace=namespace)
    if confirmed_namespace.strip() != normalized_namespace:
        raise NamespaceInputRejected(f"Type '{normalized_namespace}' to confirm namespace deletion")


def _stop_processes_for_namespace_profile(*, profile: NamespaceLaunchProfile) -> None:
    ports = [
        profile.port,
        profile.https_port,
    ]
    stopped_ports: set[int] = set()
    for port in ports:
        if port is None:
            continue
        if port in stopped_ports:
            continue
        stopped_ports.add(port)
        _stop_processes_listening_on_port(port=port)


def _serialize_catalog_entry(*, entry: NamespaceCatalogEntry) -> dict[str, object]:
    return {
        "namespace": entry.namespace,
        "is_current": entry.is_current,
        "database_exists": entry.database_exists,
        "has_launch_profile": entry.has_launch_profile,
        "saved_profile": None if entry.saved_profile is None else _serialize_profile(profile=entry.saved_profile),
        "default_profile": _serialize_profile(profile=entry.default_profile),
    }


def _serialize_reservation(*, reservation: NamespacePortReservation) -> dict[str, object]:
    return {
        "namespace": reservation.namespace,
        "service": reservation.service,
        "port": reservation.port,
        "source": reservation.source,
    }


def _serialize_profile(*, profile: NamespaceLaunchProfile) -> dict[str, object]:
    return {
        "namespace": profile.namespace,
        "port": profile.port,
        "https_port": profile.https_port,
    }


def _catalog_default_profile(*, entry: object) -> NamespaceLaunchProfile:
    if not isinstance(entry, dict):
        raise RuntimeError("Namespace catalog entry must be an object")

    namespace = entry.get("namespace")
    if not isinstance(namespace, str) or namespace == "":
        raise RuntimeError("Namespace catalog entry missing namespace")

    raw_profile = entry.get("default_profile")
    if not isinstance(raw_profile, dict):
        raise RuntimeError(f"Namespace {namespace} is missing default profile")

    port = raw_profile.get("port")
    if not isinstance(port, int):
        raise RuntimeError(f"Namespace {namespace} profile missing port")

    https_port = raw_profile.get("https_port")
    if https_port is not None and not isinstance(https_port, int):
        raise RuntimeError(f"Namespace {namespace} profile has invalid https_port")

    return NamespaceLaunchProfile(
        namespace=namespace,
        port=port,
        https_port=https_port,
        mcp_port=None,
    )


def _assert_catalog_entry_has_launch_profile(*, entry: object) -> None:
    if not isinstance(entry, dict):
        raise RuntimeError("Namespace catalog entry must be an object")
    namespace = entry.get("namespace")
    if not isinstance(namespace, str) or namespace == "":
        raise RuntimeError("Namespace catalog entry missing namespace")
    has_launch_profile = entry.get("has_launch_profile")
    if has_launch_profile is True:
        return
    raise RuntimeError(
        f"Namespace {namespace} has no launch profile. "
        "Configure its HTTP/HTTPS ports from Manage namespace ports, "
        "or launch it once with an explicit --port value."
    )


def _load_saved_profiles_by_namespace() -> dict[str, NamespaceLaunchProfile]:
    profiles = load_all_namespace_launch_profiles()
    profiles_by_namespace: dict[str, NamespaceLaunchProfile] = {}
    for profile in profiles:
        profiles_by_namespace[profile.namespace] = profile
    return profiles_by_namespace


def _discover_namespaces(
    *,
    saved_profiles: Mapping[str, NamespaceLaunchProfile],
    current_namespace: str | None,
) -> list[str]:
    discovered: set[str] = set()
    for namespace in saved_profiles:
        discovered.add(namespace)
    if current_namespace is not None:
        discovered.add(validate_namespace(namespace=current_namespace))
    namespaces_directory = resolve_namespaces_directory()
    if namespaces_directory.is_dir():
        for child in namespaces_directory.iterdir():
            if not child.is_dir():
                continue
            validate_capture = CapturedExceptionContext(NamespaceInputRejected, boundary='app/services/namespace_switcher.py:_discover_namespaces:validate_capture')
            with validate_capture:
                discovered.add(validate_namespace(namespace=child.name))
            if validate_capture.captured_exception is not None:
                continue
    ordered_namespaces = sorted(discovered)
    if server_runtime._DEFAULT_NAMESPACE in ordered_namespaces:
        ordered_namespaces.remove(server_runtime._DEFAULT_NAMESPACE)
        ordered_namespaces.insert(0, server_runtime._DEFAULT_NAMESPACE)
    return ordered_namespaces


def _supports_https(*, environ: Mapping[str, str]) -> bool:
    main_server_config = resolve_main_server_config(environ=environ)
    return main_server_config.https_port is not None


def _build_current_profile(
    *,
    environ: Mapping[str, str],
    current_namespace: str | None,
) -> NamespaceLaunchProfile | None:
    if current_namespace is None:
        return None
    normalized_namespace = validate_namespace(namespace=current_namespace)
    main_server_config = resolve_main_server_config(environ=environ)
    launch_defaults = resolve_namespace_launch_defaults(
        namespace=normalized_namespace,
        environ=environ,
    )
    return NamespaceLaunchProfile(
        namespace=normalized_namespace,
        port=main_server_config.port,
        https_port=main_server_config.https_port,
        mcp_port=launch_defaults.mcp_port,
    )


def _build_default_profile(
    *,
    namespace: str,
    saved_profile: NamespaceLaunchProfile | None,
    current_profile: NamespaceLaunchProfile | None,
    occupied_ports: set[int],
    supports_https: bool,
) -> NamespaceLaunchProfile:
    if current_profile is not None and current_profile.namespace == namespace:
        return current_profile
    if saved_profile is None:
        return _suggest_profile(
            namespace=namespace,
            occupied_ports=occupied_ports,
            supports_https=supports_https,
        )
    working_ports = set(occupied_ports)
    http_port = saved_profile.port
    if http_port is None:
        http_port = _next_free_port(
            start_port=server_runtime._DEFAULT_HTTP_PORT,
            occupied_ports=working_ports,
        )
    working_ports.add(http_port)
    if supports_https:
        https_port = saved_profile.https_port
        if https_port is None:
            https_port = _next_free_port(
                start_port=server_runtime._DEFAULT_HTTPS_PORT,
                occupied_ports=working_ports,
            )
        working_ports.add(https_port)
    else:
        https_port = None
    return NamespaceLaunchProfile(
        namespace=namespace,
        port=http_port,
        https_port=https_port,
        mcp_port=saved_profile.mcp_port,
    )


def _suggest_profile(
    *,
    namespace: str,
    occupied_ports: set[int],
    supports_https: bool,
) -> NamespaceLaunchProfile:
    working_ports = set(occupied_ports)
    http_port = _next_available_port(
        start_port=server_runtime._DEFAULT_HTTP_PORT,
        occupied_ports=working_ports,
    )
    working_ports.add(http_port)
    if supports_https:
        https_port = _next_available_port(
            start_port=server_runtime._DEFAULT_HTTPS_PORT,
            occupied_ports=working_ports,
        )
        working_ports.add(https_port)
    else:
        https_port = None
    return NamespaceLaunchProfile(
        namespace=namespace,
        port=http_port,
        https_port=https_port,
        mcp_port=None,
    )


def _next_free_port(*, start_port: int, occupied_ports: set[int]) -> int:
    port = start_port
    while port in occupied_ports:
        port += 1
    return port


def _next_available_port(*, start_port: int, occupied_ports: set[int]) -> int:
    working_ports = set(occupied_ports)
    while True:
        port = _next_free_port(
            start_port=start_port,
            occupied_ports=working_ports,
        )
        if len(_find_listening_pids_for_port(port=port)) == 0:
            return port
        working_ports.add(port)


def _reserved_ports(
    *,
    saved_profiles: Mapping[str, NamespaceLaunchProfile],
    current_profile: NamespaceLaunchProfile | None,
    ignore_namespace: str | None,
) -> list[NamespacePortReservation]:
    reservations: list[NamespacePortReservation] = []
    seen: set[tuple[str, str, int, str]] = set()
    for profile in saved_profiles.values():
        if ignore_namespace is not None and profile.namespace == ignore_namespace:
            continue
        _append_profile_reservations(
            reservations=reservations,
            seen=seen,
            profile=profile,
            source="saved_profile",
        )
    if current_profile is not None:
        if ignore_namespace is None or current_profile.namespace != ignore_namespace:
            _append_profile_reservations(
                reservations=reservations,
                seen=seen,
                profile=current_profile,
                source="current_runtime",
            )
    reservations.sort(key=lambda reservation: (reservation.port, reservation.namespace, reservation.service))
    return reservations


def _append_profile_reservations(
    *,
    reservations: list[NamespacePortReservation],
    seen: set[tuple[str, str, int, str]],
    profile: NamespaceLaunchProfile,
    source: str,
) -> None:
    port_pairs = [
        ("http", profile.port),
        ("https", profile.https_port),
    ]
    for service, port in port_pairs:
        if port is None:
            continue
        key = (profile.namespace, service, port, source)
        if key in seen:
            continue
        seen.add(key)
        reservations.append(
            NamespacePortReservation(
                namespace=profile.namespace,
                service=service,
                port=port,
                source=source,
            )
        )


def _occupied_ports(
    *,
    saved_profiles: Mapping[str, NamespaceLaunchProfile],
    current_profile: NamespaceLaunchProfile | None,
    ignore_namespace: str | None,
) -> set[int]:
    occupied: set[int] = set()
    for reservation in _reserved_ports(
        saved_profiles=saved_profiles,
        current_profile=current_profile,
        ignore_namespace=ignore_namespace,
    ):
        occupied.add(reservation.port)
    return occupied


def _build_requested_profile(
    *,
    namespace: str,
    port: int,
    https_port: int | None,
    legacy_mcp_port: int | None,
    supports_https: bool,
) -> NamespaceLaunchProfile:
    normalized_port = _validate_required_port(name="port", value=port)
    if supports_https:
        if https_port is None:
            raise NamespaceInputRejected("HTTPS port is required because TLS is enabled for this app")
        normalized_https_port = _validate_required_port(name="https_port", value=https_port)
    else:
        if https_port is not None:
            raise NamespaceInputRejected("HTTPS port is not available because TLS is not configured")
        normalized_https_port = None
    return NamespaceLaunchProfile(
        namespace=namespace,
        port=normalized_port,
        https_port=normalized_https_port,
        mcp_port=legacy_mcp_port,
    )


def _validate_required_port(*, name: str, value: int) -> int:
    if not isinstance(value, int):
        raise TypeError(f"{name} must be an int, got {type(value)}")
    if not 0 < value < 65536:
        raise NamespaceInputRejected(f"{name} must be between 1 and 65535, got: {value}")
    return value


def _assert_profile_is_conflict_free(
    *,
    chosen_profile: NamespaceLaunchProfile,
    saved_profiles: Mapping[str, NamespaceLaunchProfile],
    current_profile: NamespaceLaunchProfile | None,
) -> None:
    service_pairs = [
        ("http", chosen_profile.port),
        ("https", chosen_profile.https_port),
    ]
    seen_ports: dict[int, str] = {}
    for service, port in service_pairs:
        if port is None:
            continue
        if port in seen_ports:
            other_service = seen_ports[port]
            raise RuntimeError(
                f"{service.upper()} port {port} conflicts with {other_service.upper()} port "
                f"for namespace {chosen_profile.namespace}"
            )
        seen_ports[port] = service
    reservations = _reserved_ports(
        saved_profiles=saved_profiles,
        current_profile=current_profile,
        ignore_namespace=chosen_profile.namespace,
    )
    conflicts_by_port = {reservation.port: reservation for reservation in reservations}
    for service, port in service_pairs:
        if port is None:
            continue
        if port not in conflicts_by_port:
            continue
        reservation = conflicts_by_port[port]
        raise RuntimeError(
            f"{service.upper()} port {port} conflicts with "
            f"{reservation.service.upper()} port reserved for namespace {reservation.namespace}"
        )


def _profile_service_ports(*, profile: NamespaceLaunchProfile) -> list[tuple[str, int]]:
    service_pairs = [
        ("http", profile.port),
        ("https", profile.https_port),
    ]
    ports: list[tuple[str, int]] = []
    for service, port in service_pairs:
        if port is None:
            continue
        ports.append((service, port))
    return ports


def _assert_requested_profiles_are_conflict_free(
    *,
    requested_profiles: Sequence[NamespaceLaunchProfile],
    saved_profiles: Mapping[str, NamespaceLaunchProfile],
    current_profile: NamespaceLaunchProfile | None,
) -> None:
    requested_namespaces = {profile.namespace for profile in requested_profiles}
    requested_ports: dict[int, tuple[str, str]] = {}
    for profile in requested_profiles:
        for service, port in _profile_service_ports(profile=profile):
            if port in requested_ports:
                other_namespace, other_service = requested_ports[port]
                raise RuntimeError(
                    f"{service.upper()} port {port} for namespace {profile.namespace} conflicts with "
                    f"{other_service.upper()} port for namespace {other_namespace}"
                )
            requested_ports[port] = (profile.namespace, service)

    persisted_reservations = _reserved_ports(
        saved_profiles={
            namespace: profile
            for namespace, profile in saved_profiles.items()
            if namespace not in requested_namespaces
        },
        current_profile=None,
        ignore_namespace=None,
    )
    for profile in requested_profiles:
        for service, port in _profile_service_ports(profile=profile):
            for reservation in persisted_reservations:
                if reservation.port != port:
                    continue
                raise RuntimeError(
                    f"{service.upper()} port {port} for namespace {profile.namespace} conflicts with "
                    f"{reservation.service.upper()} port reserved for namespace {reservation.namespace}"
                )
            if current_profile is None or current_profile.namespace == profile.namespace:
                continue
            for current_service, current_port in _profile_service_ports(profile=current_profile):
                if current_port != port:
                    continue
                raise RuntimeError(
                    f"{service.upper()} port {port} for namespace {profile.namespace} conflicts with "
                    f"{current_service.upper()} port used by current namespace {current_profile.namespace}"
                )


def _find_running_namespace_port(
    *,
    environ: Mapping[str, str],
    namespace: str,
    chosen_profile: NamespaceLaunchProfile,
    saved_profile: NamespaceLaunchProfile | None,
    current_profile: NamespaceLaunchProfile | None,
) -> int | None:
    main_server_config = resolve_main_server_config(environ=environ)
    connect_host = resolve_backend_connect_host(host=main_server_config.host)
    api_prefix = resolve_api_prefix(environ=environ)
    candidate_ports: list[int] = [chosen_profile.port]
    if saved_profile is not None and saved_profile.port is not None:
        candidate_ports.append(saved_profile.port)
    if current_profile is not None and current_profile.namespace == namespace:
        candidate_ports.append(current_profile.port)
    checked_ports: set[int] = set()
    for candidate_port in candidate_ports:
        if candidate_port in checked_ports:
            continue
        checked_ports.add(candidate_port)
        status_payload = _probe_namespace_status(
            host=connect_host,
            port=candidate_port,
            api_prefix=api_prefix,
        )
        if status_payload is None:
            continue
        payload_namespace = status_payload.get("namespace")
        if payload_namespace == namespace:
            return candidate_port
    return None


def _read_process_state(*, pid: int) -> str | None:
    completed = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)],
        capture_output=True,
        check=False,
        text=True,
    )
    if completed.returncode != 0:
        return None
    process_state = completed.stdout.strip()
    if process_state == "":
        return None
    return process_state


def _is_process_running(*, pid: int) -> bool:
    if not isinstance(pid, int):
        raise TypeError(f"pid must be an int, got {type(pid)}")
    if pid <= 0:
        raise ValueError(f"pid must be positive, got: {pid}")
    if sys.platform == "win32":
        return is_windows_process_running(pid=pid)
    kill_capture = CapturedExceptionContext(ProcessLookupError, PermissionError, boundary='app/services/namespace_switcher.py:_is_process_running:kill_capture')
    with kill_capture:
        os.kill(pid, 0)
    if kill_capture.captured_exception is not None:
        if isinstance(kill_capture.captured_exception, ProcessLookupError):
            return False
        if isinstance(kill_capture.captured_exception, PermissionError):
            return True
        raise RuntimeError("Unexpected process-probe exception type")
    process_state = _read_process_state(pid=pid)
    if process_state is None:
        return True
    if process_state.startswith("Z"):
        return False
    return True


def _wait_for_process_exit(*, pid: int, timeout_seconds: float) -> bool:
    if not isinstance(timeout_seconds, float):
        raise TypeError(f"timeout_seconds must be a float, got {type(timeout_seconds)}")
    if timeout_seconds < 0.0:
        raise ValueError(f"timeout_seconds must be >= 0.0, got {timeout_seconds}")

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not _is_process_running(pid=pid):
            return True
        time.sleep(_PROCESS_WAIT_POLL_INTERVAL_SECONDS)
    return not _is_process_running(pid=pid)


def _send_signal_if_running(*, pid: int, signal_number: int) -> None:
    if not _is_process_running(pid=pid):
        return
    signal_capture = CapturedExceptionContext(ProcessLookupError, boundary='app/services/namespace_switcher.py:_send_signal_if_running:signal_capture')
    with signal_capture:
        os.kill(pid, signal_number)
    if signal_capture.captured_exception is not None:
        return


def _stop_process(*, pid: int) -> None:
    if sys.platform == "win32":
        stop_windows_process(pid=pid)
        return
    if not _is_process_running(pid=pid):
        return

    _send_signal_if_running(pid=pid, signal_number=signal.SIGTERM)
    if _wait_for_process_exit(pid=pid, timeout_seconds=_TERMINATE_GRACE_SECONDS):
        return

    _send_signal_if_running(pid=pid, signal_number=signal.SIGKILL)
    if _wait_for_process_exit(pid=pid, timeout_seconds=_KILL_GRACE_SECONDS):
        return

    raise RuntimeError(f"Timed out waiting for process {pid} to exit")


def _find_listening_pids_for_port(*, port: int) -> list[int]:
    if not isinstance(port, int):
        raise TypeError(f"port must be an int, got {type(port)}")
    if port <= 0 or port > 65535:
        raise ValueError(f"port must be between 1 and 65535, got: {port}")
    if sys.platform == "win32":
        return find_windows_listening_pids_for_port(port=port)

    lsof_path = shutil.which("lsof")
    if lsof_path is None:
        raise RuntimeError("`lsof` is required to inspect namespace ports")

    completed = subprocess.run(
        [lsof_path, "-nP", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
        capture_output=True,
        check=False,
        text=True,
    )
    if completed.returncode not in {0, 1}:
        raise RuntimeError(
            f"`lsof` failed while checking port {port}: "
            f"exit={completed.returncode} stderr={completed.stderr.strip()!r}"
        )
    stdout = completed.stdout.strip()
    if stdout == "":
        return []

    seen_pids: set[int] = set()
    ordered_pids: list[int] = []
    for raw_line in stdout.splitlines():
        raw_pid = raw_line.strip()
        if raw_pid == "":
            continue
        if not raw_pid.isdigit():
            raise RuntimeError(f"`lsof` returned a non-numeric pid for port {port}: {raw_pid!r}")
        pid = int(raw_pid)
        if pid <= 0:
            raise RuntimeError(f"`lsof` returned invalid pid for port {port}: {pid}")
        if pid in seen_pids:
            continue
        seen_pids.add(pid)
        ordered_pids.append(pid)
    return ordered_pids


def _is_port_occupied_only_by_allowed_pids(*, port: int, allowed_listener_pids: frozenset[int]) -> bool:
    if len(allowed_listener_pids) == 0:
        return False
    listener_pids = _find_listening_pids_for_port(port=port)
    if len(listener_pids) == 0:
        return False
    for pid in listener_pids:
        if pid not in allowed_listener_pids:
            return False
    return True


def _assert_ports_are_available_for_launch(
    *,
    environ: Mapping[str, str],
    namespace: str,
    chosen_profile: NamespaceLaunchProfile,
    allowed_listener_pids: frozenset[int] | None,
) -> None:
    def _port_is_owned_by_allowed_pids(*, port: int) -> bool:
        return (
            allowed_listener_pids is not None
            and _is_port_occupied_only_by_allowed_pids(
                port=port,
                allowed_listener_pids=allowed_listener_pids,
            )
        )

    main_server_config = resolve_main_server_config(environ=environ)
    connect_host = resolve_backend_connect_host(host=main_server_config.host)
    api_prefix = resolve_api_prefix(environ=environ)
    http_status = _probe_namespace_status(
        host=connect_host,
        port=chosen_profile.port,
        api_prefix=api_prefix,
    )
    if http_status is not None:
        running_namespace = http_status.get("namespace")
        if running_namespace == namespace:
            return
        if not _port_is_owned_by_allowed_pids(port=chosen_profile.port):
            raise RuntimeError(f"HTTP port {chosen_profile.port} is already in use")
    if _is_tcp_port_open(host=connect_host, port=chosen_profile.port):
        if not _port_is_owned_by_allowed_pids(port=chosen_profile.port):
            raise RuntimeError(f"HTTP port {chosen_profile.port} is already in use")
    other_ports = [("HTTPS", chosen_profile.https_port)]
    for service, port in other_ports:
        if port is None:
            continue
        if _is_tcp_port_open(host=connect_host, port=port):
            if _port_is_owned_by_allowed_pids(port=port):
                continue
            raise RuntimeError(f"{service} port {port} is already in use")


def _save_profile_if_needed(
    *,
    chosen_profile: NamespaceLaunchProfile,
    saved_profile: NamespaceLaunchProfile | None,
) -> bool:
    if saved_profile is not None:
        if (
            saved_profile.port == chosen_profile.port
            and saved_profile.https_port == chosen_profile.https_port
        ):
            return False
    save_namespace_launch_profile(
        namespace=chosen_profile.namespace,
        port=chosen_profile.port,
        https_port=chosen_profile.https_port,
        mcp_port=chosen_profile.mcp_port,
    )
    return True


def _launch_namespace_process(
    *,
    environ: Mapping[str, str],
    chosen_profile: NamespaceLaunchProfile,
) -> NamespaceLaunchProcess:
    child_environ = dict(environ)
    for name in (
        "METALIST_NAMESPACE",
        "METALIST_PORT",
        "METALIST_HTTPS_PORT",
    ):
        if name in child_environ:
            del child_environ[name]
    child_environ[ORCHESTRATED_CHILD_ENV_NAME] = "1"
    command = _resolve_main_launch_command(environ=child_environ)
    command.extend(
        [
            "--namespace",
            chosen_profile.namespace,
            "--port",
            str(chosen_profile.port),
        ]
    )
    if chosen_profile.https_port is not None:
        command.extend(["--https-port", str(chosen_profile.https_port)])
    if is_shell_execution_enabled_for_environ(environ=child_environ):
        command.append("--enable-shell")
    logs_directory = resolve_runtime_logs_directory()
    logs_directory.mkdir(parents=True, exist_ok=True)
    log_path = logs_directory / f"namespace-{chosen_profile.namespace}.log"
    recycle_direct_append_log_file(path=log_path)
    log_handle = open(log_path, "ab")
    try:
        log_handle.seek(0, os.SEEK_END)
        log_start_offset = log_handle.tell()
        process = subprocess.Popen(
            command,
            env=child_environ,
            stdout=log_handle,
            stderr=log_handle,
            start_new_session=True,
        )
    finally:
        log_handle.close()
    return NamespaceLaunchProcess(
        process=process,
        log_path=log_path,
        log_start_offset=log_start_offset,
    )


def _stop_processes_listening_on_port(*, port: int) -> None:
    listener_pids = _find_listening_pids_for_port(port=port)
    if len(listener_pids) == 0:
        return

    current_pid = os.getpid()
    for pid in listener_pids:
        if pid == current_pid:
            raise RuntimeError(f"Refusing to stop the current process on port {port}")
        _stop_process(pid=pid)


def _restart_running_namespace_process(
    *,
    environ: Mapping[str, str],
    namespace: str,
    chosen_profile: NamespaceLaunchProfile,
    running_port: int,
) -> None:
    allowed_listener_pids = frozenset(_find_listening_pids_for_port(port=running_port))
    _assert_ports_are_available_for_launch(
        environ=environ,
        namespace=namespace,
        chosen_profile=chosen_profile,
        allowed_listener_pids=allowed_listener_pids,
    )
    _stop_processes_listening_on_port(port=running_port)
    launched_process = _launch_namespace_process(
        environ=environ,
        chosen_profile=chosen_profile,
    )
    _wait_for_namespace_ready(
        environ=environ,
        namespace=namespace,
        port=chosen_profile.port,
        launched_process=launched_process,
    )


def _read_namespace_launch_log_tail(*, log_path: Path, log_start_offset: int) -> str:
    if log_start_offset < 0:
        raise ValueError("log_start_offset must not be negative")
    read_capture = CapturedExceptionContext(OSError, boundary='app/services/namespace_switcher.py:_read_namespace_launch_log_tail:read_capture')
    log_bytes: bytes | None = None
    with read_capture:
        with log_path.open("rb") as log_file:
            log_file.seek(log_start_offset)
            log_bytes = log_file.read()
    if read_capture.captured_exception is not None:
        return f"<unable to read child log: {read_capture.captured_exception}>"
    if log_bytes is None:
        raise RuntimeError("Namespace child log read produced no bytes")
    tail_text = log_bytes[-_LAUNCH_LOG_TAIL_BYTES:].decode("utf-8", errors="replace")
    tail = "\n".join(tail_text.splitlines()[-_LAUNCH_LOG_TAIL_LINES:]).strip()
    if tail == "":
        return "<child log is empty>"
    return tail


def _wait_for_namespace_ready(
    *,
    environ: Mapping[str, str],
    namespace: str,
    port: int,
    launched_process: NamespaceLaunchProcess,
) -> None:
    main_server_config = resolve_main_server_config(environ=environ)
    connect_host = resolve_backend_connect_host(host=main_server_config.host)
    api_prefix = resolve_api_prefix(environ=environ)
    deadline = time.monotonic() + _LAUNCH_READY_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        exit_code = launched_process.process.poll()
        if exit_code is not None:
            log_tail = _read_namespace_launch_log_tail(
                log_path=launched_process.log_path,
                log_start_offset=launched_process.log_start_offset,
            )
            raise RuntimeError(
                f"Namespace {namespace} process exited with code {exit_code}. "
                f"Child log: {launched_process.log_path}\n{log_tail}"
            )
        status_payload = _probe_namespace_status(
            host=connect_host,
            port=port,
            api_prefix=api_prefix,
        )
        if status_payload is not None and status_payload.get("namespace") == namespace:
            return
        time.sleep(_READY_POLL_INTERVAL_SECONDS)
    log_tail = _read_namespace_launch_log_tail(
        log_path=launched_process.log_path,
        log_start_offset=launched_process.log_start_offset,
    )
    raise RuntimeError(
        f"Timed out waiting for namespace {namespace} on port {port}. "
        f"Child log: {launched_process.log_path}\n{log_tail}"
    )


def _probe_namespace_status(
    *,
    host: str,
    port: int,
    api_prefix: str,
) -> dict[str, object] | None:
    connection = HTTPConnection(host=host, port=port, timeout=_PORT_PROBE_TIMEOUT_SECONDS)
    request_capture = CapturedExceptionContext(OSError, boundary='app/services/namespace_switcher.py:_probe_namespace_status:request_capture')
    payload_bytes: bytes | None = None
    with request_capture:
        connection.request(
            "GET",
            f"{api_prefix}/auth/status",
            headers={"X-Metalist-Tab-Id": _PROBE_TAB_ID},
        )
        response = connection.getresponse()
        if response.status != 200:
            connection.close()
            return None
        payload_bytes = response.read()
    connection.close()
    if request_capture.captured_exception is not None:
        return None
    if payload_bytes is None:
        raise RuntimeError("Namespace probe did not return a payload")

    decode_capture = CapturedExceptionContext(UnicodeDecodeError, json.JSONDecodeError, boundary='app/services/namespace_switcher.py:_probe_namespace_status:decode_capture')
    payload = None
    with decode_capture:
        payload = json.loads(payload_bytes.decode("utf-8"))
    if decode_capture.captured_exception is not None:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def _is_tcp_port_open(*, host: str, port: int) -> bool:
    connect_capture = CapturedExceptionContext(OSError, boundary='app/services/namespace_switcher.py:_is_tcp_port_open:connect_capture')
    with connect_capture:
        with socket.create_connection((host, port), timeout=_PORT_PROBE_TIMEOUT_SECONDS):
            return True
    if connect_capture.captured_exception is not None:
        return False
    raise RuntimeError("TCP port probe finished without returning a result")


def _build_browser_url(
    *,
    environ: Mapping[str, str],
    port: int | None,
) -> str | None:
    if port is None:
        return None
    main_server_config = resolve_main_server_config(environ=environ)
    browser_host = resolve_local_browser_host(host=main_server_config.host)
    return f"http://{browser_host}:{port}"


def _resolve_fallback_profile(
    *,
    environ: Mapping[str, str],
    current_namespace: str,
    fallback_namespace: str,
) -> NamespaceLaunchProfile:
    return _resolve_catalog_profile(
        environ=environ,
        current_namespace=current_namespace,
        namespace=fallback_namespace,
    )


def _resolve_catalog_profile(
    *,
    environ: Mapping[str, str],
    current_namespace: str | None,
    namespace: str,
) -> NamespaceLaunchProfile:
    normalized_namespace = validate_namespace(namespace=namespace)
    catalog = build_namespace_catalog(
        environ=environ,
        current_namespace=current_namespace,
    )
    namespaces = catalog["namespaces"]
    if not isinstance(namespaces, list):
        raise RuntimeError("Namespace catalog missing namespaces")
    for entry in namespaces:
        if not isinstance(entry, dict):
            continue
        if entry.get("namespace") != normalized_namespace:
            continue
        _assert_catalog_entry_has_launch_profile(entry=entry)
        return _catalog_default_profile(entry=entry)
    raise RuntimeError(f"Namespace {normalized_namespace} is unavailable")


def _spawn_namespace_deletion_worker(
    *,
    namespace: str,
    current_pid: int,
    job_id: str,
    recreate_default: bool,
    replacement_profile: NamespaceLaunchProfile,
) -> None:
    normalized_namespace = validate_namespace(namespace=namespace)
    if not isinstance(current_pid, int):
        raise TypeError(f"current_pid must be an int, got {type(current_pid)}")
    if current_pid <= 0:
        raise ValueError(f"current_pid must be positive, got: {current_pid}")
    if not isinstance(job_id, str) or job_id == "":
        raise TypeError("job_id must be a non-empty string")
    if not isinstance(recreate_default, bool):
        raise TypeError("recreate_default must be a boolean")
    if replacement_profile.port is None:
        raise RuntimeError("Replacement namespace profile missing HTTP port")

    command = _resolve_delete_worker_command()
    command.extend(
        [
            "--pid",
            str(current_pid),
            "--namespace",
            normalized_namespace,
            "--job-id",
            job_id,
            "--replacement-namespace",
            replacement_profile.namespace,
            "--replacement-port",
            str(replacement_profile.port),
            "--replacement-https-port",
            "0" if replacement_profile.https_port is None else str(replacement_profile.https_port),
        ]
    )
    if recreate_default:
        command.append("--recreate-default")
    logs_directory = resolve_runtime_logs_directory()
    logs_directory.mkdir(parents=True, exist_ok=True)
    log_path = logs_directory / f"namespace-delete-{normalized_namespace}.log"
    recycle_direct_append_log_file(path=log_path)
    log_handle = open(log_path, "ab")
    try:
        subprocess.Popen(
            command,
            env=dict(os.environ),
            stdout=log_handle,
            stderr=log_handle,
            start_new_session=True,
        )
    finally:
        log_handle.close()


def _spawn_namespace_rename_worker(
    *,
    environ: Mapping[str, str],
    source_namespace: str,
    target_namespace: str,
    current_pid: int,
    job_id: str,
    profile: NamespaceLaunchProfile,
) -> None:
    normalized_source = validate_namespace(namespace=source_namespace)
    normalized_target = validate_namespace(namespace=target_namespace)
    if not isinstance(current_pid, int):
        raise TypeError(f"current_pid must be an int, got {type(current_pid)}")
    if current_pid <= 0:
        raise ValueError(f"current_pid must be positive, got: {current_pid}")
    if not isinstance(job_id, str) or job_id == "":
        raise TypeError("job_id must be a non-empty string")
    if profile.namespace != normalized_target:
        raise RuntimeError("Rename worker profile namespace must match the target namespace")
    if profile.port is None:
        raise RuntimeError("Renamed namespace profile missing HTTP port")

    command = _resolve_rename_worker_command()
    command.extend(
        [
            "--pid",
            str(current_pid),
            "--source-namespace",
            normalized_source,
            "--target-namespace",
            normalized_target,
            "--job-id",
            job_id,
            "--port",
            str(profile.port),
            "--https-port",
            "0" if profile.https_port is None else str(profile.https_port),
        ]
    )
    logs_directory = resolve_runtime_logs_directory()
    logs_directory.mkdir(parents=True, exist_ok=True)
    log_path = logs_directory / f"namespace-rename-{normalized_source}-to-{normalized_target}.log"
    recycle_direct_append_log_file(path=log_path)
    log_handle = open(log_path, "ab")
    try:
        subprocess.Popen(
            command,
            env=dict(environ),
            stdout=log_handle,
            stderr=log_handle,
            start_new_session=True,
        )
    finally:
        log_handle.close()


def _build_namespace_deleted_page_url(*, url: str, job_id: str) -> str:
    if not isinstance(url, str) or url == "":
        raise TypeError("url must be a non-empty string")
    if not isinstance(job_id, str) or job_id == "":
        raise TypeError("job_id must be a non-empty string")
    parsed = urlsplit(url)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            "/namespace-deleted",
            urlencode((("job", job_id),)),
            "",
        )
    )


def _build_namespace_renamed_page_url(*, url: str, job_id: str) -> str:
    if not isinstance(url, str) or url == "":
        raise TypeError("url must be a non-empty string")
    if not isinstance(job_id, str) or job_id == "":
        raise TypeError("job_id must be a non-empty string")
    parsed = urlsplit(url)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            "/namespace-renamed",
            urlencode((("job", job_id),)),
            "",
        )
    )
