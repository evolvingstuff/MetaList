from __future__ import annotations

from http import HTTPStatus
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
import json
import re
from threading import Lock, RLock
import time
from typing import Callable, Mapping
from urllib.parse import quote, urlsplit

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
from app.services.public_http import PinnedPublicHTTPTransport
from app.services.public_http import PublicHttpTargetRejected
from app.services.public_http import ResolvedPublicHttpTarget
from app.services.public_http import _PinnedNetworkBackend
from app.services.public_http import normalize_public_http_url
from app.utils.sent_fields import sent_or_none
from app.services.public_http import resolve_public_http_target as _resolve_public_http_target

_LinkTitleTargetRejected = PublicHttpTargetRejected
_PinnedHTTPTransport = PinnedPublicHTTPTransport
_ResolvedHttpTarget = ResolvedPublicHttpTarget

# A record not yet stored has no database row id.
_UNSAVED_ROW_ID = -1
_FETCH_TIMEOUT_SECONDS = 4.0
_MAX_REDIRECTS = 5
_MAX_RESPONSE_BYTES = 1024 * 1024
_OK_REFRESH_AFTER_DAYS = 90
_NO_TITLE_REFRESH_AFTER_DAYS = 30
_FAILED_REFRESH_AFTER_DAYS = 7
_OK_REFRESH_AFTER = timedelta(days=_OK_REFRESH_AFTER_DAYS)
_NO_TITLE_REFRESH_AFTER = timedelta(days=_NO_TITLE_REFRESH_AFTER_DAYS)
_FAILED_REFRESH_AFTER = timedelta(days=_FAILED_REFRESH_AFTER_DAYS)
_MAX_TITLE_LENGTH = 300
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

_AUTO_RETRY_STATUSES = {"ok", "no_title", "failed"}
# "Retry failed link titles" asks these again; unsupported and blocked links are final.
_MANUAL_RETRY_STATUSES = {"no_title", "failed"}
_FAILED_SECOND_RETRY_MINUTES = 5
_FAILED_THIRD_RETRY_MINUTES = 30
_FAILED_FOURTH_RETRY_HOURS = 6
_FAILED_RETRY_DELAYS = (
    timedelta(minutes=1),
    timedelta(minutes=_FAILED_SECOND_RETRY_MINUTES),
    timedelta(minutes=_FAILED_THIRD_RETRY_MINUTES),
    timedelta(hours=_FAILED_FOURTH_RETRY_HOURS),
    timedelta(days=1),
    _FAILED_REFRESH_AFTER,
)
# A site that answered HTTP 429 (too many requests) is retried more slowly.
_RATE_LIMITED_FIRST_RETRY_MINUTES = 10
_RATE_LIMITED_THIRD_RETRY_HOURS = 6
_RATE_LIMITED_RETRY_DELAYS = (
    timedelta(minutes=_RATE_LIMITED_FIRST_RETRY_MINUTES),
    timedelta(hours=1),
    timedelta(hours=_RATE_LIMITED_THIRD_RETRY_HOURS),
    timedelta(days=1),
    _FAILED_REFRESH_AFTER,
)
# Polite pacing per site (docs/ui/content-formatting.md): one request at a time,
# spaced apart, and none while the site asked MetaList to wait.
_HOST_REQUEST_SPACING_SECONDS = 2.0
_HOST_WAIT_POLL_SECONDS = 0.1
_RATE_LIMIT_DEFAULT_COOLDOWN_SECONDS = 10 * 60
_RATE_LIMIT_MIN_COOLDOWN_SECONDS = 60
_RATE_LIMIT_MAX_COOLDOWN_SECONDS = 6 * 60 * 60
_NO_TITLE_SECOND_RETRY_MINUTES = 10
_NO_TITLE_FIFTH_RETRY_DAYS = 7
_NO_TITLE_RETRY_DELAYS = (
    timedelta(minutes=1),
    timedelta(minutes=_NO_TITLE_SECOND_RETRY_MINUTES),
    timedelta(hours=1),
    timedelta(days=1),
    timedelta(days=_NO_TITLE_FIFTH_RETRY_DAYS),
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
    # Login and consent walls, wherever the site puts its name.
    "before you continue",
    "log in or sign up",
    "sign in or sign up",
    "please log in",
    "please sign in",
)
# A title part (split at the usual site-name separators) that is only one of
# these says nothing about the page: "Sign in - Google Accounts", "Log in | LinkedIn",
# "Page not found | Example". Part of a longer title ("How to sign in to Gmail")
# is a real title.
_PLACEHOLDER_TITLE_PARTS = {
    "403 forbidden",
    # Reddit's generic page for automated requests ("Reddit - Dive into anything").
    "dive into anything",
    "the heart of the internet",
    "404",
    "404 not found",
    "log in",
    "log in to your account",
    "log-in",
    "login",
    "not found",
    "page not found",
    "sign in",
    "sign in to continue",
    "sign in to your account",
    "sign up",
    "sign-in",
    "signin",
}
# Site-name separators: | · – — anywhere, " - " with spaces (not "e-mail"). Not ":",
# which also starts subtitles ("Not Found: A Novel").
_TITLE_PART_SEPARATOR_RE = re.compile(r"\s*[|·–—]\s*|\s+-\s+")


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
        content = sent_or_none(attrs_by_name, "content")
        if content is None:
            return
        property_value = sent_or_none(attrs_by_name, "property")
        name_value = sent_or_none(attrs_by_name, "name")
        itemprop_value = sent_or_none(attrs_by_name, "itemprop")
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


def _ok_titles_by_url(state: _LinkTitleState | None) -> dict[str, str]:
    """The usable titles (status ok) by normalized URL; none while locked."""
    if state is None or not state.is_decrypted:
        return {}
    titles: dict[str, str] = {}
    for url, record in state.records_by_url.items():
        if record.status == "ok":
            assert record.title, f"ok link title record missing title: {url}"
            titles[url] = record.title
    return titles


class LinkTitleStore:
    def __init__(self) -> None:
        self._lock = RLock()
        self._state: _LinkTitleState | None = None
        self._in_flight: set[str] = set()
        self._revision = 0
        # Bumped on every change a rendered link can observe (records, whole
        # state swaps, and in-flight lookups shown as diagnostics), including
        # the ones that do not advance the client-facing revision.
        self._render_generation = 0
        # Called, outside the store lock, with the normalized URLs whose usable
        # title changed (fetched, decrypted, sanitized or cleared on reset).
        self._titles_changed_listeners: list[Callable[[frozenset[str]], None]] = []

    def add_titles_changed_listener(self, listener: Callable[[frozenset[str]], None]) -> None:
        if not callable(listener):
            raise TypeError("listener must be callable")
        with self._lock:
            self._titles_changed_listeners.append(listener)

    def _notify_titles_changed(self, before: Mapping[str, str], after: Mapping[str, str]) -> None:
        changed = frozenset(
            url for url in set(before) | set(after)
            if url not in before or url not in after or before[url] != after[url]
        )
        if not changed:
            return
        with self._lock:
            listeners = tuple(self._titles_changed_listeners)
        for listener in listeners:
            listener(changed)

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
            before = _ok_titles_by_url(self._state)
            self._state = state
            self._in_flight.clear()
            self._render_generation += 1
            if did_sanitize:
                self._revision += 1
        self._notify_titles_changed(before, _ok_titles_by_url(state))

    def ensure_decrypted(self, *, token: str) -> None:
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        with self._lock:
            state = self._state
            if state is None:
                raise RuntimeError("LinkTitleStore is not bootstrapped")
            if state.is_decrypted:
                return
            before = _ok_titles_by_url(state)
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
            self._render_generation += 1
        self._notify_titles_changed(before, _ok_titles_by_url(state))

    def reset(self) -> None:
        with self._lock:
            before = _ok_titles_by_url(self._state)
            self._state = None
            self._in_flight.clear()
            self._revision = 0
            self._render_generation += 1
        self._notify_titles_changed(before, {})

    def get_revision(self) -> int:
        with self._lock:
            return self._revision

    def get_render_generation(self) -> int:
        with self._lock:
            return self._render_generation

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
            self._render_generation += 1
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
                self._render_generation += 1
                return
            if not state.is_decrypted:
                self._in_flight.discard(normalized_url)
                self._render_generation += 1
                return
            previous = state.records_by_url.get(normalized_url)
            before = _ok_titles_by_url(state)
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
            self._render_generation += 1
            after = _ok_titles_by_url(self._state)
        self._notify_titles_changed(before, after)

    def list_manual_retry_urls(self) -> tuple[str, ...]:
        """Failed or title-less lookups a manual retry may ask again now (whatever
        their schedule); never unsupported or blocked links. None while locked."""
        with self._lock:
            state = self._state
            if state is None or not state.is_decrypted:
                return ()
            return tuple(sorted(
                url for url, record in state.records_by_url.items()
                if record.status in _MANUAL_RETRY_STATUSES and url not in self._in_flight
            ))

    def claim_for_manual_retry(self, normalized_url: str) -> bool:
        """Mark a lookup in progress for a manual retry; False when it no longer
        qualifies (already being looked up, now titled, or locked)."""
        with self._lock:
            state = self._state
            if state is None or not state.is_decrypted or normalized_url in self._in_flight:
                return False
            if normalized_url not in state.records_by_url:
                return False
            if state.records_by_url[normalized_url].status not in _MANUAL_RETRY_STATUSES:
                return False
            self._in_flight.add(normalized_url)
            self._render_generation += 1
            return True

    def discard_in_flight(self, url: str) -> None:
        normalized_url = normalize_url_for_link_title(url)
        if normalized_url is None:
            return
        with self._lock:
            self._in_flight.discard(normalized_url)
            self._render_generation += 1

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

    def submit_job(self, job: Callable[..., None], *args: object) -> None:
        """Run a lookup job on the title-lookup workers (manual retries)."""
        if not callable(job):
            raise TypeError("job must be callable")
        _executor().submit(job, *args)


_FETCHER_EXECUTOR = None
_FETCHER_WORKER_COUNT = 3


def _executor():
    global _FETCHER_EXECUTOR
    if _FETCHER_EXECUTOR is None:
        _FETCHER_EXECUTOR = ThreadPoolExecutor(max_workers=_FETCHER_WORKER_COUNT, thread_name_prefix="link-title")
    return _FETCHER_EXECUTOR


def normalize_url_for_link_title(url: str) -> str | None:
    return normalize_public_http_url(url)


def display_domain_for_url(url: str) -> str:
    normalized = normalize_url_for_link_title(url)
    if normalized is None:
        raise ValueError(f"URL cannot be displayed as a link title URL: {url}")
    parsed = urlsplit(normalized)
    if parsed.hostname is None or parsed.hostname == "":
        raise RuntimeError(f"Normalized URL missing hostname: {normalized}")
    hostname = parsed.hostname
    if hostname.startswith("www."):
        hostname = hostname[len("www."):]
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
        if not _is_placeholder_title(title=record.title, url=record.url):
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
        row_id = _UNSAVED_ROW_ID
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
    if status == "failed" and last_error_kind == "http_429":
        return now + _delay_for_failure_count(
            failure_count=failure_count,
            delays=_RATE_LIMITED_RETRY_DELAYS,
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


class _HostPacer:
    """Per-site pacing for title lookups: at most one request to a site at a
    time, at least _HOST_REQUEST_SPACING_SECONDS apart, and none while the site
    is cooling down after HTTP 429. In memory only; record retry delays persist."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._busy: set[str] = set()
        self._next_allowed_at: dict[str, float] = {}
        self._cooldown_until: dict[str, float] = {}

    def acquire(self, host: str) -> bool:
        """Wait for this site's turn. False (without waiting) while it is cooling down."""
        if not isinstance(host, str) or host == "":
            raise TypeError("host must be a non-empty string")
        while True:
            with self._lock:
                now = time.monotonic()
                if host in self._cooldown_until and now < self._cooldown_until[host]:
                    return False
                # A site never contacted before may be asked at once.
                next_allowed_at = now
                if host in self._next_allowed_at:
                    next_allowed_at = self._next_allowed_at[host]
                if host not in self._busy and now >= next_allowed_at:
                    self._busy.add(host)
                    return True
            time.sleep(_HOST_WAIT_POLL_SECONDS)

    def release(self, host: str) -> None:
        with self._lock:
            assert host in self._busy, f"released a site that was not taken: {host}"
            self._busy.discard(host)
            self._next_allowed_at[host] = time.monotonic() + _HOST_REQUEST_SPACING_SECONDS

    def cool_down(self, host: str, seconds: int) -> None:
        if not isinstance(seconds, int) or seconds <= 0:
            raise ValueError("cool_down requires a positive number of seconds")
        with self._lock:
            until = time.monotonic() + seconds
            if host not in self._cooldown_until or self._cooldown_until[host] < until:
                self._cooldown_until[host] = until

    def reset(self) -> None:
        with self._lock:
            self._next_allowed_at.clear()
            self._cooldown_until.clear()


class _HostTurn:
    """Holds a site's turn for one request (released on exit, also on error)."""

    def __init__(self, pacer: _HostPacer, host: str) -> None:
        self._pacer = pacer
        self._host = host

    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type, exc, traceback) -> bool:
        self._pacer.release(self._host)
        return False


_host_pacer = _HostPacer()


def _pacing_host(url: str) -> str:
    """The site a request counts against: the hostname without a leading "www."."""
    hostname = urlsplit(url).hostname
    if hostname is None or hostname == "":
        raise ValueError(f"Link-title URL has no hostname: {url}")
    hostname = hostname.casefold()
    if hostname.startswith("www."):
        return hostname[len("www."):]
    return hostname


def _rate_limit_cooldown_seconds(retry_after: str | None) -> int:
    """How long to leave a site alone after HTTP 429: its Retry-After seconds
    (bounded), or a default when it gives none or an HTTP date."""
    if retry_after is None or re.fullmatch(r"\s*\d+\s*", retry_after) is None:
        return _RATE_LIMIT_DEFAULT_COOLDOWN_SECONDS
    seconds = int(retry_after)
    return min(max(seconds, _RATE_LIMIT_MIN_COOLDOWN_SECONDS), _RATE_LIMIT_MAX_COOLDOWN_SECONDS)


def _run_fetch_job(normalized_url: str, generation: int) -> None:
    if generation != current_generation():
        return
    result = fetch_link_title(normalized_url)
    if result.status == "deferred":
        # The site is cooling down: nothing is recorded, and a later view of the
        # link asks again once the site may be contacted.
        link_title_store.discard_in_flight(normalized_url)
        return
    link_title_store.apply_current_fetch_result(result, generation)


# oEmbed: the preview service some sites offer for exactly this, answering with
# the real title where the page itself is blocked or built by JavaScript. Keyed by
# the pacing host (hostname without "www."); each URL is quoted into the endpoint.
_OEMBED_ENDPOINTS = {
    "youtube.com": "https://www.youtube.com/oembed?format=json&url=",
    "m.youtube.com": "https://www.youtube.com/oembed?format=json&url=",
    "music.youtube.com": "https://www.youtube.com/oembed?format=json&url=",
    "youtu.be": "https://www.youtube.com/oembed?format=json&url=",
    "reddit.com": "https://www.reddit.com/oembed?url=",
    "old.reddit.com": "https://www.reddit.com/oembed?url=",
    "new.reddit.com": "https://www.reddit.com/oembed?url=",
    "np.reddit.com": "https://www.reddit.com/oembed?url=",
    "vimeo.com": "https://vimeo.com/api/oembed.json?url=",
    "player.vimeo.com": "https://vimeo.com/api/oembed.json?url=",
    "tiktok.com": "https://www.tiktok.com/oembed?url=",
    "m.tiktok.com": "https://www.tiktok.com/oembed?url=",
    "vm.tiktok.com": "https://www.tiktok.com/oembed?url=",
    "open.spotify.com": "https://open.spotify.com/oembed?url=",
    "soundcloud.com": "https://soundcloud.com/oembed?format=json&url=",
    "m.soundcloud.com": "https://soundcloud.com/oembed?format=json&url=",
}
_MAX_OEMBED_RESPONSE_BYTES = 256 * 1024


def _oembed_url_for(normalized_url: str) -> str | None:
    """The oEmbed request for a link on a site that offers one, else None."""
    host = _pacing_host(normalized_url)
    if host not in _OEMBED_ENDPOINTS:
        return None
    return _OEMBED_ENDPOINTS[host] + quote(normalized_url, safe="")


def fetch_link_title(normalized_url: str) -> _LinkTitleFetchResult:
    if normalize_url_for_link_title(normalized_url) != normalized_url:
        raise ValueError(f"fetch_link_title requires normalized URL: {normalized_url}")

    current_url = normalized_url
    for _ in range(_MAX_REDIRECTS + 1):
        # Each address on the way (a share link forwards to its post) may have an
        # oEmbed answer; without one, the page is read as for any other site.
        oembed_url = _oembed_url_for(current_url)
        if oembed_url is not None:
            oembed_result = _fetch_oembed_title(page_url=normalized_url, oembed_url=oembed_url)
            if oembed_result is not None:
                return oembed_result

        target_capture = CapturedExceptionContext(PublicHttpTargetRejected, boundary='app/services/link_titles.py:fetch_link_title:target_capture')
        target = None
        with target_capture:
            target = _resolve_public_http_target(current_url)
        if target_capture.captured_exception is not None:
            exc = target_capture.captured_exception
            if not isinstance(exc, PublicHttpTargetRejected):
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
        host = _pacing_host(current_url)
        if not _host_pacer.acquire(host):
            return _LinkTitleFetchResult(url=normalized_url, title=None, status="deferred", last_error_kind="rate_limited")
        with _HostTurn(_host_pacer, host):
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


@dataclass(frozen=True)
class _FetchedPage:
    content: bytes
    encoding: str | None


# The page's HTML (as much as the limit allows) with the response's encoding,
# or the fetch result that ends the attempt (a redirect, a refusal, non-HTML);
# transport failures propagate.
def _fetch_page(url: str, target: _ResolvedHttpTarget) -> _LinkTitleFetchResult | _FetchedPage:
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

            if response.status_code == HTTPStatus.TOO_MANY_REQUESTS:
                _host_pacer.cool_down(
                    _pacing_host(url),
                    _rate_limit_cooldown_seconds(sent_or_none(response.headers, "retry-after")),
                )
            if response.status_code >= HTTPStatus.BAD_REQUEST:
                return _LinkTitleFetchResult(
                    url=url,
                    title=None,
                    status="failed",
                    last_error_kind=f"http_{response.status_code}",
                )

            # A page without a content type may still be HTML.
            content_type = sent_or_none(response.headers, "content-type")
            if content_type is not None and content_type != "" and "html" not in content_type.casefold():
                return _LinkTitleFetchResult(url=url, title=None, status="unsupported", last_error_kind="non_html")

            chunks: list[bytes] = []
            total_bytes = 0
            for chunk in response.iter_bytes():
                chunks.append(chunk)
                total_bytes += len(chunk)
                if total_bytes >= _MAX_RESPONSE_BYTES:
                    break
            return _FetchedPage(content=b"".join(chunks), encoding=response.encoding)


def _fetch_one_url(url: str, target: _ResolvedHttpTarget) -> _LinkTitleFetchResult:
    capture = CapturedExceptionContext(
        httpx.TimeoutException,
        httpx.NetworkError,
        httpx.HTTPError,
        httpcore.TimeoutException,
        httpcore.NetworkError,
        httpcore.ProtocolError,
    boundary='app/services/link_titles.py:_fetch_one_url:capture')
    fetched: _LinkTitleFetchResult | _FetchedPage | None = None
    with capture:
        fetched = _fetch_page(url, target)
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

    if isinstance(fetched, _LinkTitleFetchResult):
        return fetched
    if fetched is None:
        raise RuntimeError("Link title fetch returned without a result or exception")
    title = _extract_title_from_html(content=fetched.content, encoding=fetched.encoding)
    return _fetch_result_from_extracted_title(url=url, title=title)


def _fetch_oembed_title(*, page_url: str, oembed_url: str) -> _LinkTitleFetchResult | None:
    """The page's title from its site's oEmbed service, paced like any request to
    that site. None when the service has no usable answer (the page is read instead)."""
    target_capture = CapturedExceptionContext(PublicHttpTargetRejected, boundary='app/services/link_titles.py:_fetch_oembed_title:target_capture')
    target = None
    with target_capture:
        target = _resolve_public_http_target(oembed_url)
    if target_capture.captured_exception is not None or target is None:
        return None
    host = _pacing_host(oembed_url)
    if not _host_pacer.acquire(host):
        return _LinkTitleFetchResult(url=page_url, title=None, status="deferred", last_error_kind="rate_limited")
    with _HostTurn(_host_pacer, host):
        response = _download_oembed(oembed_url, target)
    if response is None:
        return None
    status_code, content = response
    if status_code == HTTPStatus.TOO_MANY_REQUESTS:
        return _LinkTitleFetchResult(url=page_url, title=None, status="failed", last_error_kind="http_429")
    if status_code != HTTPStatus.OK:
        return None
    json_capture = CapturedExceptionContext(json.JSONDecodeError, UnicodeDecodeError, boundary='app/services/link_titles.py:_fetch_oembed_title:json_capture')
    payload = None
    with json_capture:
        payload = json.loads(content)
    if json_capture.captured_exception is not None or not isinstance(payload, dict):
        return None
    if "title" not in payload or not isinstance(payload["title"], str):
        return None
    title = _clean_title_text(payload["title"])
    if title is None or _is_placeholder_title(title=title, url=page_url):
        return None
    return _LinkTitleFetchResult(url=page_url, title=title, status="ok", last_error_kind=None)


# (status code, body) of the oEmbed request; None when the body runs past the limit.
def _request_oembed(oembed_url: str, target: _ResolvedHttpTarget) -> tuple[int, bytes] | None:
    with httpx.Client(
        timeout=_FETCH_TIMEOUT_SECONDS,
        follow_redirects=False,
        transport=_PinnedHTTPTransport(target=target, network_backend=httpcore.SyncBackend()),
        headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
    ) as client:
        with client.stream("GET", oembed_url) as response:
            status_code = response.status_code
            content = b""
            if status_code == HTTPStatus.TOO_MANY_REQUESTS:
                _host_pacer.cool_down(
                    _pacing_host(oembed_url),
                    _rate_limit_cooldown_seconds(sent_or_none(response.headers, "retry-after")),
                )
            if status_code == HTTPStatus.OK:
                chunks: list[bytes] = []
                total_bytes = 0
                for chunk in response.iter_bytes():
                    chunks.append(chunk)
                    total_bytes += len(chunk)
                    if total_bytes > _MAX_OEMBED_RESPONSE_BYTES:
                        return None
                content = b"".join(chunks)
            return status_code, content


def _download_oembed(oembed_url: str, target: _ResolvedHttpTarget) -> tuple[int, bytes] | None:
    """(status code, body) of an oEmbed request; None when the network fails."""
    capture = CapturedExceptionContext(
        httpx.TimeoutException,
        httpx.NetworkError,
        httpx.HTTPError,
        httpcore.TimeoutException,
        httpcore.NetworkError,
        httpcore.ProtocolError,
    boundary='app/services/link_titles.py:_download_oembed:capture')
    downloaded: tuple[int, bytes] | None = None
    with capture:
        downloaded = _request_oembed(oembed_url, target)
    if capture.captured_exception is not None:
        return None
    return downloaded


def _redirect_result_from_response(*, url: str, response: httpx.Response) -> _LinkTitleFetchResult | None:
    if not httpx.codes.is_redirect(response.status_code):
        return None
    location = sent_or_none(response.headers, "location")
    if location is None or location.strip() == "":
        return _LinkTitleFetchResult(url=url, title=None, status="failed", last_error_kind="redirect_without_location")
    next_url = normalize_url_for_link_title(str(httpx.URL(url).join(location)))
    if next_url is None:
        return _LinkTitleFetchResult(url=url, title=None, status="unsupported", last_error_kind="unsupported_redirect")
    return _LinkTitleFetchResult(url=url, title=next_url, status="redirect", last_error_kind=None)


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
    if len(cleaned) > _MAX_TITLE_LENGTH:
        cleaned = cleaned[:_MAX_TITLE_LENGTH].rstrip()
    return cleaned


def _fetch_result_from_extracted_title(*, url: str, title: str | None) -> _LinkTitleFetchResult:
    if not isinstance(url, str) or url == "":
        raise ValueError("url must be a non-empty string")
    if title is None:
        return _LinkTitleFetchResult(url=url, title=None, status="no_title", last_error_kind="no_title")
    if _looks_like_interstitial_title(title):
        return _LinkTitleFetchResult(url=url, title=None, status="no_title", last_error_kind="interstitial_title")
    if _is_site_name_title(title=title, url=url):
        return _LinkTitleFetchResult(url=url, title=None, status="no_title", last_error_kind="site_name_title")
    return _LinkTitleFetchResult(url=url, title=title, status="ok", last_error_kind=None)


def _is_placeholder_title(*, title: str, url: str) -> bool:
    if _looks_like_interstitial_title(title):
        return True
    return _is_site_name_title(title=title, url=url)


# Second-level labels under a country code ("bbc.co.uk"): the site's name is the label before.
_COUNTRY_SECOND_LEVEL_LABELS = {"ac", "co", "com", "edu", "gov", "net", "org"}
_COUNTRY_CODE_LENGTH = 2
_SECOND_LEVEL_LABEL_INDEX = -2  # "co" in "bbc.co.uk"
_SITE_DOMAIN_LABEL_COUNT = 2  # "reddit", "com"
_COUNTRY_SITE_DOMAIN_LABEL_COUNT = 3  # "bbc", "co", "uk"


def _site_domain_labels(url: str) -> list[str]:
    """The site's own domain: ["reddit", "com"] for old.reddit.com, ["bbc", "co", "uk"] for bbc.co.uk."""
    labels = _pacing_host(url).split(".")
    if (
        len(labels) >= _COUNTRY_SITE_DOMAIN_LABEL_COUNT
        and len(labels[-1]) == _COUNTRY_CODE_LENGTH
        and labels[_SECOND_LEVEL_LABEL_INDEX] in _COUNTRY_SECOND_LEVEL_LABELS
    ):
        return labels[-_COUNTRY_SITE_DOMAIN_LABEL_COUNT:]
    return labels[-_SITE_DOMAIN_LABEL_COUNT:]


def _is_site_name_title(*, title: str, url: str) -> bool:
    """A title that is only the site's name ("Reddit" for reddit.com) tells nothing
    the domain does not; the link shows its URL instead."""
    if not isinstance(title, str) or not isinstance(url, str):
        raise TypeError("_is_site_name_title requires title and url strings")
    compact_title = re.sub(r"[^a-z0-9]", "", title.casefold())
    if compact_title == "":
        return False
    site_labels = _site_domain_labels(url)
    # "Reddit", "reddit.com" or the full host name.
    return compact_title in {site_labels[0], "".join(site_labels), re.sub(r"[^a-z0-9]", "", _pacing_host(url))}


def _looks_like_interstitial_title(title: str) -> bool:
    if not isinstance(title, str):
        raise TypeError("title must be a string")
    normalized = " ".join(title.casefold().split()).strip(" .!:-|")
    if normalized == "":
        return False
    if normalized in _INTERSTITIAL_TITLE_EXACT_MATCHES:
        return True
    for part in _TITLE_PART_SEPARATOR_RE.split(normalized):
        if part.strip(" .!:-|") in _PLACEHOLDER_TITLE_PARTS:
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
