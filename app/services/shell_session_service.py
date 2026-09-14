from __future__ import annotations

import os
import codecs
import io
from functools import wraps
from app.services.resource_limits import SHELL_SECONDS, SHELL_RUNS, SHELL_OUTPUT_BYTES, CLIENT_ENTRIES
import signal
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, TextIO

from app.services.exception_capture import CapturedExceptionContext
from app.services.windows_process_control import stop_process_tree as stop_windows_process


_STATUS_RUNNING = "running"
_STATUS_SUCCESS = "success"
_STATUS_ERROR = "error"
_STATUS_TIMEOUT = "timeout"
_COMPLETED_RETENTION_SECONDS = 300.0


class ShellRunNotFound(ValueError):
    pass


class ShellCapacityError(ValueError):
    pass


def _terminate_tree(process) -> None:
    with CapturedExceptionContext(ProcessLookupError, boundary='app/services/shell_session_service.py:_terminate_tree:capture'):
        if os.name == 'nt':
            stop_windows_process(process=process)
        else:
            os.killpg(process.pid, signal.SIGKILL)


def _serialized_start(function):
    @wraps(function)
    def wrapped(self, **kwargs):
        with self._lock:
            return function(self, **kwargs)
    return wrapped


def _resolve_shell_command(*, script_text: str) -> list[str]:
    if not isinstance(script_text, str) or script_text.strip() == "":
        raise ValueError("script_text must be a non-empty string")

    if os.name == "nt":
        comspec = None
        if "COMSPEC" in os.environ:
            comspec = os.environ["COMSPEC"]
        if not isinstance(comspec, str) or comspec.strip() == "":
            raise RuntimeError("COMSPEC is required for shell execution on Windows")
        return [comspec, "/d", "/s", "/c", script_text]

    shell_path = None
    if "SHELL" in os.environ:
        shell_path = os.environ["SHELL"]
    if not isinstance(shell_path, str) or shell_path.strip() == "":
        detected_shell = shutil.which("bash")
        if detected_shell is None:
            detected_shell = shutil.which("sh")
        if detected_shell is None:
            raise RuntimeError("Unable to resolve a shell executable")
        shell_path = detected_shell

    normalized_shell = Path(shell_path).name.lower()
    if normalized_shell in {"bash", "zsh", "sh", "ksh"}:
        return [shell_path, "-lc", script_text]
    return [shell_path, "-c", script_text]


@dataclass(slots=True)
class _ShellRunRecord:
    run_id: str
    note_id: str
    process: subprocess.Popen[str]
    timeout_seconds: int
    started_at_monotonic: float
    output_bytes: int
    expiration_timer: threading.Timer | None
    stdout_chunks: list[str]
    stderr_chunks: list[str]
    status: str
    exit_code: int
    error_message: str
    finished_at_monotonic: float
    lock: threading.RLock
    stdout_thread: threading.Thread | None
    stderr_thread: threading.Thread | None
    monitor_thread: threading.Thread | None

    def snapshot(self) -> Dict[str, object]:
        with self.lock:
            if self.status == _STATUS_RUNNING:
                duration_ms = int((time.monotonic() - self.started_at_monotonic) * 1000)
            else:
                duration_ms = int((self.finished_at_monotonic - self.started_at_monotonic) * 1000)
            return {
                "runId": self.run_id,
                "status": self.status,
                "exitCode": self.exit_code,
                "stdout": "".join(self.stdout_chunks),
                "stderr": "".join(self.stderr_chunks),
                "durationMs": max(duration_ms, 0),
                "errorMessage": self.error_message,
            }


class ShellSessionService:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._runs: dict[str, _ShellRunRecord] = {}

    @_serialized_start
    def reset(self) -> None:
        with self._lock:
            records = tuple(self._runs.values())
            self._runs.clear()
        for record in records:
            if record.expiration_timer is not None:
                record.expiration_timer.cancel()
            workers = (record.stdout_thread, record.stderr_thread, record.monitor_thread)
            if record.process.poll() is None or any(thread is not None and thread.is_alive() for thread in workers):
                _terminate_tree(record.process)
            for thread in workers:
                if thread is not None:
                    thread.join(timeout=5)
                    if thread.is_alive():
                        raise RuntimeError('Shell worker did not stop during namespace lock')
            with record.lock:
                record.stdout_chunks.clear()
                record.stderr_chunks.clear()

    @_serialized_start
    def start_run(self, *, note_id: str, script_text: str, timeout_seconds: int) -> Dict[str, object]:
        if not isinstance(note_id, str) or note_id == "":
            raise TypeError("note_id must be a non-empty string")
        if not isinstance(script_text, str) or script_text.strip() == "":
            raise ValueError("script_text must be a non-empty string")
        if not isinstance(timeout_seconds, int) or timeout_seconds < 0:
            raise TypeError("timeout_seconds must be a non-negative integer")

        self._prune_completed_runs(now=time.monotonic())
        if sum(record.status == _STATUS_RUNNING for record in self._runs.values()) >= SHELL_RUNS:
            raise ShellCapacityError('Maximum simultaneous shell commands reached')
        if timeout_seconds == 0:
            timeout_seconds = SHELL_SECONDS
        if timeout_seconds > SHELL_SECONDS:
            raise ValueError(f'Shell duration cannot exceed {SHELL_SECONDS} seconds')
        command = _resolve_shell_command(script_text=script_text)
        started_at = time.monotonic()
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            bufsize=-1,
            start_new_session=True,
        )
        if process.stdout is None:
            raise RuntimeError("Shell process stdout stream is unavailable")
        if process.stderr is None:
            raise RuntimeError("Shell process stderr stream is unavailable")

        run_id = str(uuid.uuid4())
        record = _ShellRunRecord(
            run_id=run_id,
            note_id=note_id,
            process=process,
            timeout_seconds=timeout_seconds,
            started_at_monotonic=started_at,
            output_bytes=0,
            expiration_timer=None,
            stdout_chunks=[],
            stderr_chunks=[],
            status=_STATUS_RUNNING,
            exit_code=-1,
            error_message="",
            finished_at_monotonic=0.0,
            lock=threading.RLock(),
            stdout_thread=None,
            stderr_thread=None,
            monitor_thread=None,
        )

        stdout_thread = threading.Thread(
            target=self._pump_stream,
            kwargs={"record": record, "stream_name": "stdout", "stream": process.stdout},
            daemon=True,
        )
        stderr_thread = threading.Thread(
            target=self._pump_stream,
            kwargs={"record": record, "stream_name": "stderr", "stream": process.stderr},
            daemon=True,
        )
        monitor_thread = threading.Thread(
            target=self._monitor_run,
            kwargs={"record": record},
            daemon=True,
        )
        record.stdout_thread = stdout_thread
        record.stderr_thread = stderr_thread
        record.monitor_thread = monitor_thread

        with self._lock:
            self._runs[run_id] = record

        stdout_thread.start()
        stderr_thread.start()
        monitor_thread.start()
        return record.snapshot()

    def get_snapshot(self, *, note_id: str, run_id: str) -> Dict[str, object]:
        record = self._require_run(note_id=note_id, run_id=run_id)
        self._prune_completed_runs(now=time.monotonic())
        return record.snapshot()

    def _require_run(self, *, note_id: str, run_id: str) -> _ShellRunRecord:
        if not isinstance(note_id, str) or note_id == "":
            raise TypeError("note_id must be a non-empty string")
        if not isinstance(run_id, str) or run_id == "":
            raise TypeError("run_id must be a non-empty string")

        with self._lock:
            record = self._runs.get(run_id)
        if record is None:
            raise ShellRunNotFound("Shell run has expired or does not exist")
        if record.note_id != note_id:
            raise ShellRunNotFound("Shell run does not exist for this note")
        return record

    def _pump_stream(self, *, record: _ShellRunRecord, stream_name: str, stream: TextIO) -> None:
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        try:
            while True:
                if isinstance(stream, io.TextIOBase):
                    raw = stream.read(4096).encode('utf-8')
                else:
                    raw = stream.read1(4096)
                with record.lock:
                    available = max(0, SHELL_OUTPUT_BYTES - record.output_bytes)
                    accepted = raw[:available]
                    record.output_bytes += len(accepted)
                    chunk = decoder.decode(accepted, final=not raw)
                    if chunk:
                        if stream_name == 'stdout':
                            record.stdout_chunks.append(chunk)
                        else:
                            record.stderr_chunks.append(chunk)
                    exceeded = len(raw) > available
                    if exceeded:
                        record.error_message = f'Shell output limit reached ({SHELL_OUTPUT_BYTES} bytes); command stopped'
                if exceeded:
                    _terminate_tree(record.process)
                    break
                if not raw:
                    break
        finally:
            stream.close()

    def _monitor_run(self, *, record: _ShellRunRecord) -> None:
        timed_out = False
        timeout = None
        if record.timeout_seconds != 0:
            timeout = record.timeout_seconds
        wait_capture = CapturedExceptionContext(subprocess.TimeoutExpired, boundary='app/services/shell_session_service.py:_monitor_run:wait_capture')
        return_code: int | None = None
        with wait_capture:
            return_code = record.process.wait(timeout=timeout)
        if wait_capture.captured_exception is not None:
            timed_out = True
            _terminate_tree(record.process)
            return_code = record.process.wait()
        if return_code is None:
            raise RuntimeError("Shell process wait did not return an exit code")

        # Background descendants belong to this run, even after the shell exits.
        _terminate_tree(record.process)
        stdout_thread = record.stdout_thread
        if stdout_thread is not None:
            stdout_thread.join(timeout=5)
            if stdout_thread.is_alive():
                raise RuntimeError('Shell stdout worker did not stop')
        stderr_thread = record.stderr_thread
        if stderr_thread is not None:
            stderr_thread.join(timeout=5)
            if stderr_thread.is_alive():
                raise RuntimeError('Shell stderr worker did not stop')

        with record.lock:
            record.exit_code = int(return_code)
            record.finished_at_monotonic = time.monotonic()
            record.expiration_timer = threading.Timer(_COMPLETED_RETENTION_SECONDS, self._expire_run, args=(record.run_id,))
            record.expiration_timer.daemon = True
            record.expiration_timer.start()
            if record.error_message:
                record.status = _STATUS_ERROR
                return
            if timed_out:
                record.status = _STATUS_TIMEOUT
                record.error_message = f"Shell command timed out after {record.timeout_seconds} seconds"
                return
            if record.exit_code != 0:
                record.status = _STATUS_ERROR
                record.error_message = f"Shell command exited with code {record.exit_code}"
                return
            record.status = _STATUS_SUCCESS
            record.error_message = ""

    def _expire_run(self, run_id: str) -> None:
        with self._lock:
            if run_id in self._runs and self._runs[run_id].status != _STATUS_RUNNING:
                del self._runs[run_id]

    def _prune_completed_runs(self, *, now: float) -> None:
        expired_run_ids: list[str] = []
        with self._lock:
            for run_id, record in self._runs.items():
                with record.lock:
                    if record.status == _STATUS_RUNNING:
                        continue
                    age_seconds = now - record.finished_at_monotonic
                if age_seconds >= _COMPLETED_RETENTION_SECONDS:
                    expired_run_ids.append(run_id)
            completed = [key for key, record in self._runs.items() if record.status != _STATUS_RUNNING]
            expired_run_ids.extend(completed[:max(0, len(self._runs) - CLIENT_ENTRIES + 1)])
            for run_id in set(expired_run_ids):
                record = self._runs.pop(run_id)
                if record.expiration_timer is not None:
                    record.expiration_timer.cancel()


shell_session_service = ShellSessionService()
