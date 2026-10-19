from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, List

from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.undo_state import reset_undo_stack
from app.usecases.base import QueryCommand
from app.usecases.collapse import apply_set_collapse_bulk


@dataclass
class CmdSetCollapseBulk(QueryCommand):
    note_ids: List[str]
    collapsed: bool
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, object]:
        reset_undo_stack(self.client_id, self.undo_context)
        note_ids_to_update: List[str] = []
        before_by_id: Dict[str, bool] = {}

        for note_id in self.note_ids:
            before = bool(store.get(note_id).is_collapsed)
            if before is bool(self.collapsed):
                continue
            note_ids_to_update.append(note_id)
            before_by_id[note_id] = before

        if note_ids_to_update:
            apply_set_collapse_bulk(note_ids_to_update, bool(self.collapsed))

        updated_count = 0
        for note_id in note_ids_to_update:
            after = bool(store.get(note_id).is_collapsed)
            if after is not bool(self.collapsed):
                print(f"FATAL: bulk collapse failed for {note_id}")
                os._exit(1)
            updated_count += 1

        status = "unchanged"
        if updated_count > 0:
            status = "updated"
        return {
            "status": status,
            "updatedCount": updated_count,
            "updateUUID": generate_new_uuid(),
        }
