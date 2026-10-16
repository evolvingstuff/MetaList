"""Encrypted file storage and reference helpers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import uuid
from typing import Optional

from app.upload_limits import MAX_ATTACHMENT_BYTES
from app.db.file_schema import FILE_PREVIEW_VARIANTS
from app.db.file_session import begin_file_writer, connect_file_reader, resolve_file_database_path
from app.db.files_sql import (
    delete_file_previews,
    delete_files,
    fetch_all_file_ids,
    fetch_all_file_metadata,
    fetch_all_file_previews,
    fetch_file_metadata,
    fetch_file_preview,
    require_file_size,
    fetch_file,
    insert_file,
    replace_file_content_fields,
    update_file_preview_storage_fields,
    update_file_storage_fields,
    upsert_file_preview,
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

_ALLOWED_THUMBNAIL_KINDS = {"pdf", "image", "audio", "video", "text", "archive", "excalidraw", "other"}

EXCALIDRAW_MIME_TYPE = "application/vnd.excalidraw+json"
EXCALIDRAW_FILE_EXTENSION = ".excalidraw"
FILE_PREVIEW_MIME_TYPE = "image/svg+xml"
# Only files MetaList edits itself may be replaced in place; other attachments stay immutable.
_EDITABLE_THUMBNAIL_KINDS = {"excalidraw"}


class FileRevisionConflict(Exception):
    """The file changed since the client loaded it (another tab or window saved first)."""

    def __init__(self, *, file_id: str, expected_revision: int, current_revision: int) -> None:
        super().__init__(
            f"File {file_id} is at revision {current_revision}, not the expected revision {expected_revision}"
        )
        self.file_id = file_id
        self.expected_revision = expected_revision
        self.current_revision = current_revision


class FileNotEditable(ValueError):
    """The file kind does not support in-place updates or previews."""


class InvalidFileContent(ValueError):
    """Submitted file content or preview does not match the file kind."""


class FilePreviewMissing(Exception):
    """No rendered preview has been stored for this file and variant yet."""


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
    content_revision: int


@dataclass(frozen=True)
class DownloadedFile:
    record: FileReferenceRecord
    content_bytes: bytes


@dataclass(frozen=True)
class FilePreview:
    file_id: str
    variant: str
    mime_type: str
    content_revision: int
    content_bytes: bytes


@dataclass(frozen=True)
class FileSnapshot:
    """An editable file's content and stored previews at one revision, kept for undo and discard."""

    file_id: str
    content_revision: int
    content_bytes: bytes
    # Empty when no previews were stored; otherwise one SVG per FILE_PREVIEW_VARIANTS entry.
    previews_by_variant: dict[str, bytes]


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
        content_revision=1,
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
    content_revision = row["content_revision"]
    assert isinstance(content_revision, int) and content_revision >= 1

    return FileReferenceRecord(
        id=file_id,
        title=title,
        original_filename=metadata["original_filename"],
        mime_type=metadata["mime_type"],
        size_bytes=metadata["size_bytes"],
        thumbnail_kind=metadata["thumbnail_kind"],
        created_at=created_at,
        updated_at=updated_at,
        content_revision=content_revision,
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


def replace_file_content(
    *,
    file_id: str,
    content_bytes: bytes,
    expected_revision: int,
    token: str,
) -> FileReferenceRecord:
    """Replace an editable file's content if nobody saved since expected_revision."""
    if not isinstance(content_bytes, bytes):
        raise TypeError(f"content_bytes must be bytes, got {type(content_bytes)}")
    if not isinstance(expected_revision, int) or expected_revision < 1:
        raise TypeError(f"expected_revision must be a positive integer, got {expected_revision!r}")
    if not isinstance(token, str) or token == "":
        raise TypeError("token must be a non-empty string")
    if len(content_bytes) > MAX_ATTACHMENT_BYTES:
        raise ValueError("Attachment exceeds the configured size limit")

    record = get_file_reference_record(file_id, token)
    _require_editable(record)
    _validate_editable_content(thumbnail_kind=record.thumbnail_kind, content_bytes=content_bytes)
    if record.content_revision != expected_revision:
        raise FileRevisionConflict(
            file_id=file_id, expected_revision=expected_revision, current_revision=record.content_revision
        )

    encryption_service = _resolve_encryption_service(token)
    content_fields = _encrypt_replacement_content(
        record=record,
        content_bytes=content_bytes,
        encryption_service=encryption_service,
    )

    now = datetime.now(timezone.utc)
    with begin_file_writer() as connection:
        updated_rows = replace_file_content_fields(
            connection,
            file_id=file_id,
            expected_revision=expected_revision,
            updated_at=now,
            **content_fields,
        )
    if updated_rows != 1:
        current = get_file_reference_record(file_id, token)
        raise FileRevisionConflict(
            file_id=file_id, expected_revision=expected_revision, current_revision=current.content_revision
        )

    updated = get_file_reference_record(file_id, token)
    assert updated.content_revision == expected_revision + 1
    assert updated.size_bytes == len(content_bytes)
    return updated


def _encrypt_replacement_content(
    *,
    record: FileReferenceRecord,
    content_bytes: bytes,
    encryption_service: object,
) -> dict[str, object]:
    metadata = {
        "original_filename": record.original_filename,
        "mime_type": record.mime_type,
        "size_bytes": len(content_bytes),
        "thumbnail_kind": record.thumbnail_kind,
    }
    metadata_json = json.dumps(metadata, separators=(",", ":"), ensure_ascii=False)
    encrypted_metadata, metadata_nonce, metadata_tag = _encrypt_text_for_storage(
        encryption_service=encryption_service,
        plaintext=metadata_json,
    )
    encrypted_blob, blob_nonce, blob_tag = _encrypt_bytes_for_storage(
        encryption_service=encryption_service,
        plaintext=content_bytes,
    )
    return {
        "metadata_json": encrypted_metadata,
        "metadata_encryption_nonce": metadata_nonce,
        "metadata_encryption_tag": metadata_tag,
        "blob_data": encrypted_blob,
        "blob_encryption_nonce": blob_nonce,
        "blob_encryption_tag": blob_tag,
    }


def capture_file_snapshot(*, file_id: str, token: str) -> FileSnapshot:
    """Read an editable file's current content and previews so they can be written back later."""
    downloaded = download_file(file_id, token)
    _require_editable(downloaded.record)
    previews_by_variant: dict[str, bytes] = {}
    for variant in FILE_PREVIEW_VARIANTS:
        preview = find_file_preview(file_id=file_id, variant=variant, token=token)
        if preview is not None:
            previews_by_variant[variant] = preview.content_bytes
    if previews_by_variant and set(previews_by_variant) != set(FILE_PREVIEW_VARIANTS):
        raise RuntimeError(f"File {file_id} has previews for only some variants")
    return FileSnapshot(
        file_id=file_id,
        content_revision=downloaded.record.content_revision,
        content_bytes=downloaded.content_bytes,
        previews_by_variant=previews_by_variant,
    )


def restore_file_snapshot(*, snapshot: FileSnapshot, token: str) -> FileReferenceRecord:
    """Write a snapshot's content and previews back together as the file's next revision."""
    if not isinstance(snapshot, FileSnapshot):
        raise TypeError(f"snapshot must be a FileSnapshot, got {type(snapshot)}")
    if not isinstance(token, str) or token == "":
        raise TypeError("token must be a non-empty string")

    record = get_file_reference_record(snapshot.file_id, token)
    _require_editable(record)
    _validate_editable_content(thumbnail_kind=record.thumbnail_kind, content_bytes=snapshot.content_bytes)
    if snapshot.previews_by_variant and set(snapshot.previews_by_variant) != set(FILE_PREVIEW_VARIANTS):
        raise InvalidFileContent(f"Previews must include exactly these variants: {', '.join(FILE_PREVIEW_VARIANTS)}")
    for variant, svg_bytes in snapshot.previews_by_variant.items():
        _validate_svg_preview(svg_bytes=svg_bytes, variant=variant)

    encryption_service = _resolve_encryption_service(token)
    content_fields = _encrypt_replacement_content(
        record=record,
        content_bytes=snapshot.content_bytes,
        encryption_service=encryption_service,
    )
    encrypted_previews = {
        variant: _encrypt_bytes_for_storage(encryption_service=encryption_service, plaintext=svg_bytes)
        for variant, svg_bytes in snapshot.previews_by_variant.items()
    }

    next_revision = record.content_revision + 1
    now = datetime.now(timezone.utc)
    with begin_file_writer() as connection:
        updated_rows = replace_file_content_fields(
            connection,
            file_id=snapshot.file_id,
            expected_revision=record.content_revision,
            updated_at=now,
            **content_fields,
        )
        if updated_rows != 1:
            raise RuntimeError(f"File {snapshot.file_id} changed while its snapshot was being restored")
        delete_file_previews(connection, snapshot.file_id)
        for variant, (preview_data, preview_nonce, preview_tag) in encrypted_previews.items():
            upsert_file_preview(
                connection,
                file_id=snapshot.file_id,
                variant=variant,
                mime_type=FILE_PREVIEW_MIME_TYPE,
                preview_data=preview_data,
                preview_encryption_nonce=preview_nonce,
                preview_encryption_tag=preview_tag,
                content_revision=next_revision,
                updated_at=now,
            )

    updated = get_file_reference_record(snapshot.file_id, token)
    assert updated.content_revision == next_revision
    assert updated.size_bytes == len(snapshot.content_bytes)
    return updated


def store_file_previews(
    *,
    file_id: str,
    previews_by_variant: dict[str, bytes],
    content_revision: int,
    token: str,
) -> FileReferenceRecord:
    """Store the light and dark SVG previews rendered from content_revision of an editable file."""
    if not isinstance(previews_by_variant, dict):
        raise TypeError(f"previews_by_variant must be a dict, got {type(previews_by_variant)}")
    if set(previews_by_variant.keys()) != set(FILE_PREVIEW_VARIANTS):
        raise InvalidFileContent(f"Previews must include exactly these variants: {', '.join(FILE_PREVIEW_VARIANTS)}")
    if not isinstance(content_revision, int) or content_revision < 1:
        raise TypeError(f"content_revision must be a positive integer, got {content_revision!r}")
    if not isinstance(token, str) or token == "":
        raise TypeError("token must be a non-empty string")

    record = get_file_reference_record(file_id, token)
    _require_editable(record)
    if record.content_revision != content_revision:
        raise FileRevisionConflict(
            file_id=file_id, expected_revision=content_revision, current_revision=record.content_revision
        )

    encryption_service = _resolve_encryption_service(token)
    encrypted_previews: dict[str, tuple[bytes, Optional[bytes], Optional[bytes]]] = {}
    for variant in FILE_PREVIEW_VARIANTS:
        svg_bytes = previews_by_variant[variant]
        _validate_svg_preview(svg_bytes=svg_bytes, variant=variant)
        encrypted_previews[variant] = _encrypt_bytes_for_storage(
            encryption_service=encryption_service,
            plaintext=svg_bytes,
        )

    now = datetime.now(timezone.utc)
    with begin_file_writer() as connection:
        for variant, (preview_data, preview_nonce, preview_tag) in encrypted_previews.items():
            upsert_file_preview(
                connection,
                file_id=file_id,
                variant=variant,
                mime_type=FILE_PREVIEW_MIME_TYPE,
                preview_data=preview_data,
                preview_encryption_nonce=preview_nonce,
                preview_encryption_tag=preview_tag,
                content_revision=content_revision,
                updated_at=now,
            )
    return record


def get_file_preview(*, file_id: str, variant: str, token: str) -> FilePreview:
    preview = find_file_preview(file_id=file_id, variant=variant, token=token)
    if preview is None:
        raise FilePreviewMissing(f"No {variant} preview stored for file {file_id}")
    return preview


def find_file_preview(*, file_id: str, variant: str, token: str) -> Optional[FilePreview]:
    """The stored preview, or None when the diagram has not been rendered yet."""
    if not isinstance(file_id, str) or file_id == "":
        raise TypeError("file_id must be a non-empty string")
    if variant not in FILE_PREVIEW_VARIANTS:
        raise ValueError(f"variant must be one of {FILE_PREVIEW_VARIANTS}, got {variant!r}")
    if not isinstance(token, str) or token == "":
        raise TypeError("token must be a non-empty string")

    encryption_service = _resolve_encryption_service(token)
    with connect_file_reader() as connection:
        row = fetch_file_preview(connection, file_id, variant)
    if row is None:
        return None
    content_bytes = _decrypt_blob_field(
        encryption_service=encryption_service,
        value=row["preview_data"],
        nonce=row["preview_encryption_nonce"],
        tag=row["preview_encryption_tag"],
        field_name="preview_data",
        file_id=file_id,
    )
    mime_type = row["mime_type"]
    content_revision = row["content_revision"]
    assert mime_type == FILE_PREVIEW_MIME_TYPE, f"unexpected preview MIME type {mime_type!r}"
    assert isinstance(content_revision, int)
    return FilePreview(
        file_id=file_id,
        variant=variant,
        mime_type=mime_type,
        content_revision=content_revision,
        content_bytes=content_bytes,
    )


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
        _rewrite_file_previews(
            connection=connection,
            decrypt_encryption_service=service,
            encrypt_encryption_service=service,
        )
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
        _rewrite_file_previews(
            connection=connection,
            decrypt_encryption_service=service,
            encrypt_encryption_service=None,
        )
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
    if normalized_mime_type == EXCALIDRAW_MIME_TYPE or extension == EXCALIDRAW_FILE_EXTENSION:
        return "excalidraw"
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


def _rewrite_file_previews(
    *,
    connection,
    decrypt_encryption_service: object,
    encrypt_encryption_service: object | None,
) -> None:
    for preview in fetch_all_file_previews(connection):
        file_id = preview["file_id"]
        variant = preview["variant"]
        assert isinstance(file_id, str) and isinstance(variant, str)
        plaintext = _decrypt_blob_field(
            encryption_service=decrypt_encryption_service,
            value=preview["preview_data"],
            nonce=preview["preview_encryption_nonce"],
            tag=preview["preview_encryption_tag"],
            field_name="preview_data",
            file_id=file_id,
        )
        if encrypt_encryption_service is None:
            next_data, next_nonce, next_tag = plaintext, None, None
        else:
            next_data, next_nonce, next_tag = _encrypt_bytes_for_storage(
                encryption_service=encrypt_encryption_service,
                plaintext=plaintext,
            )
        update_file_preview_storage_fields(
            connection,
            file_id=file_id,
            variant=variant,
            preview_data=next_data,
            preview_encryption_nonce=next_nonce,
            preview_encryption_tag=next_tag,
        )


def _require_editable(record: FileReferenceRecord) -> None:
    if record.thumbnail_kind not in _EDITABLE_THUMBNAIL_KINDS:
        raise FileNotEditable(f"Files of kind {record.thumbnail_kind!r} cannot be edited in place")


def _decode_utf8_strict(content_bytes: bytes, *, description: str) -> str:
    text = content_bytes.decode("utf-8", errors="replace")
    if text.encode("utf-8") != content_bytes:
        raise InvalidFileContent(f"{description} must be UTF-8 text")
    return text


def _validate_editable_content(*, thumbnail_kind: str, content_bytes: bytes) -> None:
    assert thumbnail_kind in _EDITABLE_THUMBNAIL_KINDS
    text = _decode_utf8_strict(content_bytes, description="Excalidraw scene")
    try:
        scene = json.loads(text)
    except json.JSONDecodeError as exc:
        raise InvalidFileContent("Excalidraw scene must be valid JSON") from exc
    if not isinstance(scene, dict) or "type" not in scene or scene["type"] != "excalidraw":
        raise InvalidFileContent("Excalidraw scene must be a JSON object with type 'excalidraw'")
    if "elements" not in scene or not isinstance(scene["elements"], list):
        raise InvalidFileContent("Excalidraw scene must contain an elements list")


def _validate_svg_preview(*, svg_bytes: bytes, variant: str) -> None:
    if not isinstance(svg_bytes, bytes):
        raise TypeError(f"{variant} preview must be bytes, got {type(svg_bytes)}")
    if len(svg_bytes) > MAX_ATTACHMENT_BYTES:
        raise ValueError("Attachment exceeds the configured size limit")
    text = _decode_utf8_strict(svg_bytes, description=f"{variant} preview").strip()
    if text.startswith("<?xml"):
        if "?>" not in text:
            raise InvalidFileContent(f"{variant} preview has an unterminated XML declaration")
        text = text[text.index("?>") + 2:].lstrip()
    if not text.startswith("<svg") or not text.endswith("</svg>"):
        raise InvalidFileContent(f"{variant} preview must be an SVG document")


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
    if not isinstance(encryption_service.dek, bytes):
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
