"""Bounded session-owned web evidence retained for AI chat follow-ups."""

from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Literal
from uuid import uuid4

from app.services.agent.web_fetch import WebPageFetchResult
from app.services.public_http import normalize_public_http_url


MAX_RETAINED_WEB_PAGES = 64
MAX_RETAINED_WEB_CHARACTERS = 4_000_000


@dataclass(frozen=True, slots=True)
class WebCitationReference:
    evidence_id: str
    final_url: str
    title: str
    source_kind: Literal["opened_page", "page_link"]
    source_page_evidence_id: str

    def __post_init__(self) -> None:
        if not isinstance(self.evidence_id, str) or self.evidence_id == "":
            raise ValueError("Web citation reference requires an id")
        if normalize_public_http_url(self.final_url) != self.final_url:
            raise ValueError("Web citation reference requires a normalized URL")
        if not isinstance(self.title, str):
            raise TypeError("Web citation reference title must be a string")
        if self.source_kind not in {"opened_page", "page_link"}:
            raise ValueError("Web citation reference has an invalid source kind")
        if (
            not isinstance(self.source_page_evidence_id, str)
            or self.source_page_evidence_id == ""
        ):
            raise ValueError("Web citation reference requires its source page id")
        if (
            self.source_kind == "opened_page"
            and self.source_page_evidence_id != self.evidence_id
        ):
            raise ValueError("Opened-page citation id must match its source page id")

    @property
    def citation_token(self) -> str:
        return f"[[web:{self.evidence_id}]]"

    def as_catalog_payload(self) -> dict[str, str]:
        return {
            "evidence_id": self.evidence_id,
            "citation_token": self.citation_token,
            "title": self.title,
            "url": self.final_url,
            "source_kind": self.source_kind,
            "source_page_evidence_id": self.source_page_evidence_id,
        }


@dataclass(frozen=True, slots=True)
class WebPageEvidence:
    evidence_id: str
    requested_url: str
    final_url: str
    title: str
    content_text: str
    fetched_at: str
    truncated: bool
    outgoing_references: tuple[WebCitationReference, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.evidence_id, str) or self.evidence_id == "":
            raise ValueError("Web evidence requires an id")
        if normalize_public_http_url(self.requested_url) != self.requested_url:
            raise ValueError("Web evidence requires a normalized requested URL")
        if normalize_public_http_url(self.final_url) != self.final_url:
            raise ValueError("Web evidence requires a normalized final URL")
        if not isinstance(self.content_text, str) or self.content_text == "":
            raise ValueError("Web evidence requires content")
        if not isinstance(self.outgoing_references, tuple):
            raise TypeError("Web evidence outgoing references must be a tuple")
        outgoing_urls: list[str] = []
        for reference in self.outgoing_references:
            if not isinstance(reference, WebCitationReference):
                raise TypeError(
                    "Web evidence outgoing references must contain WebCitationReference"
                )
            if reference.source_kind != "page_link":
                raise ValueError("Web evidence outgoing reference must be a page link")
            if reference.source_page_evidence_id != self.evidence_id:
                raise ValueError("Web evidence outgoing reference belongs to another page")
            outgoing_urls.append(reference.final_url)
        if len(set(outgoing_urls)) != len(outgoing_urls):
            raise ValueError("Web evidence outgoing reference URLs must be unique")

    @property
    def citation_token(self) -> str:
        return f"[[web:{self.evidence_id}]]"

    @property
    def citation_reference(self) -> WebCitationReference:
        return WebCitationReference(
            evidence_id=self.evidence_id,
            final_url=self.final_url,
            title=self.title,
            source_kind="opened_page",
            source_page_evidence_id=self.evidence_id,
        )

    @property
    def citation_references(self) -> tuple[WebCitationReference, ...]:
        return (self.citation_reference, *self.outgoing_references)

    def as_model_payload(self) -> dict[str, object]:
        return {
            "evidence_id": self.evidence_id,
            "citation_token": self.citation_token,
            "requested_url": self.requested_url,
            "final_url": self.final_url,
            "title": self.title,
            "content_text": self.content_text,
            "outgoing_link_references": [
                reference.as_catalog_payload()
                for reference in self.outgoing_references
            ],
            "fetched_at": self.fetched_at,
            "truncated": self.truncated,
        }


class WebEvidenceCapacityError(RuntimeError):
    """The configured in-memory evidence budget cannot retain another page."""


@dataclass
class _WebSession:
    """The pages one authenticated session has retained."""
    by_url: dict[str, WebPageEvidence]
    by_id: dict[str, WebPageEvidence]
    references_by_id: dict[str, WebCitationReference]
    # Short numbers the model cites as [[web:N]]: long ids are easy to miscopy.
    short_numbers: dict[str, int]


def _new_web_session() -> _WebSession:
    return _WebSession(by_url={}, by_id={}, references_by_id={}, short_numbers={})


class WebEvidenceStore:
    def __init__(self) -> None:
        self._sessions: dict[str, _WebSession] = {}
        self._lock = Lock()

    def reset(self) -> None:
        with self._lock:
            self._sessions.clear()

    def clear_session(self, *, session_key: str) -> None:
        _validate_session_key(session_key)
        with self._lock:
            # A session that never fetched a page has nothing to clear.
            if session_key in self._sessions:
                del self._sessions[session_key]

    def _retained_locked(self, session_key: str) -> _WebSession:
        """What the session retained; a session that never fetched a page has nothing."""
        if session_key not in self._sessions:  # shockharness: ignore[DEF002] reason="a session that never fetched a page has retained nothing"
            return _new_web_session()
        return self._sessions[session_key]

    def find_by_url(self, *, session_key: str, url: str) -> WebPageEvidence | None:
        _validate_session_key(session_key)
        normalized = normalize_public_http_url(url)
        if normalized is None:
            return None
        with self._lock:
            by_url = self._retained_locked(session_key).by_url
            if normalized not in by_url:  # shockharness: ignore[DEF002] reason="a URL the session never fetched has no evidence"
                return None
            return by_url[normalized]

    def retain_success(
        self,
        *,
        session_key: str,
        result: WebPageFetchResult,
    ) -> WebPageEvidence:
        _validate_session_key(session_key)
        if not isinstance(result, WebPageFetchResult) or result.status != "ok":
            raise ValueError("Only successful page fetches can become web evidence")
        with self._lock:
            if session_key not in self._sessions:
                self._sessions[session_key] = _new_web_session()
            session = self._sessions[session_key]
            by_url = session.by_url
            by_id = session.by_id
            references_by_id = session.references_by_id
            existing = None
            if result.requested_url in by_url:
                existing = by_url[result.requested_url]
            elif result.final_url in by_url:
                existing = by_url[result.final_url]
            if existing is not None:
                by_url[result.requested_url] = existing
                by_url[result.final_url] = existing
                return existing
            unique_pages = len(by_id)
            retained_characters = sum(
                len(evidence.content_text) for evidence in by_id.values()
            )
            if unique_pages >= MAX_RETAINED_WEB_PAGES:
                raise WebEvidenceCapacityError(
                    f"Web evidence limit reached ({MAX_RETAINED_WEB_PAGES} pages)"
                )
            if retained_characters + len(result.content_text) > MAX_RETAINED_WEB_CHARACTERS:
                raise WebEvidenceCapacityError(
                    "Web evidence text limit reached "
                    f"({MAX_RETAINED_WEB_CHARACTERS} characters)"
                )
            evidence_id = str(uuid4())
            outgoing_references = tuple(
                WebCitationReference(
                    evidence_id=str(uuid4()),
                    final_url=link_url,
                    title=link_title,
                    source_kind="page_link",
                    source_page_evidence_id=evidence_id,
                )
                for link_title, link_url in result.outgoing_links
                if link_url != result.final_url
            )
            evidence = WebPageEvidence(
                evidence_id=evidence_id,
                requested_url=result.requested_url,
                final_url=result.final_url,
                title=result.title,
                content_text=result.content_text,
                fetched_at=result.fetched_at,
                truncated=result.truncated,
                outgoing_references=outgoing_references,
            )
            references = evidence.citation_references
            if any(reference.evidence_id in references_by_id for reference in references):
                raise RuntimeError("Generated duplicate web citation reference id")
            by_url[result.requested_url] = evidence
            by_url[result.final_url] = evidence
            by_id[evidence.evidence_id] = evidence
            references_by_id.update(
                (reference.evidence_id, reference) for reference in references
            )
            short_numbers = session.short_numbers
            for reference in references:
                assert reference.evidence_id not in short_numbers
                short_numbers[reference.evidence_id] = len(short_numbers) + 1
            return evidence

    def short_citation_token(self, *, session_key: str, evidence_id: str) -> str:
        """The [[web:N]] token the model cites for a retained page or link."""
        _validate_session_key(session_key)
        with self._lock:
            return f"[[web:{self._sessions[session_key].short_numbers[evidence_id]}]]"

    def evidence_ids_by_short_number(self, *, session_key: str) -> dict[int, str]:
        """Every short citation number of the session, mapped to its full evidence id."""
        _validate_session_key(session_key)
        with self._lock:
            short_numbers = self._retained_locked(session_key).short_numbers
            return {number: evidence_id for evidence_id, number in short_numbers.items()}

    def get(self, *, session_key: str, evidence_id: str) -> WebPageEvidence:
        _validate_session_key(session_key)
        if not isinstance(evidence_id, str) or evidence_id == "":
            raise ValueError("Web evidence id must be non-empty")
        with self._lock:
            by_id = self._retained_locked(session_key).by_id
            if evidence_id not in by_id:
                raise KeyError(f"Unknown web evidence id: {evidence_id}")
            return by_id[evidence_id]

    def get_reference(
        self,
        *,
        session_key: str,
        evidence_id: str,
    ) -> WebCitationReference:
        _validate_session_key(session_key)
        if not isinstance(evidence_id, str) or evidence_id == "":
            raise ValueError("Web citation reference id must be non-empty")
        with self._lock:
            references_by_id = self._retained_locked(session_key).references_by_id
            if evidence_id not in references_by_id:
                raise KeyError(f"Unknown web citation reference id: {evidence_id}")
            return references_by_id[evidence_id]

    def available_references_for_ids(
        self,
        *,
        session_key: str,
        evidence_ids: tuple[str, ...],
    ) -> tuple[WebCitationReference, ...]:
        _validate_session_key(session_key)
        if not isinstance(evidence_ids, tuple):
            raise TypeError("Web citation reference ids must be a tuple")
        if any(
            not isinstance(evidence_id, str) or evidence_id == ""
            for evidence_id in evidence_ids
        ):
            raise ValueError("Web citation reference ids must be non-empty strings")
        if len(set(evidence_ids)) != len(evidence_ids):
            raise ValueError("Web citation reference ids must be unique")
        with self._lock:
            by_id = self._retained_locked(session_key).references_by_id
            return tuple(
                by_id[evidence_id]
                for evidence_id in evidence_ids
                if evidence_id in by_id
            )

    def retained_urls(self, *, session_key: str) -> tuple[str, ...]:
        _validate_session_key(session_key)
        with self._lock:
            return tuple(self._retained_locked(session_key).by_url)

    def evidence(self, *, session_key: str) -> tuple[WebPageEvidence, ...]:
        _validate_session_key(session_key)
        with self._lock:
            return tuple(self._retained_locked(session_key).by_id.values())


def _validate_session_key(session_key: str) -> None:
    if not isinstance(session_key, str) or session_key == "":
        raise ValueError("Web evidence session key must be non-empty")


def citation_references_for_pages(
    pages: tuple[WebPageEvidence, ...],
) -> tuple[WebCitationReference, ...]:
    if not isinstance(pages, tuple):
        raise TypeError("Web citation pages must be a tuple")
    if any(not isinstance(page, WebPageEvidence) for page in pages):
        raise TypeError("Web citation pages must contain WebPageEvidence")
    opened_urls = {page.final_url for page in pages}
    references: list[WebCitationReference] = []
    seen_urls: set[str] = set()
    for page in pages:
        reference = page.citation_reference
        if reference.final_url not in seen_urls:
            references.append(reference)
            seen_urls.add(reference.final_url)
    for page in pages:
        for reference in page.outgoing_references:
            if reference.final_url in opened_urls or reference.final_url in seen_urls:
                continue
            references.append(reference)
            seen_urls.add(reference.final_url)
    return tuple(references)


web_evidence_store = WebEvidenceStore()
