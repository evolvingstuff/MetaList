from __future__ import annotations

from dataclasses import dataclass
from typing import Dict
import os

from app.usecases.base import QueryCommand
from app.services.store import store
from app.services.sync import generate_new_uuid

from app.db.session import begin_writer
from app.db.notes_sql import update_links_preserving_updated_at as db_update_links_preserving_updated_at


def apply_set_collapse_bulk(note_ids: list[str], collapsed: bool) -> None:
    if not isinstance(note_ids, list) or len(note_ids) == 0:
        raise TypeError("note_ids must be a non-empty list")
    for note_id in note_ids:
        if not isinstance(note_id, str) or not note_id:
            raise TypeError("note_ids must contain non-empty strings")

    with begin_writer() as connection:
        for note_id in note_ids:
            db_update_links_preserving_updated_at(connection, note_id, is_collapsed=bool(collapsed))
    for note_id in note_ids:
        store.set_collapsed(note_id, bool(collapsed))


def apply_set_collapse(note_id: str, collapsed: bool) -> None:
    apply_set_collapse_bulk([note_id], collapsed)


@dataclass
class CmdCollapse(QueryCommand):
    note_id: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdCollapse(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        before = bool(store.get(self.note_id).is_collapsed)
        if before is True:
            # unchanged
            return {"status": "unchanged", "updateUUID": generate_new_uuid()}
        apply_set_collapse(self.note_id, True)
        after = bool(store.get(self.note_id).is_collapsed)
        if after is not True:
            print(f"FATAL: collapse failed for {self.note_id}")
            os._exit(1)

        # record undo
        # Deferred: undo_state imports this module's apply function to replay operations.
        from app.services.undo_state import record_collapse
        record_collapse(
            self.client_id,
            self.undo_context,
            self.note_id,
            before=before,
            after=True,
            viewport=self.viewport,
        )

        return {"status": "updated", "updateUUID": generate_new_uuid()}
