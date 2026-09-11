from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import Callable, FrozenSet, List, Optional, Tuple

from app.services.embedded_documents import document_store, render_document
from app.services.content_formatting import find_consumed_content_wrapper_keys
from app.services.content_formatting import find_global_credential_tag
from app.services.content_formatting import format_note_content_for_view
from app.services.content_formatting import has_scoped_footnotes
from app.services.content_formatting import render_standalone_link_title_html
from app.services.inline_image_occurrences import annotate_inline_image_occurrences
from app.services.remote_image_proxy import (
    remote_image_proxy_registry,
    rewrite_remote_image_sources_for_proxy,
)
from app.utils.text_utils import strip_html


_HTML_TOKEN_SPLIT_RE = re.compile(r"(<[^>]+>)")
_FIRST_LINE_BOUNDARY_RE = re.compile(
    r"(?i)<br\s*/?>|</(?:div|p|li|h[1-6]|pre|blockquote|ul|ol|table|tr|td|th|section|article|header|footer)>\s*|\n"
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


def render_note_content_with_embeds(
    *,
    note_id: str,
    content_html: str,
    tags: str,
    context: EmbedRenderContext,
    static_export: bool,
    redact_passwords: bool,
) -> str:
    return _render_note_content_with_embeds(
        note_id=note_id,
        content_html=content_html,
        tags=tags,
        context=context,
        static_export=static_export,
        redact_passwords=redact_passwords,
        render_note_embeds_as_links=False,
    )


def _render_note_content_with_embeds(
    *,
    note_id: str,
    content_html: str,
    tags: str,
    context: EmbedRenderContext,
    static_export: bool,
    redact_passwords: bool,
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
    if not isinstance(redact_passwords, bool):
        raise TypeError("redact_passwords must be a bool")
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
        redact_passwords=redact_passwords,
        render_note_embeds_as_links=render_note_embeds_as_links,
    )
    rendered_content = format_note_content_for_view(
        content_html=content_with_embeds,
        tags=tags,
        redact_passwords=redact_passwords,
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
    redact_passwords: bool,
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
        redact_passwords=redact_passwords,
        render_note_embeds_as_links=True,
    )


def _extract_collapsed_preview_meaningful_fragments(content_html: str) -> List[str]:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if content_html == "":
        return []

    fragments: List[str] = []
    fragment_parts: List[str] = []
    for part in _HTML_TOKEN_SPLIT_RE.split(content_html):
        if part == "":
            continue
        if _is_html_segment(part):
            fragment_parts.append(part)
            if _is_collapsed_preview_line_boundary_tag(part):
                if _fragment_has_collapsed_preview_content(fragment_parts):
                    fragments.append("".join(fragment_parts).strip())
                fragment_parts = []
            continue

        for text_part in _TEXT_LINE_SPLIT_RE.split(part):
            if text_part == "":
                continue
            if _TEXT_LINE_SPLIT_RE.fullmatch(text_part):
                if _fragment_has_collapsed_preview_content(fragment_parts):
                    fragments.append("".join(fragment_parts).strip())
                fragment_parts = []
                continue
            fragment_parts.append(text_part)

    if _fragment_has_collapsed_preview_content(fragment_parts):
        fragments.append("".join(fragment_parts).strip())
    return fragments


def extract_collapsed_preview_source_html(content_html: str) -> str:
    fragments = _extract_collapsed_preview_meaningful_fragments(content_html)
    if fragments:
        return fragments[0]
    return ""


def collapsed_preview_source_has_hidden_content(content_html: str) -> bool:
    fragments = _extract_collapsed_preview_meaningful_fragments(content_html)
    return len(fragments) > 1


def collapsed_preview_source_has_media(content_html: str) -> bool:
    preview_source_html = extract_collapsed_preview_source_html(content_html)
    if preview_source_html == "":
        return False
    if _fragment_has_media_tag(preview_source_html):
        return True
    # Editable documents store UUID tokens, but render as visual previews.
    return any(document_store.has(token.note_id)
               for token in collect_reference_tokens_from_html(preview_source_html))


def collapsed_preview_source_has_image_file_embed(
    *,
    content_html: str,
    context: EmbedRenderContext,
) -> bool:
    preview_source_html = extract_collapsed_preview_source_html(content_html)
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
        if thumbnail_kind == "image":
            return True
    return False


def collapsed_preview_source_has_note_embed(
    *,
    content_html: str,
    context: EmbedRenderContext,
) -> bool:
    preview_source_html = extract_collapsed_preview_source_html(content_html)
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
    redact_passwords: bool,
    render_note_embeds_as_links: bool,
) -> str:
    parts = _HTML_TOKEN_SPLIT_RE.split(content_html)
    output: List[str] = []
    occurrence_index = 0
    ignored_link_wrapper_keys = _ignored_link_wrapper_keys_for_tags(tags)
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
            ignored_link_wrapper_keys=ignored_link_wrapper_keys,
            static_export=static_export,
            redact_passwords=redact_passwords,
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
    ignored_link_wrapper_keys: FrozenSet[Tuple[str, int]],
    static_export: bool,
    redact_passwords: bool,
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

        ignored_wrapper_depth = _ignored_scoped_square_wrapper_depth_at(
            text=text,
            index=token_start,
            ignored_link_wrapper_keys=ignored_link_wrapper_keys,
            is_embed=is_embed,
        )
        if ignored_wrapper_depth > 0:
            output.append(text[index : token_start + ignored_wrapper_depth])
            index = token_start + ignored_wrapper_depth
            continue

        output.append(text[index:token_start])
        end = text.find("]]", token_start + token_open_length)
        if end == -1:
            output.append(text[token_start:])
            break

        raw_id = text[token_start + token_open_length : end]
        reference_note_id = raw_id.strip()

        if not _is_valid_embed_note_id(reference_note_id):
            output.append(text[token_start : end + 2])
            index = end + 2
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
                redact_passwords=redact_passwords,
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

    return tokens


def _find_next_reference_token_start(*, text: str, start: int) -> tuple[Optional[int], int, bool]:
    index = start
    while index < len(text):
        if text.startswith("![[", index):
            return index, 3, True
        if text.startswith("[[", index):
            return index, 2, False
        index += 1
    return None, 0, False


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
    redact_passwords: bool,
    render_note_embeds_as_links: bool,
) -> str:
    if document_store.has(reference_note_id):
        prefix = ""
        if is_embed:
            prefix = "!"
        return render_document(reference_note_id, token=prefix + "[[" + reference_note_id + "]]", static_export=static_export)
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
                redact_passwords=redact_passwords,
            )
        else:
            body_html = _render_link_body(
                reference_note_id=reference_note_id,
                context=context,
                static_export=static_export,
                redact_passwords=redact_passwords,
            )
    elif file_exists:
        wrapper_classes = f"{wrapper_classes} note-reference-file"
        record = context.get_file(reference_note_id)
        thumbnail_kind = getattr(record, "thumbnail_kind")
        if not isinstance(thumbnail_kind, str) or thumbnail_kind == "":
            raise TypeError("file thumbnail_kind must be a non-empty string")
        if display_as_embed and thumbnail_kind == "image":
            wrapper_classes = f"{wrapper_classes} note-reference-file-image"
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
    redact_passwords: bool,
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
            redact_passwords=redact_passwords,
        )
    if static_export:
        return embedded_content
    source_link = _render_link_body(
        reference_note_id=reference_note_id,
        context=context,
        static_export=False,
        redact_passwords=redact_passwords,
    )
    return (
        f"{embedded_content}"
        '<div class="note-embed-source-link">'
        f"{source_link}"
        "</div>"
    )


def _render_link_body(
    *,
    reference_note_id: str,
    context: EmbedRenderContext,
    static_export: bool,
    redact_passwords: bool,
) -> str:
    escaped_note_id = html.escape(reference_note_id, quote=True)
    preview, is_password_preview = _resolve_note_reference_preview(
        reference_note_id=reference_note_id,
        context=context,
        redact_passwords=redact_passwords,
    )
    preview_html = None
    if not is_password_preview:
        preview_html = render_standalone_link_title_html(preview)
    if preview_html is None:
        preview_html = html.escape(preview)
    if static_export:
        if is_password_preview:
            return (
                '<span class="note-reference-link note-reference-link-static meta-credential-password">'
                f'<span class="meta-credential-value">{preview_html}</span>'
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
        f'<span class="note-reference-link-title">{preview_html}</span>'
        "</a>"
    )


def _resolve_note_reference_preview(
    *,
    reference_note_id: str,
    context: EmbedRenderContext,
    redact_passwords: bool,
) -> tuple[str, bool]:
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
    is_password_preview = (
        redact_passwords
        and find_global_credential_tag(record_tags) == "password"
    )
    if is_password_preview:
        preview = "X" * len(preview)
    return preview, is_password_preview


def get_note_reference_preview(
    *,
    reference_note_id: str,
    context: EmbedRenderContext,
    redact_passwords: bool,
) -> str:
    if not isinstance(reference_note_id, str) or reference_note_id == "":
        raise TypeError("reference_note_id must be a non-empty string")
    if not isinstance(redact_passwords, bool):
        raise TypeError("redact_passwords must be a bool")
    if not context.has_note(reference_note_id):
        raise KeyError(f"Cannot preview missing note reference {reference_note_id}")
    preview, _is_password_preview = _resolve_note_reference_preview(
        reference_note_id=reference_note_id,
        context=context,
        redact_passwords=redact_passwords,
    )
    return preview


def render_compact_note_reference_link(
    *,
    reference_note_id: str,
    context: EmbedRenderContext,
    redact_passwords: bool,
) -> str:
    if not isinstance(reference_note_id, str) or reference_note_id == "":
        raise TypeError("reference_note_id must be a non-empty string")
    if not isinstance(redact_passwords, bool):
        raise TypeError("redact_passwords must be a bool")
    if not context.has_note(reference_note_id):
        raise KeyError(f"Cannot render missing note reference {reference_note_id}")
    escaped_note_id = html.escape(reference_note_id, quote=True)
    link_body = _render_link_body(
        reference_note_id=reference_note_id,
        context=context,
        static_export=False,
        redact_passwords=redact_passwords,
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
    badge_text = html.escape(_format_thumbnail_badge(thumbnail_kind))
    if static_export:
        return _render_static_file_body(
            record=record,
            escaped_title=escaped_title,
            escaped_title_attribute=escaped_title_attribute,
            badge_text=badge_text,
            is_embed=is_embed,
            thumbnail_kind=thumbnail_kind,
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

    return (
        f'<button type="button" class="{button_classes}" data-file-ref-id="{escaped_note_id}">'
        f'<span class="note-file-reference-header">'
        f'<span class="note-file-reference-badge">{badge_text}</span>'
        f'<span class="note-file-reference-title">{escaped_title}</span>'
        "</span>"
        "</button>"
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
    redact_passwords: bool,
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
        redact_passwords=redact_passwords,
        render_note_embeds_as_links=False,
    )
    rendered_content = format_note_content_for_view(
        content_html=rendered_content,
        tags=record_tags,
        redact_passwords=redact_passwords,
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
                    redact_passwords=redact_passwords,
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


def _ignored_link_wrapper_keys_for_tags(tags: str) -> FrozenSet[Tuple[str, int]]:
    consumed_wrapper_keys = find_consumed_content_wrapper_keys(tags)
    return frozenset(
        key
        for key in consumed_wrapper_keys
        if key[0] == "[" and key[1] >= 2
    )


def _ignored_scoped_square_wrapper_depth_at(
    *,
    text: str,
    index: int,
    ignored_link_wrapper_keys: FrozenSet[Tuple[str, int]],
    is_embed: bool,
) -> int:
    if is_embed:
        return 0
    for depth in sorted((key[1] for key in ignored_link_wrapper_keys), reverse=True):
        opener = "[" * depth
        if not text.startswith(opener, index):
            continue
        if index + depth < len(text) and text[index + depth] == "[":
            continue
        closer = "]" * depth
        if text.find(closer, index + depth) == -1:
            continue
        return depth
    return 0


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
    return "FILE"


def _format_reference_token(*, note_id: str, mode: str) -> str:
    if mode == "embed":
        return f"![[{note_id}]]"
    if mode == "link":
        return f"[[{note_id}]]"
    raise ValueError("mode must be 'embed' or 'link'")


def _is_html_segment(value: str) -> bool:
    return value.startswith("<") and value.endswith(">")
