"""Caches whose live references must not survive encrypted namespace logout."""

from functools import lru_cache, wraps
from threading import RLock


_lock = RLock()
_enabled = True
_clearers = []


def sensitive_lru_cache(*, maxsize: int):
    def decorate(function):
        cached = lru_cache(maxsize=maxsize)(function)
        _clearers.append(cached.cache_clear)

        @wraps(function)
        def guarded(*args, **kwargs):
            # Lock through calculation: a late calculation cannot refill a purged cache.
            with _lock:
                if _enabled:
                    return cached(*args, **kwargs)
                return function(*args, **kwargs)

        guarded.cache_clear = cached.cache_clear
        guarded.cache_info = cached.cache_info
        return guarded
    return decorate


def disable_and_clear_sensitive_caches() -> None:
    global _enabled
    with _lock:
        _enabled = False
        for clear in _clearers:
            clear()


def enable_sensitive_caches() -> None:
    global _enabled
    with _lock:
        _enabled = True


def clear_sensitive_caches() -> None:
    with _lock:
        for clear in _clearers:
            clear()
