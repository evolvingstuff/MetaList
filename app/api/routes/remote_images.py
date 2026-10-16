from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.api.request_auth import require_request_auth_token
from app.api.transactions import transactional_route
from app.services.exception_capture import CapturedExceptionContext
from app.services.remote_image_proxy import (
    RemoteImageFetchError,
    fetch_remote_image,
    remote_image_proxy_registry,
)
from app.services.input_errors import InputRejected, ResourceNotFound


router = APIRouter(prefix="/remote-images", tags=["remote-images"])


class RemoteImageRegistrationRequest(BaseModel):
    source_urls: list[str] = Field(min_length=1, max_length=100)


class RemoteImageRegistrationEntryResponse(BaseModel):
    source_url: str
    proxy_path: str


class RemoteImageRegistrationResponse(BaseModel):
    images: list[RemoteImageRegistrationEntryResponse]


@router.post("/registrations", response_model=RemoteImageRegistrationResponse)
@transactional_route
def register_remote_images(
    request: Request,
    registration: RemoteImageRegistrationRequest,
) -> RemoteImageRegistrationResponse:
    require_request_auth_token(request)
    images: list[RemoteImageRegistrationEntryResponse] = []
    for source_url in registration.source_urls:
        registration_capture = CapturedExceptionContext(InputRejected, boundary='app/api/routes/remote_images.py:register_remote_images:registration_capture')
        token = None
        with registration_capture:
            token = remote_image_proxy_registry.register(source_url)
        if registration_capture.captured_exception is not None:
            raise HTTPException(
                status_code=422,
                detail="Remote image URL must use HTTP or HTTPS",
            )
        if token is None:
            raise RuntimeError("Remote image registration completed without a token")
        images.append(
            RemoteImageRegistrationEntryResponse(
                source_url=source_url,
                proxy_path=f"/api2/remote-images/{token}",
            )
        )
    return RemoteImageRegistrationResponse(images=images)


@router.get("/{proxy_token}")
def proxy_remote_image(request: Request, proxy_token: str) -> Response:
    require_request_auth_token(request)
    resolve_capture = CapturedExceptionContext(ResourceNotFound, boundary='app/api/routes/remote_images.py:proxy_remote_image:resolve_capture')
    source_url = None
    with resolve_capture:
        source_url = remote_image_proxy_registry.resolve(proxy_token)
    if resolve_capture.captured_exception is not None:
        raise HTTPException(status_code=404, detail="Remote image reference not found")
    if source_url is None:
        raise RuntimeError("Remote image proxy resolution completed without a source URL")

    fetch_capture = CapturedExceptionContext(RemoteImageFetchError, boundary='app/api/routes/remote_images.py:proxy_remote_image:fetch_capture')
    payload = None
    with fetch_capture:
        payload = fetch_remote_image(source_url)
    if fetch_capture.captured_exception is not None:
        raise HTTPException(status_code=502, detail="Remote image unavailable")
    if payload is None:
        raise RuntimeError("Remote image fetch completed without a payload")
    return Response(
        content=payload.content,
        media_type=payload.mime_type,
        headers={
            "Cache-Control": "no-store, private",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )
