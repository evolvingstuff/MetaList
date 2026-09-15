from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.api.request_auth import AUTH_COOKIE_NAME
from app.services.exception_capture import CapturedExceptionContext
from app.security.request_hosts import _normalize_hostname, resolve_allowed_request_hosts


_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@dataclass(frozen=True)
class RequestBoundaryRejection:
    status_code: int
    detail: str


def _parse_host_header(host_header: str) -> tuple[str, int | None] | None:
    raw_host = host_header.strip()
    if raw_host == "":
        return None
    if any(character in raw_host for character in (",", "/", "\\", "@", "?", "#")):
        return None
    if any(character.isspace() for character in raw_host):
        return None

    parse_capture = CapturedExceptionContext(ValueError, boundary='app/security/request_boundary.py:_parse_host_header:parse_capture')
    port: int | None = None
    hostname: str | None = None
    with parse_capture:
        parsed = urlsplit(f"//{raw_host}")
        if parsed.hostname is None:
            return None
        port = parsed.port
        hostname = _normalize_hostname(hostname=parsed.hostname, context="Host header")
    if parse_capture.captured_exception is not None:
        return None
    if hostname is None:
        raise RuntimeError("Host header parser returned no hostname")
    return hostname, port


def _parse_origin(origin_header: str) -> tuple[str, str, int] | None:
    parse_capture = CapturedExceptionContext(ValueError, boundary='app/security/request_boundary.py:_parse_origin:parse_capture')
    hostname: str | None = None
    parsed_port: int | None = None
    with parse_capture:
        parsed = urlsplit(origin_header.strip())
        if parsed.scheme not in {"http", "https"}:
            return None
        if parsed.hostname is None or parsed.username is not None or parsed.password is not None:
            return None
        if parsed.path not in {"", "/"} or parsed.query != "" or parsed.fragment != "":
            return None
        hostname = _normalize_hostname(hostname=parsed.hostname, context="Origin header")
        parsed_port = parsed.port
    if parse_capture.captured_exception is not None:
        return None
    if hostname is None:
        raise RuntimeError("Origin header parser returned no hostname")
    if parsed_port is None:
        if parsed.scheme == "https":
            parsed_port = 443
        else:
            parsed_port = 80
    return parsed.scheme, hostname, parsed_port


def _resolve_request_authority(*, scheme: str, host_header: str) -> tuple[str, str, int] | None:
    normalized_scheme = scheme.strip().casefold()
    if normalized_scheme not in {"http", "https"}:
        return None
    parsed_host = _parse_host_header(host_header)
    if parsed_host is None:
        return None
    hostname, port = parsed_host
    if port is None:
        if normalized_scheme == "https":
            port = 443
        else:
            port = 80
    return normalized_scheme, hostname, port


def _is_bearer_authorization(authorization_header: str | None) -> bool:
    if authorization_header is None:
        return False
    parts = authorization_header.split()
    return len(parts) == 2 and parts[0].casefold() == "bearer" and parts[1] != ""


def evaluate_request_boundary(
    *,
    method: str,
    request_scheme: str,
    host_header: str | None,
    origin_header: str | None,
    authorization_header: str | None,
    has_auth_cookie: bool,
    allowed_hosts: frozenset[str],
) -> RequestBoundaryRejection | None:
    if not isinstance(method, str) or method == "":
        raise TypeError("method must be a non-empty string")
    if not isinstance(request_scheme, str) or request_scheme == "":
        raise TypeError("request_scheme must be a non-empty string")
    if not isinstance(has_auth_cookie, bool):
        raise TypeError("has_auth_cookie must be a bool")
    if not isinstance(allowed_hosts, frozenset) or len(allowed_hosts) == 0:
        raise TypeError("allowed_hosts must be a non-empty frozenset")

    if host_header is None:
        return RequestBoundaryRejection(400, "Host header required")
    request_authority = _resolve_request_authority(
        scheme=request_scheme,
        host_header=host_header,
    )
    if request_authority is None:
        return RequestBoundaryRejection(400, "Malformed Host header")
    _, request_hostname, _ = request_authority
    if request_hostname not in allowed_hosts:
        return RequestBoundaryRejection(400, "Unrecognized Host header")

    if method.upper() in _SAFE_METHODS:
        return None

    if origin_header is None:
        is_bearer_client = _is_bearer_authorization(authorization_header)
        if is_bearer_client and not has_auth_cookie:
            return None
        return RequestBoundaryRejection(403, "Origin header required for state-changing request")

    origin = _parse_origin(origin_header)
    if origin is None:
        return RequestBoundaryRejection(403, "Invalid Origin header")
    if origin != request_authority:
        return RequestBoundaryRejection(403, "Origin does not match request host")
    return None


class RequestBoundaryMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, allowed_hosts: frozenset[str]) -> None:
        super().__init__(app)
        if not isinstance(allowed_hosts, frozenset) or len(allowed_hosts) == 0:
            raise TypeError("allowed_hosts must be a non-empty frozenset")
        self._allowed_hosts = allowed_hosts

    async def dispatch(self, request: Request, call_next):
        host_headers = request.headers.getlist("host")
        if len(host_headers) != 1:
            return JSONResponse(status_code=400, content={"detail": "Exactly one Host header required"})
        lengths = request.headers.getlist("content-length")
        transfers = request.headers.getlist("transfer-encoding")
        if len(lengths) > 1 or len(request.headers.getlist("origin")) > 1 or (lengths and transfers):
            return JSONResponse(status_code=400, content={"detail": "Ambiguous request headers"})
        if lengths and (not lengths[0].isascii() or not lengths[0].isdigit()):
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
        rejection = evaluate_request_boundary(
            method=request.method,
            request_scheme=request.scope["scheme"],
            host_header=host_headers[0],
            origin_header=request.headers.get("origin"),
            authorization_header=request.headers.get("authorization"),
            has_auth_cookie=AUTH_COOKIE_NAME in request.cookies,
            allowed_hosts=self._allowed_hosts,
        )
        if rejection is not None:
            return JSONResponse(
                status_code=rejection.status_code,
                content={"detail": rejection.detail},
            )
        return await call_next(request)
