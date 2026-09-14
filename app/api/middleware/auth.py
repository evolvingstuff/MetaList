"""Authentication middleware for API requests."""

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware
from app.api.request_auth import read_request_auth_token
from app.services.tokens import token_service
from app.services.maintenance_mode import maintenance_service
from app.security.encryption import is_encryption_required
from app.config import API_PREFIX, TEST_MODE


class AuthMiddleware(BaseHTTPMiddleware):
    """Middleware to check authentication on protected routes."""

    PUBLIC_EXACT_PATHS = frozenset({
        "/",
        f"{API_PREFIX}/auth/login",
        f"{API_PREFIX}/auth/login-namespaces",
        f"{API_PREFIX}/auth/login-namespaces/open",
        f"{API_PREFIX}/auth/status",
        f"{API_PREFIX}/auth/app-update/check",
        f"{API_PREFIX}/auth/session",
        "/favicon.ico",
        "/locked",
        "/namespace-deleted",
        "/namespace-deleted/open",
        "/namespace-renamed",
        "/namespace-renamed/open",
    } | ({f"{API_PREFIX}/test/reset"} if TEST_MODE else set()))

    PUBLIC_PREFIX_PATHS = (
        f"{API_PREFIX}/auth/app-update/jobs/",  # Opaque job capability survives restart/logout.
        f"{API_PREFIX}/auth/namespaces/delete-jobs/",
        f"{API_PREFIX}/auth/namespaces/rename-jobs/",
        "/static/",  # CSS/JS files needed for login page
    )
    assert all(path.endswith("/") for path in PUBLIC_PREFIX_PATHS)
    
    # Paths to suppress verbose logging for (frequent polling endpoints)
    QUIET_PATHS = [
        f"{API_PREFIX}/auth/status",
    ]
    
    # Background/automated paths that should NOT refresh tokens (not user activity)
    NO_TOKEN_REFRESH_PATHS = [
        f"{API_PREFIX}/auth/status",  # Polling service pings this for connectivity
        f"{API_PREFIX}/reminders/evaluate",  # Reminder polling is not user-initiated activity
    ]
    
    # Note: /api/notes/* paths are NOT in this list - they require auth when password is set

    @classmethod
    def is_public_path(cls, *, path: str) -> bool:
        if not isinstance(path, str) or not path.startswith("/"):
            raise TypeError("path must be an absolute URL path")
        if path in cls.PUBLIC_EXACT_PATHS:
            return True
        return any(path.startswith(prefix) for prefix in cls.PUBLIC_PREFIX_PATHS)
    
    async def dispatch(self, request: Request, call_next):
        """Check authentication for protected routes."""
        path = request.url.path

        # Block any v1 API usage with an explicit 410 Gone (no DB access)
        if path.startswith('/api') and not (path.startswith(API_PREFIX) or path == API_PREFIX):
            return JSONResponse(status_code=410, content={"detail": "Use the current API version"})
        
        # Check if maintenance mode is active first
        if maintenance_service.is_active():
            # Allow access to maintenance page itself
            if path == "/maintenance":
                return await call_next(request)
            
            # Redirect all other requests to maintenance page
            return RedirectResponse(url="/maintenance", status_code=302)
        
        # Check if this is a quiet path (suppress verbose logging)
        is_quiet = any(path.startswith(quiet) for quiet in self.QUIET_PATHS)
        
        if not is_quiet:
            print(f"Middleware checking path: {path}")
        
        if self.is_public_path(path=path):
            if not is_quiet:
                print(f"Path {path} is explicitly public, skipping auth")
            return await call_next(request)
        
        if not is_quiet:
            print(f"Path {path} is NOT public, checking auth")
        
        # Startup and recoverable password transitions publish this memory-owned flag.
        if path == f"{API_PREFIX}/auth/settings/password/create" and not is_encryption_required():
            return await call_next(request)

        token, error_detail = read_request_auth_token(request)
        if error_detail is not None:
            return JSONResponse(status_code=401, content={"detail": error_detail})

        if token is None:
            return JSONResponse(
                status_code=401,
                content={"detail": "Authentication required"}
            )

        tab_id = request.headers.get("x-metalist-tab-id")
        if not tab_id:
            return JSONResponse(status_code=400, content={"detail": "X-Metalist-Tab-Id header required"})

        claim = request.headers.get("x-metalist-claim") == "1"
        if claim:
            token_service.claim_token_for_tab(token, tab_id)

        if not token_service.verify_token_for_tab(token, tab_id):
            return JSONResponse(
                status_code=401,
                content={"detail": "Authentication required"}
            )

        # Refresh token on user-initiated paths only
        if not any(path.startswith(p) for p in self.NO_TOKEN_REFRESH_PATHS):
            token_service.refresh_token(token)

        return await call_next(request)
