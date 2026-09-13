from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional, Tuple

from app.usecases.base import QueryCommand
from app.services.store import store
from app.services.sync import generate_new_uuid

from app.db.session import begin_writer
from app.db.notes_sql import update_links_preserving_updated_at as db_update_links_preserving_updated_at


def _neighbors(note_id: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    rec = store.get(note_id)
    return rec.parent_id, rec.prev_id, rec.next_id


def _assert_neighbors(note_id: str, exp_parent: Optional[str], exp_prev: Optional[str], exp_next: Optional[str]) -> None:
    parent_id, prev_id, next_id = _neighbors(note_id)
    if parent_id != exp_parent or prev_id != exp_prev or next_id != exp_next:
        raise RuntimeError(
            f"move invariant failed for {note_id}: "
            f"expected {(exp_parent, exp_prev, exp_next)}, actual {(parent_id, prev_id, next_id)}"
        )


def apply_move(note_id: str, new_parent_id: Optional[str], prev_id: Optional[str], next_id: Optional[str]) -> None:
    old_parent, old_prev, old_next = _neighbors(note_id)
    with begin_writer() as connection:
        if old_prev:
            db_update_links_preserving_updated_at(connection, old_prev, next_id=old_next)
        if old_next:
            db_update_links_preserving_updated_at(connection, old_next, prev_id=old_prev)

        db_update_links_preserving_updated_at(connection, note_id, parent_id=new_parent_id, prev_id=prev_id, next_id=next_id)
        if prev_id:
            db_update_links_preserving_updated_at(connection, prev_id, next_id=note_id)
        if next_id:
            db_update_links_preserving_updated_at(connection, next_id, prev_id=note_id)

    store.move_note(note_id, new_parent_id, prev_id)


@dataclass
class CmdMove(QueryCommand):
    note_id: str
    sibling_id: Optional[str]
    position: Optional[str]  # 'BEFORE' or 'AFTER'
    new_parent_id: Optional[str]
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdMove(note={self.note_id}, sib={self.sibling_id}, pos={self.position}, parent={self.new_parent_id})"

    def execute(self) -> Dict[str, str]:
        if not self.sibling_id or not isinstance(self.position, str):
            raise RuntimeError("Move requires a sibling ID and position")
        position = self.position.upper()
        if position not in {'BEFORE', 'AFTER'}:
            raise RuntimeError("Move position must be BEFORE or AFTER")
        sibling = store.get(self.sibling_id)
        destination_parent = sibling.parent_id
        if self.new_parent_id is not None:
            destination_parent = self.new_parent_id
        assert sibling.parent_id == destination_parent
        if position == 'BEFORE':
            prev_id, next_id = sibling.prev_id, sibling.id
        else:
            prev_id, next_id = sibling.id, sibling.next_id

        # Record move for undo
        old_parent, old_prev, old_next = _neighbors(self.note_id)
        record = store.get(self.note_id)
        if not isinstance(record.tags, str):
            raise RuntimeError(f"Note tags must be a string | note_id={self.note_id}")
        before_tags = record.tags
        after_tags = record.tags

        apply_move(self.note_id, destination_parent, prev_id, next_id)
        _assert_neighbors(self.note_id, destination_parent, prev_id, next_id)

        # Deferred: undo_state imports this module's apply function to replay operations.
        from app.services.undo_state import record_move
        record_move(
            self.client_id,
            self.undo_context,
            self.note_id,
            before_parent=old_parent,
            before_prev=old_prev,
            before_next=old_next,
            before_tags=before_tags,
            after_parent=destination_parent,
            after_prev=prev_id,
            after_next=next_id,
            after_tags=after_tags,
            viewport=self.viewport,
        )

        update_uuid = generate_new_uuid()
        return {"status": "moved", "updateUUID": update_uuid}
