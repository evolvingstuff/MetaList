from __future__ import annotations

from app.config import DEFAULT_TOKEN_EXPIRY_MINUTES
from app.db.session import begin_writer
from app.db.settings_sql import fetch_settings
from app.db.settings_sql import insert_default_settings
from app.db.settings_sql import update_session_timeout_minutes
from app.models.database import SafeSession


MIN_SESSION_TIMEOUT_MINUTES = 0
MAX_SESSION_TIMEOUT_MINUTES = 1_440

_cached_session_timeout_minutes: int | None = None  # shockharness: ignore[STATE001] reason="first filled under token_service's lock at login; later set only by a write request and cleared on its rollback; an int is replaced whole"


def _validate_session_timeout_minutes(*, timeout_minutes: object, source: str) -> int:
    if timeout_minutes is None:
        return DEFAULT_TOKEN_EXPIRY_MINUTES
    if not isinstance(timeout_minutes, int):
        raise RuntimeError(f"session_timeout_minutes from {source} must be an integer")
    if timeout_minutes < MIN_SESSION_TIMEOUT_MINUTES:
        raise RuntimeError(
            f"session_timeout_minutes from {source} must be >= {MIN_SESSION_TIMEOUT_MINUTES}"
        )
    if timeout_minutes > MAX_SESSION_TIMEOUT_MINUTES:
        raise RuntimeError(
            f"session_timeout_minutes from {source} must be <= {MAX_SESSION_TIMEOUT_MINUTES}"
        )
    return timeout_minutes


def get_session_timeout_minutes() -> int:
    global _cached_session_timeout_minutes

    if _cached_session_timeout_minutes is not None:
        return _cached_session_timeout_minutes

    session = SafeSession()
    try:
        with SafeSession.allow_reads("session_timeout:load"):
            settings = fetch_settings(session.connection())
        if settings is None:
            timeout_minutes = DEFAULT_TOKEN_EXPIRY_MINUTES
        else:
            timeout_minutes = _validate_session_timeout_minutes(
                timeout_minutes=settings["session_timeout_minutes"],
                source="app_settings",
            )
    finally:
        session.close()

    _cached_session_timeout_minutes = timeout_minutes
    return timeout_minutes


def save_session_timeout_minutes(*, timeout_minutes: int) -> int:
    normalized_timeout = _validate_session_timeout_minutes(
        timeout_minutes=timeout_minutes,
        source="request",
    )

    with begin_writer() as connection:
        insert_default_settings(connection)
        update_session_timeout_minutes(
            connection,
            session_timeout_minutes=normalized_timeout,
        )

    global _cached_session_timeout_minutes
    _cached_session_timeout_minutes = normalized_timeout
    return normalized_timeout


def reset_session_timeout_cache() -> None:
    global _cached_session_timeout_minutes
    _cached_session_timeout_minutes = None
