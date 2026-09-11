from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


_SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "smoke_installed_package.py"
_SCRIPT_SPEC = importlib.util.spec_from_file_location("installed_smoke_script", _SCRIPT_PATH)
assert _SCRIPT_SPEC is not None and _SCRIPT_SPEC.loader is not None
smoke = importlib.util.module_from_spec(_SCRIPT_SPEC)
_SCRIPT_SPEC.loader.exec_module(smoke)


@pytest.mark.parametrize("platform_name", ["posix", "nt"])
def test_smoke_cleanup_selects_only_exact_owned_namespace_processes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    platform_name: str,
) -> None:
    executable = tmp_path / "Données environment" / "metalist"
    namespace = "release-smoke-random-first"
    commands = [
        (111, f'"{executable}" --namespace {namespace} --port 12345'),
        (222, f'"{tmp_path / "unrelated"}" --namespace {namespace} --port 12345'),
        (333, f'"{executable}" --namespace different --port 12345'),
        (444, f'"{executable}" --namespace {namespace}-other --port 12345'),
    ]
    if platform_name == "nt":
        output = json.dumps([{"ProcessId": pid, "CommandLine": command} for pid, command in commands])
    else:
        output = "\n".join(f"{pid} {command}" for pid, command in commands)
    monkeypatch.setattr(smoke, "os", SimpleNamespace(name=platform_name))
    monkeypatch.setattr(smoke.shutil, "which", lambda name: name)
    monkeypatch.setattr(smoke.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(stdout=output))

    assert smoke._namespace_processes(executable=executable, profiles=[(namespace, 12345, 12346)]) == {111}


def test_smoke_cleanup_does_not_terminate_unowned_processes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    probes = iter([{111}, set()])
    monkeypatch.setattr(smoke, "_namespace_processes", lambda **kwargs: next(probes))
    terminated = []
    monkeypatch.setattr(smoke.os, "kill", lambda pid, signal: terminated.append(pid))

    smoke._stop_namespace_children(executable=tmp_path / "metalist", profiles=[("unique-smoke", 12345, 12346)])

    assert terminated == [111]


def test_failure_stack_dump_signals_only_owned_processes_with_registered_handler(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    logs_directory = tmp_path / "logs"
    logs_directory.mkdir()
    namespace = "unique-smoke"
    (logs_directory / f"{namespace}-server.log").write_text(
        "INFO | pid=111 thread=MainThread | [diagnostics] process diagnostics enabled log_path=example\n"
        "INFO | pid=333 thread=MainThread | [diagnostics] process diagnostics enabled log_path=example\n",
        encoding="utf-8",
    )
    fault_path = logs_directory / f"{namespace}-server.fault.log"
    fault_path.write_text("", encoding="utf-8")
    monkeypatch.setattr(smoke, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(smoke, "signal", SimpleNamespace(SIGUSR1=10))
    monkeypatch.setattr(smoke, "_namespace_processes", lambda **kwargs: {111, 222})
    signaled = []

    def signal_owned_child(pid: int, signal_number: int) -> None:
        signaled.append((pid, signal_number))
        fault_path.write_text("blocked child stack", encoding="utf-8")

    monkeypatch.setattr(smoke.os, "kill", signal_owned_child)

    smoke._dump_failed_namespace_stacks(
        executable=tmp_path / "metalist", profiles=[(namespace, 12345, 12346)], data_directory=tmp_path,
    )

    assert signaled == [(111, 10)]
    assert "blocked child stack" in capsys.readouterr().out
