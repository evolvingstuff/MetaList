from __future__ import annotations

import sqlite3

import pytest

import app.server_runtime as server_runtime
from app.server_runtime import apply_main_cli_args_to_environ
from app.server_runtime import apply_namespace_arg_to_environ
from app.server_runtime import load_namespace_launch_profile
from app.server_runtime import load_all_namespace_launch_profiles_read_only
from app.server_runtime import resolve_database_runtime_config
from app.server_runtime import ensure_default_tls_pair
from app.server_runtime import resolve_namespace_launch_defaults
from app.server_runtime import resolve_main_server_config
from app.server_runtime import resolve_request_host_for_https_redirect
from app.server_runtime import resolve_https_redirect_url
from app.server_runtime import save_namespace_launch_profile


def test_read_only_launch_profile_discovery_preserves_database_without_profile_table(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    database_path = server_runtime.resolve_namespaced_database_path(namespace="legacy")
    database_path.parent.mkdir(parents=True)
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("CREATE TABLE historical_notes (content TEXT)")
        connection.execute("INSERT INTO historical_notes VALUES ('keep this')")
        connection.commit()
    finally:
        connection.close()
    before_database_bytes = database_path.read_bytes()
    before_files = set(database_path.parent.iterdir())

    assert load_all_namespace_launch_profiles_read_only() == []

    assert database_path.read_bytes() == before_database_bytes
    assert set(database_path.parent.iterdir()) == before_files


def test_read_only_launch_profile_discovery_rejects_wrong_namespace(
    tmp_path,
    monkeypatch,
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
            "INSERT INTO namespace_launch_profile VALUES ('wrong', 8000, 8443, NULL)"
        )
        connection.commit()
    finally:
        connection.close()
    before_database_bytes = database_path.read_bytes()

    with pytest.raises(RuntimeError, match="contains launch profile for wrong"):
        load_all_namespace_launch_profiles_read_only()

    assert database_path.read_bytes() == before_database_bytes


def test_resolve_main_server_config_defaults_to_loopback_http_without_tls(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", tmp_path / "missing-cert.pem")
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", tmp_path / "missing-key.pem")

    config = resolve_main_server_config(environ={})

    assert config.host == "127.0.0.1"
    assert config.port == 8000
    assert config.https_port is None
    assert config.proxy_headers is True
    assert config.forwarded_allow_ips == "127.0.0.1,::1"
    assert config.ssl_certfile is None
    assert config.ssl_keyfile is None


def test_resolve_main_server_config_accepts_remote_bind_and_tls_files(tmp_path) -> None:
    cert_path = tmp_path / "cert.pem"
    key_path = tmp_path / "key.pem"
    cert_path.write_text("cert", encoding="utf-8")
    key_path.write_text("key", encoding="utf-8")

    config = resolve_main_server_config(
        environ={
            "METALIST_HOST": "0.0.0.0",
            "METALIST_PORT": "8443",
            "METALIST_HTTPS_PORT": "9443",
            "METALIST_PROXY_HEADERS": "0",
            "METALIST_FORWARDED_ALLOW_IPS": "10.0.0.10",
            "METALIST_TLS_CERT": str(cert_path),
            "METALIST_TLS_KEY": str(key_path),
        }
    )

    assert config.host == "0.0.0.0"
    assert config.port == 8443
    assert config.https_port == 9443
    assert config.proxy_headers is False
    assert config.forwarded_allow_ips == "10.0.0.10"
    assert config.ssl_certfile == str(cert_path)
    assert config.ssl_keyfile == str(key_path)


def test_resolve_main_server_config_requires_cert_and_key_together() -> None:
    with pytest.raises(
        RuntimeError,
        match="must be set together",
    ):
        resolve_main_server_config(
            environ={"METALIST_SSL_CERTFILE": "/tmp/cert.pem"},
        )


def test_resolve_main_server_config_requires_tls_when_https_port_is_set(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", tmp_path / "missing-cert.pem")
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", tmp_path / "missing-key.pem")

    with pytest.raises(
        RuntimeError,
        match="METALIST_HTTPS_PORT requires TLS certs",
    ):
        resolve_main_server_config(
            environ={"METALIST_HTTPS_PORT": "3443"},
        )


def test_resolve_main_server_config_uses_default_cert_paths(tmp_path, monkeypatch) -> None:
    cert_path = tmp_path / "metalist-cert.pem"
    key_path = tmp_path / "metalist-key.pem"
    cert_path.write_text("cert", encoding="utf-8")
    key_path.write_text("key", encoding="utf-8")
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", cert_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", key_path)

    config = resolve_main_server_config(
        environ={},
    )

    assert config.host == "127.0.0.1"
    assert config.port == 8000
    assert config.https_port == 8443
    assert config.ssl_certfile == str(cert_path)
    assert config.ssl_keyfile == str(key_path)


def test_resolve_main_server_config_enables_https_for_remote_bind_when_default_certs_exist(
    tmp_path,
    monkeypatch,
) -> None:
    cert_path = tmp_path / "metalist-cert.pem"
    key_path = tmp_path / "metalist-key.pem"
    cert_path.write_text("cert", encoding="utf-8")
    key_path.write_text("key", encoding="utf-8")
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", cert_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", key_path)

    config = resolve_main_server_config(
        environ={"METALIST_HOST": "0.0.0.0"},
    )

    assert config.host == "0.0.0.0"
    assert config.port == 8000
    assert config.https_port == 8443
    assert config.ssl_certfile == str(cert_path)
    assert config.ssl_keyfile == str(key_path)


def test_ensure_default_tls_pair_generates_cert_and_key(tmp_path, monkeypatch) -> None:
    cert_path = tmp_path / "certs" / "metalist-cert.pem"
    key_path = tmp_path / "certs" / "metalist-key.pem"
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", cert_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", key_path)

    pair = ensure_default_tls_pair(environ={})

    assert pair == (str(cert_path), str(key_path))
    assert cert_path.is_file() is True
    assert key_path.is_file() is True
    assert b"BEGIN CERTIFICATE" in cert_path.read_bytes()
    assert b"BEGIN RSA PRIVATE KEY" in key_path.read_bytes()


def test_ensure_default_tls_pair_respects_auto_generate_disable_flag(tmp_path, monkeypatch) -> None:
    cert_path = tmp_path / "certs" / "metalist-cert.pem"
    key_path = tmp_path / "certs" / "metalist-key.pem"
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", cert_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", key_path)

    pair = ensure_default_tls_pair(environ={"METALIST_AUTO_GENERATE_TLS": "0"})

    assert pair is None
    assert cert_path.exists() is False
    assert key_path.exists() is False


def test_ensure_default_tls_pair_reuses_existing_default_paths(tmp_path, monkeypatch) -> None:
    cert_path = tmp_path / "certs" / "metalist-cert.pem"
    key_path = tmp_path / "certs" / "metalist-key.pem"
    cert_path.parent.mkdir(parents=True, exist_ok=True)
    cert_path.write_text("existing-cert", encoding="utf-8")
    key_path.write_text("existing-key", encoding="utf-8")
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", cert_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", key_path)

    pair = ensure_default_tls_pair(environ={})

    assert pair == (str(cert_path), str(key_path))
    assert cert_path.read_text(encoding="utf-8") == "existing-cert"
    assert key_path.read_text(encoding="utf-8") == "existing-key"


def test_ensure_default_tls_pair_skips_generation_when_explicit_tls_paths_are_set(
    tmp_path,
    monkeypatch,
) -> None:
    cert_path = tmp_path / "certs" / "metalist-cert.pem"
    key_path = tmp_path / "certs" / "metalist-key.pem"
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", cert_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", key_path)

    pair = ensure_default_tls_pair(
        environ={
            "METALIST_TLS_CERT": "/tmp/custom-cert.pem",
            "METALIST_TLS_KEY": "/tmp/custom-key.pem",
        }
    )

    assert pair is None
    assert cert_path.exists() is False
    assert key_path.exists() is False


def test_resolve_database_runtime_config_defaults_to_default_namespace_path(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)

    config = resolve_database_runtime_config(
        environ={},
        argv=[],
    )

    assert config.test_mode is False
    assert config.namespace == "default"
    assert config.database_path == tmp_path / "namespaces" / "default" / "default.metalist.db"
    assert config.database_url == f"sqlite:///{tmp_path / 'namespaces' / 'default' / 'default.metalist.db'}"


def test_prepare_database_runtime_path_creates_metalist_and_namespaces_directories(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path / "MetaList")

    database_path = server_runtime.resolve_default_database_path()
    server_runtime.prepare_database_runtime_path(database_path=database_path)

    assert (tmp_path / "MetaList").is_dir() is True
    assert (tmp_path / "MetaList" / "namespaces").is_dir() is True
    assert (tmp_path / "MetaList" / "namespaces" / "default").is_dir() is True


def test_resolve_database_runtime_config_uses_namespaced_database_path(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)

    config = resolve_database_runtime_config(
        environ={"METALIST_NAMESPACE": "work"},
        argv=[],
    )

    assert config.test_mode is False
    assert config.namespace == "work"
    assert config.database_path == tmp_path / "namespaces" / "work" / "work.metalist.db"
    assert config.database_url == f"sqlite:///{tmp_path / 'namespaces' / 'work' / 'work.metalist.db'}"


def test_resolve_database_runtime_config_rejects_invalid_namespace() -> None:
    with pytest.raises(
        RuntimeError,
        match="Namespace must contain only lowercase letters, digits, and '-'",
    ):
        resolve_database_runtime_config(
            environ={"METALIST_NAMESPACE": "Work.Space"},
            argv=[],
        )


def test_resolve_database_runtime_config_rejects_namespace_in_test_mode() -> None:
    with pytest.raises(
        RuntimeError,
        match="Namespace selection cannot be combined with TEST_MODE or --test",
    ):
        resolve_database_runtime_config(
            environ={"METALIST_NAMESPACE": "work"},
            argv=["--test"],
        )


def test_apply_main_cli_args_to_environ_sets_namespace_and_ports(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", tmp_path / "missing-cert.pem")
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", tmp_path / "missing-key.pem")
    environ: dict[str, str] = {}

    parsed = apply_main_cli_args_to_environ(
        argv=[
            "--namespace",
            "work",
            "--port",
            "8123",
            "--https-port",
            "8444",
        ],
        environ=environ,
    )

    assert parsed.namespace == "work"
    assert parsed.port == 8123
    assert parsed.https_port == 8444
    assert parsed.test_mode is False
    assert parsed.namespace_requested is True
    assert environ["METALIST_NAMESPACE"] == "work"
    assert environ["METALIST_PORT"] == "8123"
    assert environ["METALIST_HTTPS_PORT"] == "8444"


def test_apply_main_cli_args_to_environ_enables_shell_and_defaults_to_loopback(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", tmp_path / "missing-cert.pem")
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", tmp_path / "missing-key.pem")
    environ: dict[str, str] = {}

    parsed = apply_main_cli_args_to_environ(
        argv=["--enable-shell", "--port", "8123"],
        environ=environ,
    )

    assert parsed.shell_enabled is True
    assert environ["METALIST_SHELL_ENABLED"] == "1"
    assert environ["METALIST_HOST"] == "127.0.0.1"


def test_apply_main_cli_args_to_environ_allows_shell_on_explicit_lan_bind(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", tmp_path / "missing-cert.pem")
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", tmp_path / "missing-key.pem")
    environ = {
        "METALIST_HOST": "0.0.0.0",
        "METALIST_ALLOWED_HOSTS": "10.0.0.31",
    }

    parsed = apply_main_cli_args_to_environ(
        argv=["--enable-shell", "--port", "8123"],
        environ=environ,
    )

    assert parsed.shell_enabled is True
    assert environ["METALIST_SHELL_ENABLED"] == "1"
    assert environ["METALIST_HOST"] == "0.0.0.0"
    assert environ["METALIST_ALLOWED_HOSTS"] == "10.0.0.31"


def test_apply_main_cli_args_to_environ_clears_unbacked_shell_capability() -> None:
    environ = {"METALIST_SHELL_ENABLED": "1"}

    parsed = apply_main_cli_args_to_environ(
        argv=["--test"],
        environ=environ,
    )

    assert parsed.shell_enabled is False
    assert "METALIST_SHELL_ENABLED" not in environ


def test_apply_main_cli_args_to_environ_rejects_namespace_in_test_mode() -> None:
    with pytest.raises(
        RuntimeError,
        match="Namespace selection cannot be combined with TEST_MODE or --test",
    ):
        apply_main_cli_args_to_environ(
            argv=["--namespace", "work", "--test"],
            environ={},
        )


def test_apply_main_cli_args_to_environ_loads_saved_profile_for_positional_namespace(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    cert_path = tmp_path / "metalist-cert.pem"
    key_path = tmp_path / "metalist-key.pem"
    cert_path.write_text("cert", encoding="utf-8")
    key_path.write_text("key", encoding="utf-8")
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", cert_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", key_path)
    save_namespace_launch_profile(
        namespace="cla",
        port=9000,
        https_port=9443,
        mcp_port=9776,
    )
    environ: dict[str, str] = {}

    parsed = apply_main_cli_args_to_environ(
        argv=["cla"],
        environ=environ,
    )

    assert parsed.namespace == "cla"
    assert parsed.port is None
    assert parsed.https_port is None
    assert parsed.namespace_requested is True
    assert environ["METALIST_NAMESPACE"] == "cla"
    assert environ["METALIST_PORT"] == "9000"
    assert environ["METALIST_HTTPS_PORT"] == "9443"


def test_apply_main_cli_args_to_environ_skips_saved_https_port_when_tls_is_unavailable(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", tmp_path / "missing-cert.pem")
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", tmp_path / "missing-key.pem")
    save_namespace_launch_profile(
        namespace="default",
        port=8000,
        https_port=8443,
        mcp_port=8765,
    )
    environ: dict[str, str] = {}

    parsed = apply_main_cli_args_to_environ(
        argv=[],
        environ=environ,
    )

    assert parsed.namespace == "default"
    assert parsed.namespace_requested is False
    assert environ["METALIST_PORT"] == "8000"
    assert "METALIST_HTTPS_PORT" not in environ


def test_apply_main_cli_args_to_environ_explicit_cli_port_overrides_saved_profile_and_persists_merge(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    cert_path = tmp_path / "metalist-cert.pem"
    key_path = tmp_path / "metalist-key.pem"
    cert_path.write_text("cert", encoding="utf-8")
    key_path.write_text("key", encoding="utf-8")
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", cert_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", key_path)
    save_namespace_launch_profile(
        namespace="cla",
        port=9000,
        https_port=9443,
        mcp_port=9776,
    )
    environ: dict[str, str] = {}

    parsed = apply_main_cli_args_to_environ(
        argv=["cla", "--port", "9001"],
        environ=environ,
    )

    assert parsed.namespace == "cla"
    assert parsed.port == 9001
    assert environ["METALIST_PORT"] == "9001"
    assert environ["METALIST_HTTPS_PORT"] == "9443"

    profile = load_namespace_launch_profile(namespace="cla")
    assert profile is not None
    assert profile.port == 9001
    assert profile.https_port == 9443
    assert profile.mcp_port == 9776


def test_apply_main_cli_args_to_environ_prefers_env_over_saved_profile(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    save_namespace_launch_profile(
        namespace="cla",
        port=9000,
        https_port=9443,
        mcp_port=9776,
    )
    environ = {
        "METALIST_PORT": "9100",
        "METALIST_HTTPS_PORT": "9543",
    }

    parsed = apply_main_cli_args_to_environ(
        argv=["cla"],
        environ=environ,
    )

    assert parsed.namespace == "cla"
    assert environ["METALIST_PORT"] == "9100"
    assert environ["METALIST_HTTPS_PORT"] == "9543"


def test_apply_main_cli_args_to_environ_saves_default_namespace_profile_when_ports_are_explicit(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    environ: dict[str, str] = {}

    parsed = apply_main_cli_args_to_environ(
        argv=["--port", "9000", "--https-port", "9443"],
        environ=environ,
    )

    assert parsed.namespace == "default"
    profile = load_namespace_launch_profile(namespace="default")
    assert profile is not None
    assert profile.port == 9000
    assert profile.https_port == 9443
    assert profile.mcp_port is None


def test_apply_namespace_arg_to_environ_bootstraps_known_args_only() -> None:
    environ: dict[str, str] = {}

    namespace = apply_namespace_arg_to_environ(
        argv=["--namespace", "work", "--input", "/tmp/example.json"],
        environ=environ,
    )

    assert namespace == "work"
    assert environ["METALIST_NAMESPACE"] == "work"


def test_resolve_namespace_launch_defaults_uses_tls_sensitive_defaults_and_saved_profile(
    tmp_path,
    monkeypatch,
) -> None:
    cert_path = tmp_path / "metalist-cert.pem"
    key_path = tmp_path / "metalist-key.pem"
    cert_path.write_text("cert", encoding="utf-8")
    key_path.write_text("key", encoding="utf-8")
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path / "MetaList")
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", cert_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", key_path)
    save_namespace_launch_profile(
        namespace="cla",
        port=9000,
        https_port=None,
        mcp_port=9776,
    )

    defaults = resolve_namespace_launch_defaults(
        namespace="cla",
        environ={},
    )

    assert defaults.namespace == "cla"
    assert defaults.port == 9000
    assert defaults.https_port == 8443
    assert defaults.mcp_port == 9776


def test_resolve_namespace_launch_defaults_ignores_saved_https_port_without_tls(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path / "MetaList")
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", tmp_path / "missing-cert.pem")
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", tmp_path / "missing-key.pem")
    save_namespace_launch_profile(
        namespace="cla",
        port=9000,
        https_port=9443,
        mcp_port=9776,
    )

    defaults = resolve_namespace_launch_defaults(
        namespace="cla",
        environ={},
    )

    assert defaults.namespace == "cla"
    assert defaults.port == 9000
    assert defaults.https_port is None
    assert defaults.mcp_port == 9776


def test_resolve_request_host_for_https_redirect_prefers_browser_host_header() -> None:
    request_host = resolve_request_host_for_https_redirect(
        host_header="localhost:8000",
        fallback_host="0.0.0.0",
    )

    assert request_host == "localhost"


def test_resolve_https_redirect_url_does_not_redirect_localhost_host_header_when_bind_host_is_wildcard() -> None:
    request_host = resolve_request_host_for_https_redirect(
        host_header="localhost:8000",
        fallback_host="0.0.0.0",
    )

    redirect_url = resolve_https_redirect_url(
        environ={"METALIST_HTTPS_PORT": "3443", "METALIST_HOST": "0.0.0.0"},
        request_scheme="http",
        request_host=request_host,
        request_path="/",
        request_query="",
    )

    assert redirect_url is None

def test_resolve_https_redirect_url_redirects_remote_http_requests_by_hostname() -> None:
    redirect_url = resolve_https_redirect_url(
        environ={"METALIST_HTTPS_PORT": "3443"},
        request_scheme="http",
        request_host="192.168.1.25",
        request_path="/",
        request_query="",
    )

    assert redirect_url == "https://192.168.1.25:3443/"


def test_resolve_https_redirect_url_uses_default_https_port_when_default_certs_exist(
    tmp_path,
    monkeypatch,
) -> None:
    cert_path = tmp_path / "metalist-cert.pem"
    key_path = tmp_path / "metalist-key.pem"
    cert_path.write_text("cert", encoding="utf-8")
    key_path.write_text("key", encoding="utf-8")
    monkeypatch.setattr(server_runtime, "_DEFAULT_CERT_PATH", cert_path)
    monkeypatch.setattr(server_runtime, "_DEFAULT_KEY_PATH", key_path)

    redirect_url = resolve_https_redirect_url(
        environ={"METALIST_HOST": "0.0.0.0"},
        request_scheme="http",
        request_host="10.0.0.31",
        request_path="/notes",
        request_query="a=1",
    )

    assert redirect_url == "https://10.0.0.31:8443/notes?a=1"


def test_resolve_https_redirect_url_does_not_redirect_localhost_http_requests() -> None:
    redirect_url = resolve_https_redirect_url(
        environ={"METALIST_HTTPS_PORT": "3443"},
        request_scheme="http",
        request_host="127.0.0.1",
        request_path="/notes",
        request_query="a=1",
    )

    assert redirect_url is None
