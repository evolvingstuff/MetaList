from __future__ import annotations

import base64
from datetime import datetime
from dataclasses import dataclass
from functools import lru_cache
import html
from pathlib import Path

from app.services.content_formatting import find_list_style
from app.services.embedded_references import EmbedRenderContext
from app.services.embedded_references import render_note_content_with_embeds
from app.services.file_registry import file_registry
from app.services.file_storage import download_file
from app.services.file_storage import get_file_reference_record
from app.services.note_store import store as note_store
from app.services.snapshot import resolve_search_scope


_VALID_EXPORT_THEMES = frozenset({"dark", "light"})
_EXPORT_STYLE_OVERRIDES = """
html {
    scrollbar-gutter: auto;
}

body.html-export-body {
    max-width: 800px;
}

.html-export-body #notes-container {
    margin-top: 0;
}

.html-export-body .note {
    transition: none;
}

.html-export-body .note:not(.editing):not(.locked):hover:not(:has(.note:hover)) {
    border-color: #e6e6e6;
}

html[data-theme="dark"] .html-export-body .note:not(.editing):not(.locked):hover:not(:has(.note:hover)) {
    border-color: #2a2a2a;
}

.html-export-body .note-content,
.html-export-body .note-content * {
    -webkit-user-select: text !important;
    user-select: text !important;
}

.html-export-body .note-collapse-toggle,
.html-export-body .note-tags,
.html-export-body .lock-icon,
.html-export-body .drag-handle {
    display: none !important;
}

.html-export-body .note-file-reference-link-static,
.html-export-body .note-file-image-static {
    cursor: default;
}

.html-export-body .note-file-reference-link-static .note-file-reference-title {
    text-decoration: none;
}
"""


@dataclass(frozen=True, slots=True)
class _ExportFileRecord:
    id: str
    title: str
    original_filename: str
    mime_type: str
    size_bytes: int
    thumbnail_kind: str
    export_data_url: str


def _indent_block(text: str, spaces: int) -> str:
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text)}")
    if not isinstance(spaces, int):
        raise TypeError(f"spaces must be an int, got {type(spaces)}")
    if spaces < 0:
        raise ValueError("spaces must be >= 0")
    if text == "":
        return ""

    prefix = " " * spaces
    return "\n".join(f"{prefix}{line}" if line else "" for line in text.splitlines())


def build_notes_export_document(
    *,
    search: str | None,
    theme: str,
    token: str,
    root_note_id: str | None,
) -> str:
    if search is not None and not isinstance(search, str):
        raise TypeError("search must be a string or null")
    if not isinstance(theme, str):
        raise TypeError("theme must be a string")
    if not isinstance(token, str) or token == "":
        raise TypeError("token must be a non-empty string")
    if root_note_id is not None and (not isinstance(root_note_id, str) or root_note_id == ""):
        raise TypeError("root_note_id must be a non-empty string or null")

    normalized_theme = theme.strip().lower()
    if normalized_theme not in _VALID_EXPORT_THEMES:
        raise ValueError("theme must be 'light' or 'dark'")

    notes_markup = _render_exported_notes_markup(
        search=search,
        token=token,
        root_note_id=root_note_id,
    )
    stylesheet = _load_export_stylesheet()
    lines = [
        "<!DOCTYPE html>",
        f'<html lang="en" data-theme="{normalized_theme}">',
        "<head>",
        '  <meta charset="utf-8" />',
        '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
        "  <title>MetaList Export</title>",
        "  <style>",
        _indent_block(stylesheet, 4),
        "  </style>",
        "</head>",
        '<body class="html-export-body">',
        '  <main id="notes-container">',
    ]
    if notes_markup != "":
        lines.append(_indent_block(notes_markup, 4))
    lines.extend([
        "  </main>",
        "</body>",
        "</html>",
    ])
    return "\n".join(lines)


def build_notes_export_filename() -> str:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return f"metalist-export-{timestamp}.html"


def _render_exported_notes_markup(*, search: str | None, token: str, root_note_id: str | None) -> str:
    normalized_search = search
    if normalized_search == "":
        normalized_search = None

    if root_note_id is not None:
        if not note_store.has_note(root_note_id):
            raise ValueError(f"Export root note not found: {root_note_id}")
        allowed_note_ids = None
        root_ids = [root_note_id]
    else:
        search_scope = resolve_search_scope(
            search=normalized_search,
            editing_note_id=None,
            sort_mode="normal",
            ordered_root_ids=None,
        )
        allowed_note_ids = search_scope.allowed_note_ids

        if search_scope.search_active:
            if search_scope.search_root_ids_ordered is None:
                root_ids = []
            else:
                root_ids = list(search_scope.search_root_ids_ordered)
        else:
            root_ids = note_store.get_children(None)

    if not isinstance(token, str) or token == "":
        raise TypeError("token must be a non-empty string")

    file_record_cache: dict[str, object] = {}

    def _get_file_record(file_id: str) -> object:
        if file_id not in file_record_cache:
            record = get_file_reference_record(file_id, token=token)
            thumbnail_kind = record.thumbnail_kind
            if not isinstance(thumbnail_kind, str) or thumbnail_kind == "":
                raise TypeError("file thumbnail_kind must be a non-empty string")

            export_data_url = ""
            if thumbnail_kind == "image":
                downloaded = download_file(file_id, token)
                export_data_url = _build_file_data_url(
                    mime_type=downloaded.record.mime_type,
                    content_bytes=downloaded.content_bytes,
                )

            file_record_cache[file_id] = _ExportFileRecord(
                id=record.id,
                title=record.title,
                original_filename=record.original_filename,
                mime_type=record.mime_type,
                size_bytes=record.size_bytes,
                thumbnail_kind=thumbnail_kind,
                export_data_url=export_data_url,
            )
        return file_record_cache[file_id]

    embed_render_context = EmbedRenderContext(
        has_note=note_store.has_note,
        get_note=note_store.get_note,
        get_children=note_store.get_children,
        has_file=file_registry.has_file,
        get_file=_get_file_record,
    )

    parts: list[str] = []
    for root_id in root_ids:
        if allowed_note_ids is not None and root_id not in allowed_note_ids:
            continue
        parts.append(
            _render_exported_note(
                note_id=root_id,
                allowed_note_ids=allowed_note_ids,
                embed_render_context=embed_render_context,
            )
        )
    return "\n".join(parts)


def _build_file_data_url(*, mime_type: str, content_bytes: bytes) -> str:
    if not isinstance(mime_type, str) or mime_type == "":
        raise TypeError("mime_type must be a non-empty string")
    if not isinstance(content_bytes, bytes):
        raise TypeError(f"content_bytes must be bytes, got {type(content_bytes)}")

    encoded = base64.b64encode(content_bytes).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _render_exported_note(*, note_id, allowed_note_ids, embed_render_context):
    pending = [(note_id, False)]
    visiting = set()
    rendered = {}
    while pending:
        current, finishing = pending.pop()
        children = [child for child in note_store.get_children(current) if allowed_note_ids is None or child in allowed_note_ids]
        if not finishing:
            if current in visiting:
                raise RuntimeError('Cycle in exported hierarchy')
            visiting.add(current)
            pending.append((current, True))
            pending.extend((child, False) for child in reversed(children))
            continue
        visiting.remove(current)
        rendered[current] = _render_exported_note_node(note_id=current, allowed_note_ids=allowed_note_ids, embed_render_context=embed_render_context, children_html_parts=[rendered.pop(child) for child in children])
    return rendered[note_id]


def _render_exported_note_node(
    *,
    children_html_parts: list[str],
    note_id: str,
    allowed_note_ids: set[str] | None,
    embed_render_context: EmbedRenderContext,
) -> str:
    record = note_store.get_note(note_id)
    record_content = record.content
    record_tags = record.tags
    if not isinstance(record_content, str):
        raise TypeError("note content must be a string")
    if not isinstance(record_tags, str):
        raise TypeError("note tags must be a string")

    rendered_content = render_note_content_with_embeds(
        note_id=note_id,
        content_html=record_content,
        tags=record_tags,
        context=embed_render_context,
        static_export=True,
        redact_passwords=True,
    )

    classes = ["note"]
    list_style = find_list_style(record_tags)
    if list_style == "bulleted":
        classes.append("list-bulleted")
    elif list_style == "numbered":
        classes.append("list-numbered")

    children_html = ""
    if children_html_parts:
        children_markup = "\n".join(children_html_parts)
        children_html = (
            "<div class=\"note-children\">\n"
            f"{_indent_block(children_markup, 2)}\n"
            "</div>"
        )

    escaped_note_id = html.escape(note_id, quote=True)
    class_attr = " ".join(classes)
    lines = [
        f'<article class="{class_attr}" id="note-{escaped_note_id}">',
        '  <div class="note-content">',
        _indent_block(rendered_content, 4),
        "  </div>",
    ]
    if children_html != "":
        lines.append(_indent_block(children_html, 2))
    lines.append("</article>")
    return "\n".join(lines)


@lru_cache(maxsize=1)
def _load_export_stylesheet() -> str:
    css_path = Path(__file__).resolve().parent.parent / "static" / "css" / "main.css"
    if not css_path.is_file():
        raise FileNotFoundError(f"MetaList stylesheet missing at {css_path}")
    return css_path.read_text(encoding="utf-8") + "\n" + _EXPORT_STYLE_OVERRIDES
