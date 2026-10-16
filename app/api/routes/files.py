from __future__ import annotations

from io import BytesIO
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from app.api.note_requests import DiscardFileEditSessionRequest, FinishFileEditSessionRequest
from app.api.transactions import transactional_route
from app.api.upload_limits import read_attachment
from app.api.request_auth import require_request_auth_token
from app.services.file_registry import file_registry
from app.services.note_store import store as note_store
from app.db.file_schema import FILE_PREVIEW_VARIANTS
from app.services.file_storage import (
    create_file,
    download_file,
    get_file_preview,
    replace_file_content,
    store_file_previews,
    trim_unused_files,
)
from app.usecases.file_edit_session import (
    CmdDiscardFileEditSession,
    CmdFinishFileEditSession,
    CmdStartFileEditSession,
)

router = APIRouter(prefix="/files", tags=["files"])

FILE_REVISION_HEADER = "X-MetaList-File-Revision"


class UploadedFileResponse(BaseModel):
    file_id: str
    reference_token: str
    title: str
    original_filename: str
    mime_type: str
    size_bytes: int
    thumbnail_kind: str


class FileContentUpdatedResponse(BaseModel):
    file_id: str
    content_revision: int
    size_bytes: int


class FilePreviewsStoredResponse(BaseModel):
    file_id: str
    content_revision: int


class TrimUnusedFilesResponse(BaseModel):
    deleted_count: int
    deleted_file_ids: list[str]


def _require_bearer_token(request: Request) -> str:
    return require_request_auth_token(request)


def _require_known_file(file_id: str) -> None:
    if not file_registry.has_file(file_id):
        raise HTTPException(status_code=404, detail=f"File not found: {file_id}")


@router.post("/upload", response_model=UploadedFileResponse)
@transactional_route
async def upload_file_endpoint(
    request: Request,
    file: Annotated[UploadFile, File()],
):
    token = _require_bearer_token(request)
    if not isinstance(file.filename, str) or file.filename == "":
        raise HTTPException(status_code=400, detail="Uploaded file must include a filename")
    if not isinstance(file.content_type, str) or file.content_type == "":
        raise HTTPException(status_code=400, detail="Uploaded file must include a non-empty MIME type")

    content_bytes = await read_attachment(file)

    record = create_file(
        original_filename=file.filename,
        mime_type=file.content_type,
        content_bytes=content_bytes,
        token=token,
    )
    return UploadedFileResponse(
        file_id=record.id,
        reference_token=f"![[{record.id}]]",
        title=record.title,
        original_filename=record.original_filename,
        mime_type=record.mime_type,
        size_bytes=record.size_bytes,
        thumbnail_kind=record.thumbnail_kind,
    )


@router.get("/{file_id}/download")
def download_file_endpoint(request: Request, file_id: str):
    token = _require_bearer_token(request)
    if not file_registry.has_file(file_id):
        raise HTTPException(status_code=404, detail=f"File not found: {file_id}")

    downloaded = download_file(file_id, token)
    quoted_filename = quote(downloaded.record.original_filename, safe="")
    return StreamingResponse(
        BytesIO(downloaded.content_bytes),
        media_type=downloaded.record.mime_type,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quoted_filename}",
            FILE_REVISION_HEADER: str(downloaded.record.content_revision),
        },
    )


@router.put("/{file_id}/content", response_model=FileContentUpdatedResponse)
@transactional_route
async def replace_file_content_endpoint(
    request: Request,
    file_id: str,
    file: Annotated[UploadFile, File()],
    expected_revision: Annotated[int, Form()],
):
    token = _require_bearer_token(request)
    _require_known_file(file_id)
    content_bytes = await read_attachment(file)
    record = replace_file_content(
        file_id=file_id,
        content_bytes=content_bytes,
        expected_revision=expected_revision,
        token=token,
    )
    return FileContentUpdatedResponse(
        file_id=record.id,
        content_revision=record.content_revision,
        size_bytes=record.size_bytes,
    )


@router.put("/{file_id}/previews", response_model=FilePreviewsStoredResponse)
@transactional_route
async def store_file_previews_endpoint(
    request: Request,
    file_id: str,
    light: Annotated[UploadFile, File()],
    dark: Annotated[UploadFile, File()],
    content_revision: Annotated[int, Form()],
):
    token = _require_bearer_token(request)
    _require_known_file(file_id)
    previews_by_variant = {
        "light": await read_attachment(light),
        "dark": await read_attachment(dark),
    }
    record = store_file_previews(
        file_id=file_id,
        previews_by_variant=previews_by_variant,
        content_revision=content_revision,
        token=token,
    )
    return FilePreviewsStoredResponse(file_id=record.id, content_revision=record.content_revision)


@router.get("/{file_id}/previews/{variant}")
def download_file_preview_endpoint(request: Request, file_id: str, variant: str):
    token = _require_bearer_token(request)
    _require_known_file(file_id)
    if variant not in FILE_PREVIEW_VARIANTS:
        raise HTTPException(status_code=404, detail=f"Unknown preview variant: {variant}")
    preview = get_file_preview(file_id=file_id, variant=variant, token=token)
    return Response(
        content=preview.content_bytes,
        media_type=preview.mime_type,
        headers={FILE_REVISION_HEADER: str(preview.content_revision)},
    )


# A diagram editing session: opened with the editor, finished by Done (one undo step), or discarded.
@router.post("/{file_id}/edit-sessions")
@transactional_route
def start_file_edit_session_endpoint(request: Request, file_id: str) -> dict[str, object]:
    token = _require_bearer_token(request)
    _require_known_file(file_id)
    return CmdStartFileEditSession(file_id=file_id, token=token).execute()


@router.post("/{file_id}/edit-sessions/{session_id}/finish")
@transactional_route
def finish_file_edit_session_endpoint(
    request: Request,
    file_id: str,
    session_id: str,
    body: FinishFileEditSessionRequest,
) -> dict[str, object]:
    token = _require_bearer_token(request)
    _require_known_file(file_id)
    host_note_id = body["hostNoteId"]
    if not note_store.has_note(host_note_id):
        raise HTTPException(status_code=404, detail=f"Note not found: {host_note_id}")
    return CmdFinishFileEditSession(
        file_id=file_id,
        session_id=session_id,
        host_note_id=host_note_id,
        content_revision=body["contentRevision"],
        is_new_diagram=body["isNewDiagram"],
        token=token,
        client_id=body["clientId"],
        undo_context=body["undoContext"],
        viewport=body["viewport"],
    ).execute()


@router.post("/{file_id}/edit-sessions/{session_id}/discard")
@transactional_route
def discard_file_edit_session_endpoint(
    request: Request,
    file_id: str,
    session_id: str,
    body: DiscardFileEditSessionRequest,
) -> dict[str, object]:
    token = _require_bearer_token(request)
    _require_known_file(file_id)
    return CmdDiscardFileEditSession(
        file_id=file_id,
        session_id=session_id,
        content_revision=body["contentRevision"],
        token=token,
    ).execute()


@router.post("/trim-unused", response_model=TrimUnusedFilesResponse)
@transactional_route
def trim_unused_files_endpoint(request: Request):
    _require_bearer_token(request)
    result = trim_unused_files()
    return TrimUnusedFilesResponse(
        deleted_count=result.deleted_count,
        deleted_file_ids=result.deleted_file_ids,
    )
