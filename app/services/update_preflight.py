"""Validate an update in a disposable installation before stopping live namespaces."""
from __future__ import annotations

from collections.abc import Mapping
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory

import httpx

from app.services.namespace_switcher import NamespaceLaunchProcess
from app.services.namespace_switcher import _stop_failed_namespace_launch
from app.services.namespace_switcher import _wait_for_namespace_ready
from app.services.windows_process_control import stop_process_tree as stop_windows_process_tree


def _run_checked(command: list[str], *, environ: Mapping[str, str], directory: Path) -> str:
    completed = subprocess.run(
        command, env=dict(environ), cwd=directory, capture_output=True,
        text=True, encoding="utf-8", check=False, timeout=600,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "Update preflight failed; the current installation and running namespaces "
            f"were not changed.\n{completed.stdout}\n{completed.stderr}"
        )
    return completed.stdout


def _probe_candidate(*, python: str, executable: str, directory: Path,
                     environ: Mapping[str, str], target_version: str) -> None:
    probe_environ = {
        key: value for key, value in environ.items()
        if not key.startswith(("METALIST_", "UVICORN_", "SECURITY_", "PYTHON"))
        and key not in {"TEST_MODE", "API_PREFIX", "V1_API_PREFIX", "SQL_TRACE"}
    }
    probe_environ.update(
        METALIST_DATA_DIRECTORY=str(directory / "probe-data"),
        METALIST_ENVIRONMENT="production", METALIST_AUTO_GENERATE_TLS="0",
        PYTHONUNBUFFERED="1", PYTHONUTF8="1", TEST_MODE="0",
    )
    if "METALIST_STARTUP_TIMEOUT_SECONDS" in environ:
        probe_environ["METALIST_STARTUP_TIMEOUT_SECONDS"] = environ["METALIST_STARTUP_TIMEOUT_SECONDS"]
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    _run_checked([
        python, "-I", "-c",
        "import sys; from app.server_runtime import save_namespace_launch_profile; "
        "save_namespace_launch_profile(namespace='update-probe', port=int(sys.argv[1]), https_port=None, mcp_port=None)",
        str(port),
    ], environ=probe_environ, directory=directory)
    log_path = directory / "startup.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            [executable, "--namespace", "update-probe", "--port", str(port)],
            cwd=directory, env=probe_environ, stdout=log, stderr=subprocess.STDOUT,
        )
    try:
        _wait_for_namespace_ready(
            environ=probe_environ, namespace="update-probe", port=port,
            launched_process=NamespaceLaunchProcess(process, log_path, 0),
        )
        with httpx.Client(
            base_url=f"http://127.0.0.1:{port}", timeout=15, trust_env=False,
            headers={"X-Metalist-Tab-Id": "00000000-0000-4000-8000-000000000001"},
        ) as client:
            status = client.get("/api2/auth/status")
            status.raise_for_status()
            if status.json()["version"] != target_version:
                raise RuntimeError("Update candidate started with the wrong version")
            for path in ("/", "/static/js/main.js", "/static/css/main.css", "/static/note-html-policy.json"):
                response = client.get(path)
                response.raise_for_status()
                if len(response.content) == 0:
                    raise RuntimeError(f"Update candidate has an empty runtime resource: {path}")
    finally:
        if sys.platform == "win32":
            # The CLI/venv launchers can own a separate Python server process.
            # Stop descendants even if readiness failure already reaped the launcher.
            stop_windows_process_tree(pid=process.pid)
        _stop_failed_namespace_launch(process=process)


def prepare_update(*, uv_executable: str, target_version: str,
                   environ: Mapping[str, str]) -> list[str]:
    # A tool environment is replaced during install: pin its external base interpreter.
    python = str(Path(sys._base_executable).resolve())
    if not Path(python).is_file():
        raise RuntimeError("The current base Python interpreter is missing; MetaList was not stopped")
    print(f"Checking MetaList v{target_version} installation and startup with Python {sys.version.split()[0]}...", flush=True)
    with TemporaryDirectory(prefix="metalist-update-check-") as temporary:
        directory = Path(temporary)
        stage_environ = dict(environ)
        stage_environ.update(UV_TOOL_DIR=str(directory / "tools"), UV_TOOL_BIN_DIR=str(directory / "bin"))
        _run_checked([
            uv_executable, "tool", "install", "--python", python,
            "--refresh", "--compile-bytecode", f"metalist=={target_version}",
        ], environ=stage_environ, directory=directory)
        if sys.platform == "win32":
            scripts = directory / "tools" / "metalist" / "Scripts"
            candidate_python = str(scripts / "python.exe")
            candidate_cli = str(scripts / "metalist.exe")
        else:
            scripts = directory / "tools" / "metalist" / "bin"
            candidate_python = str(scripts / "python")
            candidate_cli = str(scripts / "metalist")
        identity = json.loads(_run_checked([
            candidate_python, "-I", "-c",
            "import sys,json,importlib.metadata; print(json.dumps([list(sys.version_info[:2]),importlib.metadata.version('metalist')]))",
        ], environ=stage_environ, directory=directory))
        if identity != [list(sys.version_info[:2]), target_version]:
            raise RuntimeError("Update preflight changed Python or installed the wrong MetaList version")
        _run_checked([uv_executable, "pip", "check", "--python", candidate_python], environ=stage_environ, directory=directory)
        frozen = _run_checked([uv_executable, "pip", "freeze", "--python", candidate_python], environ=stage_environ, directory=directory)
        _probe_candidate(python=candidate_python, executable=candidate_cli, directory=directory,
                         environ=environ, target_version=target_version)
        # Keep the exact tested dependency set. Offline installation reuses the warmed uv cache.
        command = [uv_executable, "tool", "install", "--force", "--offline", "--python", python,
                   "--compile-bytecode", f"metalist=={target_version}"]
        for requirement in frozen.splitlines():
            if "==" not in requirement or requirement.startswith("-"):
                raise RuntimeError(f"Update preflight produced an unpinned requirement: {requirement}")
            if requirement.split("==")[0].casefold() != "metalist":
                command.extend(["--with", requirement])
    print("Update installation and startup check passed; packages are cached for offline installation.", flush=True)
    return command
