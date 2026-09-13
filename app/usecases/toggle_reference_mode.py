from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.services.embedded_references import replace_reference_token_mode_in_html
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.usecases.base import QueryCommand
from app.usecases.update_content import apply_update_content
from app.services import undo_state


@dataclass
class CmdToggleReferenceMode(QueryCommand):
    note_id: str
    reference_note_id: str
    occurrence_index: int
    mode: str
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return (
            "CmdToggleReferenceMode("
            f"note={self.note_id}, ref={self.reference_note_id}, occurrence={self.occurrence_index}, mode={self.mode}, "
            f"client={self.client_id})"
        )

    def execute(self) -> Dict[str, str]:
        if self.mode not in {"embed", "link"}:
            raise ValueError("mode must be 'embed' or 'link'")

        record = store.get(self.note_id)
        if not isinstance(record.content, str):
            raise TypeError("note content must be a string")
        if not isinstance(record.tags, str):
            raise TypeError("note tags must be a string")

        updated_content, changed = replace_reference_token_mode_in_html(
            content_html=record.content,
            reference_note_id=self.reference_note_id,
            occurrence_index=self.occurrence_index,
            target_mode=self.mode,
        )
        if not changed:
            return {"status": "noop", "updateUUID": generate_new_uuid()}

        apply_update_content(self.note_id, updated_content, record.tags, self.token)


        undo_state.record_update(
            self.client_id,
            self.undo_context,
            self.note_id,
            before=record.content,
            after=updated_content,
            before_tags=record.tags,
            after_tags=record.tags,
            viewport=self.viewport,
        )

        return {"status": "updated", "updateUUID": generate_new_uuid()}
