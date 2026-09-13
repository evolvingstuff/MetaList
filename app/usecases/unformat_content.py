from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.services.content_formatting import (
    remove_added_style_tags,
    remove_formatting_scope_delimiters,
)
from app.services.html_unformatting import unformat_note_content_html
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.usecases.base import QueryCommand
from app.usecases.update_content import apply_update_content
from app.services import undo_state


@dataclass
class CmdUnformatContent(QueryCommand):
    note_id: str
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdUnformatContent(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        record = store.get(self.note_id)
        if not isinstance(record.content, str):
            raise TypeError("note content must be a string")
        if not isinstance(record.tags, str):
            raise TypeError("note tags must be a string")

        updated_tags, wrappers_to_remove = remove_added_style_tags(record.tags)
        updated_content = unformat_note_content_html(record.content)
        updated_content = remove_formatting_scope_delimiters(
            updated_content,
            wrappers_to_remove,
        )
        if updated_content == record.content and updated_tags == record.tags:
            return {"status": "noop", "updateUUID": generate_new_uuid()}

        apply_update_content(self.note_id, updated_content, updated_tags, self.token)


        undo_state.record_update(
            self.client_id,
            self.undo_context,
            self.note_id,
            before=record.content,
            after=updated_content,
            before_tags=record.tags,
            after_tags=updated_tags,
            viewport=self.viewport,
        )

        return {"status": "updated", "updateUUID": generate_new_uuid()}
