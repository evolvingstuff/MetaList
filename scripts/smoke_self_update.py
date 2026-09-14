"""Run the real updater against a local release index and disposable uv installation.

The old-version fixture contains the candidate's updater, so this tests the update
mechanism being released, not an already-published updater we cannot change.
"""
from __future__ import annotations

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
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

import httpx

from app.services.exception_capture import CapturedExceptionContext


_SMOKE_SPEC = importlib.util.spec_from_file_location("installed_smoke", Path(__file__).with_name("smoke_installed_package.py"))
assert _SMOKE_SPEC is not None and _SMOKE_SPEC.loader is not None
smoke = importlib.util.module_from_spec(_SMOKE_SPEC)
_SMOKE_SPEC.loader.exec_module(smoke)


def _old_version_fixture(wheel: Path, directory: Path, metadata_url: str) -> Path:
    version = importlib.metadata.version("metalist")
    with zipfile.ZipFile(wheel) as archive:
        members = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/RECORD")}
    members = {name.replace(f"metalist-{version}", "metalist-0.0.0"): body for name, body in members.items()}
    metadata = "metalist-0.0.0.dist-info/METADATA"
    members[metadata] = members[metadata].replace(f"Version: {version}\n".encode(), b"Version: 0.0.0\n", 1)
    members["app/version.py"] = b'__version__ = "0.0.0"\n'
    updater = "app/services/self_update.py"
    members[updater] = members[updater].replace(b'https://pypi.org/pypi/metalist/json', metadata_url.encode())
    record = io.StringIO(newline="")
    writer = csv.writer(record)
    for name, body in members.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b"=").decode()
        writer.writerow((name, "sha256=" + digest, len(body)))
    record_name = "metalist-0.0.0.dist-info/RECORD"
    writer.writerow((record_name, "", ""))
    members[record_name] = record.getvalue().encode()
    fixture = directory / "metalist-0.0.0-py3-none-any.whl"
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
    if response.status_code != 200:
        return False
    status = response.json()
    return status["namespace"] == namespace and status["version"] == version


def run(wheel: Path) -> None:
    assert sys.flags.isolated, "Use python -I"
    uv = shutil.which("uv")
    assert uv is not None
    version = importlib.metadata.version("metalist")
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
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def log_message(self, *args):
            pass

    with tempfile.TemporaryDirectory(prefix="metalist-update-smoke-") as temporary, ThreadingHTTPServer(("127.0.0.1", 0), Index) as index:
        directory = Path(temporary)
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
        fixture = _old_version_fixture(wheel, directory, index_url + "/pypi/metalist/json")
        executable = directory / "bin" / ("metalist.exe" if os.name == "nt" else "metalist")
        profiles = smoke._profiles_with_free_ports()
        log_path = directory / "update.log"
        with log_path.open("w", encoding="utf-8") as log:
            try:
                subprocess.run([uv, "tool", "install", "--python", sys._base_executable, str(fixture)],
                               env=environment, cwd=directory, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
                smoke._seed_namespaces(directory=directory, environment=environment, profiles=profiles)
                subprocess.run([str(executable)], env=environment, cwd=directory, stdout=log,
                               stderr=subprocess.STDOUT, check=True, timeout=300)
                for namespace, port, https_port in profiles:
                    smoke._verify_namespace(namespace=namespace, http_port=port, https_port=https_port, version="0.0.0")
                subprocess.run([str(executable), "update"], env=environment, cwd=directory, stdout=log,
                               stderr=subprocess.STDOUT, check=True, timeout=600)
                deadline = time.monotonic() + 300
                while time.monotonic() < deadline:
                    ready = 0
                    for namespace, port, _ in profiles:
                        if _has_updated_namespace(port=port, namespace=namespace, version=version):
                            ready += 1
                    if ready == len(profiles):
                        break
                    time.sleep(0.5)
                else:
                    raise AssertionError("Updated namespaces did not become ready")
                for namespace, port, https_port in profiles:
                    smoke._verify_namespace(namespace=namespace, http_port=port, https_port=https_port, version=version)
                    assert list((directory / "data/namespaces" / namespace / "backups").glob("*.metalist-backup.tar.gz"))
                scripts = directory / "tools/metalist" / ("Scripts" if os.name == "nt" else "bin")
                python = scripts / ("python.exe" if os.name == "nt" else "python")
                identity = subprocess.check_output([str(python), "-I", "-c", "import sys,json; print(json.dumps(list(sys.version_info[:2])))"], text=True)
                assert json.loads(identity) == list(sys.version_info[:2]), identity
                print(f"Real uv update, backups, offline installation, interpreter preservation, and two-namespace restart passed on {sys.platform} Python {sys.version.split()[0]}.")
            finally:
                smoke._stop_namespace_children(executable=executable, profiles=profiles)
                log.flush()
                print(log_path.read_text(encoding="utf-8", errors="replace")[-20000:])
                index.shutdown()
        thread.join(timeout=5)


if __name__ == "__main__":
    assert len(sys.argv) == 2, "Expected built wheel path"
    run(Path(sys.argv[1]).resolve())
