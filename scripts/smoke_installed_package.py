"""Exercise the installed CLI and namespace children against disposable data."""
from __future__ import annotations

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


def _request(port: int, path: str, *, use_https: bool, tls_context: ssl.SSLContext) -> bytes:
    if use_https:
        connection = http.client.HTTPSConnection("127.0.0.1", port, timeout=5, context=tls_context)
    else:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", path, headers={"X-Metalist-Tab-Id": "00000000-0000-4000-8000-000000000001"})
        response = connection.getresponse()
        body = response.read()
        assert response.status == 200, f"{path}: HTTP {response.status}: {body[:500]!r}"
        return body
    finally:
        connection.close()


def _profiles_with_free_ports() -> list[tuple[str, int, int]]:
    profiles = []
    identity = uuid4().hex
    with ExitStack() as reservations:
        for suffix in ("first", "second"):
            ports = []
            for _ in range(2):
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
        cwd=directory, env=environment, check=True, timeout=30,
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
            capture_output=True, encoding="utf-8", check=True, timeout=30,
        )
        processes = [(entry["ProcessId"], entry["CommandLine"]) for entry in json.loads(completed.stdout)]
    else:
        completed = subprocess.run(
            ["ps", "-axww", "-o", "pid=,args="], capture_output=True,
            encoding="utf-8", errors="replace", check=True, timeout=10,
        )
        processes = []
        for line in completed.stdout.splitlines():
            fields = line.strip().split(maxsplit=1)
            if len(fields) == 2:
                processes.append((int(fields[0]), fields[1]))
    owned_pids = set()
    for pid, command in processes:
        if not command or str(executable).casefold() not in command.casefold():
            continue
        if any(re.search(rf"(?:^|\s)--namespace\s+{re.escape(namespace)}(?:\s|$)", command) for namespace, _, _ in profiles):
            owned_pids.add(pid)
    return owned_pids


def _stop_namespace_children(*, executable: Path, profiles: list[tuple[str, int, int]]) -> None:
    # Require both the installed executable and this run's unpredictable namespace
    # identities. A process is never terminated merely for owning a selected port.
    owned_pids = _namespace_processes(executable=executable, profiles=profiles)
    for pid in owned_pids:
        with suppress(ProcessLookupError):
            os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if not _namespace_processes(executable=executable, profiles=profiles):
            return
        time.sleep(0.2)
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
    deadline = time.monotonic() + 2
    previous_sizes = fault_sizes.copy()
    stable_samples = 0
    while fault_sizes and time.monotonic() < deadline:
        time.sleep(0.1)
        current_sizes = {path: path.stat().st_size for path in fault_sizes}
        if current_sizes == previous_sizes and all(current_sizes[path] > size for path, size in fault_sizes.items()):
            stable_samples += 1
        else:
            stable_samples = 0
        if stable_samples >= 3:
            break
        previous_sizes = current_sizes
    for fault_path in sorted(fault_sizes):
        print(f"Namespace failure stack: {fault_path}")
        print(fault_path.read_text(encoding="utf-8", errors="replace"))


def _verify_asset_batch(*, port: int, use_https: bool, tls_context: ssl.SSLContext, assets: list[tuple[str, bytes]]) -> None:
    if use_https:
        connection = http.client.HTTPSConnection('127.0.0.1', port, context=tls_context, timeout=10)
    else:
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    try:
        connection.connect()
        original_socket = connection.sock
        assert original_socket is not None
        for _ in range(3):
            for path, expected in assets:
                connection.request('GET', path, headers={'Accept-Encoding': 'gzip'})
                response = connection.getresponse()
                body = response.read()
                assert response.status == 200, f'{path}: HTTP {response.status}'
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
    assert len(assets) >= 6, 'Installed application has too few startup assets'
    for port, use_https in ((http_port, False), (https_port, True)):
        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = [executor.submit(_verify_asset_batch, port=port, use_https=use_https,
                                       tls_context=tls_context, assets=assets[index::6])
                       for index in range(6)]
            for future in futures:
                future.result()
    print(f'PASS {len(assets)} installed assets, HTTP and verified HTTPS, six connections, three passes')


def _verify_namespace(*, namespace: str, http_port: int, https_port: int, version: str, tls_context: ssl.SSLContext) -> None:
    for port, use_https in ((http_port, False), (https_port, True)):
        status = json.loads(_request(port, "/api2/auth/status", use_https=use_https, tls_context=tls_context))
        assert status["cache_ready"] is True, status
        assert status["has_password"] is False, status
        assert status["namespace"] == namespace, status
        assert status["version"] == version, status
        assert b"<!doctype html" in _request(port, "/", use_https=use_https, tls_context=tls_context).lower()


def _verify_edge_startup(*, directory: Path, certificate: Path, host: str, profiles: list[tuple[str, int, int]]) -> None:
    assert os.name == 'nt', 'Edge release validation must run on Windows'
    edge_paths = [Path(os.environ[name]) / 'Microsoft/Edge/Application/msedge.exe'
                  for name in ('ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA') if name in os.environ]
    installed_edge_paths = [path for path in edge_paths if path.is_file()]
    assert installed_edge_paths, 'Required Microsoft Edge executable is missing'
    executable = installed_edge_paths[0]
    node = shutil.which('node')
    assert node is not None, 'Required Node runtime for Edge validation is missing'
    output_directory = Path(os.environ['RUNNER_TEMP']) / 'metalist-edge-results'
    certificate_der = ssl.PEM_cert_to_DER_cert(certificate.read_text(encoding='ascii'))
    thumbprint = hashlib.sha1(certificate_der, usedforsecurity=False).hexdigest()
    # Trust only this run's generated certificate; remove it even if Edge fails.
    subprocess.run(['certutil', '-user', '-addstore', 'Root', str(certificate)], check=True, timeout=30)
    try:
        script = Path(__file__).resolve().parent / 'browser-validation' / 'edge-startup.mjs'
        urls = [f'https://{host}:{https_port}' for _, _, https_port in profiles]
        subprocess.run([node, str(script), str(executable), str(output_directory), *urls],
                       cwd=directory, check=True, timeout=240)
    finally:
        subprocess.run(['certutil', '-user', '-delstore', 'Root', thumbprint], check=True, timeout=30)


def smoke_installed_package(*, require_edge: bool) -> None:
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
        and key not in {"TEST_MODE", "API_PREFIX", "V1_API_PREFIX", "SQL_TRACE", "STARTUP_ANIMATION_ENABLED"}
    }
    environment.update(TEST_MODE="0", METALIST_ENVIRONMENT="production", PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    browser_host = '127.0.0.1'
    if require_edge:
        browser_host = socket.gethostbyname(socket.gethostname())
        assert not browser_host.startswith('127.'), 'Edge gate requires a non-loopback IPv4 address'
        environment.update(METALIST_HOST='0.0.0.0', METALIST_ALLOWED_HOSTS=browser_host, METALIST_LAN_IP=browser_host)
    profiles = _profiles_with_free_ports()
    with tempfile.TemporaryDirectory(prefix="metalist-installed-smoke-") as temporary_directory:
        directory = Path(temporary_directory)
        data_directory = directory / "Données MetaList"
        environment["METALIST_DATA_DIRECTORY"] = str(data_directory)
        environment["METALIST_SELF_EXECUTABLE"] = str(executable)
        _seed_namespaces(directory=directory, environment=environment, profiles=profiles)
        _assert_ports_are_free(profiles)
        log_path = directory / "startup.log"
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [str(executable)], cwd=directory, env=environment,
                stdout=log, stderr=subprocess.STDOUT,
            )
            is_successful = False
            try:
                assert process.wait(timeout=120) == 0, "Installed CLI namespace startup failed"
                certificate = data_directory / 'certs' / 'metalist-cert.pem'
                tls_context = ssl.create_default_context(cafile=str(certificate))
                for namespace, http_port, https_port in profiles:
                    _verify_namespace(namespace=namespace, http_port=http_port, https_port=https_port,
                                      version=distribution.version, tls_context=tls_context)
                    _verify_installed_assets(static_directory=installed_app.parent / 'static', http_port=http_port,
                                             https_port=https_port, tls_context=tls_context)
                if require_edge:
                    _verify_edge_startup(directory=directory, certificate=certificate, host=browser_host, profiles=profiles)
                is_successful = True
            finally:
                if process.poll() is None:
                    process.terminate()
                    deadline = time.monotonic() + 10
                    while process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.1)
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=10)
                if not is_successful:
                    _dump_failed_namespace_stacks(executable=executable, profiles=profiles, data_directory=data_directory)
                log.flush()
                print(log_path.read_text(encoding="utf-8", errors="replace"))
                for child_log in sorted((data_directory / "logs").glob("namespace-*.log")):
                    print(child_log.read_text(encoding="utf-8", errors="replace"))
                _stop_namespace_children(executable=executable, profiles=profiles)
    print(f"Installed MetaList {distribution.version} CLI and two HTTP/HTTPS namespaces passed on {sys.platform}, Python {sys.version.split()[0]}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--edge', action='store_true', help='Require real Edge startup over a non-loopback HTTPS address')
    smoke_installed_package(require_edge=parser.parse_args().edge)
