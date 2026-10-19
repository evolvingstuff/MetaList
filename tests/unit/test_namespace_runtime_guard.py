from __future__ import annotations

import shutil
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

import app.server_runtime as server_runtime
import app.services.namespace_runtime_guard as namespace_runtime_guard
from app.db.schema import NAMESPACE_LAUNCH_PROFILE_TABLE
from app.server_runtime import save_namespace_launch_profile


def test_namespace_runtime_guard_accepts_registered_namespace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    save_namespace_launch_profile(
        namespace="work",
        port=8001,
        https_port=None,
        mcp_port=None,
    )

    legitimacy = namespace_runtime_guard.inspect_namespace_runtime_legitimacy(namespace="work")

    assert legitimacy.is_legitimate is True
    assert legitimacy.failure_reason == ""


def test_namespace_runtime_guard_rejects_removed_namespace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    save_namespace_launch_profile(
        namespace="work",
        port=8001,
        https_port=None,
        mcp_port=None,
    )
    shutil.rmtree(server_runtime.resolve_namespace_directory(namespace="work"))

    legitimacy = namespace_runtime_guard.inspect_namespace_runtime_legitimacy(namespace="work")

    assert legitimacy.is_legitimate is False
    assert "database is missing" in legitimacy.failure_reason


def test_namespace_runtime_guard_rejects_namespace_without_launch_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(server_runtime, "_DEFAULT_DATABASE_DIRECTORY", tmp_path)
    save_namespace_launch_profile(
        namespace="work",
        port=8001,
        https_port=None,
        mcp_port=None,
    )
    database_path = server_runtime.resolve_namespaced_database_path(namespace="work")
    with closing(sqlite3.connect(database_path)) as connection:
        connection.execute(f"DELETE FROM {NAMESPACE_LAUNCH_PROFILE_TABLE} WHERE namespace = ?", ("work",))
        connection.commit()

    legitimacy = namespace_runtime_guard.inspect_namespace_runtime_legitimacy(namespace="work")

    assert legitimacy.is_legitimate is False
    assert legitimacy.failure_reason == "Namespace work launch profile is missing"


def test_namespace_runtime_guard_terminates_after_failed_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[object] = []
    monkeypatch.setattr(
        namespace_runtime_guard,
        "inspect_namespace_runtime_legitimacy",
        lambda *, namespace: namespace_runtime_guard.NamespaceRuntimeLegitimacy(
            is_legitimate=False,
            failure_reason=f"Namespace {namespace} is gone",
        ),
    )
    monkeypatch.setattr(
        namespace_runtime_guard,
        "_terminate_current_process",
        lambda: events.append("terminate"),
    )

    namespace_runtime_guard._run_namespace_runtime_guard(
        namespace="work",
        check_interval_seconds=5.0,
        sleep=lambda seconds: events.append(("sleep", seconds)),
    )

    assert events == [("sleep", 5.0), "terminate"]
