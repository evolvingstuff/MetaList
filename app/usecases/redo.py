from __future__ import annotations

from dataclasses import dataclass
from app.usecases.base import QueryCommand
from app.services.undo_state import redo as do_redo, maybe_reset_on_context
from app.services.sync import get_current_sync_uuid


@dataclass
class CmdRedo(QueryCommand):
    client_id: str
    token: str
    undo_context: str

    def execute(self):
        maybe_reset_on_context(self.client_id, self.undo_context)
        scroll_restore = do_redo(self.client_id, self.token)
        if scroll_restore is not None:
            return {
                "status": "success",
                "message": "Redo successful",
                "updateUUID": get_current_sync_uuid(),
                "scrollRestore": scroll_restore,
            }
        else:
            return {
                "status": "noop",
                "message": "No actions to redo",
                "updateUUID": get_current_sync_uuid(),
            }
