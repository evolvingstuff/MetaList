"""The @code=<language> renderer: source code with syntax highlighting.

One tag for every language (`@code=python`, `@code=javascript`, `@code=sql`),
highlighted on the server by Pygments, the standard Python highlighter. Token
spans carry `tok-` classes that main.css colours for the light and dark themes.
An unknown language shows the code plainly with a badge naming it.
"""
from __future__ import annotations

import html
import re
from typing import FrozenSet

from pygments import highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import get_all_lexers, get_lexer_by_name

from app.services.structured_note_renderers import _copyable_attr, _extract_plain_text


CODE_TAG_PREFIX = "code="
# Language names as written after @code= (c++, c#, objective-c, f#...).
CODE_LANGUAGE_RE = re.compile(r"[a-z0-9][a-z0-9+#._-]*")
# Every name and alias Pygments knows (python, py, js, javascript, c++...).
_KNOWN_LANGUAGES = frozenset(alias for _name, aliases, _patterns, _mimetypes in get_all_lexers() for alias in aliases)
_FORMATTER = HtmlFormatter(nowrap=True, classprefix="tok-")
# Fence names that mean "no language": a Markdown fence naming one stays plain.
_PLAIN_FENCE_LANGUAGES = frozenset({"text", "txt", "plain", "plaintext", "output", "console", "none", "nohighlight"})


def parse_code_tag_language(tag_name: str) -> str | None:
    """The language of a `code=<language>` tag name, or None for any other tag."""
    if not isinstance(tag_name, str) or tag_name == "":
        raise TypeError("tag_name must be a non-empty string")
    if not tag_name.startswith(CODE_TAG_PREFIX):
        return None
    language = tag_name[len(CODE_TAG_PREFIX):]
    if CODE_LANGUAGE_RE.fullmatch(language) is None:
        return None
    return language


def is_known_code_language(language: str) -> bool:
    if not isinstance(language, str):
        raise TypeError("language must be a string")
    return language in _KNOWN_LANGUAGES


def render_code_meta(*, content_html: str, language: str, formatting_tags: FrozenSet[str], extra_classes: str) -> str:
    if CODE_LANGUAGE_RE.fullmatch(language) is None:
        raise ValueError(f"Invalid code language name: {language!r}")
    raw_text = _extract_plain_text(content_html).strip("\n")
    copy_attr = _copyable_attr(formatting_tags, raw_text)
    code_class = "meta-code-code"
    if extra_classes:
        code_class = f"{code_class} {extra_classes}"
    escaped_language = html.escape(language, quote=True)
    if not is_known_code_language(language):
        return (
            f'<div class="meta-code meta-code-error"{copy_attr}>'
            f'<span class="meta-code-badge" title="@code= takes a language name such as python, javascript or sql">'
            f"Unknown language: {escaped_language}</span>"
            f'<pre class="meta-code-pre"><code class="{code_class}">{html.escape(raw_text, quote=False)}</code></pre>'
            "</div>"
        )
    return _highlighted_block(raw_text=raw_text, language=language, label=language, code_class=code_class, copy_attr=copy_attr)


def is_highlighted_fence_language(language: str) -> bool:
    """Whether a Markdown fence naming this language is highlighted (any case, aliases too)."""
    if not isinstance(language, str):
        raise TypeError("language must be a string")
    folded = language.casefold()
    return folded not in _PLAIN_FENCE_LANGUAGES and is_known_code_language(folded)


def render_fenced_code(*, code: str, language: str) -> str:
    """A Markdown fence's code, highlighted and labelled as @code=<language> renders it."""
    if not is_highlighted_fence_language(language):
        raise ValueError(f"Fence language is not highlighted: {language!r}")
    return _highlighted_block(
        raw_text=code, language=language.casefold(), label=language, code_class="meta-code-code", copy_attr="",
    )


def _highlighted_block(*, raw_text: str, language: str, label: str, code_class: str, copy_attr: str) -> str:
    highlighted = highlight(raw_text, get_lexer_by_name(language), _FORMATTER).rstrip("\n")
    return (
        f'<div class="meta-code"{copy_attr}>'
        f'<span class="meta-code-language">{html.escape(label, quote=True)}</span>'
        f'<pre class="meta-code-pre"><code class="{code_class}">{highlighted}</code></pre>'
        "</div>"
    )


__all__ = [
    "CODE_TAG_PREFIX", "is_highlighted_fence_language", "is_known_code_language", "parse_code_tag_language",
    "render_code_meta", "render_fenced_code",
]
