from __future__ import annotations

from io import BytesIO
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.api.transactions import transactional_route
from app.api.upload_limits import read_attachment
from app.api.request_auth import require_request_auth_token
from app.services.file_registry import file_registry
from app.services.file_storage import create_file, download_file, trim_unused_files

router = APIRouter(prefix="/files", tags=["files"])


class UploadedFileResponse(BaseModel):
    file_id: str
    reference_token: str
    title: str
    original_filename: str
    mime_type: str
    size_bytes: int
    thumbnail_kind: str


class TrimUnusedFilesResponse(BaseModel):
    deleted_count: int
    deleted_file_ids: list[str]


def _require_bearer_token(request: Request) -> str:
    return require_request_auth_token(request)


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
        },
    )


@router.post("/trim-unused", response_model=TrimUnusedFilesResponse)
@transactional_route
def trim_unused_files_endpoint(request: Request):
    _require_bearer_token(request)
    result = trim_unused_files()
    return TrimUnusedFilesResponse(
        deleted_count=result.deleted_count,
        deleted_file_ids=result.deleted_file_ids,
    )
