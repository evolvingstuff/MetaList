"""Caches whose live references must not survive encrypted namespace logout."""

from functools import wraps
from collections import OrderedDict, namedtuple
from app.services.resource_limits import retained_bytes
from threading import RLock


_lock = RLock()
_enabled = True  # shockharness: ignore[STATE001] reason="every access holds the module _lock"
_clearers = []  # shockharness: ignore[STATE001] reason="appended and iterated only under the module _lock"


CacheInfo = namedtuple('CacheInfo', 'hits misses maxsize currsize')


class SensitiveMemo:
    """Bounded LRU whose entries are purged with every other sensitive cache.

    Nothing is stored while sensitive caches are disabled (locked namespace).
    Callers own validity: lookup() returns a stored value, and store()
    replaces it, so entries can be checked against current state before use.
    """

    def __init__(self, *, maxsize: int, max_bytes: int) -> None:
        if maxsize <= 0 or max_bytes <= 0:
            raise ValueError("maxsize and max_bytes must be positive")
        self._maxsize = maxsize
        self._max_bytes = max_bytes
        self._entries: OrderedDict = OrderedDict()
        self._sizes: dict = {}
        self._used = 0
        self._hits = 0
        self._misses = 0
        with _lock:
            _clearers.append(self.clear)

    def clear(self) -> None:
        with _lock:
            self._entries.clear()
            self._sizes.clear()
            self._used = self._hits = self._misses = 0

    def info(self) -> CacheInfo:
        with _lock:
            return CacheInfo(self._hits, self._misses, self._maxsize, len(self._entries))

    def lookup(self, key: object) -> tuple:
        """Return (True, value) for a stored key, else (False, None)."""
        with _lock:
            if _enabled and key in self._entries:
                self._hits += 1
                self._entries.move_to_end(key)
                return True, self._entries[key]
            if _enabled:
                self._misses += 1
            return False, None

    def store(self, key: object, value: object) -> None:
        with _lock:
            if not _enabled:
                return
            if key in self._entries:
                del self._entries[key]
                self._used -= self._sizes.pop(key)
            size = retained_bytes((key, value))
            if size > self._max_bytes:
                return
            self._entries[key], self._sizes[key] = value, size
            self._used += size
            while len(self._entries) > self._maxsize or self._used > self._max_bytes:
                expired, _ = self._entries.popitem(last=False)
                self._used -= self._sizes.pop(expired)


def sensitive_lru_cache(*, maxsize: int, max_bytes: int):
    def decorate(function):
        memo = SensitiveMemo(maxsize=maxsize, max_bytes=max_bytes)

        @wraps(function)
        def guarded(*args, **kwargs):
            with _lock:
                if not _enabled:
                    return function(*args, **kwargs)
                key = (args, tuple(sorted(kwargs.items())))
                found, value = memo.lookup(key)
                if found:
                    return value
                value = function(*args, **kwargs)
                memo.store(key, value)
                return value

        guarded.cache_clear = memo.clear
        guarded.cache_info = memo.info
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
