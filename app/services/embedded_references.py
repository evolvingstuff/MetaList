from __future__ import annotations

import html
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from itertools import islice
from typing import Callable, FrozenSet, Iterator, List, Optional, Tuple

from app.services.content_formatting import find_consumed_content_wrapper_keys
from app.services.content_formatting import CREDENTIAL_MASK
from app.services.content_formatting import find_global_credential_tag
from app.services.content_formatting import format_note_content_for_view
from app.services.content_formatting import has_scoped_footnotes
from app.services.content_formatting import render_standalone_link_title_html
from app.services.file_text_preview import text_file_badge
from app.services.inline_image_occurrences import annotate_inline_image_occurrences
from app.services.remote_image_proxy import (
    remote_image_proxy_registry,
    rewrite_remote_image_sources_for_proxy,
)
from app.security.sensitive_cache import sensitive_lru_cache
from app.utils.text_utils import strip_html


_HTML_TOKEN_SPLIT_RE = re.compile(r"(<[^>]+>)")
# Editors write "first line<div>second line</div>", so a block's opening tag also ends a line.
_FIRST_LINE_BOUNDARY_RE = re.compile(
    r"(?i)<br\s*/?>|</?(?:div|p|li|h[1-6]|pre|blockquote|ul|ol|table|tr|td|th|section|article|header|footer)\b[^>]*>\s*|\n"
)
_TEXT_LINE_SPLIT_RE = re.compile(r"(\r\n|\r|\n)")
_HTML_TAG_NAME_RE = re.compile(r"^<\s*/?\s*([a-zA-Z][a-zA-Z0-9:-]*)")
_HTML_CLOSING_TAG_NAME_RE = re.compile(r"^<\s*/\s*([a-zA-Z][a-zA-Z0-9:-]*)")
_COLLAPSED_PREVIEW_BLOCK_TAGS = {
    "article",
    "blockquote",
    "div",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
}
_COLLAPSED_PREVIEW_MEDIA_TAGS = {
    "audio",
    "canvas",
    "embed",
    "iframe",
    "img",
    "math",
    "object",
    "svg",
    "video",
}
_REFERENCE_TOKEN_RE = re.compile(r"!?\[\[[^\[\]\n]+\]\]")
_INLINE_IMG_TAG_RE = re.compile(r"<img\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>", re.IGNORECASE)
# File kinds that collapse to a thumbnail, in a collapsed note and in a compact reference to it.
_THUMBNAIL_FILE_KINDS = frozenset({"image", "excalidraw"})
_UUID_REFERENCE_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_WHITESPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True, slots=True)
class EmbedRenderContext:
    has_note: Callable[[str], bool]
    get_note: Callable[[str], object]
    get_children: Callable[[Optional[str]], List[str]]
    has_file: Callable[[str], bool]
    get_file: Callable[[str], object]


@dataclass(frozen=True, slots=True)
class ReferenceToken:
    note_id: str
    start: int
    end: int
    is_embed: bool
    occurrence_index: int


class _FootnoteReferencePreview(HTMLParser):
    """Keep source citation superscripts, with no nested links or buttons."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.output: list[str] = []
        self.marker_open = False
        self.in_references = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "section" and any(
            name == "class" and value is not None and "meta-footnote-references" in value.split()
            for name, value in attrs
        ):
            self.in_references = True
        if tag == "sup" and any(
            name == "class" and value is not None and "meta-footnote-marker" in value.split()
            for name, value in attrs
        ):
            assert not self.marker_open
            self.marker_open = True
            self.output.append('<sup class="ai-chat-citation-marker meta-footnote-marker">')

    def handle_endtag(self, tag: str) -> None:
        if tag == "sup" and self.marker_open:
            self.output.append("</sup>")
            self.marker_open = False

    def handle_data(self, data: str) -> None:
        if not self.in_references:
            self.output.append(html.escape(_REFERENCE_TOKEN_RE.sub(_strip_reference_token_if_uuid, data)))


class _ImageSourceParser(HTMLParser):
    """The src of the first <img> in a fragment of stored note HTML."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.source: Optional[str] = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "img" or self.source is not None:
            return
        for name, value in attrs:
            if name == "src" and value is not None:
                self.source = value


def collect_reference_tokens_from_html(content_html: str) -> List[ReferenceToken]:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if "[[" not in content_html:
        return []

    parts = _HTML_TOKEN_SPLIT_RE.split(content_html)
    tokens: List[ReferenceToken] = []
    text_offset = 0
    occurrence_index = 0
    for part in parts:
        if _is_html_segment(part):
            text_offset += len(part)
            continue
        part_tokens = _collect_reference_tokens_in_text(
            text=part,
            text_offset=text_offset,
            occurrence_start=occurrence_index,
        )
        tokens.extend(part_tokens)
        occurrence_index += len(part_tokens)
        text_offset += len(part)
    return tokens


def normalize_reference_modes_for_comparison(content_html: str) -> str:
    """Ignore only embed/link markers on valid references, preserving other HTML."""
    tokens = collect_reference_tokens_from_html(content_html)
    parts = []
    offset = 0
    for token in tokens:
        if token.is_embed:
            assert content_html[token.start] == "!"
            parts.append(content_html[offset:token.start])
            offset = token.start + 1
    parts.append(content_html[offset:])
    return "".join(parts)


def replace_reference_token_mode_in_html(
    *,
    content_html: str,
    reference_note_id: str,
    occurrence_index: int,
    target_mode: str,
) -> tuple[str, bool]:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if not isinstance(reference_note_id, str) or reference_note_id == "":
        raise TypeError("reference_note_id must be a non-empty string")
    if not isinstance(occurrence_index, int):
        raise TypeError("occurrence_index must be an integer")
    if occurrence_index < 0:
        raise ValueError("occurrence_index must be >= 0")
    if target_mode not in {"embed", "link"}:
        raise ValueError("target_mode must be 'embed' or 'link'")

    tokens = collect_reference_tokens_from_html(content_html)
    if occurrence_index >= len(tokens):
        return content_html, False

    token = tokens[occurrence_index]
    if token.note_id != reference_note_id:
        return content_html, False

    token_mode = "link"
    if token.is_embed:
        token_mode = "embed"
    if token_mode == target_mode:
        return content_html, False

    replacement = _format_reference_token(note_id=token.note_id, mode=target_mode)
    updated_content = f"{content_html[:token.start]}{replacement}{content_html[token.end:]}"
    return updated_content, True


def collect_active_reference_tokens(content_html: str) -> List[ReferenceToken]:
    """The note references the renderer shows: every [[note id]] and ![[note id]].

    A [[...]] holding exactly a note id is a link even in a note whose tag bar
    has a [[...]] formatting wrapper (docs/ui/references.md).
    """
    if "[[" not in content_html:
        return []
    return collect_reference_tokens_from_html(content_html)


def render_note_content_with_embeds(
    *,
    note_id: str,
    content_html: str,
    tags: str,
    context: EmbedRenderContext,
    static_export: bool,
    redact_credentials: bool,
) -> str:
    return _render_note_content_with_embeds(
        note_id=note_id,
        content_html=content_html,
        tags=tags,
        context=context,
        static_export=static_export,
        redact_credentials=redact_credentials,
        render_note_embeds_as_links=False,
    )


def _render_note_content_with_embeds(
    *,
    note_id: str,
    content_html: str,
    tags: str,
    context: EmbedRenderContext,
    static_export: bool,
    redact_credentials: bool,
    render_note_embeds_as_links: bool,
) -> str:
    if not isinstance(note_id, str) or note_id == "":
        raise TypeError("note_id must be a non-empty string")
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if not isinstance(tags, str):
        raise TypeError("tags must be a string")
    if not isinstance(static_export, bool):
        raise TypeError("static_export must be a bool")
    if not isinstance(redact_credentials, bool):
        raise TypeError("redact_credentials must be a bool")
    if not isinstance(render_note_embeds_as_links, bool):
        raise TypeError("render_note_embeds_as_links must be a bool")

    annotated_content = content_html
    if not static_export:
        annotated_content = annotate_inline_image_occurrences(content_html)
    content_with_embeds = _replace_reference_tokens_in_html(
        host_note_id=note_id,
        content_html=annotated_content,
        tags=tags,
        context=context,
        ancestry=(note_id,),
        static_export=static_export,
        redact_credentials=redact_credentials,
        render_note_embeds_as_links=render_note_embeds_as_links,
    )
    rendered_content = format_note_content_for_view(
        content_html=content_with_embeds,
        tags=tags,
        redact_credentials=redact_credentials,
    )
    if static_export:
        return rendered_content
    return rewrite_remote_image_sources_for_proxy(
        content_html=rendered_content,
        registry=remote_image_proxy_registry,
    )


def render_collapsed_note_content_with_embeds(
    *,
    note_id: str,
    content_html: str,
    tags: str,
    context: EmbedRenderContext,
    static_export: bool,
    redact_credentials: bool,
) -> str:
    preview_source_html = extract_collapsed_preview_source_html(content_html)
    if has_scoped_footnotes(tags):
        # Footnotes on later source lines can attach markers to the first line.
        preview_source_html = content_html
    return _render_note_content_with_embeds(
        note_id=note_id,
        content_html=preview_source_html,
        tags=tags,
        context=context,
        static_export=static_export,
        redact_credentials=redact_credentials,
        render_note_embeds_as_links=True,
    )


def _iter_collapsed_preview_meaningful_fragments(content_html: str) -> Iterator[str]:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if content_html == "":
        return

    fragment_parts: List[str] = []
    for part in _HTML_TOKEN_SPLIT_RE.split(content_html):
        if part == "":
            continue
        if _is_html_segment(part):
            # Editors write "first line<div>second line</div>": a block opening after content
            # starts a new line, just as a block closing ends one.
            if _is_collapsed_preview_block_opening_tag(part) and _fragment_has_collapsed_preview_content(fragment_parts):
                yield "".join(fragment_parts).strip()
                fragment_parts = []
            fragment_parts.append(part)
            if _is_collapsed_preview_line_boundary_tag(part):
                if _fragment_has_collapsed_preview_content(fragment_parts):
                    yield "".join(fragment_parts).strip()
                fragment_parts = []
            continue

        for text_part in _TEXT_LINE_SPLIT_RE.split(part):
            if text_part == "":
                continue
            if _TEXT_LINE_SPLIT_RE.fullmatch(text_part):
                if _fragment_has_collapsed_preview_content(fragment_parts):
                    yield "".join(fragment_parts).strip()
                fragment_parts = []
                continue
            fragment_parts.append(text_part)

    if _fragment_has_collapsed_preview_content(fragment_parts):
        yield "".join(fragment_parts).strip()


@sensitive_lru_cache(maxsize=8192, max_bytes=32 * 1024 * 1024)
def _collapsed_preview_head(content_html: str) -> Tuple[str, bool]:
    """First meaningful fragment and whether another follows.

    Pure in the content string; a view asks for this several times per note,
    so it is cached and stops scanning once a second fragment is known.
    """
    head = tuple(islice(_iter_collapsed_preview_meaningful_fragments(content_html), 2))
    if not head:
        return "", False
    return head[0], len(head) > 1


def collapsed_preview_head(content_html: str) -> Tuple[str, bool]:
    return _collapsed_preview_head(content_html)


def extract_collapsed_preview_source_html(content_html: str) -> str:
    return _collapsed_preview_head(content_html)[0]


def collapsed_preview_source_has_hidden_content(content_html: str) -> bool:
    return _collapsed_preview_head(content_html)[1]


def collapsed_preview_source_has_media(content_html: str) -> bool:
    return preview_html_has_media(extract_collapsed_preview_source_html(content_html))


def preview_html_has_media(preview_source_html: str) -> bool:
    if preview_source_html == "":
        return False
    return _fragment_has_media_tag(preview_source_html)


def collapsed_preview_source_has_image_file_embed(
    *,
    content_html: str,
    context: EmbedRenderContext,
) -> bool:
    return preview_html_has_image_file_embed(
        preview_source_html=extract_collapsed_preview_source_html(content_html), context=context,
    )


def preview_html_has_image_file_embed(*, preview_source_html: str, context: EmbedRenderContext) -> bool:
    if preview_source_html == "":
        return False
    tokens = collect_reference_tokens_from_html(preview_source_html)
    for token in tokens:
        if not token.is_embed:
            continue
        if not context.has_file(token.note_id):
            continue
        record = context.get_file(token.note_id)
        thumbnail_kind = getattr(record, "thumbnail_kind")
        if not isinstance(thumbnail_kind, str):
            raise TypeError("file thumbnail_kind must be a string")
        if thumbnail_kind in {"image", "excalidraw"}:
            return True
    return False


def collapsed_preview_source_has_note_embed(
    *,
    content_html: str,
    context: EmbedRenderContext,
) -> bool:
    return preview_html_has_note_embed(
        preview_source_html=extract_collapsed_preview_source_html(content_html), context=context,
    )


def preview_html_has_note_embed(*, preview_source_html: str, context: EmbedRenderContext) -> bool:
    if preview_source_html == "":
        return False
    tokens = collect_reference_tokens_from_html(preview_source_html)
    return any(token.is_embed and context.has_note(token.note_id) for token in tokens)


def _replace_reference_tokens_in_html(
    *,
    host_note_id: str,
    content_html: str,
    tags: str,
    context: EmbedRenderContext,
    ancestry: Tuple[str, ...],
    static_export: bool,
    redact_credentials: bool,
    render_note_embeds_as_links: bool,
) -> str:
    parts = _HTML_TOKEN_SPLIT_RE.split(content_html)
    output: List[str] = []
    occurrence_index = 0
    for part in parts:
        if _is_html_segment(part):
            output.append(part)
            continue
        replaced_text, next_occurrence_index = _replace_reference_tokens_in_text(
            host_note_id=host_note_id,
            text=part,
            context=context,
            ancestry=ancestry,
            occurrence_start=occurrence_index,
            static_export=static_export,
            redact_credentials=redact_credentials,
            render_note_embeds_as_links=render_note_embeds_as_links,
        )
        output.append(replaced_text)
        occurrence_index = next_occurrence_index
    return "".join(output)


def _replace_reference_tokens_in_text(
    *,
    host_note_id: str,
    text: str,
    context: EmbedRenderContext,
    ancestry: Tuple[str, ...],
    occurrence_start: int,
    static_export: bool,
    redact_credentials: bool,
    render_note_embeds_as_links: bool,
) -> tuple[str, int]:
    if text == "":
        return "", occurrence_start

    output: List[str] = []
    index = 0
    occurrence_index = occurrence_start
    while index < len(text):
        token_start, token_open_length, is_embed = _find_next_reference_token_start(text=text, start=index)
        if token_start is None:
            output.append(text[index:])
            break

        output.append(text[index:token_start])
        end = text.find("]]", token_start + token_open_length)
        if end == -1:
            output.append(text[token_start:])
            break

        raw_id = text[token_start + token_open_length : end]
        reference_note_id = raw_id.strip()

        if not _is_valid_embed_note_id(reference_note_id):
            # Not a note id (a formatting wrapper or plain brackets): keep the opener
            # and scan on, so a link nested inside, as in [[see [[id]] here]], still counts.
            output.append(text[token_start : token_start + token_open_length])
            index = token_start + token_open_length
            continue

        output.append(
            _render_reference_block(
                host_note_id=host_note_id,
                reference_note_id=reference_note_id,
                occurrence_index=occurrence_index,
                is_embed=is_embed,
                context=context,
                ancestry=ancestry,
                static_export=static_export,
                redact_credentials=redact_credentials,
                render_note_embeds_as_links=render_note_embeds_as_links,
            )
        )
        occurrence_index += 1
        index = end + 2

    return "".join(output), occurrence_index


def _collect_reference_tokens_in_text(
    *,
    text: str,
    text_offset: int,
    occurrence_start: int,
) -> List[ReferenceToken]:
    tokens: List[ReferenceToken] = []
    index = 0
    occurrence_index = occurrence_start
    while index < len(text):
        token_start, token_open_length, is_embed = _find_next_reference_token_start(text=text, start=index)
        if token_start is None:
            break

        token_end_inner = text.find("]]", token_start + token_open_length)
        if token_end_inner == -1:
            break

        raw_id = text[token_start + token_open_length : token_end_inner]
        note_id = raw_id.strip()
        if _is_valid_embed_note_id(note_id):
            tokens.append(
                ReferenceToken(
                    note_id=note_id,
                    start=text_offset + token_start,
                    end=text_offset + token_end_inner + 2,
                    is_embed=is_embed,
                    occurrence_index=occurrence_index,
                )
            )
            occurrence_index += 1
            index = token_end_inner + 2
        else:
            # Same rule as rendering: only the opener is skipped, so nested links are found.
            index = token_start + token_open_length

    return tokens


def _find_next_reference_token_start(*, text: str, start: int) -> tuple[Optional[int], int, bool]:
    # An embed "![[" at i implies "[[" at i + 1, so the earliest token begins at
    # the first "[[" or one character before it when that character is "!".
    assert start >= 0
    bracket_index = text.find("[[", start)
    if bracket_index == -1:
        return None, 0, False
    if bracket_index > start and text[bracket_index - 1] == "!":
        return bracket_index - 1, 3, True
    return bracket_index, 2, False


def _is_valid_embed_note_id(note_id: str) -> bool:
    return _UUID_REFERENCE_ID_RE.fullmatch(note_id) is not None


def _render_reference_block(
    *,
    host_note_id: str,
    reference_note_id: str,
    occurrence_index: int,
    is_embed: bool,
    context: EmbedRenderContext,
    ancestry: Tuple[str, ...],
    static_export: bool,
    redact_credentials: bool,
    render_note_embeds_as_links: bool,
) -> str:
    mode = "link"
    if is_embed:
        mode = "embed"
    escaped_reference_note_id = html.escape(reference_note_id, quote=True)
    escaped_host_note_id = html.escape(host_note_id, quote=True)
    note_exists = context.has_note(reference_note_id)
    file_exists = context.has_file(reference_note_id)

    if note_exists and file_exists:
        raise RuntimeError(f"Reference UUID {reference_note_id} resolves to both a note and a file")

    display_note_embed_as_link = render_note_embeds_as_links and is_embed and note_exists
    display_as_embed = is_embed and not display_note_embed_as_link
    wrapper_classes = "note-reference-block"
    if display_as_embed:
        wrapper_classes = f"{wrapper_classes} note-reference-embed note-embed-block"
    else:
        wrapper_classes = f"{wrapper_classes} note-reference-link-mode"

    if note_exists:
        wrapper_classes = f"{wrapper_classes} note-reference-note"
        if display_as_embed:
            body_html = _render_embed_body(
                reference_note_id=reference_note_id,
                context=context,
                ancestry=ancestry,
                static_export=static_export,
                redact_credentials=redact_credentials,
            )
        else:
            body_html = _render_link_body(
                reference_note_id=reference_note_id,
                context=context,
                static_export=static_export,
                redact_credentials=redact_credentials,
                show_media=True,
            )
    elif file_exists:
        wrapper_classes = f"{wrapper_classes} note-reference-file"
        record = context.get_file(reference_note_id)
        thumbnail_kind = getattr(record, "thumbnail_kind")
        if not isinstance(thumbnail_kind, str) or thumbnail_kind == "":
            raise TypeError("file thumbnail_kind must be a non-empty string")
        if display_as_embed and thumbnail_kind == "image":
            wrapper_classes = f"{wrapper_classes} note-reference-file-image"
        if display_as_embed and thumbnail_kind == "excalidraw":
            wrapper_classes = f"{wrapper_classes} note-reference-file-excalidraw"
        if display_as_embed:
            body_html = _render_file_embed_body(
                record=record,
                reference_note_id=reference_note_id,
                static_export=static_export,
            )
        else:
            body_html = _render_file_link_body(
                record=record,
                reference_note_id=reference_note_id,
                static_export=static_export,
            )
    else:
        body_html = _render_missing_reference_body(reference_note_id)

    return (
        f'<div class="{wrapper_classes}" '
        f'data-ref-host-note-id="{escaped_host_note_id}" '
        f'data-ref-note-id="{escaped_reference_note_id}" '
        f'data-ref-occurrence="{occurrence_index}" '
        f'data-ref-mode="{mode}" '
        f'data-embed-ref-id="{escaped_reference_note_id}">'
        f'<div class="note-reference-content">{body_html}</div>'
        "</div>"
    )


def _render_embed_body(
    *,
    reference_note_id: str,
    context: EmbedRenderContext,
    ancestry: Tuple[str, ...],
    static_export: bool,
    redact_credentials: bool,
) -> str:
    escaped_note_id = html.escape(reference_note_id, quote=True)

    if reference_note_id in ancestry:
        embedded_content = (
            '<div class="note-reference-marker note-embed-cycle">'
            '<span class="note-embed-marker-icon" aria-hidden="true">&#8635;</span>'
            f'<span class="note-embed-marker-text">Circular reference: {escaped_note_id}</span>'
            "</div>"
        )
    else:
        embedded_content = _render_embedded_note_node(
            note_id=reference_note_id,
            context=context,
            ancestry=ancestry + (reference_note_id,),
            is_root=True,
            static_export=static_export,
            redact_credentials=redact_credentials,
        )
    if static_export:
        return embedded_content
    return (
        '<div class="note-embed-with-source">'
        f'<a href="#" class="note-reference-link note-source-arrow" data-ref-note-id="{escaped_note_id}" '
        'title="Go to reference source" aria-label="Go to reference source">'
        '<span aria-hidden="true">&#8599;</span></a>'
        f"{embedded_content}</div>"
    )


def _render_link_body(
    *,
    reference_note_id: str,
    context: EmbedRenderContext,
    static_export: bool,
    redact_credentials: bool,
    show_media: bool,
) -> str:
    escaped_note_id = html.escape(reference_note_id, quote=True)
    preview, redacted_credential = _resolve_note_reference_preview(
        reference_note_id=reference_note_id,
        context=context,
        redact_credentials=redact_credentials,
    )
    is_credential_preview = redacted_credential != ""
    preview_html = None
    title_classes = "note-reference-link-title"
    if show_media and not is_credential_preview:
        # A source that collapses to a thumbnail is referenced by the same thumbnail.
        thumbnail_html, caption = _render_link_preview_thumbnail(
            record=context.get_note(reference_note_id),
            context=context,
            static_export=static_export,
        )
        if thumbnail_html != "":
            title_classes = "note-reference-link-title note-reference-link-title-media"
            preview_html = thumbnail_html
            if caption != "":
                preview_html = f'{thumbnail_html}<span class="note-reference-link-caption">{html.escape(caption)}</span>'
    if preview_html is None and not is_credential_preview:
        record = context.get_note(reference_note_id)
        if has_scoped_footnotes(record.tags):
            # Format the entire source first: standalone scopes on later lines
            # can attach their markers to the source's opening line.
            formatted = format_note_content_for_view(
                content_html=record.content, tags=record.tags, redact_credentials=redact_credentials,
            )
            parser = _FootnoteReferencePreview()
            parser.feed(extract_collapsed_preview_source_html(formatted))
            parser.close()
            assert not parser.marker_open
            if parser.output:
                preview_html = "".join(parser.output).strip()
        if preview_html is None:
            preview_html = render_standalone_link_title_html(preview)
    if preview_html is None:
        preview_html = html.escape(preview)
    if static_export:
        if is_credential_preview:
            # Hidden, so nothing to copy.
            return (
                f'<span class="note-reference-link note-reference-link-static meta-credential-{redacted_credential}">'
                f'<span class="meta-credential-value" data-redacted="true">{preview_html}</span>'
                "</span>"
            )
        return (
            f'<span class="note-reference-link note-reference-link-static">'
            f"{preview_html}"
            "</span>"
        )
    return (
        f'<a href="#" class="note-reference-link" data-ref-note-id="{escaped_note_id}">'
        '<span class="note-reference-link-icon" aria-hidden="true" title="Link to reference source">&#8599;</span>'
        f'<span class="{title_classes}">{preview_html}</span>'
        "</a>"
    )


def _render_link_preview_thumbnail(
    *,
    record: object,
    context: EmbedRenderContext,
    static_export: bool,
) -> tuple[str, str]:
    """When the source's first visible line shows an image or diagram, its thumbnail and that line's text.

    Returns ("", "") when the first line has no thumbnail, so the link keeps its text preview.
    """
    content_html = getattr(record, "content")
    if not isinstance(content_html, str):
        raise TypeError("linked note content must be a string")
    fragment = extract_collapsed_preview_source_html(content_html)
    if fragment == "":
        return "", ""
    candidates: list[tuple[int, str]] = []
    for token in collect_reference_tokens_from_html(fragment):
        if not token.is_embed or not context.has_file(token.note_id):
            continue
        file_record = context.get_file(token.note_id)
        thumbnail_kind = getattr(file_record, "thumbnail_kind")
        if not isinstance(thumbnail_kind, str):
            raise TypeError("file thumbnail_kind must be a string")
        if thumbnail_kind not in _THUMBNAIL_FILE_KINDS:
            continue
        thumbnail = _render_file_link_thumbnail(
            record=file_record, file_id=token.note_id, thumbnail_kind=thumbnail_kind, static_export=static_export,
        )
        if thumbnail != "":
            candidates.append((token.start, thumbnail))
            break
    image_match = _INLINE_IMG_TAG_RE.search(fragment)
    if image_match is not None:
        thumbnail = _render_inline_image_link_thumbnail(tag_html=image_match.group(0), static_export=static_export)
        if thumbnail != "":
            candidates.append((image_match.start(), thumbnail))
    if not candidates:
        return "", ""
    first_thumbnail = min(candidates, key=lambda candidate: candidate[0])[1]
    return first_thumbnail, _strip_reference_tokens(strip_html(fragment))


def _render_file_link_thumbnail(*, record: object, file_id: str, thumbnail_kind: str, static_export: bool) -> str:
    kind_class = "note-reference-link-thumbnail-image"
    if thumbnail_kind == "excalidraw":
        kind_class = "note-reference-link-thumbnail-diagram"
    if static_export:
        export_data_url = getattr(record, "export_data_url")
        if not isinstance(export_data_url, str):
            raise TypeError("static export file must provide an export_data_url string")
        if export_data_url == "":
            return ""
        return (
            f'<span class="note-reference-link-thumbnail {kind_class}">'
            f'<img class="note-reference-link-thumbnail-static" src="{html.escape(export_data_url, quote=True)}" alt="" />'
            "</span>"
        )
    escaped_file_id = html.escape(file_id, quote=True)
    if thumbnail_kind == "excalidraw":
        content_revision = getattr(record, "content_revision")
        if not isinstance(content_revision, int) or content_revision < 1:
            raise TypeError("excalidraw file content_revision must be a positive int")
        images = "".join(
            f'<img class="note-file-excalidraw-preview note-file-excalidraw-preview-{variant}" '
            f'data-preview-variant="{variant}" alt="" decoding="async" draggable="false" hidden />'
            for variant in ("light", "dark")
        )
        # Hydrated by the diagram preview service; not editable from here.
        return (
            f'<span class="note-reference-link-thumbnail {kind_class} note-file-excalidraw-embed" '
            f'data-file-ref-id="{escaped_file_id}" data-file-revision="{content_revision}" data-preview-state="idle">'
            f'<span class="note-file-excalidraw-frame">{images}'
            '<span class="note-file-excalidraw-placeholder">Loading diagram...</span>'
            "</span></span>"
        )
    # Hydrated by the image file preview service.
    return (
        f'<span class="note-reference-link-thumbnail {kind_class} note-file-image-embed" '
        f'data-file-ref-id="{escaped_file_id}" data-preview-state="idle">'
        '<span class="note-file-image-preview-frame">'
        '<img class="note-file-image-preview" alt="" loading="lazy" decoding="async" draggable="false" hidden />'
        '<span class="note-file-image-preview-placeholder">Loading image...</span>'
        "</span></span>"
    )


def _render_inline_image_link_thumbnail(*, tag_html: str, static_export: bool) -> str:
    parser = _ImageSourceParser()
    parser.feed(tag_html)
    parser.close()
    source = parser.source
    if source is None or source.strip() == "":
        return ""
    image = f'<img class="note-reference-link-thumbnail-inline" src="{html.escape(source, quote=True)}" alt="" draggable="false" />'
    if not static_export:
        image = rewrite_remote_image_sources_for_proxy(content_html=image, registry=remote_image_proxy_registry)
    return f'<span class="note-reference-link-thumbnail note-reference-link-thumbnail-image">{image}</span>'


def _resolve_note_reference_preview(
    *,
    reference_note_id: str,
    context: EmbedRenderContext,
    redact_credentials: bool,
) -> tuple[str, str]:
    """The linked note's first line, and which credential it hides ('' for none):
    a password or username is shown as the mask when credentials are redacted."""
    record = context.get_note(reference_note_id)
    record_content = record.content
    record_tags = record.tags
    if not isinstance(record_content, str):
        raise TypeError("linked note content must be a string")
    if not isinstance(record_tags, str):
        raise TypeError("linked note tags must be a string")
    preview = _extract_first_line_preview(record_content)
    if preview == "":
        preview = "(empty note)"
    credential_tag = find_global_credential_tag(record_tags)
    if redact_credentials and credential_tag is not None:
        return CREDENTIAL_MASK, credential_tag
    return preview, ""


def get_note_reference_preview(
    *,
    reference_note_id: str,
    context: EmbedRenderContext,
    redact_credentials: bool,
) -> str:
    if not isinstance(reference_note_id, str) or reference_note_id == "":
        raise TypeError("reference_note_id must be a non-empty string")
    if not isinstance(redact_credentials, bool):
        raise TypeError("redact_credentials must be a bool")
    if not context.has_note(reference_note_id):
        raise KeyError(f"Cannot preview missing note reference {reference_note_id}")
    preview, _redacted_credential = _resolve_note_reference_preview(
        reference_note_id=reference_note_id,
        context=context,
        redact_credentials=redact_credentials,
    )
    return preview


def render_compact_note_reference_link(
    *,
    reference_note_id: str,
    context: EmbedRenderContext,
    redact_credentials: bool,
) -> str:
    if not isinstance(reference_note_id, str) or reference_note_id == "":
        raise TypeError("reference_note_id must be a non-empty string")
    if not isinstance(redact_credentials, bool):
        raise TypeError("redact_credentials must be a bool")
    if not context.has_note(reference_note_id):
        raise KeyError(f"Cannot render missing note reference {reference_note_id}")
    escaped_note_id = html.escape(reference_note_id, quote=True)
    # AI chat citations stay text-only chips.
    link_body = _render_link_body(
        reference_note_id=reference_note_id,
        context=context,
        static_export=False,
        redact_credentials=redact_credentials,
        show_media=False,
    )
    return (
        '<span class="ai-chat-note-reference note-reference-block '
        'note-reference-link-mode note-reference-note" '
        f'data-ref-note-id="{escaped_note_id}">'
        '<span class="note-reference-content">'
        f"{link_body}"
        "</span>"
        "</span>"
    )


def _render_missing_reference_body(reference_note_id: str) -> str:
    escaped_note_id = html.escape(reference_note_id, quote=True)
    return (
        '<div class="note-reference-marker note-embed-missing">'
        '<span class="note-embed-marker-icon" aria-hidden="true">&#9888;</span>'
        f'<span class="note-embed-marker-text">Missing reference: {escaped_note_id}</span>'
        "</div>"
    )


def _render_file_embed_body(
    *,
    record: object,
    reference_note_id: str,
    static_export: bool,
) -> str:
    return _render_file_body(
        record=record,
        reference_note_id=reference_note_id,
        is_embed=True,
        static_export=static_export,
    )


def _render_file_link_body(
    *,
    record: object,
    reference_note_id: str,
    static_export: bool,
) -> str:
    return _render_file_body(
        record=record,
        reference_note_id=reference_note_id,
        is_embed=False,
        static_export=static_export,
    )


def _render_file_body(
    *,
    record: object,
    reference_note_id: str,
    is_embed: bool,
    static_export: bool,
) -> str:
    title = getattr(record, "title")
    original_filename = getattr(record, "original_filename")
    mime_type = getattr(record, "mime_type")
    size_bytes = getattr(record, "size_bytes")
    thumbnail_kind = getattr(record, "thumbnail_kind")

    if not isinstance(title, str) or title == "":
        raise TypeError("file title must be a non-empty string")
    if not isinstance(original_filename, str) or original_filename == "":
        raise TypeError("file original_filename must be a non-empty string")
    if not isinstance(mime_type, str):
        raise TypeError("file mime_type must be a string")
    if not isinstance(size_bytes, int) or size_bytes < 0:
        raise TypeError("file size_bytes must be a non-negative int")
    if not isinstance(thumbnail_kind, str) or thumbnail_kind == "":
        raise TypeError("file thumbnail_kind must be a non-empty string")

    escaped_note_id = html.escape(reference_note_id, quote=True)
    escaped_title = html.escape(title)
    escaped_title_attribute = html.escape(title, quote=True)
    badge_text = html.escape(_format_file_badge(thumbnail_kind=thumbnail_kind, original_filename=original_filename))
    if static_export:
        return _render_static_file_body(
            record=record,
            escaped_title=escaped_title,
            escaped_title_attribute=escaped_title_attribute,
            badge_text=badge_text,
            is_embed=is_embed,
            thumbnail_kind=thumbnail_kind,
        )
    if is_embed and thumbnail_kind == "excalidraw":
        return _render_excalidraw_embed(
            record=record,
            escaped_note_id=escaped_note_id,
            escaped_title_attribute=escaped_title_attribute,
        )
    if is_embed and thumbnail_kind == "image":
        return (
            f'<div class="note-file-image-embed" data-file-ref-id="{escaped_note_id}" data-preview-state="idle">'
            '<div class="note-file-image-preview-frame">'
            f'<img class="note-file-image-preview" data-file-ref-id="{escaped_note_id}" alt="{escaped_title_attribute}" loading="lazy" decoding="async" hidden />'
            '<div class="note-file-image-preview-placeholder">Loading image preview...</div>'
            "</div>"
            f'<button type="button" class="note-file-image-download-link" data-file-ref-id="{escaped_note_id}" aria-label="Download image file">'
            "download image"
            "</button>"
            "</div>"
        )
    button_classes = "note-file-reference-link"
    if is_embed:
        button_classes = f"{button_classes} note-file-reference-link-embed"

    download_tooltip = html.escape(f"Click to download {original_filename}", quote=True)
    return (
        f'<button type="button" class="{button_classes}" data-file-ref-id="{escaped_note_id}" '
        f'title="{download_tooltip}">'
        f'<span class="note-file-reference-header">'
        f'<span class="note-file-reference-badge">{badge_text}</span>'
        f'<span class="note-file-reference-title">{escaped_title}</span>'
        "</span>"
        "</button>"
    )


def _render_excalidraw_embed(*, record: object, escaped_note_id: str, escaped_title_attribute: str) -> str:
    """An Excalidraw diagram in view mode: light and dark SVG previews, loaded by the browser."""
    content_revision = getattr(record, "content_revision")
    if not isinstance(content_revision, int) or content_revision < 1:
        raise TypeError("excalidraw file content_revision must be a positive int")
    images = "".join(
        f'<img class="note-file-excalidraw-preview note-file-excalidraw-preview-{variant}" '
        f'data-file-ref-id="{escaped_note_id}" data-file-kind="excalidraw" data-preview-variant="{variant}" '
        f'alt="{escaped_title_attribute}" decoding="async" draggable="false" hidden />'
        for variant in ("light", "dark")
    )
    return (
        f'<div class="note-file-excalidraw-embed" data-file-ref-id="{escaped_note_id}" '
        f'data-file-revision="{content_revision}" data-preview-state="idle" title="Double-click to edit the diagram">'
        '<div class="note-file-excalidraw-frame">'
        f"{images}"
        '<div class="note-file-excalidraw-placeholder">Loading diagram...</div>'
        "</div>"
        "</div>"
    )


def _render_static_file_body(
    *,
    record: object,
    escaped_title: str,
    escaped_title_attribute: str,
    badge_text: str,
    is_embed: bool,
    thumbnail_kind: str,
) -> str:
    if is_embed and thumbnail_kind == "image":
        export_data_url = getattr(record, "export_data_url")
        if not isinstance(export_data_url, str) or export_data_url == "":
            raise TypeError("static export image file must provide a non-empty export_data_url")
        escaped_data_url = html.escape(export_data_url, quote=True)
        return (
            '<div class="note-file-image-embed note-file-image-static" data-preview-state="loaded">'
            '<div class="note-file-image-preview-frame">'
            f'<img class="note-file-image-preview" src="{escaped_data_url}" alt="{escaped_title_attribute}" loading="lazy" decoding="async" />'
            "</div>"
            "</div>"
        )

    if is_embed and thumbnail_kind == "excalidraw":
        export_data_url = getattr(record, "export_data_url")
        if not isinstance(export_data_url, str):
            raise TypeError("static export excalidraw file must provide an export_data_url string")
        if export_data_url != "":
            escaped_data_url = html.escape(export_data_url, quote=True)
            return (
                '<div class="note-file-excalidraw-embed note-file-excalidraw-static" data-preview-state="loaded">'
                '<div class="note-file-excalidraw-frame">'
                f'<img class="note-file-excalidraw-preview" src="{escaped_data_url}" alt="{escaped_title_attribute}" decoding="async" />'
                "</div>"
                "</div>"
            )

    classes = "note-file-reference-link note-file-reference-link-static"
    if is_embed:
        classes = f"{classes} note-file-reference-link-embed"
    return (
        f'<div class="{classes}">'
        f'<span class="note-file-reference-header">'
        f'<span class="note-file-reference-badge">{badge_text}</span>'
        f'<span class="note-file-reference-title">{escaped_title}</span>'
        "</span>"
        "</div>"
    )


def _render_embedded_note_node(
    *,
    note_id: str,
    context: EmbedRenderContext,
    ancestry: Tuple[str, ...],
    is_root: bool,
    static_export: bool,
    redact_credentials: bool,
) -> str:
    record = context.get_note(note_id)
    record_content = record.content
    record_tags = record.tags
    if not isinstance(record_content, str):
        raise TypeError("embedded note content must be a string")
    if not isinstance(record_tags, str):
        raise TypeError("embedded note tags must be a string")

    annotated_content = record_content
    if not static_export:
        annotated_content = annotate_inline_image_occurrences(record_content)
    rendered_content = _replace_reference_tokens_in_html(
        host_note_id=note_id,
        content_html=annotated_content,
        tags=record_tags,
        context=context,
        ancestry=ancestry,
        static_export=static_export,
        redact_credentials=redact_credentials,
        render_note_embeds_as_links=False,
    )
    rendered_content = format_note_content_for_view(
        content_html=rendered_content,
        tags=record_tags,
        redact_credentials=redact_credentials,
    )

    escaped_note_id = html.escape(note_id, quote=True)
    classes = "note-embed-node"
    if is_root:
        classes = f"{classes} note-embed-root"
    children_html = ""
    child_ids = context.get_children(note_id)
    if child_ids:
        child_parts: List[str] = []
        for child_id in child_ids:
            child_parts.append(
                _render_embedded_note_node(
                    note_id=child_id,
                    context=context,
                    ancestry=ancestry + (child_id,),
                    is_root=False,
                    static_export=static_export,
                    redact_credentials=redact_credentials,
                )
            )
        children_html = f'<div class="note-embed-children">{"".join(child_parts)}</div>'

    return (
        f'<div class="{classes}" data-embed-note-id="{escaped_note_id}">'
        '<div class="note-embed-body">'
        f'<div class="note-embed-content">{rendered_content}</div>'
        f"{children_html}"
        "</div>"
        "</div>"
    )


def _extract_first_line_preview(content_html: str) -> str:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if content_html == "":
        return ""

    for segment in _FIRST_LINE_BOUNDARY_RE.split(content_html):
        preview = _strip_reference_tokens(strip_html(segment))
        if preview:
            return preview
    return _strip_reference_tokens(strip_html(content_html))


def _strip_reference_tokens(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    without_refs = _REFERENCE_TOKEN_RE.sub(_strip_reference_token_if_uuid, text)
    normalized = _WHITESPACE_RE.sub(" ", without_refs)
    return normalized.strip()


def _strip_reference_token_if_uuid(match: re.Match[str]) -> str:
    token = match.group(0)
    if token.startswith("![["):
        note_id = token[3:-2].strip()
    else:
        note_id = token[2:-2].strip()
    if _is_valid_embed_note_id(note_id):
        return " "
    return token


def _is_collapsed_preview_line_boundary_tag(tag_html: str) -> bool:
    if not isinstance(tag_html, str):
        raise TypeError("tag_html must be a string")
    tag_name = _extract_html_tag_name(tag_html)
    if tag_name == "br":
        return True
    closing_tag_name = _extract_html_closing_tag_name(tag_html)
    if closing_tag_name in _COLLAPSED_PREVIEW_BLOCK_TAGS:
        return True
    return False


def _is_collapsed_preview_block_opening_tag(tag_html: str) -> bool:
    if not isinstance(tag_html, str):
        raise TypeError("tag_html must be a string")
    if _extract_html_closing_tag_name(tag_html) != "":
        return False
    return _extract_html_tag_name(tag_html) in _COLLAPSED_PREVIEW_BLOCK_TAGS


def _fragment_has_collapsed_preview_content(fragment_parts: List[str]) -> bool:
    if not isinstance(fragment_parts, list):
        raise TypeError("fragment_parts must be a list")
    fragment_html = "".join(fragment_parts)
    if fragment_html == "":
        return False
    if _fragment_has_media_tag(fragment_html):
        return True

    text = strip_html(fragment_html)
    if _REFERENCE_TOKEN_RE.search(text):
        return True
    return _strip_reference_tokens(text) != ""


def _fragment_has_media_tag(fragment_html: str) -> bool:
    if not isinstance(fragment_html, str):
        raise TypeError("fragment_html must be a string")
    for tag_match in re.finditer(r"<[^>]+>", fragment_html):
        tag_name = _extract_html_tag_name(tag_match.group(0))
        if tag_name in _COLLAPSED_PREVIEW_MEDIA_TAGS:
            return True
    return False


def _extract_html_tag_name(tag_html: str) -> str:
    if not isinstance(tag_html, str):
        raise TypeError("tag_html must be a string")
    match = _HTML_TAG_NAME_RE.match(tag_html)
    if not match:
        return ""
    return match.group(1).lower()


def _extract_html_closing_tag_name(tag_html: str) -> str:
    if not isinstance(tag_html, str):
        raise TypeError("tag_html must be a string")
    match = _HTML_CLOSING_TAG_NAME_RE.match(tag_html)
    if not match:
        return ""
    return match.group(1).lower()


def _format_file_badge(*, thumbnail_kind: str, original_filename: str) -> str:
    """The pill label: a previewable text file's extension (.MD, .CSV, .JSON, .TXT), else its kind."""
    text_badge = text_file_badge(original_filename)
    if text_badge != "":
        return text_badge
    return _format_thumbnail_badge(thumbnail_kind)


def _format_thumbnail_badge(thumbnail_kind: str) -> str:
    if thumbnail_kind == "pdf":
        return "PDF"
    if thumbnail_kind == "image":
        return "IMG"
    if thumbnail_kind == "audio":
        return "AUD"
    if thumbnail_kind == "video":
        return "VID"
    if thumbnail_kind == "text":
        return "TXT"
    if thumbnail_kind == "archive":
        return "ZIP"
    if thumbnail_kind == "excalidraw":
        return "DRAW"
    return "FILE"


def _format_reference_token(*, note_id: str, mode: str) -> str:
    if mode == "embed":
        return f"![[{note_id}]]"
    if mode == "link":
        return f"[[{note_id}]]"
    raise ValueError("mode must be 'embed' or 'link'")


def _is_html_segment(value: str) -> bool:
    return value.startswith("<") and value.endswith(">")
