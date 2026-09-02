from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Dict, List

from app.usecases.base import QueryCommand
from app.services.store import store, NodeRecord
from app.services.sync import generate_new_uuid

from app.db.session import begin_writer
from app.db.notes_sql import (
    delete_notes as db_delete_notes,
    insert_note as db_insert_note,
    update_links_preserving_updated_at as db_update_links_preserving_updated_at,
)
from app.security.encryption import encrypt
from app.security.note_html import sanitize_note_html


def _collect_subtree_ids(root_id: str) -> List[str]:
    ids: List[str] = []
    stack: List[str] = [root_id]
    seen: set[str] = set()
    while stack:
        nid = stack.pop()
        if nid in seen:
            continue
        seen.add(nid)
        ids.append(nid)
        for cid in store.children(nid):
            stack.append(cid)
    return ids


def _snapshot_subtree(root_id: str) -> List[NodeRecord]:
    out: List[NodeRecord] = []
    for nid in _collect_subtree_ids(root_id):
        out.append(store.get(nid))
    return out


def apply_delete_subtree(note_id: str) -> None:
    # Validate existence and compute neighbors
    rec = store.get(note_id)
    parent_id = rec.parent_id
    siblings = store.children(parent_id)
    if note_id not in siblings:
        raise RuntimeError(
            "Integrity failure: delete target missing from siblings list: "
            f"note_id={note_id} parent_id={parent_id}"
        )
    idx = siblings.index(note_id)
    if idx > 0:
        prev_id = siblings[idx - 1]
    else:
        prev_id = None
    if idx + 1 < len(siblings):
        next_id = siblings[idx + 1]
    else:
        next_id = None

    ids_to_delete = _collect_subtree_ids(note_id)

    with begin_writer() as connection:
        # Relink neighbors
        if prev_id:
            db_update_links_preserving_updated_at(connection, prev_id, next_id=next_id)
        if next_id:
            db_update_links_preserving_updated_at(connection, next_id, prev_id=prev_id)
        # Delete subtree
        db_delete_notes(connection, ids_to_delete)

    # Update in-memory store after commit
    store.delete_subtree(note_id)


def apply_restore_records(records: List[NodeRecord], token: str) -> None:
    # Reinsert records in preorder; rely on stored prev/next pointers
    # Insert in DB
    sanitized_records: List[NodeRecord] = []
    with begin_writer() as connection:
        now = datetime.now(timezone.utc)
        for rec in records:
            assert isinstance(rec.content, str)
            assert isinstance(rec.tags, str)
            created_at = rec.created_at
            if created_at is None:
                created_at = now
            if not isinstance(created_at, datetime):
                raise TypeError(f"Restored note created_at must be a datetime: note_id={rec.id}")
            updated_at = rec.updated_at
            if updated_at is None:
                updated_at = now
            if not isinstance(updated_at, datetime):
                raise TypeError(f"Restored note updated_at must be a datetime: note_id={rec.id}")
            sanitized_content = sanitize_note_html(rec.content)
            if isinstance(rec, NodeRecord):
                sanitized_record = replace(
                    rec,
                    content=sanitized_content,
                    created_at=created_at,
                    updated_at=updated_at,
                )
            else:
                record_values = vars(rec).copy()
                record_values["content"] = sanitized_content
                record_values["created_at"] = created_at
                record_values["updated_at"] = updated_at
                sanitized_record = SimpleNamespace(**record_values)
            sanitized_records.append(sanitized_record)
            ciphertext, nonce, tag = encrypt(sanitized_content, token)
            tags_ciphertext, tags_nonce, tags_tag = encrypt(rec.tags, token)
            db_insert_note(
                connection,
                note_id=rec.id,
                content=ciphertext,
                encryption_nonce=nonce,
                encryption_tag=tag,
                tags=tags_ciphertext,
                tags_encryption_nonce=tags_nonce,
                tags_encryption_tag=tags_tag,
                parent_id=rec.parent_id,
                prev_id=rec.prev_id,
                next_id=rec.next_id,
                is_collapsed=rec.is_collapsed,
                created_at=created_at,
                updated_at=updated_at,
            )
            # Update neighbor links around this node
            if rec.prev_id:
                db_update_links_preserving_updated_at(connection, rec.prev_id, next_id=rec.id)
            if rec.next_id:
                db_update_links_preserving_updated_at(connection, rec.next_id, prev_id=rec.id)

    # Update in-memory store after commit
    store.restore_subtree(sanitized_records)


@dataclass
class CmdDeleteSubtree(QueryCommand):
    note_id: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdDeleteSubtree(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        # Snapshot before delete for undo
        snapshot = _snapshot_subtree(self.note_id)
        apply_delete_subtree(self.note_id)

        # Record for undo
        from app.services.undo_state import record_delete
        record_delete(self.client_id, self.undo_context, snapshot, viewport=self.viewport)

        update_uuid = generate_new_uuid()
        return {"status": "success", "updateUUID": update_uuid}
