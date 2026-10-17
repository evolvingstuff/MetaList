from __future__ import annotations

from http import HTTPStatus
from fastapi import HTTPException, Request, Response

from app.config import ACTIVE_NAMESPACE
from app.server_runtime import validate_namespace
from app.utils.sent_fields import sent_or_none


AUTH_COOKIE_PREFIX = "metalist_auth"
# "Bearer <token>": the scheme and the token.
_BEARER_HEADER_PARTS = 2


def auth_cookie_name_for_namespace(namespace: str) -> str:
    normalized_namespace = validate_namespace(namespace=namespace)
    return f"{AUTH_COOKIE_PREFIX}_{normalized_namespace}"


AUTH_COOKIE_NAME = auth_cookie_name_for_namespace(ACTIVE_NAMESPACE)


def read_request_auth_token(request: Request) -> tuple[str | None, str | None]:
    if not isinstance(request, Request):
        raise TypeError("request must be a Request")

    authorization = sent_or_none(request.headers, "authorization")
    if authorization is not None:
        parts = authorization.split()
        if len(parts) != _BEARER_HEADER_PARTS or parts[0].lower() != "bearer":
            return None, "Invalid Authorization header"
        return parts[1], None

    cookie_token = request.cookies.get(AUTH_COOKIE_NAME)
    if cookie_token is None or cookie_token == "":
        return None, None
    return cookie_token, None


def get_request_auth_token(request: Request) -> str | None:
    token, error_detail = read_request_auth_token(request)
    if error_detail is not None:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail=error_detail)
    return token


def require_request_auth_token(request: Request) -> str:
    token = get_request_auth_token(request)
    if token is None:
        raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="Authentication required")
    return token


def set_auth_cookie(*, request: Request, response: Response, token: str) -> None:
    if not isinstance(request, Request):
        raise TypeError("request must be a Request")
    if not isinstance(response, Response):
        raise TypeError("response must be a Response")
    if not isinstance(token, str) or token == "":
        raise ValueError("token must be a non-empty string")

    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )


def clear_auth_cookie(*, response: Response) -> None:
    if not isinstance(response, Response):
        raise TypeError("response must be a Response")
    response.delete_cookie(key=AUTH_COOKIE_NAME, path="/")
