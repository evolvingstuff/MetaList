from __future__ import annotations

from dataclasses import dataclass
from threading import RLock
from typing import Dict, List, Optional, Tuple

from app.services.view_state import ViewState


@dataclass(frozen=True)
class WarmView:
    """What one browser tab currently displays: the last view the server sent it.

    Holds only what diffing needs (hierarchy, per-note hashes, locks), never
    rendered note HTML, so a large window stays small.
    """

    children_by_parent: Dict[Optional[str], List[str]]
    hash_by_id: Dict[str, str]
    locks: Dict[str, str]

    @classmethod
    def from_view_state(cls, state: ViewState) -> "WarmView":
        return cls(
            children_by_parent=state.children_by_parent,
            hash_by_id=state.hash_by_id,
            locks=state.locks,
        )


class ViewCache:
    """Warm view per (client, tab), kept for the tab's lifetime.

    Every notes.view response is diffed against the tab's warm view and then
    becomes the new one, so the browser never sends its state. Entries are
    removed only when their tab is deleted or the session ends (login,
    passwordless claim, logout, lock, restore); a tab with no warm view gets
    its initial window (structure plus every windowed note).
    """

    def __init__(self) -> None:
        self._views: Dict[Tuple[str, str], WarmView] = {}
        self._lock = RLock()

    @staticmethod
    def _key(client_id: str, tab_id: str) -> Tuple[str, str]:
        if not isinstance(client_id, str) or client_id == "":
            raise TypeError("client_id must be a non-empty string")
        if not isinstance(tab_id, str) or tab_id == "":
            raise TypeError("tab_id must be a non-empty string")
        return client_id, tab_id

    def get(self, *, client_id: str, tab_id: str) -> WarmView | None:
        key = self._key(client_id, tab_id)
        with self._lock:
            if key not in self._views:  # shockharness: ignore[DEF002] reason="a tab with no warm view yet has none"
                return None
            return self._views[key]

    def set(self, *, client_id: str, tab_id: str, state: ViewState) -> None:
        key = self._key(client_id, tab_id)
        warm_view = WarmView.from_view_state(state)
        with self._lock:
            self._views[key] = warm_view

    def copy_tab(self, *, client_id: str, source_tab_id: str, target_tab_id: str) -> None:
        """Seed a duplicated tab, whose DOM is cloned from the source tab."""
        source_key = self._key(client_id, source_tab_id)
        target_key = self._key(client_id, target_tab_id)
        with self._lock:
            if source_key in self._views:
                self._views[target_key] = self._views[source_key]

    def discard_tab(self, tab_id: str) -> None:
        with self._lock:
            for key in tuple(self._views):
                if key[1] == tab_id:
                    del self._views[key]

    def capture(self) -> Dict[Tuple[str, str], WarmView]:
        # WarmView entries are immutable; a shallow copy is an exact snapshot.
        with self._lock:
            return dict(self._views)

    def restore(self, snapshot: Dict[Tuple[str, str], WarmView]) -> None:
        with self._lock:
            self._views.clear()
            self._views.update(snapshot)

    def diagnostics(self) -> dict:
        with self._lock:
            return dict(entries=len(self._views), notes=sum(len(view.hash_by_id) for view in self._views.values()))

    def clear(self) -> None:
        with self._lock:
            self._views.clear()


view_cache = ViewCache()
