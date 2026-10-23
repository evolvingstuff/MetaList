from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Dict, List, Optional

from app.db.notes_sql import reset_updated_at_to_created_at as db_reset_updated_at_to_created_at
from app.db.session import begin_writer
from app.services.snapshot import resolve_search_scope
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.undo_state import reset_undo_stack
from app.usecases.base import QueryCommand


def _normalize_search_query(search_query: Optional[str]) -> Optional[str]:
    if search_query is None:
        return None
    if not isinstance(search_query, str):
        raise TypeError(f"search_query must be a string or None, got {type(search_query)}")
    if search_query.strip() == "":
        return None
    return search_query


def _resolve_context_root_ids(search_query: Optional[str]) -> List[str]:
    normalized_search = _normalize_search_query(search_query)
    if normalized_search is None:
        return store.children(None)

    search_scope = resolve_search_scope(
        search=normalized_search,
        editing_note_id=None,
        sort_mode="normal",
        date_filter=None,
        ordered_root_ids=store.children(None),
    )
    if not search_scope.search_active:
        return store.children(None)
    if search_scope.search_root_ids_ordered is None:
        return []
    return list(search_scope.search_root_ids_ordered)


def _collect_subtree_note_ids(root_ids: List[str]) -> List[str]:
    if not isinstance(root_ids, list):
        raise TypeError("root_ids must be a list")
    ordered_note_ids: List[str] = []
    seen: set[str] = set()
    stack = list(reversed(root_ids))
    while stack:
        note_id = stack.pop()
        if note_id in seen:
            raise RuntimeError(f"Cycle detected while collecting timestamp repair subtree: {note_id}")
        seen.add(note_id)
        ordered_note_ids.append(note_id)
        children = store.children(note_id)
        stack.extend(reversed(children))
    return ordered_note_ids


@dataclass
class CmdResetUpdatedAtToCreatedAt(QueryCommand):
    search_query: Optional[str]
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, object]:
        root_ids = _resolve_context_root_ids(self.search_query)
        if len(root_ids) == 0:
            return {
                "status": "noop",
                "reason": "no_roots",
                "rootCount": 0,
                "noteCount": 0,
                "changedNoteCount": 0,
            }

        note_ids = _collect_subtree_note_ids(root_ids)
        changed_updates: List[SimpleNamespace] = []
        for note_id in note_ids:
            record = store.get(note_id)
            if record.created_at is None:
                raise RuntimeError(f"Note is missing created_at: {note_id}")
            if record.updated_at is None:
                raise RuntimeError(f"Note is missing updated_at: {note_id}")
            if record.updated_at == record.created_at:
                continue
            changed_updates.append(
                SimpleNamespace(
                    id=note_id,
                    updated_at=record.created_at,
                )
            )

        if len(changed_updates) == 0:
            return {
                "status": "noop",
                "reason": "already_reset",
                "rootCount": len(root_ids),
                "noteCount": len(note_ids),
                "changedNoteCount": 0,
            }

        changed_ids = [update.id for update in changed_updates]
        with begin_writer() as connection:
            changed_count = db_reset_updated_at_to_created_at(connection, changed_ids)

        if changed_count != len(changed_updates):
            raise RuntimeError(
                "Reset updated timestamps changed an unexpected number of rows: "
                f"expected={len(changed_updates)} actual={changed_count}"
            )

        store.set_updated_ats({update.id: update.updated_at for update in changed_updates})
        reset_undo_stack(self.client_id, self.undo_context)

        return {
            "status": "updated",
            "rootCount": len(root_ids),
            "noteCount": len(note_ids),
            "changedNoteCount": changed_count,
            "updateUUID": generate_new_uuid(),
        }
