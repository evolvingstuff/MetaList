from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.presentation.render.note_renderer import render_read_only_mode


def test_llm_note_preserves_completed_chat_html_exactly() -> None:
    completed_chat_html = (
        '<div class="ai-chat-message-content meta-markdown" '
        'data-markdown-rendered="true">'
        '<h1>Result</h1>'
        '<p>Supported claim'
        '<sup class="ai-chat-citation-marker" aria-label="Reference 1">'
        '<a href="#" class="ai-chat-citation-link note-reference-link" '
        'data-ref-note-id="75193dae-9e05-4a4e-94bf-417ffde18957" '
        'data-ref-query="75193dae-9e05-4a4e-94bf-417ffde18957">[1]</a>'
        '</sup>.</p>'
        '<details class="ai-chat-references-disclosure"></details>'
        '</div>'
    )
    note = SimpleNamespace(content=completed_chat_html, tags="@llm")

    assert render_read_only_mode(note) == completed_chat_html


def test_legacy_markdown_llm_note_remains_loadable() -> None:
    note = SimpleNamespace(
        content="<div># Prior copy</div><div></div><div>Body text</div>",
        tags="@markdown @llm",
    )

    assert render_read_only_mode(note) == (
        '<div class="ai-chat-message-content meta-markdown" '
        'data-markdown-rendered="true">'
        '<h1>Prior copy</h1><p>Body text</p>'
        '</div>'
    )


def test_llm_note_rejects_non_chat_html() -> None:
    note = SimpleNamespace(content="<div>Plain note</div>", tags="@llm")

    with pytest.raises(RuntimeError, match="@llm note is missing completed chat HTML"):
        render_read_only_mode(note)
