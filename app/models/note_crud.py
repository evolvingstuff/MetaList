from typing import Optional
import time
from types import SimpleNamespace
from datetime import datetime, timezone

from app.db.notes_sql import (
    delete_notes,
    fetch_children_ordered,
    fetch_note,
    insert_note,
    update_links_preserving_updated_at,
    update_note_content,
)
from app.models.database import SafeSession
from ..utils.encryption import encrypt
from ..services.content_cache import (
    cache_note,
    cache_note_proposed_tags,
    cache_note_tags,
    cache_note_text,
    remove_cached_note,
)
from app.utils.text_utils import strip_html
from ..services.note_store import store as note_store
from app.security.note_html import sanitize_note_html


class NoteCRUD:
    """Handles CRUD operations for notes"""
    
    @staticmethod
    def create_note_top(db: SafeSession, note_id: str, parent_id: Optional[str]) -> None:
        """Create a new note and insert it as the new head of the linked list"""
        if note_id is None:
            raise ValueError("Note ID must be specified")

        next_id = None
        if note_store.loaded:
            siblings = note_store.get_children(parent_id)
            if siblings:
                next_id = siblings[0]
        else:
            with SafeSession.allow_reads("notecrud:create_note_top:first_sibling"):
                ordered = fetch_children_ordered(db.connection(), parent_id)
            if ordered:
                next_id = ordered[0]["id"]

        plaintext = ""
        content_text = strip_html(plaintext)
        ciphertext, nonce, tag = encrypt(plaintext, "")
        tags_ciphertext, tags_nonce, tags_tag = encrypt("", "")
        proposed_tags_ciphertext, proposed_tags_nonce, proposed_tags_tag = encrypt("", "")
        timestamp = datetime.now(timezone.utc)

        insert_note(
            db.connection(),
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
            prev_id=None,
            next_id=next_id,
            is_collapsed=False,
            created_at=timestamp,
            updated_at=timestamp,
        )

        cache_note(note_id, plaintext)
        cache_note_tags(note_id, "")
        cache_note_proposed_tags(note_id, "")
        cache_note_text(note_id, content_text)

        if next_id:
            update_links_preserving_updated_at(
                db.connection(),
                next_id,
                prev_id=note_id,
            )

        if note_store.loaded:
            note_store.add_note_from_db(
                SimpleNamespace(
                    id=note_id,
                    content=ciphertext,
                    encryption_nonce=nonce,
                    encryption_tag=tag,
                    tags=tags_ciphertext,
                    proposed_tags=proposed_tags_ciphertext,
                    tags_encryption_nonce=tags_nonce,
                    tags_encryption_tag=tags_tag,
                    parent_id=parent_id,
                    prev_id=None,
                    next_id=next_id,
                    is_collapsed=False,
                    created_at=timestamp,
                    updated_at=timestamp,
                ),
                plaintext,
                "",
                "",
            )
            if next_id:
                sibling_record = note_store.get_note(next_id)
                note_store.update_metadata_from_db(
                    SimpleNamespace(
                        id=next_id,
                        parent_id=sibling_record.parent_id,
                        prev_id=note_id,
                        next_id=sibling_record.next_id,
                        created_at=sibling_record.created_at,
                        updated_at=sibling_record.updated_at,
                        is_collapsed=sibling_record.is_collapsed,
                    ),
                    rebuild=True,
                )

    @staticmethod
    def get_note(db: SafeSession, note_id: str) -> SimpleNamespace:
        if note_store.loaded:
            record = note_store.get_note(note_id)
            return SimpleNamespace(
                id=record.id,
                content=record.content,
                parent_id=record.parent_id,
                prev_id=record.prev_id,
                next_id=record.next_id,
                is_collapsed=record.is_collapsed,
                created_at=record.created_at,
                updated_at=record.updated_at,
                encryption_nonce=None,
                encryption_tag=None,
            )

        with SafeSession.allow_reads("notecrud:get_note"):
            row = fetch_note(db.connection(), note_id)
        if not row:
            raise ValueError(f"Note with id {note_id} not found")
        return SimpleNamespace(
            id=row["id"],
            content=row["content"],
            parent_id=row["parent_id"],
            prev_id=row["prev_id"],
            next_id=row["next_id"],
            is_collapsed=row["is_collapsed"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            encryption_nonce=row["encryption_nonce"],
            encryption_tag=row["encryption_tag"],
        )

    @staticmethod
    def update_note(db: SafeSession, note_id: str, content: str):
        record = None
        if note_store.loaded:
            record = note_store.get_note(note_id)
        else:
            record = NoteCRUD.get_note(db, note_id)

        sanitized_content = sanitize_note_html(content)
        ciphertext, nonce, tag = encrypt(sanitized_content, "")
        timestamp = datetime.now(timezone.utc)

        update_note_content(
            db.connection(),
            note_id,
            content=ciphertext,
            encryption_nonce=nonce,
            encryption_tag=tag,
            updated_at=timestamp,
        )

        cache_note(note_id, sanitized_content)
        cache_note_text(note_id, strip_html(sanitized_content))

        if note_store.loaded:
            note_store.update_note_from_db(
                SimpleNamespace(
                    id=record.id,
                    parent_id=record.parent_id,
                    prev_id=record.prev_id,
                    next_id=record.next_id,
                    is_collapsed=record.is_collapsed,
                    created_at=record.created_at,
                    updated_at=timestamp,
                ),
                sanitized_content,
                record.tags,
                record.proposed_tags,
            )

    @staticmethod
    def delete_note(db: SafeSession, note_id: str) -> None:
        """Delete a note and ALL its descendants, updating surrounding links"""
        if note_store.loaded:
            print(f"[notes.delete] store branch note_id={note_id}")
            record = note_store.get_note(note_id)

            ids_to_delete = _collect_descendants_from_store(note_id)
            print(f"[notes.delete] ids_to_delete count={len(ids_to_delete)}")

            timings: dict[str, float] = {}

            neighbor_start = time.perf_counter()
            if record.prev_id:
                update_links_preserving_updated_at(
                    db.connection(),
                    record.prev_id,
                    next_id=record.next_id,
                )


            if record.next_id:
                update_links_preserving_updated_at(
                    db.connection(),
                    record.next_id,
                    prev_id=record.prev_id,
                )
            timings["neighbor_updates_ms"] = (time.perf_counter() - neighbor_start) * 1000
            note_store.debug_validate_links(record.prev_id, record.next_id, record.parent_id)

            delete_start = time.perf_counter()
            delete_notes(db.connection(), ids_to_delete)
            timings["delete_notes_ms"] = (time.perf_counter() - delete_start) * 1000
            print("[notes.delete] delete_notes complete")

            for to_remove in ids_to_delete:
                remove_cached_note(to_remove)

            remove_start = time.perf_counter()
            note_store.remove_note(note_id)
            timings["store_remove_ms"] = (time.perf_counter() - remove_start) * 1000
            print("[notes.delete] note_store.remove_note complete")
            print(
                f"[notes.delete] store timings note_id={note_id} metrics={timings}"
            )
            note_store.debug_validate_links(record.prev_id, record.next_id, record.parent_id)
            return

        with SafeSession.allow_reads("notecrud:delete_note:root"):
            note = fetch_note(db.connection(), note_id)
        if not note:
            raise ValueError(f"Note {note_id} not found")

        def get_all_descendant_ids(parent_id: str) -> set[str]:
            descendants = set()
            with SafeSession.allow_reads("notecrud:delete_note:children"):
                children = fetch_children_ordered(db.connection(), parent_id)
            for child in children:
                child_id = child["id"]
                descendants.add(child_id)
                descendants.update(get_all_descendant_ids(child_id))
            return descendants

        descendant_ids = get_all_descendant_ids(note_id)
        for descendant_id in descendant_ids:
            delete_notes(db.connection(), [descendant_id])
            remove_cached_note(descendant_id)

        prev_id = note["prev_id"]
        next_id = note["next_id"]
        if prev_id:
            update_links_preserving_updated_at(
                db.connection(),
                prev_id,
                next_id=next_id,
            )
        if next_id:
            update_links_preserving_updated_at(
                db.connection(),
                next_id,
                prev_id=prev_id,
            )

        delete_notes(db.connection(), [note_id])
        remove_cached_note(note_id)


def _collect_descendants_from_store(root_id: str) -> list[str]:
    stack = [root_id]
    result = []
    while stack:
        current = stack.pop()
        result.append(current)
        stack.extend(note_store.get_children(current))
    return result
