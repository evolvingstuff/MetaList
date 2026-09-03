from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional
import uuid

from app.usecases.base import QueryCommand
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.undo_state import record_create
from app.usecases.create_note import apply_insert_note, build_created_note_undo_record
from app.usecases.search_comment_autofill import compute_initial_tags_for_new_note


@dataclass
class CmdCreateChild(QueryCommand):
    parent_note_id: str
    search_query: Optional[str]
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdCreateChild(parent={self.parent_note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        parent = store.get(self.parent_note_id)
        children = store.children(parent.id)
        prev_id = None
        next_id = None
        if children:
            next_id = children[0]

        note_uuid = str(uuid.uuid4())
        content = ""
        tags = compute_initial_tags_for_new_note(
            parent_id=parent.id,
            search_query=self.search_query,
        )
        apply_insert_note(
            note_uuid,
            parent.id,
            prev_id,
            next_id,
            self.token,
            content=content,
            tags=tags,
            proposed_tags="",
        )

        rec = build_created_note_undo_record(note_uuid)
        record_create(self.client_id, self.undo_context, rec, viewport=self.viewport)

        update_uuid = generate_new_uuid()
        return {"id": note_uuid, "status": "created", "updateUUID": update_uuid}
