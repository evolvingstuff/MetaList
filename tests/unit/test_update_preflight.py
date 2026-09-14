from pathlib import Path
import json
import sys
from types import SimpleNamespace

import httpx
import pytest

from app.services import update_preflight


@pytest.mark.parametrize("platform", ["linux", "darwin", "win32"])
def test_preflight_pins_current_python_isolates_tools_and_freezes_tested_dependencies(monkeypatch, platform):
    calls = []
    probes = []
    base_python = str(Path(sys._base_executable).resolve())
    monkeypatch.setattr(update_preflight.sys, "platform", platform)

    def run(command, *, environ, directory):
        calls.append((command, environ, directory))
        assert Path(environ["UV_TOOL_DIR"]).is_relative_to(directory)
        assert Path(environ["UV_TOOL_BIN_DIR"]).is_relative_to(directory)
        if "-c" in command:
            return json.dumps([list(sys.version_info[:2]), "0.6.2"])
        if "freeze" in command:
            return "metalist==0.6.2\nhttpx==0.28.1\n"
        return ""

    monkeypatch.setattr(update_preflight, "_run_checked", run)
    monkeypatch.setattr(update_preflight, "_probe_candidate", lambda **kwargs: probes.append(kwargs))
    environ = {"PATH": "/tools", "UV_TOOL_DIR": "/real/tools", "UV_TOOL_BIN_DIR": "/real/bin"}
    install = update_preflight.prepare_update(uv_executable="uv", target_version="0.6.2", environ=environ)
    assert install == ["uv", "tool", "install", "--force", "--offline", "--python", base_python,
                       "--compile-bytecode", "metalist==0.6.2", "--with", "httpx==0.28.1"]
    assert calls[0][0][calls[0][0].index("--python") + 1] == base_python
    assert len(probes) == 1
    assert probes[0]["environ"] == environ
    assert environ["UV_TOOL_DIR"] == "/real/tools"
    assert not calls[0][2].exists()


def test_preflight_rejects_interpreter_drift_before_startup(monkeypatch):
    def run(command, **kwargs):
        if "-c" in command:
            return json.dumps([[9, 9], "0.6.2"])
        return ""

    monkeypatch.setattr(update_preflight, "_run_checked", run)
    monkeypatch.setattr(update_preflight, "_probe_candidate", lambda **kwargs: pytest.fail("must reject interpreter drift"))
    with pytest.raises(RuntimeError, match="changed Python"):
        update_preflight.prepare_update(uv_executable="uv", target_version="0.6.2", environ={})


@pytest.mark.parametrize("startup_fails", [False, True])
def test_windows_probe_stops_python_child_even_when_launcher_exits(monkeypatch, tmp_path, startup_fails):
    alive = {"launcher": True, "python_child": True}

    class Launcher:
        pid = 4321
        returncode = None

        def poll(self):
            return self.returncode

        def terminate(self):
            alive["launcher"] = False
            self.returncode = 0

        def wait(self, *, timeout):
            assert not alive["launcher"]
            return 0

    launcher = Launcher()

    def wait_for_ready(**kwargs):
        if startup_fails:
            launcher.terminate()
            raise RuntimeError("probe failed startup")

    def stop_tree(*, pid):
        assert pid == launcher.pid
        launcher.terminate()
        alive["python_child"] = False

    def response(request):
        return httpx.Response(200, json={"version": "0.6.3"})

    client = httpx.Client(base_url="http://probe", transport=httpx.MockTransport(response))
    monkeypatch.setattr(update_preflight, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(update_preflight, "_run_checked", lambda *args, **kwargs: "")
    monkeypatch.setattr(update_preflight.subprocess, "Popen", lambda *args, **kwargs: launcher)
    monkeypatch.setattr(update_preflight, "_wait_for_namespace_ready", wait_for_ready)
    monkeypatch.setattr(update_preflight.httpx, "Client", lambda **kwargs: client)
    monkeypatch.setattr(update_preflight, "stop_windows_process_tree", stop_tree)
    kwargs = dict(python="python.exe", executable="metalist.exe", directory=tmp_path,
                  environ={}, target_version="0.6.3")
    if startup_fails:
        with pytest.raises(RuntimeError, match="probe failed startup"):
            update_preflight._probe_candidate(**kwargs)
    else:
        update_preflight._probe_candidate(**kwargs)
    assert not alive["python_child"], "Probe child still holds its temporary log files open"
    assert not alive["launcher"]
