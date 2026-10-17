"""In-memory flag tracking whether the cache was hydrated post-login.

This lets the /auth/login endpoint avoid re-reading sqlite every time a user
logs in. The app starts with the flag cleared. Once the cache has been
refreshed using a real DEK, we mark it so future logins can skip the expensive
populate step. If we ever need to force a refresh (password reset, etc.), call
``reset_cache_state``.
"""

from __future__ import annotations

from threading import Lock

_cache_ready = False  # shockharness: ignore[STATE001] reason="every access holds _cache_lock"
_cache_lock = Lock()


def cache_refresh_needed() -> bool:
    with _cache_lock:
        return not _cache_ready


def mark_cache_ready() -> None:
    global _cache_ready
    with _cache_lock:
        _cache_ready = True


def reset_cache_state() -> None:
    global _cache_ready
    with _cache_lock:
        _cache_ready = False
