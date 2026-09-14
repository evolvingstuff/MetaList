from __future__ import annotations

import shutil
import subprocess
import time
import ctypes
from ctypes import wintypes


_WAIT_POLL_INTERVAL_SECONDS = 0.25
_TERMINATE_GRACE_SECONDS = 5.0
_KILL_GRACE_SECONDS = 5.0


def _validate_pid(*, pid: int) -> None:
    if not isinstance(pid, int):
        raise TypeError(f"pid must be an int, got {type(pid)}")
    if pid <= 0:
        raise ValueError(f"pid must be positive, got: {pid}")


def _validate_port(*, port: int) -> None:
    if not isinstance(port, int):
        raise TypeError(f"port must be an int, got {type(port)}")
    if port <= 0 or port > 65535:
        raise ValueError(f"port must be between 1 and 65535, got: {port}")


def _resolve_powershell_path() -> str:
    powershell_path = shutil.which("powershell.exe")
    if powershell_path is not None:
        return powershell_path
    pwsh_path = shutil.which("pwsh.exe")
    if pwsh_path is not None:
        return pwsh_path
    raise RuntimeError("PowerShell is required for MetaList process management on Windows")


def _run_powershell(*, script: str, operation: str) -> str:
    if script.strip() == "":
        raise ValueError("PowerShell script must not be empty")
    if operation.strip() == "":
        raise ValueError("PowerShell operation must not be empty")
    completed = subprocess.run(
        [
            _resolve_powershell_path(),
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ],
        capture_output=True,
        check=False,
        text=True,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"PowerShell failed while {operation}: "
            f"exit={completed.returncode} stderr={completed.stderr.strip()!r}"
        )
    return completed.stdout.strip()


def find_listening_pids_for_port(*, port: int) -> list[int]:
    _validate_port(port=port)
    stdout = _run_powershell(
        script=(
            f"@(Get-NetTCPConnection -State Listen -LocalPort {port} -ErrorAction SilentlyContinue "
            "| Select-Object -ExpandProperty OwningProcess) -join [Environment]::NewLine"
        ),
        operation=f"checking port {port}",
    )
    if stdout == "":
        return []

    ordered_pids: list[int] = []
    seen_pids: set[int] = set()
    for raw_line in stdout.splitlines():
        raw_pid = raw_line.strip()
        if not raw_pid.isdigit():
            raise RuntimeError(
                f"PowerShell returned a non-numeric listener pid for port {port}: {raw_pid!r}"
            )
        pid = int(raw_pid)
        if pid <= 0:
            raise RuntimeError(f"PowerShell returned invalid listener pid for port {port}: {pid}")
        if pid in seen_pids:
            continue
        seen_pids.add(pid)
        ordered_pids.append(pid)
    return ordered_pids


def is_process_running(*, pid: int) -> bool:
    _validate_pid(pid=pid)
    stdout = _run_powershell(
        script=(
            f"@(Get-Process -Id {pid} -ErrorAction SilentlyContinue "
            "| Select-Object -ExpandProperty Id) -join [Environment]::NewLine"
        ),
        operation=f"checking process {pid}",
    )
    if stdout == "":
        return False
    if stdout != str(pid):
        raise RuntimeError(f"PowerShell returned an unexpected process id for pid {pid}: {stdout!r}")
    return True


def _wait_for_process_exit(*, pid: int, timeout_seconds: float) -> bool:
    if not isinstance(timeout_seconds, float):
        raise TypeError(f"timeout_seconds must be a float, got {type(timeout_seconds)}")
    if timeout_seconds < 0.0:
        raise ValueError(f"timeout_seconds must be >= 0.0, got {timeout_seconds}")

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not is_process_running(pid=pid):
            return True
        time.sleep(_WAIT_POLL_INTERVAL_SECONDS)
    return not is_process_running(pid=pid)


def stop_process(*, pid: int) -> None:
    _validate_pid(pid=pid)
    if not is_process_running(pid=pid):
        return

    _run_powershell(
        script=f"Stop-Process -Id {pid} -ErrorAction Stop",
        operation=f"stopping process {pid}",
    )
    if _wait_for_process_exit(pid=pid, timeout_seconds=_TERMINATE_GRACE_SECONDS):
        return
    if not is_process_running(pid=pid):
        return

    _run_powershell(
        script=f"Stop-Process -Id {pid} -Force -ErrorAction Stop",
        operation=f"force-stopping process {pid}",
    )
    if _wait_for_process_exit(pid=pid, timeout_seconds=_KILL_GRACE_SECONDS):
        return
    if not is_process_running(pid=pid):
        return
    raise RuntimeError(f"Timed out waiting for Windows process {pid} to exit")


def _creation_filetime(process) -> int:
    """Read identity from the owned handle, which survives exit and prevents PID reuse."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_times = kernel32.GetProcessTimes
    get_times.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
    get_times.restype = wintypes.BOOL
    created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
    if not get_times(int(process._handle), ctypes.byref(created), ctypes.byref(exited),
                     ctypes.byref(kernel), ctypes.byref(user)):
        raise ctypes.WinError(ctypes.get_last_error())
    return (created.dwHighDateTime << 32) | created.dwLowDateTime


def stop_process_tree(*, process) -> None:
    """Stop and wait for descendants, including children of an exited parent."""
    pid = process.pid
    _validate_pid(pid=pid)
    created_filetime = _creation_filetime(process)
    _run_powershell(
        script=(
            "$ErrorActionPreference = 'Stop'; "
            "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop); "
            f"$pending = [System.Collections.Generic.List[int]]::new(); $pending.Add({pid}); "
            f"$created = @{{}}; $created[{pid}] = [datetime]::FromFileTimeUtc({created_filetime}); "
            "$seen = [System.Collections.Generic.HashSet[int]]::new(); "
            "for ($i=0; $i -lt $pending.Count; $i++) { "
            "$parent = $pending[$i]; if (-not $seen.Add($parent)) { continue }; "
            "foreach ($child in $all) { if ($child.ParentProcessId -eq $parent) { "
            "if ($null -eq $child.CreationDate) { throw 'Missing child process creation time' }; "
            "$birth = $child.CreationDate.ToUniversalTime(); "
            "if ($birth -ge $created[$parent]) { "
            "$pending.Add([int]$child.ProcessId); $created[[int]$child.ProcessId] = $birth } } } }; "
            "for ($i=$pending.Count-1; $i -ge 0; $i--) { "
            "$target = Get-Process -Id $pending[$i] -ErrorAction SilentlyContinue; "
            "if ($null -ne $target) { try { "
            "$null = $target.Handle; "
            "if ($target.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -ne "
            "$created[$pending[$i]].ToString('yyyyMMddHHmmssffffff')) { throw 'Process identity changed before cleanup' }; "
            "$target | Stop-Process -Force -ErrorAction Stop; "
            f"if (-not $target.WaitForExit({int(_KILL_GRACE_SECONDS * 1000)})) {{ "
            "throw ('Timed out waiting for process ' + $pending[$i] + ' to exit') } "
            "} finally { $target.Dispose() } } }; "
            # An absent launcher is expected after its child exits. Its final
            # Get-Process lookup can leave $? false despite successful cleanup.
            "exit 0"
        ),
        operation=f"stopping process tree {pid}",
    )
