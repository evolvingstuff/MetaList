from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3
import sys
import traceback

from app.db.schema import NAMESPACE_LAUNCH_PROFILE_TABLE
from app.server_runtime import resolve_namespace_directory
from app.server_runtime import validate_namespace
from app.services.exception_capture import CapturedExceptionContext
from app.services.namespace_deletion_worker import _stop_process
from app.services.namespace_rename_jobs import mark_namespace_rename_job_failed
from app.services.namespace_rename_jobs import mark_namespace_rename_job_succeeded
from app.services.namespace_switcher import open_or_launch_namespace


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rename a namespace after its server process exits")
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--source-namespace", required=True)
    parser.add_argument("--target-namespace", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--https-port", type=int, required=True)
    return parser.parse_args()


def _database_rename_pairs(
    *,
    directory: Path,
    source_namespace: str,
    target_namespace: str,
) -> list[tuple[Path, Path]]:
    source_stem = f"{source_namespace}.metalist"
    target_stem = f"{target_namespace}.metalist"
    suffixes = (
        ".db",
        ".db-wal",
        ".db-shm",
        ".files.db",
        ".files.db-wal",
        ".files.db-shm",
    )
    return [
        (directory / f"{source_stem}{suffix}", directory / f"{target_stem}{suffix}")
        for suffix in suffixes
    ]


def _rewrite_launch_profile_namespace(
    *,
    database_path: Path,
    source_namespace: str,
    target_namespace: str,
) -> None:
    connection = sqlite3.connect(str(database_path), check_same_thread=False)
    try:
        source_row = connection.execute(
            f"SELECT namespace FROM {NAMESPACE_LAUNCH_PROFILE_TABLE} WHERE namespace = ?",
            (source_namespace,),
        ).fetchone()
        if source_row is None:
            raise RuntimeError(f"Namespace {source_namespace} launch profile is missing")
        target_row = connection.execute(
            f"SELECT namespace FROM {NAMESPACE_LAUNCH_PROFILE_TABLE} WHERE namespace = ?",
            (target_namespace,),
        ).fetchone()
        if target_row is not None:
            raise RuntimeError(f"Namespace {target_namespace} launch profile already exists")
        connection.execute(
            f"""
            UPDATE {NAMESPACE_LAUNCH_PROFILE_TABLE}
            SET namespace = ?, updated_at = ?
            WHERE namespace = ?
            """,
            (target_namespace, datetime.now(timezone.utc).isoformat(), source_namespace),
        )
        connection.commit()
    finally:
        connection.close()


def _rename_namespace_storage(*, source_namespace: str, target_namespace: str) -> None:
    normalized_source = validate_namespace(namespace=source_namespace)
    normalized_target = validate_namespace(namespace=target_namespace)
    if normalized_source == normalized_target:
        raise RuntimeError("New namespace name must differ from the current name")
    source_directory = resolve_namespace_directory(namespace=normalized_source)
    target_directory = resolve_namespace_directory(namespace=normalized_target)
    if not source_directory.is_dir():
        raise RuntimeError(f"Namespace {normalized_source} is unavailable")
    if target_directory.exists():
        raise RuntimeError(f"Namespace {normalized_target} already exists")

    source_database = source_directory / f"{normalized_source}.metalist.db"
    if not source_database.is_file():
        raise RuntimeError(f"Namespace database is missing: {source_database}")
    source_directory.rename(target_directory)

    for source_path, target_path in _database_rename_pairs(
        directory=target_directory,
        source_namespace=normalized_source,
        target_namespace=normalized_target,
    ):
        if not source_path.exists():
            continue
        if target_path.exists():
            raise RuntimeError(f"Rename target already exists: {target_path}")
        source_path.rename(target_path)

    target_database = target_directory / f"{normalized_target}.metalist.db"
    if not target_database.is_file():
        raise RuntimeError(f"Renamed namespace database is missing: {target_database}")
    _rewrite_launch_profile_namespace(
        database_path=target_database,
        source_namespace=normalized_source,
        target_namespace=normalized_target,
    )


def _launch_renamed_namespace(*, args: argparse.Namespace) -> None:
    https_port = args.https_port
    if https_port == 0:
        https_port = None
    open_or_launch_namespace(
        environ=os.environ,
        current_namespace=None,
        namespace=args.target_namespace,
        port=args.port,
        https_port=https_port,
    )


def main() -> None:
    args = _parse_args()
    main_capture = CapturedExceptionContext(Exception, boundary='app/services/namespace_rename_worker.py:main:main_capture')
    with main_capture:
        _stop_process(pid=args.pid)
        _rename_namespace_storage(
            source_namespace=args.source_namespace,
            target_namespace=args.target_namespace,
        )
        _launch_renamed_namespace(args=args)
        mark_namespace_rename_job_succeeded(job_id=args.job_id)
    if main_capture.captured_exception is not None:
        mark_namespace_rename_job_failed(
            job_id=args.job_id,
            error=traceback.format_exc(),
        )
        raise main_capture.captured_exception


if __name__ == "__main__":
    main()
