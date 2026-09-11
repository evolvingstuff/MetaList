from __future__ import annotations

import ast
import builtins
from pathlib import Path
import socket
import sys
from types import ModuleType
from types import SimpleNamespace

import main as main_entrypoint
import pytest
from app import server_runtime
from app.encryption_audit import audit_all_namespaces
from app.server_runtime import DatabaseRuntimeConfig
from app.server_runtime import MainCliArgs
from app.server_runtime import MainServerConfig
from app.server_runtime import NamespaceLaunchProfile
from app.services.namespace_switcher import NamespaceOpenResult


def test_main_entrypoint_has_no_top_level_mcp_client_import() -> None:
    source_path = Path(main_entrypoint.__file__)
    source_text = source_path.read_text(encoding="utf-8")
    tree = ast.parse(source_text, filename=str(source_path))

    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert alias.name != "mcp_client"
        if isinstance(node, ast.ImportFrom):
            assert node.module != "mcp_client"


def test_installed_cli_forwards_empty_argument_list(monkeypatch) -> None:
    calls: list[object] = []
    monkeypatch.setattr(sys, "argv", ["metalist"])
    monkeypatch.setattr(
        main_entrypoint,
        "_bootstrap_default_namespace_if_empty",
        lambda *, environ: calls.append("unexpected-bootstrap"),
    )
    monkeypatch.setattr(main_entrypoint, "main", lambda argv: calls.append(("main", argv)))

    main_entrypoint.cli()

    assert calls == [("main", [])]


def test_installed_cli_forwards_namespace_and_port_arguments(monkeypatch) -> None:
    calls: list[object] = []
    argv = ["henry", "--port", "8001", "--https-port", "8444"]
    monkeypatch.setattr(sys, "argv", ["metalist", *argv])
    monkeypatch.setattr(
        main_entrypoint,
        "_bootstrap_default_namespace_if_empty",
        lambda *, environ: calls.append("unexpected-bootstrap"),
    )
    monkeypatch.setattr(main_entrypoint, "main", lambda argv: calls.append(("main", argv)))

    main_entrypoint.cli()

    assert calls == [("main", argv)]


def test_installed_cli_orchestrated_child_bypasses_parent_startup_gates(monkeypatch) -> None:
    calls: list[object] = []
    argv = ["--namespace", "default", "--port", "8000"]
    monkeypatch.setattr(sys, "argv", ["metalist", *argv])
    monkeypatch.setenv("METALIST_ORCHESTRATED_CHILD", "1")
    monkeypatch.setattr(
        main_entrypoint,
        "main",
        lambda child_argv: (_ for _ in ()).throw(AssertionError("parent startup gates must not run")),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "run_orchestrated_namespace_server",
        lambda child_argv: calls.append(
            (
                "run_orchestrated_namespace_server",
                child_argv,
                "METALIST_ORCHESTRATED_CHILD" in main_entrypoint.os.environ,
            )
        ),
    )

    main_entrypoint.cli()

    assert calls == [("run_orchestrated_namespace_server", argv, False)]


def test_installed_cli_update_hands_off_without_starting_metalist(monkeypatch) -> None:
    calls: list[object] = []
    monkeypatch.setattr(sys, "argv", ["metalist", "update"])
    monkeypatch.setattr(main_entrypoint.os, "getpid", lambda: 4321)
    monkeypatch.setattr(
        main_entrypoint,
        "_resolve_current_entrypoint",
        lambda: "C:/Users/hlaho/.local/bin/metalist.exe",
    )
    monkeypatch.setattr(
        main_entrypoint,
        "schedule_self_update",
        lambda **kwargs: calls.append(kwargs) or SimpleNamespace(message="Updater started."),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "main",
        lambda argv: (_ for _ in ()).throw(AssertionError("main must not start")),
    )
    monkeypatch.setattr(builtins, "print", lambda message: calls.append(message))

    main_entrypoint.cli()

    assert calls == [
        {
            "current_version": main_entrypoint.__version__,
            "metalist_executable": "C:/Users/hlaho/.local/bin/metalist.exe",
            "current_pid": 4321,
            "platform_name": sys.platform,
            "environ": main_entrypoint.os.environ,
        },
        "Updater started.",
    ]


def test_installed_cli_update_rejects_extra_arguments(monkeypatch) -> None:
    monkeypatch.setattr(sys, "argv", ["metalist", "update", "unexpected"])

    with pytest.raises(RuntimeError, match="Usage: metalist update"):
        main_entrypoint.cli()


def test_installed_default_bootstrap_creates_metalist_directory_tree(
    tmp_path: Path,
    monkeypatch,
) -> None:
    metalist_directory = tmp_path / "MetaList"
    monkeypatch.setattr(
        server_runtime,
        "_DEFAULT_DATABASE_DIRECTORY",
        metalist_directory,
    )
    monkeypatch.setattr(
        main_entrypoint,
        "ensure_default_tls_pair",
        lambda *, environ: None,
    )
    monkeypatch.setattr(
        "app.services.namespace_switcher._find_listening_pids_for_port",
        lambda *, port: [],
    )

    main_entrypoint._bootstrap_default_namespace_if_empty(environ={})

    namespace_directory = metalist_directory / "namespaces" / "default"
    database_path = namespace_directory / "default.metalist.db"
    profile = server_runtime.load_namespace_launch_profile(namespace="default")
    assert metalist_directory.is_dir()
    assert namespace_directory.is_dir()
    assert database_path.is_file()
    assert profile is not None
    assert profile.namespace == "default"
    assert profile.port == 8000
    assert profile.mcp_port is None
    audit_report = audit_all_namespaces(
        namespaces_directory=metalist_directory / "namespaces",
    )
    assert audit_report.passed is True
    assert audit_report.namespace_count == 1
    assert audit_report.encrypted_namespace_count == 0


def test_run_startup_sanity_gates_runs_python_then_js_in_development(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    calls: list[str] = []
    monkeypatch.setenv("METALIST_ENVIRONMENT", "development")

    monkeypatch.setattr(
        main_entrypoint,
        "assert_startup_sanity",
        lambda repo_root: calls.append(f"python:{repo_root}"),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "assert_startup_js_sanity",
        lambda repo_root: calls.append(f"js:{repo_root}"),
    )

    main_entrypoint._run_startup_sanity_gates(repo_root=tmp_path)

    assert calls == [
        f"python:{tmp_path}",
        f"js:{tmp_path}",
    ]
    assert "[startup] MetaList environment: development" in capsys.readouterr().out


def test_run_startup_sanity_gates_skips_checks_in_production(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    monkeypatch.setenv("METALIST_ENVIRONMENT", "production")
    monkeypatch.setattr(
        main_entrypoint,
        "assert_startup_sanity",
        lambda repo_root: (_ for _ in ()).throw(AssertionError("Python sanity must not run")),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "assert_startup_js_sanity",
        lambda repo_root: (_ for _ in ()).throw(AssertionError("JS sanity must not run")),
    )

    main_entrypoint._run_startup_sanity_gates(repo_root=tmp_path)

    assert "[startup] MetaList environment: production" in capsys.readouterr().out


def test_startup_encryption_audit_crashes_for_fatal_findings(
    monkeypatch,
    tmp_path: Path,
) -> None:
    report = SimpleNamespace(
        passed=False,
        startup_allowed=False,
        render_text=lambda: "fatal encrypted storage finding",
    )
    monkeypatch.setattr(
        main_entrypoint,
        "audit_all_namespaces",
        lambda *, namespaces_directory: report,
    )

    with pytest.raises(RuntimeError, match="fatal encrypted storage finding"):
        main_entrypoint._run_startup_encryption_audit(
            namespaces_directory=tmp_path,
        )


def test_startup_encryption_audit_allows_only_deferred_migration_findings(
    monkeypatch,
    tmp_path: Path,
) -> None:
    report = SimpleNamespace(
        passed=False,
        startup_allowed=True,
        render_text=lambda: "password-dependent migration required",
    )
    monkeypatch.setattr(
        main_entrypoint,
        "audit_all_namespaces",
        lambda *, namespaces_directory: report,
    )

    returned = main_entrypoint._run_startup_encryption_audit(
        namespaces_directory=tmp_path,
    )

    assert returned is report


def test_startup_encryption_audit_prints_migration_warning_and_continues(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    report = SimpleNamespace(
        passed=False,
        startup_allowed=True,
        render_text=lambda: (
            "Encrypted namespace audit: MIGRATION REQUIRED\n"
            "- cla: MIGRATION REQUIRED\n- default: PASS"
        ),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "audit_all_namespaces",
        lambda *, namespaces_directory: report,
    )

    returned_report = main_entrypoint._run_startup_encryption_audit(
        namespaces_directory=tmp_path,
    )

    captured = capsys.readouterr()
    assert returned_report is report
    assert "AUTHENTICATED DATABASE MIGRATION REQUIRED" in captured.err
    assert "known password-dependent migration" in captured.err
    assert "- cla: MIGRATION REQUIRED" in captured.err
    assert "- default: PASS" in captured.err


def test_startup_encryption_audit_prints_pass_without_warning(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    report = SimpleNamespace(
        passed=True,
        render_text=lambda: "Encrypted namespace audit: PASS\n- default: PASS",
    )
    monkeypatch.setattr(
        main_entrypoint,
        "audit_all_namespaces",
        lambda *, namespaces_directory: report,
    )

    returned_report = main_entrypoint._run_startup_encryption_audit(
        namespaces_directory=tmp_path,
    )

    captured = capsys.readouterr()
    assert returned_report is report
    assert "Encrypted namespace audit: PASS" in captured.out
    assert captured.err == ""


def test_main_generates_default_tls_pair_on_explicit_namespace_startup(tmp_path, monkeypatch) -> None:
    calls: list[str] = []
    fake_app_module = ModuleType("app.main")
    fake_app_object = object()
    fake_app_module.app = fake_app_object
    monkeypatch.setitem(sys.modules, "app.main", fake_app_module)

    def fake_apply_main_cli_args_to_environ(*, argv, environ) -> MainCliArgs:
        calls.append("apply_main_cli_args_to_environ")
        return MainCliArgs(
            namespace="default",
            port=None,
            https_port=None,
            test_mode=False,
            namespace_requested=True,
            shell_enabled=False,
        )

    def fake_resolve_database_runtime_config(*, environ, argv) -> DatabaseRuntimeConfig:
        calls.append("resolve_database_runtime_config")
        return DatabaseRuntimeConfig(
            database_path=tmp_path / "default.metalist.db",
            database_url=f"sqlite:///{tmp_path / 'default.metalist.db'}",
            namespace="default",
            test_mode=False,
        )

    def fake_prepare_database_runtime_path(*, database_path: Path) -> None:
        assert database_path == tmp_path / "default.metalist.db"
        calls.append("prepare_database_runtime_path")

    def fake_ensure_default_tls_pair(*, environ) -> None:
        calls.append("ensure_default_tls_pair")

    def fake_resolve_main_server_config(*, environ) -> MainServerConfig:
        calls.append("resolve_main_server_config")
        return MainServerConfig(
            host="127.0.0.1",
            port=18000,
            https_port=None,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1,::1",
            ssl_certfile=None,
            ssl_keyfile=None,
        )

    def fake_run_main_listener(
        *,
        app_object,
        host: str,
        port: int,
        proxy_headers: bool,
        forwarded_allow_ips: str,
        ssl_certfile,
        ssl_keyfile,
    ) -> None:
        assert app_object is fake_app_object
        assert host == "127.0.0.1"
        assert port == 18000
        assert proxy_headers is True
        assert forwarded_allow_ips == "127.0.0.1,::1"
        assert ssl_certfile is None
        assert ssl_keyfile is None
        calls.append("_run_main_listener")

    monkeypatch.setattr(main_entrypoint, "apply_main_cli_args_to_environ", fake_apply_main_cli_args_to_environ)
    monkeypatch.setattr(
        main_entrypoint,
        "resolve_database_runtime_config",
        fake_resolve_database_runtime_config,
    )
    monkeypatch.setattr(main_entrypoint, "prepare_database_runtime_path", fake_prepare_database_runtime_path)
    monkeypatch.setattr(main_entrypoint, "ensure_default_tls_pair", fake_ensure_default_tls_pair)
    monkeypatch.setattr(main_entrypoint, "resolve_main_server_config", fake_resolve_main_server_config)
    monkeypatch.setattr(main_entrypoint, "_run_main_listener", fake_run_main_listener)
    monkeypatch.setattr(main_entrypoint, "_record_self_executable_for_namespace_launch", lambda: calls.append("_record_self_executable_for_namespace_launch"))
    monkeypatch.setattr(main_entrypoint, "_run_startup_sanity_gates", lambda *, repo_root: calls.append("_run_startup_sanity_gates"))
    monkeypatch.setattr(main_entrypoint, "_run_startup_encryption_audit", lambda *, namespaces_directory: calls.append("_run_startup_encryption_audit"))

    main_entrypoint.main(argv=["--namespace", "default"])

    assert calls == [
        "_record_self_executable_for_namespace_launch",
        "_run_startup_sanity_gates",
        "_run_startup_encryption_audit",
        "apply_main_cli_args_to_environ",
        "resolve_database_runtime_config",
        "prepare_database_runtime_path",
        "ensure_default_tls_pair",
        "resolve_main_server_config",
        "_run_main_listener",
    ]


def test_main_skips_default_tls_generation_in_test_mode(tmp_path, monkeypatch) -> None:
    calls: list[str] = []
    fake_app_module = ModuleType("app.main")
    fake_app_module.app = object()
    monkeypatch.setitem(sys.modules, "app.main", fake_app_module)

    def fake_resolve_database_runtime_config(*, environ, argv) -> DatabaseRuntimeConfig:
        calls.append("resolve_database_runtime_config")
        return DatabaseRuntimeConfig(
            database_path=tmp_path / "test.db",
            database_url="sqlite:///./test.db",
            namespace=None,
            test_mode=True,
        )

    def fail_prepare_database_runtime_path(*, database_path: Path) -> None:
        raise AssertionError("prepare_database_runtime_path should not run in test mode")

    def fail_ensure_default_tls_pair(*, environ) -> None:
        raise AssertionError("ensure_default_tls_pair should not run in test mode")

    def fake_resolve_main_server_config(*, environ) -> MainServerConfig:
        calls.append("resolve_main_server_config")
        return MainServerConfig(
            host="127.0.0.1",
            port=18000,
            https_port=None,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1,::1",
            ssl_certfile=None,
            ssl_keyfile=None,
        )

    def _fake_apply_main_cli_args_to_environ(*, argv, environ) -> MainCliArgs:
        calls.append("apply_main_cli_args_to_environ")
        return MainCliArgs(
            namespace=None,
            port=None,
            https_port=None,
            test_mode=True,
            namespace_requested=False,
            shell_enabled=False,
        )

    monkeypatch.setattr(main_entrypoint, "apply_main_cli_args_to_environ", _fake_apply_main_cli_args_to_environ)
    monkeypatch.setattr(
        main_entrypoint,
        "resolve_database_runtime_config",
        fake_resolve_database_runtime_config,
    )
    monkeypatch.setattr(main_entrypoint, "prepare_database_runtime_path", fail_prepare_database_runtime_path)
    monkeypatch.setattr(main_entrypoint, "ensure_default_tls_pair", fail_ensure_default_tls_pair)
    monkeypatch.setattr(main_entrypoint, "resolve_main_server_config", fake_resolve_main_server_config)
    monkeypatch.setattr(
        main_entrypoint,
        "_run_main_listener",
        lambda **kwargs: calls.append("_run_main_listener"),
    )
    monkeypatch.setattr(main_entrypoint, "_record_self_executable_for_namespace_launch", lambda: calls.append("_record_self_executable_for_namespace_launch"))
    monkeypatch.setattr(main_entrypoint, "_run_startup_sanity_gates", lambda *, repo_root: calls.append("_run_startup_sanity_gates"))
    monkeypatch.setattr(main_entrypoint, "_run_startup_encryption_audit", lambda *, namespaces_directory: calls.append("_run_startup_encryption_audit"))

    main_entrypoint.main(argv=["--test"])

    assert calls == [
        "_record_self_executable_for_namespace_launch",
        "_run_startup_sanity_gates",
        "_run_startup_encryption_audit",
        "apply_main_cli_args_to_environ",
        "resolve_database_runtime_config",
        "resolve_main_server_config",
        "_run_main_listener",
    ]


def test_namespace_server_entrypoint_runs_encryption_audit_before_starting(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(
        main_entrypoint,
        "_run_startup_encryption_audit",
        lambda *, namespaces_directory: calls.append("_run_startup_encryption_audit"),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "apply_main_cli_args_to_environ",
        lambda *, argv, environ: calls.append("apply_main_cli_args_to_environ"),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "_run_namespace_server_for_current_env",
        lambda *, argv: calls.append("_run_namespace_server_for_current_env"),
    )

    main_entrypoint.run_namespace_server(argv=[])

    assert calls == [
        "_run_startup_encryption_audit",
        "apply_main_cli_args_to_environ",
        "_run_namespace_server_for_current_env",
    ]


def test_run_namespace_server_prints_resolved_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_app_module = ModuleType("app.main")
    fake_app_module.app = object()
    monkeypatch.setitem(sys.modules, "app.main", fake_app_module)

    printed: list[str] = []

    monkeypatch.setattr(
        main_entrypoint,
        "resolve_database_runtime_config",
        lambda *, environ, argv: DatabaseRuntimeConfig(
            database_path=tmp_path / "default.metalist.db",
            database_url=f"sqlite:///{tmp_path / 'default.metalist.db'}",
            namespace="default",
            test_mode=False,
        ),
    )
    monkeypatch.setattr(main_entrypoint, "prepare_database_runtime_path", lambda *, database_path: None)
    monkeypatch.setattr(main_entrypoint, "ensure_default_tls_pair", lambda *, environ: None)
    monkeypatch.setattr(
        main_entrypoint,
        "resolve_main_server_config",
        lambda *, environ: MainServerConfig(
            host="127.0.0.1",
            port=18000,
            https_port=None,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1,::1",
            ssl_certfile=None,
            ssl_keyfile=None,
        ),
    )
    monkeypatch.setattr(main_entrypoint, "_run_main_listener", lambda **kwargs: None)
    monkeypatch.setattr(builtins, "print", lambda text: printed.append(text))

    main_entrypoint._run_namespace_server_for_current_env(argv=[])

    assert any(
        "MetaList resolved config:" in line and "namespace='default'" in line and "http_port=18000" in line
        for line in printed
    )


@pytest.mark.parametrize(
    "entrypoint",
    (
        "/tmp/main.py",
        "C:/Users/hlaho/.local/bin/metalist.exe",
    ),
)
def test_main_run_without_explicit_namespace_bootstraps_all_namespaces(
    monkeypatch,
    entrypoint: str,
) -> None:
    calls: list[str] = []

    def _fake_bootstrap_default_namespace_if_empty(*, environ) -> None:
        calls.append("_bootstrap_default_namespace_if_empty")

    def _fake_prompt_for_missing_namespace_launch_profiles(*, environ) -> None:
        calls.append("_prompt_for_missing_namespace_launch_profiles")

    def _fake_open_or_launch_all_namespaces(*, environ):
        calls.append("open_or_launch_all_namespaces")
        return [
            type(
                "LaunchResult",
                (),
                {"namespace": "default", "action": "launched", "url": "http://127.0.0.1:8000"},
            )(),
            type(
                "LaunchResult",
                (),
                {"namespace": "work", "action": "restarted", "url": "http://127.0.0.1:8001"},
            )(),
        ]

    monkeypatch.setattr(
        main_entrypoint,
        "apply_main_cli_args_to_environ",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("apply_main_cli_args_to_environ should not run")),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "_bootstrap_default_namespace_if_empty",
        _fake_bootstrap_default_namespace_if_empty,
    )
    monkeypatch.setattr(
        main_entrypoint,
        "_prompt_for_missing_namespace_launch_profiles",
        _fake_prompt_for_missing_namespace_launch_profiles,
    )
    monkeypatch.setattr(main_entrypoint, "open_or_launch_all_namespaces", _fake_open_or_launch_all_namespaces)
    monkeypatch.setattr(
        main_entrypoint,
        "_print_namespace_bootstrap_results",
        lambda *, environ, launch_results: calls.append("_print_namespace_bootstrap_results"),
    )
    monkeypatch.setattr(main_entrypoint, "_record_self_executable_for_namespace_launch", lambda: calls.append("_record_self_executable_for_namespace_launch"))
    monkeypatch.setattr(main_entrypoint, "_run_startup_sanity_gates", lambda *, repo_root: calls.append("_run_startup_sanity_gates"))
    monkeypatch.setattr(main_entrypoint, "_run_startup_encryption_audit", lambda *, namespaces_directory: calls.append("_run_startup_encryption_audit"))
    monkeypatch.setattr(main_entrypoint, "_resolve_current_entrypoint", lambda: entrypoint)
    monkeypatch.setattr(
        main_entrypoint,
        "resolve_database_runtime_config",
        lambda *, environ, argv: (_ for _ in ()).throw(AssertionError("resolve_database_runtime_config should not run")),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "_run_main_listener",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("_run_main_listener should not run")),
    )

    main_entrypoint.main(argv=[])

    assert calls == [
        "_record_self_executable_for_namespace_launch",
        "_run_startup_sanity_gates",
        "_run_startup_encryption_audit",
        "_bootstrap_default_namespace_if_empty",
        "_prompt_for_missing_namespace_launch_profiles",
        "open_or_launch_all_namespaces",
        "_print_namespace_bootstrap_results",
    ]


def test_main_enable_shell_launches_all_namespaces_with_shared_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_enable_shell_execution_for_launch(*, environ) -> None:
        environ["METALIST_HOST"] = "127.0.0.1"
        environ["METALIST_SHELL_ENABLED"] = "1"
        calls.append("enable_shell_execution_for_launch")

    def fake_open_or_launch_all_namespaces(*, environ):
        assert environ["METALIST_HOST"] == "127.0.0.1"
        assert environ["METALIST_SHELL_ENABLED"] == "1"
        calls.append("open_or_launch_all_namespaces")
        return []

    monkeypatch.setattr(main_entrypoint, "_record_self_executable_for_namespace_launch", lambda: None)
    monkeypatch.setattr(main_entrypoint, "_run_startup_sanity_gates", lambda *, repo_root: None)
    monkeypatch.setattr(main_entrypoint, "_run_startup_encryption_audit", lambda *, namespaces_directory: None)
    monkeypatch.setattr(main_entrypoint, "enable_shell_execution_for_launch", fake_enable_shell_execution_for_launch)
    monkeypatch.setattr(
        main_entrypoint,
        "_print_shell_execution_enabled_banner",
        lambda: calls.append("_print_shell_execution_enabled_banner"),
    )
    monkeypatch.setattr(main_entrypoint, "_bootstrap_default_namespace_if_empty", lambda *, environ: calls.append("_bootstrap_default_namespace_if_empty"))
    monkeypatch.setattr(main_entrypoint, "_prompt_for_missing_namespace_launch_profiles", lambda *, environ: calls.append("_prompt_for_missing_namespace_launch_profiles"))
    monkeypatch.setattr(main_entrypoint, "open_or_launch_all_namespaces", fake_open_or_launch_all_namespaces)
    monkeypatch.setattr(
        main_entrypoint,
        "_print_namespace_bootstrap_results",
        lambda *, environ, launch_results: calls.append("_print_namespace_bootstrap_results"),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "_run_namespace_server_for_current_env",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("single namespace server must not start")),
    )

    main_entrypoint.main(argv=["--enable-shell"])

    assert calls == [
        "enable_shell_execution_for_launch",
        "_print_shell_execution_enabled_banner",
        "_bootstrap_default_namespace_if_empty",
        "_prompt_for_missing_namespace_launch_profiles",
        "open_or_launch_all_namespaces",
        "_print_namespace_bootstrap_results",
    ]


def test_shell_execution_enabled_notice_is_concise(capsys) -> None:
    main_entrypoint._print_shell_execution_enabled_banner()

    output = capsys.readouterr().out
    assert output == (
        "[startup] @shell enabled for authenticated loopback clients "
        "(this launch only).\n"
    )


def test_prompt_for_missing_namespace_launch_profiles_auto_saves_default_ports(monkeypatch) -> None:
    calls: list[object] = []
    catalog_calls = {"count": 0}

    def _fake_build_namespace_catalog(*, environ, current_namespace):
        catalog_calls["count"] += 1
        if catalog_calls["count"] == 1:
            return {
                "namespaces": [
                    {
                        "namespace": "default",
                        "has_launch_profile": False,
                        "default_profile": {
                            "namespace": "default",
                            "port": 8000,
                            "https_port": 8443,
                        },
                    }
                ]
            }
        return {
            "namespaces": [
                {
                    "namespace": "default",
                    "has_launch_profile": True,
                    "default_profile": {
                        "namespace": "default",
                        "port": 8000,
                        "https_port": 8443,
                    },
                }
            ]
        }

    monkeypatch.setattr(main_entrypoint, "build_namespace_catalog", _fake_build_namespace_catalog)
    monkeypatch.setattr(
        main_entrypoint,
        "save_namespace_launch_profile",
        lambda **kwargs: calls.append(kwargs),
    )
    monkeypatch.setattr(
        builtins,
        "input",
        lambda prompt: (_ for _ in ()).throw(AssertionError("default bootstrap should not prompt")),
    )
    monkeypatch.setattr(builtins, "print", lambda text: calls.append(text))

    main_entrypoint._prompt_for_missing_namespace_launch_profiles(environ={})

    assert calls == [
        "Namespace default has no saved launch profile. Saving suggested default ports.",
        {
            "namespace": "default",
            "port": 8000,
            "https_port": 8443,
            "mcp_port": None,
        },
    ]


def test_main_aborts_before_namespace_bootstrap_when_sanity_fails(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setattr(main_entrypoint, "_record_self_executable_for_namespace_launch", lambda: calls.append("_record_self_executable_for_namespace_launch"))
    monkeypatch.setattr(
        main_entrypoint,
        "_run_startup_sanity_gates",
        lambda *, repo_root: (_ for _ in ()).throw(RuntimeError("sanity failed")),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "apply_main_cli_args_to_environ",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("apply_main_cli_args_to_environ should not run")),
    )
    monkeypatch.setattr(
        main_entrypoint,
        "open_or_launch_all_namespaces",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("open_or_launch_all_namespaces should not run")),
    )

    with pytest.raises(RuntimeError, match="sanity failed"):
        main_entrypoint.main(argv=[])

    assert calls == ["_record_self_executable_for_namespace_launch"]


def test_print_namespace_bootstrap_results_shows_http_and_https_urls(monkeypatch) -> None:
    printed: list[str] = []

    monkeypatch.setattr(
        main_entrypoint,
        "resolve_main_server_config",
        lambda *, environ: MainServerConfig(
            host="0.0.0.0",
            port=8000,
            https_port=8443,
            proxy_headers=True,
            forwarded_allow_ips="127.0.0.1,::1",
            ssl_certfile=None,
            ssl_keyfile=None,
        ),
    )
    monkeypatch.setattr(builtins, "print", lambda text: printed.append(text))

    main_entrypoint._print_namespace_bootstrap_results(
        environ={},
        launch_results=[
            NamespaceOpenResult(
                namespace="default",
                action="launched",
                url="http://127.0.0.1:8000",
                saved_profile=NamespaceLaunchProfile(
                    namespace="default",
                    port=8000,
                    https_port=8443,
                    mcp_port=8765,
                ),
                saved_for_next_launch=False,
                message="Started namespace default.",
            ),
            NamespaceOpenResult(
                namespace="cla",
                action="restarted",
                url="http://127.0.0.1:8001",
                saved_profile=NamespaceLaunchProfile(
                    namespace="cla",
                    port=8001,
                    https_port=None,
                    mcp_port=8766,
                ),
                saved_for_next_launch=False,
                message="Restarted namespace cla.",
            ),
        ],
    )

    assert printed == [
        "MetaList namespace bootstrap:",
        "namespace\taction\thttp\thttps",
        "default\tlaunched\thttp://127.0.0.1:8000\thttps://127.0.0.1:8443",
        "cla\trestarted\thttp://127.0.0.1:8001\tdisabled",
    ]


def test_find_listening_pids_for_port_returns_unique_listener_pids(monkeypatch) -> None:
    class _Completed:
        returncode = 0
        stdout = "123\n123\n456\n"
        stderr = ""

    monkeypatch.setattr(main_entrypoint.shutil, "which", lambda name: "/usr/sbin/lsof")
    monkeypatch.setattr(main_entrypoint.subprocess, "run", lambda *args, **kwargs: _Completed())

    assert main_entrypoint._find_listening_pids_for_port(port=8443) == [123, 456]


def test_find_listening_pids_for_port_uses_windows_process_control_without_lsof(monkeypatch) -> None:
    monkeypatch.setattr(main_entrypoint.sys, "platform", "win32")
    monkeypatch.setattr(
        main_entrypoint,
        "find_windows_listening_pids_for_port",
        lambda *, port: [4321],
    )
    monkeypatch.setattr(
        main_entrypoint.shutil,
        "which",
        lambda name: (_ for _ in ()).throw(AssertionError("Windows startup must not require lsof")),
    )

    assert main_entrypoint._find_listening_pids_for_port(port=8443) == [4321]


def test_evict_processes_listening_on_port_stops_foreign_pids(monkeypatch) -> None:
    stopped_pids: list[int] = []

    monkeypatch.setattr(main_entrypoint, "_find_listening_pids_for_port", lambda *, port: [2345, 6789])
    monkeypatch.setattr(main_entrypoint.os, "getpid", lambda: 9999)
    monkeypatch.setattr(main_entrypoint, "_stop_process", lambda *, pid: stopped_pids.append(pid))

    main_entrypoint._evict_processes_listening_on_port(port=8443)

    assert stopped_pids == [2345, 6789]


def test_run_main_listener_evicts_port_conflicts_before_uvicorn(monkeypatch) -> None:
    calls: list[tuple[str, int]] = []

    monkeypatch.setattr(
        main_entrypoint,
        "_evict_processes_listening_on_port",
        lambda *, port: calls.append(("evict", port)),
    )
    monkeypatch.setattr(
        main_entrypoint.uvicorn,
        "run",
        lambda app_object, **kwargs: calls.append(("uvicorn", kwargs["port"])),
    )

    main_entrypoint._run_main_listener(
        app_object=object(),
        host="127.0.0.1",
        port=18000,
        proxy_headers=True,
        forwarded_allow_ips="127.0.0.1,::1",
        ssl_certfile=None,
        ssl_keyfile=None,
    )

    assert calls == [
        ("evict", 18000),
        ("uvicorn", 18000),
    ]


def test_https_proxy_binding_does_not_require_reverse_dns(monkeypatch) -> None:
    bind_calls: list[tuple[str, int]] = []
    listen_calls: list[int] = []
    bound_address = ("127.0.0.1", 18443)
    fake_socket = SimpleNamespace(
        setsockopt=lambda *args: None,
        bind=bind_calls.append,
        getsockname=lambda: bound_address,
        listen=listen_calls.append,
        close=lambda: None,
    )

    def _unexpected_reverse_lookup(host):
        raise AssertionError("HTTPS binding must not require reverse DNS")

    monkeypatch.setattr(socket, "socket", lambda *args: fake_socket)
    monkeypatch.setattr(socket, "getfqdn", _unexpected_reverse_lookup)
    monkeypatch.setattr(main_entrypoint, "_evict_processes_listening_on_port", lambda **kwargs: None)
    monkeypatch.setattr(main_entrypoint.ssl, "SSLContext", lambda protocol: SimpleNamespace(
        load_cert_chain=lambda **kwargs: None,
        wrap_socket=lambda sock, **kwargs: sock,
    ))
    monkeypatch.setattr(main_entrypoint.threading, "Thread", lambda **kwargs: SimpleNamespace(start=lambda: None))

    started_proxy = main_entrypoint._start_https_proxy_server(
        host="localhost",
        https_port=18443,
        backend_host="127.0.0.1",
        backend_port=18000,
        ssl_certfile="/unused/cert.pem",
        ssl_keyfile="/unused/key.pem",
    )

    assert bind_calls == [("localhost", 18443)]
    assert len(listen_calls) == 1
    assert started_proxy.server.server_address == bound_address
    assert started_proxy.server.server_name == bound_address[0]
    assert started_proxy.server.server_port == bound_address[1]


def test_start_https_proxy_server_evicts_port_conflicts_before_bind(monkeypatch) -> None:
    calls: list[tuple[str, object]] = []

    class _FakeServer:
        def __init__(self, server_address, handler_class) -> None:
            calls.append(("server_address", server_address))
            self.socket = "raw-socket"
            self.daemon_threads = False

        def serve_forever(self) -> None:
            calls.append(("serve_forever", None))

    class _FakeSslContext:
        def __init__(self, protocol) -> None:
            calls.append(("ssl_protocol", protocol))

        def load_cert_chain(self, *, certfile, keyfile) -> None:
            calls.append(("load_cert_chain", (certfile, keyfile)))

        def wrap_socket(self, socket, server_side):
            calls.append(("wrap_socket", (socket, server_side)))
            return "wrapped-socket"

    class _FakeThread:
        def __init__(self, *, target, name, daemon) -> None:
            calls.append(("thread_init", (name, daemon)))
            self.target = target
            self.started = False

        def start(self) -> None:
            self.started = True
            calls.append(("thread_start", None))

    monkeypatch.setattr(
        main_entrypoint,
        "_evict_processes_listening_on_port",
        lambda *, port: calls.append(("evict", port)),
    )
    monkeypatch.setattr(main_entrypoint, "_HttpsProxyServer", _FakeServer)
    monkeypatch.setattr(main_entrypoint.ssl, "SSLContext", _FakeSslContext)
    monkeypatch.setattr(main_entrypoint.threading, "Thread", _FakeThread)

    started_proxy = main_entrypoint._start_https_proxy_server(
        host="0.0.0.0",
        https_port=8443,
        backend_host="127.0.0.1",
        backend_port=8000,
        ssl_certfile="/tmp/cert.pem",
        ssl_keyfile="/tmp/key.pem",
    )

    assert calls == [
        ("evict", 8443),
        ("server_address", ("0.0.0.0", 8443)),
        ("ssl_protocol", main_entrypoint.ssl.PROTOCOL_TLS_SERVER),
        ("load_cert_chain", ("/tmp/cert.pem", "/tmp/key.pem")),
        ("wrap_socket", ("raw-socket", True)),
        ("thread_init", ("metalist-https-proxy", True)),
        ("thread_start", None),
    ]
    assert started_proxy.server.socket == "wrapped-socket"
    assert started_proxy.thread.started is True


def test_https_proxy_replaces_caller_supplied_forwarding_headers() -> None:
    forwarded_headers = main_entrypoint._build_https_proxy_forward_headers(
        incoming_headers=(
            ("Host", "10.0.0.31:8444"),
            ("Origin", "https://10.0.0.31:8444"),
            ("X-Forwarded-For", "127.0.0.1"),
            ("x-forwarded-proto", "http"),
            ("X-Forwarded-Host", "localhost:8444"),
            ("Forwarded", "for=127.0.0.1;proto=http"),
            ("Connection", "keep-alive"),
        ),
        client_ip="10.0.0.52",
    )

    assert forwarded_headers == {
        "Host": "10.0.0.31:8444",
        "Origin": "https://10.0.0.31:8444",
        "X-Forwarded-For": "10.0.0.52",
        "X-Forwarded-Proto": "https",
    }


def test_evict_processes_listening_on_port_raises_if_current_process_owns_listener(monkeypatch) -> None:
    monkeypatch.setattr(main_entrypoint, "_find_listening_pids_for_port", lambda *, port: [4321])
    monkeypatch.setattr(main_entrypoint.os, "getpid", lambda: 4321)

    with pytest.raises(RuntimeError, match="current MetaList process"):
        main_entrypoint._evict_processes_listening_on_port(port=8443)
