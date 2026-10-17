from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from contextvars import ContextVar
import os
from pathlib import Path
import sys
from threading import RLock
import traceback
from typing import Iterator, Optional

from app.config import DATABASE_URL, SQL_TRACE_ENABLED
from app.db.live_recovery import recover_pending_change
from app.db.schema import initialize_schema
from app.utils.time_units import MS_PER_SECOND
from loguru import logger

_MEMORY_URI = "file:metalist_memory?mode=memory&cache=shared"
_MODE_BANNER_RULE_WIDTH = 50
_ROLLBACK_STACK_FRAME_LIMIT = 50


def _resolve_db_path(url: str) -> Path:
    if not url.startswith("sqlite:///"):
        raise ValueError(f"Unsupported DATABASE_URL: {url}")
    raw_path = url.replace("sqlite:///", "", 1)
    path = Path(raw_path)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path


def _is_select(statement: str) -> bool:
    snippet = statement.lstrip().lower()
    return snippet.startswith("select")


def _configure_sql_logging(conn: sqlite3.Connection) -> None:
    def tracer(statement: str, _cursor, _time, _data):
        logger.info(
            "sqlite.query",
            extra={
                "sql": statement,
                "duration_ms": _time * MS_PER_SECOND,
            },
        )

    if not SQL_TRACE_ENABLED:
        return
    # Raw trace callback logs *every* statement; keep it DEBUG-only to avoid
    # drowning the logs in polling traffic.
    conn.set_trace_callback(lambda statement: logger.debug("sqlite.raw", extra={"sql": statement}))

class SafeSession:
    _db_path = _resolve_db_path(DATABASE_URL)
    _read_guard_lock = RLock()
    _reads_enabled = True
    _context_reads_allowed: ContextVar[bool] = ContextVar("database_reads_allowed", default=False)
    _schema_lock = RLock()
    _bootstrapped_databases = set()
    _use_memory = False
    _memory_anchor: Optional[sqlite3.Connection] = None

    def __init__(self) -> None:
        self._connection = self._create_connection()
        self._closed = False

    @classmethod
    def _create_connection(cls) -> sqlite3.Connection:
        if cls._use_memory:
            conn = sqlite3.connect(
                _MEMORY_URI,
                uri=True,
                check_same_thread=False,
                isolation_level="DEFERRED",
            )
        else:
            recover_pending_change(cls._db_path)
            cls._db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(
                str(cls._db_path),
                check_same_thread=False,
                isolation_level="DEFERRED",
            )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA secure_delete=ON")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA cache_size=500000")
        with cls._schema_lock:
            if cls._use_memory:
                key = ('memory', id(cls._memory_anchor))
            else:
                stat = cls._db_path.stat()
                key = (str(cls._db_path), stat.st_dev, stat.st_ino)
            if key not in cls._bootstrapped_databases:
                initialize_schema(conn)
                conn.commit()
                cls._bootstrapped_databases.add(key)
        _configure_sql_logging(conn)
        return conn

    @classmethod
    def use_memory_db(cls):
        cls._bootstrapped_databases.clear()
        if cls._memory_anchor:
            cls._memory_anchor.close()
            cls._memory_anchor = None
        cls._use_memory = True
        anchor = sqlite3.connect(
            _MEMORY_URI,
            uri=True,
            check_same_thread=False,
            isolation_level="DEFERRED",
        )
        anchor.row_factory = sqlite3.Row
        anchor.execute("PRAGMA foreign_keys = ON")
        anchor.execute("PRAGMA secure_delete=ON")
        initialize_schema(anchor)
        anchor.commit()
        cls._bootstrapped_databases.add(('memory', id(anchor)))
        _configure_sql_logging(anchor)
        cls._memory_anchor = anchor
        print("\n" + "=" * _MODE_BANNER_RULE_WIDTH)
        print("TEST MODE: IN-MEMORY DATABASE")
        print("All data is temporary")
        print("=" * _MODE_BANNER_RULE_WIDTH + "\n")
        return {"status": "ok", "message": "Using in-memory database"}

    @classmethod
    def use_file_db(cls):
        cls._bootstrapped_databases.clear()
        cls._use_memory = False
        if cls._memory_anchor:
            cls._memory_anchor.close()
            cls._memory_anchor = None
        cls._db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(
            str(cls._db_path),
            check_same_thread=False,
            isolation_level="DEFERRED",
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA secure_delete=ON")
        initialize_schema(conn)
        conn.commit()
        stat = cls._db_path.stat()
        cls._bootstrapped_databases.add((str(cls._db_path), stat.st_dev, stat.st_ino))
        _configure_sql_logging(conn)
        conn.close()
        print("\n" + "=" * _MODE_BANNER_RULE_WIDTH)
        print("PRODUCTION MODE: FILE DATABASE")
        print("=" * _MODE_BANNER_RULE_WIDTH + "\n")
        return {"status": "ok", "message": "Using file database"}

    @classmethod
    def invalidate_schema_bootstrap(cls) -> None:
        with cls._schema_lock:
            cls._bootstrapped_databases.clear()

    @classmethod
    def enable_read_guard(cls) -> None:
        with cls._read_guard_lock:
            cls._reads_enabled = False

    @classmethod
    def disable_read_guard(cls) -> None:
        with cls._read_guard_lock:
            cls._reads_enabled = True

    @classmethod
    def reads_allowed(cls) -> bool:
        if cls._context_reads_allowed.get():
            return True
        return cls._reads_enabled

    @classmethod
    @contextmanager
    def allow_reads(cls, reason: str) -> Iterator[None]:
        token = cls._context_reads_allowed.set(True)
        try:
            yield
        finally:
            cls._context_reads_allowed.reset(token)

    def commit(self) -> None:
        self._connection.commit()

    def rollback(self) -> None:
        self._connection.rollback()
        stack = "".join(traceback.format_stack(limit=_ROLLBACK_STACK_FRAME_LIMIT))
        exc_type, _, _ = sys.exc_info()
        if exc_type is None:
            logger.error(
                "FATAL: DB rollback executed; crashing process",
                extra={"stack": stack},
            )
        else:
            logger.error(
                "FATAL: DB rollback executed; crashing process",
                extra={"stack": stack, "error_type": exc_type.__name__},
            )
        sys.stderr.write("FATAL: DB rollback executed; crashing process\n")
        sys.stderr.flush()
        os._exit(1)

    def execute(self, statement: str, parameters: tuple):
        if not type(self).reads_allowed() and _is_select(statement):
            raise RuntimeError("Post-startup DB read forbidden")
        if len(parameters) == 0:
            return self._connection.execute(statement)
        return self._connection.execute(statement, parameters)

    def connection(self) -> sqlite3.Connection:
        return self._connection

    def close(self) -> None:
        if self._closed:
            return
        self._connection.close()
        self._closed = True


def SessionLocal(*_args, **_kwargs) -> SafeSession:
    """Backwards compatible factory returning a new SafeSession."""

    return SafeSession()


__all__ = ["SafeSession", "SessionLocal"]
