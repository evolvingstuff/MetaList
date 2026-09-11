"""View-only reference chrome; no saved content or persistent caches."""

import html
import re

from app.services.embedded_references import EmbedRenderContext, collect_active_reference_tokens


_EMPTY_EDITOR_WRAPPER_RE = re.compile(
    r"</?(?:div|p|br|span|b|strong|i|em|u|s)\b[^>]*>", re.IGNORECASE
)


def decorate_note_references(
    *, note_id: str, content_html: str, tags: str, rendered_content: str,
    context: EmbedRenderContext, has_backlinks: bool,
) -> str:
    assert context.has_note(note_id)
    assert isinstance(has_backlinks, bool)
    classes = []
    tokens = collect_active_reference_tokens(content_html, tags)
    if len(tokens) == 1 and context.has_note(tokens[0].note_id):
        token = tokens[0]
        remaining = content_html[:token.start] + content_html[token.end:]
        if html.unescape(_EMPTY_EDITOR_WRAPPER_RE.sub("", remaining)).strip() == "":
            classes.append("note-reference-only")
    source_arrow = ""
    if has_backlinks:
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
