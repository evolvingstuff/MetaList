from __future__ import annotations

from dataclasses import dataclass
from typing import Dict
import os

from app.usecases.base import QueryCommand
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.usecases.collapse import apply_set_collapse, is_shown_collapsed
from app.services import undo_state


@dataclass
class CmdExpand(QueryCommand):
    note_id: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, str]:
        before = is_shown_collapsed(self.note_id)
        if before is False:
            return {"status": "unchanged", "updateUUID": generate_new_uuid()}
        apply_set_collapse(self.note_id, False)
        after = is_shown_collapsed(self.note_id)
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
