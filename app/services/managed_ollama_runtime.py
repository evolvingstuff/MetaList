"""Lifecycle manager for MetaList's shared local Ollama server."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

import httpx

from app.server_runtime import resolve_managed_runtime_directory
from app.server_runtime import resolve_runtime_logs_directory
from app.services.diagnostics import recycle_direct_append_log_file
from app.services.exception_capture import CapturedExceptionContext
from app.services.windows_process_control import is_process_running as is_windows_process_running
from app.services.windows_process_control import find_listening_pids_for_port as find_windows_listening_pids_for_port


_DEFAULT_HOST = "127.0.0.1"
_DEFAULT_PORT = 11_435
_DEFAULT_CONTEXT_TOKENS = 32_768
_DEFAULT_STARTUP_TIMEOUT_SECONDS = 30.0
_LOCK_WAIT_TIMEOUT_SECONDS = 35.0
_LOCK_POLL_INTERVAL_SECONDS = 0.1
_HEALTH_POLL_INTERVAL_SECONDS = 0.1
_PROBE_TIMEOUT_SECONDS = 0.5
_PROCESS_TERMINATE_TIMEOUT_SECONDS = 5.0
_STATE_FILE_NAME = "ollama-runtime.json"
_LOCK_FILE_NAME = "ollama-start.lock"
_LOG_FILE_NAME = "ollama-managed.log"


class ManagedOllamaRuntimeError(RuntimeError):
    """An expected local Ollama lifecycle or ownership failure."""


@dataclass(frozen=True, slots=True)
class ManagedOllamaRuntimeConfig:
    host: str
    port: int
    context_tokens: int
    startup_timeout_seconds: float

    def __post_init__(self) -> None:
        if self.host != _DEFAULT_HOST:
            raise ValueError("Managed Ollama must bind to 127.0.0.1")
        if not isinstance(self.port, int) or isinstance(self.port, bool):
            raise TypeError("Managed Ollama port must be an integer")
        if not 0 < self.port < 65_536:
            raise ValueError("Managed Ollama port must be between 1 and 65535")
        if not isinstance(self.context_tokens, int) or isinstance(self.context_tokens, bool):
            raise TypeError("Managed Ollama context length must be an integer")
        if self.context_tokens < 16_384:
            raise ValueError("Managed Ollama context length must be at least 16384")
        if not isinstance(self.startup_timeout_seconds, float):
            raise TypeError("Managed Ollama startup timeout must be a float")
        if self.startup_timeout_seconds <= 0.0:
            raise ValueError("Managed Ollama startup timeout must be positive")

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"


@dataclass(frozen=True, slots=True)
class ManagedOllamaRuntimeInfo:
    base_url: str
    context_tokens: int
    executable: str
    pid: int
    port: int
    started_at: str
    version: str

    def __post_init__(self) -> None:
        if not isinstance(self.base_url, str) or self.base_url == "":
            raise ValueError("Managed Ollama state requires base_url")
        if not isinstance(self.context_tokens, int) or self.context_tokens < 1:
            raise ValueError("Managed Ollama state requires positive context_tokens")
        if not isinstance(self.executable, str) or self.executable == "":
            raise ValueError("Managed Ollama state requires executable")
        if not isinstance(self.pid, int) or self.pid < 1:
            raise ValueError("Managed Ollama state requires a positive pid")
        if not isinstance(self.port, int) or not 0 < self.port < 65_536:
            raise ValueError("Managed Ollama state requires a valid port")
        if not isinstance(self.started_at, str) or self.started_at == "":
            raise ValueError("Managed Ollama state requires started_at")
        if not isinstance(self.version, str) or self.version == "":
            raise ValueError("Managed Ollama state requires version")


@dataclass(frozen=True, slots=True)
class _StartupLockRecord:
    owner_pid: int
    token: str

    def __post_init__(self) -> None:
        if not isinstance(self.owner_pid, int) or self.owner_pid < 1:
            raise ValueError("Managed Ollama startup lock requires a positive owner pid")
        if not isinstance(self.token, str) or self.token == "":
            raise ValueError("Managed Ollama startup lock requires a token")


class ManagedOllamaRuntime:
    def __init__(
        self,
        *,
        config: ManagedOllamaRuntimeConfig,
        runtime_directory: Path,
        logs_directory: Path,
        environ: Mapping[str, str],
    ) -> None:
        if not isinstance(config, ManagedOllamaRuntimeConfig):
            raise TypeError("ManagedOllamaRuntime requires validated config")
        if not isinstance(runtime_directory, Path):
            raise TypeError("ManagedOllamaRuntime runtime_directory must be a Path")
        if not isinstance(logs_directory, Path):
            raise TypeError("ManagedOllamaRuntime logs_directory must be a Path")
        if not isinstance(environ, Mapping):
            raise TypeError("ManagedOllamaRuntime environ must be a mapping")
        self.config = config
        self.runtime_directory = runtime_directory
        self.logs_directory = logs_directory
        self._environ = environ

    @property
    def state_path(self) -> Path:
        return self.runtime_directory / _STATE_FILE_NAME

    @property
    def lock_path(self) -> Path:
        return self.runtime_directory / _LOCK_FILE_NAME

    def ensure_running(self) -> ManagedOllamaRuntimeInfo:
        self.runtime_directory.mkdir(parents=True, exist_ok=True)
        existing_state = self._load_state()
        if existing_state is not None and self._state_is_reusable(state=existing_state):
            return existing_state

        lock_record = self._acquire_startup_lock()
        try:
            existing_state = self._load_state()
            if existing_state is not None:
                if self._state_is_reusable(state=existing_state):
                    return existing_state
                self._discard_stale_state(state=existing_state)
            occupying_version = _probe_ollama_version(
                base_url=self.config.base_url,
                timeout_seconds=_PROBE_TIMEOUT_SECONDS,
            )
            if occupying_version != "":
                raise ManagedOllamaRuntimeError(
                    f"Managed Ollama port {self.config.port} is already occupied by an "
                    "Ollama server MetaList does not own"
                )
            return self._launch_server()
        finally:
            self._release_startup_lock(record=lock_record)

    def _state_is_reusable(self, *, state: ManagedOllamaRuntimeInfo) -> bool:
        if not _is_process_running(pid=state.pid):
            return False
        if state.base_url != self.config.base_url:
            raise ManagedOllamaRuntimeError(
                "MetaList-managed Ollama state has an unexpected URL"
            )
        if state.port != self.config.port:
            raise ManagedOllamaRuntimeError(
                "MetaList-managed Ollama state has an unexpected port"
            )
        if state.context_tokens != self.config.context_tokens:
            raise ManagedOllamaRuntimeError(
                "MetaList-managed Ollama is running with a different context length; "
                "stop that owned daemon before restarting MetaList"
            )
        running_version = _probe_ollama_version(
            base_url=state.base_url,
            timeout_seconds=_PROBE_TIMEOUT_SECONDS,
        )
        if running_version == "":
            return False
        listener_pids = _find_listening_pids_for_port(port=state.port)
        if listener_pids != [state.pid]:
            raise ManagedOllamaRuntimeError(
                "MetaList-managed Ollama ownership does not match the process listening "
                f"on port {state.port}"
            )
        return True

    def _discard_stale_state(self, *, state: ManagedOllamaRuntimeInfo) -> None:
        if _is_process_running(pid=state.pid):
            raise ManagedOllamaRuntimeError(
                "MetaList-managed Ollama process is running but its API is unavailable"
            )
        occupying_version = _probe_ollama_version(
            base_url=self.config.base_url,
            timeout_seconds=_PROBE_TIMEOUT_SECONDS,
        )
        if occupying_version != "":
            raise ManagedOllamaRuntimeError(
                f"Managed Ollama port {self.config.port} is occupied after its ownership "
                "record became stale"
            )
        self.state_path.unlink()

    def _launch_server(self) -> ManagedOllamaRuntimeInfo:
        executable = shutil.which("ollama")
        if executable is None:
            raise ManagedOllamaRuntimeError(
                "Ollama is not installed or is not available on MetaList's PATH"
            )
        self.logs_directory.mkdir(parents=True, exist_ok=True)
        log_path = self.logs_directory / _LOG_FILE_NAME
        recycle_direct_append_log_file(path=log_path)
        child_environment = dict(self._environ)
        child_environment.update(
            {
                "OLLAMA_CONTEXT_LENGTH": str(self.config.context_tokens),
                "OLLAMA_HOST": f"{self.config.host}:{self.config.port}",
                "OLLAMA_DEBUG_LOG_REQUESTS": "false",
                "OLLAMA_NO_CLOUD": "1",
                "OLLAMA_NOHISTORY": "1",
                "OLLAMA_NUM_PARALLEL": "1",
            }
        )
        log_handle = open(log_path, "ab")
        try:
            process = subprocess.Popen(
                [executable, "serve"],
                env=child_environment,
                stdout=log_handle,
                stderr=log_handle,
                start_new_session=True,
            )
        finally:
            log_handle.close()
        return self._wait_for_server(
            executable=executable,
            process=process,
            log_path=log_path,
        )

    def _wait_for_server(
        self,
        *,
        executable: str,
        process: subprocess.Popen[bytes],
        log_path: Path,
    ) -> ManagedOllamaRuntimeInfo:
        deadline = time.monotonic() + self.config.startup_timeout_seconds
        while time.monotonic() < deadline:
            return_code = process.poll()
            if return_code is not None:
                log_tail = _read_log_tail(path=log_path)
                raise ManagedOllamaRuntimeError(
                    f"MetaList-managed Ollama exited during startup with code {return_code}: "
                    f"{log_tail}"
                )
            version = _probe_ollama_version(
                base_url=self.config.base_url,
                timeout_seconds=_PROBE_TIMEOUT_SECONDS,
            )
            if version != "":
                listener_pids = _find_listening_pids_for_port(port=self.config.port)
                if listener_pids != [process.pid]:
                    process.terminate()
                    process.wait(timeout=_PROCESS_TERMINATE_TIMEOUT_SECONDS)
                    raise ManagedOllamaRuntimeError(
                        "The Ollama process MetaList started does not exclusively own "
                        f"port {self.config.port}"
                    )
                state = ManagedOllamaRuntimeInfo(
                    base_url=self.config.base_url,
                    context_tokens=self.config.context_tokens,
                    executable=executable,
                    pid=process.pid,
                    port=self.config.port,
                    started_at=datetime.now(timezone.utc).isoformat(),
                    version=version,
                )
                self._write_state(state=state)
                return state
            time.sleep(_HEALTH_POLL_INTERVAL_SECONDS)
        process.terminate()
        process.wait(timeout=_PROCESS_TERMINATE_TIMEOUT_SECONDS)
        log_tail = _read_log_tail(path=log_path)
        raise ManagedOllamaRuntimeError(
            f"MetaList-managed Ollama did not become ready within "
            f"{self.config.startup_timeout_seconds:g} seconds: {log_tail}"
        )

    def _load_state(self) -> ManagedOllamaRuntimeInfo | None:
        if not self.state_path.exists():
            return None
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ManagedOllamaRuntimeError(
                "MetaList-managed Ollama state is unreadable"
            ) from exc
        if not isinstance(payload, dict):
            raise ManagedOllamaRuntimeError(
                "MetaList-managed Ollama state must be an object"
            )
        expected_keys = {
            "base_url",
            "context_tokens",
            "executable",
            "pid",
            "port",
            "started_at",
            "version",
        }
        if set(payload) != expected_keys:
            raise ManagedOllamaRuntimeError(
                "MetaList-managed Ollama state fields are invalid"
            )
        return ManagedOllamaRuntimeInfo(**payload)

    def _write_state(self, *, state: ManagedOllamaRuntimeInfo) -> None:
        temporary_path = self.runtime_directory / f"{_STATE_FILE_NAME}.{uuid.uuid4().hex}.tmp"
        serialized = json.dumps(asdict(state), sort_keys=True, separators=(",", ":"))
        file_descriptor = os.open(
            temporary_path,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            0o600,
        )
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as state_file:
            state_file.write(serialized)
            state_file.flush()
            os.fsync(state_file.fileno())
        os.replace(temporary_path, self.state_path)

    def _acquire_startup_lock(self) -> _StartupLockRecord:
        deadline = time.monotonic() + _LOCK_WAIT_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            record = _StartupLockRecord(owner_pid=os.getpid(), token=uuid.uuid4().hex)
            lock_capture = CapturedExceptionContext(FileExistsError, boundary='app/services/managed_ollama_runtime.py:_acquire_startup_lock:lock_capture')
            file_descriptor = -1
            with lock_capture:
                file_descriptor = os.open(
                    self.lock_path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
            if lock_capture.captured_exception is None:
                assert file_descriptor >= 0
                with os.fdopen(file_descriptor, "w", encoding="utf-8") as lock_file:
                    lock_file.write(
                        json.dumps(asdict(record), sort_keys=True, separators=(",", ":"))
                    )
                    lock_file.flush()
                    os.fsync(lock_file.fileno())
                return record
            self._remove_stale_lock()
            time.sleep(_LOCK_POLL_INTERVAL_SECONDS)
        raise ManagedOllamaRuntimeError(
            "Timed out waiting for another MetaList process to start Ollama"
        )

    def _remove_stale_lock(self) -> None:
        read_capture = CapturedExceptionContext(FileNotFoundError, boundary='app/services/managed_ollama_runtime.py:_remove_stale_lock:read_capture')
        serialized_lock = ""
        with read_capture:
            serialized_lock = self.lock_path.read_text(encoding="utf-8")
        if read_capture.captured_exception is not None:
            return
        try:
            payload = json.loads(serialized_lock)
        except json.JSONDecodeError as exc:
            raise ManagedOllamaRuntimeError(
                "MetaList-managed Ollama startup lock is unreadable"
            ) from exc
        if not isinstance(payload, dict) or set(payload) != {"owner_pid", "token"}:
            raise ManagedOllamaRuntimeError(
                "MetaList-managed Ollama startup lock is invalid"
            )
        record = _StartupLockRecord(**payload)
        if _is_process_running(pid=record.owner_pid):
            return
        missing_capture = CapturedExceptionContext(FileNotFoundError, boundary='app/services/managed_ollama_runtime.py:_remove_stale_lock:missing_capture')
        with missing_capture:
            self.lock_path.unlink()

    def _release_startup_lock(self, *, record: _StartupLockRecord) -> None:
        payload = json.loads(self.lock_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or set(payload) != {"owner_pid", "token"}:
            raise RuntimeError("MetaList-managed Ollama startup lock changed unexpectedly")
        current_record = _StartupLockRecord(**payload)
        if current_record != record:
            raise RuntimeError("MetaList-managed Ollama startup lock ownership changed")
        self.lock_path.unlink()


def _probe_ollama_version(*, base_url: str, timeout_seconds: float) -> str:
    probe_capture = CapturedExceptionContext(httpx.HTTPError, json.JSONDecodeError, boundary='app/services/managed_ollama_runtime.py:_probe_ollama_version:probe_capture')
    payload: object = {}
    with probe_capture:
        with httpx.Client(
            timeout=timeout_seconds,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            response = client.get(f"{base_url}/api/version")
            response.raise_for_status()
            payload = json.loads(response.text)
    if probe_capture.captured_exception is not None:
        return ""
    if not isinstance(payload, dict):
        raise ManagedOllamaRuntimeError("Ollama version response must be an object")
    version = payload.get("version")
    if not isinstance(version, str) or version == "":
        raise ManagedOllamaRuntimeError("Ollama version response is missing version")
    return version


def _is_process_running(*, pid: int) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid < 1:
        raise ValueError("Managed Ollama pid must be a positive integer")
    if sys.platform == "win32":
        return is_windows_process_running(pid=pid)
    process_capture = CapturedExceptionContext(ProcessLookupError, PermissionError, boundary='app/services/managed_ollama_runtime.py:_is_process_running:process_capture')
    with process_capture:
        os.kill(pid, 0)
    if process_capture.captured_exception is None:
        return True
    if isinstance(process_capture.captured_exception, ProcessLookupError):
        return False
    if isinstance(process_capture.captured_exception, PermissionError):
        return True
    raise RuntimeError("Unexpected managed Ollama process probe result")


def _find_listening_pids_for_port(*, port: int) -> list[int]:
    if not isinstance(port, int) or isinstance(port, bool) or not 0 < port < 65_536:
        raise ValueError("Managed Ollama port must be between 1 and 65535")
    if sys.platform == "win32":
        return find_windows_listening_pids_for_port(port=port)
    lsof_path = shutil.which("lsof")
    if lsof_path is None:
        raise ManagedOllamaRuntimeError(
            "`lsof` is required to verify ownership of MetaList-managed Ollama"
        )
    completed = subprocess.run(
        [lsof_path, "-nP", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
        capture_output=True,
        check=False,
        text=True,
    )
    if completed.returncode not in {0, 1}:
        raise ManagedOllamaRuntimeError(
            f"`lsof` failed while verifying MetaList-managed Ollama on port {port}: "
            f"exit={completed.returncode} stderr={completed.stderr.strip()!r}"
        )
    listener_pids: set[int] = set()
    for raw_line in completed.stdout.splitlines():
        raw_pid = raw_line.strip()
        if raw_pid == "":
            continue
        if not raw_pid.isdigit() or int(raw_pid) < 1:
            raise ManagedOllamaRuntimeError(
                f"`lsof` returned an invalid Ollama listener pid: {raw_pid!r}"
            )
        listener_pids.add(int(raw_pid))
    return sorted(listener_pids)


def _read_log_tail(*, path: Path) -> str:
    if not path.exists():
        return "no Ollama log was created"
    with open(path, "rb") as log_file:
        log_file.seek(0, os.SEEK_END)
        file_size = log_file.tell()
        log_file.seek(max(0, file_size - 4096), os.SEEK_SET)
        log_tail = log_file.read().decode("utf-8", errors="replace").strip()
    if log_tail == "":
        return "Ollama log is empty"
    return log_tail


managed_ollama_runtime = ManagedOllamaRuntime(
    config=ManagedOllamaRuntimeConfig(
        host=_DEFAULT_HOST,
        port=_DEFAULT_PORT,
        context_tokens=_DEFAULT_CONTEXT_TOKENS,
        startup_timeout_seconds=_DEFAULT_STARTUP_TIMEOUT_SECONDS,
    ),
    runtime_directory=resolve_managed_runtime_directory() / "ollama",
    logs_directory=resolve_runtime_logs_directory(),
    environ=os.environ,
)
