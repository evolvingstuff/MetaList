"""strip_sanitized_html_keeping_link_urls gives exactly strip_html_keeping_link_urls's
text for the note sanitizer's output, without Python's HTML parser: keeping link URLs
searchable read every linked note through it, 0.27 s of unlocking (2026-10-19)."""

from __future__ import annotations

import random

import pytest

from app.security.note_html import sanitize_note_html
from app.utils.text_utils import strip_html_keeping_link_urls, strip_sanitized_html_keeping_link_urls

_CORPUS_SEED = 13
_CORPUS_NOTES = 3000

_CASES = [
    '<div><a href="https://example.com/a">Video title</a></div>',
    '<div><a href="https://example.com/a">https://example.com/a</a></div>',
    '<div><a href="https://example.com/?a=1&amp;b=2">query &amp; more</a> after</div>',
    '<div><a href="mailto:me@example.com">mail me</a></div>',
    '<div><a href="HTTPS://Example.com/Up">shouting</a></div>',
    '<div><a href="  https://example.com/space  ">padded</a></div>',
    '<div><a href="https://example.com/b"><b>bold</b> <i>label</i></a></div>',
    '<div><a href="https://example.com/c">one</a><a href="https://example.com/d">two</a></div>',
    '<ul><li><a href="https://example.com/e">item</a></li><li>plain</li></ul>',
    '<div><a href="https://example.com/f" title="a > b">titled</a></div>',
    '<div><a>no href</a> and <a href="">empty</a></div>',
    '<div><a href="https://example.com/g"><div>block</div> label</a></div>',
    '<p>no link at all, only href as a word</p>',
    '<div>&lt;a href="https://fake.example"&gt;text&lt;/a&gt;</div>',
]


@pytest.mark.parametrize("raw_html", _CASES)
def test_hand_written_cases_match_the_parser(raw_html: str) -> None:
    sanitized = sanitize_note_html(raw_html)
    assert strip_sanitized_html_keeping_link_urls(sanitized) == strip_html_keeping_link_urls(sanitized)


def _random_note(generator: random.Random) -> str:
    words = ["alpha", "&amp;", "x>y", "été", "&nbsp;", "it's", "https://example.com/w", "  ", "\n"]
    hrefs = ["https://example.com/p?q=1&amp;r=2", "http://example.org", "mailto:a@b.c", "https://example.com/w", ""]
    parts = []
    for _ in range(generator.randint(1, 6)):
        text = " ".join(generator.choice(words) for _ in range(generator.randint(0, 5)))
        if generator.random() < 0.6:
            label = generator.choice([text, f"<b>{text}</b>", generator.choice(hrefs)])
            text = f'<a href="{generator.choice(hrefs)}">{label}</a> {text}'
        parts.append(f"<{generator.choice(['div', 'p', 'li', 'span'])}>{text}</div>")
    return "".join(parts)


def test_a_generated_corpus_matches_the_parser() -> None:
    generator = random.Random(_CORPUS_SEED)
    for _ in range(_CORPUS_NOTES):
        sanitized = sanitize_note_html(_random_note(generator))
        assert strip_sanitized_html_keeping_link_urls(sanitized) == strip_html_keeping_link_urls(sanitized), sanitized


def test_it_refuses_markup_the_sanitizer_never_writes() -> None:
    with pytest.raises(ValueError):
        strip_sanitized_html_keeping_link_urls('<div><a href="https://x.example">a</a><!-- hidden --></div>')
