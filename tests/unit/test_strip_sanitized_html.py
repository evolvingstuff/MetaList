"""strip_sanitized_html gives exactly strip_html's text for the note sanitizer's output,
much faster: unlocking extracted every note's text with Python's HTML parser, about a
third of unlocking a 107,500-note namespace (2026-10-19)."""

from __future__ import annotations

import random

import pytest

from app.security.note_html import sanitize_note_html
from app.utils.text_utils import strip_html, strip_sanitized_html

_CORPUS_SEED = 11
_CORPUS_NOTES = 3000

_CASES = [
    "",
    "plain text",
    "<div>one</div><div>two</div>",
    "<p>para</p>text<br>after<br/>break",
    "<div title=\"a > b\">quoted &gt; inside</div>",
    "<div title='it&#39;s > here'>single quotes</div>",
    "<p>&amp; &lt;tag&gt; &quot;q&quot; &#8598; &#x2196; &nbsp;space&nbsp;&nbsp;x</p>",
    "<ul><li>one</li><li><b>two</b> <i>three</i></li></ul>",
    "<table><tr><td>a</td><td>b</td></tr></table>",
    "<h1>Head</h1><blockquote>quote</blockquote><pre>  keep\n  lines  </pre>",
    "<span>inline</span><span>joined</span>",
    "<a href=\"https://example.com/a?b=1&amp;c=2\">link</a> after",
    "<math><mi>x</mi><mo>=</mo><mn>2</mn></math>",
    "<details><summary>Sum</summary>Body</details>",
    "<div>   lots   of\n\n whitespace\t</div>",
    "<div><img src=\"data:image/png;base64,iVBORw0KGgo=\" alt=\"pic\">caption</div>",
    "<p>Trailing entity &amp</p>",
    "<div>a</div>\n<div>b</div>",
]


@pytest.mark.parametrize("raw_html", _CASES)
def test_hand_written_cases_match_strip_html(raw_html: str) -> None:
    sanitized = sanitize_note_html(raw_html)
    assert strip_sanitized_html(sanitized) == strip_html(sanitized)


def _random_note(generator: random.Random) -> str:
    words = ["alpha", "beta", "&amp;", "&lt;b&gt;", "x>y", "été", "&nbsp;", "a\"b", "it's", "  ", "\n"]
    blocks = ["div", "p", "li", "h2", "blockquote", "pre", "td"]
    inlines = ["b", "i", "span", "code", "u", "s", "mark"]
    parts = []
    for _ in range(generator.randint(1, 8)):
        text = " ".join(generator.choice(words) for _ in range(generator.randint(0, 6)))
        inline = generator.choice(inlines)
        title = generator.choice(["", ' title="t > u"', " title='q'"])
        inner = text
        if generator.random() < 0.5:
            inner = f"<{inline}{title}>{text}</{inline}>"
        if generator.random() < 0.2:
            inner += "<br>"
        block = generator.choice(blocks)
        parts.append(f"<{block}>{inner}</{block}>")
    return "".join(parts)


def test_a_generated_corpus_matches_strip_html() -> None:
    generator = random.Random(_CORPUS_SEED)
    for _ in range(_CORPUS_NOTES):
        sanitized = sanitize_note_html(_random_note(generator))
        assert strip_sanitized_html(sanitized) == strip_html(sanitized), sanitized


def test_it_refuses_markup_the_sanitizer_never_writes() -> None:
    # A comment or a script means the input did not come from the sanitizer.
    for unsanitized in ("<div>a<!-- hidden --></div>", "<script>x()</script>", "<style>p{}</style>"):
        with pytest.raises(ValueError):
            strip_sanitized_html(unsanitized)
