from __future__ import annotations

from collections import OrderedDict
from threading import RLock
from time import monotonic
from app.services.resource_limits import VIEW_BYTES, CLIENT_ENTRIES, CLIENT_IDLE_SECONDS, retained_bytes

from typing import Dict, Optional, Tuple

from app.services.view_state import ViewState


class ViewCache:
    """In-memory cache mapping each client tab/view context to its last rendered state."""

    def __init__(self) -> None:
        self._cache = OrderedDict()
        self._sizes = {}
        self._used = {}
        self._lock = RLock()
        self._hits = self._misses = self._evictions = 0

    @staticmethod
    def _normalize(value: Optional[str]) -> str:
        if value is None:
            return ''
        return value

    def _key(
        self,
        client_id: str,
        tab_id: Optional[str],
        search: Optional[str],
        sort_mode: str,
        is_untagged_view: bool,
    ) -> Tuple[str, str, str, str, bool]:
        normalized_tab = tab_id
        if normalized_tab is None:
            normalized_tab = '0'
        normalized_search = self._normalize(search)
        return (
            client_id,
            normalized_tab,
            normalized_search,
            sort_mode,
            is_untagged_view,
        )

    def get(
        self,
        *,
        client_id: str,
        tab_id: Optional[str],
        search: Optional[str],
        sort_mode: str,
        is_untagged_view: bool,
    ) -> Optional[ViewState]:
        key = self._key(client_id, tab_id, search, sort_mode, is_untagged_view)
        with self._lock:
            self._prune()
            if key not in self._cache:
                self._misses += 1
                return None
            self._hits += 1
            self._cache.move_to_end(key)
            self._used[key] = monotonic()
            return self._cache[key]

    def set(
        self,
        *,
        client_id: str,
        tab_id: Optional[str],
        search: Optional[str],
        sort_mode: str,
        is_untagged_view: bool,
        state: ViewState,
    ) -> None:
        key = self._key(client_id, tab_id, search, sort_mode, is_untagged_view)
        size = retained_bytes((key, state))
        with self._lock:
            for old in tuple(self._cache):
                if old[:2] == key[:2]:
                    self._discard(old)
            if size > VIEW_BYTES:
                return  # A missing baseline uses the existing full-snapshot protocol.
            self._cache[key] = state
            self._sizes[key] = size
            self._used[key] = monotonic()
            self._prune()

    def _discard(self, key):
        del self._cache[key], self._sizes[key], self._used[key]
        self._evictions += 1

    def _prune(self):
        now = monotonic()
        for key in tuple(self._cache):
            if now - self._used[key] >= CLIENT_IDLE_SECONDS:
                self._discard(key)
        while len(self._cache) > CLIENT_ENTRIES or sum(self._sizes.values()) > VIEW_BYTES:
            self._discard(next(iter(self._cache)))

    def discard_tab(self, tab_id: str) -> None:
        with self._lock:
            for key in tuple(self._cache):
                if key[1] == tab_id:
                    self._discard(key)

    def diagnostics(self) -> dict:
        with self._lock:
            self._prune()
            return dict(entries=len(self._cache), bytes=sum(self._sizes.values()), hits=self._hits, misses=self._misses, evictions=self._evictions)

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()
            self._sizes.clear()
            self._used.clear()


view_cache = ViewCache()
