from __future__ import annotations

from typing import Dict, Optional, Tuple

from app.services.view_state import ViewState


class ViewCache:
    """In-memory cache mapping each client tab/view context to its last rendered state."""

    def __init__(self) -> None:
        self._cache: Dict[Tuple[str, str, str, str, bool], ViewState] = {}

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
        return self._cache.get(
            self._key(client_id, tab_id, search, sort_mode, is_untagged_view)
        )

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
        self._cache[
            self._key(client_id, tab_id, search, sort_mode, is_untagged_view)
        ] = state

    def clear(self) -> None:
        self._cache.clear()


view_cache = ViewCache()
