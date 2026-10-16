"""View-only reference chrome; no saved content or persistent caches."""

import html

from app.services.embedded_references import EmbedRenderContext, shows_note_embed


def decorate_note_references(
    *, note_id: str, content_html: str, tags: str, rendered_content: str,
    context: EmbedRenderContext, has_backlinks: bool,
) -> str:
    assert context.has_note(note_id)
    assert isinstance(has_backlinks, bool)
    classes = []
    if shows_note_embed(content_html=content_html, context=context):
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
