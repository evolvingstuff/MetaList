from __future__ import annotations

from dataclasses import dataclass
from app.usecases.base import QueryCommand
from app.services.undo_state import undo as do_undo, maybe_reset_on_context, undo_history_limited
from app.services.sync import get_current_sync_uuid


@dataclass
class CmdUndo(QueryCommand):
    client_id: str
    token: str
    undo_context: str

    def describe(self) -> str:
        return f"CmdUndo(client={self.client_id})"

    def execute(self):
        maybe_reset_on_context(self.client_id, self.undo_context)
        scroll_restore = do_undo(self.client_id, self.token)
        if scroll_restore is not None:
            return {
                "status": "success",
                "message": "Undo successful",
                "updateUUID": get_current_sync_uuid(),
                "scrollRestore": scroll_restore,
            }
        else:
            return {
                "status": "noop",
                "message": "Older undo history was discarded to stay within memory limits" if undo_history_limited(self.client_id) else "No actions to undo",
                "updateUUID": get_current_sync_uuid(),
            }
