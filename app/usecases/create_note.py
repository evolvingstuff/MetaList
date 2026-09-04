from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Dict, Optional
import uuid

from app.usecases.base import QueryCommand
from app.services.undo_state import record_create
from app.usecases.search_comment_autofill import compute_initial_tags_for_new_note
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.content_cache import (
    cache_note,
    cache_note_proposed_tags,
    cache_note_tags,
    cache_note_text,
)

from app.db.session import begin_writer
from app.db.notes_sql import insert_note as db_insert_note
from app.db.notes_sql import update_links_preserving_updated_at as db_update_links_preserving_updated_at
from app.security.encryption import encrypt
from app.security.note_html import sanitize_note_html
from app.utils.text_utils import strip_html


def apply_insert_note(
    note_id: str,
    parent_id: Optional[str],
    prev_id: Optional[str],
    next_id: Optional[str],
    token: str,
    *,
    content: str,
    tags: str,
    proposed_tags: str,
) -> None:
    if not isinstance(content, str):
        raise TypeError("content must be a string")
    sanitized_content = sanitize_note_html(content)
    ciphertext, nonce, tag = encrypt(sanitized_content, token)
    tags_ciphertext, tags_nonce, tags_tag = encrypt(tags, token)
    proposed_tags_ciphertext, proposed_tags_nonce, proposed_tags_tag = encrypt(
        proposed_tags,
        token,
    )
    now = datetime.now(timezone.utc)
    with begin_writer() as connection:
        db_insert_note(
            connection,
            note_id=note_id,
            content=ciphertext,
            encryption_nonce=nonce,
            encryption_tag=tag,
            tags=tags_ciphertext,
            tags_encryption_nonce=tags_nonce,
            tags_encryption_tag=tags_tag,
            proposed_tags=proposed_tags_ciphertext,
            proposed_tags_encryption_nonce=proposed_tags_nonce,
            proposed_tags_encryption_tag=proposed_tags_tag,
            parent_id=parent_id,
            prev_id=prev_id,
            next_id=next_id,
            is_collapsed=False,
            created_at=now,
            updated_at=now,
        )
        if prev_id:
            db_update_links_preserving_updated_at(connection, prev_id, next_id=note_id)
        if next_id:
            db_update_links_preserving_updated_at(connection, next_id, prev_id=note_id)

    cache_note(note_id, sanitized_content)
    cache_note_tags(note_id, tags)
    cache_note_proposed_tags(note_id, proposed_tags)
    cache_note_text(note_id, strip_html(sanitized_content))
    store.insert_after(
        SimpleNamespace(
            id=note_id,
            content=sanitized_content,
            tags=tags,
            proposed_tags=proposed_tags,
            is_collapsed=False,
            created_at=now,
            updated_at=now,
        ),
        parent_id=parent_id,
        prev_id=prev_id,
    )


def build_created_note_undo_record(note_id: str) -> Dict[str, object]:
    if not isinstance(note_id, str) or not note_id:
        raise TypeError("note_id must be a non-empty string")
    record = store.get(note_id)
    if record.id != note_id:
        raise RuntimeError(
            f"Created note lookup returned mismatched id: expected={note_id} actual={record.id}"
        )
    if not isinstance(record.content, str):
        raise TypeError(f"Created note content must be a string: note_id={note_id}")
    if not isinstance(record.tags, str):
        raise TypeError(f"Created note tags must be a string: note_id={note_id}")
    if not isinstance(record.proposed_tags, str):
        raise TypeError(f"Created note proposed_tags must be a string: note_id={note_id}")
    if not isinstance(record.is_collapsed, bool):
        raise TypeError(f"Created note is_collapsed must be a boolean: note_id={note_id}")
    if not isinstance(record.created_at, datetime):
        raise TypeError(f"Created note created_at must be a datetime: note_id={note_id}")
    if not isinstance(record.updated_at, datetime):
        raise TypeError(f"Created note updated_at must be a datetime: note_id={note_id}")
    for field_name in ("parent_id", "prev_id", "next_id"):
        value = getattr(record, field_name)
        if value is not None and (not isinstance(value, str) or not value):
            raise TypeError(
                f"Created note {field_name} must be a non-empty string or None: note_id={note_id}"
            )
    return {
        "id": record.id,
        "parent_id": record.parent_id,
        "prev_id": record.prev_id,
        "next_id": record.next_id,
        "is_collapsed": record.is_collapsed,
        "content": record.content,
        "tags": record.tags,
        "proposed_tags": record.proposed_tags,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
    }


@dataclass
class CmdCreateNote(QueryCommand):
    first_visible_note_id: Optional[str]
    search_query: Optional[str]
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdCreateNote(client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        siblings = store.children(None)
        next_id = None
        prev_id = None
        if self.first_visible_note_id and self.first_visible_note_id in siblings:
            idx = siblings.index(self.first_visible_note_id)
            next_id = self.first_visible_note_id
            if idx > 0:
                prev_id = siblings[idx - 1]
            else:
                prev_id = None
        else:
            next_id = None
            if siblings:
                next_id = siblings[0]
            prev_id = None


        note_uuid = str(uuid.uuid4())
        content = ""
        tags = compute_initial_tags_for_new_note(
            parent_id=None,
            search_query=self.search_query,
        )

        apply_insert_note(
            note_uuid,
            None,
            prev_id,
            next_id,
            self.token,
            content=content,
            tags=tags,
            proposed_tags="",
        )

        # Record for undo (delete on undo).
        rec = build_created_note_undo_record(note_uuid)
        record_create(self.client_id, self.undo_context, rec, viewport=self.viewport)

        update_uuid = generate_new_uuid()
        return {"id": note_uuid, "status": "created", "updateUUID": update_uuid}
