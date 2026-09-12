"""Encrypted file storage and reference helpers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import uuid
from typing import Optional

from app.upload_limits import MAX_ATTACHMENT_BYTES
from app.db.file_session import begin_file_writer, connect_file_reader, resolve_file_database_path
from app.db.files_sql import (
    delete_files,
    fetch_all_file_ids,
    fetch_all_file_metadata,
    fetch_file_metadata,
    require_file_size,
    fetch_file,
    insert_file,
    update_file_storage_fields,
)
from app.models.database import SafeSession
from app.security.encryption import (
    get_encryption_service,
    get_encryption_service_with_token,
    is_encryption_required,
)
from app.services.embedded_references import collect_reference_tokens_from_html
from app.services.file_registry import file_registry
from app.services.note_store import store as note_store

_ALLOWED_THUMBNAIL_KINDS = {"pdf", "image", "audio", "video", "text", "archive", "other"}


@dataclass(frozen=True)
class FileReferenceRecord:
    id: str
    title: str
    original_filename: str
    mime_type: str
    size_bytes: int
    thumbnail_kind: str
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class DownloadedFile:
    record: FileReferenceRecord
    content_bytes: bytes


@dataclass(frozen=True)
class TrimUnusedFilesResult:
    deleted_count: int
    deleted_file_ids: list[str]


def resolve_live_file_database_path() -> Path:
    if bool(SafeSession._use_memory):  # type: ignore[attr-defined]
        raise RuntimeError("File database path is unavailable when using the in-memory notes database")
    note_path = SafeSession._db_path  # type: ignore[attr-defined]
    return resolve_file_database_path(note_path)


def bootstrap_file_registry() -> set[str]:
    with begin_file_writer():
        pass
    with connect_file_reader() as connection:
        rows = fetch_all_file_metadata(connection)
    file_ids: set[str] = set()
    thumbnail_kinds_by_id: dict[str, str] = {}
    encryption_service = _resolve_encryption_service(None)
    can_decrypt_encrypted_metadata = _coerce_encryption_service(encryption_service) is not None
    for row in rows:
        file_id = row["id"]
        if not isinstance(file_id, str) or file_id == "":
            raise TypeError(f"files.id must be a non-empty string, got {file_id!r}")
        file_ids.add(file_id)
        metadata_has_encryption = _field_has_encryption(
            nonce=row["metadata_encryption_nonce"],
            tag=row["metadata_encryption_tag"],
            file_id=file_id,
            field_name="metadata_json",
        )
        if metadata_has_encryption and not can_decrypt_encrypted_metadata:
            file_ids = set()
            for id_row in rows:
                row_file_id = id_row["id"]
                if not isinstance(row_file_id, str) or row_file_id == "":
                    raise TypeError(f"files.id must be a non-empty string, got {row_file_id!r}")
                file_ids.add(row_file_id)
            file_registry.replace_all(file_ids)
            return file_ids
        metadata_json = _decrypt_text_field(
            encryption_service=encryption_service,
            value=row["metadata_json"],
            nonce=row["metadata_encryption_nonce"],
            tag=row["metadata_encryption_tag"],
            field_name="metadata_json",
            file_id=file_id,
        )
        metadata = _parse_file_metadata(metadata_json, file_id=file_id)
        thumbnail_kind = metadata["thumbnail_kind"]
        if not isinstance(thumbnail_kind, str) or thumbnail_kind == "":
            raise TypeError(f"files.metadata_json thumbnail_kind invalid for file {file_id}")
        thumbnail_kinds_by_id[file_id] = thumbnail_kind
    if len(thumbnail_kinds_by_id) == len(file_ids):
        file_registry.replace_all_with_thumbnail_kinds(thumbnail_kinds_by_id)
    else:
        file_registry.replace_all(file_ids)
    return file_ids


def create_file(
    *,
    original_filename: str,
    mime_type: str,
    content_bytes: bytes,
    token: str,
) -> FileReferenceRecord:
    if not isinstance(original_filename, str) or original_filename == "":
        raise TypeError("original_filename must be a non-empty string")
    if not isinstance(mime_type, str) or mime_type == "":
        raise TypeError("mime_type must be a non-empty string")
    if not isinstance(content_bytes, bytes):
        raise TypeError(f"content_bytes must be bytes, got {type(content_bytes)}")
    if not isinstance(token, str) or token == "":
        raise TypeError("token must be a non-empty string")

    if len(content_bytes) > MAX_ATTACHMENT_BYTES:
        raise ValueError("Attachment exceeds the configured size limit")

    file_id = _generate_unique_file_id()
    title = Path(original_filename).name
    if title == "":
        raise ValueError("original_filename must resolve to a non-empty basename")

    metadata = {
        "original_filename": title,
        "mime_type": mime_type,
        "size_bytes": len(content_bytes),
        "thumbnail_kind": _derive_thumbnail_kind(mime_type=mime_type, original_filename=title),
    }
    metadata_json = json.dumps(metadata, separators=(",", ":"), ensure_ascii=False)

    encryption_service = _resolve_encryption_service(token)
    encrypted_title, title_nonce, title_tag = _encrypt_text_for_storage(
        encryption_service=encryption_service,
        plaintext=title,
    )
    encrypted_metadata, metadata_nonce, metadata_tag = _encrypt_text_for_storage(
        encryption_service=encryption_service,
        plaintext=metadata_json,
    )
    encrypted_blob, blob_nonce, blob_tag = _encrypt_bytes_for_storage(
        encryption_service=encryption_service,
        plaintext=content_bytes,
    )

    now = datetime.now(timezone.utc)
    with begin_file_writer() as connection:
        insert_file(
            connection,
            file_id=file_id,
            title=encrypted_title,
            title_encryption_nonce=title_nonce,
            title_encryption_tag=title_tag,
            metadata_json=encrypted_metadata,
            metadata_encryption_nonce=metadata_nonce,
            metadata_encryption_tag=metadata_tag,
            blob_data=encrypted_blob,
            blob_encryption_nonce=blob_nonce,
            blob_encryption_tag=blob_tag,
            created_at=now,
            updated_at=now,
        )

    file_registry.add_with_thumbnail_kind(file_id, thumbnail_kind=metadata["thumbnail_kind"])
    return FileReferenceRecord(
        id=file_id,
        title=title,
        original_filename=metadata["original_filename"],
        mime_type=metadata["mime_type"],
        size_bytes=metadata["size_bytes"],
        thumbnail_kind=metadata["thumbnail_kind"],
        created_at=now,
        updated_at=now,
    )


def get_file_reference_record(file_id: str, token: Optional[str]) -> FileReferenceRecord:
    if not isinstance(file_id, str) or file_id == "":
        raise TypeError("file_id must be a non-empty string")

    encryption_service = _resolve_encryption_service(token)
    with connect_file_reader() as connection:
        row = fetch_file_metadata(connection, file_id)
    if row is None:
        raise KeyError(f"File {file_id} not present")

    title = _decrypt_text_field(
        encryption_service=encryption_service,
        value=row["title"],
        nonce=row["title_encryption_nonce"],
        tag=row["title_encryption_tag"],
        field_name="title",
        file_id=file_id,
    )
    metadata_json = _decrypt_text_field(
        encryption_service=encryption_service,
        value=row["metadata_json"],
        nonce=row["metadata_encryption_nonce"],
        tag=row["metadata_encryption_tag"],
        field_name="metadata_json",
        file_id=file_id,
    )
    metadata = _parse_file_metadata(metadata_json, file_id=file_id)
    created_at = row["created_at"]
    updated_at = row["updated_at"]
    if not isinstance(created_at, datetime):
        raise TypeError(f"files.created_at must be datetime for file {file_id}")
    if not isinstance(updated_at, datetime):
        raise TypeError(f"files.updated_at must be datetime for file {file_id}")

    return FileReferenceRecord(
        id=file_id,
        title=title,
        original_filename=metadata["original_filename"],
        mime_type=metadata["mime_type"],
        size_bytes=metadata["size_bytes"],
        thumbnail_kind=metadata["thumbnail_kind"],
        created_at=created_at,
        updated_at=updated_at,
    )


def download_file(file_id: str, token: str) -> DownloadedFile:
    if not isinstance(token, str) or token == "":
        raise TypeError("token must be a non-empty string")

    encryption_service = _resolve_encryption_service(token)
    with connect_file_reader() as connection:
        require_file_size(connection, file_id, MAX_ATTACHMENT_BYTES)
        row = fetch_file(connection, file_id)
    if row is None:
        raise KeyError(f"File {file_id} not present")

    record = get_file_reference_record(file_id, token)
    encrypted_blob = row["blob_data"]
    if not isinstance(encrypted_blob, bytes):
        raise TypeError(f"files.blob_data must be bytes for file {file_id}")

    content_bytes = _decrypt_blob_field(
        encryption_service=encryption_service,
        value=encrypted_blob,
        nonce=row["blob_encryption_nonce"],
        tag=row["blob_encryption_tag"],
        field_name="blob_data",
        file_id=file_id,
    )
    return DownloadedFile(record=record, content_bytes=content_bytes)


def trim_unused_files() -> TrimUnusedFilesResult:
    if not note_store.loaded:
        raise RuntimeError("Cannot trim unused files before NoteStore hydration")

    referenced_file_ids: set[str] = set()
    for note_id in note_store.list_note_ids():
        content_html = note_store.get_note(note_id).content
        tokens = collect_reference_tokens_from_html(content_html)
        for token in tokens:
            if file_registry.has_file(token.note_id):
                referenced_file_ids.add(token.note_id)

    all_file_ids = file_registry.list_ids()
    unused_file_ids = all_file_ids.difference(referenced_file_ids)
    deleted_ids = sorted(unused_file_ids)
    with begin_file_writer() as connection:
        deleted_count = delete_files(connection, deleted_ids)
    if deleted_count != len(deleted_ids):
        raise RuntimeError(
            "File trim deleted unexpected number of rows: "
            f"expected={len(deleted_ids)} actual={deleted_count}"
        )
    file_registry.remove_many(set(deleted_ids))
    return TrimUnusedFilesResult(
        deleted_count=deleted_count,
        deleted_file_ids=deleted_ids,
    )


def encrypt_all_files_for_active_dek(*, encryption_service: object) -> int:
    service = _coerce_encryption_service(encryption_service)
    if service is None:
        raise RuntimeError("File encryption migration requires an active DEK")

    rewritten_count = 0
    with begin_file_writer() as connection:
        file_ids = fetch_all_file_ids(connection)
        for file_id in file_ids:
            row = fetch_file(connection, file_id)
            assert row is not None
            if _row_is_fully_encrypted(row):
                continue
            _rewrite_file_row(
                connection=connection,
                row=row,
                decrypt_encryption_service=service,
                encrypt_encryption_service=service,
            )
            rewritten_count += 1
    return rewritten_count


def decrypt_all_files_for_plaintext(*, encryption_service: object) -> int:
    service = _coerce_encryption_service(encryption_service)
    if service is None:
        raise RuntimeError("File decryption migration requires an active DEK")

    rewritten_count = 0
    with begin_file_writer() as connection:
        file_ids = fetch_all_file_ids(connection)
        for file_id in file_ids:
            row = fetch_file(connection, file_id)
            assert row is not None
            if _row_is_fully_plaintext(row):
                continue
            _rewrite_file_row(
                connection=connection,
                row=row,
                decrypt_encryption_service=service,
                encrypt_encryption_service=None,
            )
            rewritten_count += 1
    return rewritten_count


def _generate_unique_file_id() -> str:
    for _ in range(100):
        candidate = str(uuid.uuid4())
        if note_store.has_note(candidate):
            continue
        if file_registry.has_file(candidate):
            continue
        return candidate
    raise RuntimeError("Failed to generate a unique file UUID")


def _derive_thumbnail_kind(*, mime_type: str, original_filename: str) -> str:
    normalized_mime_type = mime_type.strip().lower()
    extension = Path(original_filename).suffix.lower()
    if normalized_mime_type == "application/pdf" or extension == ".pdf":
        return "pdf"
    if normalized_mime_type.startswith("image/"):
        return "image"
    if normalized_mime_type.startswith("audio/"):
        return "audio"
    if normalized_mime_type.startswith("video/"):
        return "video"
    if normalized_mime_type.startswith("text/"):
        return "text"
    if extension in {".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz"}:
        return "archive"
    return "other"


def _rewrite_file_row(
    *,
    connection,
    row: dict[str, object],
    decrypt_encryption_service: object,
    encrypt_encryption_service: object | None,
) -> None:
    file_id = row["id"]
    if not isinstance(file_id, str) or file_id == "":
        raise TypeError(f"files.id must be a non-empty string, got {file_id!r}")

    title = _decrypt_text_field(
        encryption_service=decrypt_encryption_service,
        value=row["title"],
        nonce=row["title_encryption_nonce"],
        tag=row["title_encryption_tag"],
        field_name="title",
        file_id=file_id,
    )
    metadata_json = _decrypt_text_field(
        encryption_service=decrypt_encryption_service,
        value=row["metadata_json"],
        nonce=row["metadata_encryption_nonce"],
        tag=row["metadata_encryption_tag"],
        field_name="metadata_json",
        file_id=file_id,
    )
    blob_data = _decrypt_blob_field(
        encryption_service=decrypt_encryption_service,
        value=row["blob_data"],
        nonce=row["blob_encryption_nonce"],
        tag=row["blob_encryption_tag"],
        field_name="blob_data",
        file_id=file_id,
    )

    if encrypt_encryption_service is None:
        next_title = title
        next_title_nonce = None
        next_title_tag = None
        next_metadata_json = metadata_json
        next_metadata_nonce = None
        next_metadata_tag = None
        next_blob_data = blob_data
        next_blob_nonce = None
        next_blob_tag = None
    else:
        next_title, next_title_nonce, next_title_tag = _encrypt_text_for_storage(
            encryption_service=encrypt_encryption_service,
            plaintext=title,
        )
        next_metadata_json, next_metadata_nonce, next_metadata_tag = _encrypt_text_for_storage(
            encryption_service=encrypt_encryption_service,
            plaintext=metadata_json,
        )
        next_blob_data, next_blob_nonce, next_blob_tag = _encrypt_bytes_for_storage(
            encryption_service=encrypt_encryption_service,
            plaintext=blob_data,
        )

    update_file_storage_fields(
        connection,
        file_id=file_id,
        title=next_title,
        title_encryption_nonce=next_title_nonce,
        title_encryption_tag=next_title_tag,
        metadata_json=next_metadata_json,
        metadata_encryption_nonce=next_metadata_nonce,
        metadata_encryption_tag=next_metadata_tag,
        blob_data=next_blob_data,
        blob_encryption_nonce=next_blob_nonce,
        blob_encryption_tag=next_blob_tag,
        updated_at=datetime.now(timezone.utc),
    )


def _row_is_fully_plaintext(row: dict[str, object]) -> bool:
    return (
        _field_has_encryption(
            nonce=row["title_encryption_nonce"],
            tag=row["title_encryption_tag"],
            file_id=row["id"],
            field_name="title",
        )
        is False
        and _field_has_encryption(
            nonce=row["metadata_encryption_nonce"],
            tag=row["metadata_encryption_tag"],
            file_id=row["id"],
            field_name="metadata_json",
        )
        is False
        and _field_has_encryption(
            nonce=row["blob_encryption_nonce"],
            tag=row["blob_encryption_tag"],
            file_id=row["id"],
            field_name="blob_data",
        )
        is False
    )


def _row_is_fully_encrypted(row: dict[str, object]) -> bool:
    return (
        _field_has_encryption(
            nonce=row["title_encryption_nonce"],
            tag=row["title_encryption_tag"],
            file_id=row["id"],
            field_name="title",
        )
        is True
        and _field_has_encryption(
            nonce=row["metadata_encryption_nonce"],
            tag=row["metadata_encryption_tag"],
            file_id=row["id"],
            field_name="metadata_json",
        )
        is True
        and _field_has_encryption(
            nonce=row["blob_encryption_nonce"],
            tag=row["blob_encryption_tag"],
            file_id=row["id"],
            field_name="blob_data",
        )
        is True
    )


def _field_has_encryption(*, nonce: object, tag: object, file_id: object, field_name: str) -> bool:
    if nonce is None and tag is None:
        return False
    if not isinstance(nonce, bytes) or not isinstance(tag, bytes):
        raise RuntimeError(
            "Encrypted field metadata invalid: "
            f"file_id={file_id} field={field_name} nonce={nonce is not None} tag={tag is not None}"
        )
    return True


def _resolve_encryption_service(token: Optional[str]):
    service = None
    if token is not None and token != "":
        service = get_encryption_service_with_token(token)
    if service is None:
        service = get_encryption_service()
    return service


def _encrypt_text_for_storage(
    *,
    encryption_service: object,
    plaintext: str,
) -> tuple[str, Optional[bytes], Optional[bytes]]:
    if not isinstance(plaintext, str):
        raise TypeError(f"plaintext must be a string, got {type(plaintext)}")

    service = _coerce_encryption_service(encryption_service)
    if service is None:
        if is_encryption_required():
            raise RuntimeError("Encryption is required but no DEK is available")
        return plaintext, None, None
    return service.encrypt_for_storage(plaintext)


def _encrypt_bytes_for_storage(
    *,
    encryption_service: object,
    plaintext: bytes,
) -> tuple[bytes, Optional[bytes], Optional[bytes]]:
    if not isinstance(plaintext, bytes):
        raise TypeError(f"plaintext must be bytes, got {type(plaintext)}")

    service = _coerce_encryption_service(encryption_service)
    if service is None:
        if is_encryption_required():
            raise RuntimeError("Encryption is required but no DEK is available")
        return plaintext, None, None
    return service.encrypt_bytes_for_storage(plaintext)


def _decrypt_text_field(
    *,
    encryption_service,
    value: object,
    nonce: object,
    tag: object,
    field_name: str,
    file_id: str,
) -> str:
    if not isinstance(value, str):
        raise TypeError(f"files.{field_name} must be a string for file {file_id}")
    if nonce is None and tag is None:
        return value
    if (nonce is None) != (tag is None):
        raise RuntimeError(
            "Encrypted text metadata missing: "
            f"file_id={file_id} field={field_name} nonce={nonce is not None} tag={tag is not None}"
        )
    if not isinstance(nonce, bytes) or not isinstance(tag, bytes):
        raise RuntimeError(
            "Encrypted text metadata invalid: "
            f"file_id={file_id} field={field_name}"
        )

    service = _coerce_encryption_service(encryption_service)
    if service is None:
        raise RuntimeError(f"Encrypted file metadata requires an active DEK: file_id={file_id}")
    return service.decrypt_from_storage(value, nonce, tag)


def _decrypt_blob_field(
    *,
    encryption_service,
    value: object,
    nonce: object,
    tag: object,
    field_name: str,
    file_id: str,
) -> bytes:
    if not isinstance(value, bytes):
        raise TypeError(f"files.{field_name} must be bytes for file {file_id}")
    if nonce is None and tag is None:
        return value
    if (nonce is None) != (tag is None):
        raise RuntimeError(
            "Encrypted blob metadata missing: "
            f"file_id={file_id} field={field_name} nonce={nonce is not None} tag={tag is not None}"
        )
    if not isinstance(nonce, bytes) or not isinstance(tag, bytes):
        raise RuntimeError(
            "Encrypted blob metadata invalid: "
            f"file_id={file_id} field={field_name}"
        )

    service = _coerce_encryption_service(encryption_service)
    if service is None:
        raise RuntimeError(f"Encrypted file blob requires an active DEK: file_id={file_id}")
    return service.decrypt_bytes_from_storage(value, nonce, tag)


def _coerce_encryption_service(encryption_service: object):
    if encryption_service is None:
        return None
    dek = getattr(encryption_service, "dek", None)
    if not isinstance(dek, bytes):
        return None
    return encryption_service


def _parse_file_metadata(metadata_json: str, *, file_id: str) -> dict[str, object]:
    metadata = json.loads(metadata_json)
    if not isinstance(metadata, dict):
        raise TypeError(f"files.metadata_json must decode to an object for file {file_id}")

    if "original_filename" not in metadata:
        raise TypeError(f"files.metadata_json original_filename missing for file {file_id}")
    if "mime_type" not in metadata:
        raise TypeError(f"files.metadata_json mime_type missing for file {file_id}")
    if "size_bytes" not in metadata:
        raise TypeError(f"files.metadata_json size_bytes missing for file {file_id}")
    if "thumbnail_kind" not in metadata:
        raise TypeError(f"files.metadata_json thumbnail_kind missing for file {file_id}")

    original_filename = metadata["original_filename"]
    mime_type = metadata["mime_type"]
    size_bytes = metadata["size_bytes"]
    thumbnail_kind = metadata["thumbnail_kind"]

    if not isinstance(original_filename, str) or original_filename == "":
        raise TypeError(f"files.metadata_json original_filename missing for file {file_id}")
    if not isinstance(mime_type, str):
        raise TypeError(f"files.metadata_json mime_type invalid for file {file_id}")
    if not isinstance(size_bytes, int) or size_bytes < 0:
        raise TypeError(f"files.metadata_json size_bytes invalid for file {file_id}")
    if not isinstance(thumbnail_kind, str) or thumbnail_kind not in _ALLOWED_THUMBNAIL_KINDS:
        raise TypeError(f"files.metadata_json thumbnail_kind invalid for file {file_id}")

    return {
        "original_filename": original_filename,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "thumbnail_kind": thumbnail_kind,
    }
