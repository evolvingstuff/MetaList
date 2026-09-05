"""Attach and save editable documents through the note transaction boundary."""
from __future__ import annotations

from uuid import uuid4

from app.db.session import after_request_commit
from app.services.embedded_documents import document_store
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.undo_state import record_create, record_document_update, record_update
from app.usecases.create_note import apply_insert_note, build_created_note_undo_record
from app.usecases.search_comment_autofill import compute_initial_tags_for_new_note
from app.usecases.update_content import apply_update_content


INSERT_MARKER = "![[NEW-DOCUMENT]]"


def attach_document(*, note_id, expected_content, content, document, search_query, token, client_id, undo_context, viewport):
    assert content.count(INSERT_MARKER) == 1
    document_id = document_store.create(document)
    content = content.replace(INSERT_MARKER, "![[" + document_id + "]]")
    if note_id:
        note = store.get(note_id)
        assert note.content == expected_content
        tags = note.tags
        apply_update_content(note_id, content, tags, token)
        after_request_commit(lambda: record_update(
            client_id, undo_context, note_id, before=expected_content, after=content,
            before_tags=tags, after_tags=tags, viewport=viewport,
        ))
    else:
        note_id = str(uuid4())
        children = store.children(None)
        next_id = None
        if children:
            next_id = children[0]
        tags = compute_initial_tags_for_new_note(parent_id=None, search_query=search_query)
        apply_insert_note(note_id, None, None, next_id, token, content=content, tags=tags, proposed_tags="")
        record = build_created_note_undo_record(note_id)
        after_request_commit(lambda: record_create(client_id, undo_context, record, viewport=viewport))
    after_request_commit(generate_new_uuid)
    return {"note_id": note_id, "document_id": document_id}


def save_document(*, document_id, document, note_id, client_id, undo_context, viewport):
    before = document_store.get(document_id)
    if before == document:
        return
    document_store.put(document_id, document)
    after_request_commit(lambda: record_document_update(
        client_id, undo_context, note_id=note_id, document_id=document_id,
        before=before, after=document, viewport=viewport,
    ))
    after_request_commit(generate_new_uuid)
