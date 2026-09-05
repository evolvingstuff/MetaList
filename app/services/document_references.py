"""Serialization and clipboard integration for embedded editable documents."""
from __future__ import annotations

from copy import deepcopy

from app.services.embedded_documents import document_store, render_document
from app.services.embedded_references import collect_reference_tokens_from_html


def render_editable_documents(content: str) -> str:
    for token in reversed(collect_reference_tokens_from_html(content)):
        if document_store.has(token.note_id):
            original = content[token.start:token.end]
            content = content[:token.start] + render_document(token.note_id, token=original, static_export=False) + content[token.end:]
    return content


def snapshot_documents(records: list) -> list:
    snapshot = deepcopy(records)
    for record in snapshot:
        record["embedded_documents"] = {
            token.note_id: document_store.get(token.note_id)
            for token in collect_reference_tokens_from_html(record["content"])
            if document_store.has(token.note_id)
        }
    return snapshot


def clone_clipboard_documents(snapshot: list) -> list:
    """One clone per distinct source in this paste; never traverse note refs."""
    documents = {}
    for record in snapshot:
        # Older/manual internal clipboard producers can contain no document snapshot.
        if "embedded_documents" in record:
            for document_id, payload in record["embedded_documents"].items():
                if document_id in documents and documents[document_id] != payload:
                    raise ValueError("Clipboard contains conflicting document snapshots")
                documents[document_id] = payload
    id_map = {document_id: document_store.create(payload) for document_id, payload in documents.items()}
    cloned = deepcopy(snapshot)
    for record in cloned:
        content = record["content"]
        for token in reversed(collect_reference_tokens_from_html(content)):
            if token.note_id in id_map:
                prefix = ""
                if token.is_embed:
                    prefix = "!"
                replacement = prefix + "[[" + id_map[token.note_id] + "]]"
                content = content[:token.start] + replacement + content[token.end:]
        record["content"] = content
    return cloned
