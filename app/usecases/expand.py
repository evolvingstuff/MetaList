from __future__ import annotations

from dataclasses import dataclass
from typing import Dict
import os

from app.usecases.base import QueryCommand
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.usecases.collapse import apply_set_collapse
from app.services import undo_state


@dataclass
class CmdExpand(QueryCommand):
    note_id: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdExpand(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        before = bool(store.get(self.note_id).is_collapsed)
        if before is False:
            return {"status": "unchanged", "updateUUID": generate_new_uuid()}
        apply_set_collapse(self.note_id, False)
        after = bool(store.get(self.note_id).is_collapsed)
        if after is not False:
            print(f"FATAL: expand failed for {self.note_id}")
            os._exit(1)

        undo_state.record_collapse(
            self.client_id,
            self.undo_context,
            self.note_id,
            before=before,
            after=False,
            viewport=self.viewport,
        )

        return {"status": "updated", "updateUUID": generate_new_uuid()}
