"""The @mermaid renderer: the note's text is one Mermaid diagram.

The same source markup a fenced ```mermaid block produces under @markdown, in
its own `meta-mermaid` block (styled in main.css); the browser draws it like a
fenced block (mermaid-render-service.js).
"""
from __future__ import annotations

import html
from typing import FrozenSet

from app.services.structured_note_renderers import _copyable_attr, _extract_plain_text


def render_mermaid_meta(*, content_html: str, formatting_tags: FrozenSet[str]) -> str:
    raw_text = _extract_plain_text(content_html).strip("\n")
    copy_attr = _copyable_attr(formatting_tags, raw_text)
    return (
        f'<div class="meta-mermaid"{copy_attr}>'
        '<pre class="meta-mermaid-source">'
        f'<code class="language-mermaid">{html.escape(raw_text, quote=False)}</code>'
        "</pre>"
        "</div>"
    )


__all__ = ["render_mermaid_meta"]
