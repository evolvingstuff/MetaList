from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
import ipaddress
import re
import socket
from threading import RLock
from typing import Iterable, Mapping
from urllib.parse import urlsplit, urlunsplit

import httpcore
import httpx

from app.config import TEST_MODE
from app.services.runtime_generation import current_generation
from app.services.bulk_operation import bulk_operation_guard
from app.db.link_titles_sql import (
    fetch_all_link_title_rows,
    insert_link_title_row,
    update_link_title_row,
)
from app.db.session import begin_writer
from app.security.encryption import decrypt, encrypt, get_encryption_service
from app.services.exception_capture import CapturedExceptionContext

_FETCH_TIMEOUT_SECONDS = 4.0
_MAX_REDIRECTS = 5
_MAX_RESPONSE_BYTES = 1024 * 1024
_OK_REFRESH_AFTER = timedelta(days=90)
_NO_TITLE_REFRESH_AFTER = timedelta(days=30)
_FAILED_REFRESH_AFTER = timedelta(days=7)
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

_AUTO_RETRY_STATUSES = {"ok", "no_title", "failed"}
_FAILED_RETRY_DELAYS = (
    timedelta(minutes=1),
    timedelta(minutes=5),
    timedelta(minutes=30),
    timedelta(hours=6),
    timedelta(days=1),
    _FAILED_REFRESH_AFTER,
)
_NO_TITLE_RETRY_DELAYS = (
    timedelta(minutes=1),
    timedelta(minutes=10),
    timedelta(hours=1),
    timedelta(days=1),
    timedelta(days=7),
    _NO_TITLE_REFRESH_AFTER,
)
_INTERSTITIAL_TITLE_EXACT_MATCHES = {
    "access denied",
    "attention required",
    "browser check",
    "checking your browser",
    "enable javascript",
    "just a moment",
    "login",
    "please wait",
    "sign in",
    "verification required",
}
_INTERSTITIAL_TITLE_PHRASES = (
    "access denied",
    "are you a human",
    "bot detection",
    "checking if the site connection is secure",
    "checking your browser",
    "complete the security check",
    "enable cookies",
    "enable javascript",
    "human verification",
    "please enable js",
    "please enable javascript",
    "please wait for verification",
    "security check",
    "verify you are human",
)


@dataclass(frozen=True, slots=True)
class LinkTitleRecord:
    id: int
    url: str
    title: str | None
    status: str
    last_error_kind: str | None
    last_checked_at: datetime
    last_success_at: datetime | None
    last_failure_at: datetime | None
    next_check_after: datetime | None
    failure_count: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class _StoredLinkTitleRow:
    id: int
    stored_url: str
    url_encryption_nonce: bytes | None
    url_encryption_tag: bytes | None
    stored_title: str | None
    title_encryption_nonce: bytes | None
    title_encryption_tag: bytes | None
    status: str
    last_error_kind: str | None
    last_checked_at: datetime
    last_success_at: datetime | None
    last_failure_at: datetime | None
    next_check_after: datetime | None
    failure_count: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class _LinkTitleFetchResult:
    url: str
    title: str | None
    status: str
    last_error_kind: str | None


class _LinkTitleTargetRejected(Exception):
    def __init__(self, reason: str) -> None:
        if reason not in {
            "blocked_private_address",
            "dns_error",
            "missing_hostname",
            "unsupported_scheme",
        }:
            raise ValueError(f"Unsupported link-title target rejection reason: {reason}")
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True, slots=True)
class _ResolvedHttpTarget:
    hostname: str
    port: int
    public_addresses: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.hostname == "":
            raise ValueError("Resolved HTTP target hostname must not be empty")
        if not 0 < self.port < 65536:
            raise ValueError(f"Resolved HTTP target port is invalid: {self.port}")
        if len(self.public_addresses) == 0:
            raise ValueError("Resolved HTTP target must include at least one address")
        for address in self.public_addresses:
            if not ipaddress.ip_address(address).is_global:
                raise ValueError(f"Resolved HTTP target address is not public: {address}")


class _PinnedNetworkBackend(httpcore.NetworkBackend):
    def __init__(
        self,
        *,
        target: _ResolvedHttpTarget,
        network_backend: httpcore.NetworkBackend,
    ) -> None:
        self._target = target
        self._network_backend = network_backend

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None,
        local_address: str | None,
        socket_options: Iterable[tuple[int, int, int | bytes]] | None,
    ) -> httpcore.NetworkStream:
        if host != self._target.hostname or port != self._target.port:
            raise RuntimeError("Pinned link-title transport received an unexpected host or port")

        for address in self._target.public_addresses[:-1]:
            connect_capture = CapturedExceptionContext(
                httpcore.ConnectError,
                httpcore.ConnectTimeout,
            boundary='app/services/link_titles.py:connect_tcp:connect_capture')
            with connect_capture:
                return self._network_backend.connect_tcp(
                    host=address,
                    port=port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
        return self._network_backend.connect_tcp(
            host=self._target.public_addresses[-1],
            port=port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    def connect_unix_socket(
        self,
        path: str,
        timeout: float | None,
        socket_options: Iterable[tuple[int, int, int | bytes]] | None,
    ) -> httpcore.NetworkStream:
        raise RuntimeError("Link-title transport does not support Unix sockets")

    def sleep(self, seconds: float) -> None:
        self._network_backend.sleep(seconds)


class _PinnedResponseStream(httpx.SyncByteStream):
    def __init__(self, stream: Iterable[bytes]) -> None:
        self._stream = stream

    def __iter__(self):
        yield from self._stream

    def close(self) -> None:
        close = getattr(self._stream, "close", None)
        if not callable(close):
            raise RuntimeError("Link-title response stream has no close method")
        close()


class _PinnedHTTPTransport(httpx.BaseTransport):
    def __init__(
        self,
        *,
        target: _ResolvedHttpTarget,
        network_backend: httpcore.NetworkBackend,
    ) -> None:
        network_backend = _PinnedNetworkBackend(
            target=target,
            network_backend=network_backend,
        )
        self._pool = httpcore.ConnectionPool(
            ssl_context=httpx.create_ssl_context(verify=True, trust_env=True),
            max_connections=1,
            max_keepalive_connections=0,
            retries=0,
            network_backend=network_backend,
        )

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if not isinstance(request.stream, httpx.SyncByteStream):
            raise TypeError("Pinned link-title transport requires a synchronous request stream")
        core_request = httpcore.Request(
            method=request.method,
            url=httpcore.URL(
                scheme=request.url.raw_scheme,
                host=request.url.raw_host,
                port=request.url.port,
                target=request.url.raw_path,
            ),
            headers=request.headers.raw,
            content=request.stream,
            extensions=request.extensions,
        )
        core_response = self._pool.handle_request(core_request)
        if not isinstance(core_response.stream, Iterable):
            raise TypeError("Pinned link-title transport received a non-iterable response stream")
        return httpx.Response(
            status_code=core_response.status,
            headers=core_response.headers,
            stream=_PinnedResponseStream(core_response.stream),
            extensions=core_response.extensions,
        )

    def close(self) -> None:
        self._pool.close()


@dataclass(frozen=True, slots=True)
class LinkTitleDiagnostic:
    message: str


@dataclass(frozen=True, slots=True)
class _SerializedTextField:
    value: str | None
    nonce: bytes | None
    tag: bytes | None


@dataclass(frozen=True, slots=True)
class _LinkTitleState:
    stored_rows: tuple[_StoredLinkTitleRow, ...]
    records_by_url: Mapping[str, LinkTitleRecord]
    is_decrypted: bool


@dataclass(frozen=True, slots=True)
class _LinkTitleSanitizeResult:
    state: _LinkTitleState
    did_update: bool


class _TitleParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._inside_title = False
        self._title_parts: list[str] = []
        self.og_title: str | None = None
        self.twitter_title: str | None = None
        self.meta_title: str | None = None
        self.itemprop_name: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.casefold()
        if normalized_tag == "title":
            self._inside_title = True
            return
        if normalized_tag != "meta":
            return

        attrs_by_name = {
            name.casefold(): value
            for name, value in attrs
            if isinstance(name, str) and isinstance(value, str)
        }
        content = attrs_by_name.get("content")
        if content is None:
            return
        property_value = attrs_by_name.get("property")
        name_value = attrs_by_name.get("name")
        itemprop_value = attrs_by_name.get("itemprop")
        if property_value is not None and property_value.casefold() == "og:title":
            self.og_title = content
        if name_value is not None and name_value.casefold() == "twitter:title":
            self.twitter_title = content
        if name_value is not None and name_value.casefold() == "title":
            self.meta_title = content
        if itemprop_value is not None and itemprop_value.casefold() == "name":
            self.itemprop_name = content

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "title":
            self._inside_title = False

    def handle_data(self, data: str) -> None:
        if self._inside_title:
            self._title_parts.append(data)

    @property
    def title(self) -> str | None:
        return _clean_title_text("".join(self._title_parts))


class LinkTitleStore:
    def __init__(self) -> None:
        self._lock = RLock()
        self._state: _LinkTitleState | None = None
        self._in_flight: set[str] = set()
        self._revision = 0

    def bootstrap(self, *, connection) -> None:
        rows = fetch_all_link_title_rows(connection)
        stored_rows = tuple(_coerce_stored_row(row) for row in rows)
        state = _build_state_from_stored_rows(stored_rows=stored_rows, token="")
        did_sanitize = False
        if state.is_decrypted:
            result = _sanitize_cached_interstitial_titles(state=state, connection=connection)
            state = result.state
            did_sanitize = result.did_update
        with self._lock:
            self._state = state
            self._in_flight.clear()
            if did_sanitize:
                self._revision += 1

    def ensure_decrypted(self, *, token: str) -> None:
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        with self._lock:
            state = self._state
            if state is None:
                raise RuntimeError("LinkTitleStore is not bootstrapped")
            if state.is_decrypted:
                return
            state = _build_state_from_stored_rows(
                stored_rows=state.stored_rows,
                token=token,
            )
            if state.is_decrypted:
                with begin_writer() as connection:
                    result = _sanitize_cached_interstitial_titles(state=state, connection=connection)
                    state = result.state
                if result.did_update:
                    self._revision += 1
            self._state = state

    def reset(self) -> None:
        with self._lock:
            self._state = None
            self._in_flight.clear()
            self._revision = 0

    def get_revision(self) -> int:
        with self._lock:
            return self._revision

    def get_ok_title(self, url: str) -> str | None:
        normalized_url = normalize_url_for_link_title(url)
        if normalized_url is None:
            return None
        with self._lock:
            state = self._state
            if state is None or not state.is_decrypted:
                return None
            record = state.records_by_url.get(normalized_url)
            if record is None:
                return None
            if record.status != "ok":
                return None
            if record.title is None or record.title == "":
                raise RuntimeError(f"ok link title record missing title: {normalized_url}")
            return record.title

    def maybe_enqueue_fetch(self, url: str) -> None:
        generation = current_generation()
        normalized_url = normalize_url_for_link_title(url)
        if normalized_url is None:
            return
        if TEST_MODE:
            return
        with self._lock:
            if not self._is_fetch_eligible_locked(normalized_url=normalized_url):
                return
            self._in_flight.add(normalized_url)
        link_title_fetcher.submit(normalized_url, generation)

    def apply_current_fetch_result(self, result: _LinkTitleFetchResult, generation: int) -> None:
        with bulk_operation_guard.lock:
            if generation != current_generation():
                return
            self.apply_fetch_result(result)

    def apply_fetch_result(self, result: _LinkTitleFetchResult) -> None:
        if not isinstance(result, _LinkTitleFetchResult):
            raise TypeError("result must be a _LinkTitleFetchResult")
        normalized_url = normalize_url_for_link_title(result.url)
        if normalized_url is None:
            raise ValueError(f"Fetch result URL is not eligible: {result.url}")
        now = datetime.now(timezone.utc)

        with self._lock:
            state = self._state
            if state is None:
                self._in_flight.discard(normalized_url)
                return
            if not state.is_decrypted:
                self._in_flight.discard(normalized_url)
                return
            previous = state.records_by_url.get(normalized_url)
            next_record = _build_next_record(
                previous=previous,
                normalized_url=normalized_url,
                result=result,
                now=now,
            )
            stored_payload = _serialize_record_for_storage(record=next_record)
            with begin_writer() as connection:
                if previous is None:
                    row_id = insert_link_title_row(connection, **stored_payload)
                    next_record = replace(next_record, id=row_id)
                else:
                    update_payload = dict(stored_payload)
                    update_payload.pop("created_at")
                    update_link_title_row(connection, previous.id, **update_payload)

            next_rows_by_id = {row.id: row for row in state.stored_rows}
            next_rows_by_id[next_record.id] = _stored_row_from_record(record=next_record)
            records_by_url = dict(state.records_by_url)
            records_by_url[normalized_url] = next_record
            self._state = _LinkTitleState(
                stored_rows=tuple(sorted(next_rows_by_id.values(), key=lambda row: row.id)),
                records_by_url=records_by_url,
                is_decrypted=True,
            )
            self._in_flight.discard(normalized_url)
            self._revision += 1

    def discard_in_flight(self, url: str) -> None:
        normalized_url = normalize_url_for_link_title(url)
        if normalized_url is None:
            return
        with self._lock:
            self._in_flight.discard(normalized_url)

    def _is_fetch_eligible_locked(self, *, normalized_url: str) -> bool:
        state = self._state
        if state is None or not state.is_decrypted:
            return False
        if normalized_url in self._in_flight:
            return False
        record = state.records_by_url.get(normalized_url)
        if record is None:
            return True
        if record.status not in _AUTO_RETRY_STATUSES:
            return False
        next_check_after = _effective_next_check_after(record=record)
        if next_check_after is None:
            return False
        return datetime.now(timezone.utc) >= next_check_after

    def get_diagnostic(self, url: str) -> LinkTitleDiagnostic | None:
        normalized_url = normalize_url_for_link_title(url)
        if normalized_url is None:
            return None
        with self._lock:
            state = self._state
            if state is None or not state.is_decrypted:
                return None
            if normalized_url in self._in_flight:
                return LinkTitleDiagnostic(message="Link title lookup in progress")
            record = state.records_by_url.get(normalized_url)
            if record is None:
                return None
        message = _diagnostic_message_for_record(record=record)
        if message is None:
            return None
        return LinkTitleDiagnostic(message=message)


class LinkTitleFetcher:
    def submit(self, normalized_url: str, generation: int) -> None:
        if not isinstance(normalized_url, str) or normalized_url == "":
            raise TypeError("normalized_url must be a non-empty string")
        _executor().submit(_run_fetch_job, normalized_url, generation)


_FETCHER_EXECUTOR = None


def _executor():
    global _FETCHER_EXECUTOR
    if _FETCHER_EXECUTOR is None:
        _FETCHER_EXECUTOR = ThreadPoolExecutor(max_workers=3, thread_name_prefix="link-title")
    return _FETCHER_EXECUTOR


def normalize_url_for_link_title(url: str) -> str | None:
    if not isinstance(url, str):
        raise TypeError("url must be a string")
    stripped = url.strip()
    if stripped == "":
        return None
    parsed = urlsplit(stripped)
    scheme = parsed.scheme.casefold()
    if scheme not in {"http", "https"}:
        return None
    if parsed.hostname is None or parsed.hostname == "":
        return None
    hostname = parsed.hostname.casefold()
    port = parsed.port
    netloc = hostname
    if port is not None:
        default_port = 443
        if scheme == "http":
            default_port = 80
        if port != default_port:
            netloc = f"{netloc}:{port}"
    return urlunsplit((scheme, netloc, parsed.path, parsed.query, ""))


def display_domain_for_url(url: str) -> str:
    normalized = normalize_url_for_link_title(url)
    if normalized is None:
        raise ValueError(f"URL cannot be displayed as a link title URL: {url}")
    parsed = urlsplit(normalized)
    if parsed.hostname is None or parsed.hostname == "":
        raise RuntimeError(f"Normalized URL missing hostname: {normalized}")
    hostname = parsed.hostname
    if hostname.startswith("www."):
        hostname = hostname[4:]
    return hostname


def _coerce_stored_row(row: Mapping[str, object]) -> _StoredLinkTitleRow:
    row_id = row["id"]
    if not isinstance(row_id, int):
        raise TypeError("link_titles.id must be an int")
    stored_url = row["url"]
    if not isinstance(stored_url, str):
        raise TypeError("link_titles.url must be a string")
    title = row["title"]
    if title is not None and not isinstance(title, str):
        raise TypeError("link_titles.title must be a string or None")
    status = row["status"]
    if not isinstance(status, str) or status == "":
        raise TypeError("link_titles.status must be a non-empty string")
    last_error_kind = row["last_error_kind"]
    if last_error_kind is not None and not isinstance(last_error_kind, str):
        raise TypeError("link_titles.last_error_kind must be a string or None")
    failure_count = row["failure_count"]
    if not isinstance(failure_count, int) or failure_count < 0:
        raise TypeError("link_titles.failure_count must be a non-negative int")

    for field_name in (
        "last_checked_at",
        "created_at",
        "updated_at",
    ):
        if not isinstance(row[field_name], datetime):
            raise TypeError(f"link_titles.{field_name} must be a datetime")
    for field_name in ("last_success_at", "last_failure_at", "next_check_after"):
        if row[field_name] is not None and not isinstance(row[field_name], datetime):
            raise TypeError(f"link_titles.{field_name} must be a datetime or None")

    url_nonce = row["url_encryption_nonce"]
    url_tag = row["url_encryption_tag"]
    title_nonce = row["title_encryption_nonce"]
    title_tag = row["title_encryption_tag"]
    if (url_nonce is None) != (url_tag is None):
        raise RuntimeError(f"link_titles row {row_id} has incomplete URL encryption metadata")
    if (title_nonce is None) != (title_tag is None):
        raise RuntimeError(f"link_titles row {row_id} has incomplete title encryption metadata")
    if title is None and title_nonce is not None:
        raise RuntimeError(f"link_titles row {row_id} has encrypted title metadata but NULL title")

    return _StoredLinkTitleRow(
        id=row_id,
        stored_url=stored_url,
        url_encryption_nonce=_coerce_optional_bytes(url_nonce, field_name="url_encryption_nonce"),
        url_encryption_tag=_coerce_optional_bytes(url_tag, field_name="url_encryption_tag"),
        stored_title=title,
        title_encryption_nonce=_coerce_optional_bytes(title_nonce, field_name="title_encryption_nonce"),
        title_encryption_tag=_coerce_optional_bytes(title_tag, field_name="title_encryption_tag"),
        status=status,
        last_error_kind=last_error_kind,
        last_checked_at=row["last_checked_at"],
        last_success_at=row["last_success_at"],
        last_failure_at=row["last_failure_at"],
        next_check_after=row["next_check_after"],
        failure_count=failure_count,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _coerce_optional_bytes(value: object, *, field_name: str) -> bytes | None:
    if value is None:
        return None
    if not isinstance(value, bytes):
        raise TypeError(f"link_titles.{field_name} must be bytes or None")
    return value


def _build_state_from_stored_rows(*, stored_rows: tuple[_StoredLinkTitleRow, ...], token: str) -> _LinkTitleState:
    contains_encrypted = any(row.url_encryption_nonce is not None for row in stored_rows)
    if contains_encrypted and not _encryption_can_decrypt(token=token):
        return _LinkTitleState(
            stored_rows=stored_rows,
            records_by_url={},
            is_decrypted=False,
        )

    records_by_url: dict[str, LinkTitleRecord] = {}
    for row in stored_rows:
        url = _decrypt_text_field(
            stored_value=row.stored_url,
            nonce=row.url_encryption_nonce,
            tag=row.url_encryption_tag,
            token=token,
            field_name="url",
        )
        title = None
        if row.stored_title is not None:
            title = _decrypt_text_field(
                stored_value=row.stored_title,
                nonce=row.title_encryption_nonce,
                tag=row.title_encryption_tag,
                token=token,
                field_name="title",
            )
        normalized_url = normalize_url_for_link_title(url)
        if normalized_url is None:
            raise RuntimeError(f"Stored link_titles row {row.id} has invalid URL: {url}")
        records_by_url[normalized_url] = LinkTitleRecord(
            id=row.id,
            url=normalized_url,
            title=title,
            status=row.status,
            last_error_kind=row.last_error_kind,
            last_checked_at=row.last_checked_at,
            last_success_at=row.last_success_at,
            last_failure_at=row.last_failure_at,
            next_check_after=row.next_check_after,
            failure_count=row.failure_count,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )

    return _LinkTitleState(
        stored_rows=stored_rows,
        records_by_url=records_by_url,
        is_decrypted=True,
    )


def _encryption_can_decrypt(*, token: str) -> bool:
    if token:
        return True
    service = get_encryption_service()
    return service is not None and service.dek is not None


def _decrypt_text_field(
    *,
    stored_value: str,
    nonce: bytes | None,
    tag: bytes | None,
    token: str,
    field_name: str,
) -> str:
    if nonce is None and tag is None:
        return stored_value
    if nonce is None or tag is None:
        raise RuntimeError(f"Encrypted {field_name} has incomplete metadata")
    return decrypt(stored_value, nonce, tag, token)


def _serialize_record_for_storage(record: LinkTitleRecord) -> dict[str, object]:
    serialized_url = _encrypt_optional_text(record.url)
    if serialized_url.value is None:
        raise RuntimeError("Link title URL serialization produced None")
    serialized_title = _encrypt_optional_text(record.title)
    return {
        "url": serialized_url.value,
        "url_encryption_nonce": serialized_url.nonce,
        "url_encryption_tag": serialized_url.tag,
        "title": serialized_title.value,
        "title_encryption_nonce": serialized_title.nonce,
        "title_encryption_tag": serialized_title.tag,
        "status": record.status,
        "last_error_kind": record.last_error_kind,
        "last_checked_at": record.last_checked_at,
        "last_success_at": record.last_success_at,
        "last_failure_at": record.last_failure_at,
        "next_check_after": record.next_check_after,
        "failure_count": record.failure_count,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
    }


def _encrypt_optional_text(value: str | None) -> _SerializedTextField:
    if value is None:
        return _SerializedTextField(value=None, nonce=None, tag=None)
    stored_value, nonce, tag = encrypt(value, "")
    if (nonce is None) != (tag is None):
        raise RuntimeError("Encrypted link title field must include both nonce and tag")
    return _SerializedTextField(value=stored_value, nonce=nonce, tag=tag)


def _stored_row_from_record(*, record: LinkTitleRecord) -> _StoredLinkTitleRow:
    return _StoredLinkTitleRow(
        id=record.id,
        stored_url=record.url,
        url_encryption_nonce=None,
        url_encryption_tag=None,
        stored_title=record.title,
        title_encryption_nonce=None,
        title_encryption_tag=None,
        status=record.status,
        last_error_kind=record.last_error_kind,
        last_checked_at=record.last_checked_at,
        last_success_at=record.last_success_at,
        last_failure_at=record.last_failure_at,
        next_check_after=record.next_check_after,
        failure_count=record.failure_count,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _stored_row_from_serialized_record(
    *,
    record: LinkTitleRecord,
    payload: dict[str, object],
) -> _StoredLinkTitleRow:
    return _StoredLinkTitleRow(
        id=record.id,
        stored_url=_require_serialized_text(payload, "url"),
        url_encryption_nonce=_require_optional_bytes(payload, "url_encryption_nonce"),
        url_encryption_tag=_require_optional_bytes(payload, "url_encryption_tag"),
        stored_title=_require_optional_text(payload, "title"),
        title_encryption_nonce=_require_optional_bytes(payload, "title_encryption_nonce"),
        title_encryption_tag=_require_optional_bytes(payload, "title_encryption_tag"),
        status=record.status,
        last_error_kind=record.last_error_kind,
        last_checked_at=record.last_checked_at,
        last_success_at=record.last_success_at,
        last_failure_at=record.last_failure_at,
        next_check_after=record.next_check_after,
        failure_count=record.failure_count,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _require_serialized_text(payload: Mapping[str, object], key: str) -> str:
    value = payload[key]
    if not isinstance(value, str) or value == "":
        raise RuntimeError(f"Serialized link title field {key} must be non-empty string")
    return value


def _require_optional_text(payload: Mapping[str, object], key: str) -> str | None:
    value = payload[key]
    if value is not None and not isinstance(value, str):
        raise RuntimeError(f"Serialized link title field {key} must be string or None")
    return value


def _require_optional_bytes(payload: Mapping[str, object], key: str) -> bytes | None:
    value = payload[key]
    if value is not None and not isinstance(value, bytes):
        raise RuntimeError(f"Serialized link title field {key} must be bytes or None")
    return value


def _sanitize_cached_interstitial_titles(
    *,
    state: _LinkTitleState,
    connection,
) -> _LinkTitleSanitizeResult:
    if not state.is_decrypted:
        return _LinkTitleSanitizeResult(state=state, did_update=False)
    next_rows_by_id = {row.id: row for row in state.stored_rows}
    next_records_by_url = dict(state.records_by_url)
    now = datetime.now(timezone.utc)
    did_update = False

    for record in state.records_by_url.values():
        if record.status != "ok" or record.title is None:
            continue
        if not _looks_like_interstitial_title(record.title):
            continue
        next_record = _build_next_record(
            previous=record,
            normalized_url=record.url,
            result=_LinkTitleFetchResult(
                url=record.url,
                title=None,
                status="no_title",
                last_error_kind="interstitial_title",
            ),
            now=now,
        )
        payload = _serialize_record_for_storage(record=next_record)
        update_payload = dict(payload)
        update_payload.pop("created_at")
        update_link_title_row(connection, next_record.id, **update_payload)
        next_rows_by_id[next_record.id] = _stored_row_from_serialized_record(
            record=next_record,
            payload=payload,
        )
        next_records_by_url[next_record.url] = next_record
        did_update = True

    if not did_update:
        return _LinkTitleSanitizeResult(state=state, did_update=False)
    return _LinkTitleSanitizeResult(
        state=_LinkTitleState(
            stored_rows=tuple(sorted(next_rows_by_id.values(), key=lambda row: row.id)),
            records_by_url=next_records_by_url,
            is_decrypted=True,
        ),
        did_update=True,
    )


def _build_next_record(
    *,
    previous: LinkTitleRecord | None,
    normalized_url: str,
    result: _LinkTitleFetchResult,
    now: datetime,
) -> LinkTitleRecord:
    if result.status == "ok":
        if result.title is None or result.title == "":
            raise RuntimeError("ok fetch result must include a title")
        last_success_at = now
        last_failure_at = None
        if previous is not None:
            last_failure_at = previous.last_failure_at
        failure_count = 0
        next_check_after = now + _OK_REFRESH_AFTER
    else:
        last_success_at = None
        if previous is not None:
            last_success_at = previous.last_success_at
        last_failure_at = now
        prior_failures = 0
        if previous is not None:
            prior_failures = previous.failure_count
        failure_count = prior_failures + 1
        next_check_after = _next_check_after_for_status(
            status=result.status,
            now=now,
            failure_count=failure_count,
            last_error_kind=result.last_error_kind,
        )

    if previous is None:
        row_id = -1
        created_at = now
    else:
        row_id = previous.id
        created_at = previous.created_at

    return LinkTitleRecord(
        id=row_id,
        url=normalized_url,
        title=result.title,
        status=result.status,
        last_error_kind=result.last_error_kind,
        last_checked_at=now,
        last_success_at=last_success_at,
        last_failure_at=last_failure_at,
        next_check_after=next_check_after,
        failure_count=failure_count,
        created_at=created_at,
        updated_at=now,
    )


def _next_check_after_for_status(
    *,
    status: str,
    now: datetime,
    failure_count: int,
    last_error_kind: str | None,
) -> datetime | None:
    if not isinstance(failure_count, int) or failure_count < 0:
        raise TypeError("failure_count must be a non-negative int")
    if last_error_kind is not None and not isinstance(last_error_kind, str):
        raise TypeError("last_error_kind must be a string or None")
    if status == "ok":
        return now + _OK_REFRESH_AFTER
    if status == "no_title":
        return now + _delay_for_failure_count(
            failure_count=failure_count,
            delays=_NO_TITLE_RETRY_DELAYS,
        )
    if status == "failed":
        return now + _delay_for_failure_count(
            failure_count=failure_count,
            delays=_FAILED_RETRY_DELAYS,
        )
    if status in {"unsupported", "blocked"}:
        return None
    raise RuntimeError(f"Unsupported link title status: {status}")


def _delay_for_failure_count(*, failure_count: int, delays: tuple[timedelta, ...]) -> timedelta:
    if not isinstance(failure_count, int) or failure_count < 0:
        raise TypeError("failure_count must be a non-negative int")
    if not delays:
        raise ValueError("delays must not be empty")
    if failure_count <= 1:
        return delays[0]
    delay_index = failure_count - 1
    if delay_index >= len(delays):
        return delays[-1]
    return delays[delay_index]


def _effective_next_check_after(*, record: LinkTitleRecord) -> datetime | None:
    if record.status not in _AUTO_RETRY_STATUSES:
        return None
    computed = _next_check_after_for_status(
        status=record.status,
        now=record.last_checked_at,
        failure_count=record.failure_count,
        last_error_kind=record.last_error_kind,
    )
    if record.next_check_after is None:
        return computed
    if computed is None:
        return record.next_check_after
    return min(record.next_check_after, computed)


def _diagnostic_message_for_record(*, record: LinkTitleRecord) -> str | None:
    if record.status == "ok":
        return None
    detail = record.status
    if record.last_error_kind is not None:
        detail = f"{detail}: {record.last_error_kind}"
    next_check_after = _effective_next_check_after(record=record)
    if next_check_after is None:
        return f"Link title lookup {detail}"
    return f"Link title lookup {detail}; retry after {_format_utc_datetime(next_check_after)}"


def _format_utc_datetime(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("value must be timezone-aware")
    utc_value = value.astimezone(timezone.utc)
    return utc_value.strftime("%Y-%m-%d %H:%M UTC")


def _run_fetch_job(normalized_url: str, generation: int) -> None:
    if generation != current_generation():
        return
    result = fetch_link_title(normalized_url)
    link_title_store.apply_current_fetch_result(result, generation)


def fetch_link_title(normalized_url: str) -> _LinkTitleFetchResult:
    if normalize_url_for_link_title(normalized_url) != normalized_url:
        raise ValueError(f"fetch_link_title requires normalized URL: {normalized_url}")

    current_url = normalized_url
    for _ in range(_MAX_REDIRECTS + 1):
        target_capture = CapturedExceptionContext(_LinkTitleTargetRejected, boundary='app/services/link_titles.py:fetch_link_title:target_capture')
        target = None
        with target_capture:
            target = _resolve_public_http_target(current_url)
        if target_capture.captured_exception is not None:
            exc = target_capture.captured_exception
            if not isinstance(exc, _LinkTitleTargetRejected):
                raise RuntimeError("Link-title target rejection has an unexpected type")
            status = "blocked"
            if exc.reason == "dns_error":
                status = "failed"
            return _LinkTitleFetchResult(
                url=normalized_url,
                title=None,
                status=status,
                last_error_kind=exc.reason,
            )
        if target is None:
            raise RuntimeError("Link-title target resolution returned no target")
        response_result = _fetch_one_url(current_url, target)
        if response_result.status != "redirect":
            return replace(response_result, url=normalized_url)
        if response_result.title is None:
            raise RuntimeError("redirect result must carry next URL in title field")
        current_url = response_result.title

    return _LinkTitleFetchResult(
        url=normalized_url,
        title=None,
        status="failed",
        last_error_kind="too_many_redirects",
    )


def _fetch_one_url(url: str, target: _ResolvedHttpTarget) -> _LinkTitleFetchResult:
    capture = CapturedExceptionContext(
        httpx.TimeoutException,
        httpx.NetworkError,
        httpx.HTTPError,
        httpcore.TimeoutException,
        httpcore.NetworkError,
        httpcore.ProtocolError,
    boundary='app/services/link_titles.py:_fetch_one_url:capture')
    content = b""
    response_encoding = None
    with capture:
        with httpx.Client(
            timeout=_FETCH_TIMEOUT_SECONDS,
            follow_redirects=False,
            transport=_PinnedHTTPTransport(
                target=target,
                network_backend=httpcore.SyncBackend(),
            ),
            headers={
                "User-Agent": _USER_AGENT,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
        ) as client:
            with client.stream("GET", url) as response:
                redirect_result = _redirect_result_from_response(url=url, response=response)
                if redirect_result is not None:
                    return redirect_result

                if response.status_code >= 400:
                    return _LinkTitleFetchResult(
                        url=url,
                        title=None,
                        status="failed",
                        last_error_kind=f"http_{response.status_code}",
                    )

                content_type = response.headers.get("content-type", "")
                if content_type and "html" not in content_type.casefold():
                    return _LinkTitleFetchResult(url=url, title=None, status="unsupported", last_error_kind="non_html")

                chunks: list[bytes] = []
                total_bytes = 0
                for chunk in response.iter_bytes():
                    chunks.append(chunk)
                    total_bytes += len(chunk)
                    if total_bytes >= _MAX_RESPONSE_BYTES:
                        break
                content = b"".join(chunks)
                response_encoding = response.encoding

    if capture.captured_exception is not None:
        if isinstance(
            capture.captured_exception,
            (httpx.TimeoutException, httpcore.TimeoutException),
        ):
            return _LinkTitleFetchResult(url=url, title=None, status="failed", last_error_kind="timeout")
        if isinstance(
            capture.captured_exception,
            (httpx.NetworkError, httpcore.NetworkError),
        ):
            return _LinkTitleFetchResult(url=url, title=None, status="failed", last_error_kind="network_error")
        return _LinkTitleFetchResult(url=url, title=None, status="failed", last_error_kind="http_client_error")

    title = _extract_title_from_html(content=content, encoding=response_encoding)
    return _fetch_result_from_extracted_title(url=url, title=title)


def _redirect_result_from_response(*, url: str, response: httpx.Response) -> _LinkTitleFetchResult | None:
    if 300 > response.status_code or response.status_code >= 400:
        return None
    location = response.headers.get("location")
    if location is None or location.strip() == "":
        return _LinkTitleFetchResult(url=url, title=None, status="failed", last_error_kind="redirect_without_location")
    next_url = normalize_url_for_link_title(str(httpx.URL(url).join(location)))
    if next_url is None:
        return _LinkTitleFetchResult(url=url, title=None, status="unsupported", last_error_kind="unsupported_redirect")
    return _LinkTitleFetchResult(url=url, title=next_url, status="redirect", last_error_kind=None)


def _resolve_public_http_target(url: str) -> _ResolvedHttpTarget:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise _LinkTitleTargetRejected("unsupported_scheme")
    hostname = parsed.hostname
    if hostname is None or hostname == "":
        raise _LinkTitleTargetRejected("missing_hostname")
    request_hostname = httpx.URL(url).raw_host.decode("ascii")
    port = parsed.port
    if port is None:
        port = 80
        if parsed.scheme == "https":
            port = 443
    capture = CapturedExceptionContext(socket.gaierror, boundary='app/services/link_titles.py:_resolve_public_http_target:capture')
    infos = []
    with capture:
        infos = socket.getaddrinfo(
            request_hostname,
            port,
            type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
    if capture.captured_exception is not None:
        raise _LinkTitleTargetRejected("dns_error") from capture.captured_exception
    if not infos:
        raise _LinkTitleTargetRejected("dns_error")
    public_addresses: list[str] = []
    for info in infos:
        address = info[4][0]
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise _LinkTitleTargetRejected("blocked_private_address")
        normalized_address = str(ip)
        if normalized_address not in public_addresses:
            public_addresses.append(normalized_address)
    return _ResolvedHttpTarget(
        hostname=request_hostname,
        port=port,
        public_addresses=tuple(public_addresses),
    )


def _extract_title_from_html(*, content: bytes, encoding: str | None) -> str | None:
    if not isinstance(content, bytes):
        raise TypeError("content must be bytes")
    if encoding is None:
        encoding = "utf-8"
    text = content.decode(encoding, errors="replace")
    parser = _TitleParser()
    parser.feed(text)
    for candidate in (
        parser.og_title,
        parser.twitter_title,
        parser.meta_title,
        parser.itemprop_name,
        parser.title,
    ):
        cleaned = _clean_title_text(candidate)
        if cleaned is not None:
            return cleaned
    return None


def _clean_title_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.split())
    if cleaned == "":
        return None
    if len(cleaned) > 300:
        cleaned = cleaned[:300].rstrip()
    return cleaned


def _fetch_result_from_extracted_title(*, url: str, title: str | None) -> _LinkTitleFetchResult:
    if not isinstance(url, str) or url == "":
        raise ValueError("url must be a non-empty string")
    if title is None:
        return _LinkTitleFetchResult(url=url, title=None, status="no_title", last_error_kind="no_title")
    if _looks_like_interstitial_title(title):
        return _LinkTitleFetchResult(url=url, title=None, status="no_title", last_error_kind="interstitial_title")
    return _LinkTitleFetchResult(url=url, title=title, status="ok", last_error_kind=None)


def _looks_like_interstitial_title(title: str) -> bool:
    if not isinstance(title, str):
        raise TypeError("title must be a string")
    normalized = " ".join(title.casefold().split()).strip(" .!:-|")
    if normalized == "":
        return False
    if normalized in _INTERSTITIAL_TITLE_EXACT_MATCHES:
        return True
    return any(_contains_normalized_phrase(normalized, phrase) for phrase in _INTERSTITIAL_TITLE_PHRASES)


def _contains_normalized_phrase(normalized_value: str, normalized_phrase: str) -> bool:
    if not isinstance(normalized_value, str) or not isinstance(normalized_phrase, str):
        raise TypeError("normalized phrase inputs must be strings")
    pattern = rf"(?<![a-z0-9]){re.escape(normalized_phrase)}(?![a-z0-9])"
    return re.search(pattern, normalized_value) is not None


def rewrite_persisted_link_titles(*, connection, encryption_service: object | None, force_plaintext: bool) -> int:
    rows = fetch_all_link_title_rows(connection)
    rewritten_count = 0
    for row in rows:
        stored_row = _coerce_stored_row(row)
        record = _record_from_stored_for_rewrite(
            stored_row=stored_row,
            encryption_service=encryption_service,
        )
        payload = _serialize_record_for_rewrite(
            record=record,
            encryption_service=encryption_service,
            force_plaintext=force_plaintext,
        )
        should_be_encrypted = not force_plaintext and encryption_service is not None
        url_encrypted = stored_row.url_encryption_nonce is not None
        title_encrypted = stored_row.title_encryption_nonce is not None
        if stored_row.stored_title is None:
            row_matches_target = url_encrypted == should_be_encrypted and not title_encrypted
        else:
            row_matches_target = (
                url_encrypted == should_be_encrypted
                and title_encrypted == should_be_encrypted
            )
        if row_matches_target:
            continue
        update_link_title_row(connection, stored_row.id, **payload)
        rewritten_count += 1
    return rewritten_count


def _record_from_stored_for_rewrite(
    *,
    stored_row: _StoredLinkTitleRow,
    encryption_service: object | None,
) -> LinkTitleRecord:
    url = stored_row.stored_url
    if stored_row.url_encryption_nonce is not None:
        service = _coerce_encryption_service(encryption_service)
        url = service.decrypt_from_storage(
            stored_row.stored_url,
            stored_row.url_encryption_nonce,
            stored_row.url_encryption_tag,
        )
    title = stored_row.stored_title
    if stored_row.title_encryption_nonce is not None:
        service = _coerce_encryption_service(encryption_service)
        if stored_row.stored_title is None:
            raise RuntimeError(f"Encrypted link title row {stored_row.id} has NULL title")
        title = service.decrypt_from_storage(
            stored_row.stored_title,
            stored_row.title_encryption_nonce,
            stored_row.title_encryption_tag,
        )
    normalized = normalize_url_for_link_title(url)
    if normalized is None:
        raise RuntimeError(f"Stored link_titles row {stored_row.id} has invalid URL: {url}")
    return LinkTitleRecord(
        id=stored_row.id,
        url=normalized,
        title=title,
        status=stored_row.status,
        last_error_kind=stored_row.last_error_kind,
        last_checked_at=stored_row.last_checked_at,
        last_success_at=stored_row.last_success_at,
        last_failure_at=stored_row.last_failure_at,
        next_check_after=stored_row.next_check_after,
        failure_count=stored_row.failure_count,
        created_at=stored_row.created_at,
        updated_at=stored_row.updated_at,
    )


def _serialize_record_for_rewrite(
    *,
    record: LinkTitleRecord,
    encryption_service: object | None,
    force_plaintext: bool,
) -> dict[str, object]:
    service = None
    if not force_plaintext:
        service = _coerce_optional_encryption_service(encryption_service)
    url = _serialize_text_with_service(value=record.url, encryption_service=service)
    title = _serialize_text_with_service(value=record.title, encryption_service=service)
    return {
        "url": url.value,
        "url_encryption_nonce": url.nonce,
        "url_encryption_tag": url.tag,
        "title": title.value,
        "title_encryption_nonce": title.nonce,
        "title_encryption_tag": title.tag,
        "status": record.status,
        "last_error_kind": record.last_error_kind,
        "last_checked_at": record.last_checked_at,
        "last_success_at": record.last_success_at,
        "last_failure_at": record.last_failure_at,
        "next_check_after": record.next_check_after,
        "failure_count": record.failure_count,
        "updated_at": datetime.now(timezone.utc),
    }


def _serialize_text_with_service(
    *,
    value: str | None,
    encryption_service,
) -> _SerializedTextField:
    if value is None:
        return _SerializedTextField(value=None, nonce=None, tag=None)
    if encryption_service is None:
        return _SerializedTextField(value=value, nonce=None, tag=None)
    ciphertext, nonce, tag = encryption_service.encrypt_for_storage(value)
    return _SerializedTextField(value=ciphertext, nonce=nonce, tag=tag)


def _coerce_optional_encryption_service(encryption_service: object | None):
    if encryption_service is None:
        return None
    return _coerce_encryption_service(encryption_service)


def _coerce_encryption_service(encryption_service: object):
    if encryption_service is None:
        raise RuntimeError("Link title encryption rewrite requires an encryption service")
    if not hasattr(encryption_service, "encrypt_for_storage"):
        raise TypeError("encryption_service missing encrypt_for_storage")
    if not hasattr(encryption_service, "decrypt_from_storage"):
        raise TypeError("encryption_service missing decrypt_from_storage")
    return encryption_service


link_title_store = LinkTitleStore()
link_title_fetcher = LinkTitleFetcher()
