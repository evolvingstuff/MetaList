from __future__ import annotations

import pytest

from app.security.note_html import sanitize_note_html
from app.services.latex_rendering import render_latex_math_to_html


def test_plain_text_span_survives_storage_without_allowing_arbitrary_styles() -> None:
    content = '<h1>Before <span class="note-unformatted-text unwanted" style="font-size: 999px" onclick="bad()">plain</span> after</h1>'
    assert sanitize_note_html(content) == '<h1>Before <span class="note-unformatted-text">plain</span> after</h1>'


@pytest.mark.parametrize(
    ("malicious_html", "forbidden_fragments"),
    [
        ("<script>alert(1)</script><div>kept</div>", ("script", "alert(1)")),
        ("<img src=x onerror=alert(1)>", ("onerror",)),
        ('<a href="javascript:alert(1)">click</a>', ("javascript:", "href=")),
        ('<svg><a href="javascript:alert(1)">x</a></svg>', ("svg", "javascript:")),
        ('<div style="background-image:url(https://attacker.test/x); margin-left: 12px">x</div>', ("background-image", "attacker.test")),
        ('<img src="data:text/html;base64,PHNjcmlwdD4=">', ("data:text/html",)),
        ('<form><input autofocus onfocus=alert(1)></form>', ("form", "input", "onfocus")),
    ],
)
def test_sanitize_note_html_removes_executable_markup(
    malicious_html: str,
    forbidden_fragments: tuple[str, ...],
) -> None:
    sanitized = sanitize_note_html(malicious_html)

    for fragment in forbidden_fragments:
        assert fragment not in sanitized.casefold()


def test_sanitize_note_html_preserves_supported_note_formatting() -> None:
    content = (
        '<h2><strong>Heading</strong></h2>'
        '<div style="margin-left: 24px; text-indent: 0px">Indented</div>'
        '<ol start="3"><li>Three</li></ol>'
        '<table><tbody><tr><td colspan="2">Cell</td></tr></tbody></table>'
        '<a href="https://example.com/path?q=1" title="Example">Link</a>'
        '<img src="data:image/png;base64,AAAA" alt="Example" style="max-width: 100%; height: auto">'
    )

    sanitized = sanitize_note_html(content)

    assert "<h2><strong>Heading</strong></h2>" in sanitized
    assert 'style="margin-left:24px;text-indent:0px"' in sanitized
    assert '<ol start="3"><li>Three</li></ol>' in sanitized
    assert '<td colspan="2">Cell</td>' in sanitized
    assert 'href="https://example.com/path?q=1"' in sanitized
    assert 'src="data:image/png;base64,AAAA"' in sanitized
    assert 'style="max-width:100%;height:auto"' in sanitized


def test_sanitize_note_html_preserves_generated_ai_reference_markup() -> None:
    note_id = "75193dae-9e05-4a4e-94bf-417ffde18957"
    content = (
        '<div class="ai-chat-message-content meta-markdown" '
        'data-markdown-rendered="true">'
        '<p>Claim<sup class="ai-chat-citation-marker" aria-label="Reference 1">'
        '<a href="#" class="ai-chat-citation-link note-reference-link" '
        f'data-ref-note-id="{note_id}" data-ref-query="{note_id}">[1]</a>'
        '</sup></p>'
        '<section class="ai-chat-references" aria-label="References">'
        '<details class="ai-chat-references-disclosure">'
        '<summary class="ai-chat-references-heading">References</summary>'
        f'<ol><li data-ref-query="{note_id}">'
        '<span class="ai-chat-reference-number">[1]</span>'
        '<span class="ai-chat-note-reference note-reference-block '
        f'note-reference-link-mode note-reference-note" data-ref-note-id="{note_id}">'
        '<span class="note-reference-content">'
        '<a href="#" class="note-reference-link" '
        f'data-ref-note-id="{note_id}">'
        '<span class="note-reference-link-icon" aria-hidden="true" '
        'title="Link to reference source">&#8599;</span>'
        '<span class="note-reference-link-title">Source note</span>'
        '</a></span></span></li></ol>'
        '</details></section></div>'
    )

    sanitized = sanitize_note_html(content)

    assert 'class="ai-chat-message-content meta-markdown"' in sanitized
    assert 'data-markdown-rendered="true"' in sanitized
    assert 'class="ai-chat-citation-link note-reference-link"' in sanitized
    assert f'data-ref-query="{note_id}"' in sanitized
    assert '<section class="ai-chat-references" aria-label="References">' in sanitized
    assert '<details class="ai-chat-references-disclosure">' in sanitized
    assert '<summary class="ai-chat-references-heading">References</summary>' in sanitized
    assert 'class="ai-chat-note-reference note-reference-block note-reference-link-mode note-reference-note"' in sanitized


def test_sanitize_note_html_preserves_generated_ai_mathml() -> None:
    rendered_math = render_latex_math_to_html(
        r"P(H \mid E) = \frac{P(E \mid H)P(H)}{P(E)}",
        display="block",
    )
    assert rendered_math.has_error is False

    sanitized = sanitize_note_html(
        '<div class="ai-chat-message-content meta-markdown" '
        'data-markdown-rendered="true">'
        f"<p>Bayes: {rendered_math.html}</p>"
        "</div>"
    )

    assert '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' in sanitized
    assert "<mfrac>" in sanitized
    assert '<mo stretchy="false">(</mo>' in sanitized
    assert sanitized.count("<mi>P</mi>") == 4


def test_sanitize_note_html_rejects_executable_mathml_attributes() -> None:
    content = (
        '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block" '
        'href="javascript:alert(1)">'
        '<mstyle mathcolor="url(javascript:alert(2))">'
        '<mi onclick="alert(3)">x</mi>'
        '</mstyle></math>'
    )

    sanitized = sanitize_note_html(content)

    assert "<math" in sanitized
    assert "<mi>x</mi>" in sanitized
    assert "javascript:" not in sanitized
    assert "href=" not in sanitized
    assert "onclick=" not in sanitized
    assert "mathcolor=" not in sanitized


def test_sanitize_note_html_rejects_untrusted_classes_and_reference_attributes() -> None:
    content = (
        '<div class="trusted-looking ai-chat-message-content" '
        'data-markdown-rendered="false">Body</div>'
        '<a class="note-reference-link hostile" data-ref-note-id="not-a-uuid" '
        'data-ref-query="javascript:alert(1)" href="#">Link</a>'
    )

    sanitized = sanitize_note_html(content)

    assert 'class="ai-chat-message-content"' in sanitized
    assert "trusted-looking" not in sanitized
    assert "hostile" not in sanitized
    assert "data-markdown-rendered" not in sanitized
    assert "data-ref-note-id" not in sanitized
    assert "data-ref-query" not in sanitized


def test_sanitize_note_html_is_idempotent() -> None:
    content = '<div style="margin-left: 12px"><a href="https://example.com">safe</a></div>'
    once = sanitize_note_html(content)

    assert sanitize_note_html(once) == once


def test_sanitize_note_html_rejects_malformed_layout_attributes() -> None:
    content = '<img src="https://example.com/x.png" width="100%"><td colspan="-4">x</td>'

    sanitized = sanitize_note_html(content)

    assert "width=" not in sanitized
    assert "colspan=" not in sanitized


def test_sanitize_note_html_rejects_non_string_input() -> None:
    with pytest.raises(TypeError, match="content must be a string"):
        sanitize_note_html(None)  # type: ignore[arg-type]
