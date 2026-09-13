from typing import Optional
from types import SimpleNamespace

from app.db.notes_sql import fetch_children_ordered, fetch_note, update_links_preserving_updated_at
from app.models.database import SafeSession
from .enums import MovePosition
from ..services.note_store import store as note_store


class ListOperations:
    """Handles linked list manipulation operations"""
    
    @staticmethod
    def move_note(
        db: SafeSession,
        note_id: str,
        new_parent_id: Optional[str],
        sibling_id: Optional[str],
        position: Optional[MovePosition],
    ):
        """Move a note to a new position"""
        if note_store.loaded:
            _move_note_with_store(db, note_id, new_parent_id, sibling_id, position)
            return

            # Fallback path when store is not available (legacy behavior)
        if sibling_id and position is None:
            raise ValueError("Position must be specified when sibling_id is provided")
        if position and not sibling_id:
            raise ValueError("Position cannot be specified without a sibling_id")
        if sibling_id == note_id:
            raise ValueError("Cannot move note relative to itself")

        with SafeSession.allow_reads("list_ops:move_note:target"):
            note_row = fetch_note(db.connection(), note_id)
        if not note_row:
            raise ValueError(f"Note {note_id} not found")

        note = SimpleNamespace(**note_row)
        if new_parent_id == note.parent_id and sibling_id is None:
            raise ValueError("Note is already at this position")

        old_prev_id = note.prev_id
        old_next_id = note.next_id

        def is_descendant(parent_id: str, potential_child_id: str) -> bool:
            with SafeSession.allow_reads("list_ops:is_descendant"):
                current_row = fetch_note(db.connection(), potential_child_id)
            if current_row:
                current = SimpleNamespace(**current_row)
            else:
                current = None
            while current and current.parent_id:
                if current.parent_id == parent_id:
                    return True
                with SafeSession.allow_reads("list_ops:is_descendant:up"):
                    row = fetch_note(db.connection(), current.parent_id)
                if row:
                    current = SimpleNamespace(**row)
                else:
                    current = None
            return False

        if new_parent_id and is_descendant(note_id, new_parent_id):
            raise ValueError("Cannot create circular parent-child relationship")
        if new_parent_id == note_id:
            raise ValueError("Cannot make a note its own parent")

        with SafeSession.allow_reads("list_ops:target_notes"):
            target_rows = fetch_children_ordered(db.connection(), new_parent_id)
        target_notes = [SimpleNamespace(**row) for row in target_rows]

        if old_prev_id:
            update_links_preserving_updated_at(
                db.connection(),
                old_prev_id,
                next_id=old_next_id,
            )
        if old_next_id:
            update_links_preserving_updated_at(
                db.connection(),
                old_next_id,
                prev_id=old_prev_id,
            )

        update_links_preserving_updated_at(
            db.connection(),
            note_id,
            parent_id=new_parent_id,
            prev_id=None,
            next_id=None,
        )

        if sibling_id is None:
            heads = [n for n in target_notes if n.prev_id is None]
            if not heads:
                raise RuntimeError(
                    "Integrity failure: target sibling list has no head (prev_id is NULL)"
                )
            existing_head = heads[0]
            update_links_preserving_updated_at(
                db.connection(),
                existing_head.id,
                prev_id=note_id,
            )
            update_links_preserving_updated_at(
                db.connection(),
                note_id,
                next_id=existing_head.id,
            )
            return

        with SafeSession.allow_reads("list_ops:sibling"):
            sibling_row = fetch_note(db.connection(), sibling_id)
        if not sibling_row:
            raise ValueError(f"Sibling note {sibling_id} not found")
        sibling = SimpleNamespace(**sibling_row)
        if sibling.parent_id != new_parent_id:
            raise ValueError("Sibling must have the same parent")

        if position == MovePosition.BEFORE:
            update_links_preserving_updated_at(
                db.connection(),
                note_id,
                prev_id=sibling.prev_id,
                next_id=sibling_id,
            )
            update_links_preserving_updated_at(
                db.connection(),
                sibling_id,
                prev_id=note_id,
            )
            if sibling.prev_id:
                update_links_preserving_updated_at(
                    db.connection(),
                    sibling.prev_id,
                    next_id=note_id,
                )
        else:
            update_links_preserving_updated_at(
                db.connection(),
                note_id,
                prev_id=sibling_id,
                next_id=sibling.next_id,
            )
            update_links_preserving_updated_at(
                db.connection(),
                sibling_id,
                next_id=note_id,
            )
            if sibling.next_id:
                update_links_preserving_updated_at(
                    db.connection(),
                    sibling.next_id,
                    prev_id=note_id,
                )


def _move_note_with_store(db: SafeSession, note_id: str, new_parent_id: Optional[str],
                          sibling_id: Optional[str], position: Optional[MovePosition]) -> None:
    record = note_store.get_note(note_id)

    if sibling_id and position is None:
        raise ValueError("Position must be specified when sibling_id is provided")
    if position and not sibling_id:
        raise ValueError("Position cannot be specified without a sibling_id")
    if sibling_id == note_id:
        raise ValueError("Cannot move note relative to itself")
    if new_parent_id == note_id:
        raise ValueError("Cannot make a note its own parent")

    if new_parent_id:
        descendants = _collect_descendants_from_store(note_id)[1:]
        if new_parent_id in descendants:
            raise ValueError("Cannot create circular parent-child relationship")

    old_parent = record.parent_id

    def build_order(parent_id: Optional[str]) -> list[str]:
        order = list(note_store.get_children(parent_id))
        return [nid for nid in order if nid != note_id]

    old_order = build_order(old_parent)

    if new_parent_id == old_parent:
        new_order = list(old_order)
    else:
        new_order = build_order(new_parent_id)

    if sibling_id is None:
        new_order.insert(0, note_id)
    else:
        if sibling_id not in new_order:
            raise ValueError(f"Sibling note {sibling_id} not found")
        index = new_order.index(sibling_id)
        if position == MovePosition.BEFORE:
            new_order.insert(index, note_id)
        else:
            new_order.insert(index + 1, note_id)

    if new_parent_id == old_parent:
        updates = _persist_order(db, new_parent_id, new_order)
    else:
        updates = _persist_order(db, old_parent, old_order)
        updates.extend(_persist_order(db, new_parent_id, new_order))
    note_store.bulk_update_metadata(updates, rebuild=True)
    note_store.debug_validate_links(note_id, sibling_id, new_parent_id, old_parent)


def _persist_order(db: SafeSession, parent_id: Optional[str], order: list[str]) -> list[SimpleNamespace]:
    updates: list[SimpleNamespace] = []

    for index, current_id in enumerate(order):
        if index > 0:
            prev_id = order[index - 1]
        else:
            prev_id = None
        if index < len(order) - 1:
            next_id = order[index + 1]
        else:
            next_id = None

        record = note_store.get_note(current_id)

        changed_parent = record.parent_id != parent_id
        changed_prev = record.prev_id != prev_id
        changed_next = record.next_id != next_id

        if not (changed_parent or changed_prev or changed_next):
            continue

        kwargs = {}
        if changed_parent:
            kwargs["parent_id"] = parent_id
        if changed_prev:
            kwargs["prev_id"] = prev_id
        if changed_next:
            kwargs["next_id"] = next_id

        update_links_preserving_updated_at(db.connection(), current_id, **kwargs)

        updates.append(
            SimpleNamespace(
                id=current_id,
                parent_id=parent_id,
                prev_id=prev_id,
                next_id=next_id,
                updated_at=record.updated_at,
            )
        )

    return updates


def _collect_descendants_from_store(root_id: str) -> list[str]:
    stack = [root_id]
    result = []
    while stack:
        current = stack.pop()
        result.append(current)
        stack.extend(note_store.get_children(current))
    return result
