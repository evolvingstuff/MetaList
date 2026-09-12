"""Caches whose live references must not survive encrypted namespace logout."""

from functools import wraps
from collections import OrderedDict, namedtuple
from app.services.resource_limits import retained_bytes
from threading import RLock


_lock = RLock()
_enabled = True
_clearers = []


CacheInfo = namedtuple('CacheInfo', 'hits misses maxsize currsize')


def sensitive_lru_cache(*, maxsize: int, max_bytes: int):
    def decorate(function):
        entries = OrderedDict()
        sizes = {}
        used = hits = misses = 0
        def clear():
            nonlocal used, hits, misses
            with _lock:
                entries.clear()
                sizes.clear()
                used = hits = misses = 0
        def info():
            with _lock:
                return CacheInfo(hits, misses, maxsize, len(entries))
        _clearers.append(clear)

        @wraps(function)
        def guarded(*args, **kwargs):
            nonlocal used, hits, misses
            with _lock:
                if not _enabled:
                    return function(*args, **kwargs)
                key = (args, tuple(sorted(kwargs.items())))
                if key in entries:
                    hits += 1
                    entries.move_to_end(key)
                    return entries[key]
                misses += 1
                value = function(*args, **kwargs)
                size = retained_bytes((key, value))
                if size <= max_bytes:
                    entries[key], sizes[key] = value, size
                    used += size
                    while len(entries) > maxsize or used > max_bytes:
                        expired, _ = entries.popitem(last=False)
                        used -= sizes.pop(expired)
                return value

        guarded.cache_clear = clear
        guarded.cache_info = info
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
