"""Canonical DB session and guard helpers.

This module centralizes access to the sqlite connection via SafeSession and
exposes thin helpers used across the app (writers/readers + read guard).
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import sys
from typing import Callable, Iterator, Optional

from app.models.database import SafeSession


def _is_select(statement: str) -> bool:
    return statement.lstrip().lower().startswith("select")


class GuardedConnection:
    """Lightweight wrapper enforcing the post-startup read guard."""

    __slots__ = ("_connection",)

    def __init__(self, connection) -> None:
        self._connection = connection

    def execute(self, statement: str, *args):
        if not SafeSession._reads_enabled and _is_select(statement):  # type: ignore[attr-defined]
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
        if not SafeSession._reads_enabled and _is_select(statement):  # type: ignore[attr-defined]
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


@contextmanager
def begin_request_transaction() -> Iterator[None]:
    existing_state = _request_transaction_state.get()
    if existing_state is not None:
        raise RuntimeError("Request transaction already active")

    state = _RequestTransactionState(session=None, guard=None, commit_callbacks=[])
    token = _request_transaction_state.set(state)
    try:
        yield
    finally:
        exc_type, _, _ = sys.exc_info()
        try:
            if state.session is not None:
                if exc_type is None:
                    state.session.commit()
                else:
                    state.session.connection().rollback()
            if exc_type is None:
                for callback in state.commit_callbacks:
                    callback()
        finally:
            try:
                if state.session is not None:
                    state.session.close()
            finally:
                _request_transaction_state.reset(token)


@contextmanager
def begin_writer() -> Iterator[GuardedConnection]:
    request_state = _request_transaction_state.get()
    if request_state is not None:
        _, guard = _ensure_request_transaction_resources(request_state)
        yield guard
        return

    session = SafeSession()
    connection = session.connection()
    guard = GuardedConnection(connection)
    try:
        yield guard
    finally:
        exc_type, _, _ = sys.exc_info()
        if exc_type is None:
            session.commit()
        else:
            session.rollback()
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
