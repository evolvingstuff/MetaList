from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List
import uuid

from app.usecases.base import QueryCommand
from app.usecases.create_note import apply_insert_note
from app.usecases.update_content import apply_update_content
from app.services.store import NodeRecord
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.undo_state import record_split_note
from app.security.note_html import sanitize_note_html


def _validate_split_segments(segments: List[str]) -> None:
    if not isinstance(segments, list):
        raise TypeError("segments must be a list")
    if len(segments) < 2:
        raise ValueError("split requires at least two segments")
    for segment in segments:
        if not isinstance(segment, str):
            raise TypeError("split segments must be strings")


@dataclass
class CmdSplitNote(QueryCommand):
    note_id: str
    segments: List[str]
    tags: str
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdSplitNote(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, object]:
        _validate_split_segments(self.segments)
        if not isinstance(self.tags, str):
            raise TypeError("tags must be a string")

        before_record = store.get(self.note_id)
        before_content = before_record.content
        before_tags = before_record.tags
        parent_id = before_record.parent_id

        sanitized_segments = [sanitize_note_html(segment) for segment in self.segments]
        apply_update_content(self.note_id, sanitized_segments[0], self.tags, self.token)
        inserted_records: List[NodeRecord] = []
        anchor_note_id = self.note_id
        for segment in sanitized_segments[1:]:
            anchor_record = store.get(anchor_note_id)
            next_id = anchor_record.next_id
            new_note_id = str(uuid.uuid4())
            apply_insert_note(
                new_note_id,
                parent_id,
                anchor_note_id,
                next_id,
                self.token,
                content=segment,
                tags=self.tags,
                proposed_tags="",
            )
            inserted_records.append(store.get(new_note_id))
            anchor_note_id = new_note_id

        if len(inserted_records) == 0:
            raise RuntimeError("split produced no inserted records")

        record_split_note(
            self.client_id,
            self.undo_context,
            note_id=self.note_id,
            before_content=before_content,
            before_tags=before_tags,
            after_content=sanitized_segments[0],
            after_tags=self.tags,
            inserted_records=inserted_records,
            viewport=self.viewport,
        )

        update_uuid = generate_new_uuid()
        return {
            "status": "split",
            "id": self.note_id,
            "createdIds": [record.id for record in inserted_records],
            "updateUUID": update_uuid,
        }
