from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from app.api.request_auth import require_request_auth_token
from app.api.transactions import transactional_route
from app.services.embedded_documents import DocumentPayload, document_store, validate_document
from app.services.store import store
from app.services.undo_state import _normalize_viewport_snapshot
from app.security.note_html import sanitize_note_html
from app.usecases.embedded_documents import INSERT_MARKER, attach_document, save_document


router = APIRouter(prefix="/documents", tags=["embedded-documents"])


class DocumentMutation(BaseModel):
    clientId: str = Field(min_length=1)
    undoContext: str = Field(min_length=1)
    viewport: dict
    note_id: str
    document: DocumentPayload

    @field_validator("viewport")
    @classmethod
    def validate_viewport(cls, viewport: dict) -> dict:
        # Validate before persistence, not in the post-commit undo callback.
        return _normalize_viewport_snapshot(viewport)


class DocumentInsertion(DocumentMutation):
    expected_content: str
    content: str
    search_query: str


class DocumentUpdate(DocumentMutation):
    expected_document: DocumentPayload


@router.get("/note-source/{note_id}")
def read_document_note_source(note_id: str) -> dict:
    if not store.contains(note_id):
        raise HTTPException(status_code=404, detail="Note no longer exists")
    return {"content": store.get(note_id).content}


@router.get("/{document_id}")
def read_document(document_id: str) -> dict:
    if not document_store.has(document_id):
        raise HTTPException(status_code=404, detail="Diagram no longer exists")
    return document_store.get(document_id)


@router.post("/in-note")
@transactional_route
def insert_document(request: Request, payload: DocumentInsertion) -> dict:
    token = require_request_auth_token(request)
    content = sanitize_note_html(payload.content)
    if content.count(INSERT_MARKER) != 1:
        raise HTTPException(status_code=422, detail="Insertion requires exactly one diagram position")
    if payload.note_id:
        if not store.contains(payload.note_id):
            raise HTTPException(status_code=404, detail="Note no longer exists")
        if store.get(payload.note_id).content != sanitize_note_html(payload.expected_content):
            raise HTTPException(status_code=409, detail="Note changed while the diagram editor was open")
    document = validate_document(payload.document.model_dump())
    return attach_document(
        note_id=payload.note_id, expected_content=sanitize_note_html(payload.expected_content), content=content,
        document=document, search_query=payload.search_query, token=token,
        client_id=payload.clientId, undo_context=payload.undoContext, viewport=payload.viewport,
    )


@router.put("/{document_id}")
@transactional_route
def update_document(document_id: str, request: Request, payload: DocumentUpdate) -> dict:
    require_request_auth_token(request)
    if not document_store.has(document_id) or not store.contains(payload.note_id):
        raise HTTPException(status_code=404, detail="Diagram or containing note no longer exists")
    if document_store.get(document_id) != payload.expected_document.model_dump():
        raise HTTPException(status_code=409, detail="Diagram changed while the editor was open; cancel and reopen it")
    document = validate_document(payload.document.model_dump())
    save_document(document_id=document_id, document=document, note_id=payload.note_id,
                  client_id=payload.clientId, undo_context=payload.undoContext, viewport=payload.viewport)
    return {"document_id": document_id, "note_id": payload.note_id}
