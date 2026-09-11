"""View-only reference chrome; no saved content or persistent caches."""

import html
import re

from app.services.embedded_references import EmbedRenderContext, collect_active_reference_tokens


_EMPTY_EDITOR_WRAPPER_RE = re.compile(
    r"</?(?:div|p|br|span|b|strong|i|em|u|s)\b[^>]*>", re.IGNORECASE
)


def collect_referenced_note_ids(context: EmbedRenderContext) -> set[str]:
    """One namespace pass per snapshot, including notes outside the visible search."""
    referenced_ids: set[str] = set()
    stack = list(context.get_children(None))
    while stack:
        note_id = stack.pop()
        record = context.get_note(note_id)
        for token in collect_active_reference_tokens(record.content, record.tags):
            if token.note_id != note_id and context.has_note(token.note_id):
                referenced_ids.add(token.note_id)
        stack.extend(context.get_children(note_id))
    return referenced_ids


def decorate_note_references(
    *, note_id: str, content_html: str, tags: str, rendered_content: str,
    context: EmbedRenderContext, referenced_note_ids: set[str],
) -> str:
    assert context.has_note(note_id)
    classes = []
    tokens = collect_active_reference_tokens(content_html, tags)
    if len(tokens) == 1 and context.has_note(tokens[0].note_id):
        token = tokens[0]
        remaining = content_html[:token.start] + content_html[token.end:]
        if html.unescape(_EMPTY_EDITOR_WRAPPER_RE.sub("", remaining)).strip() == "":
            classes.append("note-reference-only")
    source_arrow = ""
    if note_id in referenced_note_ids:
        classes.append("note-with-backlinks")
        source_arrow = (
            '<button type="button" class="note-backlinks-link note-source-arrow" '
            f'data-source-note-id="{html.escape(note_id, quote=True)}" '
            'title="Show backlinks — notes referencing this source" '
            'aria-label="Show backlinks — notes referencing this source">'
            '<span aria-hidden="true">&#8598;</span></button>'
        )
    if not classes:
        return rendered_content
    return f'<div class="{" ".join(classes)}">{source_arrow}{rendered_content}</div>'
