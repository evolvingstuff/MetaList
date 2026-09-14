from __future__ import annotations

import os
from pathlib import Path
import subprocess

import pytest

import app.services.self_update as self_update


@pytest.fixture(autouse=True)
def _isolate_update_backups(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(self_update, "_prepare_update", lambda *, uv_executable, target_version, environ: [
        uv_executable, "tool", "install", "--force", "--offline", "--python", "/base/python3.14",
        "--compile-bytecode", f"metalist=={target_version}",
    ])
    def _unexpected_backup(**kwargs):
        raise AssertionError("this test must not create a backup")

    monkeypatch.setattr(
        self_update,
        "resolve_namespaces_directory",
        lambda: tmp_path / "namespaces",
    )
    monkeypatch.setattr(
        self_update,
        "backup_all_namespaces_for_update",
        _unexpected_backup,
    )


@pytest.fixture
def successful_backups(monkeypatch, tmp_path: Path) -> tuple[Path, ...]:
    backup_paths = (tmp_path / "default-backup.tar.gz", tmp_path / "work-backup.tar.gz")
    monkeypatch.setattr(
        self_update,
        "backup_all_namespaces_for_update",
        lambda **kwargs: backup_paths,
    )
    return backup_paths


@pytest.mark.parametrize("platform_name", ("darwin", "linux"))
def test_schedule_posix_self_update_stops_servers_then_hands_off_to_shell(
    monkeypatch,
    platform_name: str,
    successful_backups: tuple[Path, ...],
) -> None:
    popen_calls: list[tuple[list[str], dict[str, object]]] = []
    monkeypatch.setattr(
        self_update,
        "stop_all_namespace_processes_for_update",
        lambda: 3,
    )
    monkeypatch.setattr(self_update, "_fetch_latest_pypi_version", lambda: "0.3.13")
    monkeypatch.setattr(self_update.shutil, "which", lambda command: "/opt/homebrew/bin/uv")
    monkeypatch.setattr(
        self_update.subprocess,
        "Popen",
        lambda command, **kwargs: popen_calls.append((command, kwargs)),
    )

    result = self_update.schedule_self_update(
        current_version="0.3.12",
        metalist_executable="/Users/example/.local/bin/metalist",
        current_pid=4321,
        platform_name=platform_name,
        environ={"PATH": "/opt/homebrew/bin"},
    )

    assert result.stopped_process_count == 3
    assert result.platform_name == platform_name
    assert result.current_version == "0.3.12"
    assert result.target_version == "0.3.13"
    assert result.update_scheduled is True
    assert len(popen_calls) == 1
    command, kwargs = popen_calls[0]
    assert command[:2] == ["/bin/sh", "-c"]
    assert "kill -0 4321" in command[2]
    assert "/opt/homebrew/bin/uv tool install --force --offline --python /base/python3.14 --compile-bytecode metalist==0.3.13" in command[2]
    assert "/Users/example/.local/bin/metalist" in command[2]
    assert "MetaList updated to v0.3.13." in command[2]
    assert kwargs["start_new_session"] is True
    assert kwargs["cwd"] == str(self_update.Path.home())
    assert kwargs["env"] == {"PATH": "/opt/homebrew/bin"}


def test_schedule_windows_self_update_uses_external_powershell_console(
    monkeypatch,
    successful_backups: tuple[Path, ...],
) -> None:
    popen_calls: list[tuple[list[str], dict[str, object]]] = []
    executable_paths = {
        "uv": "C:\\Users\\example\\.local\\bin\\uv.exe",
        "powershell.exe": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    }

    def _resolve_executable(command: str) -> str | None:
        if command in executable_paths:
            return executable_paths[command]
        return None

    monkeypatch.setattr(
        self_update,
        "stop_all_namespace_processes_for_update",
        lambda: 2,
    )
    monkeypatch.setattr(self_update, "_fetch_latest_pypi_version", lambda: "0.3.13")
    monkeypatch.setattr(self_update.shutil, "which", _resolve_executable)
    monkeypatch.setattr(
        self_update.subprocess,
        "Popen",
        lambda command, **kwargs: popen_calls.append((command, kwargs)),
    )

    result = self_update.schedule_self_update(
        current_version="0.3.12",
        metalist_executable="C:\\Users\\example\\.local\\bin\\metalist.exe",
        current_pid=9876,
        platform_name="win32",
        environ={"PATH": "C:\\Windows\\System32"},
    )

    assert result.stopped_process_count == 2
    assert result.platform_name == "win32"
    assert result.current_version == "0.3.12"
    assert result.target_version == "0.3.13"
    assert result.update_scheduled is True
    assert len(popen_calls) == 1
    command, kwargs = popen_calls[0]
    assert command[:5] == [
        executable_paths["powershell.exe"],
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
    ]
    assert "Get-Process -Id 9876" in command[5]
    assert "'tool' 'install' '--force' '--offline' '--python' '/base/python3.14' '--compile-bytecode' 'metalist==0.3.13'" in command[5]
    assert "metalist.exe" in command[5]
    assert "MetaList updated to v0.3.13." in command[5]
    assert kwargs["creationflags"] == self_update._WINDOWS_CREATE_NEW_CONSOLE
    assert kwargs["cwd"] == str(self_update.Path.home())
    assert kwargs["env"] == {"PATH": "C:\\Windows\\System32"}


@pytest.mark.parametrize("platform_name", ("darwin", "linux", "win32"))
def test_schedule_self_update_backs_up_after_stop_before_install(
    monkeypatch,
    tmp_path: Path,
    capsys,
    platform_name: str,
) -> None:
    events: list[str] = []
    namespaces_directory = tmp_path / "namespaces"
    backup_paths = (
        namespaces_directory / "default" / "backups" / "before-update.tar.gz",
        namespaces_directory / "work" / "backups" / "before-update.tar.gz",
    )

    def _stop_servers() -> int:
        events.append("stop")
        return 2

    def _backup_namespaces(*, namespaces_directory: Path) -> tuple[Path, ...]:
        assert namespaces_directory == tmp_path / "namespaces"
        events.append("backup")
        return backup_paths

    def _launch_updater(command, **kwargs) -> None:
        events.append("install")

    monkeypatch.setattr(self_update, "_fetch_latest_pypi_version", lambda: "0.3.13")
    monkeypatch.setattr(self_update.shutil, "which", lambda command: "/tools/" + command)
    monkeypatch.setattr(self_update, "stop_all_namespace_processes_for_update", _stop_servers)
    monkeypatch.setattr(self_update, "backup_all_namespaces_for_update", _backup_namespaces)
    monkeypatch.setattr(self_update.subprocess, "Popen", _launch_updater)

    result = self_update.schedule_self_update(
        current_version="0.3.12",
        metalist_executable="/tools/metalist",
        current_pid=4321,
        platform_name=platform_name,
        environ={},
    )

    assert events == ["stop", "backup", "install"]
    assert result.update_scheduled is True
    assert "2 namespace backup(s)" in result.message
    output = capsys.readouterr().out
    assert "Backing up all namespaces" in output


@pytest.mark.parametrize("platform_name", ("darwin", "linux", "win32"))
@pytest.mark.parametrize(
    "backup_failure",
    (
        OSError("backup disk is full"),
        self_update.sqlite3.DatabaseError("database is corrupt"),
        self_update.tarfile.ReadError("invalid archive"),
        RuntimeError("backup checksum mismatch"),
    ),
)
def test_schedule_self_update_aborts_before_install_when_backup_fails(
    monkeypatch,
    platform_name: str,
    backup_failure: Exception,
) -> None:
    events: list[str] = []

    def _stop_servers() -> int:
        events.append("stop")
        return 2

    def _fail_backup(**kwargs):
        events.append("backup")
        raise backup_failure

    def _unexpected_updater(*args, **kwargs):
        raise AssertionError("a failed backup must prevent installation")

    monkeypatch.setattr(self_update, "_fetch_latest_pypi_version", lambda: "0.3.13")
    monkeypatch.setattr(self_update.shutil, "which", lambda command: "/tools/" + command)
    monkeypatch.setattr(self_update, "stop_all_namespace_processes_for_update", _stop_servers)
    monkeypatch.setattr(self_update, "backup_all_namespaces_for_update", _fail_backup)
    monkeypatch.setattr(self_update.subprocess, "Popen", _unexpected_updater)

    with pytest.raises(RuntimeError, match="backup failed.*update aborted") as caught:
        self_update.schedule_self_update(
            current_version="0.3.12",
            metalist_executable="/tools/metalist",
            current_pid=4321,
            platform_name=platform_name,
            environ={},
        )

    assert events == ["stop", "backup"]
    assert caught.value.__cause__ is backup_failure
    assert "current version is intact" in str(caught.value)
    assert "servers are stopped" in str(caught.value)
    assert "run metalist to restart" in str(caught.value)


@pytest.mark.parametrize("failure_type", (AssertionError, TypeError, AttributeError))
def test_backup_programming_errors_propagate_without_being_reclassified(
    monkeypatch,
    failure_type,
) -> None:
    programming_error = failure_type("broken backup invariant")

    def _fail_backup(**kwargs):
        raise programming_error

    monkeypatch.setattr(self_update, "backup_all_namespaces_for_update", _fail_backup)

    with pytest.raises(failure_type) as caught:
        self_update._back_up_namespaces_before_update()

    assert caught.value is programming_error


def test_schedule_self_update_refuses_to_stop_servers_without_uv(monkeypatch) -> None:
    monkeypatch.setattr(self_update, "_fetch_latest_pypi_version", lambda: "0.3.13")
    monkeypatch.setattr(self_update.shutil, "which", lambda command: None)
    monkeypatch.setattr(
        self_update,
        "stop_all_namespace_processes_for_update",
        lambda: (_ for _ in ()).throw(AssertionError("servers must remain running")),
    )

    with pytest.raises(RuntimeError, match="uv executable was not found"):
        self_update.schedule_self_update(
            current_version="0.3.12",
            metalist_executable="/Users/example/.local/bin/metalist",
            current_pid=os.getpid(),
            platform_name="linux",
            environ={},
        )


def test_schedule_posix_self_update_refuses_to_stop_servers_without_shell(monkeypatch) -> None:
    monkeypatch.setattr(self_update, "_fetch_latest_pypi_version", lambda: "0.3.13")
    monkeypatch.setattr(self_update.shutil, "which", lambda command: "/tools/uv")
    monkeypatch.setattr(self_update.Path, "is_file", lambda path: False)
    monkeypatch.setattr(
        self_update,
        "stop_all_namespace_processes_for_update",
        lambda: (_ for _ in ()).throw(AssertionError("servers must remain running")),
    )

    with pytest.raises(RuntimeError, match="/bin/sh is required"):
        self_update.schedule_self_update(
            current_version="0.3.12",
            metalist_executable="/tools/metalist",
            current_pid=4321,
            platform_name="linux",
            environ={},
        )


def test_schedule_windows_self_update_refuses_to_stop_servers_without_powershell(monkeypatch) -> None:
    executable_paths = {"uv": "C:\\Users\\example\\.local\\bin\\uv.exe"}

    def _resolve_executable(command: str) -> str | None:
        if command in executable_paths:
            return executable_paths[command]
        return None

    monkeypatch.setattr(self_update.shutil, "which", _resolve_executable)
    monkeypatch.setattr(self_update, "_fetch_latest_pypi_version", lambda: "0.3.13")
    monkeypatch.setattr(
        self_update,
        "stop_all_namespace_processes_for_update",
        lambda: (_ for _ in ()).throw(AssertionError("servers must remain running")),
    )

    with pytest.raises(RuntimeError, match="PowerShell is required"):
        self_update.schedule_self_update(
            current_version="0.3.12",
            metalist_executable="C:\\Users\\example\\.local\\bin\\metalist.exe",
            current_pid=1234,
            platform_name="win32",
            environ={},
        )


def test_schedule_self_update_does_nothing_when_current_version_matches_pypi(monkeypatch) -> None:
    monkeypatch.setattr(self_update, "_fetch_latest_pypi_version", lambda: "0.3.12")
    monkeypatch.setattr(
        self_update.shutil,
        "which",
        lambda command: (_ for _ in ()).throw(AssertionError("uv must not be resolved")),
    )
    monkeypatch.setattr(
        self_update,
        "stop_all_namespace_processes_for_update",
        lambda: (_ for _ in ()).throw(AssertionError("servers must remain running")),
    )
    monkeypatch.setattr(
        self_update.subprocess,
        "Popen",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("updater must not start")),
    )

    result = self_update.schedule_self_update(
        current_version="0.3.12",
        metalist_executable="/Users/example/.local/bin/metalist",
        current_pid=4321,
        platform_name="darwin",
        environ={"PATH": "/opt/homebrew/bin"},
    )

    assert result.current_version == "0.3.12"
    assert result.target_version == "0.3.12"
    assert result.update_scheduled is False
    assert result.stopped_process_count == 0
    assert result.message == "MetaList is already up to date (v0.3.12)."


def test_schedule_self_update_does_not_downgrade_a_newer_install(monkeypatch) -> None:
    monkeypatch.setattr(self_update, "_fetch_latest_pypi_version", lambda: "0.3.12")
    monkeypatch.setattr(
        self_update,
        "stop_all_namespace_processes_for_update",
        lambda: (_ for _ in ()).throw(AssertionError("servers must remain running")),
    )

    result = self_update.schedule_self_update(
        current_version="0.3.13",
        metalist_executable="/Users/example/.local/bin/metalist",
        current_pid=4321,
        platform_name="darwin",
        environ={},
    )

    assert result.update_scheduled is False
    assert result.stopped_process_count == 0
    assert result.message == (
        "MetaList v0.3.13 is newer than the latest PyPI release "
        "(v0.3.12); no update was performed."
    )


def test_fetch_latest_pypi_version_reads_validated_project_metadata(monkeypatch) -> None:
    request = self_update.httpx.Request("GET", self_update._PYPI_PROJECT_URL)
    response = self_update.httpx.Response(
        200,
        json={"info": {"version": "0.3.13"}},
        request=request,
    )
    calls: list[tuple[str, dict[str, object]]] = []
    monkeypatch.setattr(
        self_update.httpx,
        "get",
        lambda url, **kwargs: calls.append((url, kwargs)) or response,
    )

    assert self_update._fetch_latest_pypi_version() == "0.3.13"
    assert calls == [
        (
            self_update._PYPI_PROJECT_URL,
            {
                "follow_redirects": False,
                "timeout": self_update._PYPI_REQUEST_TIMEOUT_SECONDS,
            },
        )
    ]


def test_schedule_self_update_leaves_servers_running_when_pypi_check_fails(monkeypatch) -> None:
    monkeypatch.setattr(
        self_update.httpx,
        "get",
        lambda *args, **kwargs: (_ for _ in ()).throw(self_update.httpx.ConnectError("offline")),
    )
    monkeypatch.setattr(
        self_update,
        "stop_all_namespace_processes_for_update",
        lambda: (_ for _ in ()).throw(AssertionError("servers must remain running")),
    )

    with pytest.raises(self_update.httpx.ConnectError, match="offline"):
        self_update.schedule_self_update(
            current_version="0.3.12",
            metalist_executable="/Users/example/.local/bin/metalist",
            current_pid=4321,
            platform_name="darwin",
            environ={},
        )


def test_update_preflight_failure_keeps_current_servers_running(monkeypatch):
    events = []
    monkeypatch.setattr(self_update, "_fetch_latest_pypi_version", lambda: "0.6.2")
    monkeypatch.setattr(self_update.shutil, "which", lambda name: "/tools/" + name)
    monkeypatch.setattr(self_update, "stop_all_namespace_processes_for_update", lambda: events.append("stop"))

    def unavailable(**kwargs):
        events.append("preflight")
        raise RuntimeError("candidate unavailable")

    monkeypatch.setattr(self_update, "_prepare_update", unavailable, raising=False)
    with pytest.raises(RuntimeError, match="candidate unavailable"):
        self_update.schedule_self_update(current_version="0.6.1", metalist_executable="/tools/metalist", current_pid=4321, platform_name="darwin", environ={})
    assert events == ["preflight"]
