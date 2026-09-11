from __future__ import annotations

import argparse
from collections.abc import Mapping, MutableMapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import ipaddress
import os
from pathlib import Path
import re
import socket
import sqlite3
import tempfile
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from app.data_directory import resolve_data_directory
from app.db.schema import NAMESPACE_LAUNCH_PROFILE_TABLE
from app.db.schema import initialize_schema
from app.db.settings_sql import insert_default_settings
from app.services.exception_capture import CapturedExceptionContext
from app.security.shell_execution import enable_shell_execution_for_launch
from app.security.shell_execution import SHELL_EXECUTION_ENV_NAME


_LOOPBACK_BIND_HOSTS = frozenset({"127.0.0.1", "localhost", "0.0.0.0", "::1"})
_DEFAULT_API_PREFIX = "/api2"
_DEFAULT_V1_API_PREFIX = "/api"
_DEFAULT_DATABASE_DIRECTORY = resolve_data_directory(environ=os.environ)
_DEFAULT_CERT_PATH = _DEFAULT_DATABASE_DIRECTORY / "certs" / "metalist-cert.pem"
_DEFAULT_KEY_PATH = _DEFAULT_DATABASE_DIRECTORY / "certs" / "metalist-key.pem"
_DEFAULT_RUNTIME_DIRECTORY = Path(tempfile.gettempdir()) / "metalist-runtime"
if "METALIST_DATA_DIRECTORY" in os.environ:
    _DEFAULT_RUNTIME_DIRECTORY = _DEFAULT_DATABASE_DIRECTORY / "runtime"
_DEFAULT_NAMESPACES_DIRECTORY_NAME = "namespaces"
_DEFAULT_NAMESPACE_DELETE_JOBS_DIRECTORY_NAME = "namespace-delete-jobs"
_DEFAULT_NAMESPACE_RENAME_JOBS_DIRECTORY_NAME = "namespace-rename-jobs"
_DEFAULT_LOGS_DIRECTORY_NAME = "logs"
_DEFAULT_MANAGED_RUNTIME_DIRECTORY_NAME = "runtime"
_DEFAULT_NAMESPACE = "default"
_DEFAULT_HTTP_PORT = 8000
_DEFAULT_HTTPS_PORT = 8443
_DEFAULT_TEST_DATABASE_URL = "sqlite:///./test.db"
_DEFAULT_TEST_DATABASE_PATH = Path("./test.db")
_NAMESPACE_ENV_NAME = "METALIST_NAMESPACE"
_NAMESPACE_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


@dataclass(frozen=True)
class MainServerConfig:
    host: str
    port: int
    https_port: int | None
    proxy_headers: bool
    forwarded_allow_ips: str
    ssl_certfile: str | None
    ssl_keyfile: str | None


@dataclass(frozen=True)
class DatabaseRuntimeConfig:
    database_path: Path
    database_url: str
    namespace: str | None
    test_mode: bool


@dataclass(frozen=True)
class MainCliArgs:
    namespace: str | None
    port: int | None
    https_port: int | None
    test_mode: bool
    namespace_requested: bool
    shell_enabled: bool


@dataclass(frozen=True)
class NamespaceLaunchProfile:
    namespace: str
    port: int | None
    https_port: int | None
    mcp_port: int | None


def _parse_port_argument(raw_value: str) -> int:
    value = raw_value.strip()
    if value == "":
        raise argparse.ArgumentTypeError("port must not be empty")
    if not value.isdigit():
        raise argparse.ArgumentTypeError(f"port must be numeric, got: {raw_value!r}")
    parsed = int(value)
    if not 0 < parsed < 65536:
        raise argparse.ArgumentTypeError(f"port must be between 1 and 65535, got: {parsed}")
    return parsed


def _parse_namespace_argument(raw_value: str) -> str:
    namespace_capture = CapturedExceptionContext(RuntimeError)
    normalized_namespace: str | None = None
    with namespace_capture:
        normalized_namespace = validate_namespace(namespace=raw_value)
    if namespace_capture.captured_exception is not None:
        exc = namespace_capture.captured_exception
        raise argparse.ArgumentTypeError(str(exc)) from exc
    if normalized_namespace is None:
        raise RuntimeError("Namespace argument parser did not return a namespace")
    return normalized_namespace


def validate_namespace(*, namespace: str) -> str:
    if not isinstance(namespace, str):
        raise TypeError(f"namespace must be a string, got {type(namespace)}")
    normalized = namespace.strip()
    if normalized == "":
        raise RuntimeError("Namespace must not be empty")
    if normalized != normalized.casefold():
        raise RuntimeError("Namespace must contain only lowercase letters, digits, and '-'")
    if _NAMESPACE_PATTERN.fullmatch(normalized) is None:
        raise RuntimeError("Namespace must contain only lowercase letters, digits, and '-'")
    return normalized


def resolve_namespaces_directory() -> Path:
    return _DEFAULT_DATABASE_DIRECTORY / _DEFAULT_NAMESPACES_DIRECTORY_NAME


def resolve_namespace_delete_jobs_directory() -> Path:
    return _DEFAULT_RUNTIME_DIRECTORY / _DEFAULT_NAMESPACE_DELETE_JOBS_DIRECTORY_NAME


def resolve_namespace_rename_jobs_directory() -> Path:
    return _DEFAULT_RUNTIME_DIRECTORY / _DEFAULT_NAMESPACE_RENAME_JOBS_DIRECTORY_NAME


def resolve_runtime_logs_directory() -> Path:
    return _DEFAULT_DATABASE_DIRECTORY / _DEFAULT_LOGS_DIRECTORY_NAME


def resolve_managed_runtime_directory() -> Path:
    return _DEFAULT_DATABASE_DIRECTORY / _DEFAULT_MANAGED_RUNTIME_DIRECTORY_NAME


def resolve_namespace_directory(*, namespace: str) -> Path:
    normalized = validate_namespace(namespace=namespace)
    return resolve_namespaces_directory() / normalized


def resolve_default_database_path() -> Path:
    return resolve_namespaced_database_path(namespace=_DEFAULT_NAMESPACE)


def resolve_namespaced_database_path(*, namespace: str) -> Path:
    normalized = validate_namespace(namespace=namespace)
    return resolve_namespace_directory(namespace=normalized) / f"{normalized}.metalist.db"


def prepare_database_runtime_path(*, database_path: Path) -> None:
    if not isinstance(database_path, Path):
        raise TypeError(f"database_path must be a Path, got {type(database_path)}")
    _DEFAULT_DATABASE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    resolve_namespaces_directory().mkdir(parents=True, exist_ok=True)
    database_path.parent.mkdir(parents=True, exist_ok=True)


def _validate_optional_port(*, name: str, value: int | None) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int):
        raise TypeError(f"{name} must be an int or None, got {type(value)}")
    if not 0 < value < 65536:
        raise ValueError(f"{name} must be between 1 and 65535, got: {value}")
    return value


def _coerce_optional_db_port(*, value: object) -> int | None:
    if value is None:
        return None
    return int(value)


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect_namespace_database(
    *,
    namespace: str,
    create_if_missing: bool,
) -> sqlite3.Connection | None:
    database_path = resolve_namespaced_database_path(namespace=namespace)
    database_was_missing = not database_path.exists()
    if database_was_missing:
        if not create_if_missing:
            return None
        prepare_database_runtime_path(database_path=database_path)
    elif not database_path.is_file():
        raise RuntimeError(f"Namespace database path is not a file: {database_path}")
    connection = sqlite3.connect(str(database_path), check_same_thread=False)
    initialize_schema(connection)
    if database_was_missing:
        insert_default_settings(connection)
    connection.commit()
    return connection


def _fetch_launch_profile_from_connection(
    *,
    connection: sqlite3.Connection,
    namespace: str,
) -> NamespaceLaunchProfile | None:
    row = connection.execute(
        f"""
        SELECT namespace, port, https_port, mcp_port
        FROM {NAMESPACE_LAUNCH_PROFILE_TABLE}
        WHERE namespace = ?
        """,
        (namespace,),
    ).fetchone()
    if row is None:
        return None
    stored_namespace = str(row[0])
    if stored_namespace != namespace:
        raise RuntimeError(
            f"Launch profile namespace mismatch in {namespace}: found {stored_namespace}"
        )
    return NamespaceLaunchProfile(
        namespace=stored_namespace,
        port=_coerce_optional_db_port(value=row[1]),
        https_port=_coerce_optional_db_port(value=row[2]),
        mcp_port=_coerce_optional_db_port(value=row[3]),
    )


def _assert_launch_profile_rows_belong_to_namespace(
    *,
    connection: sqlite3.Connection,
    namespace: str,
) -> None:
    rows = connection.execute(
        f"""
        SELECT namespace
        FROM {NAMESPACE_LAUNCH_PROFILE_TABLE}
        ORDER BY namespace ASC
        """
    ).fetchall()
    for row in rows:
        stored_namespace = str(row[0])
        if stored_namespace == namespace:
            continue
        raise RuntimeError(
            f"Namespace DB for {namespace} contains launch profile for {stored_namespace}"
        )


def _missing_launch_profile_message(*, namespace: str) -> str:
    return (
        f"Namespace {namespace} has no launch profile. "
        "Run this namespace once with an explicit --port value"
        " plus --https-port when TLS is enabled, or configure its ports from the namespace UI."
    )


def _read_profile_from_explicit_environment(
    *,
    namespace: str,
    environ: Mapping[str, str],
) -> NamespaceLaunchProfile | None:
    env_port = _read_optional_int(environ=environ, name="METALIST_PORT")
    env_https_port = _read_optional_int(environ=environ, name="METALIST_HTTPS_PORT")
    if env_port is None and env_https_port is None:
        return None
    ssl_certfile, _ = _resolve_tls_pair(environ=environ)
    if env_port is None:
        raise RuntimeError(_missing_launch_profile_message(namespace=namespace))
    if ssl_certfile is not None and env_https_port is None:
        raise RuntimeError(_missing_launch_profile_message(namespace=namespace))
    return NamespaceLaunchProfile(
        namespace=namespace,
        port=env_port,
        https_port=env_https_port,
        mcp_port=None,
    )


def load_namespace_launch_profile(*, namespace: str) -> NamespaceLaunchProfile | None:
    normalized_namespace = validate_namespace(namespace=namespace)
    connection = _connect_namespace_database(
        namespace=normalized_namespace,
        create_if_missing=False,
    )
    if connection is None:
        return None
    try:
        _assert_launch_profile_rows_belong_to_namespace(
            connection=connection,
            namespace=normalized_namespace,
        )
        profile = _fetch_launch_profile_from_connection(
            connection=connection,
            namespace=normalized_namespace,
        )
    finally:
        connection.close()
    return profile


def _read_namespace_launch_profile(
    *,
    database_path: Path,
    namespace: str,
) -> NamespaceLaunchProfile | None:
    database_uri = f"{database_path.resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(database_uri, uri=True, check_same_thread=False)
    try:
        connection.execute("PRAGMA query_only = ON")
        profile_table = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            (NAMESPACE_LAUNCH_PROFILE_TABLE,),
        ).fetchone()
        if profile_table is None:
            return None
        _assert_launch_profile_rows_belong_to_namespace(
            connection=connection,
            namespace=namespace,
        )
        return _fetch_launch_profile_from_connection(
            connection=connection,
            namespace=namespace,
        )
    finally:
        connection.close()


def _load_all_namespace_launch_profiles(*, read_only: bool) -> list[NamespaceLaunchProfile]:
    namespaces_directory = resolve_namespaces_directory()
    if not namespaces_directory.exists():
        return []
    if not namespaces_directory.is_dir():
        raise RuntimeError(f"Namespaces path is not a directory: {namespaces_directory}")

    profiles: list[NamespaceLaunchProfile] = []
    for child in sorted(namespaces_directory.iterdir(), key=lambda path: path.name):
        if not child.is_dir():
            continue
        validate_capture = CapturedExceptionContext(RuntimeError)
        normalized_namespace: str | None = None
        with validate_capture:
            normalized_namespace = validate_namespace(namespace=child.name)
        if validate_capture.captured_exception is not None:
            continue
        if normalized_namespace is None:
            raise RuntimeError("Namespace validation did not return a namespace")
        database_path = resolve_namespaced_database_path(namespace=normalized_namespace)
        if not database_path.is_file():
            raise RuntimeError(
                f"Namespace {normalized_namespace} directory exists but database is missing: "
                f"{database_path}"
            )
        if read_only:
            profile = _read_namespace_launch_profile(
                database_path=database_path,
                namespace=normalized_namespace,
            )
        else:
            profile = load_namespace_launch_profile(namespace=normalized_namespace)
        if profile is None:
            continue
        profiles.append(profile)
    return profiles


def load_all_namespace_launch_profiles() -> list[NamespaceLaunchProfile]:
    return _load_all_namespace_launch_profiles(read_only=False)


def load_all_namespace_launch_profiles_read_only() -> list[NamespaceLaunchProfile]:
    return _load_all_namespace_launch_profiles(read_only=True)


def save_namespace_launch_profile(
    *,
    namespace: str,
    port: int | None,
    https_port: int | None,
    mcp_port: int | None,
) -> NamespaceLaunchProfile:
    normalized_namespace = validate_namespace(namespace=namespace)
    normalized_port = _validate_optional_port(name="port", value=port)
    normalized_https_port = _validate_optional_port(name="https_port", value=https_port)
    normalized_mcp_port = _validate_optional_port(name="mcp_port", value=mcp_port)
    connection = _connect_namespace_database(
        namespace=normalized_namespace,
        create_if_missing=True,
    )
    if connection is None:
        raise RuntimeError("Namespace DB connection was not created")
    try:
        now = _utc_timestamp()
        connection.execute(
            f"""
            INSERT INTO {NAMESPACE_LAUNCH_PROFILE_TABLE} (
                namespace,
                port,
                https_port,
                mcp_port,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(namespace) DO UPDATE SET
                port = excluded.port,
                https_port = excluded.https_port,
                mcp_port = excluded.mcp_port,
                updated_at = excluded.updated_at
            """,
            (
                normalized_namespace,
                normalized_port,
                normalized_https_port,
                normalized_mcp_port,
                now,
                now,
            ),
        )
        connection.commit()
    finally:
        connection.close()
    return NamespaceLaunchProfile(
        namespace=normalized_namespace,
        port=normalized_port,
        https_port=normalized_https_port,
        mcp_port=normalized_mcp_port,
    )


def delete_namespace_launch_profile(*, namespace: str) -> None:
    normalized_namespace = validate_namespace(namespace=namespace)
    connection = _connect_namespace_database(
        namespace=normalized_namespace,
        create_if_missing=False,
    )
    if connection is None:
        return
    try:
        connection.execute(
            f"""
            DELETE FROM {NAMESPACE_LAUNCH_PROFILE_TABLE}
            WHERE namespace = ?
            """,
            (normalized_namespace,),
        )
        connection.commit()
    finally:
        connection.close()


def resolve_namespace_launch_defaults(
    *,
    namespace: str,
    environ: Mapping[str, str],
) -> NamespaceLaunchProfile:
    normalized_namespace = validate_namespace(namespace=namespace)
    stored_profile = load_namespace_launch_profile(namespace=normalized_namespace)
    env_port = _read_optional_int(environ=environ, name="METALIST_PORT")
    env_https_port = _read_optional_int(environ=environ, name="METALIST_HTTPS_PORT")
    ssl_certfile, _ = _resolve_tls_pair(environ=environ)

    if stored_profile is not None and stored_profile.port is not None:
        port = stored_profile.port
    else:
        port = _DEFAULT_HTTP_PORT
    if env_port is not None:
        port = env_port

    if (
        stored_profile is not None
        and stored_profile.https_port is not None
        and ssl_certfile is not None
    ):
        https_port = stored_profile.https_port
    elif ssl_certfile is not None:
        https_port = _DEFAULT_HTTPS_PORT
    else:
        https_port = None
    if env_https_port is not None:
        https_port = env_https_port

    if stored_profile is None:
        legacy_mcp_port = None
    else:
        legacy_mcp_port = stored_profile.mcp_port

    return NamespaceLaunchProfile(
        namespace=normalized_namespace,
        port=port,
        https_port=https_port,
        mcp_port=legacy_mcp_port,
    )


def _apply_namespace_profile_to_environ(
    *,
    environ: MutableMapping[str, str],
    profile: NamespaceLaunchProfile | None,
    cli_port: int | None,
    cli_https_port: int | None,
) -> None:
    ssl_certfile, _ = _resolve_tls_pair(environ=environ)
    if cli_port is None and "METALIST_PORT" not in environ and profile is not None and profile.port is not None:
        environ["METALIST_PORT"] = str(profile.port)
    if (
        cli_https_port is None
        and "METALIST_HTTPS_PORT" not in environ
        and profile is not None
        and profile.https_port is not None
        and ssl_certfile is not None
    ):
        environ["METALIST_HTTPS_PORT"] = str(profile.https_port)


def resolve_api_prefix(*, environ: Mapping[str, str]) -> str:
    if "API_PREFIX" in environ:
        return environ["API_PREFIX"].rstrip("/")
    return _DEFAULT_API_PREFIX


def resolve_v1_api_prefix(*, environ: Mapping[str, str]) -> str:
    if "V1_API_PREFIX" in environ:
        return environ["V1_API_PREFIX"].rstrip("/")
    return _DEFAULT_V1_API_PREFIX


def resolve_test_mode(*, environ: Mapping[str, str], argv: Sequence[str]) -> bool:
    if "--test" in argv:
        return True
    if "TEST_MODE" in environ:
        return environ["TEST_MODE"] == "1"
    return False


def resolve_database_runtime_config(
    *,
    environ: Mapping[str, str],
    argv: Sequence[str],
) -> DatabaseRuntimeConfig:
    test_mode = resolve_test_mode(environ=environ, argv=argv)
    namespace_value = _read_optional_text(environ=environ, name=_NAMESPACE_ENV_NAME)
    namespace = _DEFAULT_NAMESPACE
    if namespace_value is not None:
        namespace = validate_namespace(namespace=namespace_value)

    if test_mode:
        if namespace_value is not None:
            raise RuntimeError("Namespace selection cannot be combined with TEST_MODE or --test")
        return DatabaseRuntimeConfig(
            database_path=_DEFAULT_TEST_DATABASE_PATH,
            database_url=_DEFAULT_TEST_DATABASE_URL,
            namespace=None,
            test_mode=True,
        )

    database_path = resolve_namespaced_database_path(namespace=namespace)

    return DatabaseRuntimeConfig(
        database_path=database_path,
        database_url=f"sqlite:///{database_path.expanduser()}",
        namespace=namespace,
        test_mode=False,
    )


def apply_namespace_arg_to_environ(
    *,
    argv: Sequence[str],
    environ: MutableMapping[str, str],
) -> str | None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--namespace", type=_parse_namespace_argument)
    parsed_args, _ = parser.parse_known_args(list(argv))
    namespace = parsed_args.namespace
    if namespace is None:
        return None
    environ[_NAMESPACE_ENV_NAME] = namespace
    return namespace


def apply_main_cli_args_to_environ(
    *,
    argv: Sequence[str],
    environ: MutableMapping[str, str],
) -> MainCliArgs:
    parser = argparse.ArgumentParser(description="Run the MetaList server")
    parser.add_argument(
        "--namespace",
        type=_parse_namespace_argument,
        help="Namespace to run. Defaults to 'default' when omitted.",
    )
    parser.add_argument(
        "namespace_shorthand",
        nargs="?",
        type=_parse_namespace_argument,
        help="Namespace shorthand, e.g. `python main.py cla`.",
    )
    parser.add_argument(
        "--port",
        type=_parse_port_argument,
        help="HTTP port for this launch and remembered namespace profile.",
    )
    parser.add_argument(
        "--https-port",
        type=_parse_port_argument,
        help="HTTPS port for this launch and remembered namespace profile.",
    )
    parser.add_argument(
        "--enable-shell",
        action="store_true",
        help="Enable @shell execution for authenticated loopback requests.",
    )
    parser.add_argument("--test", action="store_true", help="Run against the temporary test database.")
    parsed_args = parser.parse_args(list(argv))

    if parsed_args.enable_shell:
        enable_shell_execution_for_launch(environ=environ)
    elif SHELL_EXECUTION_ENV_NAME in environ:
        del environ[SHELL_EXECUTION_ENV_NAME]

    if parsed_args.namespace is not None and parsed_args.namespace_shorthand is not None:
        raise RuntimeError("Specify namespace either positionally or with --namespace, not both")

    namespace_requested = False
    if parsed_args.namespace is not None:
        namespace_requested = True
    if parsed_args.namespace_shorthand is not None:
        namespace_requested = True
    namespace = parsed_args.namespace
    if namespace is None:
        namespace = parsed_args.namespace_shorthand

    if namespace is not None and parsed_args.test:
        raise RuntimeError("Namespace selection cannot be combined with TEST_MODE or --test")

    if parsed_args.test:
        resolved_namespace = None
    elif namespace is not None:
        resolved_namespace = namespace
    elif _NAMESPACE_ENV_NAME in environ:
        resolved_namespace = validate_namespace(namespace=environ[_NAMESPACE_ENV_NAME])
    else:
        resolved_namespace = _DEFAULT_NAMESPACE
    if resolved_namespace is not None:
        environ[_NAMESPACE_ENV_NAME] = resolved_namespace
        stored_profile = load_namespace_launch_profile(namespace=resolved_namespace)
    else:
        stored_profile = None

    if parsed_args.port is not None:
        environ["METALIST_PORT"] = str(parsed_args.port)
    if parsed_args.https_port is not None:
        environ["METALIST_HTTPS_PORT"] = str(parsed_args.https_port)
    if resolved_namespace is not None:
        if stored_profile is None:
            explicit_profile = _read_profile_from_explicit_environment(
                namespace=resolved_namespace,
                environ=environ,
            )
            if explicit_profile is None:
                raise RuntimeError(_missing_launch_profile_message(namespace=resolved_namespace))
            stored_profile = save_namespace_launch_profile(
                namespace=explicit_profile.namespace,
                port=explicit_profile.port,
                https_port=explicit_profile.https_port,
                mcp_port=explicit_profile.mcp_port,
            )
        _apply_namespace_profile_to_environ(
            environ=environ,
            profile=stored_profile,
            cli_port=parsed_args.port,
            cli_https_port=parsed_args.https_port,
        )
        if (
            parsed_args.port is not None
            or parsed_args.https_port is not None
        ):
            stored_port = None
            stored_https_port = None
            stored_mcp_port = None
            if stored_profile is not None:
                stored_port = stored_profile.port
                stored_https_port = stored_profile.https_port
                stored_mcp_port = stored_profile.mcp_port
            resolved_port = stored_port
            if parsed_args.port is not None:
                resolved_port = parsed_args.port
            resolved_https_port = stored_https_port
            if parsed_args.https_port is not None:
                resolved_https_port = parsed_args.https_port
            save_namespace_launch_profile(
                namespace=resolved_namespace,
                port=resolved_port,
                https_port=resolved_https_port,
                mcp_port=stored_mcp_port,
            )

    return MainCliArgs(
        namespace=resolved_namespace,
        port=parsed_args.port,
        https_port=parsed_args.https_port,
        test_mode=parsed_args.test,
        namespace_requested=namespace_requested,
        shell_enabled=parsed_args.enable_shell,
    )


def resolve_backend_connect_host(*, host: str) -> str:
    stripped_host = host.strip()
    if stripped_host == "":
        raise RuntimeError("host must not be empty")
    if stripped_host in {"0.0.0.0", "127.0.0.1", "localhost"}:
        return "127.0.0.1"
    if stripped_host == "::":
        return "::1"
    return stripped_host


def resolve_local_browser_host(*, host: str) -> str:
    stripped_host = host.strip()
    if stripped_host == "":
        raise RuntimeError("host must not be empty")
    if stripped_host in {"0.0.0.0", "127.0.0.1", "localhost"}:
        return "127.0.0.1"
    if stripped_host in {"::", "::1"}:
        return "[::1]"
    return stripped_host


def resolve_request_host_for_https_redirect(
    *,
    host_header: str | None,
    fallback_host: str | None,
) -> str | None:
    if host_header is not None and host_header.strip() != "":
        candidate_header = host_header.strip()
    else:
        candidate_header = None

    if candidate_header is None:
        return fallback_host

    parsed = urlsplit(f"//{candidate_header}")
    if parsed.hostname is None or parsed.hostname.strip() == "":
        raise RuntimeError(f"Could not parse request host header: {candidate_header!r}")
    return parsed.hostname


def _read_text(*, environ: Mapping[str, str], name: str, fallback: str) -> str:
    if name in environ:
        value = environ[name]
    else:
        value = fallback
    stripped = value.strip()
    if stripped == "":
        raise RuntimeError(f"{name} must not be empty")
    return stripped


def _read_optional_text(*, environ: Mapping[str, str], name: str) -> str | None:
    if name not in environ:
        return None
    stripped = environ[name].strip()
    if stripped == "":
        raise RuntimeError(f"{name} must not be empty")
    return stripped


def _read_int(*, environ: Mapping[str, str], name: str, fallback: int) -> int:
    if name in environ:
        raw_value = environ[name]
    else:
        raw_value = str(fallback)
    value = raw_value.strip()
    if value == "":
        raise RuntimeError(f"{name} must not be empty")
    if not value.isdigit():
        raise RuntimeError(f"{name} must be numeric, got: {value!r}")
    parsed = int(value)
    if not 0 < parsed < 65536:
        raise RuntimeError(f"{name} must be between 1 and 65535, got: {parsed}")
    return parsed


def _read_optional_int(*, environ: Mapping[str, str], name: str) -> int | None:
    raw_value = _read_optional_text(environ=environ, name=name)
    if raw_value is None:
        return None
    if not raw_value.isdigit():
        raise RuntimeError(f"{name} must be numeric, got: {raw_value!r}")
    parsed = int(raw_value)
    if not 0 < parsed < 65536:
        raise RuntimeError(f"{name} must be between 1 and 65535, got: {parsed}")
    return parsed


def _read_flag(*, environ: Mapping[str, str], name: str, fallback: bool) -> bool:
    if name in environ:
        raw_value = environ[name]
    else:
        raw_value = "0"
        if fallback:
            raw_value = "1"
    value = raw_value.strip().lower()
    if value == "":
        raise RuntimeError(f"{name} must not be empty")
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"Invalid boolean env flag {name}={value!r}")


def _resolve_existing_file(*, path_text: str, env_name: str) -> str:
    path = Path(path_text).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"{env_name} file not found: {path}")
    return str(path)


def _format_host_for_url(*, host: str) -> str:
    if ":" in host and not host.startswith("[") and not host.endswith("]"):
        return f"[{host}]"
    return host


def _is_loopback_host(*, host: str) -> bool:
    normalized = host.strip().casefold()
    if normalized == "":
        return False
    if normalized == "localhost":
        return True
    parse_capture = CapturedExceptionContext(ValueError)
    parsed_ip: ipaddress._BaseAddress | None = None
    with parse_capture:
        parsed_ip = ipaddress.ip_address(normalized)
    if parse_capture.captured_exception is not None:
        return False
    if parsed_ip is None:
        raise RuntimeError("Loopback-host parser did not return an IP address")
    return parsed_ip.is_loopback


def _resolve_tls_hostname() -> str:
    hostname = socket.gethostname().strip()
    if hostname == "":
        return "localhost"
    return hostname


def _detect_lan_ip(*, environ: Mapping[str, str]) -> str | None:
    configured_lan_ip = _read_optional_text(environ=environ, name="METALIST_LAN_IP")
    if configured_lan_ip is not None:
        configured_ip_capture = CapturedExceptionContext(ValueError)
        with configured_ip_capture:
            ipaddress.ip_address(configured_lan_ip)
        if configured_ip_capture.captured_exception is not None:
            exc = configured_ip_capture.captured_exception
            raise RuntimeError(f"METALIST_LAN_IP must be a valid IP address: {configured_lan_ip!r}") from exc
        return configured_lan_ip

    probe_capture = CapturedExceptionContext(OSError)
    candidate_ip: str | None = None
    with probe_capture:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe_socket:
            probe_socket.connect(("8.8.8.8", 80))
            candidate_ip = probe_socket.getsockname()[0]
    if probe_capture.captured_exception is None:
        if candidate_ip is None:
            raise RuntimeError("LAN-IP probe did not return an address")
        if not _is_loopback_host(host=candidate_ip):
            return candidate_ip

    hostname = _resolve_tls_hostname()
    resolve_capture = CapturedExceptionContext(OSError)
    resolved_ips: list[str] | None = None
    with resolve_capture:
        resolved_ips = socket.gethostbyname_ex(hostname)[2]
    if resolve_capture.captured_exception is not None:
        return None
    if resolved_ips is None:
        raise RuntimeError("Hostname resolution did not return an IP list")
    for candidate_ip in resolved_ips:
        parsed_ip_capture = CapturedExceptionContext(ValueError)
        parsed_ip: ipaddress._BaseAddress | None = None
        with parsed_ip_capture:
            parsed_ip = ipaddress.ip_address(candidate_ip)
        if parsed_ip_capture.captured_exception is not None:
            continue
        if parsed_ip is None:
            raise RuntimeError("Resolved IP parser did not return an IP address")
        if parsed_ip.is_loopback:
            continue
        return candidate_ip

    return None


def ensure_default_tls_pair(*, environ: Mapping[str, str]) -> tuple[str, str] | None:
    explicit_certfile = _read_optional_text(environ=environ, name="METALIST_SSL_CERTFILE")
    explicit_keyfile = _read_optional_text(environ=environ, name="METALIST_SSL_KEYFILE")
    if explicit_certfile is None:
        explicit_certfile = _read_optional_text(environ=environ, name="METALIST_TLS_CERT")
    if explicit_keyfile is None:
        explicit_keyfile = _read_optional_text(environ=environ, name="METALIST_TLS_KEY")
    if explicit_certfile is not None or explicit_keyfile is not None:
        return None
    if not _read_flag(environ=environ, name="METALIST_AUTO_GENERATE_TLS", fallback=True):
        return None

    if _DEFAULT_CERT_PATH.is_file() and _DEFAULT_KEY_PATH.is_file():
        return (str(_DEFAULT_CERT_PATH), str(_DEFAULT_KEY_PATH))

    _DEFAULT_CERT_PATH.parent.mkdir(parents=True, exist_ok=True)
    _DEFAULT_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)

    hostname = _resolve_tls_hostname()
    lan_ip = _detect_lan_ip(environ=environ)
    common_name = hostname
    if lan_ip is not None:
        common_name = lan_ip
    san_entries: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.DNSName(hostname),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    ]
    if lan_ip is not None and lan_ip != "127.0.0.1":
        san_entries.append(x509.IPAddress(ipaddress.ip_address(lan_ip)))

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, common_name)]
    )
    now = datetime.now(timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .sign(private_key=private_key, algorithm=hashes.SHA256())
    )

    _DEFAULT_CERT_PATH.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    _DEFAULT_KEY_PATH.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    os.chmod(_DEFAULT_CERT_PATH, 0o644)
    os.chmod(_DEFAULT_KEY_PATH, 0o600)
    print(
        "Generated default TLS certificate: "
        f"cert={_DEFAULT_CERT_PATH.expanduser()} "
        f"key={_DEFAULT_KEY_PATH.expanduser()}"
    )
    return (str(_DEFAULT_CERT_PATH), str(_DEFAULT_KEY_PATH))


def _resolve_tls_pair(*, environ: Mapping[str, str]) -> tuple[str | None, str | None]:
    cert_env_value = _read_optional_text(environ=environ, name="METALIST_SSL_CERTFILE")
    key_env_value = _read_optional_text(environ=environ, name="METALIST_SSL_KEYFILE")
    if cert_env_value is None:
        cert_env_value = _read_optional_text(environ=environ, name="METALIST_TLS_CERT")
    if key_env_value is None:
        key_env_value = _read_optional_text(environ=environ, name="METALIST_TLS_KEY")

    if (cert_env_value is None) != (key_env_value is None):
        raise RuntimeError(
            "METALIST_SSL_CERTFILE/METALIST_TLS_CERT and "
            "METALIST_SSL_KEYFILE/METALIST_TLS_KEY must be set together",
        )

    if cert_env_value is not None and key_env_value is not None:
        return (
            _resolve_existing_file(
                path_text=cert_env_value,
                env_name="METALIST_SSL_CERTFILE/METALIST_TLS_CERT",
            ),
            _resolve_existing_file(
                path_text=key_env_value,
                env_name="METALIST_SSL_KEYFILE/METALIST_TLS_KEY",
            ),
        )

    if _DEFAULT_CERT_PATH.is_file() and _DEFAULT_KEY_PATH.is_file():
        return (str(_DEFAULT_CERT_PATH), str(_DEFAULT_KEY_PATH))
    return (None, None)


def _resolve_https_port(*, environ: Mapping[str, str], ssl_certfile: str | None) -> int | None:
    https_port = _read_optional_int(environ=environ, name="METALIST_HTTPS_PORT")
    if https_port is not None:
        return https_port
    if ssl_certfile is not None:
        return _DEFAULT_HTTPS_PORT
    return None


def resolve_main_server_config(*, environ: Mapping[str, str]) -> MainServerConfig:
    ssl_certfile, ssl_keyfile = _resolve_tls_pair(environ=environ)

    host = _read_text(environ=environ, name="METALIST_HOST", fallback="127.0.0.1")
    port = _read_int(environ=environ, name="METALIST_PORT", fallback=_DEFAULT_HTTP_PORT)
    https_port = _resolve_https_port(environ=environ, ssl_certfile=ssl_certfile)
    proxy_headers = _read_flag(environ=environ, name="METALIST_PROXY_HEADERS", fallback=True)
    forwarded_allow_ips = _read_text(
        environ=environ,
        name="METALIST_FORWARDED_ALLOW_IPS",
        fallback="127.0.0.1,::1",
    )
    if https_port is not None and ssl_certfile is None:
        raise RuntimeError(
            "METALIST_HTTPS_PORT requires TLS certs via "
            "METALIST_SSL_CERTFILE/METALIST_TLS_CERT or ~/MetaList/certs/metalist-cert.pem",
        )
    if https_port is not None and https_port == port:
        raise RuntimeError("METALIST_HTTPS_PORT must differ from METALIST_PORT")

    return MainServerConfig(
        host=host,
        port=port,
        https_port=https_port,
        proxy_headers=proxy_headers,
        forwarded_allow_ips=forwarded_allow_ips,
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
    )


def resolve_https_redirect_url(
    *,
    environ: Mapping[str, str],
    request_scheme: str,
    request_host: str | None,
    request_path: str,
    request_query: str,
) -> str | None:
    ssl_certfile, _ = _resolve_tls_pair(environ=environ)
    https_port = _resolve_https_port(environ=environ, ssl_certfile=ssl_certfile)
    if https_port is None:
        return None

    scheme = request_scheme.strip().lower()
    if scheme == "":
        raise RuntimeError("request_scheme must not be empty")
    if scheme not in {"http", "https"}:
        raise RuntimeError(f"Unsupported request scheme: {request_scheme!r}")
    if scheme != "http":
        return None
    if request_host is None or request_host.strip() == "":
        raise RuntimeError("request_host must not be empty when HTTPS redirect is enabled")
    if _is_loopback_host(host=request_host):
        return None

    formatted_host = _format_host_for_url(host=request_host.strip())
    query_suffix = ""
    if request_query != "":
        query_suffix = f"?{request_query}"
    return f"https://{formatted_host}:{https_port}{request_path}{query_suffix}"
