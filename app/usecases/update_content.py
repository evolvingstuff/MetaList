from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict

from app.usecases.base import QueryCommand
from app.services.store import store
from app.services.sync import generate_new_uuid

from app.db.session import begin_writer
from app.db.notes_sql import update_note_fields as db_update_note_fields
from app.db.notes_sql import update_note_fields_preserving_updated_at as db_update_note_fields_preserving_updated_at
from app.security.encryption import encrypt
from app.security.note_html import sanitize_note_html
from app.services.search_history import current_local_date, record_explicit_tag_additions
from app.services.content_cache import (
    cache_note,
    cache_note_proposed_tags,
    cache_note_tags,
    cache_note_text,
)
from app.utils.text_utils import strip_html


def apply_update_content(note_id: str, content: str, tags: str, token: str) -> None:
    """Apply a content+tags update to DB and in-memory store in a single atomic commit."""
    record = store.get(note_id)
    apply_update_note_sources(
        note_id=note_id,
        content=content,
        tags=tags,
        proposed_tags=record.proposed_tags,
        token=token,
    )


def apply_update_note_sources(
    *,
    note_id: str,
    content: str,
    tags: str,
    proposed_tags: str,
    token: str,
) -> None:
    """Atomically persist note content plus accepted and proposed tag sources."""
    if not isinstance(content, str):
        raise TypeError("content must be a string")
    if not isinstance(tags, str):
        raise TypeError("tags must be a string")
    if not isinstance(proposed_tags, str):
        raise TypeError("proposed_tags must be a string")
    sanitized_content = sanitize_note_html(content)

    # Validate existence without DB reads
    if not store.contains(note_id):
        raise KeyError(f"Note not found: {note_id}")

    record = store.get(note_id)
    content_changed = record.content != sanitized_content
    tags_changed = record.tags != tags
    proposed_tags_changed = record.proposed_tags != proposed_tags
    if not content_changed and not tags_changed and not proposed_tags_changed:
        return

    update_payload: dict[str, object] = {}
    if content_changed:
        ciphertext, nonce, tag = encrypt(sanitized_content, token)
        updated_at = datetime.now(timezone.utc)
        update_payload.update(
            {
                "content": ciphertext,
                "encryption_nonce": nonce,
                "encryption_tag": tag,
            }
        )
    else:
        updated_at = record.updated_at
        if updated_at is None:
            raise RuntimeError(f"Cannot preserve missing updated_at for tag-source update: {note_id}")

    if tags_changed:
        tags_ciphertext, tags_nonce, tags_tag = encrypt(tags, token)
        update_payload.update(
            {
                "tags": tags_ciphertext,
                "tags_encryption_nonce": tags_nonce,
                "tags_encryption_tag": tags_tag,
            }
        )
    if proposed_tags_changed:
        proposed_ciphertext, proposed_nonce, proposed_tag = encrypt(proposed_tags, token)
        update_payload.update(
            {
                "proposed_tags": proposed_ciphertext,
                "proposed_tags_encryption_nonce": proposed_nonce,
                "proposed_tags_encryption_tag": proposed_tag,
            }
        )
    if not update_payload:
        raise RuntimeError("Changed note produced no database update fields")

    with begin_writer() as connection:
        if content_changed:
            db_update_note_fields(
                connection,
                note_id,
                updated_at=updated_at,
                **update_payload,
            )
        else:
            db_update_note_fields_preserving_updated_at(
                connection,
                note_id,
                **update_payload,
            )

    if content_changed:
        cache_note(note_id, sanitized_content)
        cache_note_text(note_id, strip_html(sanitized_content))
    if tags_changed:
        cache_note_tags(note_id, tags)
    if proposed_tags_changed:
        cache_note_proposed_tags(note_id, proposed_tags)
    store.update_note_sources(
        note_id,
        sanitized_content,
        tags,
        proposed_tags,
        updated_at=updated_at,
    )


@dataclass
class CmdUpdateContent(QueryCommand):
    note_id: str
    content: str
    tags: str
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdUpdateContent(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        # Capture previous plaintext for undo recording
        record = store.get(self.note_id)
        prev = record.content
        prev_tags = record.tags
        sanitized_content = sanitize_note_html(self.content)
        apply_update_content(self.note_id, sanitized_content, self.tags, self.token)

        # Record in undo stack
        # Deferred: undo_state imports this module's apply function to replay operations.
        from app.services.undo_state import record_update
        record_update(
            self.client_id,
            self.undo_context,
            self.note_id,
            before=prev,
            after=sanitized_content,
            before_tags=prev_tags,
            after_tags=self.tags,
            viewport=self.viewport,
        )
        record_explicit_tag_additions(
            before_tags=prev_tags,
            after_tags=self.tags,
            token=self.token,
            interacted_on=current_local_date(),
        )

        update_uuid = generate_new_uuid()
        return {"status": "success", "updateUUID": update_uuid}
