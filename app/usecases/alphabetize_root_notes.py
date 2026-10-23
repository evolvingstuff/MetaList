from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional

from app.services.snapshot import resolve_search_scope
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.undo_state import reset_undo_stack
from app.usecases.base import QueryCommand
from app.usecases.move import _assert_neighbors, _neighbors, apply_move
from app.utils.text_utils import strip_html

_MIN_ROOTS_TO_ALPHABETIZE = 2


def _normalize_direction(direction: str) -> str:
    if not isinstance(direction, str):
        raise TypeError(f"direction must be a string, got {type(direction)}")
    normalized = direction.strip().lower()
    if normalized not in {"asc", "desc"}:
        raise ValueError("direction must be 'asc' or 'desc'")
    return normalized


def _resolve_visible_root_ids(search_query: Optional[str]) -> List[str]:
    if search_query is not None and not isinstance(search_query, str):
        raise TypeError(f"search_query must be a string or None, got {type(search_query)}")

    normalized_search = search_query
    if isinstance(normalized_search, str) and normalized_search.strip() == "":
        normalized_search = None

    if normalized_search is None:
        return store.children(None)

    search_scope = resolve_search_scope(
        search=normalized_search,
        editing_note_id=None,
        sort_mode="normal",
        date_filter=None,
        ordered_root_ids=None,
    )
    if not search_scope.search_active or search_scope.search_root_ids_ordered is None:
        return store.children(None)
    return list(search_scope.search_root_ids_ordered)


def _build_target_root_ids(
    *,
    ordered_root_ids: List[str],
    visible_root_ids: List[str],
    desired_visible_root_ids: List[str],
) -> List[str]:
    visible_root_id_set = set(visible_root_ids)
    if len(visible_root_id_set) != len(visible_root_ids):
        raise RuntimeError("Visible root ids must be unique")

    desired_visible_root_id_set = set(desired_visible_root_ids)
    if desired_visible_root_id_set != visible_root_id_set:
        raise RuntimeError("Desired visible root ids must match visible root ids")

    desired_index = 0
    target_root_ids: List[str] = []
    for root_id in ordered_root_ids:
        if root_id in visible_root_id_set:
            if desired_index >= len(desired_visible_root_ids):
                raise RuntimeError("Desired visible root ids exhausted during root order reconstruction")
            target_root_ids.append(desired_visible_root_ids[desired_index])
            desired_index += 1
        else:
            target_root_ids.append(root_id)

    if desired_index != len(desired_visible_root_ids):
        raise RuntimeError("Desired visible root ids overflowed root order reconstruction")
    return target_root_ids


def _content_sort_key(note_id: str) -> tuple[str, str]:
    record = store.get(note_id)
    if not isinstance(record.content, str):
        raise RuntimeError(f"Note content must be a string | note_id={note_id}")
    text_content = strip_html(record.content).strip()
    return text_content.casefold(), text_content


@dataclass
class CmdAlphabetizeRootNotes(QueryCommand):
    direction: str
    search_query: Optional[str]
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, object]:
        normalized_direction = _normalize_direction(self.direction)

        ordered_root_ids = store.children(None)
        visible_root_ids = _resolve_visible_root_ids(self.search_query)

        if len(visible_root_ids) < _MIN_ROOTS_TO_ALPHABETIZE:
            return {
                "status": "noop",
                "reason": "not_enough_roots",
                "visibleRootCount": len(visible_root_ids),
            }

        desired_visible_root_ids = sorted(
            visible_root_ids,
            key=_content_sort_key,
            reverse=normalized_direction == "desc",
        )
        target_root_ids = _build_target_root_ids(
            ordered_root_ids=ordered_root_ids,
            visible_root_ids=visible_root_ids,
            desired_visible_root_ids=desired_visible_root_ids,
        )
        if target_root_ids == ordered_root_ids:
            return {
                "status": "noop",
                "reason": "already_alphabetized",
                "visibleRootCount": len(visible_root_ids),
            }

        simulated_root_ids = list(ordered_root_ids)
        move_ops: List[Dict[str, object]] = []

        for target_index, note_id in enumerate(target_root_ids):
            current_index = simulated_root_ids.index(note_id)
            if current_index == target_index:
                continue

            before_parent, before_prev, before_next = _neighbors(note_id)
            if before_parent is not None:
                raise RuntimeError(
                    "Alphabetize only supports root notes in v1: "
                    f"note_id={note_id} parent_id={before_parent}"
                )

            record = store.get(note_id)
            if not isinstance(record.tags, str):
                raise RuntimeError(f"Note tags must be a string | note_id={note_id}")
            tags = record.tags

            simulated_without = simulated_root_ids[:current_index] + simulated_root_ids[current_index + 1:]
            if target_index == 0:
                dest_prev = None
            else:
                dest_prev = simulated_without[target_index - 1]
            if target_index >= len(simulated_without):
                dest_next = None
            else:
                dest_next = simulated_without[target_index]

            apply_move(note_id, None, dest_prev, dest_next)
            _assert_neighbors(note_id, None, dest_prev, dest_next)

            move_ops.append(
                {
                    "note_id": note_id,
                    "before_parent": before_parent,
                    "before_prev": before_prev,
                    "before_next": before_next,
                    "before_tags": tags,
                    "after_parent": None,
                    "after_prev": dest_prev,
                    "after_next": dest_next,
                    "after_tags": tags,
                }
            )

            simulated_root_ids = list(simulated_without)
            simulated_root_ids.insert(target_index, note_id)

        if simulated_root_ids != target_root_ids:
            raise RuntimeError(
                "Alphabetize failed to realize target order: "
                f"actual={simulated_root_ids} target={target_root_ids}"
            )

        if len(move_ops) == 0:
            return {
                "status": "noop",
                "reason": "already_alphabetized",
                "visibleRootCount": len(visible_root_ids),
            }

        reset_undo_stack(
            self.client_id,
            self.undo_context,
        )

        return {
            "status": "moved",
            "movedRootCount": len(move_ops),
            "visibleRootCount": len(visible_root_ids),
            "updateUUID": generate_new_uuid(),
        }
