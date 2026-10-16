from __future__ import annotations

import base64
from datetime import datetime
from dataclasses import dataclass
from functools import lru_cache
import html
import re
from pathlib import Path

from app.services.content_formatting import find_list_style
from app.services.content_formatting import is_password_note
from app.services.content_formatting import is_username_note
from app.services.embedded_references import EmbedRenderContext
from app.services.embedded_references import collect_active_reference_tokens
from app.services.embedded_references import extract_collapsed_preview_source_html
from app.services.embedded_references import render_collapsed_note_content_with_embeds
from app.services.embedded_references import render_note_content_with_embeds
from app.services.embedded_references import resolve_held_source
from app.services.embedded_references import sole_reference_token
from app.services.markdown_rendering import strip_latex_source_attributes
from app.services.file_registry import file_registry
from app.services.file_storage import download_file, find_file_preview
from app.services.file_storage import get_file_reference_record
from app.services.note_store import store as note_store
from app.services.reference_presentation import decorate_note_references
from app.services.snapshot import is_content_collapsible
from app.services.snapshot import resolve_view_scope_membership
from app.services.content_formatting import extract_note_text_for_agent


_VALID_EXPORT_THEMES = frozenset({"dark", "light"})
_EXPORT_STYLE_OVERRIDES = """
/* The scrollbar's place is kept, as in MetaList: collapsing or expanding a
   note can stop or start the page scrolling, and the centred page must not
   move sideways when it does. */
html {
    scrollbar-gutter: stable;
}

body.html-export-body {
    max-width: 800px;
    /* Paper keeps the colours too (embed tints, code, tags): browsers drop
       backgrounds when printing unless the page asks to keep them. */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
}

.html-export-body #notes-container {
    margin-top: 0;
    /* Room for the collapse arrows, which sit left of their notes. */
    margin-left: 30px;
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

/* Collapsing (downloads): the first line rendered ahead replaces the text, and
   the children hide; expanded, the first line stays hidden. */
.html-export-body .note > .note-content-collapsed {
    display: none !important;
}

.html-export-body .note.collapsed > .note-content:not(.note-content-collapsed),
.html-export-body .note.collapsed > .note-children {
    display: none !important;
}

.html-export-body .note.collapsed > .note-content-collapsed {
    display: -webkit-box !important;
}

/* The notes in an embed fold the same way, each with its own arrow. */
.html-export-body .note-embed-body > .note-embed-content-collapsed {
    display: none !important;
}

.html-export-body .note-embed-collapsed > .note-embed-body > .note-embed-content:not(.note-embed-content-collapsed),
.html-export-body .note-embed-collapsed > .note-embed-body > .note-embed-children {
    display: none !important;
}

.html-export-body .note-embed-collapsed > .note-embed-body > .note-embed-content-collapsed {
    display: block !important;
}

/* Passwords an export or print includes are there to be read; hidden ones
   are not there to copy. */
.html-export-body .meta-credential-password .meta-credential-value:not([data-redacted]) {
    filter: none;
}

.html-export-body .meta-credential-value[data-redacted] {
    cursor: default;
    text-decoration: none;
}

.html-export-title {
    margin: 0 0 12px;
    font-size: 1.6rem;
    font-weight: 600;
}

/* Images and diagrams never split across pages (below). On paper the print sets its own margins, on every page: that leaves the
   browser no room for its header and footer (title, address, date, page
   number). The page's full width is used: no column, no room for arrows. */
@page {
    margin: 0;
}

@media print {
    html {
        scrollbar-gutter: auto;
    }

    body.html-export-body {
        max-width: none;
        margin: 0;
        padding: 15mm;
        -webkit-box-decoration-break: clone;
        box-decoration-break: clone;
    }

    .html-export-body #notes-container {
        margin-left: 0;
    }

    .html-export-body .note-collapse-toggle,
    .html-export-body .note-embed-collapse-toggle {
        display: none !important;
    }

    .html-export-body img,
    .html-export-body .note-file-image-embed,
    .html-export-body .note-file-excalidraw-embed {
        break-inside: avoid;
    }
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


EXPORT_PURPOSES = frozenset({"download", "print"})
# A download's arrow, by whether its note starts collapsed: aria-expanded and label.
_ARROW_STATES = {True: ("false", "Expand note"), False: ("true", "Collapse note")}
_DEFAULT_TITLE = "MetaList"
_MAX_TITLE_CHARACTERS = 120
_EMBED_TOKEN = re.compile(r"!?\[\[[^\]]+\]\]")

# Exported files (downloads) work like MetaList where a file can: they start
# collapsed and expanded as MetaList shows the notes, a click on a note's arrow
# (in an embed too) shows only its first line and hides its children, and a
# click on a username, an included password or a copyable value copies it.
# Printing shows everything and drops the arrows.
_EXPORT_SCRIPT = r"""
function flashCopied(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  setTimeout(function () { element.classList.remove(className); }, 700);
}

function copyText(text, element, className) {
  var copiedWithSelection = function () {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    var copied = document.execCommand('copy');
    area.remove();
    if (copied) {
      flashCopied(element, className);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { flashCopied(element, className); }, copiedWithSelection);
  } else {
    copiedWithSelection();
  }
}

// As MetaList copies: one line without its leading space, several lines
// without their shared indent.
function copyableText(element) {
  var text = element.hasAttribute('data-copy-value') ? element.getAttribute('data-copy-value') : element.textContent;
  text = text.replace(/ /g, ' ');
  if (text.indexOf('\n') === -1) {
    return text.replace(/^\s+/, '');
  }
  var lines = text.split('\n');
  var indents = lines.filter(function (line) { return line.trim() !== ''; })
    .map(function (line) { return line.match(/^[ \t]*/)[0].length; });
  if (indents.length === 0) {
    return text;
  }
  var indent = Math.min.apply(null, indents);
  return lines.map(function (line) { return line.slice(Math.min(indent, line.match(/^[ \t]*/)[0].length)); }).join('\n');
}

function showFolded(toggle, collapsed) {
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggle.setAttribute('aria-label', collapsed ? 'Expand note' : 'Collapse note');
}

document.addEventListener('click', function (event) {
  var toggle = event.target.closest('.note-collapse-toggle');
  if (toggle) {
    showFolded(toggle, toggle.parentElement.classList.toggle('collapsed'));
    return;
  }
  var embedToggle = event.target.closest('.note-embed-collapse-toggle');
  if (embedToggle) {
    showFolded(embedToggle, embedToggle.closest('.note-embed-node').classList.toggle('note-embed-collapsed'));
    return;
  }
  var credential = event.target.closest('.meta-credential-value');
  if (credential) {
    if (!credential.hasAttribute('data-redacted')) {
      copyText(credential.getAttribute('data-copy-value'), credential, 'meta-credential-copied');
    }
    return;
  }
  var copyable = event.target.closest('.meta-copyable');
  if (!copyable || !window.getSelection().isCollapsed || event.target.closest('a')) {
    return;
  }
  var text = copyableText(copyable);
  if (text !== '') {
    copyText(text, copyable, 'meta-copyable-copied');
  }
});
""".strip()


def build_notes_export_document(
    *,
    search: str | None,
    sort_mode: str,
    is_untagged_view: bool,
    theme: str,
    token: str,
    root_note_id: str | None,
    purpose: str,
    title: str,
    include_credentials: bool,
    editing_note_id: str | None,
) -> str:
    """A note with its children, or the view as it is shown (its search, sort order
    and kind), with the user's title as its heading and page title (blank: no
    heading, and "MetaList"). A download has collapse arrows and starts collapsed
    and expanded as MetaList shows it (the note being edited open, with its
    ancestors); a print has no arrows and shows every note expanded. Passwords
    and usernames show only when the user chose to include them."""
    if purpose not in EXPORT_PURPOSES:
        raise ValueError(f"Unknown export purpose: {purpose}")
    if not isinstance(title, str):
        raise TypeError("title must be a string")
    if search is not None and not isinstance(search, str):
        raise TypeError("search must be a string or null")
    if not isinstance(sort_mode, str) or not isinstance(is_untagged_view, bool):
        raise TypeError("sort_mode must be a string and is_untagged_view a bool")
    if not isinstance(include_credentials, bool):
        raise TypeError("include_credentials must be a bool")
    if not isinstance(theme, str):
        raise TypeError("theme must be a string")
    if not isinstance(token, str) or token == "":
        raise TypeError("token must be a non-empty string")
    if root_note_id is not None and (not isinstance(root_note_id, str) or root_note_id == ""):
        raise TypeError("root_note_id must be a non-empty string or null")
    if editing_note_id is not None and (not isinstance(editing_note_id, str) or editing_note_id == ""):
        raise TypeError("editing_note_id must be a non-empty string or null")

    normalized_theme = theme.strip().lower()
    if normalized_theme not in _VALID_EXPORT_THEMES:
        raise ValueError("theme must be 'light' or 'dark'")

    is_download = purpose == "download"
    root_ids, allowed_note_ids = resolve_export_scope(
        search=search, sort_mode=sort_mode, is_untagged_view=is_untagged_view, root_note_id=root_note_id,
    )
    notes_markup = _render_exported_notes_markup(
        root_ids=root_ids,
        allowed_note_ids=allowed_note_ids,
        token=token,
        collapsible=is_download,
        open_note_ids=_open_while_editing(editing_note_id),
        redact_credentials=not include_credentials,
    )
    stylesheet = _load_export_stylesheet()
    document_title = title.strip()
    if document_title == "":
        document_title = _DEFAULT_TITLE
    lines = [
        "<!DOCTYPE html>",
        f'<html lang="en" data-theme="{normalized_theme}">',
        "<head>",
        '  <meta charset="utf-8" />',
        '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
        f"  <title>{html.escape(document_title)}</title>",
        "  <style>",
        _indent_block(stylesheet, 4),
        "  </style>",
        "</head>",
        '<body class="html-export-body">',
    ]
    if _shows_heading(title=title, root_ids=root_ids):
        lines.append(f'  <h1 class="html-export-title">{html.escape(title.strip())}</h1>')
    lines.append('  <main id="notes-container">')
    if notes_markup != "":
        lines.append(_indent_block(notes_markup, 4))
    lines.append("  </main>")
    if is_download:
        lines.extend(["  <script>", _indent_block(_EXPORT_SCRIPT, 4), "  </script>"])
    lines.extend(["</body>", "</html>"])
    return "\n".join(lines)


def _first_line_title(note_id: str) -> str:
    """A note's first line as a title: as its collapsed preview shows it, or the
    rest when that line is only an embedded note or file; never a password ('')."""
    record = note_store.get_note(note_id)
    for content_html in (extract_collapsed_preview_source_html(record.content), record.content):
        text, redacted = extract_note_text_for_agent(content_html=content_html, tags=record.tags)
        if redacted:
            return ""
        words = " ".join(_EMBED_TOKEN.sub(" ", text.split("\n")[0]).split())
        if words != "":
            return words[:_MAX_TITLE_CHARACTERS]
    return ""


def _shows_heading(*, title: str, root_ids: list[str]) -> bool:
    """A title heads the page unless blank, or the first note says it already."""
    heading = " ".join(title.split())
    if heading == "":
        return False
    if not root_ids:
        return True
    return heading.casefold() != _first_line_title(root_ids[0]).casefold()


def default_export_title(*, search: str | None, is_untagged_view: bool, root_note_id: str | None) -> str:
    """What an export or print is called unless the user changes it: a note's first
    line as it shows (never a password), or MetaList with the view's search."""
    if root_note_id is not None:
        first_line = _first_line_title(root_note_id)
        if first_line == "":
            return _DEFAULT_TITLE
        return first_line
    if is_untagged_view:
        return f"{_DEFAULT_TITLE} — Untagged notes"
    if search is None or search.strip() == "" or _is_note_id_search(search):
        return _DEFAULT_TITLE
    return f"{_DEFAULT_TITLE} — {search.strip()}"[:_MAX_TITLE_CHARACTERS]


def _is_note_id_search(search: str) -> bool:
    # A references view searches for note IDs: no use as a title.
    return any(len(word) == 36 and word.count("-") == 4 for word in search.replace(":", " ").split())





# Characters a file name cannot hold on some system, and control characters.
_FILENAME_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]')
_MAX_FILENAME_CHARACTERS = 120


def build_notes_export_filename(title: str) -> str:
    """The export's file name: its title, or the time it was made for a blank title."""
    if not isinstance(title, str):
        raise TypeError("title must be a string")
    name = " ".join(_FILENAME_UNSAFE.sub("-", title).split())[:_MAX_FILENAME_CHARACTERS].strip(" .")
    if name == "":
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        return f"metalist-export-{timestamp}.html"
    return f"{name}.html"


def resolve_export_scope(
    *, search: str | None, sort_mode: str, is_untagged_view: bool, root_note_id: str | None,
) -> tuple[list[str], set[str] | None]:
    """The roots exported, in order, and the notes allowed under them (None: all)."""
    if root_note_id is not None:
        if not note_store.has_note(root_note_id):
            raise ValueError(f"Export root note not found: {root_note_id}")
        return [root_note_id], None
    # What the view shows: as /notes/view resolves it (search, sort order, Untagged).
    search_text = ""
    if search is not None:
        search_text = search
    scope = resolve_view_scope_membership(
        search=search_text, sort_mode=sort_mode, is_untagged_view=is_untagged_view,
    )
    if not scope.filter_active:
        return list(scope.ordered_root_ids), None
    allowed_note_ids = set(scope.allowed_note_ids)
    return [root for root in scope.ordered_root_ids if root in allowed_note_ids], allowed_note_ids


@dataclass(frozen=True, slots=True)
class CredentialCounts:
    passwords: int
    usernames: int


def exported_credential_counts(
    *, search: str | None, sort_mode: str, is_untagged_view: bool, root_note_id: str | None,
) -> CredentialCounts:
    """How many @password and @username notes an export or print would show: those
    exported, and those shown inside them (embedded notes with their children,
    and the notes references point to)."""
    root_ids, allowed_note_ids = resolve_export_scope(
        search=search, sort_mode=sort_mode, is_untagged_view=is_untagged_view, root_note_id=root_note_id,
    )
    passwords: set[str] = set()
    usernames: set[str] = set()
    # (note, whether the export's scope limits its children): an embedded note
    # shows all of its children.
    pending = [(root_id, True) for root_id in root_ids]
    visited: set[tuple[str, bool]] = set()
    while pending:
        visit = pending.pop()
        if visit in visited:
            continue
        visited.add(visit)
        note_id, in_scope = visit
        record = note_store.get_note(note_id)
        if is_password_note(record.tags):
            passwords.add(note_id)
        if is_username_note(record.tags):
            usernames.add(note_id)
        pending.extend(
            (child, in_scope) for child in note_store.get_children(note_id)
            if not in_scope or allowed_note_ids is None or child in allowed_note_ids
        )
        # A note that is only a reference embeds it (its subtree is shown); any
        # other reference is a link.
        embeds_reference = sole_reference_token(record.content) is not None
        for reference in collect_active_reference_tokens(record.content):
            if not note_store.has_note(reference.note_id):
                continue
            if embeds_reference:
                pending.append((reference.note_id, False))
                continue
            linked_tags = note_store.get_note(reference.note_id).tags
            if is_password_note(linked_tags):
                passwords.add(reference.note_id)
            if is_username_note(linked_tags):
                usernames.add(reference.note_id)
    return CredentialCounts(passwords=len(passwords), usernames=len(usernames))


def _open_while_editing(editing_note_id: str | None) -> frozenset[str]:
    """The notes MetaList shows open whatever their saved state: the note being
    edited and its ancestors."""
    if editing_note_id is None:
        return frozenset()
    open_ids = [editing_note_id]
    current = note_store.get_note(editing_note_id)
    while current.parent_id is not None:
        if current.parent_id in open_ids:
            raise RuntimeError("Cycle in editing note ancestry")
        open_ids.append(current.parent_id)
        current = note_store.get_note(current.parent_id)
    return frozenset(open_ids)


def _render_exported_notes_markup(
    *, root_ids: list[str], allowed_note_ids: set[str] | None, token: str, collapsible: bool,
    open_note_ids: frozenset[str], redact_credentials: bool,
) -> str:
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
            if thumbnail_kind == "excalidraw":
                # Exports show the light rendering; a diagram never rendered exports as a file card.
                preview = find_file_preview(file_id=file_id, variant="light", token=token)
                if preview is not None:
                    export_data_url = _build_file_data_url(
                        mime_type=preview.mime_type,
                        content_bytes=preview.content_bytes,
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
        static_collapse_arrows=collapsible,
    )

    parts: list[str] = []
    for root_id in root_ids:
        parts.append(
            _render_exported_note(
                note_id=root_id,
                allowed_note_ids=allowed_note_ids,
                embed_render_context=embed_render_context,
                collapsible=collapsible,
                open_note_ids=open_note_ids,
                redact_credentials=redact_credentials,
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


def _render_exported_note(*, note_id, allowed_note_ids, embed_render_context, collapsible, open_note_ids, redact_credentials):
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
        rendered[current] = _render_exported_note_node(note_id=current, allowed_note_ids=allowed_note_ids, embed_render_context=embed_render_context, children_html_parts=[rendered.pop(child) for child in children], collapsible=collapsible, open_note_ids=open_note_ids, redact_credentials=redact_credentials)
    return rendered[note_id]


def _render_exported_note_node(
    *,
    children_html_parts: list[str],
    note_id: str,
    allowed_note_ids: set[str] | None,
    embed_render_context: EmbedRenderContext,
    collapsible: bool,
    open_note_ids: frozenset[str],
    redact_credentials: bool,
) -> str:
    record = note_store.get_note(note_id)
    record_content = record.content
    record_tags = record.tags
    if not isinstance(record_content, str):
        raise TypeError("note content must be a string")
    if not isinstance(record_tags, str):
        raise TypeError("note tags must be a string")

    rendered_content = _as_drawn_in_metalist(note_id=note_id, record=record, context=embed_render_context, rendered_content=strip_latex_source_attributes(render_note_content_with_embeds(
        note_id=note_id,
        content_html=record_content,
        tags=record_tags,
        context=embed_render_context,
        static_export=True,
        redact_credentials=redact_credentials,
    )))

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
    # The same notes get an arrow as in MetaList: those with children, or with
    # more than a first line. The first line is rendered ahead for collapsing.
    can_collapse = collapsible and (
        bool(children_html_parts)
        or is_content_collapsible(content_html=record_content, context=embed_render_context)
    )
    if not can_collapse:
        lines = [
            f'<article class="{class_attr}" id="note-{escaped_note_id}">',
            '  <div class="note-content">',
            _indent_block(rendered_content, 4),
            "  </div>",
        ]
    else:
        collapsed_content = _as_drawn_in_metalist(note_id=note_id, record=record, context=embed_render_context, rendered_content=strip_latex_source_attributes(render_collapsed_note_content_with_embeds(
            note_id=note_id,
            content_html=record_content,
            tags=record_tags,
            context=embed_render_context,
            static_export=True,
            redact_credentials=redact_credentials,
        )))
        # It starts as MetaList shows it: a note that is only a reference folds as its source.
        shown_state_id = resolve_held_source(
            note_id, has_note=embed_render_context.has_note,
            content_of=lambda held_id: embed_render_context.get_note(held_id).content,
        )
        starts_collapsed = (
            note_id not in open_note_ids and bool(embed_render_context.get_note(shown_state_id).is_collapsed)
        )
        expanded_attr, toggle_label = _ARROW_STATES[starts_collapsed]
        if starts_collapsed:
            class_attr = f"{class_attr} collapsed"
        lines = [
            f'<article class="{class_attr}" id="note-{escaped_note_id}" data-can-collapse="true">',
            f'  <button type="button" class="note-collapse-toggle" aria-expanded="{expanded_attr}" aria-label="{toggle_label}"></button>',
            '  <div class="note-content">',
            _indent_block(rendered_content, 4),
            "  </div>",
            '  <div class="note-content note-content-collapsed">',
            _indent_block(collapsed_content, 4),
            "  </div>",
        ]
    if children_html != "":
        lines.append(_indent_block(children_html, 2))
    lines.append("</article>")
    return "\n".join(lines)


def _as_drawn_in_metalist(*, note_id: str, record, context: EmbedRenderContext, rendered_content: str) -> str:
    """A note's content with the wrapper MetaList's view gives it: a holder (a note
    that is only a reference) is tinted and its embed has no panel of its own.
    There is no backlinks button: a file has no backlinks view to open."""
    return decorate_note_references(
        note_id=note_id, content_html=record.content, tags=record.tags,
        rendered_content=rendered_content, context=context, has_backlinks=False,
    )


@lru_cache(maxsize=1)
def _load_export_stylesheet() -> str:
    css_path = Path(__file__).resolve().parent.parent / "static" / "css" / "main.css"
    if not css_path.is_file():
        raise FileNotFoundError(f"MetaList stylesheet missing at {css_path}")
    return css_path.read_text(encoding="utf-8") + "\n" + _EXPORT_STYLE_OVERRIDES
