"""Bounded public-web page retrieval for agent evidence."""

from __future__ import annotations

from http import HTTPStatus
import asyncio
import codecs
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from html.parser import HTMLParser
from io import BytesIO
import re
from collections.abc import Callable
from typing import Literal
from urllib.parse import urljoin

import httpcore
import httpx
from pypdf import PdfReader
from pypdf.errors import PyPdfError

from app.services.exception_capture import CapturedExceptionContext
from app.services.public_http import PinnedPublicHTTPTransport
from app.services.public_http import PublicHttpTargetRejected
from app.services.public_http import ResolvedPublicHttpTarget
from app.services.public_http import normalize_public_http_url
from app.utils.sent_fields import sent_or_none
from app.services.public_http import resolve_public_http_target


MAX_WEB_PAGE_URLS = 8
MAX_WEB_FETCH_CONCURRENCY = 4
MAX_WEB_REDIRECTS = 5
MAX_WEB_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_WEB_PAGE_TEXT_CHARACTERS = 120_000
MAX_WEB_BATCH_TEXT_CHARACTERS = 480_000
MAX_WEB_PDF_PAGES = 100
MAX_WEB_PAGE_OUTGOING_LINKS = 256
_OUTGOING_LINK_FIELD_COUNT = 2  # (title, URL)
WEB_FETCH_TIMEOUT_SECONDS = 10.0
_WEB_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/140.0.0.0 Safari/537.36 MetaList/0.8"
)
_SUPPORTED_CONTENT_TYPES = frozenset(
    {
        "application/pdf",
        "application/xhtml+xml",
        "text/html",
        "text/plain",
    }
)


@dataclass(frozen=True, slots=True)
class WebPageFetchResult:
    requested_url: str
    final_url: str
    status: Literal["ok", "blocked", "failed", "unsupported"]
    title: str
    content_text: str
    outgoing_links: tuple[tuple[str, str], ...]
    fetched_at: str
    truncated: bool
    error_kind: str

    def __post_init__(self) -> None:
        if not isinstance(self.requested_url, str) or self.requested_url == "":
            raise ValueError("Web fetch result requires requested_url")
        if self.status == "ok":
            if normalize_public_http_url(self.final_url) != self.final_url:
                raise ValueError("Successful web fetch requires normalized final_url")
            if self.content_text == "":
                raise ValueError("Successful web fetch requires readable content")
            if self.error_kind != "":
                raise ValueError("Successful web fetch cannot include error_kind")
        else:
            if self.content_text != "":
                raise ValueError("Unsuccessful web fetch cannot include content")
            if self.error_kind == "":
                raise ValueError("Unsuccessful web fetch requires error_kind")
        if not isinstance(self.outgoing_links, tuple):
            raise TypeError("Web fetch outgoing_links must be a tuple")
        outgoing_urls: list[str] = []
        for link in self.outgoing_links:
            if not isinstance(link, tuple) or len(link) != _OUTGOING_LINK_FIELD_COUNT:
                raise TypeError("Web fetch outgoing link must be a (title, URL) tuple")
            link_title, link_url = link
            if not isinstance(link_title, str) or link_title == "":
                raise ValueError("Web fetch outgoing link requires a title")
            if normalize_public_http_url(link_url) != link_url:
                raise ValueError("Web fetch outgoing link requires a normalized URL")
            outgoing_urls.append(link_url)
        if len(set(outgoing_urls)) != len(outgoing_urls):
            raise ValueError("Web fetch outgoing links must have unique URLs")
        if self.status != "ok" and self.outgoing_links:
            raise ValueError("Unsuccessful web fetch cannot include outgoing links")


@dataclass(frozen=True, slots=True)
class _DownloadedWebResponse:
    kind: Literal["content", "redirect", "error"]
    final_url: str
    content: bytes
    content_type: str
    encoding: str
    truncated: bool
    error_kind: str


def _meta_tag_kind(attrs_by_name: dict[str, str]) -> str:
    """What a meta tag describes, by property= (Open Graph) or name=; empty when neither."""
    for kind_attribute in ("property", "name"):
        if kind_attribute in attrs_by_name and attrs_by_name[kind_attribute] != "":
            return attrs_by_name[kind_attribute].casefold()
    return ""


class _ReadableHtmlParser(HTMLParser):
    _SUPPRESSED_TAGS = frozenset(
        {"aside", "footer", "form", "header", "nav", "noscript", "script", "style", "svg"}
    )
    _BLOCK_TAGS = frozenset(
        {
            "article", "blockquote", "br", "dd", "div", "dl", "dt", "h1", "h2",
            "h3", "h4", "h5", "h6", "hr", "li", "main", "ol", "p", "pre",
            "section", "table", "tbody", "td", "th", "thead", "tr", "ul",
        }
    )

    def __init__(self, *, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        if normalize_public_http_url(base_url) != base_url:
            raise ValueError("HTML parser requires a normalized public base URL")
        self._base_url = base_url
        self._suppressed_depth = 0
        self._inside_title = False
        self._title_parts: list[str] = []
        self._text_parts: list[str] = []
        self._metadata_title = ""
        self._active_links: list[tuple[str, list[str]]] = []
        self._outgoing_links: list[tuple[str, str]] = []
        self._outgoing_link_urls: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized_tag = tag.casefold()
        if normalized_tag == "title":
            self._inside_title = True
            return
        if normalized_tag == "meta":
            attrs_by_name = {
                name.casefold(): value
                for name, value in attrs
                if isinstance(value, str)
            }
            key = _meta_tag_kind(attrs_by_name)
            if key in {"og:title", "twitter:title"} and self._metadata_title == "" and "content" in attrs_by_name:
                self._metadata_title = attrs_by_name["content"]
            return
        if normalized_tag == "a":
            attrs_by_name = {
                name.casefold(): value
                for name, value in attrs
                if isinstance(value, str)
            }
            normalized_link = ""
            if self._suppressed_depth == 0:
                # A link without href= points at the page itself, as before.
                href = ""
                if "href" in attrs_by_name:
                    href = attrs_by_name["href"]
                join_capture = CapturedExceptionContext(
                    ValueError,
                    boundary='app/services/agent/web_fetch.py:handle_starttag:join_capture',
                )
                joined_link = None
                with join_capture:
                    joined_link = urljoin(self._base_url, href)
                if join_capture.captured_exception is None:
                    if joined_link is None:
                        raise RuntimeError("HTML link joining returned no result")
                    public_link = normalize_public_http_url(joined_link)
                    if public_link is not None:
                        normalized_link = public_link
            self._active_links.append((normalized_link, []))
        if normalized_tag in self._SUPPRESSED_TAGS:
            self._suppressed_depth += 1
            return
        if self._suppressed_depth == 0 and normalized_tag in self._BLOCK_TAGS:
            self._text_parts.append("\n")
            if normalized_tag == "li":
                self._text_parts.append("- ")

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.casefold()
        if normalized_tag == "a":
            if self._active_links:
                normalized_link, label_parts = self._active_links.pop()
                if normalized_link != "" and self._suppressed_depth == 0:
                    self._text_parts.append(f" ({normalized_link})")
                    label = _clean_single_line("".join(label_parts), maximum=300)
                    if (
                        label != ""
                        and normalized_link not in self._outgoing_link_urls
                        and len(self._outgoing_links) < MAX_WEB_PAGE_OUTGOING_LINKS
                    ):
                        self._outgoing_links.append((label, normalized_link))
                        self._outgoing_link_urls.add(normalized_link)
            return
        if normalized_tag == "title":
            self._inside_title = False
            return
        if normalized_tag in self._SUPPRESSED_TAGS:
            if self._suppressed_depth > 0:
                self._suppressed_depth -= 1
            return
        if self._suppressed_depth == 0 and normalized_tag in self._BLOCK_TAGS:
            self._text_parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._inside_title:
            self._title_parts.append(data)
        elif self._suppressed_depth == 0:
            self._text_parts.append(data)
            if self._active_links:
                self._active_links[-1][1].append(data)

    @property
    def title(self) -> str:
        candidate = self._metadata_title
        if candidate == "":
            candidate = "".join(self._title_parts)
        return _clean_single_line(candidate, maximum=300)

    @property
    def readable_text(self) -> str:
        return _normalize_readable_text("".join(self._text_parts))

    @property
    def outgoing_links(self) -> tuple[tuple[str, str], ...]:
        return tuple(self._outgoing_links)


def fetch_web_page(normalized_url: str, *, allows_target: Callable[[str], bool]) -> WebPageFetchResult:
    """Fetch one page; ``allows_target`` must approve every address, including each
    redirect hop (contextual web mode allows only addresses already in context)."""
    if normalize_public_http_url(normalized_url) != normalized_url:
        raise ValueError("fetch_web_page requires a normalized HTTP(S) URL")
    current_url = normalized_url
    for _redirect_index in range(MAX_WEB_REDIRECTS + 1):
        if not allows_target(current_url):
            error_kind = "not_available_in_permitted_context"
            if current_url != normalized_url:
                error_kind = "redirect_not_available_in_permitted_context"
            return _error_result(
                requested_url=normalized_url,
                final_url=current_url,
                status="blocked",
                error_kind=error_kind,
            )
        target_capture = CapturedExceptionContext(
            PublicHttpTargetRejected,
            boundary='app/services/agent/web_fetch.py:fetch_web_page:target_capture',
        )
        target = None
        with target_capture:
            target = resolve_public_http_target(current_url)
        if target_capture.captured_exception is not None:
            exc = target_capture.captured_exception
            if not isinstance(exc, PublicHttpTargetRejected):
                raise RuntimeError("Web target rejection has an unexpected type")
            status: Literal["blocked", "failed"] = "blocked"
            if exc.reason == "dns_error":
                status = "failed"
            return _error_result(
                requested_url=normalized_url,
                final_url=current_url,
                status=status,
                error_kind=exc.reason,
            )
        if target is None:
            raise RuntimeError("Web target resolution returned no target")
        downloaded = _download_one_url(current_url, target)
        if downloaded.kind == "redirect":
            current_url = downloaded.final_url
            continue
        if downloaded.kind == "error":
            status = "failed"
            if downloaded.error_kind in {"unsupported_content_type", "unsupported_redirect"}:
                status = "unsupported"
            return _error_result(
                requested_url=normalized_url,
                final_url=current_url,
                status=status,
                error_kind=downloaded.error_kind,
            )
        title, content_text, outgoing_links, extracted_truncated, extraction_error = _extract_web_content(
            content=downloaded.content,
            content_type=downloaded.content_type,
            encoding=downloaded.encoding,
            base_url=current_url,
        )
        if extraction_error != "":
            return _error_result(
                requested_url=normalized_url,
                final_url=current_url,
                status="unsupported",
                error_kind=extraction_error,
            )
        return WebPageFetchResult(
            requested_url=normalized_url,
            final_url=current_url,
            status="ok",
            title=title,
            content_text=content_text,
            outgoing_links=outgoing_links,
            fetched_at=_utc_now_text(),
            truncated=any((downloaded.truncated, extracted_truncated)),
            error_kind="",
        )
    return _error_result(
        requested_url=normalized_url,
        final_url=current_url,
        status="failed",
        error_kind="too_many_redirects",
    )


async def fetch_web_pages(urls: list[str], *, allows_target: Callable[[str], bool]) -> tuple[WebPageFetchResult, ...]:
    if not isinstance(urls, list) or len(urls) < 1 or len(urls) > MAX_WEB_PAGE_URLS:
        raise ValueError(f"Web page batch must contain 1–{MAX_WEB_PAGE_URLS} URLs")
    normalized_by_input: list[str | None] = []
    unique_urls: list[str] = []
    for url in urls:
        if not isinstance(url, str) or url.strip() == "":
            raise ValueError("Web page batch URLs must be non-empty strings")
        normalized = normalize_public_http_url(url)
        normalized_by_input.append(normalized)
        if normalized is not None and normalized not in unique_urls:
            unique_urls.append(normalized)

    semaphore = asyncio.Semaphore(MAX_WEB_FETCH_CONCURRENCY)

    async def fetch_one(url: str) -> WebPageFetchResult:
        async with semaphore:
            return await asyncio.to_thread(fetch_web_page, url, allows_target=allows_target)

    fetched = await asyncio.gather(*(fetch_one(url) for url in unique_urls))
    result_by_url = dict(zip(unique_urls, fetched, strict=True))
    ordered: list[WebPageFetchResult] = []
    for original, normalized in zip(urls, normalized_by_input, strict=True):
        if normalized is None:
            ordered.append(
                _error_result(
                    requested_url=original,
                    final_url="",
                    status="blocked",
                    error_kind="unsupported_scheme_or_url",
                )
            )
        else:
            ordered.append(result_by_url[normalized])
    return _apply_batch_text_limit(tuple(ordered))


# The page as the server sent it, a redirect, or the error kind; transport failures propagate.
def _exchange_web_request(url: str, target: ResolvedPublicHttpTarget) -> _DownloadedWebResponse:
    with httpx.Client(
        timeout=WEB_FETCH_TIMEOUT_SECONDS,
        follow_redirects=False,
        transport=PinnedPublicHTTPTransport(
            target=target,
            network_backend=httpcore.SyncBackend(),
        ),
        headers={
            "User-Agent": _WEB_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,text/plain,application/pdf",
            "Accept-Language": "en-US,en;q=0.9",
        },
    ) as client:
        with client.stream("GET", url) as response:
            if httpx.codes.is_redirect(response.status_code):
                location = sent_or_none(response.headers, "location")
                if location is None or location.strip() == "":
                    return _download_error(url, "redirect_without_location")
                next_url = normalize_public_http_url(str(httpx.URL(url).join(location)))
                if next_url is None:
                    return _download_error(url, "unsupported_redirect")
                return _DownloadedWebResponse(
                    kind="redirect",
                    final_url=next_url,
                    content=b"",
                    content_type="",
                    encoding="",
                    truncated=False,
                    error_kind="",
                )
            if response.status_code >= HTTPStatus.BAD_REQUEST:
                return _download_error(url, f"http_{response.status_code}")
            # A response without a content type is judged by its bytes below.
            content_type = sent_or_none(response.headers, "content-type")
            media_type = ""
            if content_type is not None:
                media_type = content_type.split(";", 1)[0].strip().casefold()
            content_length = sent_or_none(response.headers, "content-length")
            if content_length is not None and content_length.isdecimal():
                if int(content_length) > MAX_WEB_RESPONSE_BYTES:
                    return _download_error(url, "response_too_large")
            chunks: list[bytes] = []
            total_bytes = 0
            truncated = False
            for chunk in response.iter_bytes():
                remaining = MAX_WEB_RESPONSE_BYTES - total_bytes
                if len(chunk) > remaining:
                    chunks.append(chunk[:remaining])
                    truncated = True
                    break
                chunks.append(chunk)
                total_bytes += len(chunk)
            content = b"".join(chunks)
            if media_type == "":
                media_type = _sniff_content_type(content)
            if media_type not in _SUPPORTED_CONTENT_TYPES:
                return _download_error(url, "unsupported_content_type")
            response_encoding = response.encoding
            if response_encoding is None:
                response_encoding = "utf-8"
            return _DownloadedWebResponse(
                kind="content",
                final_url=url,
                content=content,
                content_type=media_type,
                encoding=response_encoding,
                truncated=truncated,
                error_kind="",
            )


def _download_one_url(url: str, target: ResolvedPublicHttpTarget) -> _DownloadedWebResponse:
    transport_capture = CapturedExceptionContext(
        httpx.TimeoutException,
        httpx.NetworkError,
        httpx.HTTPError,
        httpcore.TimeoutException,
        httpcore.NetworkError,
        httpcore.ProtocolError,
        boundary='app/services/agent/web_fetch.py:_download_one_url:transport_capture',
    )
    downloaded: _DownloadedWebResponse | None = None
    with transport_capture:
        downloaded = _exchange_web_request(url, target)
    captured = transport_capture.captured_exception
    if isinstance(captured, (httpx.TimeoutException, httpcore.TimeoutException)):
        return _download_error(url, "timeout")
    if isinstance(captured, (httpx.NetworkError, httpcore.NetworkError)):
        return _download_error(url, "network_error")
    if captured is not None:
        return _download_error(url, "http_client_error")
    if downloaded is None:
        raise RuntimeError("Web transport returned without a result or exception")
    return downloaded


def _extract_web_content(
    *,
    content: bytes,
    content_type: str,
    encoding: str,
    base_url: str,
) -> tuple[str, str, tuple[tuple[str, str], ...], bool, str]:
    if normalize_public_http_url(base_url) != base_url:
        raise ValueError("Web content extraction requires a normalized public base URL")
    if content_type == "application/pdf":
        title, text, truncated, error = _extract_pdf_content(content)
        return title, text, (), truncated, error
    if content_type == "text/plain":
        text = _normalize_readable_text(_decode_web_text(content, encoding))
        title, bounded_text, truncated, error = _bounded_extracted_text(title="", text=text)
        return title, bounded_text, (), truncated, error
    assert content_type in {"text/html", "application/xhtml+xml"}
    parser = _ReadableHtmlParser(base_url=base_url)
    parser.feed(_decode_web_text(content, encoding))
    title, text, truncated, error = _bounded_extracted_text(
        title=parser.title,
        text=parser.readable_text,
    )
    return title, text, parser.outgoing_links, truncated, error


def _decode_web_text(content: bytes, encoding: str) -> str:
    encoding_capture = CapturedExceptionContext(
        LookupError,
        boundary='app/services/agent/web_fetch.py:_decode_web_text:encoding_capture',
    )
    codec = None
    with encoding_capture:
        codec = codecs.lookup(encoding)
    if encoding_capture.captured_exception is not None:
        return content.decode("utf-8", errors="replace")
    if codec is None:
        raise RuntimeError("Web text codec lookup returned no codec")
    return content.decode(codec.name, errors="replace")


# Title, readable text, whether it was cut short, and the error kind of a PDF; PyPdfError for a malformed one.
def _read_pdf(content: bytes) -> tuple[str, str, bool, str]:
    reader = PdfReader(BytesIO(content), strict=True)
    if reader.is_encrypted:
        return "", "", False, "encrypted_pdf"
    title = ""
    if reader.metadata is not None and isinstance(reader.metadata.title, str):
        title = _clean_single_line(reader.metadata.title, maximum=300)
    page_text: list[str] = []
    truncated_pages = len(reader.pages) > MAX_WEB_PDF_PAGES
    for page in reader.pages[:MAX_WEB_PDF_PAGES]:
        extracted = page.extract_text()
        if extracted:
            page_text.append(extracted)
    bounded_title, bounded_text, truncated_text, error = _bounded_extracted_text(
        title=title,
        text=_normalize_readable_text("\n\n".join(page_text)),
    )
    return bounded_title, bounded_text, any((truncated_pages, truncated_text)), error


def _extract_pdf_content(content: bytes) -> tuple[str, str, bool, str]:
    pdf_capture = CapturedExceptionContext(
        PyPdfError,
        boundary='app/services/agent/web_fetch.py:_extract_pdf_content:pdf_capture',
    )
    extracted: tuple[str, str, bool, str] | None = None
    with pdf_capture:
        extracted = _read_pdf(content)
    if pdf_capture.captured_exception is not None:
        return "", "", False, "malformed_pdf"
    if extracted is None:
        raise RuntimeError("PDF extraction returned without a result or exception")
    return extracted


def _bounded_extracted_text(
    *,
    title: str,
    text: str,
) -> tuple[str, str, bool, str]:
    if text == "":
        return "", "", False, "no_readable_text"
    if len(text) <= MAX_WEB_PAGE_TEXT_CHARACTERS:
        return title, text, False, ""
    return title, text[:MAX_WEB_PAGE_TEXT_CHARACTERS].rstrip(), True, ""


def _apply_batch_text_limit(
    results: tuple[WebPageFetchResult, ...],
) -> tuple[WebPageFetchResult, ...]:
    remaining = MAX_WEB_BATCH_TEXT_CHARACTERS
    limited_by_identity: dict[int, WebPageFetchResult] = {}
    output: list[WebPageFetchResult] = []
    for result in results:
        identity = id(result)
        if identity in limited_by_identity:
            output.append(limited_by_identity[identity])
            continue
        limited = result
        if result.status == "ok":
            retained = result.content_text[:remaining].rstrip()
            if retained == "":
                limited = _error_result(
                    requested_url=result.requested_url,
                    final_url=result.final_url,
                    status="failed",
                    error_kind="batch_text_limit",
                )
            elif len(retained) < len(result.content_text):
                limited = replace(result, content_text=retained, truncated=True)
            remaining -= len(retained)
        limited_by_identity[identity] = limited
        output.append(limited)
    return tuple(output)


def _download_error(url: str, error_kind: str) -> _DownloadedWebResponse:
    return _DownloadedWebResponse(
        kind="error",
        final_url=url,
        content=b"",
        content_type="",
        encoding="",
        truncated=False,
        error_kind=error_kind,
    )


def _error_result(
    *,
    requested_url: str,
    final_url: str,
    status: Literal["blocked", "failed", "unsupported"],
    error_kind: str,
) -> WebPageFetchResult:
    return WebPageFetchResult(
        requested_url=requested_url,
        final_url=final_url,
        status=status,
        title="",
        content_text="",
        outgoing_links=(),
        fetched_at=_utc_now_text(),
        truncated=False,
        error_kind=error_kind,
    )


def _sniff_content_type(content: bytes) -> str:
    stripped = content.lstrip()
    if stripped.startswith(b"%PDF-"):
        return "application/pdf"
    if stripped[:1] == b"<":
        return "text/html"
    return "text/plain"


def _clean_single_line(value: str, *, maximum: int) -> str:
    cleaned = " ".join(value.split())
    if len(cleaned) <= maximum:
        return cleaned
    return cleaned[:maximum].rstrip()


def _normalize_readable_text(value: str) -> str:
    lines: list[str] = []
    previous_blank = True
    for raw_line in value.splitlines():
        line = re.sub(r"[\t\f\v ]+", " ", raw_line).strip()
        if line == "":
            if not previous_blank:
                lines.append("")
            previous_blank = True
            continue
        lines.append(line)
        previous_blank = False
    return "\n".join(lines).strip()


def _utc_now_text() -> str:
    return datetime.now(timezone.utc).isoformat()
