from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional
import uuid

from app.services.file_storage import download_file
from app.services.file_text_preview import build_file_text_preview
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.undo_state import record_create
from app.usecases.base import QueryCommand
from app.usecases.create_note import apply_insert_note, build_created_note_undo_record
from app.usecases.search_comment_autofill import compute_initial_tags_for_new_note


@dataclass
class CmdCreateFilePreviewChild(QueryCommand):
    """A dropped text file's preview: its text as the last child of the note holding its pill.

    Files that get no preview (not .txt/.md/.csv/.json, too large, not UTF-8) create
    nothing; the status says why (app/services/file_text_preview.py).
    """

    parent_note_id: str
    file_id: str
    search_query: Optional[str]
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, str]:
        parent = store.get(self.parent_note_id)
        if f"[[{self.file_id}]]" not in parent.content:
            raise ValueError(f"Note {parent.id} does not hold file {self.file_id}")
        downloaded = download_file(self.file_id, self.token)
        preview = build_file_text_preview(
            original_filename=downloaded.record.original_filename,
            content_bytes=downloaded.content_bytes,
        )
        if preview.status != "ready":
            return {"status": preview.status}

        children = store.children(parent.id)
        prev_id = None
        if children:
            prev_id = children[-1]
        initial_tags = compute_initial_tags_for_new_note(parent_id=parent.id, search_query=self.search_query)
        tags = " ".join(part for part in (initial_tags, preview.render_tag) if part != "")

        note_uuid = str(uuid.uuid4())
        apply_insert_note(
            note_uuid,
            parent.id,
            prev_id,
            None,
            self.token,
            content=preview.content_html,
            tags=tags,
            proposed_tags="",
        )
        record_create(self.client_id, self.undo_context, build_created_note_undo_record(note_uuid),
                      viewport=self.viewport)
        return {"status": "created", "id": note_uuid, "updateUUID": generate_new_uuid()}
