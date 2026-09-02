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
class CmdCreateSibling(QueryCommand):
    reference_note_id: str
    search_query: Optional[str]
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdCreateSibling(ref={self.reference_note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        ref = store.get(self.reference_note_id)
        parent_id = ref.parent_id
        siblings = store.children(parent_id)
        if ref.id not in siblings:
            raise RuntimeError(
                "Integrity failure: reference note missing from siblings list: "
                f"note_id={ref.id} parent_id={parent_id}"
            )
        idx = siblings.index(ref.id)
        prev_id = ref.id
        if idx + 1 < len(siblings):
            next_id = siblings[idx + 1]
        else:
            next_id = None


        note_uuid = str(uuid.uuid4())
        content = ""
        tags = compute_initial_tags_for_new_note(
            parent_id=parent_id,
            search_query=self.search_query,
        )

        apply_insert_note(
            note_uuid,
            parent_id,
            prev_id,
            next_id,
            self.token,
            content=content,
            tags=tags,
        )

        rec = build_created_note_undo_record(note_uuid)
        record_create(self.client_id, self.undo_context, rec, viewport=self.viewport)

        update_uuid = generate_new_uuid()
        return {"id": note_uuid, "status": "created", "updateUUID": update_uuid}
