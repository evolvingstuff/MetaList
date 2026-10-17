"""Exercise the installed CLI and namespace children against disposable data."""
from __future__ import annotations

from http import HTTPStatus
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, suppress
import gzip
import hashlib
import http.client
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import sysconfig
import tempfile
import time
from uuid import uuid4

from app.services.exception_capture import CapturedExceptionContext

PORTS_PER_PROFILE = 2  # HTTP and HTTPS
PS_TIMEOUT_SECONDS = 10
PS_FIELD_COUNT = 2  # pid=,args=
FAULT_STACK_WAIT_SECONDS = 2
FAULT_LOG_STABLE_SAMPLES = 3
ASSET_CONNECTION_TIMEOUT_SECONDS = 10
# Each asset is fetched this many times over one kept-alive connection.
ASSET_BATCH_ROUNDS = 3
JSON_INDENT = 2
SERVER_TERMINATE_GRACE_SECONDS = 10
SERVER_EXIT_WAIT_SECONDS = 10
SERVER_EXIT_POLL_SECONDS = 0.1
REQUEST_TIMEOUT_SECONDS = 5
ERROR_BODY_PREVIEW_BYTES = 500
SEED_NAMESPACES_TIMEOUT_SECONDS = 30
POWERSHELL_TIMEOUT_SECONDS = 30
NAMESPACE_STOP_TIMEOUT_SECONDS = 15
NAMESPACE_STOP_POLL_SECONDS = 0.2
FAULT_LOG_POLL_SECONDS = 0.1
# Parallel kept-alive connections, each fetching an interleaved share of the
# assets; at least this many assets are needed for every connection to carry one.
ASSET_CONNECTION_COUNT = 6
CERTUTIL_TIMEOUT_SECONDS = 30
BROWSER_STARTUP_TIMEOUT_SECONDS = 240
# Any port works for the route probe: connecting a UDP socket sends nothing.
ROUTE_PROBE_PORT = 80
CLI_RUN_TIMEOUT_SECONDS = 180
NAMESPACE_STARTUP_TIMEOUT_SECONDS = 120


def _request(port: int, path: str, *, host: str, use_https: bool, tls_context: ssl.SSLContext) -> bytes:
    if use_https:
        connection = http.client.HTTPSConnection(host, port, timeout=REQUEST_TIMEOUT_SECONDS, context=tls_context)
    else:
        connection = http.client.HTTPConnection(host, port, timeout=REQUEST_TIMEOUT_SECONDS)
    try:
        connection.request("GET", path, headers={"X-Metalist-Tab-Id": "00000000-0000-4000-8000-000000000001"})
        response = connection.getresponse()
        body = response.read()
        assert response.status == HTTPStatus.OK, f"{path}: HTTP {response.status}: {body[:ERROR_BODY_PREVIEW_BYTES]!r}"
        return body
    finally:
        connection.close()


def _profiles_with_free_ports() -> list[tuple[str, int, int]]:
    profiles = []
    identity = uuid4().hex
    with ExitStack() as reservations:
        for suffix in ("first", "second"):
            ports = []
            for _ in range(PORTS_PER_PROFILE):
                listener = reservations.enter_context(socket.socket())
                listener.bind(("127.0.0.1", 0))
                ports.append(listener.getsockname()[1])
            profiles.append((f"release-smoke-{identity}-{suffix}", ports[0], ports[1]))
    return profiles


def _assert_ports_are_free(profiles: list[tuple[str, int, int]]) -> None:
    with ExitStack() as reservations:
        for _, http_port, https_port in profiles:
            for port in (http_port, https_port):
                listener = reservations.enter_context(socket.socket())
                listener.bind(("127.0.0.1", port))


def _seed_namespaces(*, directory: Path, environment: dict[str, str], profiles: list[tuple[str, int, int]]) -> None:
    subprocess.run(
        [sys.executable, "-I", "-X", "utf8", "-c", (
            "import json, sys\n"
            "from app.server_runtime import save_namespace_launch_profile\n"
            "for namespace, http_port, https_port in json.loads(sys.argv[1]):\n"
            "    save_namespace_launch_profile(namespace=namespace, port=http_port, https_port=https_port, mcp_port=None)\n"
        ), json.dumps(profiles)],
        cwd=directory, env=environment, check=True, timeout=SEED_NAMESPACES_TIMEOUT_SECONDS,
    )


def _namespace_processes(*, executable: Path, profiles: list[tuple[str, int, int]]) -> set[int]:
    if os.name == "nt":
        powershell = shutil.which("powershell.exe")
        if powershell is None:
            powershell = shutil.which("pwsh.exe")
        assert powershell is not None, "PowerShell is required for Windows namespace cleanup"
        completed = subprocess.run(
            [powershell, "-NoProfile", "-NonInteractive", "-Command", (
                "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); "
                "@(Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress"
            )],
            capture_output=True, encoding="utf-8", check=True, timeout=POWERSHELL_TIMEOUT_SECONDS,
        )
        processes = [(entry["ProcessId"], entry["CommandLine"]) for entry in json.loads(completed.stdout)]
    else:
        completed = subprocess.run(
            ["ps", "-axww", "-o", "pid=,args="], capture_output=True,
            encoding="utf-8", errors="replace", check=True, timeout=PS_TIMEOUT_SECONDS,
        )
        processes = []
        for line in completed.stdout.splitlines():
            fields = line.strip().split(maxsplit=1)
            if len(fields) == PS_FIELD_COUNT:
                processes.append((int(fields[0]), fields[1]))
    owned_pids = set()
    for pid, command in processes:
        if not command or str(executable).casefold() not in command.casefold():
            continue
        if any(re.search(rf"(?:^|\s)--namespace\s+{re.escape(namespace)}(?:\s|$)", command) for namespace, _, _ in profiles):
            owned_pids.add(pid)
    return owned_pids


def _terminate_on_windows(pid: int) -> None:
    """A process that is already exiting refuses termination on Windows with
    "Access is denied" (WinError 5) rather than reporting itself gone. The caller's
    wait still fails loudly if it does not actually stop."""
    exit_capture = CapturedExceptionContext(
        ProcessLookupError,
        PermissionError,
        boundary='scripts/smoke_installed_package.py:_terminate_on_windows:exit_capture',
    )
    with exit_capture:
        os.kill(pid, signal.SIGTERM)


def _stop_namespace_children(*, executable: Path, profiles: list[tuple[str, int, int]]) -> None:
    # Require both the installed executable and this run's unpredictable namespace
    # identities. A process is never terminated merely for owning a selected port.
    owned_pids = _namespace_processes(executable=executable, profiles=profiles)
    for pid in owned_pids:
        if os.name == "nt":
            _terminate_on_windows(pid)
            continue
        with suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + NAMESPACE_STOP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not _namespace_processes(executable=executable, profiles=profiles):
            return
        time.sleep(NAMESPACE_STOP_POLL_SECONDS)
    raise RuntimeError(f"Smoke namespace processes did not stop: {sorted(owned_pids)}")


def _dump_failed_namespace_stacks(*, executable: Path, profiles: list[tuple[str, int, int]], data_directory: Path) -> None:
    if sys.platform != "darwin":
        return
    owned_pids = _namespace_processes(executable=executable, profiles=profiles)
    fault_sizes = {}
    for namespace, _, _ in profiles:
        log_path = data_directory / "logs" / f"{namespace}-server.log"
        if not log_path.is_file():
            continue
        # This message is emitted only after configure_process_diagnostics has
        # registered SIGUSR1. Sending it before registration would kill a child.
        registered_pids = set()
        for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if "[diagnostics] process diagnostics enabled " not in line:
                continue
            match = re.search(r"\bpid=(\d+)\b", line)
            if match is not None:
                registered_pids.add(int(match.group(1)))
        fault_path = data_directory / "logs" / f"{namespace}-server.fault.log"
        for pid in owned_pids & registered_pids:
            fault_sizes[fault_path] = fault_path.stat().st_size
            with suppress(ProcessLookupError):
                os.kill(pid, signal.SIGUSR1)
    deadline = time.monotonic() + FAULT_STACK_WAIT_SECONDS
    previous_sizes = fault_sizes.copy()
    stable_samples = 0
    while fault_sizes and time.monotonic() < deadline:
        time.sleep(FAULT_LOG_POLL_SECONDS)
        current_sizes = {path: path.stat().st_size for path in fault_sizes}
        if current_sizes == previous_sizes and all(current_sizes[path] > size for path, size in fault_sizes.items()):
            stable_samples += 1
        else:
            stable_samples = 0
        if stable_samples >= FAULT_LOG_STABLE_SAMPLES:
            break
        previous_sizes = current_sizes
    for fault_path in sorted(fault_sizes):
        print(f"Namespace failure stack: {fault_path}")
        print(fault_path.read_text(encoding="utf-8", errors="replace"))


def _verify_asset_batch(*, port: int, use_https: bool, tls_context: ssl.SSLContext, assets: list[tuple[str, bytes]]) -> None:
    if use_https:
        connection = http.client.HTTPSConnection('127.0.0.1', port, context=tls_context, timeout=ASSET_CONNECTION_TIMEOUT_SECONDS)
    else:
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=ASSET_CONNECTION_TIMEOUT_SECONDS)
    try:
        connection.connect()
        original_socket = connection.sock
        assert original_socket is not None
        for _ in range(ASSET_BATCH_ROUNDS):
            for path, expected in assets:
                connection.request('GET', path, headers={'Accept-Encoding': 'gzip'})
                response = connection.getresponse()
                body = response.read()
                assert response.status == HTTPStatus.OK, f'{path}: HTTP {response.status}'
                encoding = response.getheader('Content-Encoding')
                assert encoding in (None, 'gzip'), f'{path}: unexpected encoding {encoding}'
                if encoding == 'gzip':
                    body = gzip.decompress(body)
                assert body == expected, f'{path}: truncated or incorrect installed asset'
                if path.endswith('.js'):
                    assert 'javascript' in response.getheader('Content-Type', ''), f'{path}: incorrect JavaScript MIME type'
                assert not response.will_close, f'{path}: server disabled HTTP/1.1 connection reuse'
                assert connection.sock is original_socket, f'{path}: unexpected reconnect'
    finally:
        connection.close()


def _verify_installed_assets(*, static_directory: Path, http_port: int, https_port: int, tls_context: ssl.SSLContext) -> None:
    assets = [('/static/' + path.relative_to(static_directory).as_posix(), path.read_bytes())
              for path in sorted(static_directory.rglob('*'))
              if path.is_file() and path.suffix in {'.js', '.css', '.json', '.ico'}]
    if len(assets) < ASSET_CONNECTION_COUNT:
        raise RuntimeError('Installed application has too few startup assets')
    for port, use_https in ((http_port, False), (https_port, True)):
        with ThreadPoolExecutor(max_workers=ASSET_CONNECTION_COUNT) as executor:
            futures = [executor.submit(_verify_asset_batch, port=port, use_https=use_https,
                                       tls_context=tls_context, assets=assets[index::ASSET_CONNECTION_COUNT])
                       for index in range(ASSET_CONNECTION_COUNT)]
            for future in futures:
                future.result()
    print(f'PASS {len(assets)} installed assets, HTTP and verified HTTPS, six connections, three passes')


def _verify_remote_http_redirect(*, host: str, http_port: int, https_port: int, path: str) -> None:
    connection = http.client.HTTPConnection(host, http_port, timeout=REQUEST_TIMEOUT_SECONDS)
    try:
        connection.request('GET', path)
        response = connection.getresponse()
        response.read()
        assert response.status == HTTPStatus.TEMPORARY_REDIRECT, f'Expected remote HTTP redirect: {response.status}'
        assert response.getheader('Location') == f'https://{host}:{https_port}{path}'
    finally:
        connection.close()


def _verify_namespace(*, host: str, namespace: str, http_port: int, https_port: int, version: str, tls_context: ssl.SSLContext) -> None:
    for port, use_https in ((http_port, False), (https_port, True)):
        if host != '127.0.0.1' and not use_https:
            for path in ('/api2/auth/status', '/'):
                _verify_remote_http_redirect(host=host, http_port=http_port, https_port=https_port, path=path)
            continue
        status = json.loads(_request(port, "/api2/auth/status", host=host, use_https=use_https, tls_context=tls_context))
        assert status["cache_ready"] is True, status
        assert status["has_password"] is False, status
        assert status["namespace"] == namespace, status
        assert status["version"] == version, status
        assert b"<!doctype html" in _request(port, "/", host=host, use_https=use_https, tls_context=tls_context).lower()


def _browser_candidates(*, browser_name: str) -> list[Path]:
    assert browser_name in {'chrome', 'firefox', 'edge'}, browser_name
    if os.name == 'nt':
        relative_paths = {
            'chrome': 'Google/Chrome/Application/chrome.exe',
            'firefox': 'Mozilla Firefox/firefox.exe',
            'edge': 'Microsoft/Edge/Application/msedge.exe',
        }
        return [
            Path(os.environ[environment_name]) / relative_paths[browser_name]
            for environment_name in ('ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA')
            if environment_name in os.environ
        ]
    if sys.platform == 'darwin':
        application_paths = {
            'chrome': '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            'firefox': '/Applications/Firefox.app/Contents/MacOS/firefox',
            'edge': '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        }
        return [Path(application_paths[browser_name])]
    executable_names = {
        'chrome': ('google-chrome', 'google-chrome-stable'),
        'firefox': ('firefox',),
        'edge': ('microsoft-edge', 'microsoft-edge-stable'),
    }
    return [Path(executable) for name in executable_names[browser_name]
            if (executable := shutil.which(name)) is not None]


def _verify_browser_startup(*, certificate: Path, host: str,
                            profiles: list[tuple[str, int, int]], browser_name: str,
                            use_https: bool, cold_runs: int, reloads: int,
                            validate_encrypted_login: bool) -> None:
    if os.environ['RUNNER_ENVIRONMENT'] != 'github-hosted':
        raise RuntimeError('Release browser validation requires a disposable GitHub-hosted runner')
    assert not use_https or os.name == 'nt', 'Browser HTTPS trust setup is currently implemented for Windows'
    assert cold_runs >= 1
    assert reloads >= 1
    assert isinstance(validate_encrypted_login, bool)
    output_directory = Path(os.environ['RUNNER_TEMP']) / 'metalist-browser-results' / browser_name
    output_directory.mkdir(parents=True, exist_ok=True)
    diagnostics = {'browser': browser_name, 'transport': 'https' if use_https else 'http',
                   'stage': 'locating browser', 'passed': False}
    trusted = False
    try:
        installed_browser_paths = [path for path in _browser_candidates(browser_name=browser_name) if path.is_file()]
        assert installed_browser_paths, f'Required {browser_name} executable is missing'
        executable = installed_browser_paths[0]
        node = shutil.which('node')
        assert node is not None, 'Required Node runtime for browser validation is missing'
        certificate_der = ssl.PEM_cert_to_DER_cert(certificate.read_text(encoding='ascii'))
        thumbprint = hashlib.sha1(certificate_der, usedforsecurity=False).hexdigest()
        if use_https:
            # The ephemeral hosted Windows VM runs as administrator. Its machine
            # store avoids the interactive confirmation required by the user store.
            diagnostics['stage'] = 'trusting generated certificate'
            subprocess.run(['certutil', '-addstore', 'Root', str(certificate)],
                           stdin=subprocess.DEVNULL, check=True, timeout=CERTUTIL_TIMEOUT_SECONDS)
            trusted = True
        diagnostics['stage'] = f'running {browser_name} startup checks'
        script = Path(__file__).resolve().parent / 'browser-validation' / 'browser-startup.mjs'
        if use_https:
            urls = [f'https://{host}:{https_port}' for _, _, https_port in profiles]
        else:
            urls = [f'http://{host}:{http_port}' for _, http_port, _ in profiles]
        # Browser helper processes can outlive the Node controller briefly on
        # Windows. Keep their inherited working directory outside the disposable
        # installed-package fixture so that delay cannot block fixture cleanup.
        if validate_encrypted_login:
            validate_login_text = '1'
        else:
            validate_login_text = '0'
        subprocess.run([
            node, str(script), browser_name, str(executable), str(output_directory),
            str(cold_runs), str(reloads), validate_login_text, *urls,
        ],
                       cwd=script.parent, check=True, timeout=BROWSER_STARTUP_TIMEOUT_SECONDS)
        diagnostics['passed'] = True
    finally:
        try:
            if trusted:
                subprocess.run(['certutil', '-delstore', 'Root', thumbprint],
                               stdin=subprocess.DEVNULL, check=True, timeout=CERTUTIL_TIMEOUT_SECONDS)
        finally:
            (output_directory / 'setup-results.json').write_text(json.dumps(diagnostics, indent=JSON_INDENT), encoding='utf-8')


def _verify_remembered_network_settings(*, executable: Path, environment: dict[str, str],
                                      directory: Path, profiles: list[tuple[str, int, int]],
                                      version: str, tls_context: ssl.SSLContext, log) -> str:
    if 'METALIST_LAN_IP' in environment:
        host = environment['METALIST_LAN_IP']
    else:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            # Match automatic certificate interface detection; no datagram is sent.
            probe.connect(('8.8.8.8', ROUTE_PROBE_PORT))
            host = probe.getsockname()[0]
    assert not host.startswith('127.'), 'LAN persistence check requires a non-loopback interface'
    configured = dict(environment, METALIST_HOST='0.0.0.0', METALIST_ALLOWED_HOSTS=host)
    subprocess.run([str(executable)], cwd=directory, env=configured,
                   stdout=log, stderr=subprocess.STDOUT, check=True, timeout=CLI_RUN_TIMEOUT_SECONDS)
    fresh = {key: value for key, value in environment.items()
             if key not in {'METALIST_HOST', 'METALIST_ALLOWED_HOSTS'}}
    subprocess.run([str(executable)], cwd=directory, env=fresh,
                   stdout=log, stderr=subprocess.STDOUT, check=True, timeout=CLI_RUN_TIMEOUT_SECONDS)
    for namespace, http_port, https_port in profiles:
        _verify_namespace(host=host, namespace=namespace, http_port=http_port, https_port=https_port,
                          version=version, tls_context=tls_context)
    print('PASS LAN HTTP/HTTPS after plain CLI restart without network environment overrides')
    return host


def _preserve_browser_server_diagnostics(*, startup_log: Path, data_directory: Path) -> None:
    results_directory = Path(os.environ['RUNNER_TEMP']) / 'metalist-browser-results' / 'server-logs'
    results_directory.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(startup_log, results_directory / 'startup.log')
    source_logs = data_directory / 'logs'
    if not source_logs.is_dir():
        (results_directory / 'server-logs-unavailable.txt').write_text(
            f'Backend log directory was not created: {source_logs}\n', encoding='utf-8',
        )
        return
    for source_log in sorted(source_logs.glob('*.log')):
        assert source_log.is_file()
        shutil.copyfile(source_log, results_directory / source_log.name)


def smoke_installed_package(*, browsers: list[str], https_browsers: list[str],
                            browser_cold_runs: int, browser_reloads: int,
                            validate_browser_login: bool) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    assert sys.flags.isolated, "Run with python -I to exclude the source checkout"
    distribution = importlib.metadata.distribution("metalist")
    app_spec = importlib.util.find_spec("app")
    assert app_spec is not None and app_spec.origin is not None
    installed_app = Path(app_spec.origin).resolve()
    assert installed_app == Path(distribution.locate_file("app/__init__.py")).resolve(), "Must test a wheel install, not an editable checkout"
    assert not installed_app.is_relative_to(Path(__file__).resolve().parents[1]), "Must test outside the source checkout"
    assert any(entry.name == "metalist" and entry.value == "main:cli" for entry in distribution.entry_points)
    executable = Path(sysconfig.get_path("scripts")) / ("metalist.exe" if os.name == "nt" else "metalist")
    assert executable.is_file(), f"Installed CLI executable is missing: {executable}"
    environment = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("METALIST_", "UVICORN_", "SECURITY_", "PYTHON"))
        and key not in {"TEST_MODE", "API_PREFIX", "V1_API_PREFIX", "SQL_TRACE"}
    }
    environment.update(TEST_MODE="0", METALIST_ENVIRONMENT="production", PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    profiles = _profiles_with_free_ports()
    with tempfile.TemporaryDirectory(prefix="metalist-installed-smoke-") as temporary_directory:
        directory = Path(temporary_directory)
        # Namespace children inherit the launcher's working directory. Keep that
        # directory outside the disposable fixture so a briefly exiting Windows
        # child cannot retain a handle that blocks fixture deletion.
        launch_directory = directory.parent
        data_directory = directory / "Données MetaList"
        environment["METALIST_DATA_DIRECTORY"] = str(data_directory)
        environment["METALIST_SELF_EXECUTABLE"] = str(executable)
        _seed_namespaces(directory=launch_directory, environment=environment, profiles=profiles)
        _assert_ports_are_free(profiles)
        log_path = directory / "startup.log"
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [str(executable)], cwd=launch_directory, env=environment,
                stdout=log, stderr=subprocess.STDOUT,
            )
            is_successful = False
            try:
                assert process.wait(timeout=NAMESPACE_STARTUP_TIMEOUT_SECONDS) == 0, "Installed CLI namespace startup failed"
                certificate = data_directory / 'certs' / 'metalist-cert.pem'
                tls_context = ssl.create_default_context(cafile=str(certificate))
                for namespace, http_port, https_port in profiles:
                    _verify_namespace(host="127.0.0.1", namespace=namespace, http_port=http_port, https_port=https_port,
                                      version=distribution.version, tls_context=tls_context)
                    _verify_installed_assets(static_directory=installed_app.parent / 'static', http_port=http_port,
                                             https_port=https_port, tls_context=tls_context)
                browser_host = _verify_remembered_network_settings(
                    executable=executable, environment=environment, directory=launch_directory,
                    profiles=profiles, version=distribution.version, tls_context=tls_context, log=log)
                for browser_name in browsers:
                    _verify_browser_startup(
                        certificate=certificate, host='127.0.0.1', profiles=profiles,
                        browser_name=browser_name, use_https=False,
                        cold_runs=browser_cold_runs, reloads=browser_reloads,
                        validate_encrypted_login=validate_browser_login,
                    )
                for browser_name in https_browsers:
                    _verify_browser_startup(
                        certificate=certificate, host=browser_host, profiles=profiles,
                        browser_name=browser_name, use_https=True,
                        cold_runs=browser_cold_runs, reloads=browser_reloads,
                        validate_encrypted_login=validate_browser_login,
                    )
                is_successful = True
            finally:
                if process.poll() is None:
                    process.terminate()
                    deadline = time.monotonic() + SERVER_TERMINATE_GRACE_SECONDS
                    while process.poll() is None and time.monotonic() < deadline:
                        time.sleep(SERVER_EXIT_POLL_SECONDS)
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=SERVER_EXIT_WAIT_SECONDS)
                if not is_successful:
                    _dump_failed_namespace_stacks(executable=executable, profiles=profiles, data_directory=data_directory)
                try:
                    _stop_namespace_children(executable=executable, profiles=profiles)
                finally:
                    log.flush()
                    print(log_path.read_text(encoding="utf-8", errors="replace"))
                    for child_log in sorted((data_directory / "logs").glob("namespace-*.log")):
                        print(child_log.read_text(encoding="utf-8", errors="replace"))
                    if browsers or https_browsers:
                        _preserve_browser_server_diagnostics(
                            startup_log=log_path, data_directory=data_directory,
                        )
    print(f"Installed MetaList {distribution.version} CLI and two HTTP/HTTPS namespaces passed on {sys.platform}, Python {sys.version.split()[0]}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', action='append', choices=('chrome', 'firefox', 'edge'), default=[])
    parser.add_argument('--https-browser', action='append', choices=('chrome', 'firefox', 'edge'), default=[])
    parser.add_argument('--browser-cold-runs', type=int, required=True)
    parser.add_argument('--browser-reloads', type=int, required=True)
    parser.add_argument('--skip-browser-login', action='store_true')
    arguments = parser.parse_args()
    assert arguments.browser_cold_runs >= 1
    assert arguments.browser_reloads >= 1
    smoke_installed_package(
        browsers=arguments.browser, https_browsers=arguments.https_browser,
        browser_cold_runs=arguments.browser_cold_runs,
        browser_reloads=arguments.browser_reloads,
        validate_browser_login=not arguments.skip_browser_login,
    )
