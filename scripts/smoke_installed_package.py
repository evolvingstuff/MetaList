"""Start the installed wheel outside the checkout using a disposable namespace."""
from __future__ import annotations

import http.client
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time


def _request(port: int, path: str) -> bytes:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("GET", path, headers={"X-Metalist-Tab-Id": "00000000-0000-4000-8000-000000000001"})
        response = connection.getresponse()
        body = response.read()
        assert response.status == 200, f"{path}: HTTP {response.status}: {body[:500]!r}"
        return body
    finally:
        connection.close()


def _wait_for_ready(process: subprocess.Popen, port: int) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        assert process.poll() is None, f"Installed application exited with code {process.returncode}"
        with socket.socket() as probe:
            probe.settimeout(0.2)
            is_listening = probe.connect_ex(("127.0.0.1", port)) == 0
        if not is_listening:
            time.sleep(0.2)
            continue
        status = json.loads(_request(port, "/api2/auth/status"))
        assert status["cache_ready"] is True, status
        assert status["has_password"] is False, status
        assert status["namespace"] == "release-smoke", status
        return
    raise RuntimeError("Installed application failed to become ready within 60 seconds")


def smoke_installed_package() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    assert sys.flags.isolated, "Run with python -I to exclude the source checkout"
    distribution = importlib.metadata.distribution("metalist")
    app_spec = importlib.util.find_spec("app")
    assert app_spec is not None and app_spec.origin is not None
    installed_app = Path(app_spec.origin).resolve()
    assert installed_app == Path(distribution.locate_file("app/__init__.py")).resolve(), "Must test a wheel install, not an editable checkout"
    assert not installed_app.is_relative_to(Path(__file__).resolve().parents[1]), "Must test outside the source checkout"
    assert any(entry.name == "metalist" and entry.value == "main:cli" for entry in distribution.entry_points)
    environment = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("METALIST_", "UVICORN_", "SECURITY_", "PYTHON"))
        and key not in {"TEST_MODE", "API_PREFIX", "V1_API_PREFIX", "SQL_TRACE", "STARTUP_ANIMATION_ENABLED"}
    }
    environment.update(TEST_MODE="0", METALIST_ENVIRONMENT="production", METALIST_NAMESPACE="release-smoke")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="metalist-installed-smoke-") as temporary_directory:
        log_path = Path(temporary_directory) / "startup.log"
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [sys.executable, "-I", "-X", "utf8", "-c", (
                    "import sys; from pathlib import Path; import app.server_runtime as runtime; "
                    "runtime._DEFAULT_DATABASE_DIRECTORY = Path.cwd() / 'MetaList'; "
                    "runtime._DEFAULT_RUNTIME_DIRECTORY = Path.cwd() / 'runtime'; "
                    "runtime._DEFAULT_CERT_PATH = Path.cwd() / 'cert.pem'; "
                    "runtime._DEFAULT_KEY_PATH = Path.cwd() / 'key.pem'; "
                    "runtime.save_namespace_launch_profile(namespace='release-smoke', port=int(sys.argv[1]), https_port=None, mcp_port=None); "
                    "import main; import uvicorn; "
                    "uvicorn.run('app.main:app', host='127.0.0.1', port=int(sys.argv[1]), access_log=False)"
                ), str(port)],
                cwd=temporary_directory, env=environment, stdout=log, stderr=subprocess.STDOUT,
            )
            try:
                _wait_for_ready(process, port)
                assert b"<!doctype html" in _request(port, "/").lower()
                for path in ("/static/js/main.js", "/static/css/main.css", "/static/note-html-policy.json"):
                    assert _request(port, path), f"Empty runtime asset: {path}"
                assert process.poll() is None, "Application exited after serving startup requests"
            finally:
                if process.poll() is None:
                    process.terminate()
                    deadline = time.monotonic() + 10
                    while process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.1)
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=10)
                log.flush()
                print(log_path.read_text(encoding="utf-8", errors="replace"))
    print(f"Installed MetaList {distribution.version} startup passed on {sys.platform}, Python {sys.version.split()[0]}.")


if __name__ == "__main__":
    smoke_installed_package()
