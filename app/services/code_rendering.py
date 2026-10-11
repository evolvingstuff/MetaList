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
    highlighted = highlight(raw_text, get_lexer_by_name(language), _FORMATTER).rstrip("\n")
    return (
        f'<div class="meta-code"{copy_attr}>'
        f'<span class="meta-code-language">{escaped_language}</span>'
        f'<pre class="meta-code-pre"><code class="{code_class}">{highlighted}</code></pre>'
        "</div>"
    )


__all__ = ["CODE_TAG_PREFIX", "is_known_code_language", "parse_code_tag_language", "render_code_meta"]
