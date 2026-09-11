"""View-only footnote collection after the ordinary scoped-style pass."""

import hashlib
import html
import re
from html.parser import HTMLParser
from typing import Callable

from app.services.footnote_layout import relocate_standalone_footnotes
from app.services.markdown_rendering import render_markdown_to_html


_INLINE_FORMATTING_TAG = re.compile(
    r"</?(?:a|b|strong|i|em|u|s|strike|del|ins|span|small|sub|sup|code|mark)\b[^>]*>",
    re.IGNORECASE,
)


def _trim_spaces_before_marker(parts: list[str]) -> None:
    """Remove horizontal editor spacing, stopping at text or a line boundary."""
    for index in range(len(parts) - 1, -1, -1):
        part = parts[index]
        if _INLINE_FORMATTING_TAG.fullmatch(part):
            continue
        if html.unescape(part).strip(" \t\u00a0") == "":
            parts[index] = ""
            continue
        parts[index] = part.rstrip(" \t\u00a0")
        break


class _FootnoteCollector(HTMLParser):
    def __init__(self, content_html: str):
        super().__init__(convert_charrefs=False)
        self.output: list[str] = []
        self.bodies: dict[str, list[str]] = {}
        self.tokens: dict[str, str] = {}
        self.continuations: set[str] = set()
        self.active_scope = ""
        self.span_depth = 0
        self.prefix = "MLFOOTNOTE" + hashlib.sha256(content_html.encode()).hexdigest()

    def _append(self, value: str) -> None:
        if self.active_scope:
            self.bodies[self.active_scope].append(value)
        else:
            self.output.append(value)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "span" and not self.active_scope and "data-footnote-scope" in attributes:
            scope = attributes["data-footnote-scope"]
            assert isinstance(scope, str) and scope
            if scope not in self.bodies:
                self.bodies[scope] = []
                self.tokens[scope] = f"{self.prefix}N{len(self.bodies)}END"
                _trim_spaces_before_marker(self.output)
                self.output.append(self.tokens[scope])
            else:
                self.bodies[scope].append("<br>")
                continuation = f"{self.prefix}CONT{scope}END"
                self.continuations.add(continuation)
                self.output.append(continuation)
            self.active_scope = scope
            self.span_depth = 1
            classes = attributes["class"].replace("meta-footnote", "").strip()
            style = ""
            if "style" in attributes:
                style = attributes["style"]
                assert isinstance(style, str)
            self._append(f'<span class="{html.escape(classes, quote=True)}" style="{html.escape(style, quote=True)}">')
            return
        if self.active_scope and tag == "span":
            self.span_depth += 1
        self._append(self.get_starttag_text())

    def handle_endtag(self, tag: str) -> None:
        self._append(f"</{tag}>")
        if self.active_scope and tag == "span":
            self.span_depth -= 1
            assert self.span_depth >= 0
            if self.span_depth == 0:
                self.active_scope = ""

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._append(self.get_starttag_text())

    def handle_data(self, data: str) -> None:
        self._append(data)

    def handle_entityref(self, name: str) -> None:
        self._append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        self._append(f"&#{name};")

    def handle_comment(self, data: str) -> None:
        self._append(f"<!--{data}-->")


class _FootnoteMarkdown(HTMLParser):
    """Render Markdown text while retaining existing editor links and rich HTML."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.output: list[str] = []
        self.literal_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"a", "pre", "code", "math"}:
            self.literal_depth += 1
        self.output.append(self.get_starttag_text())

    def handle_endtag(self, tag: str) -> None:
        if tag in {"a", "pre", "code", "math"}:
            self.literal_depth -= 1
            assert self.literal_depth >= 0
        self.output.append(f"</{tag}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.output.append(self.get_starttag_text())

    def handle_data(self, data: str) -> None:
        if self.literal_depth:
            self.output.append(html.escape(data, quote=False))
            return
        rendered = render_markdown_to_html(data)
        if rendered.startswith("<p>") and rendered.endswith("</p>"):
            rendered = rendered[3:-4].replace("</p><p>", "<br><br>")
        self.output.append(rendered)


def collect_footnotes(content_html: str) -> tuple[str, list[tuple[str, str]]]:
    collector = _FootnoteCollector(content_html)
    collector.feed(content_html)
    collector.close()
    assert not collector.active_scope, "Rendered footnote scope must be closed"
    bodies = []
    for scope, parts in collector.bodies.items():
        markdown = _FootnoteMarkdown()
        markdown.feed("".join(parts))
        markdown.close()
        bodies.append((collector.tokens[scope], "".join(markdown.output)))
    output = "".join(collector.output)
    if bodies:
        output = relocate_standalone_footnotes(output, set(collector.tokens.values()), collector.continuations)
    return output, bodies


class _FootnoteIdentity(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text: list[str] = []
        self.targets: list[tuple[str, str]] = []

    def handle_data(self, data: str) -> None:
        self.text.append(data)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"br", "p", "div", "li"}:
            self.text.append("\n")
        for name, value in attrs:
            if name in {"href", "src"}:
                assert isinstance(value, str)
                self.targets.append((name, value))


def finish_footnotes(
    content_html: str, footnotes: list[tuple[str, str]], render_reference_body: Callable[[str], str],
) -> str:
    if not footnotes:
        return content_html
    rows = []
    numbers: dict[tuple[str, tuple[tuple[str, str], ...]], int] = {}
    for token, body in footnotes:
        identity = _FootnoteIdentity()
        identity.feed(body)
        identity.close()
        key = ("".join(identity.text), tuple(identity.targets))
        is_new_reference = key not in numbers
        if is_new_reference:
            numbers[key] = len(numbers) + 1
        number = numbers[key]
        marker = (
            '<sup class="ai-chat-citation-marker meta-footnote-marker">'
            f'<button type="button" class="meta-footnote-link" data-footnote-number="{number}" '
            f'aria-label="Go to reference {number}">[{number}]</button></sup>'
        )
        content_html = content_html.replace(token, marker)
        if not is_new_reference:
            continue
        body = render_reference_body(body)
        rows.append(
            f'<li data-footnote-reference="{number}" tabindex="-1">'
            f'<span class="ai-chat-reference-number">[{number}]:</span>'
            f'<div class="meta-footnote-body">{body}</div></li>'
        )
    return (
        f'<div class="meta-footnotes-note">{content_html}'
        '<section class="ai-chat-references meta-footnote-references" aria-label="References">'
        '<div class="ai-chat-references-heading">References:</div>'
        f'<ol>{"".join(rows)}</ol></section></div>'
    )
