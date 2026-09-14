from __future__ import annotations

import shutil
import subprocess
import time


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


def stop_process_tree(*, pid: int) -> None:
    """Stop and wait for descendants, including children of an exited parent."""
    _validate_pid(pid=pid)
    _run_powershell(
        script=(
            "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop); "
            f"$pending = [System.Collections.Generic.List[int]]::new(); $pending.Add({pid}); "
            "$seen = [System.Collections.Generic.HashSet[int]]::new(); "
            "for ($i=0; $i -lt $pending.Count; $i++) { "
            "$parent = $pending[$i]; if (-not $seen.Add($parent)) { continue }; "
            "foreach ($child in $all) { if ($child.ParentProcessId -eq $parent) { $pending.Add([int]$child.ProcessId) } } }; "
            "for ($i=$pending.Count-1; $i -ge 0; $i--) { "
            "$target = Get-Process -Id $pending[$i] -ErrorAction SilentlyContinue; "
            "if ($null -ne $target) { try { "
            "$null = $target.Handle; "
            "$target | Stop-Process -Force -ErrorAction Stop; "
            f"if (-not $target.WaitForExit({int(_KILL_GRACE_SECONDS * 1000)})) {{ "
            "throw ('Timed out waiting for process ' + $pending[$i] + ' to exit') } "
            "} finally { $target.Dispose() } } }"
        ),
        operation=f"stopping process tree {pid}",
    )
