from __future__ import annotations

from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
import os
import shutil
import subprocess
import sys

import pytest

from app.services import windows_process_control


@pytest.fixture
def real_powershell(monkeypatch):
    paths = [shutil.which(name) for name in ("powershell.exe", "pwsh")]
    executables = [path for path in paths if path is not None]
    if not executables:
        if "GITHUB_ACTIONS" in os.environ and os.environ["GITHUB_ACTIONS"] == "true":
            pytest.fail("Release CI requires PowerShell for process-cleanup regressions")
        pytest.skip("PowerShell runtime is not installed")
    executable = executables[0]
    monkeypatch.setattr(windows_process_control, "_resolve_powershell_path", lambda: executable)
    run = windows_process_control._run_powershell
    if sys.platform != "win32":
        # Windows reads the retained Popen handle with GetProcessTimes. Use the
        # same creation timestamp through .NET on other hosts.
        def created(process):
            if process.poll() is not None:
                return 1
            return int(run(script=f"(Get-Process -Id {process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc()",
                           operation="reading disposable test process identity"))
        monkeypatch.setattr(windows_process_control, "_creation_filetime", created)
    return windows_process_control._run_powershell


def test_real_powershell_tree_cleanup_accepts_already_exited_launcher(monkeypatch, real_powershell):
    launcher = subprocess.Popen([sys.executable, "-c", "pass"])
    launcher.wait(timeout=10)

    def run(*, script, operation):
        # WMI is Windows-only. Supply an empty descendant snapshot, retaining
        # real Get-Process and PowerShell exit semantics on every test host.
        return real_powershell(script="function Get-CimInstance { @() }; " + script, operation=operation)

    monkeypatch.setattr(windows_process_control, "_run_powershell", run)
    windows_process_control.stop_process_tree(process=launcher)


def test_real_powershell_tree_cleanup_waits_for_live_process(monkeypatch, real_powershell):
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])

    def run(*, script, operation):
        return real_powershell(script="function Get-CimInstance { @() }; " + script, operation=operation)

    monkeypatch.setattr(windows_process_control, "_run_powershell", run)
    # Reap concurrently: Unix keeps a killed process as a zombie until its
    # parent waits, unlike Windows. PowerShell must observe actual exit.
    with ThreadPoolExecutor(max_workers=1) as executor:
        reaped = executor.submit(process.wait)
        try:
            windows_process_control.stop_process_tree(process=process)
            assert reaped.result(timeout=1) is not None
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)


@pytest.mark.parametrize("fixture, message", [
    ("function Get-CimInstance { throw 'enumeration fixture failure' }; ", "enumeration fixture failure"),
    ("function Get-CimInstance { @() }; function Get-Process { [pscustomobject]@{Handle=1; StartTime=[datetime]::FromFileTimeUtc(1)} | "
     "Add-Member -MemberType ScriptMethod -Name Dispose -Value {} -PassThru }; "
     "function Stop-Process { Write-Error 'termination fixture failure' }; ", "termination fixture failure"),
    ("function Get-CimInstance { @() }; function Get-Process { [pscustomobject]@{Handle=1; StartTime=[datetime]::FromFileTimeUtc(1)} | "
     "Add-Member -MemberType ScriptMethod -Name Dispose -Value {} -PassThru }; "
     "function Stop-Process { }; ", "WaitForExit"),
])
def test_real_powershell_tree_cleanup_propagates_failures(monkeypatch, real_powershell, fixture, message):
    def run(*, script, operation):
        return real_powershell(
            script=fixture + script,
            operation=operation,
        )

    monkeypatch.setattr(windows_process_control, "_run_powershell", run)
    monkeypatch.setattr(windows_process_control, "_creation_filetime", lambda process: 1)
    with pytest.raises(RuntimeError, match=message):
        windows_process_control.stop_process_tree(process=SimpleNamespace(pid=4321))


@pytest.mark.parametrize("launcher_exited", [False, True])
def test_real_powershell_excludes_stale_parent_pid_links(monkeypatch, real_powershell, launcher_exited):
    fixture = (
        "function Get-CimInstance { @( "
        "[pscustomobject]@{ProcessId=2;ParentProcessId=1;CreationDate=[datetime]::FromFileTimeUtc(100)}; "
        "[pscustomobject]@{ProcessId=3;ParentProcessId=1;CreationDate=[datetime]::FromFileTimeUtc(300)} "
        ") }; "
        "function Get-Process { param($Id); "
        "if ($Id -eq 2) { throw 'Unrelated older process selected for termination' }; "
        "if ($Id -eq 1 -and $launcherExited) { return }; "
        "$birth = 200; if ($Id -eq 3) { $birth = 300 }; "
        "$p = [pscustomobject]@{Handle=1;Id=$Id;StartTime=[datetime]::FromFileTimeUtc($birth)}; "
        "$p | Add-Member ScriptMethod Dispose {}; $p | Add-Member ScriptMethod WaitForExit { return $true }; $p }; "
        "function Stop-Process { param([Parameter(ValueFromPipeline=$true)]$InputObject, [switch]$Force); "
        "process { Write-Output $InputObject.Id } }; "
    )
    stopped = []

    def run(*, script, operation):
        output = real_powershell(script=f"$launcherExited = ${str(launcher_exited).lower()}; " + fixture + script,
                                 operation=operation)
        stopped.extend(output.splitlines())
        return output

    monkeypatch.setattr(windows_process_control, "_creation_filetime", lambda process: 200)
    monkeypatch.setattr(windows_process_control, "_run_powershell", run)
    windows_process_control.stop_process_tree(process=SimpleNamespace(pid=1))
    expected = ["3"]
    if not launcher_exited:
        expected.append("1")
    assert stopped == expected


def test_find_listening_pids_for_port_uses_powershell_and_deduplicates(monkeypatch) -> None:
    completed = SimpleNamespace(returncode=0, stdout="4321\n4321\n8765\n", stderr="")
    calls: list[list[str]] = []

    monkeypatch.setattr(
        windows_process_control,
        "_resolve_powershell_path",
        lambda: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    )
    monkeypatch.setattr(
        windows_process_control.subprocess,
        "run",
        lambda command, **kwargs: calls.append(command) or completed,
    )

    assert windows_process_control.find_listening_pids_for_port(port=8443) == [4321, 8765]
    assert "Get-NetTCPConnection -State Listen -LocalPort 8443" in calls[0][-1]


def test_is_process_running_returns_false_when_powershell_finds_no_process(monkeypatch) -> None:
    completed = SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(
        windows_process_control,
        "_resolve_powershell_path",
        lambda: "powershell.exe",
    )
    monkeypatch.setattr(windows_process_control.subprocess, "run", lambda *args, **kwargs: completed)

    assert windows_process_control.is_process_running(pid=4321) is False


def test_stop_process_escalates_to_force(monkeypatch) -> None:
    running_results = iter([True, True, False])
    commands: list[str] = []

    monkeypatch.setattr(
        windows_process_control,
        "is_process_running",
        lambda *, pid: next(running_results),
    )
    monkeypatch.setattr(
        windows_process_control,
        "_wait_for_process_exit",
        lambda *, pid, timeout_seconds: False,
    )
    monkeypatch.setattr(
        windows_process_control,
        "_run_powershell",
        lambda *, script, operation: commands.append(script),
    )

    windows_process_control.stop_process(pid=4321)

    assert commands == [
        "Stop-Process -Id 4321 -ErrorAction Stop",
        "Stop-Process -Id 4321 -Force -ErrorAction Stop",
    ]
