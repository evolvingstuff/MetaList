"""Whether the page opens straight on the login screen (docs/AI-SUMMARY.md, Login screen)."""

from __future__ import annotations

from starlette.requests import Request

from app.api.request_auth import AUTH_COOKIE_NAME
from app.services.tokens import token_service
from app.utils.sent_fields import sent_or_none


def login_is_certainly_needed(request: Request) -> bool:
    """Whether a password namespace's page can open on the login screen at once,
    with no white page before the browser checks its session: a re-login was asked
    for (the Session locked page's Go to Login), or the browser has no session the
    server still knows (no cookie, or one from a session that has ended)."""
    if not isinstance(request, Request):
        raise TypeError("request must be a Request")
    if sent_or_none(request.query_params, "force_reauth") == "1":
        return True
    cookie_token = sent_or_none(request.cookies, AUTH_COOKIE_NAME)
    if cookie_token is None:
        return True
    return not token_service.verify_token(cookie_token)
