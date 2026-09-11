from fastapi import FastAPI, Request, Depends
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.exceptions import RequestValidationError
from pathlib import Path
from typing import Annotated
import json
import secrets
from app.presentation.templates import get_templates
from .api import dev
from .api.middleware.auth import AuthMiddleware
from app.config import ACTIVE_NAMESPACE, STARTUP_ANIMATION_ENABLED, VERSION
from .db.session import begin_writer, enable_read_guard
from .db.schema import initialize_schema
from .db.migrations import CURRENT_DATABASE_VERSION
from .db.migrations import read_database_version
from .db.migrations import run_database_migrations
from .db.notes_sql import clear_encryption_metadata_for_empty_notes
from .db.settings_sql import fetch_settings, insert_default_settings
from .api.deps import get_db
from .services.content_cache import populate_cache_from_db
from .services.file_storage import bootstrap_file_registry
from .services.auth import AuthService
from .services.note_store import store as note_store
from app.services import auth_cache_state
from app.services.integrity import assert_linked_list_integrity
from app.services.tag_ontology import OntologyParseError
from app.services.ontology_rules_store import bootstrap_ontology_rules_store
from app.services.tab_state import tab_state_store
from app.services.link_titles import link_title_store
from app.services.reminders import reminder_store
from app.services.search_history import search_history_store
from app.services.sound_storage import sound_store
from app.services.runtime_hardening import apply_runtime_hardening
from app.security.encryption import set_encryption_required
from app.security.http_headers import apply_security_headers
from app.security.request_boundary import evaluate_request_boundary
from app.security.request_boundary import resolve_allowed_request_hosts
from app.security.validation_errors import summarize_validation_errors
from app.server_runtime import resolve_https_redirect_url
from app.server_runtime import resolve_request_host_for_https_redirect
from app.server_runtime import validate_namespace
from app.services.exception_capture import CapturedExceptionContext
from app.services.namespace_deletion_jobs import load_namespace_deletion_job
from app.services.namespace_rename_jobs import load_namespace_rename_job
from app.services.namespace_switcher import build_namespace_catalog
from app.services.namespace_switcher import open_or_launch_namespace
from app.services.namespace_runtime_guard import start_namespace_runtime_guard
from app.services.diagnostics import configure_process_diagnostics
from app.services.diagnostics import allow_plaintext_diagnostics
from app.services.diagnostics import start_asyncio_diagnostics
from app.services.diagnostics import track_request
from app.api.request_auth import AUTH_COOKIE_NAME, clear_auth_cookie
from app.api.routes.notes import router as api2_router
from app.api.routes.auth import router as api2_auth_router
from app.api.routes.files import router as api2_files_router
from app.api.routes.sounds import router as api2_sounds_router
from app.api.routes.ontology import router as api2_ontology_router
from app.api.routes.backups import router as api2_backup_router
from app.api.routes.reminders import router as api2_reminders_router
from app.api.routes.remote_images import router as api2_remote_images_router
from app.api.routes.ai import router as api2_ai_router
from app.api.routes.test import router as api2_test_router
from app.api.transactions import transactional_route
from app.config import API_PREFIX, TEST_MODE, V1_API_PREFIX
from app.config import CRASH_SERVER_ON_FAIL
from .models.database import SafeSession
from loguru import logger
import logging
import time
import sys
import uuid
from starlette.staticfiles import StaticFiles as StarletteStaticFiles
from fastapi.middleware.gzip import GZipMiddleware
import os
from urllib.parse import parse_qsl
from urllib.parse import urlencode
from urllib.parse import urlsplit
from urllib.parse import urlunsplit

logger.remove()
logger.add(
    sys.stdout,
    level="INFO",
    backtrace=False,
    diagnose=False,
    filter=allow_plaintext_diagnostics,
    format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level:<8} | {message} | {extra}"
)


class InterceptHandler(logging.Handler):
    def emit(self, record):
        level = record.levelno

        frame, depth = logging.currentframe(), 2
        while frame and frame.f_code.co_filename == logging.__file__:
            frame = frame.f_back
            depth += 1

        error_type = ""
        if record.exc_info is not None:
            error_type = f" error_type={record.exc_info[0].__name__}"
        logger.opt(depth=depth).log(
            level,
            f"{record.getMessage()}{error_type}",
        )


logging.basicConfig(handlers=[InterceptHandler()], level=0, force=True)


def _resolve_diagnostics_namespace(*, namespace: str | None) -> str:
    if namespace is None:
        return "default"
    if namespace == "":
        raise RuntimeError("Active namespace must not be empty")
    return namespace


configure_process_diagnostics(
    namespace=_resolve_diagnostics_namespace(namespace=ACTIVE_NAMESPACE),
    enabled=not TEST_MODE,
)

app = FastAPI()


@app.on_event("startup")
async def start_diagnostics_watchdogs():
    start_asyncio_diagnostics(enabled=not TEST_MODE)
    start_namespace_runtime_guard(
        namespace=ACTIVE_NAMESPACE,
        enabled=not TEST_MODE,
    )

# CRASH SERVER ON VALIDATION ERRORS - FAIL FAST AND LOUD
@app.exception_handler(RequestValidationError)
async def crash_on_validation_error(request: Request, exc: RequestValidationError):
    validation_summary = summarize_validation_errors(exc.errors())
    if CRASH_SERVER_ON_FAIL:
        logger.error(f"🚨 FATAL: Validation error on {request.method} {request.url.path}")
        logger.error(f"🚨 Validation errors: {validation_summary}")
        logger.error(f"🚨 CRASHING SERVER IMMEDIATELY")
        raise RuntimeError(
            f"VALIDATION FAILED - CRASHING: {request.method} "
            f"{request.url.path}: {validation_summary}"
        ) from exc
    else:
        # Normal behavior - return 422
        return JSONResponse(status_code=422, content={"detail": validation_summary})


@app.exception_handler(OntologyParseError)
async def handle_ontology_parse_error(request: Request, exc: OntologyParseError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})

_startup_timing_enabled = True


def _log_startup_step(step: str, elapsed: float) -> None:
    if not _startup_timing_enabled:
        return
    message = f"[startup] {step} took {elapsed:.2f}s"
    logger.info(message)


overall_start = time.perf_counter()

hardening_start = time.perf_counter()
apply_runtime_hardening()
_log_startup_step("runtime hardening checks", time.perf_counter() - hardening_start)

schema_start = time.perf_counter()
with begin_writer() as connection:
    initialize_schema(connection.raw_connection)
    settings = fetch_settings(connection)
    if not settings:
        insert_default_settings(connection)
        settings = fetch_settings(connection)
    if settings is None:
        raise RuntimeError("App settings missing after schema initialization")
    database_version = read_database_version(connection.raw_connection)
    if database_version > CURRENT_DATABASE_VERSION:
        raise RuntimeError(
            f"Database version {database_version} is newer than supported version "
            f"{CURRENT_DATABASE_VERSION}"
        )
    if not bool(settings["encryption_enabled"]):
        run_database_migrations(
            connection=connection.raw_connection,
            encryption_enabled=False,
            encryption_service=None,
        )
        database_version = CURRENT_DATABASE_VERSION
    bootstrap_ontology_rules_store(connection=connection)
    tab_state_store.bootstrap(connection=connection)
    link_title_store.bootstrap(connection=connection)
    reminder_store.bootstrap(connection=connection)
    if not bool(settings["encryption_enabled"]) or database_version >= CURRENT_DATABASE_VERSION:
        search_history_store.bootstrap(connection=connection)
    else:
        search_history_store.reset()
_log_startup_step("schema + settings bootstrap", time.perf_counter() - schema_start)

startup_has_password = False
encryption_enabled = False
if settings:
    encryption_enabled = bool(settings["encryption_enabled"])
    startup_has_password = encryption_enabled
set_encryption_required(encryption_enabled)

file_registry_start = time.perf_counter()
bootstrap_file_registry()
_log_startup_step("file registry bootstrap", time.perf_counter() - file_registry_start)

sound_store_start = time.perf_counter()
if startup_has_password:
    sound_store.reset()
else:
    sound_store.bootstrap(token="")
_log_startup_step("sound store bootstrap", time.perf_counter() - sound_store_start)


def _resolve_page_title(*, base_title: str) -> str:
    if ACTIVE_NAMESPACE in {None, "default"}:
        return base_title
    return f"{base_title} [{ACTIVE_NAMESPACE}]"

integrity_start = time.perf_counter()
integrity_session = SafeSession()
try:
    assert_linked_list_integrity(integrity_session, "startup")
    integrity_session.commit()
finally:
    integrity_session.close()
_log_startup_step("linked list integrity check", time.perf_counter() - integrity_start)

if startup_has_password:
    logger.info("[startup] password set; skipping cache + store hydration until login")
    auth_cache_state.reset_cache_state()
    guard_start = time.perf_counter()
    enable_read_guard()
    _log_startup_step("read guard enable", time.perf_counter() - guard_start)
    _log_startup_step("total startup", time.perf_counter() - overall_start)
else:
    # Populate content cache on startup
    repair_start = time.perf_counter()
    with begin_writer() as connection:
        repaired = clear_encryption_metadata_for_empty_notes(connection)
    if repaired:
        logger.info(
            f"[startup] repaired {repaired} empty encrypted notes (cleared nonce/tag)"
        )
    _log_startup_step(
        "empty-note encryption metadata repair",
        time.perf_counter() - repair_start,
    )

    cache_start = time.perf_counter()
    cache_session = SafeSession()
    try:
        prefetched_rows = populate_cache_from_db(cache_session)
        cache_session.commit()
    finally:
        cache_session.close()
    _log_startup_step("cache population", time.perf_counter() - cache_start)

    store_start = time.perf_counter()
    note_store.load_from_db(None, prefetched_rows=prefetched_rows)
    _log_startup_step("note store hydration", time.perf_counter() - store_start)
    auth_cache_state.mark_cache_ready()

    guard_start = time.perf_counter()
    enable_read_guard()
    _log_startup_step("read guard enable", time.perf_counter() - guard_start)

    _log_startup_step("total startup", time.perf_counter() - overall_start)

# Custom StaticFiles class that disables caching
class NoCacheStaticFiles(StarletteStaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            # Set no-cache headers for all static files
            response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            response.headers['Pragma'] = 'no-cache'
            response.headers['Expires'] = '0'
            
            # Log when JavaScript files are served
            if path.endswith('.js'):
                logger.debug(f"JS file served with no-cache headers: {path}")
                
        return response

# Add GZip compression
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Add authentication middleware
app.add_middleware(AuthMiddleware)

# Mount static files with no-cache headers
app.mount(
    "/static",
    NoCacheStaticFiles(directory=str(Path(__file__).resolve().parent / "static")),
    name="static",
)

ASSET_VERSION = str(int(time.time()))

templates = get_templates(
    template_directory=Path(__file__).resolve().parent / "templates",
)
allowed_request_hosts = resolve_allowed_request_hosts(environ=os.environ)

# v2 routers mounted under configured API_PREFIX
app.include_router(api2_router, prefix=API_PREFIX, tags=["api2"]) 
app.include_router(api2_auth_router, prefix=API_PREFIX)
app.include_router(api2_backup_router, prefix=API_PREFIX)
app.include_router(api2_files_router, prefix=API_PREFIX)
app.include_router(api2_sounds_router, prefix=API_PREFIX)
app.include_router(api2_ontology_router, prefix=API_PREFIX)
app.include_router(api2_reminders_router, prefix=API_PREFIX)
app.include_router(api2_remote_images_router, prefix=API_PREFIX)
app.include_router(api2_ai_router, prefix=API_PREFIX)
if TEST_MODE:
    app.include_router(dev.router, prefix="/dev", tags=["dev"])
    app.include_router(api2_test_router, prefix=API_PREFIX, tags=["api2-test"])

# Catch-all guard for any v1 API access (hard exit)
@app.api_route(f"{V1_API_PREFIX}/{{rest_of_path:path}}", methods=["GET","POST","PUT","DELETE","PATCH","OPTIONS","HEAD"])
@transactional_route
async def block_v1_any(rest_of_path: str):
    os._exit(1)

@app.api_route(f"{V1_API_PREFIX}", methods=["GET","POST","PUT","DELETE","PATCH","OPTIONS","HEAD"])
@transactional_route
async def block_v1_root():
    os._exit(1)


@app.middleware("http")
async def redirect_remote_http_to_https(request: Request, call_next):
    request_host = resolve_request_host_for_https_redirect(
        host_header=request.headers.get("host"),
        fallback_host=request.url.hostname,
    )
    redirect_url = resolve_https_redirect_url(
        environ=os.environ,
        request_scheme=request.url.scheme,
        request_host=request_host,
        request_path=request.url.path,
        request_query=request.url.query,
    )
    if redirect_url is not None:
        return RedirectResponse(url=redirect_url, status_code=307)
    return await call_next(request)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    request_id = uuid.uuid4().hex[:8]
    handler = request.scope.get("endpoint")
    handler_name = getattr(handler, "__qualname__", "unknown")

    path = request.url.path
    is_noisy_poll = request.method == "GET" and path == f"{API_PREFIX}/auth/status"
    is_noisy_lock = request.method == "POST" and path in {
        f"{API_PREFIX}/notes/acquire-lock",
        f"{API_PREFIX}/notes/release-lock",
    }
    if not (is_noisy_poll or is_noisy_lock):
        logger.bind(request_id=request_id).info(
            "⇒ {method} {path} handler={handler}",
            method=request.method,
            path=path,
            handler=handler_name,
        )

    start = time.perf_counter()
    if request.client is None:
        raise RuntimeError("Request is missing client metadata")
    client_host = request.client.host
    request_tracker = track_request(
        request_id=request_id,
        method=request.method,
        path=path,
        has_query=request.url.query != "",
        client=client_host,
        user_agent=request.headers.get("user-agent", "-"),
        started_at=start,
    )
    with request_tracker:
        response = await call_next(request)

    duration_ms = (time.perf_counter() - start) * 1000
    size = response.headers.get("content-length", "-")
    if not (is_noisy_poll or is_noisy_lock):
        logger.bind(request_id=request_id).info(
            "⇐ {status} {method} {path} handler={handler} duration={duration:.2f} ms size={size}",
            status=response.status_code,
            method=request.method,
            path=path,
            handler=handler_name,
            duration=duration_ms,
            size=size,
        )
    return response


@app.middleware("http")
async def validate_request_boundary(request: Request, call_next):
    host_headers = request.headers.getlist("host")
    if len(host_headers) != 1:
        return JSONResponse(
            status_code=400,
            content={"detail": "Exactly one Host header required"},
        )
    rejection = evaluate_request_boundary(
        method=request.method,
        request_scheme=request.url.scheme,
        host_header=host_headers[0],
        origin_header=request.headers.get("origin"),
        authorization_header=request.headers.get("authorization"),
        has_auth_cookie=AUTH_COOKIE_NAME in request.cookies,
        allowed_hosts=allowed_request_hosts,
    )
    if rejection is not None:
        return JSONResponse(
            status_code=rejection.status_code,
            content={"detail": rejection.detail},
        )
    return await call_next(request)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    nonce = secrets.token_urlsafe(24)
    if len(nonce) != 32:
        raise RuntimeError("Generated CSP nonce has unexpected length")
    request.state.csp_nonce = nonce
    response = await call_next(request)
    apply_security_headers(response=response, nonce=nonce)
    return response

@app.get("/", response_class=HTMLResponse)
async def home(request: Request, db: Annotated[SafeSession, Depends(get_db)]):
    template = templates.get_template("index.html")

    auth = AuthService(db)
    needs_auth = auth.has_password()

    if needs_auth:
        return template.render(
            request=request,
            version=VERSION,
            asset_version=ASSET_VERSION,
            page_title=_resolve_page_title(base_title="MetaList"),
            needs_auth=True,
            startup_animation_enabled=STARTUP_ANIMATION_ENABLED,
        )
    return template.render(
        request=request,
        notes=[],
        version=VERSION,
        asset_version=ASSET_VERSION,
        page_title=_resolve_page_title(base_title="MetaList"),
        needs_auth=False,
        startup_animation_enabled=STARTUP_ANIMATION_ENABLED,
    )


@app.get("/maintenance", response_class=HTMLResponse)
async def maintenance_page(request: Request):
    """Maintenance mode page shown during bulk operations."""
    template = templates.get_template("maintenance.html")
    return template.render(
        request=request,
        version=VERSION,
        asset_version=ASSET_VERSION,
        page_title=_resolve_page_title(base_title="MetaList - Processing"),
    )


def _build_namespace_deleted_links(*, job_id: str, redirect_namespace: str) -> list[dict[str, str]]:
    normalized_redirect_namespace = validate_namespace(namespace=redirect_namespace)
    query = urlencode({"job": job_id, "namespace": normalized_redirect_namespace})
    return [
        {
            "namespace": normalized_redirect_namespace,
            "label": normalized_redirect_namespace,
            "meta": "Selected destination",
            "href": f"/namespace-deleted/open?{query}",
        }
    ]


def _resolve_catalog_profile(*, namespace: str) -> tuple[int, int | None]:
    catalog = build_namespace_catalog(
        environ=os.environ,
        current_namespace=ACTIVE_NAMESPACE,
    )
    raw_namespaces = catalog["namespaces"]
    if not isinstance(raw_namespaces, list):
        raise RuntimeError("Namespace catalog missing namespaces")
    for entry in raw_namespaces:
        if not isinstance(entry, dict):
            raise RuntimeError("Namespace catalog entry must be an object")
        if entry["namespace"] != namespace:
            continue
        profile = entry["default_profile"]
        if not isinstance(profile, dict):
            raise RuntimeError(f"Namespace {namespace} is missing default profile")
        port = profile["port"]
        https_port = profile["https_port"]
        if not isinstance(port, int):
            raise RuntimeError(f"Namespace {namespace} profile missing port")
        if https_port is not None and not isinstance(https_port, int):
            raise RuntimeError(f"Namespace {namespace} profile has invalid https_port")
        return port, https_port
    raise RuntimeError(f"Unknown namespace: {namespace}")


def _build_force_reauth_url(*, url: str) -> str:
    if not isinstance(url, str) or url == "":
        raise TypeError("url must be a non-empty string")
    parsed = urlsplit(url)
    path = parsed.path
    if path == "":
        path = "/"
    query_items = [
        (name, value)
        for name, value in parse_qsl(parsed.query, keep_blank_values=True)
        if name != "force_reauth"
    ]
    query_items.append(("force_reauth", "1"))
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            path,
            urlencode(query_items),
            parsed.fragment,
        )
    )


@app.get("/namespace-deleted", response_class=HTMLResponse)
async def namespace_deleted_page(request: Request):
    job_id = request.query_params.get("job")
    if not isinstance(job_id, str) or job_id.strip() == "":
        return HTMLResponse("Missing namespace deletion job", status_code=400)
    job_record_capture = CapturedExceptionContext(
        RuntimeError,
        TypeError,
        ValueError,
        FileNotFoundError,
    )
    job_record: dict[str, object] | None = None
    with job_record_capture:
        job_record = load_namespace_deletion_job(job_id=job_id)
    if job_record_capture.captured_exception is not None:
        exc = job_record_capture.captured_exception
        return HTMLResponse(str(exc), status_code=400)
    if job_record is None:
        return HTMLResponse(f"Namespace deletion job not found: {job_id}", status_code=404)

    template = templates.get_template("namespace_deleted.html")
    namespace_links = _build_namespace_deleted_links(
        job_id=job_record["job_id"],
        redirect_namespace=job_record["redirect_namespace"],
    )
    page_state = json.dumps(
        {
            "jobId": job_record["job_id"],
            "deletedNamespace": job_record["deleted_namespace"],
            "initialStatus": job_record["status"],
            "initialError": job_record["error"],
            "redirectNamespace": job_record["redirect_namespace"],
        }
    )
    return template.render(
        request=request,
        version=VERSION,
        asset_version=ASSET_VERSION,
        page_title="MetaList - Namespace Deleted",
        deleted_namespace=job_record["deleted_namespace"],
        namespace_links=namespace_links,
        page_state_json=page_state,
    )


@app.get("/namespace-deleted/open")
async def namespace_deleted_open_page(request: Request):
    job_id = request.query_params.get("job")
    namespace = request.query_params.get("namespace")
    if not isinstance(job_id, str) or job_id.strip() == "":
        return HTMLResponse("Missing namespace deletion job", status_code=400)
    if not isinstance(namespace, str) or namespace.strip() == "":
        return HTMLResponse("Missing namespace", status_code=400)
    job_record_capture = CapturedExceptionContext(
        RuntimeError,
        TypeError,
        ValueError,
        FileNotFoundError,
    )
    job_record: dict[str, object] | None = None
    with job_record_capture:
        job_record = load_namespace_deletion_job(job_id=job_id)
    if job_record_capture.captured_exception is not None:
        exc = job_record_capture.captured_exception
        return HTMLResponse(str(exc), status_code=400)
    if job_record is None:
        return HTMLResponse(f"Namespace deletion job not found: {job_id}", status_code=404)
    if job_record["status"] == "pending":
        return HTMLResponse("Namespace deletion is still in progress", status_code=409)
    if (
        namespace == job_record["deleted_namespace"]
        and namespace != job_record["redirect_namespace"]
    ):
        return HTMLResponse("Deleted namespace is unavailable", status_code=400)

    launch_capture = CapturedExceptionContext(
        RuntimeError,
        TypeError,
        ValueError,
        FileNotFoundError,
    )
    result = None
    with launch_capture:
        port, https_port = _resolve_catalog_profile(namespace=namespace)
        result = open_or_launch_namespace(
            environ=os.environ,
            current_namespace=ACTIVE_NAMESPACE,
            namespace=namespace,
            port=port,
            https_port=https_port,
        )
    if launch_capture.captured_exception is not None:
        exc = launch_capture.captured_exception
        return HTMLResponse(str(exc), status_code=400)
    if result is None:
        raise RuntimeError("Namespace launch did not return a result")
    response = RedirectResponse(url=_build_force_reauth_url(url=result.url), status_code=307)
    clear_auth_cookie(response=response)
    return response


@app.get("/namespace-renamed", response_class=HTMLResponse)
async def namespace_renamed_page(request: Request):
    job_id = request.query_params.get("job")
    if not isinstance(job_id, str) or job_id.strip() == "":
        return HTMLResponse("Missing namespace rename job", status_code=400)
    job_record_capture = CapturedExceptionContext(
        RuntimeError,
        TypeError,
        ValueError,
        FileNotFoundError,
    )
    job_record: dict[str, object] | None = None
    with job_record_capture:
        job_record = load_namespace_rename_job(job_id=job_id)
    if job_record_capture.captured_exception is not None:
        exc = job_record_capture.captured_exception
        return HTMLResponse(str(exc), status_code=400)
    if job_record is None:
        return HTMLResponse(f"Namespace rename job not found: {job_id}", status_code=404)

    page_state = json.dumps(
        {
            "jobId": job_record["job_id"],
            "sourceNamespace": job_record["source_namespace"],
            "targetNamespace": job_record["target_namespace"],
            "initialStatus": job_record["status"],
            "initialError": job_record["error"],
        }
    )
    template = templates.get_template("namespace_renamed.html")
    return template.render(
        request=request,
        version=VERSION,
        asset_version=ASSET_VERSION,
        page_title="MetaList - Namespace Renamed",
        source_namespace=job_record["source_namespace"],
        target_namespace=job_record["target_namespace"],
        page_state_json=page_state,
    )


@app.get("/namespace-renamed/open")
async def namespace_renamed_open_page(request: Request):
    job_id = request.query_params.get("job")
    if not isinstance(job_id, str) or job_id.strip() == "":
        return HTMLResponse("Missing namespace rename job", status_code=400)
    job_record_capture = CapturedExceptionContext(
        RuntimeError,
        TypeError,
        ValueError,
        FileNotFoundError,
    )
    job_record: dict[str, object] | None = None
    with job_record_capture:
        job_record = load_namespace_rename_job(job_id=job_id)
    if job_record_capture.captured_exception is not None:
        exc = job_record_capture.captured_exception
        return HTMLResponse(str(exc), status_code=400)
    if job_record is None:
        return HTMLResponse(f"Namespace rename job not found: {job_id}", status_code=404)
    if job_record["status"] != "succeeded":
        return HTMLResponse("Namespace rename is not complete", status_code=409)
    if ACTIVE_NAMESPACE != job_record["target_namespace"]:
        return HTMLResponse("Renamed namespace is not running here", status_code=409)
    response = RedirectResponse(url="/?force_reauth=1", status_code=307)
    clear_auth_cookie(response=response)
    return response


@app.get("/locked", response_class=HTMLResponse)
async def locked_page(request: Request, db: Annotated[SafeSession, Depends(get_db)]):
    """Render a dedicated locked screen when a session is invalidated."""
    template = templates.get_template("locked.html")
    auth = AuthService(db)
    has_password = auth.has_password()
    return template.render(
        request=request,
        version=VERSION,
        asset_version=ASSET_VERSION,
        page_title=_resolve_page_title(base_title="MetaList – Locked"),
        has_password=has_password,
    )
