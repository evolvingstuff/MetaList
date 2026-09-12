from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
import os
from pathlib import Path
import sys
from threading import RLock
import traceback
from typing import Iterator, Optional

from app.config import DATABASE_URL, SQL_TRACE_ENABLED
from app.db.live_recovery import recover_pending_change
from app.db.schema import initialize_schema
from loguru import logger

_MEMORY_URI = "file:metalist_memory?mode=memory&cache=shared"


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
                "duration_ms": _time * 1000,
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
        initialize_schema(conn)
        conn.commit()
        _configure_sql_logging(conn)
        return conn

    @classmethod
    def use_memory_db(cls):
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
        _configure_sql_logging(anchor)
        cls._memory_anchor = anchor
        print("\n" + "=" * 50)
        print(
            """
🧪 SWITCHING TO TEST MODE 🧪
┌──────────────────────────┐
│   IN-MEMORY DATABASE     │
│  *All Data is Temporary  │
└──────────────────────────┘
        """
        )
        print("=" * 50 + "\n")
        return {"status": "ok", "message": "Using in-memory database"}

    @classmethod
    def use_file_db(cls):
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
        _configure_sql_logging(conn)
        conn.close()
        print("\n" + "=" * 50)
        print(
            """
📝 RETURNING TO PRODUCTION MODE 📝
┌──────────────────────────┐
│      PROD DATABASE       │
│                          │
└──────────────────────────┘
        """
        )
        print("=" * 50 + "\n")
        return {"status": "ok", "message": "Using file database"}

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
        stack = "".join(traceback.format_stack(limit=50))
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


@dataclass
class DBNote:
    id: str
    content: str
    parent_id: Optional[str] = None
    prev_id: Optional[str] = None
    next_id: Optional[str] = None
    is_collapsed: bool = False
    encryption_nonce: Optional[bytes] = None
    encryption_tag: Optional[bytes] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass
class AppSettings:
    id: int = 1
    auth_verifier: Optional[str] = None
    auth_salt: Optional[bytes] = None
    auth_iterations: Optional[int] = None
    kek_salt: Optional[bytes] = None
    kek_iterations: Optional[int] = None
    vault_version: Optional[int] = None
    kdf_algorithm: Optional[str] = None
    kdf_memory_cost_kib: Optional[int] = None
    kdf_parallelism: Optional[int] = None
    encryption_enabled: bool = False
    encryption_algorithm: Optional[str] = None
    encrypted_dek: Optional[bytes] = None
    dek_nonce: Optional[bytes] = None
    dek_tag: Optional[bytes] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


__all__ = ["SafeSession", "SessionLocal", "DBNote", "AppSettings"]
