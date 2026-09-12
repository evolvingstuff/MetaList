from __future__ import annotations

import io
import os
import sys
import subprocess
import threading
import time

import pytest

from app.services import shell_session_service


class _BlockingPopen:
    def __init__(
        self,
        *,
        wait_event: threading.Event,
        stdout_text: str,
        stderr_text: str,
        returncode: int,
    ) -> None:
        self.stdin = None
        self.stdout = io.StringIO(stdout_text)
        self.stderr = io.StringIO(stderr_text)
        self._wait_event = wait_event
        self._returncode = returncode
        self.kill_called = False

    def wait(self, *args, **kwargs) -> int:
        timeout = None
        if len(args) > 0:
            timeout = args[0]
        if "timeout" in kwargs:
            timeout = kwargs["timeout"]
        if timeout is None:
            self._wait_event.wait()
            return self._returncode
        if self._wait_event.wait(timeout):
            return self._returncode
        raise subprocess.TimeoutExpired(cmd=["fake-shell"], timeout=timeout)

    def kill(self) -> None:
        self.kill_called = True
        self._returncode = -9
        self._wait_event.set()


class _ImmediateTimeoutPopen:
    def __init__(self, *, stdout_text: str, stderr_text: str) -> None:
        self.stdin = None
        self.stdout = io.StringIO(stdout_text)
        self.stderr = io.StringIO(stderr_text)
        self.kill_called = False
        self._timed_out = False

    def wait(self, *args, **kwargs) -> int:
        timeout = None
        if len(args) > 0:
            timeout = args[0]
        if "timeout" in kwargs:
            timeout = kwargs["timeout"]
        if timeout is not None and not self._timed_out:
            self._timed_out = True
            raise subprocess.TimeoutExpired(cmd=["fake-shell"], timeout=timeout)
        return -9

    def kill(self) -> None:
        self.kill_called = True


def _wait_for_status(
    service: shell_session_service.ShellSessionService,
    *,
    note_id: str,
    run_id: str,
    expected_status: str,
) -> dict[str, object]:
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        snapshot = service.get_snapshot(note_id=note_id, run_id=run_id)
        if snapshot["status"] == expected_status:
            return snapshot
        time.sleep(0.01)
    raise AssertionError(f"Timed out waiting for shell run status {expected_status}")


def test_resolve_shell_command_prefers_login_shell_for_bash(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shell_session_service.os, "name", "posix", raising=False)
    monkeypatch.setenv("SHELL", "/bin/bash")

    command = shell_session_service._resolve_shell_command(script_text="echo hello")

    assert command == ["/bin/bash", "-lc", "echo hello"]


def test_shell_session_streams_output_without_stdin(monkeypatch: pytest.MonkeyPatch) -> None:
    wait_event = threading.Event()
    fake_process = _BlockingPopen(
        wait_event=wait_event,
        stdout_text="hello from stdout\n",
        stderr_text="warning on stderr\n",
        returncode=0,
    )
    service = shell_session_service.ShellSessionService()
    popen_calls: list[dict[str, object]] = []

    monkeypatch.setattr(shell_session_service, "_resolve_shell_command", lambda *, script_text: ["fake-shell"])
    monkeypatch.setattr(
        shell_session_service.subprocess,
        "Popen",
        lambda *args, **kwargs: popen_calls.append(kwargs) or fake_process,
    )

    started = service.start_run(note_id="note-1", script_text="echo hello", timeout_seconds=0)
    run_id = started["runId"]
    assert isinstance(run_id, str) and run_id != ""
    assert len(popen_calls) == 1
    assert popen_calls[0]["stdin"] is subprocess.DEVNULL

    running = _wait_for_status(service, note_id="note-1", run_id=run_id, expected_status="running")
    assert running["stdout"] == "hello from stdout\n"
    assert running["stderr"] == "warning on stderr\n"

    wait_event.set()
    completed = _wait_for_status(service, note_id="note-1", run_id=run_id, expected_status="success")
    assert completed["exitCode"] == 0


def test_shell_session_marks_timeout_and_kills_process(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_process = _ImmediateTimeoutPopen(
        stdout_text="partial stdout\n",
        stderr_text="partial stderr\n",
    )
    service = shell_session_service.ShellSessionService()

    monkeypatch.setattr(shell_session_service, "_resolve_shell_command", lambda *, script_text: ["fake-shell"])
    monkeypatch.setattr(
        shell_session_service.subprocess,
        "Popen",
        lambda *args, **kwargs: fake_process,
    )

    started = service.start_run(note_id="note-2", script_text="echo timeout", timeout_seconds=1)
    run_id = started["runId"]
    completed = _wait_for_status(service, note_id="note-2", run_id=run_id, expected_status="timeout")

    assert fake_process.kill_called is True
    assert completed["errorMessage"] == "Shell command timed out after 1 seconds"
    assert completed["stdout"] == "partial stdout\n"
    assert completed["stderr"] == "partial stderr\n"


@pytest.mark.skipif(os.name == 'nt', reason='POSIX process-group integration test')
def test_namespace_reset_stops_worker_and_drops_output(monkeypatch):
    service = shell_session_service.ShellSessionService()
    monkeypatch.setattr(shell_session_service, '_resolve_shell_command', lambda **kwargs: [
        sys.executable, '-c', "import time; print('PRIVATE_SHELL_CANARY', flush=True); time.sleep(20)",
    ])
    started = service.start_run(note_id='fixture', script_text='fixture', timeout_seconds=30)
    record = service._runs[started['runId']]
    deadline = time.monotonic() + 3
    while not record.stdout_chunks and time.monotonic() < deadline:
        time.sleep(0.01)
    try:
        assert 'PRIVATE_SHELL_CANARY' in ''.join(record.stdout_chunks)
    finally:
        service.reset()
    assert service._runs == {}
    assert record.process.poll() is not None
    assert record.stdout_chunks == record.stderr_chunks == []
    assert not record.stdout_thread.is_alive()
    assert not record.stderr_thread.is_alive()
    assert not record.monitor_thread.is_alive()
