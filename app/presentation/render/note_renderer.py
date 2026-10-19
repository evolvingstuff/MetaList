"""How a note reads when MetaList copies it to the clipboard (app/models/utils.py).

The page's own views are rendered by app/services/snapshot.py; this is the plain
read-only rendering of one note's content and tags.
"""

import re

from app.services.content_formatting import format_note_content_for_view
from app.services.content_formatting import extract_plain_text_from_note_html
from app.services.content_formatting import note_tags_include
from app.services.ai_chat_rendering import find_note_citation_ids
from app.services.ai_chat_rendering import render_ai_chat_markdown_to_html
from app.services.note_store import store as note_store


def _format_note_content_standard(*, content_html: str, tags: str) -> str:
    if note_tags_include(tags, "@llm"):
        if note_tags_include(tags, "@markdown"):
            markdown_text = extract_plain_text_from_note_html(content_html)
            if markdown_text == "":
                return ""
            allowed_note_ids = find_note_citation_ids(
                markdown_text,
                notes=note_store,
            )
            rendered_content = render_ai_chat_markdown_to_html(
                markdown_text,
                notes=note_store,
                allowed_note_ids=allowed_note_ids,
                allowed_web_evidence=(),
            )
            return (
                '<div class="ai-chat-message-content meta-markdown" '
                'data-markdown-rendered="true">'
                f"{rendered_content}</div>"
            )
        if 'class="ai-chat-message-content meta-markdown"' not in content_html:
            raise RuntimeError("@llm note is missing completed chat HTML")
        return content_html
    return format_note_content_for_view(
        content_html=content_html,
        tags=tags,
        redact_credentials=False,
    )


def strip_comments_from_html(html_content: str) -> str:
    """
    Remove comment patterns like /* text */ from HTML content while preserving HTML structure.
    Also removes empty divs that might be left behind.
    """
    if not html_content:
        return html_content
    
    # Remove /* comment */ patterns (including any whitespace around them)
    content = re.sub(r'/\*[^*]*\*/', '', html_content)
    
    # Remove empty divs that might be left behind
    content = re.sub(r'<div>\s*</div>', '', content)
    
    # Clean up extra whitespace
    content = re.sub(r'\s+', ' ', content).strip()
    
    return content


def render_read_only_mode(note) -> str:
    tags = note.tags
    if not isinstance(tags, str):
        raise TypeError(f"Note tags must be a string, got {type(tags)}")
    content = note.content
    if not note_tags_include(tags, "@llm"):
        content = strip_comments_from_html(content)
    return _format_note_content_standard(content_html=content, tags=tags)
