from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Dict, List, Optional

from app.db.notes_sql import update_links_preserving_updated_at as db_update_links_preserving_updated_at
from app.db.session import begin_writer
from app.services.search_index import extract_tags_for_search
from app.services.search_index import search_index
from app.services.note_store import NotePosition
from app.services.store import store
from app.services.tag_term_matching import tag_term_matches_prefix
from app.services.sync import generate_new_uuid
from app.services.tag_ontology import is_valid_tag_token
from app.services.undo_state import reset_undo_stack
from app.usecases.base import QueryCommand
from app.usecases.move import _assert_neighbors, _neighbors


def _normalize_direction(direction: str) -> str:
    if not isinstance(direction, str):
        raise TypeError(f"direction must be a string, got {type(direction)}")
    normalized = direction.strip().lower()
    if normalized not in {"front", "back"}:
        raise ValueError("direction must be 'front' or 'back'")
    return normalized


def _normalize_tag(tag: str) -> str:
    if not isinstance(tag, str):
        raise TypeError(f"tag must be a string, got {type(tag)}")
    normalized = tag.strip()
    if normalized == "":
        raise ValueError("tag must be a non-empty tag token")
    if not is_valid_tag_token(normalized):
        raise ValueError("tag must be a single valid tag token")
    return normalized


def _validate_legacy_search_query(search_query: Optional[str]) -> None:
    if search_query is not None and not isinstance(search_query, str):
        raise TypeError(f"search_query must be a string or None, got {type(search_query)}")


def _build_target_root_ids(
    *,
    ordered_root_ids: List[str],
    matching_root_ids: List[str],
    direction: str,
) -> List[str]:
    ordered_root_id_set = set(ordered_root_ids)
    if len(ordered_root_id_set) != len(ordered_root_ids):
        raise RuntimeError("Root ids must be unique")

    matching_root_id_set = set(matching_root_ids)
    if len(matching_root_id_set) != len(matching_root_ids):
        raise RuntimeError("Matching root ids must be unique")
    if not matching_root_id_set.issubset(ordered_root_id_set):
        raise RuntimeError("Matching root ids must be a subset of ordered root ids")

    non_matching_root_ids = [
        root_id for root_id in ordered_root_ids if root_id not in matching_root_id_set
    ]
    if direction == "front":
        return matching_root_ids + non_matching_root_ids
    return non_matching_root_ids + matching_root_ids


def _build_root_order_updates(
    *,
    target_root_ids: List[str],
) -> tuple[List[SimpleNamespace], int]:
    if len(set(target_root_ids)) != len(target_root_ids):
        raise RuntimeError("Target root ids must be unique")

    updates: List[SimpleNamespace] = []
    changed_count = 0
    for index, note_id in enumerate(target_root_ids):
        if index > 0:
            prev_id = target_root_ids[index - 1]
        else:
            prev_id = None
        if index + 1 < len(target_root_ids):
            next_id = target_root_ids[index + 1]
        else:
            next_id = None

        before_parent, before_prev, before_next = _neighbors(note_id)
        if before_parent is not None:
            raise RuntimeError(
                "Prioritize only supports root notes in v1: "
                f"note_id={note_id} parent_id={before_parent}"
            )
        link_changed = before_prev != prev_id
        if before_next != next_id:
            link_changed = True
        if link_changed:
            changed_count += 1
            updates.append(
                SimpleNamespace(
                    id=note_id,
                    parent_id=None,
                    prev_id=prev_id,
                    next_id=next_id,
                    link_changed=True,
                )
            )
        else:
            updates.append(
                SimpleNamespace(
                    id=note_id,
                    parent_id=None,
                    prev_id=prev_id,
                    next_id=next_id,
                    link_changed=False,
                )
            )
    return updates, changed_count


def _apply_root_order_updates(updates: List[SimpleNamespace]) -> None:
    if not updates:
        return

    with begin_writer() as connection:
        for update in updates:
            if update.link_changed is not True:
                continue
            db_update_links_preserving_updated_at(
                connection,
                update.id,
                parent_id=update.parent_id,
                prev_id=update.prev_id,
                next_id=update.next_id,
            )

    store.move_notes([
        NotePosition(note_id=update.id, parent_id=update.parent_id, prev_id=update.prev_id, next_id=update.next_id)
        for update in updates
    ])
    for update in updates:
        _assert_neighbors(update.id, update.parent_id, update.prev_id, update.next_id)


def _scored_term_order(scored_term: tuple[int, int, str, str]) -> tuple[int, int, str, str]:
    """Direct prefix matches first, then the most used, then by name."""
    direct_prefix_score, count, casefolded, representative = scored_term
    return (-direct_prefix_score, -count, casefolded, representative)


def list_prioritize_tag_suggestions(
    *,
    search_query: Optional[str],
    query: str,
    limit: int,
) -> List[str]:
    if not isinstance(query, str):
        raise TypeError(f"query must be a string, got {type(query)}")
    if not isinstance(limit, int) or limit <= 0:
        raise TypeError("limit must be a positive integer")

    _validate_legacy_search_query(search_query)
    normalized_prefix = query.strip()
    ordered_root_ids = store.children(None)

    total_counts: Dict[str, int] = {}
    representative_counts: Dict[str, Dict[str, int]] = {}
    direct_prefix_matches: Dict[str, bool] = {}
    first_seen_indices: Dict[str, int] = {}
    next_index = 0

    for root_id in ordered_root_ids:
        record = store.get(root_id)
        if not isinstance(record.tags, str):
            raise RuntimeError(f"Note tags must be a string | note_id={root_id}")
        for tag in extract_tags_for_search(record.tags):
            if normalized_prefix != "" and not tag_term_matches_prefix(term=tag, prefix=normalized_prefix):
                continue
            tag_casefold = tag.casefold()
            if tag_casefold not in total_counts:
                total_counts[tag_casefold] = 0
                representative_counts[tag_casefold] = {}
            total_counts[tag_casefold] += 1
            spelling_counts = representative_counts[tag_casefold]
            if tag not in spelling_counts:
                spelling_counts[tag] = 0
            spelling_counts[tag] += 1
            if tag not in first_seen_indices:
                first_seen_indices[tag] = next_index
                next_index += 1
            if tag_casefold not in direct_prefix_matches:
                direct_prefix_matches[tag_casefold] = tag.casefold().startswith(normalized_prefix.casefold())
            elif not direct_prefix_matches[tag_casefold] and tag.casefold().startswith(normalized_prefix.casefold()):
                direct_prefix_matches[tag_casefold] = True

    scored_terms: List[tuple[int, int, str, str]] = []
    for tag_casefold, count in total_counts.items():
        spellings = representative_counts[tag_casefold]
        representative = sorted(
            spellings.items(),
            key=lambda item: (-item[1], first_seen_indices[item[0]], item[0].casefold(), item[0]),
        )[0][0]
        direct_prefix_score = 0
        if tag_casefold in direct_prefix_matches and direct_prefix_matches[tag_casefold]:
            direct_prefix_score = 1
        scored_terms.append(
            (
                direct_prefix_score,
                count,
                representative.casefold(),
                representative,
            )
        )

    scored_terms.sort(key=_scored_term_order)
    return [representative for _, _, _, representative in scored_terms[:limit]]


@dataclass
class CmdPrioritize(QueryCommand):
    tag: str
    direction: str
    search_query: Optional[str]
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, object]:
        normalized_tag = _normalize_tag(self.tag)
        normalized_direction = _normalize_direction(self.direction)
        _validate_legacy_search_query(self.search_query)

        ordered_root_ids = store.children(None)
        matching_note_ids = set(search_index.query_note_ids(normalized_tag))
        matching_root_ids = [
            root_id for root_id in ordered_root_ids if root_id in matching_note_ids
        ]

        if len(matching_root_ids) == 0:
            return {
                "status": "noop",
                "reason": "no_matches",
                "matchedRootCount": 0,
                "rootCount": len(ordered_root_ids),
            }

        target_root_ids = _build_target_root_ids(
            ordered_root_ids=ordered_root_ids,
            matching_root_ids=matching_root_ids,
            direction=normalized_direction,
        )
        if target_root_ids == ordered_root_ids:
            return {
                "status": "noop",
                "reason": "already_prioritized",
                "matchedRootCount": len(matching_root_ids),
                "rootCount": len(ordered_root_ids),
            }

        updates, moved_root_count = _build_root_order_updates(
            target_root_ids=target_root_ids,
        )

        if moved_root_count == 0:
            return {
                "status": "noop",
                "reason": "already_prioritized",
                "matchedRootCount": len(matching_root_ids),
                "rootCount": len(ordered_root_ids),
            }

        _apply_root_order_updates(updates)
        reset_undo_stack(
            self.client_id,
            self.undo_context,
        )

        return {
            "status": "moved",
            "movedRootCount": len(matching_root_ids),
            "matchedRootCount": len(matching_root_ids),
            "rootCount": len(ordered_root_ids),
            "updateUUID": generate_new_uuid(),
        }
