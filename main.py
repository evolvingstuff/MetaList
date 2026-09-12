import uvicorn
from collections.abc import Iterable
from dataclasses import dataclass
import logging
import os
import signal
import shutil
import subprocess
import sys
import threading
import time
import ssl
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer

from app.https_proxy import BoundedProxyServer, make_proxy_handler
from app.server_runtime import apply_main_cli_args_to_environ
from app.server_runtime import ensure_default_tls_pair
from app.server_runtime import MainCliArgs
from app.server_runtime import prepare_database_runtime_path
from app.server_runtime import resolve_backend_connect_host
from app.server_runtime import resolve_database_runtime_config
from app.server_runtime import resolve_local_browser_host
from app.server_runtime import resolve_main_server_config
from app.server_runtime import resolve_namespaces_directory
from app.server_runtime import save_namespace_launch_profile
from app.db.live_recovery import recover_pending_namespaces
from app.encryption_audit import audit_all_namespaces
from app.encryption_audit import EncryptionAuditReport
from app.startup_js_sanity import assert_startup_js_sanity
from app.startup_sanity import assert_startup_sanity
from app.startup_environment import DEVELOPMENT_ENVIRONMENT
from app.startup_environment import resolve_startup_environment
from app.services.exception_capture import CapturedExceptionContext
from app.services.namespace_switcher import build_namespace_catalog
from app.services.namespace_switcher import NamespaceOpenResult
from app.services.namespace_switcher import ORCHESTRATED_CHILD_ENV_NAME
from app.services.namespace_switcher import open_or_launch_all_namespaces
from app.services.self_update import schedule_self_update
from app.version import __version__
from app.security.shell_execution import enable_shell_execution_for_launch
from app.security.shell_execution import is_shell_execution_enabled
from app.services.windows_process_control import find_listening_pids_for_port as find_windows_listening_pids_for_port
from app.services.windows_process_control import is_process_running as is_windows_process_running
from app.services.windows_process_control import stop_process as stop_windows_process


class _HttpsProxyServer(BoundedProxyServer):
    def server_bind(self) -> None:
        # The proxy needs its bound address, not a potentially blocking reverse DNS lookup.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


@dataclass(frozen=True)
class _StartedHttpsProxy:
    server: _HttpsProxyServer
    thread: threading.Thread


_WAIT_POLL_INTERVAL_SECONDS = 0.25
_TERMINATE_GRACE_SECONDS = 5.0
_KILL_GRACE_SECONDS = 5.0
_EXPLICIT_NAMESPACE_LAUNCH_ENV_NAMES = (
    "METALIST_NAMESPACE",
    "METALIST_PORT",
    "METALIST_HTTPS_PORT",
)
_HTTPS_PROXY_STRIPPED_REQUEST_HEADERS = frozenset(
    {
        "connection",
        "forwarded",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
    }
)


def _print_shell_execution_enabled_banner() -> None:
    print(
        "[startup] @shell enabled for authenticated loopback clients "
        "(this launch only).",
        flush=True,
    )


def _run_startup_sanity_gates(*, repo_root: Path) -> None:
    startup_environment = resolve_startup_environment(
        repo_root=repo_root,
        environ=os.environ,
    )
    print(f"[startup] MetaList environment: {startup_environment}", flush=True)
    if startup_environment != DEVELOPMENT_ENVIRONMENT:
        return

    assert_startup_sanity(repo_root)
    assert_startup_js_sanity(repo_root)


def _run_startup_encryption_audit(
    *,
    namespaces_directory: Path,
) -> EncryptionAuditReport:
    recover_pending_namespaces(namespaces_directory)
    print("[startup] Scanning encrypted namespaces for plaintext payloads...", flush=True)
    report = audit_all_namespaces(namespaces_directory=namespaces_directory)
    rendered_report = report.render_text()
    if report.passed:
        print(rendered_report, flush=True)
        return report

    warning_border = "!" * 96
    if report.startup_allowed:
        print(warning_border, file=sys.stderr, flush=True)
        print(
            "!!! ENCRYPTION AUDIT: AUTHENTICATED DATABASE MIGRATION REQUIRED !!!",
            file=sys.stderr,
            flush=True,
        )
        print(
            "MetaList will continue only so the known password-dependent migration can run.",
            file=sys.stderr,
            flush=True,
        )
        print(rendered_report, file=sys.stderr, flush=True)
        print(warning_border, file=sys.stderr, flush=True)
        return report

    print(warning_border, file=sys.stderr, flush=True)
    print(
        "!!! ENCRYPTION AUDIT FATAL: PLAINTEXT OR INVALID ENCRYPTION STORAGE DETECTED !!!",
        file=sys.stderr,
        flush=True,
    )
    print(
        "MetaList refuses to start because the findings are not an allowlisted migration state.",
        file=sys.stderr,
        flush=True,
    )
    print(rendered_report, file=sys.stderr, flush=True)
    print(warning_border, file=sys.stderr, flush=True)
    raise RuntimeError(f"Encrypted namespace audit failed:\n{rendered_report}")


class FilterCheckUpdates(logging.Filter):
    NOISY_PATTERNS = (
        'POST /api/notes/acquire-lock',
        'POST /api2/notes/acquire-lock',
        'POST /api2/notes/release-lock',
        'GET /api/auth/sessions',
        'GET /api2/auth/status',
    )

    def filter(self, record):
        message = record.getMessage()
        return not any(pattern in message for pattern in self.NOISY_PATTERNS)


def _resolve_current_entrypoint() -> str | None:
    raw_value = sys.argv[0].strip()
    if raw_value == "":
        return None
    if os.path.sep in raw_value:
        return os.path.abspath(raw_value)
    if os.path.altsep is not None and os.path.altsep in raw_value:
        return os.path.abspath(raw_value)
    resolved = shutil.which(raw_value)
    if resolved is None:
        return None
    return resolved


def _record_self_executable_for_namespace_launch() -> None:
    entrypoint = _resolve_current_entrypoint()
    if entrypoint is None:
        return
    os.environ["METALIST_SELF_EXECUTABLE"] = entrypoint


def _is_source_main_entrypoint() -> bool:
    entrypoint = _resolve_current_entrypoint()
    if entrypoint is None:
        return False
    return os.path.basename(entrypoint) == "main.py"


def _should_open_or_launch_all_namespaces(
    *,
    original_environ: dict[str, str],
    cli_args: MainCliArgs,
) -> bool:
    if cli_args.test_mode:
        return False
    if cli_args.namespace_requested:
        return False
    if cli_args.port is not None or cli_args.https_port is not None:
        return False
    if not _is_source_main_entrypoint():
        return False
    return not any(name in original_environ for name in _EXPLICIT_NAMESPACE_LAUNCH_ENV_NAMES)


def _should_bootstrap_all_namespaces_without_cli_parse(
    *,
    argv: list[str],
    original_environ: dict[str, str],
) -> bool:
    if argv not in ([], ["--enable-shell"]):
        return False
    if "TEST_MODE" in original_environ and original_environ["TEST_MODE"] == "1":
        return False
    return not any(name in original_environ for name in _EXPLICIT_NAMESPACE_LAUNCH_ENV_NAMES)


def _read_prompted_port(*, namespace: str, service: str, suggested_port: object) -> int:
    if not isinstance(suggested_port, int):
        raise RuntimeError(f"Namespace {namespace} missing suggested {service} port")
    raw_value = input(f"{namespace} {service} port [{suggested_port}]: ")
    value = raw_value.strip()
    if value == "":
        return suggested_port
    if not value.isdigit():
        raise RuntimeError(f"{namespace} {service} port must be numeric, got: {value!r}")
    port = int(value)
    if not 0 < port < 65536:
        raise RuntimeError(f"{namespace} {service} port must be between 1 and 65535, got: {port}")
    return port


def _read_prompted_https_port(*, namespace: str, suggested_port: object) -> int | None:
    if suggested_port is None:
        return None
    return _read_prompted_port(
        namespace=namespace,
        service="HTTPS",
        suggested_port=suggested_port,
    )


def _prompt_for_missing_namespace_launch_profile(*, entry: dict[str, object]) -> None:
    namespace = entry["namespace"]
    if not isinstance(namespace, str) or namespace == "":
        raise RuntimeError("Namespace catalog entry missing namespace")
    raw_profile = entry["default_profile"]
    if not isinstance(raw_profile, dict):
        raise RuntimeError(f"Namespace {namespace} missing default profile")
    print(f"Namespace {namespace} has no saved launch profile. Enter ports or press Return for suggestions.")
    port = _read_prompted_port(
        namespace=namespace,
        service="HTTP",
        suggested_port=raw_profile["port"],
    )
    https_port = _read_prompted_https_port(
        namespace=namespace,
        suggested_port=raw_profile["https_port"],
    )
    save_namespace_launch_profile(
        namespace=namespace,
        port=port,
        https_port=https_port,
        mcp_port=None,
    )


def _save_missing_default_namespace_launch_profile(*, entry: dict[str, object]) -> None:
    namespace = entry["namespace"]
    if namespace != "default":
        raise RuntimeError(f"Expected default namespace entry, got: {namespace!r}")
    raw_profile = entry["default_profile"]
    if not isinstance(raw_profile, dict):
        raise RuntimeError("Namespace default missing default profile")
    port = raw_profile["port"]
    https_port = raw_profile["https_port"]
    if not isinstance(port, int):
        raise RuntimeError("Namespace default missing suggested HTTP port")
    if https_port is not None and not isinstance(https_port, int):
        raise RuntimeError("Namespace default has invalid suggested HTTPS port")
    print("Namespace default has no saved launch profile. Saving suggested default ports.")
    save_namespace_launch_profile(
        namespace="default",
        port=port,
        https_port=https_port,
        mcp_port=None,
    )


def _prompt_for_missing_namespace_launch_profiles(*, environ: dict[str, str]) -> None:
    while True:
        catalog = build_namespace_catalog(environ=environ, current_namespace=None)
        raw_namespaces = catalog["namespaces"]
        if not isinstance(raw_namespaces, list):
            raise RuntimeError("Namespace catalog missing namespaces")
        missing_entry: dict[str, object] | None = None
        for raw_entry in raw_namespaces:
            if not isinstance(raw_entry, dict):
                raise RuntimeError("Namespace catalog entry must be an object")
            has_launch_profile = raw_entry["has_launch_profile"]
            if has_launch_profile is True:
                continue
            missing_entry = raw_entry
            break
        if missing_entry is None:
            return
        raw_namespace = missing_entry["namespace"]
        if raw_namespace == "default":
            _save_missing_default_namespace_launch_profile(entry=missing_entry)
            continue
        _prompt_for_missing_namespace_launch_profile(entry=missing_entry)


def _bootstrap_default_namespace_if_empty(*, environ: dict[str, str]) -> None:
    ensure_default_tls_pair(environ=environ)
    catalog = build_namespace_catalog(environ=environ, current_namespace=None)
    raw_namespaces = catalog["namespaces"]
    if not isinstance(raw_namespaces, list):
        raise RuntimeError("Namespace catalog missing namespaces")
    if len(raw_namespaces) > 0:
        return
    raw_profile = catalog["new_namespace_profile"]
    if not isinstance(raw_profile, dict):
        raise RuntimeError("Empty namespace catalog missing suggested launch profile")
    port = raw_profile["port"]
    https_port = raw_profile["https_port"]
    if not isinstance(port, int):
        raise RuntimeError("Suggested default namespace profile missing HTTP port")
    if https_port is not None and not isinstance(https_port, int):
        raise RuntimeError("Suggested default namespace profile has invalid HTTPS port")
    print("No namespaces found. Creating a fresh default namespace.")
    save_namespace_launch_profile(
        namespace="default",
        port=port,
        https_port=https_port,
        mcp_port=None,
    )


def _build_https_namespace_url(*, host: str, result: NamespaceOpenResult) -> str:
    https_port = result.saved_profile.https_port
    if https_port is None:
        return "disabled"
    return f"https://{host}:{https_port}"


def _print_namespace_bootstrap_results(
    *,
    environ: dict[str, str],
    launch_results: list[NamespaceOpenResult],
) -> None:
    main_server_config = resolve_main_server_config(environ=environ)
    browser_host = resolve_local_browser_host(host=main_server_config.host)
    print("MetaList namespace bootstrap:")
    print("namespace\taction\thttp\thttps")
    for result in launch_results:
        https_url = _build_https_namespace_url(host=browser_host, result=result)
        print(
            "\t".join(
                [
                    result.namespace,
                    result.action,
                    result.url,
                    https_url,
                ]
            )
        )


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
    kill_capture = CapturedExceptionContext(ProcessLookupError, PermissionError)
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
        time.sleep(_WAIT_POLL_INTERVAL_SECONDS)
    return not _is_process_running(pid=pid)


def _send_signal_if_running(*, pid: int, signal_number: int) -> None:
    if not _is_process_running(pid=pid):
        return
    signal_capture = CapturedExceptionContext(ProcessLookupError)
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
        raise RuntimeError("`lsof` is required to evict listeners from occupied ports")

    completed = subprocess.run(
        [lsof_path, "-nP", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
        capture_output=True,
        check=False,
        text=True,
    )
    if completed.returncode not in {0, 1}:
        error_text = completed.stderr.strip()
        raise RuntimeError(
            f"`lsof` failed while checking port {port}: exit={completed.returncode} stderr={error_text!r}"
        )
    stdout = completed.stdout.strip()
    if stdout == "":
        return []

    ordered_pids: list[int] = []
    seen_pids: set[int] = set()
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


def _evict_processes_listening_on_port(*, port: int) -> None:
    listener_pids = _find_listening_pids_for_port(port=port)
    if len(listener_pids) == 0:
        return

    current_pid = os.getpid()
    foreign_listener_pids: list[int] = []
    for pid in listener_pids:
        if pid == current_pid:
            raise RuntimeError(
                f"Port {port} is already held by the current MetaList process (pid {current_pid})"
            )
        foreign_listener_pids.append(pid)

    for pid in foreign_listener_pids:
        print(f"Port {port} is in use; terminating pid {pid}")
        _stop_process(pid=pid)


def _run_main_listener(
    *,
    app_object,
    host: str,
    port: int,
    proxy_headers: bool,
    forwarded_allow_ips: str,
    ssl_certfile: str | None,
    ssl_keyfile: str | None,
) -> None:
    _evict_processes_listening_on_port(port=port)
    uvicorn.run(
        app_object,
        host=host,
        port=port,
        reload=False,  # Disable auto-reload
        workers=1,  # Limit to a single worker
        proxy_headers=proxy_headers,
        forwarded_allow_ips=forwarded_allow_ips,
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
        access_log=False,
    )


def _build_https_proxy_forward_headers(
    *,
    incoming_headers: Iterable[tuple[str, str]],
    client_ip: str,
) -> dict[str, str]:
    if not isinstance(client_ip, str) or client_ip.strip() == "":
        raise TypeError("client_ip must be a non-empty string")

    forwarded_headers: dict[str, str] = {}
    for key, value in incoming_headers:
        if not isinstance(key, str) or key.strip() == "":
            raise TypeError("Incoming proxy header names must be non-empty strings")
        if not isinstance(value, str):
            raise TypeError("Incoming proxy header values must be strings")
        if key.casefold() in _HTTPS_PROXY_STRIPPED_REQUEST_HEADERS:
            continue
        forwarded_headers[key] = value

    forwarded_headers["X-Forwarded-For"] = client_ip
    forwarded_headers["X-Forwarded-Proto"] = "https"
    return forwarded_headers


def _start_https_proxy_server(
    *,
    host: str,
    https_port: int,
    backend_host: str,
    backend_port: int,
    ssl_certfile: str,
    ssl_keyfile: str,
) -> None:
    ProxyHandler = make_proxy_handler(
        backend_host=backend_host, backend_port=backend_port,
        forward_headers=_build_https_proxy_forward_headers,
    )

    _evict_processes_listening_on_port(port=https_port)
    server = _HttpsProxyServer((host, https_port), ProxyHandler)
    server.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=ssl_certfile, keyfile=ssl_keyfile)
    server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)

    def _run() -> None:
        server.serve_forever()

    link = f"https://{host}:{https_port}"
    print(f"MetaList HTTPS listener: {link}")
    thread = threading.Thread(target=_run, name="metalist-https-proxy", daemon=True)
    thread.start()
    return _StartedHttpsProxy(server=server, thread=thread)

def main(argv: list[str]) -> None:
    # Configure logging to filter noisy polling endpoints
    logging.getLogger("uvicorn.access").addFilter(FilterCheckUpdates())
    _record_self_executable_for_namespace_launch()
    _run_startup_sanity_gates(repo_root=Path(__file__).resolve().parent)
    _run_startup_encryption_audit(
        namespaces_directory=resolve_namespaces_directory(),
    )
    original_environ = dict(os.environ)
    if _should_bootstrap_all_namespaces_without_cli_parse(
        argv=argv,
        original_environ=original_environ,
    ):
        if argv == ["--enable-shell"]:
            enable_shell_execution_for_launch(environ=os.environ)
            _print_shell_execution_enabled_banner()
        _bootstrap_default_namespace_if_empty(environ=os.environ)
        _prompt_for_missing_namespace_launch_profiles(environ=os.environ)
        launch_results = open_or_launch_all_namespaces(environ=os.environ)
        _print_namespace_bootstrap_results(environ=os.environ, launch_results=launch_results)
        return
    cli_args = apply_main_cli_args_to_environ(argv=argv, environ=os.environ)
    if cli_args.shell_enabled:
        _print_shell_execution_enabled_banner()
    if _should_open_or_launch_all_namespaces(
        original_environ=original_environ,
        cli_args=cli_args,
    ):
        ensure_default_tls_pair(environ=os.environ)
        launch_results = open_or_launch_all_namespaces(environ=os.environ)
        _print_namespace_bootstrap_results(environ=os.environ, launch_results=launch_results)
        return
    _run_namespace_server_for_current_env(argv=argv)


def cli() -> None:
    argv = sys.argv[1:]
    if ORCHESTRATED_CHILD_ENV_NAME in os.environ:
        orchestrated_child = os.environ[ORCHESTRATED_CHILD_ENV_NAME]
        if orchestrated_child != "1":
            raise RuntimeError(f"{ORCHESTRATED_CHILD_ENV_NAME} must be '1' when set")
        del os.environ[ORCHESTRATED_CHILD_ENV_NAME]
        run_orchestrated_namespace_server(argv)
        return
    if len(argv) != 0 and argv[0] == "update":
        if argv != ["update"]:
            raise RuntimeError("Usage: metalist update")
        metalist_executable = _resolve_current_entrypoint()
        if metalist_executable is None:
            raise RuntimeError("Could not resolve the installed MetaList executable")
        result = schedule_self_update(
            current_version=__version__,
            metalist_executable=metalist_executable,
            current_pid=os.getpid(),
            platform_name=sys.platform,
            environ=os.environ,
        )
        print(result.message)
        return
    main(argv)


def run_namespace_server(argv: list[str]) -> None:
    logging.getLogger("uvicorn.access").addFilter(FilterCheckUpdates())
    _run_startup_encryption_audit(
        namespaces_directory=resolve_namespaces_directory(),
    )
    apply_main_cli_args_to_environ(argv=argv, environ=os.environ)
    _run_namespace_server_for_current_env(argv=argv)


def run_orchestrated_namespace_server(argv: list[str]) -> None:
    logging.getLogger("uvicorn.access").addFilter(FilterCheckUpdates())
    apply_main_cli_args_to_environ(argv=argv, environ=os.environ)
    _run_namespace_server_for_current_env(argv=argv)


def _run_namespace_server_for_current_env(*, argv: list[str]) -> None:
    database_runtime_config = resolve_database_runtime_config(
        environ=os.environ,
        argv=argv,
    )
    if not database_runtime_config.test_mode:
        prepare_database_runtime_path(database_path=database_runtime_config.database_path)
        ensure_default_tls_pair(environ=os.environ)

    main_server_config = resolve_main_server_config(environ=os.environ)
    from app.main import app as metalist_app
    print(
        "MetaList resolved config: "
        f"namespace={database_runtime_config.namespace!r} "
        f"database={database_runtime_config.database_path.expanduser()} "
        f"host={main_server_config.host} "
        f"http_port={main_server_config.port} "
        f"https_port={main_server_config.https_port} "
        f"shell_enabled={is_shell_execution_enabled()} "
        f"ssl_certfile={main_server_config.ssl_certfile!r} "
        f"ssl_keyfile={main_server_config.ssl_keyfile!r}"
    )
    if main_server_config.https_port is not None:
        assert main_server_config.ssl_certfile is not None
        assert main_server_config.ssl_keyfile is not None
        _start_https_proxy_server(
            host=main_server_config.host,
            https_port=main_server_config.https_port,
            backend_host=resolve_backend_connect_host(host=main_server_config.host),
            backend_port=main_server_config.port,
            ssl_certfile=main_server_config.ssl_certfile,
            ssl_keyfile=main_server_config.ssl_keyfile,
        )
        print(
            f"MetaList HTTP listener: http://{main_server_config.host}:{main_server_config.port}"
        )
    print(
        "MetaList local URL: "
        f"http://{resolve_local_browser_host(host=main_server_config.host)}:{main_server_config.port}"
    )
    _run_main_listener(
        app_object=metalist_app,
        host=main_server_config.host,
        port=main_server_config.port,
        proxy_headers=main_server_config.proxy_headers,
        forwarded_allow_ips=main_server_config.forwarded_allow_ips,
        ssl_certfile=None,
        ssl_keyfile=None,
    )


if __name__ == "__main__":
    main(sys.argv[1:])
