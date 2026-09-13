from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.usecases.base import QueryCommand
from app.usecases.update_content import apply_update_content
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.tag_rename import toggle_meta_tag_pair_in_tag_bar
from app.services import undo_state


@dataclass
class CmdToggleTodoDone(QueryCommand):
    note_id: str
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdToggleTodoDone(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        record = store.get(self.note_id)
        next_tags, changed = toggle_meta_tag_pair_in_tag_bar(
            tags=record.tags,
            tag_a="@todo",
            tag_b="@done",
        )
        if not changed:
            raise RuntimeError(f"Toggle todo/done did not change tags for note {self.note_id}")

        apply_update_content(self.note_id, record.content, next_tags, self.token)

        undo_state.record_update(
            self.client_id,
            self.undo_context,
            self.note_id,
            before=record.content,
            after=record.content,
            before_tags=record.tags,
            after_tags=next_tags,
            viewport=self.viewport,
        )

        update_uuid = generate_new_uuid()
        return {"status": "success", "updateUUID": update_uuid}
