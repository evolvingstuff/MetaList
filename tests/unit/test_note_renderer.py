from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.presentation.render.note_renderer import highlight_search_terms
from app.presentation.render.note_renderer import render_collapsed_read_only_mode
from app.presentation.render.note_renderer import render_editing_mode
from app.presentation.render.note_renderer import render_read_only_mode


def test_search_highlighting_ignores_or_operator() -> None:
    rendered = highlight_search_terms(
        "<div>alpha or beta</div>",
        "alpha OR beta",
    )

    assert rendered == (
        '<div><span class="search-highlight">alpha</span> or '
        '<span class="search-highlight">beta</span></div>'
    )


def test_search_highlighting_keeps_lowercase_or_as_a_term() -> None:
    rendered = highlight_search_terms("<div>this or that</div>", "or")

    assert rendered == '<div>this <span class="search-highlight">or</span> that</div>'


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


def test_llm_note_editing_mode_preserves_completed_chat_html() -> None:
    completed_chat_html = (
        '<div class="ai-chat-message-content meta-markdown" '
        'data-markdown-rendered="true"><p>Body text</p></div>'
    )
    note = SimpleNamespace(content=completed_chat_html, tags="@llm")

    assert render_editing_mode(note) == completed_chat_html


def test_collapsed_llm_note_preserves_completed_chat_html_for_css_clamping() -> None:
    completed_chat_html = (
        '<div class="ai-chat-message-content meta-markdown" '
        'data-markdown-rendered="true"><h1>Result</h1><p>Body text</p></div>'
    )
    note = SimpleNamespace(content=completed_chat_html, tags="@llm")

    assert render_collapsed_read_only_mode(note) == completed_chat_html


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


def test_collapsed_footnote_note_renders_scopes_before_css_clamping():
    note = SimpleNamespace(content='<p>blah blah</p><p>{{reference}}</p>', tags='{{@footnote}}')
    rendered = render_collapsed_read_only_mode(note)
    assert '<p>blah blah<sup' in rendered
    assert 'data-footnote-number="1"' in rendered
