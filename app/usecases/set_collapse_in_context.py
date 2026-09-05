from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, List, Optional, Set

from app.services.note_store import store as note_store
from app.services.search_index import search_index
from app.services.search_query import SearchClause, parse_search_query
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.undo_state import reset_undo_stack
from app.usecases.base import QueryCommand
from app.usecases.collapse import apply_set_collapse_bulk


def _include_ancestors(note_ids: Set[str], *, starting_ids: Set[str]) -> None:
    to_visit = list(starting_ids)
    while to_visit:
        current_id = to_visit.pop()
        if not note_store.has_note(current_id):
            continue
        parent_id = note_store.get_note(current_id).parent_id
        if parent_id is None:
            continue
        if parent_id in note_ids:
            continue
        note_ids.add(parent_id)
        to_visit.append(parent_id)


def _include_descendants(note_ids: Set[str], *, starting_ids: Set[str]) -> None:
    to_visit = list(starting_ids)
    while to_visit:
        current_id = to_visit.pop()
        if not note_store.has_note(current_id):
            continue
        for child_id in note_store.get_children(current_id):
            if child_id in note_ids:
                continue
            note_ids.add(child_id)
            to_visit.append(child_id)


def _collect_context_root_ids(search_query: Optional[str]) -> List[str]:
    ordered_root_ids = note_store.get_children(None)

    if search_query is None:
        return list(ordered_root_ids)

    if not isinstance(search_query, str):
        raise TypeError("search_query must be a string or null")

    parsed = parse_search_query(search_query)
    has_terms = any(
        clause.required_tags
        or clause.forbidden_tags
        or clause.required_text
        or clause.forbidden_text
        for clause in parsed.clauses
    )

    if not has_terms:
        return list(ordered_root_ids)

    allowed_note_ids: Set[str] = set()
    for clause in parsed.clauses:
        clause_matched_note_ids = set(search_index.query_clause_note_ids(clause))
        clause_allowed_note_ids = set(clause_matched_note_ids)

        _include_ancestors(clause_allowed_note_ids, starting_ids=set(clause_matched_note_ids))
        _include_descendants(clause_allowed_note_ids, starting_ids=set(clause_matched_note_ids))

        excluded_note_ids: Set[str] = set()
        for tag in clause.forbidden_tags:
            excluded_note_ids.update(
                search_index.query_clause_note_ids(
                    SearchClause(
                        required_tags=frozenset({tag}),
                        forbidden_tags=frozenset(),
                        required_text=(),
                        forbidden_text=(),
                    )
                )
            )
        for phrase in clause.forbidden_text:
            excluded_note_ids.update(
                search_index.query_clause_note_ids(
                    SearchClause(
                        required_tags=frozenset(),
                        forbidden_tags=frozenset(),
                        required_text=(phrase,),
                        forbidden_text=(),
                    )
                )
            )
        clause_allowed_note_ids.difference_update(excluded_note_ids)
        allowed_note_ids.update(clause_allowed_note_ids)

    return [root_id for root_id in ordered_root_ids if root_id in allowed_note_ids]


def collect_subtree_note_ids(root_ids: List[str]) -> List[str]:
    note_ids: List[str] = []
    seen_note_ids: Set[str] = set()
    to_visit = list(reversed(root_ids))
    while to_visit:
        note_id = to_visit.pop()
        if note_id in seen_note_ids:
            raise RuntimeError(f"Cycle or duplicate detected in note hierarchy: {note_id}")
        if not note_store.has_note(note_id):
            raise RuntimeError(f"Collapse subtree contains missing note: {note_id}")
        seen_note_ids.add(note_id)
        note_ids.append(note_id)
        to_visit.extend(reversed(note_store.get_children(note_id)))
    return note_ids


def _set_collapse_state(
    *,
    note_ids: List[str],
    collapsed: bool,
    client_id: str,
    undo_context: str,
) -> int:
    reset_undo_stack(client_id, undo_context)
    note_ids_to_update: List[str] = []
    for note_id in note_ids:
        before = bool(store.get(note_id).is_collapsed)
        if before is bool(collapsed):
            continue
        note_ids_to_update.append(note_id)

    if note_ids_to_update:
        apply_set_collapse_bulk(note_ids_to_update, bool(collapsed))

    for note_id in note_ids_to_update:
        after = bool(store.get(note_id).is_collapsed)
        if after is not bool(collapsed):
            print(f"FATAL: context collapse failed for {note_id}")
            os._exit(1)
    return len(note_ids_to_update)


@dataclass
class CmdSetCollapseInContext(QueryCommand):
    search_query: Optional[str]
    collapsed: bool
    recursive: bool
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        normalized = ""
        if self.search_query is not None:
            normalized = self.search_query
        return (
            f"CmdSetCollapseInContext(search={normalized!r}, "
            f"collapsed={self.collapsed}, recursive={self.recursive}, "
            f"client={self.client_id})"
        )

    def execute(self) -> Dict[str, object]:
        root_ids = _collect_context_root_ids(self.search_query)
        note_ids = list(root_ids)
        if self.recursive:
            note_ids = collect_subtree_note_ids(root_ids)
        updated_count = _set_collapse_state(
            note_ids=note_ids,
            collapsed=self.collapsed,
            client_id=self.client_id,
            undo_context=self.undo_context,
        )

        status = "unchanged"
        if updated_count > 0:
            status = "updated"

        return {
            "status": status,
            "updatedCount": updated_count,
            "totalCount": len(note_ids),
            "updateUUID": generate_new_uuid(),
        }


@dataclass
class CmdSetCollapseSubtree(QueryCommand):
    note_id: str
    collapsed: bool
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return (
            f"CmdSetCollapseSubtree(note={self.note_id}, "
            f"collapsed={self.collapsed}, client={self.client_id})"
        )

    def execute(self) -> Dict[str, object]:
        note_ids = collect_subtree_note_ids([self.note_id])
        updated_count = _set_collapse_state(
            note_ids=note_ids,
            collapsed=self.collapsed,
            client_id=self.client_id,
            undo_context=self.undo_context,
        )
        return {
            "status": "updated" if updated_count > 0 else "unchanged",
            "updatedCount": updated_count,
            "totalCount": len(note_ids),
            "updateUUID": generate_new_uuid(),
        }
