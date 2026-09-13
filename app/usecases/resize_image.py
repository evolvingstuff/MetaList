from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.services.file_registry import file_registry
from app.services.image_size_formatting import apply_image_size_action
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.usecases.base import QueryCommand
from app.usecases.update_content import apply_update_content
from app.services import undo_state


@dataclass
class CmdResizeImage(QueryCommand):
    note_id: str
    source_kind: str
    occurrence_index: int
    action: str
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return (
            "CmdResizeImage("
            f"note={self.note_id}, source={self.source_kind}, occurrence={self.occurrence_index}, "
            f"action={self.action}, client={self.client_id})"
        )

    def execute(self) -> Dict[str, object]:
        record = store.get(self.note_id)
        if not isinstance(record.content, str):
            raise TypeError("note content must be a string")
        if not isinstance(record.tags, str):
            raise TypeError("note tags must be a string")

        mutation = apply_image_size_action(
            content_html=record.content,
            tags=record.tags,
            source_kind=self.source_kind,
            occurrence_index=self.occurrence_index,
            action=self.action,
            is_image_file=file_registry.has_image_file,
        )
        update_uuid = generate_new_uuid()
        if not mutation.changed:
            return {
                "status": "noop",
                "content": record.content,
                "tags": record.tags,
                "sizeFactor": mutation.size_factor,
                "updateUUID": update_uuid,
            }

        apply_update_content(
            self.note_id,
            mutation.content_html,
            mutation.tags,
            self.token,
        )


        undo_state.record_update(
            self.client_id,
            self.undo_context,
            self.note_id,
            before=record.content,
            after=mutation.content_html,
            before_tags=record.tags,
            after_tags=mutation.tags,
            viewport=self.viewport,
        )

        return {
            "status": "updated",
            "content": mutation.content_html,
            "tags": mutation.tags,
            "sizeFactor": mutation.size_factor,
            "updateUUID": update_uuid,
        }
