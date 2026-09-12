"""Enforce limits before multipart spooling and before creating a complete blob."""

from threading import BoundedSemaphore

from fastapi import HTTPException, UploadFile
from starlette.formparsers import MultiPartException
from starlette.responses import JSONResponse

from app.upload_limits import MAX_ATTACHMENT_BYTES, MAX_UPLOAD_REQUEST_BYTES, UPLOAD_CHUNK_BYTES


async def read_attachment(file: UploadFile) -> bytes:
    content = bytearray()
    try:
        while True:
            chunk = await file.read(min(UPLOAD_CHUNK_BYTES, MAX_ATTACHMENT_BYTES + 1 - len(content)))
            if not chunk:
                return bytes(content)
            content.extend(chunk)
            if len(content) > MAX_ATTACHMENT_BYTES:
                raise HTTPException(status_code=413, detail='Attachment exceeds the configured size limit')
    finally:
        await file.close()


class UploadLimitMiddleware:
    def __init__(self, app):
        self.app = app
        self._slots = BoundedSemaphore(4)

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        is_upload = scope['path'].endswith('/files/upload')
        is_download = '/files/' in scope['path'] and scope['path'].endswith('/download')
        if not (is_upload or is_download):
            await self.app(scope, receive, send)
            return
        if not self._slots.acquire(blocking=False):
            await JSONResponse({'detail': 'Too many attachment transfers; retry after another finishes'}, status_code=429)(scope, receive, send)
            return
        try:
            if is_upload:
                await self._receive_upload(scope, receive, send)
            else:
                await self.app(scope, receive, send)
        finally:
            self._slots.release()

    async def _receive_upload(self, scope, receive, send):
        lengths = [value for key, value in scope['headers'] if key == b'content-length']
        if len(lengths) == 1 and lengths[0].isdigit() and int(lengths[0]) > MAX_UPLOAD_REQUEST_BYTES:
            await JSONResponse({'detail': 'Upload exceeds the configured size limit'}, status_code=413)(scope, receive, send)
            return
        received = 0
        exceeded = False
        async def limited_receive():
            nonlocal received, exceeded
            message = await receive()
            if message['type'] == 'http.request':
                if 'body' in message:
                    received += len(message['body'])
                if received > MAX_UPLOAD_REQUEST_BYTES:
                    exceeded = True
                    # Starlette closes all partially spooled files on this exception.
                    raise MultiPartException('Upload exceeds the configured size limit')
            return message
        async def limited_send(message):
            if exceeded and message['type'] == 'http.response.start':
                message = dict(message, status=413)
            await send(message)
        await self.app(scope, limited_receive, limited_send)
