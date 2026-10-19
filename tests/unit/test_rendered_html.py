"""The final sanitize pass over rendered HTML (app/security/rendered_html.py).

Two guarantees. Every renderer's markup passes through unchanged: one note per renderer
and formatting tag, each checked by conftest.py's lossless comparison. And whatever a
renderer (or the AI's Markdown) puts in, the page receives no script, event handler or
script-capable URL.
"""

from __future__ import annotations

import pytest

from app.security.rendered_html import sanitize_rendered_html
from app.services import ai_chat_rendering
from app.services.ai_chat_rendering import render_ai_chat_thinking_to_html
from app.services.content_formatting import format_note_content_for_view

_START_POSITION = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

# One note per renderer and formatting tag the view knows.
_RENDERED_NOTES = [
    ("<div># Heading</div><div>- item **bold** `code` [link](https://example.com)</div>"
     "<div>&gt; quote</div><div>| a | b |</div><div>|---|---|</div><div>| 1 | 2 |</div>"
     "<div>```python</div><div>x = 1</div><div>```</div>", "@markdown"),
    ("<div>$x^2 + \\frac{1}{2}$</div>", "@latex"),
    ('<div>{"name": "MetaList", "count": 2}</div>', "@json"),
    ("<div>a,b</div><div>1,2</div>", "@csv"),
    ("<div>ls -la</div>", "@shell"),
    (f"<p>{_START_POSITION}</p>", "@chess"),
    ("<div>@@ -1 +1 @@</div><div>-old</div><div>+new</div>", "@diff"),
    ("<div>graph TD; A--&gt;B</div>", "@mermaid"),
    ("<div>def area(radius):</div><div>    return 3.14 * radius ** 2</div>", "@code=python"),
    ("<div>alice</div>", "@username"),
    ("<div>hunter2</div>", "@password"),
    ("<div>alice@example.com</div>", "@email"),
    ("<div>Buy milk</div>", "@todo"),
    ("<div>Buy milk</div>", "@done"),
    ("<div>Body text{{https://example.com a footnote}}</div>", ""),
    ("<div>A link https://example.com/page</div>", ""),
    ("<div>some ((scoped)) text</div>", "((@red))"),
    ("<div>big text</div>", "@size=2"),
    ("<div>a ((box)) here</div>", "((@copyable))"),
    *[(f"<div>Formatted with {name}</div>", f"@{name}") for name in (
        "monospace", "heading", "red", "green", "blue", "grey", "highlighter", "bold", "italic",
        "strikethrough", "serif", "copyable",
    )],
]


@pytest.mark.parametrize(("content_html", "tags"), _RENDERED_NOTES)
@pytest.mark.parametrize("redact_credentials", [False, True])
def test_every_renderer_passes_through_unchanged(content_html, tags, redact_credentials):
    rendered = format_note_content_for_view(
        content_html=content_html, tags=tags, redact_credentials=redact_credentials,
    )
    # conftest.py fails this call if the pass removed any tag or attribute.
    sanitize_rendered_html(rendered)


def test_the_thinking_text_passes_through_unchanged():
    render_ai_chat_thinking_to_html("Looking at **two** notes:\n\n- one\n- `two`\n\n```js\nx()\n```")


_UNSAFE_MARKUP = [
    ('<img src="x" onerror="alert(1)">', "onerror"),
    ("<script>alert(1)</script>", "<script"),
    ('<a href="javascript:alert(1)">x</a>', "javascript:"),
    ('<button onclick="alert(1)" type="button">x</button>', "onclick"),
    ('<div data-ref-note-id="n" style="background:url(javascript:alert(1))">x</div>', "javascript:"),
    ('<svg><script>alert(1)</script></svg>', "<script"),
    ('<svg onload="alert(1)"><path d="M0 0"/></svg>', "onload"),
    ('<iframe src="https://example.com"></iframe>', "<iframe"),
    ('<a href="https://example.com" target="_top">x</a>', "_top"),
    ('<img src="x" data-remote-image-proxy-src="https://evil.example/">', "evil.example"),
    ('<form action="/x"><input name="q"></form>', "<input"),
]


@pytest.mark.parametrize(("markup", "removed"), _UNSAFE_MARKUP)
def test_unsafe_renderer_output_never_reaches_the_page(unchecked_rendered_html_pass, markup, removed):
    assert removed not in sanitize_rendered_html(f"<div>{markup}</div>")


def test_the_pass_keeps_text_when_it_drops_a_tag(unchecked_rendered_html_pass):
    assert sanitize_rendered_html('<div><iframe></iframe><span class="x">kept</span></div>') == "<div><span>kept</span></div>"


@pytest.mark.parametrize("unsafe_html", ['<img src=x onerror="alert(1)">', '<a href="javascript:alert(1)">x</a>'])
def test_a_chat_reply_cannot_carry_unsafe_markup_from_the_renderer(unchecked_rendered_html_pass, monkeypatch, unsafe_html):
    # Whatever the Markdown renderer returns, the chat reply is sanitized after it.
    monkeypatch.setattr(ai_chat_rendering, "render_markdown_to_html", lambda _markdown: unsafe_html)
    rendered = render_ai_chat_thinking_to_html("anything")
    assert "onerror" not in rendered and "javascript:" not in rendered


def test_the_pass_rejects_a_non_string():
    with pytest.raises(TypeError):
        sanitize_rendered_html(None)
