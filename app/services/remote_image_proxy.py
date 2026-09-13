"""In-memory same-origin proxy boundary for remote note images."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from io import BytesIO
import re
import secrets
from threading import RLock
from typing import Callable
import warnings

import httpcore
import httpx
from PIL import Image, UnidentifiedImageError

from app.services.exception_capture import CapturedExceptionContext
from app.services.link_titles import (
    _LinkTitleTargetRejected,
    _PinnedHTTPTransport,
    _resolve_public_http_target,
    normalize_url_for_link_title,
)
from app.services.input_errors import InputRejected, ResourceNotFound


_FETCH_TIMEOUT_SECONDS = 8.0
_MAX_REDIRECTS = 5
_MAX_IMAGE_BYTES = 10_485_760
_MAX_IMAGE_PIXELS = 16_000_000
_USER_AGENT = "MetaList/remote-image-proxy"
_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32}$")
_IMG_TAG_RE = re.compile(r"<img\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>", re.IGNORECASE)
_SRC_ATTRIBUTE_RE = re.compile(
    r"\bsrc\s*=\s*(?:\"(?P<double>[^\"]*)\"|'(?P<single>[^']*)'|(?P<bare>[^\s>]+))",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class RemoteImagePayload:
    content: bytes
    mime_type: str

    def __post_init__(self) -> None:
        if not isinstance(self.content, bytes) or self.content == b"":
            raise ValueError("Remote image payload content must be non-empty bytes")
        if not isinstance(self.mime_type, str) or not self.mime_type.startswith("image/"):
            raise ValueError("Remote image payload requires an image MIME type")


class RemoteImageFetchError(RuntimeError):
    def __init__(self, reason: str) -> None:
        if not isinstance(reason, str) or reason == "":
            raise ValueError("Remote image fetch failure requires a reason")
        self.reason = reason
        super().__init__(reason)


class RemoteImageProxyRegistry:
    def __init__(self, *, max_entries: int, token_factory: Callable[[], str]) -> None:
        if not isinstance(max_entries, int) or max_entries <= 0:
            raise ValueError("max_entries must be a positive integer")
        if not callable(token_factory):
            raise TypeError("token_factory must be callable")
        self._max_entries = max_entries
        self._token_factory = token_factory
        self._lock = RLock()
        self._url_by_token: OrderedDict[str, str] = OrderedDict()
        self._token_by_url: dict[str, str] = {}

    def register(self, url: str) -> str:
        normalized_url = normalize_url_for_link_title(url)
        if normalized_url is None:
            raise InputRejected("Remote image proxy URL must use HTTP or HTTPS")
        with self._lock:
            if normalized_url in self._token_by_url:
                existing_token = self._token_by_url[normalized_url]
                self._url_by_token.move_to_end(existing_token)
                return existing_token

            token = ""
            for _ in range(8):
                candidate = self._token_factory()
                if not isinstance(candidate, str) or _TOKEN_PATTERN.fullmatch(candidate) is None:
                    raise RuntimeError("Remote image proxy token factory returned an invalid token")
                if candidate not in self._url_by_token:
                    token = candidate
                    break
            if token == "":
                raise RuntimeError("Remote image proxy token collision limit exceeded")

            if len(self._url_by_token) >= self._max_entries:
                evicted_token, evicted_url = self._url_by_token.popitem(last=False)
                removed_token = self._token_by_url.pop(evicted_url)
                if removed_token != evicted_token:
                    raise RuntimeError("Remote image proxy registry indexes diverged")
            self._url_by_token[token] = normalized_url
            self._token_by_url[normalized_url] = token
            return token

    def resolve(self, token: str) -> str:
        if not isinstance(token, str) or _TOKEN_PATTERN.fullmatch(token) is None:
            raise ResourceNotFound("Unknown remote image proxy token")
        with self._lock:
            if token not in self._url_by_token:
                raise ResourceNotFound("Unknown remote image proxy token")
            url = self._url_by_token[token]
            self._url_by_token.move_to_end(token)
            return url

    def reset(self) -> None:
        with self._lock:
            self._url_by_token.clear()
            self._token_by_url.clear()


remote_image_proxy_registry = RemoteImageProxyRegistry(
    max_entries=50_000,
    token_factory=lambda: secrets.token_urlsafe(24),
)


def rewrite_remote_image_sources_for_proxy(
    *,
    content_html: str,
    registry: RemoteImageProxyRegistry,
) -> str:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if not isinstance(registry, RemoteImageProxyRegistry):
        raise TypeError("registry must be a RemoteImageProxyRegistry")
    replacements: list[tuple[int, int, str]] = []
    for tag_match in _IMG_TAG_RE.finditer(content_html):
        attribute_match = _SRC_ATTRIBUTE_RE.search(tag_match.group(0))
        if attribute_match is None:
            continue
        value_group = "double"
        if attribute_match.group(value_group) is None:
            value_group = "single"
        if attribute_match.group(value_group) is None:
            value_group = "bare"
        source = attribute_match.group(value_group)
        if source is None:
            raise RuntimeError("Image src parser selected an empty capture group")
        normalized_url = normalize_url_for_link_title(source)
        if normalized_url is None:
            continue
        token = registry.register(normalized_url)
        start = tag_match.start() + attribute_match.start()
        end = tag_match.start() + attribute_match.end()
        replacements.append(
            (
                start,
                end,
                f'data-remote-image-proxy-src="/api2/remote-images/{token}"',
            )
        )

    rewritten = content_html
    for start, end, replacement in reversed(replacements):
        rewritten = f"{rewritten[:start]}{replacement}{rewritten[end:]}"
    return rewritten


def _validated_image_mime_type(content: bytes) -> tuple[str | None, str | None]:
    if not isinstance(content, bytes) or content == b"":
        raise TypeError("content must be non-empty bytes")
    format_to_mime_type = {
        "AVIF": "image/avif",
        "BMP": "image/bmp",
        "GIF": "image/gif",
        "JPEG": "image/jpeg",
        "PNG": "image/png",
        "WEBP": "image/webp",
    }
    validation_capture = CapturedExceptionContext(
        Image.DecompressionBombError,
        OSError,
        SyntaxError,
        UnidentifiedImageError,
        ValueError,
    boundary='app/services/remote_image_proxy.py:_validated_image_mime_type:validation_capture')
    mime_type = None
    with validation_capture:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            with Image.open(BytesIO(content)) as image:
                image_format = image.format
                if image_format not in format_to_mime_type:
                    return None, "unsupported_image_type"
                width, height = image.size
                if width <= 0 or height <= 0:
                    return None, "invalid_image_dimensions"
                if width * height > _MAX_IMAGE_PIXELS:
                    return None, "too_many_pixels"
                image.verify()
                mime_type = format_to_mime_type[image_format]
    if validation_capture.captured_exception is not None:
        return None, "invalid_image"
    if mime_type is None:
        raise RuntimeError("Image validation completed without a MIME type")
    return mime_type, None


def _download_one_url(url: str) -> tuple[bytes | None, str | None, str | None]:
    target_rejection_capture = CapturedExceptionContext(_LinkTitleTargetRejected, boundary='app/services/remote_image_proxy.py:_download_one_url:target_rejection_capture')
    target = None
    with target_rejection_capture:
        target = _resolve_public_http_target(url)
    if target_rejection_capture.captured_exception is not None:
        error = target_rejection_capture.captured_exception
        if not isinstance(error, _LinkTitleTargetRejected):
            raise RuntimeError("Remote image target rejection has unexpected type")
        return None, None, error.reason
    if target is None:
        raise RuntimeError("Remote image target resolution returned no target")

    request_capture = CapturedExceptionContext(
        httpx.TimeoutException,
        httpx.NetworkError,
        httpx.HTTPError,
        httpcore.TimeoutException,
        httpcore.NetworkError,
        httpcore.ProtocolError,
    boundary='app/services/remote_image_proxy.py:_download_one_url:request_capture')
    content = b""
    with request_capture:
        with httpx.Client(
            timeout=_FETCH_TIMEOUT_SECONDS,
            follow_redirects=False,
            transport=_PinnedHTTPTransport(
                target=target,
                network_backend=httpcore.SyncBackend(),
            ),
            headers={
                "User-Agent": _USER_AGENT,
                "Accept": "image/avif,image/webp,image/*,*/*;q=0.1",
            },
        ) as client:
            with client.stream("GET", url) as response:
                if 300 <= response.status_code < 400:
                    location = response.headers.get("location")
                    if location is None or location.strip() == "":
                        return None, None, "redirect_without_location"
                    next_url = normalize_url_for_link_title(str(httpx.URL(url).join(location)))
                    if next_url is None:
                        return None, None, "unsupported_redirect"
                    return None, next_url, None
                if response.status_code >= 400:
                    return None, None, f"http_{response.status_code}"
                declared_length = response.headers.get("content-length")
                if declared_length is not None:
                    normalized_length = declared_length.strip()
                    if not normalized_length.isdecimal():
                        return None, None, "invalid_content_length"
                    if int(normalized_length) > _MAX_IMAGE_BYTES:
                        return None, None, "too_large"
                chunks: list[bytes] = []
                total_bytes = 0
                for chunk in response.iter_bytes():
                    total_bytes += len(chunk)
                    if total_bytes > _MAX_IMAGE_BYTES:
                        return None, None, "too_large"
                    chunks.append(chunk)
                content = b"".join(chunks)
    if request_capture.captured_exception is not None:
        if isinstance(
            request_capture.captured_exception,
            (httpx.TimeoutException, httpcore.TimeoutException),
        ):
            return None, None, "timeout"
        return None, None, "network_error"
    if content == b"":
        return None, None, "empty_response"
    return content, None, None


def fetch_remote_image(url: str) -> RemoteImagePayload:
    normalized_url = normalize_url_for_link_title(url)
    if normalized_url is None:
        raise RemoteImageFetchError("unsupported_url")
    current_url = normalized_url
    for _ in range(_MAX_REDIRECTS + 1):
        content, redirect_url, error_kind = _download_one_url(current_url)
        if error_kind is not None:
            raise RemoteImageFetchError(error_kind)
        if redirect_url is not None:
            current_url = redirect_url
            continue
        if content is None:
            raise RuntimeError("Remote image download returned no terminal result")
        mime_type, validation_error = _validated_image_mime_type(content)
        if validation_error is not None:
            raise RemoteImageFetchError(validation_error)
        if mime_type is None:
            raise RuntimeError("Validated remote image is missing a MIME type")
        return RemoteImagePayload(content=content, mime_type=mime_type)
    raise RemoteImageFetchError("too_many_redirects")
