from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.services.search_index import extract_tags_for_search, search_index
from app.services.search_history import current_local_date, record_explicit_tag_additions
from app.services.selected_text_tag import (
    find_equivalent_existing_tag,
    resolve_selected_text_tag,
)
from app.services.store import store
from app.services.sync import generate_new_uuid, get_current_sync_uuid
from app.services.undo_state import record_update
from app.usecases.base import QueryCommand
from app.usecases.update_content import apply_update_content


def _append_global_tag(*, tags: str, tag: str) -> str:
    if not isinstance(tags, str):
        raise TypeError("tags must be a string")
    if not isinstance(tag, str) or tag == "":
        raise TypeError("tag must be a non-empty string")
    if any(char.isspace() for char in tag):
        raise ValueError("tag must not contain whitespace")

    normalized_existing = tags.strip()
    if normalized_existing == "":
        return tag
    return f"{normalized_existing} {tag}"


@dataclass
class CmdAddSelectedTextTag(QueryCommand):
    note_id: str
    selected_text: str
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdAddSelectedTextTag(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        record = store.get(self.note_id)
        if not isinstance(record.content, str):
            raise TypeError("note content must be a string")
        if not isinstance(record.tags, str):
            raise TypeError("note tags must be a string")

        namespace_tag_frequencies = search_index.list_explicit_tag_frequencies()
        current_note_tags = extract_tags_for_search(record.tags)
        # A tag only this note's unsaved text has is on no saved note yet.
        current_note_frequencies = {tag: 0 for tag in current_note_tags}
        for tag in current_note_tags:
            if tag in namespace_tag_frequencies:
                current_note_frequencies[tag] = namespace_tag_frequencies[tag]
        current_tag = find_equivalent_existing_tag(
            selected_text=self.selected_text,
            existing_tag_frequencies=current_note_frequencies,
        )
        if current_tag is not None:
            return {
                "status": "exists",
                "tag": current_tag,
                "tags": record.tags,
                "updateUUID": get_current_sync_uuid(),
            }

        resolved_tag = resolve_selected_text_tag(
            selected_text=self.selected_text,
            existing_tag_frequencies=namespace_tag_frequencies,
        )
        next_tags = _append_global_tag(tags=record.tags, tag=resolved_tag)
        assert next_tags != record.tags

        apply_update_content(
            self.note_id,
            record.content,
            next_tags,
            self.token,
        )
        record_update(
            self.client_id,
            self.undo_context,
            self.note_id,
            before=record.content,
            after=record.content,
            before_tags=record.tags,
            after_tags=next_tags,
            viewport=self.viewport,
        )
        record_explicit_tag_additions(
            before_tags=record.tags,
            after_tags=next_tags,
            token=self.token,
            interacted_on=current_local_date(),
        )

        return {
            "status": "added",
            "tag": resolved_tag,
            "tags": next_tags,
            "updateUUID": generate_new_uuid(),
        }
