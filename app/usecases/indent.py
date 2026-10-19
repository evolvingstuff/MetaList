from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.usecases.base import QueryCommand
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.usecases.collapse import apply_set_collapse
from app.usecases.move import apply_move, _neighbors, _assert_neighbors
from app.services.undo_state import record_move


@dataclass
class CmdIndent(QueryCommand):
    note_id: str
    visible_prev_id: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, str]:
        record = store.get(self.note_id)
        parent_id = record.parent_id
        siblings = store.children(parent_id)
        if self.note_id not in siblings:
            raise RuntimeError(
                "Integrity failure: indent target missing from siblings list: "
                f"note_id={self.note_id} parent_id={parent_id}"
            )
        if not isinstance(self.visible_prev_id, str) or not self.visible_prev_id:
            raise TypeError("visible_prev_id must be a non-empty string")
        if not store.contains(self.visible_prev_id):
            raise RuntimeError(f"visible_prev_id missing from store: {self.visible_prev_id}")

        index = siblings.index(self.note_id)
        prev_index = siblings.index(self.visible_prev_id)
        if prev_index >= index:
            return {"status": "noop"}

        prev_record = store.get(self.visible_prev_id)
        if prev_record.parent_id != parent_id:
            raise RuntimeError(
                "Indent visible_prev_id must share parent with note: "
                f"note_id={self.note_id} parent_id={parent_id} visible_prev_id={self.visible_prev_id} "
                f"visible_prev_parent={prev_record.parent_id}"
            )

        new_parent_id = self.visible_prev_id
        destination_children = store.children(new_parent_id)
        dest_prev = None
        if destination_children:
            dest_prev = destination_children[-1]
        dest_next = None

        before_parent, before_prev, before_next = _neighbors(self.note_id)
        if not isinstance(record.tags, str):
            raise RuntimeError(f"Note tags must be a string | note_id={self.note_id}")
        before_tags = record.tags
        after_tags = record.tags

        apply_move(self.note_id, new_parent_id, dest_prev, dest_next)
        _assert_neighbors(self.note_id, new_parent_id, dest_prev, dest_next)
        if prev_record.is_collapsed:
            apply_set_collapse(new_parent_id, False)

        record_move(
            self.client_id,
            self.undo_context,
            self.note_id,
            before_parent=before_parent,
            before_prev=before_prev,
            before_next=before_next,
            before_tags=before_tags,
            after_parent=new_parent_id,
            after_prev=dest_prev,
            after_next=dest_next,
            after_tags=after_tags,
            viewport=self.viewport,
        )

        update_uuid = generate_new_uuid()
        return {"status": "moved", "updateUUID": update_uuid}
