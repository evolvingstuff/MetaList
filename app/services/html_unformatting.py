from __future__ import annotations

from dataclasses import dataclass
from html import escape
from html.parser import HTMLParser
import re


_IGNORED_TAGS = frozenset({"script", "style", "noscript"})
_VOID_TAGS = frozenset({"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source"})
_BLOCK_TAGS = frozenset(
    {
        "address",
        "article",
        "aside",
        "blockquote",
        "caption",
        "div",
        "dl",
        "dt",
        "dd",
        "fieldset",
        "figcaption",
        "figure",
        "footer",
        "form",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "main",
        "nav",
        "p",
        "pre",
        "section",
    }
)
_TABLE_CONTAINER_TAGS = frozenset({"table", "thead", "tbody", "tfoot"})
_TABLE_CELL_TAGS = frozenset({"td", "th"})
_TEXT_WHITESPACE_RE = re.compile(r"[\t\n\r\f\v ]+")
_TEXT_LINE_BREAK_RE = re.compile(r"\r\n|\r|\n")
_LINE_BREAK_PRESERVING_WHITE_SPACE_VALUES = frozenset(
    {"break-spaces", "pre", "pre-line", "pre-wrap"}
)


class _HtmlNode:
    __slots__ = ("kind", "tag", "attrs", "text", "children", "preserve_line_breaks")

    def __init__(
        self,
        *,
        kind: str,
        tag: str,
        attrs: dict[str, str],
        text: str,
        children: list["_HtmlNode"],
        preserve_line_breaks: bool,
    ) -> None:
        self.kind = kind
        self.tag = tag
        self.attrs = attrs
        self.text = text
        self.children = children
        self.preserve_line_breaks = preserve_line_breaks


@dataclass
class _ListFrame:
    kind: str
    next_index: int = 1


class _HtmlTreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._root = _create_element_node(tag="root", attrs={}, preserve_line_breaks=False)
        self._stack = [self._root]
        self._ignore_depth = 0

    @property
    def root(self) -> _HtmlNode:
        return self._root

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._open_tag(tag, attrs, push=tag.lower() not in _VOID_TAGS)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._open_tag(tag, attrs, push=False)

    def handle_endtag(self, tag: str) -> None:
        normalized_tag = tag.lower()
        if self._ignore_depth > 0:
            if normalized_tag in _IGNORED_TAGS:
                self._ignore_depth -= 1
            return

        for index in range(len(self._stack) - 1, 0, -1):
            if self._stack[index].tag == normalized_tag:
                del self._stack[index:]
                return

    def handle_data(self, data: str) -> None:
        if self._ignore_depth > 0 or data == "":
            return
        self._stack[-1].children.append(
            _create_text_node(
                data,
                preserve_line_breaks=self._stack[-1].preserve_line_breaks,
            )
        )

    def handle_comment(self, data: str) -> None:
        del data

    def _open_tag(self, tag: str, attrs: list[tuple[str, str | None]], *, push: bool) -> None:
        normalized_tag = tag.lower()
        if self._ignore_depth > 0:
            if normalized_tag in _IGNORED_TAGS:
                self._ignore_depth += 1
            return
        if normalized_tag in _IGNORED_TAGS:
            self._ignore_depth += 1
            return

        normalized_attrs: dict[str, str] = {}
        for name, value in attrs:
            if name is None or value is None:
                continue
            normalized_name = str(name).lower()
            if normalized_name in normalized_attrs:
                continue
            normalized_attrs[normalized_name] = str(value)

        preserves_default_line_breaks = self._stack[-1].preserve_line_breaks
        if normalized_tag == "pre":
            preserves_default_line_breaks = True

        node = _create_element_node(
            tag=normalized_tag,
            attrs=normalized_attrs,
            preserve_line_breaks=_resolve_preserved_line_breaks(
                attrs=normalized_attrs,
                inherited=preserves_default_line_breaks,
            ),
        )
        self._stack[-1].children.append(node)
        if push:
            self._stack.append(node)


class _HtmlLineBuilder:
    def __init__(self) -> None:
        self._lines: list[list[str]] = [[]]

    def append_html(self, fragment: str) -> None:
        if fragment == "":
            return
        self._lines[-1].append(fragment)

    def append_text(self, text: str, *, preserve_line_breaks: bool) -> None:
        if preserve_line_breaks:
            parts = _TEXT_LINE_BREAK_RE.split(text)
            for index, part in enumerate(parts):
                self.append_text(part, preserve_line_breaks=False)
                if index < len(parts) - 1:
                    self.newline(preserve_blank=True)
            return

        normalized = _normalize_text(text)
        if normalized == "":
            return
        if not self.current_line_has_content():
            normalized = normalized.lstrip()
        elif self._lines[-1][-1].endswith(" "):
            normalized = normalized.lstrip()
        if normalized == "":
            return
        self._lines[-1].append(escape(normalized))

    def current_line_has_content(self) -> bool:
        return len(self._lines[-1]) > 0

    def newline(self, *, preserve_blank: bool) -> None:
        if self.current_line_has_content() or preserve_blank:
            self._lines.append([])

    def ensure_block_break(self) -> None:
        if self.current_line_has_content():
            self.newline(preserve_blank=False)

    def ensure_paragraph_spacing(self) -> None:
        if self.current_line_has_content():
            self.newline(preserve_blank=False)

        trailing_empty_lines = 0
        for line in reversed(self._lines):
            if line:
                break
            trailing_empty_lines += 1
        if trailing_empty_lines == len(self._lines):
            return
        while trailing_empty_lines < 2:
            self._lines.append([])
            trailing_empty_lines += 1

    def to_html(self) -> str:
        lines: list[str] = []
        has_pending_blank_line = False
        for fragments in self._lines:
            line = "".join(fragments).rstrip()
            if line == "":
                # Emit at most one blank line, only between nonempty lines.
                has_pending_blank_line = bool(lines)
                continue
            if has_pending_blank_line:
                lines.append("")
            lines.append(line)
            has_pending_blank_line = False
        return "<br>".join(lines)


def unformat_note_content_html(content_html: str) -> str:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if content_html == "":
        return ""

    parser = _HtmlTreeBuilder()
    parser.feed(content_html)
    parser.close()

    builder = _HtmlLineBuilder()
    list_stack: list[_ListFrame] = []
    _render_nodes(parser.root.children, builder, list_stack)
    return builder.to_html()


def _render_nodes(nodes: list[_HtmlNode], builder: _HtmlLineBuilder, list_stack: list[_ListFrame]) -> None:
    for node in nodes:
        _render_node(node, builder, list_stack)


def _render_node(node: _HtmlNode, builder: _HtmlLineBuilder, list_stack: list[_ListFrame]) -> None:
    if node.kind == "text":
        builder.append_text(node.text, preserve_line_breaks=node.preserve_line_breaks)
        return
    if node.kind != "element":
        raise TypeError(f"Unsupported HTML node kind: {node.kind}")

    tag = node.tag
    if tag == "br":
        builder.newline(preserve_blank=True)
        return
    if tag == "img":
        return
    if tag == "a":
        _render_anchor(node, builder, list_stack)
        return
    if tag in {"ul", "ol"}:
        builder.ensure_block_break()
        list_stack.append(_ListFrame(kind=tag))
        _render_nodes(node.children, builder, list_stack)
        list_stack.pop()
        if builder.current_line_has_content():
            builder.newline(preserve_blank=False)
        return
    if tag == "li":
        if builder.current_line_has_content():
            builder.newline(preserve_blank=False)
        builder.append_html(escape(_list_item_prefix(list_stack)))
        _render_nodes(node.children, builder, list_stack)
        if builder.current_line_has_content():
            builder.newline(preserve_blank=False)
        return
    if tag in _TABLE_CONTAINER_TAGS:
        builder.ensure_block_break()
        _render_nodes(node.children, builder, list_stack)
        if builder.current_line_has_content():
            builder.newline(preserve_blank=False)
        return
    if tag == "tr":
        _render_table_row(node, builder, list_stack)
        return
    if tag in _TABLE_CELL_TAGS:
        _render_nodes(node.children, builder, list_stack)
        return
    if tag == "p":
        builder.ensure_paragraph_spacing()
        _render_nodes(node.children, builder, list_stack)
        builder.ensure_paragraph_spacing()
        return
    if tag in _BLOCK_TAGS:
        builder.ensure_block_break()
        _render_nodes(node.children, builder, list_stack)
        if builder.current_line_has_content():
            builder.newline(preserve_blank=False)
        return

    _render_nodes(node.children, builder, list_stack)


def _render_anchor(node: _HtmlNode, builder: _HtmlLineBuilder, list_stack: list[_ListFrame]) -> None:
    href = _read_attr(node.attrs, "href")
    inner_builder = _HtmlLineBuilder()
    _render_nodes(node.children, inner_builder, list_stack)
    inner_html = inner_builder.to_html()
    if href == "":
        if inner_html != "":
            builder.append_html(inner_html)
        return

    attr_parts = [f'href="{escape(href, quote=True)}"']
    title = _read_attr(node.attrs, "title")
    if title != "":
        attr_parts.append(f'title="{escape(title, quote=True)}"')

    if inner_html == "":
        inner_html = escape(href)

    builder.append_html(f"<a {' '.join(attr_parts)}>{inner_html}</a>")


def _render_table_row(node: _HtmlNode, builder: _HtmlLineBuilder, list_stack: list[_ListFrame]) -> None:
    builder.ensure_block_break()

    cell_html: list[str] = []
    for child in node.children:
        if child.kind != "element" or child.tag not in _TABLE_CELL_TAGS:
            continue
        cell_builder = _HtmlLineBuilder()
        _render_nodes(child.children, cell_builder, list_stack)
        cell_html.append(cell_builder.to_html())

    joined_cells = " | ".join(cell_html)
    if joined_cells == "":
        return
    builder.append_html(joined_cells)
    builder.newline(preserve_blank=False)


def _list_item_prefix(list_stack: list[_ListFrame]) -> str:
    if not list_stack:
        return "- "
    frame = list_stack[-1]
    if frame.kind == "ol":
        prefix = f"{frame.next_index}. "
        frame.next_index += 1
        return prefix
    return "- "


def _resolve_preserved_line_breaks(*, attrs: dict[str, str], inherited: bool) -> bool:
    style = _read_attr(attrs, "style")
    resolved_value = ""
    has_white_space_declaration = False
    for declaration in style.split(";"):
        property_name, separator, property_value = declaration.partition(":")
        if separator == "" or property_name.strip().lower() != "white-space":
            continue
        has_white_space_declaration = True
        resolved_value = property_value.split("!important", maxsplit=1)[0].strip().lower()

    if not has_white_space_declaration:
        return inherited
    return resolved_value in _LINE_BREAK_PRESERVING_WHITE_SPACE_VALUES


def _create_element_node(
    tag: str,
    attrs: dict[str, str],
    *,
    preserve_line_breaks: bool,
) -> _HtmlNode:
    return _HtmlNode(
        kind="element",
        tag=tag,
        attrs=attrs,
        text="",
        children=[],
        preserve_line_breaks=preserve_line_breaks,
    )


def _create_text_node(text: str, *, preserve_line_breaks: bool) -> _HtmlNode:
    return _HtmlNode(
        kind="text",
        tag="",
        attrs={},
        text=text,
        children=[],
        preserve_line_breaks=preserve_line_breaks,
    )


def _read_attr(attrs: dict[str, str], key: str) -> str:
    if key in attrs:
        return attrs[key]
    return ""


def _normalize_text(text: str) -> str:
    return _TEXT_WHITESPACE_RE.sub(" ", text.replace("\xa0", " "))
