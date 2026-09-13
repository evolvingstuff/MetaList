from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
import traceback

import app.server_runtime as server_runtime
from app.server_runtime import save_namespace_launch_profile
from app.server_runtime import resolve_namespace_directory
from app.server_runtime import validate_namespace
from app.services.exception_capture import CapturedExceptionContext
from app.services.namespace_deletion_jobs import mark_namespace_deletion_job_failed
from app.services.namespace_deletion_jobs import mark_namespace_deletion_job_succeeded
from app.services.namespace_switcher import open_or_launch_namespace
from app.services.windows_process_control import is_process_running as is_windows_process_running
from app.services.windows_process_control import stop_process as stop_windows_process


_WAIT_POLL_INTERVAL_SECONDS = 0.25
_INITIAL_EXIT_GRACE_SECONDS = 1.0
_TERMINATE_GRACE_SECONDS = 5.0
_KILL_GRACE_SECONDS = 5.0


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Delete a namespace after its server process exits")
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--replacement-namespace", required=True)
    parser.add_argument("--replacement-port", type=int, required=True)
    parser.add_argument("--replacement-https-port", type=int, required=True)
    parser.add_argument("--recreate-default", action="store_true")
    return parser.parse_args()


def _read_process_state(*, pid: int) -> str | None:
    result = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        return None
    process_state = result.stdout.strip()
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
    kill_capture = CapturedExceptionContext(ProcessLookupError, PermissionError, boundary='app/services/namespace_deletion_worker.py:_is_process_running:kill_capture')
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
    signal_capture = CapturedExceptionContext(ProcessLookupError, boundary='app/services/namespace_deletion_worker.py:_send_signal_if_running:signal_capture')
    with signal_capture:
        os.kill(pid, signal_number)
    if signal_capture.captured_exception is not None:
        return


def _stop_process(*, pid: int) -> None:
    if sys.platform == "win32":
        stop_windows_process(pid=pid)
        return
    if _wait_for_process_exit(pid=pid, timeout_seconds=_INITIAL_EXIT_GRACE_SECONDS):
        return

    _send_signal_if_running(pid=pid, signal_number=signal.SIGTERM)
    if _wait_for_process_exit(pid=pid, timeout_seconds=_TERMINATE_GRACE_SECONDS):
        return

    _send_signal_if_running(pid=pid, signal_number=signal.SIGKILL)
    if _wait_for_process_exit(pid=pid, timeout_seconds=_KILL_GRACE_SECONDS):
        return

    raise RuntimeError(f"Timed out waiting for process {pid} to exit")


def _delete_namespace_directory(*, namespace: str) -> None:
    namespace_directory = resolve_namespace_directory(namespace=namespace)
    if not namespace_directory.exists():
        return
    if not namespace_directory.is_dir():
        raise RuntimeError(f"Namespace path is not a directory: {namespace_directory}")
    shutil.rmtree(namespace_directory)


def _recreate_default_namespace(*, args: argparse.Namespace) -> None:
    replacement_namespace = validate_namespace(namespace=args.replacement_namespace)
    if replacement_namespace != server_runtime._DEFAULT_NAMESPACE:
        raise RuntimeError("Final namespace deletion must recreate default")
    https_port = args.replacement_https_port
    if https_port == 0:
        https_port = None
    save_namespace_launch_profile(
        namespace=replacement_namespace,
        port=args.replacement_port,
        https_port=https_port,
        mcp_port=None,
    )
    open_or_launch_namespace(
        environ=os.environ,
        current_namespace=None,
        namespace=replacement_namespace,
        port=args.replacement_port,
        https_port=https_port,
    )


def main() -> None:
    args = _parse_args()
    main_capture = CapturedExceptionContext(Exception, boundary='app/services/namespace_deletion_worker.py:main:main_capture')
    with main_capture:
        normalized_namespace = validate_namespace(namespace=args.namespace)
        _stop_process(pid=args.pid)
        _delete_namespace_directory(namespace=normalized_namespace)
        if args.recreate_default:
            _recreate_default_namespace(args=args)
        mark_namespace_deletion_job_succeeded(job_id=args.job_id)
    if main_capture.captured_exception is not None:
        mark_namespace_deletion_job_failed(
            job_id=args.job_id,
            error=traceback.format_exc(),
        )
        raise main_capture.captured_exception


if __name__ == "__main__":
    main()
