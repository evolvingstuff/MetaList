"""Run the real updater against a local release index and disposable uv installation.

The ordinary old-version fixture contains the candidate's updater. The Windows
repair variant uses the published 0.7.1 wheel, changing only its release-metadata
URL to our disposable index, and invokes the extracted standalone repair ZIP.
"""
from __future__ import annotations

from http import HTTPStatus
import base64
import csv
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import urlopen
import zipfile

import httpx

from app.services.exception_capture import CapturedExceptionContext


_SMOKE_SPEC = importlib.util.spec_from_file_location("installed_smoke", Path(__file__).with_name("smoke_installed_package.py"))
assert _SMOKE_SPEC is not None and _SMOKE_SPEC.loader is not None
smoke = importlib.util.module_from_spec(_SMOKE_SPEC)
_SMOKE_SPEC.loader.exec_module(smoke)
_REPAIR_SPEC = importlib.util.spec_from_file_location("repair_archive", Path(__file__).with_name("build_windows_update_repair.py"))
assert _REPAIR_SPEC is not None and _REPAIR_SPEC.loader is not None
repair_archive = importlib.util.module_from_spec(_REPAIR_SPEC)
_REPAIR_SPEC.loader.exec_module(repair_archive)
REPAIR_BASELINE_VERSION = "0.7.1"
REPAIR_BASELINE_URL = "https://files.pythonhosted.org/packages/05/a1/11778f70740ff305d47c2e194b267f3ec6e57f0db0b2c25a19f7072ec47e/metalist-0.7.1-py3-none-any.whl"
REPAIR_BASELINE_SHA256 = "3e14d8d0d16408e4092cbf10a37432c0c19c71a8bc1867e9a67bacc7fe7d8137"
# sys.version_info[:N] is (major, minor), the interpreter an update must keep.
_MAJOR_MINOR_PARTS = 2
_BROWSER_RELOADS = 2
# Command line: script, wheel path, optional --repair.
_ARGC_WITHOUT_REPAIR = 2
_ARGC_WITH_REPAIR = 3
_REPAIR_FLAG_INDEX = 2
_BASELINE_DOWNLOAD_TIMEOUT_SECONDS = 120
_TOOL_INSTALL_TIMEOUT_SECONDS = 600
_FIRST_START_TIMEOUT_SECONDS = 300
_UPDATE_TIMEOUT_SECONDS = 600
_UPDATED_NAMESPACES_READY_TIMEOUT_SECONDS = 300
_READY_POLL_INTERVAL_SECONDS = 0.5
_INDEX_THREAD_JOIN_TIMEOUT_SECONDS = 5
# How much of the end of the update log to print.
_LOG_TAIL_CHARACTERS = 20000


def _path_without_uv(path_value: str) -> str:
    retained = []
    if os.name == "nt":
        executable_name = "uv.exe"
    else:
        executable_name = "uv"
    for directory_text in path_value.split(os.pathsep):
        assert directory_text != "", "Release smoke PATH entries must be explicit"
        if (Path(directory_text) / executable_name).is_file():
            continue
        retained.append(directory_text)
    assert retained, "Release smoke requires a PATH after removing global uv"
    filtered = os.pathsep.join(retained)
    assert shutil.which("uv", path=filtered) is None
    return filtered


def _old_version_fixture(wheel: Path, directory: Path, metadata_url: str, *, repair: bool) -> Path:
    version = importlib.metadata.version("metalist")
    fixture_version = "0.0.0"
    wheel_body = wheel.read_bytes()
    if repair:
        with urlopen(REPAIR_BASELINE_URL, timeout=_BASELINE_DOWNLOAD_TIMEOUT_SECONDS) as response:
            wheel_body = response.read()
        assert hashlib.sha256(wheel_body).hexdigest() == REPAIR_BASELINE_SHA256
        version = fixture_version = REPAIR_BASELINE_VERSION
    with zipfile.ZipFile(io.BytesIO(wheel_body)) as archive:
        members = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/RECORD")}
    if not repair:
        members = {name.replace(f"metalist-{version}", f"metalist-{fixture_version}"): body for name, body in members.items()}
        metadata = f"metalist-{fixture_version}.dist-info/METADATA"
        members[metadata] = members[metadata].replace(f"Version: {version}\n".encode(), b"Version: 0.0.0\n", 1)
        members["app/version.py"] = b'__version__ = "0.0.0"\n'
    updater = "app/services/self_update.py"
    assert members[updater].count(b'https://pypi.org/pypi/metalist/json') == 1
    members[updater] = members[updater].replace(b'https://pypi.org/pypi/metalist/json', metadata_url.encode())
    record = io.StringIO(newline="")
    writer = csv.writer(record)
    for name, body in members.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b"=").decode()
        writer.writerow((name, "sha256=" + digest, len(body)))
    record_name = f"metalist-{fixture_version}.dist-info/RECORD"
    writer.writerow((record_name, "", ""))
    members[record_name] = record.getvalue().encode()
    fixture = directory / f"metalist-{fixture_version}-py3-none-any.whl"
    with zipfile.ZipFile(fixture, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, body in members.items():
            archive.writestr(name, body)
    return fixture


def _has_updated_namespace(*, port: int, namespace: str, version: str) -> bool:
    probe_capture = CapturedExceptionContext(
        httpx.HTTPError,
        boundary='scripts/smoke_self_update.py:_has_updated_namespace:probe_capture',
    )
    with probe_capture:
        response = httpx.get(
            f"http://127.0.0.1:{port}/api2/auth/status", timeout=1, trust_env=False,
            headers={"X-Metalist-Tab-Id": "00000000-0000-4000-8000-000000000001"},
        )
    if probe_capture.captured_exception is not None:
        return False  # Expected while this disposable server is restarting.
    if response.status_code != HTTPStatus.OK:
        return False
    status = response.json()
    return status["namespace"] == namespace and status["version"] == version


def _repair_command(directory: Path) -> list[str]:
    assert sys.platform == "win32", "Repair launcher requires Windows"
    archive_path = directory / "repair.zip"
    repair_archive.build_repair_archive(archive_path)
    extracted = directory / "Repair MetaList"
    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(extracted)  # The archive was built from this checkout above.
    return ["cmd.exe", "/d", "/c", str(extracted / "Repair-MetaList.cmd")]


def run(wheel: Path, *, repair: bool) -> None:
    assert sys.flags.isolated, "Use python -I"
    assert not repair or sys.platform == "win32", "Repair launcher requires Windows"
    uv = shutil.which("uv")
    assert uv is not None
    version = importlib.metadata.version("metalist")
    old_version = "0.0.0"
    if repair:
        old_version = REPAIR_BASELINE_VERSION
    wheel_body = wheel.read_bytes()
    digest = hashlib.sha256(wheel_body).hexdigest()

    class Index(BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            if self.path == "/pypi/metalist/json":
                body = json.dumps({"info": {"version": version}}).encode()
                content_type = "application/json"
            elif self.path == "/simple/metalist/":
                body = f'<a href="/{wheel.name}#sha256={digest}">{wheel.name}</a>'.encode()
                content_type = "text/html"
            elif self.path == "/" + wheel.name:
                body = wheel_body
                content_type = "application/octet-stream"
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def log_message(self, *args):  # shockharness: ignore[STUB001] reason="the empty override silences the test server's request log"
            pass

    with tempfile.TemporaryDirectory(prefix="metalist-update-smoke-") as temporary, ThreadingHTTPServer(("127.0.0.1", 0), Index) as index:
        directory = Path(temporary)
        launch_directory = directory.parent
        index_url = f"http://127.0.0.1:{index.server_port}"
        thread = threading.Thread(target=index.serve_forever, daemon=True)
        thread.start()
        environment = {
            key: value for key, value in os.environ.items()
            if not key.startswith(("METALIST_", "UV_", "UVICORN_", "SECURITY_", "PYTHON"))
            and key not in {"TEST_MODE", "API_PREFIX", "V1_API_PREFIX", "SQL_TRACE", "VIRTUAL_ENV"}
        }
        environment.update(
            UV_TOOL_DIR=str(directory / "tools"), UV_TOOL_BIN_DIR=str(directory / "bin"),
            UV_INDEX=index_url + "/simple", METALIST_DATA_DIRECTORY=str(directory / "data"),
            METALIST_ENVIRONMENT="production", PYTHONUNBUFFERED="1", PYTHONUTF8="1", TEST_MODE="0",
        )
        if sys.platform == "linux":
            environment["XDG_CACHE_HOME"] = str(directory / "cache")
        elif sys.platform == "darwin":
            environment["HOME"] = str(directory / "home")
        fixture = _old_version_fixture(wheel, directory, index_url + "/pypi/metalist/json", repair=repair)
        executable = directory / "bin" / ("metalist.exe" if os.name == "nt" else "metalist")
        environment["PATH"] = str(executable.parent) + os.pathsep + environment["PATH"]
        if sys.platform == "win32":
            environment["LOCALAPPDATA"] = str(directory / "local-app-data")
        update_command = [str(executable), "update"]
        if repair:
            update_command = _repair_command(directory)
        profiles = smoke._profiles_with_free_ports()
        log_path = directory / "update.log"
        with log_path.open("w", encoding="utf-8") as log:
            try:
                subprocess.run([uv, "tool", "install", "--python", sys._base_executable, str(fixture)],
                               env=environment, cwd=launch_directory, stdout=log, stderr=subprocess.STDOUT, check=True,
                               timeout=_TOOL_INSTALL_TIMEOUT_SECONDS)
                if not repair:
                    environment["PATH"] = _path_without_uv(environment["PATH"])
                smoke._seed_namespaces(directory=launch_directory, environment=environment, profiles=profiles)
                subprocess.run([str(executable)], env=environment, cwd=launch_directory, stdout=log,
                               stderr=subprocess.STDOUT, check=True, timeout=_FIRST_START_TIMEOUT_SECONDS)
                certificate = directory / 'data/certs/metalist-cert.pem'
                tls_context = ssl.create_default_context(cafile=str(certificate))
                for namespace, port, https_port in profiles:
                    smoke._verify_namespace(host="127.0.0.1", namespace=namespace, http_port=port, https_port=https_port,
                                            version=old_version, tls_context=tls_context)
                lan_host = smoke._verify_remembered_network_settings(
                    executable=executable, environment=environment, directory=launch_directory,
                    profiles=profiles, version=old_version, tls_context=tls_context, log=log)
                subprocess.run(update_command, env=environment, cwd=launch_directory, stdout=log,
                               stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, check=True,
                               timeout=_UPDATE_TIMEOUT_SECONDS)
                if sys.platform == "win32":
                    managed_installers = list(
                        (directory / "local-app-data/MetaList/update-tools").glob("uv-*/uv.exe")
                    )
                elif sys.platform == "darwin":
                    managed_installers = list(
                        (directory / "home/Library/Caches/MetaList/update-tools").glob("uv-*/uv")
                    )
                else:
                    managed_installers = list(
                        (directory / "cache/metalist/update-tools").glob("uv-*/uv")
                    )
                assert managed_installers, "The update must use MetaList's managed uv"
                deadline = time.monotonic() + _UPDATED_NAMESPACES_READY_TIMEOUT_SECONDS
                while time.monotonic() < deadline:
                    ready = 0
                    for namespace, port, _ in profiles:
                        if _has_updated_namespace(port=port, namespace=namespace, version=version):
                            ready += 1
                    if ready == len(profiles):
                        break
                    time.sleep(_READY_POLL_INTERVAL_SECONDS)
                else:
                    raise AssertionError("Updated namespaces did not become ready")
                for namespace, port, https_port in profiles:
                    smoke._verify_namespace(host="127.0.0.1", namespace=namespace, http_port=port, https_port=https_port,
                                            version=version, tls_context=tls_context)
                    smoke._verify_namespace(host=lan_host, namespace=namespace, http_port=port, https_port=https_port,
                                            version=version, tls_context=tls_context)
                    assert list((directory / "data/namespaces" / namespace / "backups").glob("*.metalist-backup.tar.gz"))
                scripts = directory / "tools/metalist" / ("Scripts" if os.name == "nt" else "bin")
                python = scripts / ("python.exe" if os.name == "nt" else "python")
                identity = subprocess.check_output([str(python), "-I", "-c", "import sys,json; print(json.dumps(list(sys.version_info[:2])))"], text=True)
                assert json.loads(identity) == list(sys.version_info[:_MAJOR_MINOR_PARTS]), identity
                if repair:
                    for browser_name in ('chrome', 'firefox'):
                        smoke._verify_browser_startup(
                            certificate=certificate, host='127.0.0.1', profiles=profiles,
                            browser_name=browser_name, use_https=False,
                            cold_runs=1, reloads=_BROWSER_RELOADS, validate_encrypted_login=True,
                        )
                    smoke._verify_browser_startup(
                        certificate=certificate, host=lan_host, profiles=profiles,
                        browser_name='edge', use_https=True,
                        cold_runs=1, reloads=_BROWSER_RELOADS, validate_encrypted_login=True,
                    )
                print(f"Real uv update, backups, offline installation, interpreter preservation, and two-namespace restart passed on {sys.platform} Python {sys.version.split()[0]}.")
            finally:
                log.flush()
                print(log_path.read_text(encoding="utf-8", errors="replace")[-_LOG_TAIL_CHARACTERS:])
                try:
                    smoke._stop_namespace_children(executable=executable, profiles=profiles)
                finally:
                    if repair:
                        smoke._preserve_browser_server_diagnostics(
                            startup_log=log_path, data_directory=directory / 'data',
                        )
                    index.shutdown()
                    thread.join(timeout=_INDEX_THREAD_JOIN_TIMEOUT_SECONDS)


if __name__ == "__main__":
    assert len(sys.argv) in (_ARGC_WITHOUT_REPAIR, _ARGC_WITH_REPAIR), "Expected built wheel path and optional --repair"
    is_repair = len(sys.argv) == _ARGC_WITH_REPAIR
    if is_repair:
        assert sys.argv[_REPAIR_FLAG_INDEX] == "--repair"
    run(Path(sys.argv[1]).resolve(), repair=is_repair)
