"""Canonical DB session and guard helpers.

This module centralizes access to the sqlite connection via SafeSession and
exposes thin helpers used across the app (writers/readers + read guard).
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional

from app.models.database import SafeSession
from app.db.live_recovery import LiveDatabaseRecovery, MemoryDatabaseRecovery


def _is_select(statement: str) -> bool:
    return statement.lstrip().lower().startswith("select")


class GuardedConnection:
    """Lightweight wrapper enforcing the post-startup read guard."""

    __slots__ = ("_connection",)

    def __init__(self, connection) -> None:
        self._connection = connection

    def execute(self, statement: str, *args):
        if not SafeSession.reads_allowed() and _is_select(statement):  # type: ignore[attr-defined]
            raise RuntimeError("Post-startup DB read forbidden")
        if len(args) == 0:
            return self._connection.execute(statement)
        if len(args) != 1:
            raise TypeError(f"execute expects at most 1 parameters tuple, got {len(args)} args")
        parameters = args[0]
        if not isinstance(parameters, tuple):
            raise TypeError(f"execute parameters must be a tuple: {type(parameters)}")
        if len(parameters) == 0:
            return self._connection.execute(statement)
        return self._connection.execute(statement, parameters)

    def executemany(self, statement: str, seq_of_parameters):  # pragma: no cover - thin wrapper
        if not SafeSession.reads_allowed() and _is_select(statement):  # type: ignore[attr-defined]
            raise RuntimeError("Post-startup DB read forbidden")
        return self._connection.executemany(statement, seq_of_parameters)

    def __getattr__(self, item):
        return getattr(self._connection, item)

    @property
    def raw_connection(self):
        return self._connection


@dataclass
class _RequestTransactionState:
    session: Optional[SafeSession]
    guard: Optional[GuardedConnection]
    commit_callbacks: list[Callable[[], None]]
    rollback_callbacks: list[Callable[[], None]]
    recoveries: dict[Path, LiveDatabaseRecovery | MemoryDatabaseRecovery]
    did_write: bool = False


_request_transaction_state: ContextVar[Optional[_RequestTransactionState]] = ContextVar(
    "request_transaction_state",
    default=None,
)


def _ensure_request_transaction_resources(state: _RequestTransactionState) -> tuple[SafeSession, GuardedConnection]:
    session = state.session
    guard = state.guard
    if session is not None and guard is not None:
        return session, guard
    if session is not None or guard is not None:
        raise RuntimeError("Request transaction state must initialize session and guard together")

    session = SafeSession()
    connection = session.connection()
    guard = GuardedConnection(connection)
    state.session = session
    state.guard = guard
    return session, guard


def get_request_session() -> Optional[SafeSession]:
    state = _request_transaction_state.get()
    if state is None:
        return None
    session, _ = _ensure_request_transaction_resources(state)
    return session


def after_request_commit(callback: Callable[[], None]) -> None:
    """Publish memory changes only after successful request persistence."""
    state = _request_transaction_state.get()
    if state is None:
        callback()
        return
    state.commit_callbacks.append(callback)


def enable_read_guard() -> None:
    SafeSession.enable_read_guard()


def disable_read_guard() -> None:
    SafeSession.disable_read_guard()


@contextmanager
def allow_reads(reason: str) -> Iterator[None]:
    with SafeSession.allow_reads(reason):
        yield


def after_request_rollback(callback: Callable[[], None]) -> None:
    state = _request_transaction_state.get()
    if state is not None:
        state.rollback_callbacks.append(callback)


def current_request_state():
    return _request_transaction_state.get()


def _run_rollback_callbacks(callbacks: list[Callable[[], None]]) -> None:
    if not callbacks:
        return
    callback = callbacks.pop()
    try:
        callback()
    finally:
        # Runtime teardown must still run if on-disk recovery itself fails.
        _run_rollback_callbacks(callbacks)


@contextmanager
def recoverable_database_change(database_path: Path):
    state = _request_transaction_state.get()
    if state is None:
        with begin_request_transaction():
            with recoverable_database_change(database_path):
                yield
        return
    key = database_path.resolve()
    if key not in state.recoveries:
        if state.session is not None and state.session.connection().in_transaction:
            raise RuntimeError("Recovery must start before the first database write")
        if SafeSession._use_memory:
            change = MemoryDatabaseRecovery()
        else:
            change = LiveDatabaseRecovery(database_path)
        change.begin()
        state.recoveries[key] = change
        state.rollback_callbacks.append(change.rollback)
    yield


@contextmanager
def begin_request_transaction() -> Iterator[None]:
    if _request_transaction_state.get() is not None:
        raise RuntimeError("Request transaction already active")
    state = _RequestTransactionState(session=None, guard=None, commit_callbacks=[], rollback_callbacks=[], recoveries={})
    token = _request_transaction_state.set(state)
    succeeded = False
    try:
        yield
        if state.session is not None:
            state.session.commit()
        for callback in state.commit_callbacks:
            callback()
        for recovery in state.recoveries.values():
            recovery.commit()
        succeeded = True
    finally:
        try:
            if state.session is not None:
                try:
                    if state.session.connection().total_changes > 0:
                        state.did_write = True
                    if not succeeded:
                        state.session.connection().rollback()
                finally:
                    state.session.close()
        finally:
            _request_transaction_state.reset(token)
            if not succeeded:
                _run_rollback_callbacks(state.rollback_callbacks)


@contextmanager
def begin_writer() -> Iterator[GuardedConnection]:
    request_state = _request_transaction_state.get()
    if request_state is not None:
        request_state.did_write = True
        _, guard = _ensure_request_transaction_resources(request_state)
        yield guard
        return

    session = SafeSession()
    connection = session.connection()
    guard = GuardedConnection(connection)
    succeeded = False
    try:
        yield guard
        session.commit()
        succeeded = True
    finally:
        try:
            if not succeeded:
                connection.rollback()
        finally:
            session.close()


@contextmanager
def connect_reader(reason: Optional[str]) -> Iterator[GuardedConnection]:
    if reason is None:
        read_reason = "reader"
    else:
        read_reason = reason

    request_state = _request_transaction_state.get()
    if request_state is not None:
        with SafeSession.allow_reads(read_reason):
            _, guard = _ensure_request_transaction_resources(request_state)
            yield guard
        return

    with SafeSession.allow_reads(read_reason):
        session = SafeSession()
        connection = session.connection()
        guard = GuardedConnection(connection)
        try:
            yield guard
        finally:
            session.close()
