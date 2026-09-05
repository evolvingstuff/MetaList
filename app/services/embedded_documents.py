"""Typed, namespace-local editable documents shared by embedded widget editors."""
from __future__ import annotations

from base64 import b64encode
from copy import deepcopy
from html import escape
import json
from uuid import UUID, uuid4
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.db.session import after_request_commit, begin_writer
from app.security.encryption import get_encryption_service, is_encryption_required


class Rectangle(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=80)
    x: float = Field(ge=0, le=720, allow_inf_nan=False)
    y: float = Field(ge=0, le=440, allow_inf_nan=False)
    label: str = Field(max_length=120)


class DiagramSource(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    rectangles: list[Rectangle] = Field(max_length=200)

    @model_validator(mode="after")
    def validate_ids(self):
        ids = [rect.id for rect in self.rectangles]
        if len(ids) != len(set(ids)):
            raise ValueError("Rectangle IDs must be unique")
        return self


class DocumentPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: Literal["diagram"]
    version: Literal[1]
    source: DiagramSource


# New kinds add a validator and renderer here; identity/storage/copy remain shared.
def validate_document(payload: dict) -> dict:
    return DocumentPayload.model_validate(payload).model_dump()


class EmbeddedDocumentStore:
    def __init__(self) -> None:
        self.documents: dict[str, dict] = {}
        self.encrypted: dict[str, tuple] = {}

    def reset(self) -> None:
        self.documents.clear()
        self.encrypted.clear()

    def bootstrap(self, *, connection) -> None:
        self.reset()
        rows = connection.execute("SELECT id, payload, nonce, tag FROM embedded_documents").fetchall()
        for row in rows:
            document_id = row["id"]
            assert str(UUID(document_id)) == document_id
            if (row["nonce"] is None) != (row["tag"] is None):
                raise RuntimeError("Incomplete embedded document encryption metadata")
            if row["nonce"] is not None:
                self.encrypted[document_id] = (row["payload"], row["nonce"], row["tag"])
            else:
                self.documents[document_id] = self._decode(document_id, row["payload"])

    def _decode(self, document_id: str, serialized: str) -> dict:
        envelope = json.loads(serialized)
        if envelope["id"] != document_id:
            raise ValueError("Embedded document identity mismatch")
        return validate_document(envelope["document"])

    def ensure_decrypted(self, *, token: str) -> None:
        if not self.encrypted:
            return
        service = get_encryption_service()
        if service is None or service.dek is None:
            raise RuntimeError("Embedded documents require an unlocked namespace")
        decrypted = {}
        for document_id, fields in self.encrypted.items():
            decrypted[document_id] = self._decode(document_id, service.decrypt_from_storage(*fields))
        self.documents.update(decrypted)
        self.encrypted.clear()

    def has(self, document_id: str) -> bool:
        if document_id in self.documents:
            return True
        return document_id in self.encrypted

    def get(self, document_id: str) -> dict:
        if document_id in self.encrypted:
            raise RuntimeError("Embedded document accessed before namespace hydration")
        return deepcopy(self.documents[document_id])

    def put(self, document_id: str, payload: dict) -> None:
        assert str(UUID(document_id)) == document_id
        document = validate_document(payload)
        service = get_encryption_service()
        if is_encryption_required() and (service is None or service.dek is None):
            raise RuntimeError("Embedded document persistence requires an unlocked namespace")
        with begin_writer() as connection:
            self._write(connection, document_id, document, service, not is_encryption_required())
        after_request_commit(lambda: self.documents.__setitem__(document_id, document))

    def create(self, payload: dict) -> str:
        document_id = str(uuid4())
        assert not self.has(document_id)
        self.put(document_id, payload)
        return document_id

    def _write(self, connection, document_id, document, service, force_plaintext):
        serialized = json.dumps({"id": document_id, "document": document}, separators=(",", ":"))
        fields = (serialized, None, None)
        if not force_plaintext:
            if service is None or service.dek is None:
                raise RuntimeError("Embedded document encryption requires an active DEK")
            fields = service.encrypt_for_storage(serialized)
        connection.execute(
            "INSERT INTO embedded_documents(id, payload, nonce, tag) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, nonce=excluded.nonce, tag=excluded.tag",
            (document_id, *fields),
        )

    def rewrite_storage(self, *, connection, encryption_service, force_plaintext: bool) -> None:
        self.ensure_decrypted(token="")
        for document_id, document in self.documents.items():
            self._write(connection, document_id, document, encryption_service, force_plaintext)


document_store = EmbeddedDocumentStore()


def render_diagram_svg(document: dict) -> str:
    source = validate_document(document)["source"]
    shapes = []
    for rect in source["rectangles"]:
        x, y = rect["x"], rect["y"]
        shapes.append(
            f'<rect x="{x}" y="{y}" width="160" height="80" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>'
            f'<text x="{x + 80}" y="{y + 44}" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#172337">{escape(rect["label"])}</text>'
        )
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 540"><rect width="900" height="540" fill="#fff"/>' + ''.join(shapes) + '</svg>'


def render_document(document_id: str, *, token: str, static_export: bool) -> str:
    document = document_store.get(document_id)
    svg = render_diagram_svg(document)
    image = 'data:image/svg+xml;base64,' + b64encode(svg.encode()).decode()
    preview = f'<img src="{image}" alt="Diagram" draggable="false">'
    if static_export:
        return preview
    return (
        f'<span class="embedded-document" contenteditable="false" data-document-id="{escape(document_id)}" '
        f'data-document-token="{escape(token)}" role="button" tabindex="0" aria-label="Edit diagram" title="Edit diagram">'
        f'{preview}</span>'
    )
