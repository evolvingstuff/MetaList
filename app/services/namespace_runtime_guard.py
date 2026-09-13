"""Terminate a namespace process whose on-disk namespace identity disappears."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
import os
import signal
import sqlite3
import threading
import time

from loguru import logger

from app.db.schema import NAMESPACE_LAUNCH_PROFILE_TABLE
from app.server_runtime import resolve_namespaced_database_path
from app.server_runtime import validate_namespace
from app.services.exception_capture import CapturedExceptionContext


_CHECK_INTERVAL_SECONDS = 5.0
_guard_lock = threading.Lock()
_guard_started = False


@dataclass(frozen=True)
class NamespaceRuntimeLegitimacy:
    is_legitimate: bool
    failure_reason: str


def inspect_namespace_runtime_legitimacy(*, namespace: str) -> NamespaceRuntimeLegitimacy:
    normalized_namespace = validate_namespace(namespace=namespace)
    database_path = resolve_namespaced_database_path(namespace=normalized_namespace)
    if not database_path.is_file():
        return NamespaceRuntimeLegitimacy(
            is_legitimate=False,
            failure_reason=(
                f"Namespace {normalized_namespace} database is missing: {database_path}"
            ),
        )

    database_capture = CapturedExceptionContext(OSError, sqlite3.Error, boundary='app/services/namespace_runtime_guard.py:inspect_namespace_runtime_legitimacy:database_capture')
    row = None
    with database_capture:
        with closing(
            sqlite3.connect(
                f"file:{database_path}?mode=ro",
                uri=True,
                check_same_thread=False,
            )
        ) as connection:
            row = connection.execute(
                f"""
                SELECT namespace
                FROM {NAMESPACE_LAUNCH_PROFILE_TABLE}
                WHERE namespace = ?
                """,
                (normalized_namespace,),
            ).fetchone()
    if database_capture.captured_exception is not None:
        return NamespaceRuntimeLegitimacy(
            is_legitimate=False,
            failure_reason=(
                f"Namespace {normalized_namespace} database check failed with "
                f"{type(database_capture.captured_exception).__name__}"
            ),
        )
    if row is None:
        return NamespaceRuntimeLegitimacy(
            is_legitimate=False,
            failure_reason=f"Namespace {normalized_namespace} launch profile is missing",
        )
    stored_namespace = str(row[0])
    if stored_namespace != normalized_namespace:
        return NamespaceRuntimeLegitimacy(
            is_legitimate=False,
            failure_reason=(
                f"Namespace runtime identity mismatch: expected {normalized_namespace}, "
                f"found {stored_namespace}"
            ),
        )
    return NamespaceRuntimeLegitimacy(is_legitimate=True, failure_reason="")


def assert_namespace_runtime_is_legitimate(*, namespace: str) -> None:
    legitimacy = inspect_namespace_runtime_legitimacy(namespace=namespace)
    if not legitimacy.is_legitimate:
        raise RuntimeError(legitimacy.failure_reason)


def _terminate_current_process() -> None:
    os.kill(os.getpid(), signal.SIGTERM)


def _run_namespace_runtime_guard(
    *,
    namespace: str,
    check_interval_seconds: float,
    sleep: Callable[[float], None],
) -> None:
    if check_interval_seconds <= 0.0:
        raise ValueError("check_interval_seconds must be positive")
    while True:
        sleep(check_interval_seconds)
        legitimacy = inspect_namespace_runtime_legitimacy(namespace=namespace)
        if legitimacy.is_legitimate:
            continue
        logger.critical(
            "[namespace-guard] namespace legitimacy check failed; terminating "
            "namespace={namespace} reason={reason}",
            namespace=namespace,
            reason=legitimacy.failure_reason,
        )
        _terminate_current_process()
        return


def start_namespace_runtime_guard(*, namespace: str | None, enabled: bool) -> bool:
    global _guard_started

    if not enabled:
        return False
    if namespace is None:
        raise RuntimeError("Namespace runtime guard requires an active namespace")
    normalized_namespace = validate_namespace(namespace=namespace)
    with _guard_lock:
        if _guard_started:
            return False
        thread = threading.Thread(
            target=_run_namespace_runtime_guard,
            kwargs={
                "namespace": normalized_namespace,
                "check_interval_seconds": _CHECK_INTERVAL_SECONDS,
                "sleep": time.sleep,
            },
            name="metalist-namespace-runtime-guard",
            daemon=True,
        )
        _guard_started = True
        thread.start()
    return True
