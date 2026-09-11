from __future__ import annotations

from pathlib import Path
import shutil
import sqlite3
import sys
from urllib.parse import parse_qs, urlsplit

import pytest

import app.server_runtime as server_runtime
import app.services.namespace_switcher as namespace_switcher
from app.server_runtime import delete_namespace_launch_profile
from app.server_runtime import load_namespace_launch_profile
from app.server_runtime import NamespaceLaunchProfile
from app.server_runtime import save_namespace_launch_profile
from app.services.namespace_switcher import build_namespace_catalog
from app.services.namespace_switcher import build_login_namespace_catalog
from app.services.namespace_switcher import delete_current_namespace
from app.services.namespace_switcher import delete_namespace
from app.services.namespace_switcher import open_login_namespace
from app.services.namespace_switcher import open_or_launch_namespace
from app.services.namespace_switcher import open_or_launch_all_namespaces
from app.services.namespace_switcher import rename_current_namespace
from app.services.namespace_switcher import save_namespace_port_profiles
from app.services.namespace_switcher import stop_all_namespace_processes_for_update
from app.services.namespace_switcher import NamespaceOpenResult
from app.services.namespace_switcher import _probe_namespace_status


@pytest.fixture(autouse=True)
def _assume_no_external_port_listeners(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        namespace_switcher,
        "_find_listening_pids_for_port",
        lambda *, port: [],
    )


def test_rename_current_namespace_preserves_ports_and_starts_worker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="default",
        port=8000,
        https_port=None,
        mcp_port=8765,
    )
    worker_requests: list[dict[str, object]] = []
    monkeypatch.setattr(
        namespace_switcher,
        "create_namespace_rename_job",
        lambda *, source_namespace, target_namespace: {
            "job_id": "11111111-1111-1111-1111-111111111111",
            "status": "pending",
            "source_namespace": source_namespace,
            "target_namespace": target_namespace,
            "error": "",
        },
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_spawn_namespace_rename_worker",
        lambda **kwargs: worker_requests.append(kwargs),
    )
    monkeypatch.setattr(namespace_switcher.os, "getpid", lambda: 4321)

    result = rename_current_namespace(
        environ={},
        current_namespace="default",
        target_namespace="personal",
    )

    assert result.source_namespace == "default"
    assert result.target_namespace == "personal"
    assert result.rename_job_id == "11111111-1111-1111-1111-111111111111"
    parsed_redirect = urlsplit(result.redirect_url)
    assert parsed_redirect.netloc == "127.0.0.1:8000"
    assert parsed_redirect.path == "/namespace-renamed"
    assert parse_qs(parsed_redirect.query) == {
        "job": ["11111111-1111-1111-1111-111111111111"]
    }
    assert worker_requests == [
        {
            "environ": {},
            "source_namespace": "default",
            "target_namespace": "personal",
            "current_pid": 4321,
            "job_id": "11111111-1111-1111-1111-111111111111",
            "profile": NamespaceLaunchProfile(
                namespace="personal",
                port=8000,
                https_port=None,
                mcp_port=8765,
            ),
        }
    ]


def test_rename_current_namespace_rejects_existing_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(namespace="default", port=8000, https_port=None, mcp_port=8765)
    save_namespace_launch_profile(namespace="personal", port=8001, https_port=None, mcp_port=8766)

    with pytest.raises(RuntimeError, match="Namespace personal already exists"):
        rename_current_namespace(
            environ={},
            current_namespace="default",
            target_namespace="personal",
        )


def _disable_default_tls(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", tmp_path / "missing-cert.pem")
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", tmp_path / "missing-key.pem")


def test_build_namespace_catalog_suggests_next_free_ports(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="default",
        port=8000,
        https_port=None,
        mcp_port=8765,
    )
    save_namespace_launch_profile(
        namespace="cla",
        port=8001,
        https_port=None,
        mcp_port=8766,
    )

    catalog = build_namespace_catalog(
        environ={},
        current_namespace="default",
    )

    assert catalog["current_namespace"] == "default"
    assert catalog["current_profile"] == {
        "namespace": "default",
        "port": 8000,
        "https_port": None,
    }
    assert catalog["new_namespace_profile"] == {
        "namespace": "new-namespace",
        "port": 8002,
        "https_port": None,
    }

    namespaces = {entry["namespace"]: entry for entry in catalog["namespaces"]}
    assert namespaces["default"]["default_profile"] == {
        "namespace": "default",
        "port": 8000,
        "https_port": None,
    }
    assert namespaces["cla"]["default_profile"] == {
        "namespace": "cla",
        "port": 8001,
        "https_port": None,
    }


def test_build_namespace_catalog_skips_ports_with_os_listeners(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="default",
        port=8000,
        https_port=None,
        mcp_port=None,
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_find_listening_pids_for_port",
        lambda *, port: [4321] if port == 8001 else [],
    )

    catalog = build_namespace_catalog(
        environ={},
        current_namespace="default",
    )

    assert catalog["new_namespace_profile"] == {
        "namespace": "new-namespace",
        "port": 8002,
        "https_port": None,
    }


def test_build_namespace_catalog_skips_os_listeners_for_http_and_https(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    monkeypatch.setattr(namespace_switcher, "_supports_https", lambda *, environ: True)
    save_namespace_launch_profile(
        namespace="default",
        port=8000,
        https_port=8443,
        mcp_port=None,
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_find_listening_pids_for_port",
        lambda *, port: [4321] if port in {8001, 8444} else [],
    )

    catalog = build_namespace_catalog(
        environ={},
        current_namespace="default",
    )

    assert catalog["new_namespace_profile"] == {
        "namespace": "new-namespace",
        "port": 8002,
        "https_port": 8445,
    }


def test_build_namespace_catalog_includes_existing_database_without_saved_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    database_path = server_runtime.resolve_namespaced_database_path(namespace="work")
    server_runtime.prepare_database_runtime_path(database_path=database_path)
    database_path.write_text("", encoding="utf-8")

    catalog = build_namespace_catalog(
        environ={},
        current_namespace="default",
    )

    namespaces = {entry["namespace"]: entry for entry in catalog["namespaces"]}
    assert namespaces["work"]["database_exists"] is True
    assert namespaces["work"]["has_launch_profile"] is False
    assert namespaces["work"]["default_profile"] == {
        "namespace": "work",
        "port": 8001,
        "https_port": None,
    }


def test_build_namespace_catalog_does_not_recreate_deleted_default_when_henry_exists(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(namespace="default", port=8000, https_port=None, mcp_port=8765)
    save_namespace_launch_profile(namespace="henry", port=8001, https_port=None, mcp_port=8766)
    shutil.rmtree(server_runtime.resolve_namespace_directory(namespace="default"))

    catalog = build_namespace_catalog(environ={}, current_namespace=None)

    assert [entry["namespace"] for entry in catalog["namespaces"]] == ["henry"]


def test_build_login_namespace_catalog_returns_plain_namespace_names(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="default",
        port=8000,
        https_port=None,
        mcp_port=8765,
    )
    save_namespace_launch_profile(
        namespace="cla",
        port=8001,
        https_port=None,
        mcp_port=8766,
    )

    catalog = build_login_namespace_catalog(
        environ={},
        current_namespace="default",
    )

    assert catalog == {
        "current_namespace": "default",
        "namespaces": ["default", "cla"],
    }


def test_open_or_launch_namespace_rejects_reserved_current_port(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)

    with pytest.raises(
        RuntimeError,
        match="HTTP port 8000 conflicts with HTTP port reserved for namespace default",
    ):
        open_or_launch_namespace(
            environ={},
            current_namespace="default",
            namespace="work",
            port=8000,
            https_port=None,
        )


def test_open_or_launch_namespace_launches_new_process_and_saves_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    launched: list[tuple[str, int]] = []
    waited: list[tuple[str, int, object]] = []

    def _fake_launch(*, environ, chosen_profile):
        launched.append((chosen_profile.namespace, chosen_profile.port))
        return "launched-process"

    def _fake_wait(*, environ, namespace, port, launched_process):
        waited.append((namespace, port, launched_process))

    monkeypatch.setattr(namespace_switcher, "_find_running_namespace_port", lambda **kwargs: None)
    monkeypatch.setattr(namespace_switcher, "_assert_ports_are_available_for_launch", lambda **kwargs: None)
    monkeypatch.setattr(namespace_switcher, "_launch_namespace_process", _fake_launch)
    monkeypatch.setattr(namespace_switcher, "_wait_for_namespace_ready", _fake_wait)

    result = open_or_launch_namespace(
        environ={},
        current_namespace="default",
        namespace="work",
        port=8123,
        https_port=None,
    )

    assert result.action == "launched"
    assert result.url == "http://127.0.0.1:8123"
    assert launched == [("work", 8123)]
    assert waited == [("work", 8123, "launched-process")]
    saved_profile = load_namespace_launch_profile(namespace="work")
    assert saved_profile is not None
    assert saved_profile.port == 8123
    assert saved_profile.https_port is None
    assert saved_profile.mcp_port is None


def test_save_namespace_port_profiles_updates_without_launching(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="cla",
        port=8001,
        https_port=None,
        mcp_port=8766,
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_launch_namespace_process",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("_launch_namespace_process should not be called")),
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_restart_running_namespace_process",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("_restart_running_namespace_process should not be called")),
    )

    result = save_namespace_port_profiles(
        environ={},
        current_namespace="default",
        requested_profiles=[
            NamespaceLaunchProfile(
                namespace="cla",
                port=8011,
                https_port=None,
                mcp_port=8776,
            )
        ],
    )

    assert result.message == "Saved ports for 1 namespace(s)."
    assert result.saved_profiles == [
        NamespaceLaunchProfile(
            namespace="cla",
            port=8011,
            https_port=None,
            mcp_port=8766,
        )
    ]
    saved_profile = load_namespace_launch_profile(namespace="cla")
    assert saved_profile == NamespaceLaunchProfile(
        namespace="cla",
        port=8011,
        https_port=None,
        mcp_port=8766,
    )


def test_save_namespace_port_profiles_rejects_batch_conflicts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)

    with pytest.raises(
        RuntimeError,
        match="HTTP port 8100 for namespace work conflicts with HTTP port for namespace cla",
    ):
        save_namespace_port_profiles(
            environ={},
            current_namespace="default",
            requested_profiles=[
                NamespaceLaunchProfile(
                    namespace="cla",
                    port=8100,
                    https_port=None,
                    mcp_port=8766,
                ),
                NamespaceLaunchProfile(
                    namespace="work",
                    port=8100,
                    https_port=None,
                    mcp_port=8767,
                ),
            ],
        )


def test_open_login_namespace_uses_catalog_default_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="cla",
        port=8001,
        https_port=None,
        mcp_port=8766,
    )
    opened: list[tuple[str | None, str, int, int | None]] = []

    def _fake_open_or_launch_namespace(
        *,
        environ,
        current_namespace,
        namespace,
        port,
        https_port,
    ) -> NamespaceOpenResult:
        opened.append((current_namespace, namespace, port, https_port))
        return NamespaceOpenResult(
            namespace=namespace,
            action="opened-running",
            url=f"http://127.0.0.1:{port}",
            saved_profile=NamespaceLaunchProfile(
                namespace=namespace,
                port=port,
                https_port=https_port,
                mcp_port=None,
            ),
            saved_for_next_launch=False,
            message=f"Opened namespace {namespace}.",
        )

    monkeypatch.setattr(namespace_switcher, "open_or_launch_namespace", _fake_open_or_launch_namespace)

    result = open_login_namespace(
        environ={},
        current_namespace="default",
        namespace="cla",
    )

    assert opened == [("default", "cla", 8001, None)]
    assert result.url == "http://127.0.0.1:8001"


def test_open_or_launch_all_namespaces_uses_catalog_default_profiles(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="default",
        port=8000,
        https_port=None,
        mcp_port=8765,
    )
    save_namespace_launch_profile(
        namespace="cla",
        port=8001,
        https_port=None,
        mcp_port=8766,
    )
    opened: list[tuple[str | None, str, int, int | None]] = []

    def _fake_open_or_launch_namespace(
        *,
        environ,
        current_namespace,
        namespace,
        port,
        https_port,
    ) -> NamespaceOpenResult:
        opened.append((current_namespace, namespace, port, https_port))
        return NamespaceOpenResult(
            namespace=namespace,
            action="launched",
            url=f"http://127.0.0.1:{port}",
            saved_profile=NamespaceLaunchProfile(
                namespace=namespace,
                port=port,
                https_port=https_port,
                mcp_port=None,
            ),
            saved_for_next_launch=False,
            message=f"Started namespace {namespace}.",
        )

    monkeypatch.setattr(namespace_switcher, "open_or_launch_namespace", _fake_open_or_launch_namespace)

    results = open_or_launch_all_namespaces(environ={})

    assert opened == [
        (None, "default", 8000, None),
        (None, "cla", 8001, None),
    ]
    assert [result.namespace for result in results] == ["default", "cla"]


def test_open_or_launch_all_namespaces_repairs_saved_port_conflicts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    monkeypatch.setattr(namespace_switcher, "_supports_https", lambda *, environ: True)
    save_namespace_launch_profile(
        namespace="default",
        port=8000,
        https_port=8443,
        mcp_port=8765,
    )
    save_namespace_launch_profile(
        namespace="henry",
        port=8000,
        https_port=8443,
        mcp_port=8765,
    )
    opened: list[NamespaceLaunchProfile] = []

    def _fake_open_or_launch_namespace(**kwargs) -> NamespaceOpenResult:
        profile = NamespaceLaunchProfile(
            namespace=kwargs["namespace"],
            port=kwargs["port"],
            https_port=kwargs["https_port"],
            mcp_port=None,
        )
        opened.append(profile)
        return NamespaceOpenResult(
            namespace=profile.namespace,
            action="launched",
            url=f"http://127.0.0.1:{profile.port}",
            saved_profile=profile,
            saved_for_next_launch=False,
            message=f"Started namespace {profile.namespace}.",
        )

    monkeypatch.setattr(namespace_switcher, "open_or_launch_namespace", _fake_open_or_launch_namespace)

    open_or_launch_all_namespaces(environ={})

    assert opened == [
        NamespaceLaunchProfile(namespace="default", port=8000, https_port=8443, mcp_port=None),
        NamespaceLaunchProfile(namespace="henry", port=8001, https_port=8444, mcp_port=None),
    ]
    assert load_namespace_launch_profile(namespace="henry") == NamespaceLaunchProfile(
        namespace="henry",
        port=8001,
        https_port=8444,
        mcp_port=8765,
    )
    assert (
        "[startup] WARNING: adjusted namespace henry ports to resolve a saved conflict: "
        "HTTP 8000 -> 8001, HTTPS 8443 -> 8444."
    ) in capsys.readouterr().err


def test_stop_all_namespace_processes_for_update_deduplicates_listener_pids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        namespace_switcher,
        "load_all_namespace_launch_profiles_read_only",
        lambda: [
            NamespaceLaunchProfile(
                namespace="default",
                port=8000,
                https_port=8443,
                mcp_port=8765,
            ),
            NamespaceLaunchProfile(
                namespace="henry",
                port=8000,
                https_port=8444,
                mcp_port=8766,
            ),
        ],
    )
    listener_pids = {
        8000: [111, 222],
        8443: [111],
        8444: [222],
    }
    monkeypatch.setattr(
        namespace_switcher,
        "_find_listening_pids_for_port",
        lambda *, port: listener_pids[port],
    )
    monkeypatch.setattr(namespace_switcher.os, "getpid", lambda: 222)
    stopped: list[int] = []
    monkeypatch.setattr(
        namespace_switcher,
        "_stop_process",
        lambda *, pid: stopped.append(pid),
    )

    count = stop_all_namespace_processes_for_update()

    assert count == 1
    assert stopped == [111]


def test_stop_for_update_preserves_historical_namespace_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    database_path = server_runtime.resolve_namespaced_database_path(namespace="work")
    database_path.parent.mkdir(parents=True)
    connection = sqlite3.connect(database_path)
    try:
        connection.execute(
            "CREATE TABLE namespace_launch_profile "
            "(namespace TEXT, port INTEGER, https_port INTEGER, mcp_port INTEGER)"
        )
        connection.execute(
            "INSERT INTO namespace_launch_profile VALUES ('work', 8000, 8443, 8765)"
        )
        connection.execute("PRAGMA user_version = 1")
        connection.commit()
    finally:
        connection.close()
    before_database_bytes = database_path.read_bytes()
    before_files = set(database_path.parent.iterdir())
    listener_ports: list[int] = []
    stopped_pids: list[int] = []

    def find_listeners(*, port: int) -> list[int]:
        listener_ports.append(port)
        return [1234]

    monkeypatch.setattr(namespace_switcher, "_find_listening_pids_for_port", find_listeners)
    monkeypatch.setattr(namespace_switcher, "_stop_process", lambda *, pid: stopped_pids.append(pid))

    assert stop_all_namespace_processes_for_update() == 1

    assert listener_ports == [8000, 8443]
    assert stopped_pids == [1234]
    assert database_path.read_bytes() == before_database_bytes
    assert set(database_path.parent.iterdir()) == before_files


def test_open_or_launch_all_namespaces_restarts_warm_running_processes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="default",
        port=8000,
        https_port=None,
        mcp_port=8765,
    )

    def _fake_open_or_launch_namespace(**kwargs) -> NamespaceOpenResult:
        profile = NamespaceLaunchProfile(
            namespace=kwargs["namespace"],
            port=kwargs["port"],
            https_port=kwargs["https_port"],
            mcp_port=None,
        )
        return NamespaceOpenResult(
            namespace=profile.namespace,
            action="opened-running",
            url=f"http://127.0.0.1:{profile.port}",
            saved_profile=profile,
            saved_for_next_launch=False,
            message=f"Namespace {profile.namespace} is already running with a warm cache.",
        )

    restarted: list[tuple[str, int]] = []
    monkeypatch.setattr(namespace_switcher, "open_or_launch_namespace", _fake_open_or_launch_namespace)
    monkeypatch.setattr(
        namespace_switcher,
        "_restart_running_namespace_process",
        lambda *, environ, namespace, chosen_profile, running_port: restarted.append(
            (namespace, running_port)
        ),
    )

    results = open_or_launch_all_namespaces(environ={})

    assert restarted == [("default", 8000)]
    assert len(results) == 1
    assert results[0].action == "restarted"
    assert results[0].message == "Restarted namespace default."


def test_open_or_launch_all_namespaces_rejects_missing_launch_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    database_path = server_runtime.resolve_namespaced_database_path(namespace="work")
    server_runtime.prepare_database_runtime_path(database_path=database_path)
    database_path.touch()

    with pytest.raises(RuntimeError, match="Namespace work has no launch profile"):
        open_or_launch_all_namespaces(environ={})


def test_restart_running_namespace_process_allows_existing_namespace_ports_before_relaunch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checks: list[tuple[str, object]] = []

    monkeypatch.setattr(namespace_switcher, "_find_listening_pids_for_port", lambda *, port: [2345] if port == 8123 else [])
    monkeypatch.setattr(
        namespace_switcher,
        "_assert_ports_are_available_for_launch",
        lambda *, environ, namespace, chosen_profile, allowed_listener_pids: checks.append(
            ("assert", (namespace, chosen_profile.port, allowed_listener_pids))
        ),
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_stop_processes_listening_on_port",
        lambda *, port: checks.append(("stop", port)),
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_launch_namespace_process",
        lambda *, environ, chosen_profile: checks.append(("launch", (chosen_profile.namespace, chosen_profile.port))) or "launched-process",
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_wait_for_namespace_ready",
        lambda *, environ, namespace, port, launched_process: checks.append(
            ("wait", (namespace, port, launched_process))
        ),
    )

    namespace_switcher._restart_running_namespace_process(
        environ={},
        namespace="work",
        chosen_profile=NamespaceLaunchProfile(
            namespace="work",
            port=8123,
            https_port=None,
            mcp_port=8766,
        ),
        running_port=8123,
    )

    assert checks == [
        ("assert", ("work", 8123, frozenset({2345}))),
        ("stop", 8123),
        ("launch", ("work", 8123)),
        ("wait", ("work", 8123, "launched-process")),
    ]


def test_assert_ports_are_available_for_launch_ignores_legacy_port_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        namespace_switcher,
        "resolve_main_server_config",
        lambda *, environ: server_runtime.MainServerConfig(
            host="127.0.0.1",
            port=8000,
            https_port=None,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1,::1",
            ssl_certfile=None,
            ssl_keyfile=None,
        ),
    )
    monkeypatch.setattr(namespace_switcher, "resolve_backend_connect_host", lambda *, host: "127.0.0.1")
    monkeypatch.setattr(namespace_switcher, "resolve_api_prefix", lambda *, environ: "/api2")
    monkeypatch.setattr(
        namespace_switcher,
        "_probe_namespace_status",
        lambda *, host, port, api_prefix: {"namespace": "work"} if port == 8123 else None,
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_is_tcp_port_open",
        lambda *, host, port: port in {8123, 8766},
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_find_listening_pids_for_port",
        lambda *, port: [2345] if port in {8123, 8766} else [],
    )

    namespace_switcher._assert_ports_are_available_for_launch(
        environ={},
        namespace="work",
        chosen_profile=NamespaceLaunchProfile(
            namespace="work",
            port=8123,
            https_port=None,
            mcp_port=8766,
        ),
        allowed_listener_pids=frozenset({2345}),
    )


def test_assert_ports_are_available_for_launch_rejects_conflicting_ports_without_eviction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    evicted_ports: list[int] = []

    monkeypatch.setattr(
        namespace_switcher,
        "resolve_main_server_config",
        lambda *, environ: server_runtime.MainServerConfig(
            host="127.0.0.1",
            port=8000,
            https_port=None,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1,::1",
            ssl_certfile=None,
            ssl_keyfile=None,
        ),
    )
    monkeypatch.setattr(namespace_switcher, "resolve_backend_connect_host", lambda *, host: "127.0.0.1")
    monkeypatch.setattr(namespace_switcher, "resolve_api_prefix", lambda *, environ: "/api2")
    monkeypatch.setattr(
        namespace_switcher,
        "_probe_namespace_status",
        lambda *, host, port, api_prefix: {"namespace": "default"} if port == 8123 else None,
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_is_tcp_port_open",
        lambda *, host, port: port in {8123, 8766},
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_find_listening_pids_for_port",
        lambda *, port: [9999] if port in {8123, 8766} else [],
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_stop_processes_listening_on_port",
        lambda *, port: evicted_ports.append(port),
    )

    with pytest.raises(RuntimeError, match="HTTP port 8123 is already in use"):
        namespace_switcher._assert_ports_are_available_for_launch(
            environ={},
            namespace="work",
            chosen_profile=NamespaceLaunchProfile(
                namespace="work",
                port=8123,
                https_port=None,
                mcp_port=8766,
            ),
            allowed_listener_pids=frozenset(),
        )

    assert evicted_ports == []


def test_assert_ports_are_available_for_launch_rejects_https_listener_without_eviction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    evicted_ports: list[int] = []
    monkeypatch.setattr(
        namespace_switcher,
        "resolve_main_server_config",
        lambda *, environ: server_runtime.MainServerConfig(
            host="127.0.0.1",
            port=8000,
            https_port=8443,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1,::1",
            ssl_certfile="cert.pem",
            ssl_keyfile="key.pem",
        ),
    )
    monkeypatch.setattr(namespace_switcher, "resolve_backend_connect_host", lambda *, host: "127.0.0.1")
    monkeypatch.setattr(namespace_switcher, "resolve_api_prefix", lambda *, environ: "/api2")
    monkeypatch.setattr(namespace_switcher, "_probe_namespace_status", lambda **kwargs: None)
    monkeypatch.setattr(
        namespace_switcher,
        "_is_tcp_port_open",
        lambda *, host, port: port == 8444,
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_stop_processes_listening_on_port",
        lambda *, port: evicted_ports.append(port),
    )

    with pytest.raises(RuntimeError, match="HTTPS port 8444 is already in use"):
        namespace_switcher._assert_ports_are_available_for_launch(
            environ={},
            namespace="work",
            chosen_profile=NamespaceLaunchProfile(
                namespace="work",
                port=8001,
                https_port=8444,
                mcp_port=None,
            ),
            allowed_listener_pids=frozenset(),
        )

    assert evicted_ports == []


def test_launch_namespace_process_uses_recorded_python_script_entrypoint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    launched: dict[str, object] = {}

    def _fake_popen(command, **kwargs):
        launched["command"] = command
        launched["env"] = kwargs["env"]
        launched["stdout_name"] = kwargs["stdout"].name

        class _Process:
            pass

        return _Process()

    monkeypatch.setattr(
        namespace_switcher,
        "resolve_runtime_logs_directory",
        lambda: tmp_path / "logs",
    )
    monkeypatch.setattr(namespace_switcher.subprocess, "Popen", _fake_popen)

    namespace_switcher._launch_namespace_process(
        environ={
            "METALIST_SELF_EXECUTABLE": "/tmp/metalist/main.py",
            "METALIST_SHELL_ENABLED": "1",
        },
        chosen_profile=NamespaceLaunchProfile(
            namespace="work",
            port=8123,
            https_port=None,
            mcp_port=8766,
        ),
    )

    assert launched["command"] == [
        sys.executable,
        "/tmp/metalist/serve_namespace.py",
        "--namespace",
        "work",
        "--port",
        "8123",
        "--enable-shell",
    ]
    assert Path(str(launched["stdout_name"])).parent == tmp_path / "logs"
    launched_env = launched["env"]
    assert isinstance(launched_env, dict)
    assert "METALIST_NAMESPACE" not in launched_env
    assert "METALIST_PORT" not in launched_env
    assert "METALIST_HTTPS_PORT" not in launched_env
    assert "MCP_AGENT_WEB_PORT" not in launched_env
    assert launched_env["METALIST_ORCHESTRATED_CHILD"] == "1"


def test_wait_for_namespace_ready_reports_early_child_exit_and_log(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    log_path = tmp_path / "namespace-default.log"
    log_path.write_text("Traceback\nRuntimeError: child exploded\n", encoding="utf-8")

    class _ExitedProcess:
        def poll(self) -> int:
            return 7

    launched_process = namespace_switcher.NamespaceLaunchProcess(
        process=_ExitedProcess(),
        log_path=log_path,
        log_start_offset=0,
    )
    monkeypatch.setattr(
        namespace_switcher,
        "resolve_main_server_config",
        lambda *, environ: server_runtime.MainServerConfig(
            host="127.0.0.1",
            port=8000,
            https_port=None,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1,::1",
            ssl_certfile=None,
            ssl_keyfile=None,
        ),
    )
    monkeypatch.setattr(namespace_switcher, "resolve_backend_connect_host", lambda *, host: host)
    monkeypatch.setattr(namespace_switcher, "resolve_api_prefix", lambda *, environ: "/api2")

    with pytest.raises(
        RuntimeError,
        match=r"(?s)Namespace default process exited with code 7.*child exploded",
    ):
        namespace_switcher._wait_for_namespace_ready(
            environ={},
            namespace="default",
            port=8000,
            launched_process=launched_process,
        )


def test_read_namespace_launch_log_tail_excludes_previous_launches(tmp_path: Path) -> None:
    log_path = tmp_path / "namespace-default.log"
    previous_launch = "old query value that must not be repeated\n"
    current_launch = "RuntimeError: current launch failed\n"
    log_path.write_text(previous_launch + current_launch, encoding="utf-8")

    log_tail = namespace_switcher._read_namespace_launch_log_tail(
        log_path=log_path,
        log_start_offset=len(previous_launch.encode("utf-8")),
    )

    assert log_tail == "RuntimeError: current launch failed"
    assert "old query value" not in log_tail


def test_open_or_launch_namespace_restarts_running_namespace_and_updates_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="work",
        port=8123,
        https_port=None,
        mcp_port=8766,
    )
    monkeypatch.setattr(namespace_switcher, "_find_running_namespace_port", lambda **kwargs: 8123)
    restarted: list[tuple[str, int, int]] = []
    monkeypatch.setattr(
        namespace_switcher,
        "_restart_running_namespace_process",
        lambda *, environ, namespace, chosen_profile, running_port: restarted.append(
            (namespace, chosen_profile.port, running_port)
        ),
    )

    result = open_or_launch_namespace(
        environ={},
        current_namespace="default",
        namespace="work",
        port=8124,
        https_port=None,
    )

    assert result.action == "restarted"
    assert result.url == "http://127.0.0.1:8124"
    assert result.saved_for_next_launch is True
    assert restarted == [("work", 8124, 8123)]
    saved_profile = load_namespace_launch_profile(namespace="work")
    assert saved_profile is not None
    assert saved_profile.port == 8124
    assert saved_profile.mcp_port == 8766


def test_open_or_launch_namespace_reuses_warm_running_namespace_when_profile_is_unchanged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="work",
        port=8123,
        https_port=None,
        mcp_port=8766,
    )
    monkeypatch.setattr(namespace_switcher, "_find_running_namespace_port", lambda **kwargs: 8123)
    monkeypatch.setattr(
        namespace_switcher,
        "_restart_running_namespace_process",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("unchanged running namespace must not restart")
        ),
    )

    result = open_or_launch_namespace(
        environ={},
        current_namespace="default",
        namespace="work",
        port=8123,
        https_port=None,
    )

    assert result.action == "opened-running"
    assert result.url == "http://127.0.0.1:8123"
    assert result.saved_for_next_launch is False
    assert result.message == "Namespace work is already running with a warm cache."


def test_open_or_launch_namespace_short_circuits_current_namespace_process(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="default",
        port=8000,
        https_port=None,
        mcp_port=8765,
    )

    monkeypatch.setattr(
        namespace_switcher,
        "_find_running_namespace_port",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("_find_running_namespace_port should not be called")),
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_launch_namespace_process",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("_launch_namespace_process should not be called")),
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_wait_for_namespace_ready",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("_wait_for_namespace_ready should not be called")),
    )

    result = open_or_launch_namespace(
        environ={},
        current_namespace="default",
        namespace="default",
        port=8000,
        https_port=None,
    )

    assert result.action == "opened-running"
    assert result.url == "http://127.0.0.1:8000"
    assert result.saved_for_next_launch is False
    assert result.message == "Namespace default is already running."


def test_probe_namespace_status_sends_required_tab_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested: dict[str, object] = {}

    class _FakeResponse:
        status = 200

        def read(self) -> bytes:
            return b'{"namespace":"work"}'

    class _FakeConnection:
        def __init__(self, *, host, port, timeout):
            requested["host"] = host
            requested["port"] = port
            requested["timeout"] = timeout

        def request(self, method, url, headers):
            requested["method"] = method
            requested["url"] = url
            requested["headers"] = headers

        def getresponse(self):
            return _FakeResponse()

        def close(self):
            requested["closed"] = True

    monkeypatch.setattr(namespace_switcher, "HTTPConnection", _FakeConnection)

    payload = _probe_namespace_status(
        host="127.0.0.1",
        port=8001,
        api_prefix="/api2",
    )

    assert payload == {"namespace": "work"}
    assert requested["method"] == "GET"
    assert requested["url"] == "/api2/auth/status"
    assert requested["headers"] == {"X-Metalist-Tab-Id": "namespace-switcher-probe"}
    assert requested["closed"] is True

def test_delete_current_namespace_launches_default_and_spawns_cleanup_worker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    _disable_default_tls(monkeypatch, tmp_path)
    save_namespace_launch_profile(
        namespace="default",
        port=8001,
        https_port=None,
        mcp_port=8766,
    )
    launched: list[tuple[str, str, int, int | None]] = []
    cleanup_requests: list[tuple[str, int, str, bool, str]] = []

    def _fake_open_or_launch_namespace(*, environ, current_namespace, namespace, port, https_port):
        launched.append((current_namespace, namespace, port, https_port))
        return NamespaceOpenResult(
            namespace=namespace,
            action="launched",
            url=f"http://127.0.0.1:{port}",
            saved_profile=NamespaceLaunchProfile(
                namespace=namespace,
                port=port,
                https_port=https_port,
                mcp_port=None,
            ),
            saved_for_next_launch=False,
            message=f"Started namespace {namespace}.",
        )

    monkeypatch.setattr(namespace_switcher, "open_or_launch_namespace", _fake_open_or_launch_namespace)
    monkeypatch.setattr(
        namespace_switcher,
        "create_namespace_deletion_job",
        lambda *, deleted_namespace, redirect_namespace: {
            "job_id": "11111111-1111-1111-1111-111111111111",
            "status": "pending",
            "deleted_namespace": deleted_namespace,
            "redirect_namespace": redirect_namespace,
            "error": "",
        },
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_spawn_namespace_deletion_worker",
        lambda *, namespace, current_pid, job_id, recreate_default, replacement_profile: cleanup_requests.append(
            (namespace, current_pid, job_id, recreate_default, replacement_profile.namespace)
        ),
    )
    monkeypatch.setattr(namespace_switcher.os, "getpid", lambda: 4321)

    result = delete_current_namespace(
        environ={},
        current_namespace="work",
        confirmed_namespace=" work ",
        redirect_namespace="default",
    )

    assert result.deleted_namespace == "work"
    assert result.delete_job_id == "11111111-1111-1111-1111-111111111111"
    assert result.active_namespace_deleted is True
    assert result.message == "Deleting namespace work. Opening the namespace removal page."
    parsed_redirect = urlsplit(result.redirect_url)
    assert parsed_redirect.netloc == "127.0.0.1:8001"
    assert parsed_redirect.path == "/namespace-deleted"
    redirect_query = parse_qs(parsed_redirect.query)
    assert redirect_query == {"job": ["11111111-1111-1111-1111-111111111111"]}
    assert launched == [("work", "default", 8001, None)]
    assert cleanup_requests == [
        ("work", 4321, "11111111-1111-1111-1111-111111111111", False, "default")
    ]


def test_delete_current_namespace_requires_confirmed_namespace_name() -> None:
    with pytest.raises(RuntimeError, match="Type 'work' to confirm namespace deletion"):
        delete_current_namespace(
            environ={},
            current_namespace="work",
            confirmed_namespace="permanently delete",
            redirect_namespace="default",
        )


def test_delete_final_default_recreates_default_on_current_ports(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current_profile = NamespaceLaunchProfile(
        namespace="default",
        port=8002,
        https_port=8445,
        mcp_port=8767,
    )
    cleanup_requests: list[dict[str, object]] = []
    monkeypatch.setattr(
        namespace_switcher,
        "build_namespace_catalog",
        lambda *, environ, current_namespace: {
            "namespaces": [{"namespace": "default"}],
        },
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_build_current_profile",
        lambda *, environ, current_namespace: current_profile,
    )
    monkeypatch.setattr(
        namespace_switcher,
        "create_namespace_deletion_job",
        lambda *, deleted_namespace, redirect_namespace: {
            "job_id": "11111111-1111-1111-1111-111111111111",
            "deleted_namespace": deleted_namespace,
            "redirect_namespace": redirect_namespace,
        },
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_spawn_namespace_deletion_worker",
        lambda **kwargs: cleanup_requests.append(kwargs),
    )
    monkeypatch.setattr(namespace_switcher.os, "getpid", lambda: 4321)

    result = delete_current_namespace(
        environ={},
        current_namespace="default",
        confirmed_namespace="default",
        redirect_namespace="default",
    )

    assert result.redirect_url == (
        "http://127.0.0.1:8002/namespace-deleted?job=11111111-1111-1111-1111-111111111111"
    )
    assert cleanup_requests[0]["recreate_default"] is True
    assert cleanup_requests[0]["replacement_profile"] == current_profile


def test_delete_namespace_removes_inactive_namespace_without_redirect(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    namespace_directory = tmp_path / "namespaces" / "cla"
    namespace_directory.mkdir(parents=True)
    stopped_profiles: list[NamespaceLaunchProfile] = []
    target_profile = NamespaceLaunchProfile(
        namespace="cla",
        port=8002,
        https_port=None,
        mcp_port=8767,
    )

    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    monkeypatch.setattr(
        namespace_switcher,
        "_load_saved_profiles_by_namespace",
        lambda: {"cla": target_profile},
    )
    monkeypatch.setattr(
        namespace_switcher,
        "_stop_processes_for_namespace_profile",
        lambda *, profile: stopped_profiles.append(profile),
    )

    result = delete_namespace(
        environ={},
        current_namespace="test",
        target_namespace="cla",
        confirmed_namespace=" cla ",
        redirect_namespace="test",
    )

    assert result.deleted_namespace == "cla"
    assert result.redirect_url == ""
    assert result.delete_job_id == ""
    assert result.active_namespace_deleted is False
    assert result.message == "cla namespace successfully deleted."
    assert namespace_directory.exists() is False
    assert stopped_profiles == [target_profile]


def test_delete_inactive_namespace_fails_if_directory_remains(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    namespace_directory = tmp_path / "namespaces" / "default"
    namespace_directory.mkdir(parents=True)
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    monkeypatch.setattr(namespace_switcher, "_load_saved_profiles_by_namespace", lambda: {})
    monkeypatch.setattr(namespace_switcher.shutil, "rmtree", lambda path: None)

    with pytest.raises(RuntimeError, match="still exists after deletion"):
        delete_namespace(
            environ={},
            current_namespace="cla",
            target_namespace="default",
            confirmed_namespace="default",
            redirect_namespace="cla",
        )


def test_delete_namespace_launch_profile_removes_saved_entry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    save_namespace_launch_profile(
        namespace="work",
        port=8123,
        https_port=None,
        mcp_port=8766,
    )

    assert load_namespace_launch_profile(namespace="work") is not None

    delete_namespace_launch_profile(namespace="work")

    assert load_namespace_launch_profile(namespace="work") is None
