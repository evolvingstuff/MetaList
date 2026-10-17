from __future__ import annotations

import html
from typing import Set

from app.services.content_formatting import find_list_style
from app.services.embedded_references import EmbedRenderContext
from app.services.embedded_references import render_note_content_with_embeds
from app.services.file_registry import file_registry
from app.services.file_storage import get_file_reference_record
from app.services.note_store import store as note_store

# Content and children sit two levels deep (inside the article and its div),
# at two spaces per level.
_NESTED_BLOCK_INDENT_SPACES = 4


def build_note_fullscreen_markup(note_id: str) -> str:
    if not isinstance(note_id, str) or note_id == "":
        raise TypeError("note_id must be a non-empty string")

    file_record_cache: dict[str, object] = {}

    def _get_file_record(file_id: str) -> object:
        if file_id not in file_record_cache:
            file_record_cache[file_id] = get_file_reference_record(file_id, token=None)
        return file_record_cache[file_id]

    render_context = EmbedRenderContext(
        has_note=note_store.has_note,
        get_note=note_store.get_note,
        get_children=note_store.get_children,
        has_file=file_registry.has_file,
        get_file=_get_file_record,
        static_collapse_arrows=False,
    )
    return _render_fullscreen_note(
        note_id=note_id,
        render_context=render_context,
        visiting=set(),
    )


def _render_fullscreen_note(
    *,
    note_id: str,
    render_context: EmbedRenderContext,
    visiting: Set[str],
) -> str:
    if note_id in visiting:
        raise RuntimeError(f"Hierarchy cycle detected while rendering note {note_id}")
    visiting.add(note_id)

    record = note_store.get_note(note_id)
    if not isinstance(record.content, str):
        raise TypeError("note content must be a string")
    if not isinstance(record.tags, str):
        raise TypeError("note tags must be a string")

    rendered_content = render_note_content_with_embeds(
        note_id=note_id,
        content_html=record.content,
        tags=record.tags,
        context=render_context,
        static_export=False,
        redact_credentials=False,
    )

    classes = ["note"]
    list_style = find_list_style(record.tags)
    if list_style == "bulleted":
        classes.append("list-bulleted")
    elif list_style == "numbered":
        classes.append("list-numbered")

    lines = [
        f'<article class="{" ".join(classes)}">',
        '  <div class="note-content" contenteditable="false">',
        _indent_block(rendered_content, _NESTED_BLOCK_INDENT_SPACES),
        "  </div>",
        f'  <div class="note-tags" aria-hidden="true">{html.escape(record.tags)}</div>',
    ]

    child_parts = [
        _render_fullscreen_note(
            note_id=child_id,
            render_context=render_context,
            visiting=visiting,
        )
        for child_id in note_store.get_children(note_id)
    ]
    if child_parts:
        child_markup = "\n".join(child_parts)
        lines.extend(
            [
                '  <div class="note-children">',
                _indent_block(child_markup, _NESTED_BLOCK_INDENT_SPACES),
                "  </div>",
            ]
        )
    lines.append("</article>")
    visiting.remove(note_id)
    return "\n".join(lines)


def _indent_block(value: str, spaces: int) -> str:
    if not isinstance(value, str):
        raise TypeError("value must be a string")
    if not isinstance(spaces, int) or spaces < 0:
        raise TypeError("spaces must be a non-negative integer")
    prefix = " " * spaces
    return "\n".join(f"{prefix}{line}" for line in value.splitlines())
