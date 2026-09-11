"""Move standalone footnote markers into the preceding visible paragraph."""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
import html
import re


_VOID_TAGS = frozenset({'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'})
_BLOCK_TAGS = frozenset({'p', 'div', 'li', 'ul', 'ol', 'blockquote', 'pre', 'table', 'tr', 'td', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'})
_INLINE_TAGS = frozenset({'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'span', 'small', 'sub', 'sup', 'code', 'mark'})


@dataclass
class _Element:
    tag: str
    opening: str
    closing: str
    children: list[str | _Element]

    def render(self) -> str:
        return self.opening + ''.join(_render(child) for child in self.children) + self.closing


@dataclass
class _Line:
    content: list[str | _Element]
    ending: str | _Element

    def append_marker(self, marker: str) -> None:
        if len(self.content) == 1 and isinstance(self.content[0], _Element) and self.content[0].tag in _BLOCK_TAGS:
            self.content[0].children.append(marker)
        else:
            self.content.append(marker)


def _render(node: str | _Element) -> str:
    if isinstance(node, str):
        return node
    return node.render()


def _visible_text(node: str | _Element) -> str:
    if isinstance(node, str):
        return html.unescape(node)
    if node.tag not in _INLINE_TAGS and node.tag not in {'p', 'div', 'br'}:
        return '\ufffc'  # Media and structural containers cannot be footnote-only lines.
    if node.tag == 'br':
        return '\n'
    return ''.join(_visible_text(child) for child in node.children)


class _LayoutParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.root = _Element('', '', '', [])
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        element = _Element(tag, self.get_starttag_text(), '', [])
        self.stack[-1].children.append(element)
        if tag not in _VOID_TAGS:
            self.stack.append(element)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack[index].closing = f'</{tag}>'
                del self.stack[index:]
                return
        self.stack[-1].children.append(f'</{tag}>')

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.stack[-1].children.append(_Element(tag, self.get_starttag_text(), '', []))

    def handle_data(self, data: str) -> None:
        self.stack[-1].children.extend(part for part in re.split(r'(\r\n|\n|\r)', data) if part)

    def handle_entityref(self, name: str) -> None:
        self.stack[-1].children.append(f'&{name};')

    def handle_charref(self, name: str) -> None:
        self.stack[-1].children.append(f'&#{name};')

    def handle_comment(self, data: str) -> None:
        self.stack[-1].children.append(f'<!--{data}-->')


def _lines(children: list[str | _Element]) -> list[_Line]:
    lines: list[_Line] = []
    content: list[str | _Element] = []
    for child in children:
        is_break = isinstance(child, str) and html.unescape(child) in {'\n', '\r', '\r\n'}
        if isinstance(child, _Element) and child.tag == 'br':
            is_break = True
        if is_break:
            lines.append(_Line(content, child))
            content = []
        elif isinstance(child, _Element) and child.tag in _BLOCK_TAGS:
            if content:
                lines.append(_Line(content, ''))
                content = []
            lines.append(_Line([child], ''))
        else:
            content.append(child)
    if content:
        lines.append(_Line(content, ''))
    return lines


def _relocate_in_element(element: _Element, token_pattern: re.Pattern[str], markers: set[str]) -> None:
    for child in element.children:
        if isinstance(child, _Element):
            _relocate_in_element(child, token_pattern, markers)
    lines = _lines(element.children)
    retained: list[_Line] = []
    previous_content: list[_Line] = []
    has_moved_line = False
    for line in lines:
        text = ''.join(_visible_text(child) for child in line.content)
        tokens = token_pattern.findall(text)
        only_footnotes = bool(tokens) and token_pattern.sub('', text).strip() == ''
        if only_footnotes and previous_content:
            for token in tokens:
                if token in markers:
                    previous_content[-1].append_marker(token)
            # Preserve one paragraph boundary without accumulating empty lines.
            while retained[-1] is not previous_content[-1]:
                retained.pop()
            if previous_content[-1].ending:
                retained.append(_Line([], previous_content[-1].ending))
            has_moved_line = True
            continue
        if (only_footnotes and not any(token in markers for token in tokens)
                and len(line.content) == 1 and isinstance(line.content[0], _Element)
                and line.content[0].tag in {'p', 'div'}):
            continue
        if has_moved_line and not text.strip():
            continue
        retained.append(line)
        if text.strip() and not only_footnotes:
            if (len(line.content) == 1 and isinstance(line.content[0], _Element)
                    and line.content[0].tag in _BLOCK_TAGS - {'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}):
                previous_content = []
            else:
                previous_content = [line]
            has_moved_line = False
    if has_moved_line and previous_content:
        while retained[-1] is not previous_content[-1]:
            retained.pop()
        previous_content[-1].ending = ''
    element.children = []
    for line in retained:
        element.children.extend(line.content)
        if line.ending:
            element.children.append(line.ending)


def relocate_standalone_footnotes(content_html: str, markers: set[str], continuations: set[str]) -> str:
    assert markers, 'Footnote layout requires at least one marker'
    parser = _LayoutParser()
    parser.feed(content_html)
    parser.close()
    pattern = re.compile('|'.join(re.escape(token) for token in sorted(markers | continuations)))
    _relocate_in_element(parser.root, pattern, markers)
    output = parser.root.render()
    for continuation in continuations:
        output = output.replace(continuation, '')
    return output
