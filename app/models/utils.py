import re
from html.parser import HTMLParser
from typing import Any, Dict, List
from types import SimpleNamespace

from app.presentation.render.note_renderer import render_read_only_mode
from app.services.markdown_rendering import strip_latex_source_attributes

# Copied HTML indents each nesting level with a spacer cell this wide.
_CLIPBOARD_INDENT_PX_PER_LEVEL = 32


def note_data_to_html(note_data: Dict[str, Any]) -> str:
    """
    Convert serialized note data to HTML using table structure for reliable indentation.
    Uses nested tables which create indentation that works across all applications.
    
    Args:
        note_data: Dictionary containing note content and children
        
    Returns:
        HTML string representation with guaranteed indentation
    """
    def render_note(note: Dict[str, Any], depth: int) -> str:
        html_parts = []
        pending = [(note, depth)]
        visited = set()
        while pending:
            note, depth = pending.pop()
            if id(note) in visited:
                raise RuntimeError('Cycle in clipboard hierarchy')
            visited.add(id(note))

            # Create indentation using table with spacer cell
            if depth > 0:
                spacer_width = depth * _CLIPBOARD_INDENT_PX_PER_LEVEL
                html_parts.append('<table style="width: 100%; border-collapse: collapse; margin: 2px 0;"><tr>')
                html_parts.append(f'<td style="width: {spacer_width}px;"></td>')
                html_parts.append('<td>')

            # Add the note content with border
            if "content" not in note:
                raise RuntimeError(f"note_data missing required key: content | note={note}")
            content = note["content"]
            note_style = """
                border: 1px solid #cccccc;
                border-radius: 4px;
                padding: 8px 15px;
                margin: 2px 0;
                background: white;
            """
            html_parts.append(f'<div class="note-content" style="{note_style}">{content}</div>')

            # Close the table cell if indented
            if depth > 0:
                html_parts.append('</td></tr></table>')

            # Add children with increased depth
            if "children" not in note:
                raise RuntimeError(f"note_data missing required key: children | note={note}")
            children = note["children"]
            if not isinstance(children, list):
                raise TypeError(f"note_data.children must be a list: {type(children)}")
            pending.extend((child, depth + 1) for child in reversed(children))
        return ''.join(html_parts)

    # Container with basic styling
    container_css = """
        font-family: system-ui, -apple-system, sans-serif;
        line-height: 1.5;
        color: #333333;
    """
    
    html = f'<div data-metalist-note-clipboard="true" style="{container_css}">'
    html += render_note(note_data, 0)
    html += '</div>'
    
    return html


_CLIPBOARD_IGNORE_TAGS = {"script", "style", "noscript"}
_CLIPBOARD_BLOCK_TAGS = {
    "address",
    "article",
    "aside",
    "blockquote",
    "div",
    "dl",
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
    "hr",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tbody",
    "tfoot",
    "thead",
    "tr",
    "ul",
}
_CLIPBOARD_CELL_TAGS = {"td", "th"}


class _ClipboardPlainTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._lines: List[str] = []
        self._current_line = ""
        self._ignore_depth = 0
        self._list_depth = 0

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        del attrs
        normalized = tag.lower()
        if normalized in _CLIPBOARD_IGNORE_TAGS:
            self._ignore_depth += 1
            return
        if self._ignore_depth > 0:
            return
        if normalized == "br":
            self._flush_line()
            return
        if normalized in {"ul", "ol"}:
            self._start_block()
            self._list_depth += 1
            return
        if normalized == "li":
            self._start_block()
            marker_indent = "\t" * max(1, self._list_depth)
            self._current_line += f"{marker_indent}- "
            return
        if normalized in _CLIPBOARD_BLOCK_TAGS:
            self._start_block()
            return
        if normalized in _CLIPBOARD_CELL_TAGS:
            self._append_space()

    def handle_startendtag(self, tag: str, attrs: Any) -> None:
        del attrs
        normalized = tag.lower()
        if self._ignore_depth > 0:
            return
        if normalized == "br":
            self._flush_line()
            return
        if normalized in _CLIPBOARD_BLOCK_TAGS:
            self._start_block()

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.lower()
        if normalized in _CLIPBOARD_IGNORE_TAGS:
            if self._ignore_depth > 0:
                self._ignore_depth -= 1
            return
        if self._ignore_depth > 0:
            return
        if normalized == "li":
            self._flush_line()
            return
        if normalized in {"ul", "ol"}:
            if self._list_depth <= 0:
                raise RuntimeError("Clipboard HTML parser list depth underflow")
            self._list_depth -= 1
            self._start_block()
            return
        if normalized in _CLIPBOARD_BLOCK_TAGS:
            self._flush_line()
            return
        if normalized in _CLIPBOARD_CELL_TAGS:
            self._append_space()

    def handle_data(self, data: str) -> None:
        if self._ignore_depth > 0:
            return
        self._current_line += data

    def get_lines(self) -> List[str]:
        self._flush_line()
        return list(self._lines)

    def _start_block(self) -> None:
        if self._current_line_is_empty_or_list_marker():
            return
        self._flush_line()

    def _flush_line(self) -> None:
        raw_line = self._current_line
        self._current_line = ""
        normalized_line = _normalize_clipboard_plain_text_line(raw_line)
        if normalized_line:
            self._lines.append(normalized_line)

    def _append_space(self) -> None:
        if self._current_line and not self._current_line.endswith((" ", "\t")):
            self._current_line += " "

    def _current_line_is_empty_or_list_marker(self) -> bool:
        normalized = _normalize_clipboard_plain_text_line(self._current_line)
        if normalized == "":
            return True
        list_marker = ("\t" * max(1, self._list_depth)) + "-"
        return normalized.rstrip() == list_marker


def _normalize_clipboard_plain_text_line(raw_line: str) -> str:
    if not isinstance(raw_line, str):
        raise TypeError(f"raw_line must be a string: {type(raw_line)}")
    leading_tabs_match = re.match(r"^\t*", raw_line)
    assert leading_tabs_match is not None
    leading_tabs = leading_tabs_match.group(0)
    body = raw_line[len(leading_tabs):]
    collapsed_body = re.sub(r"[ \t\r\f\v]+", " ", body).strip()
    if collapsed_body == "" or collapsed_body == "-":
        return ""
    return f"{leading_tabs}{collapsed_body}"


def _html_to_clipboard_plain_text_lines(content_html: str) -> List[str]:
    if not isinstance(content_html, str):
        raise TypeError(f"content_html must be a string: {type(content_html)}")
    if content_html == "":
        return []

    parser = _ClipboardPlainTextParser()
    parser.feed(content_html)
    parser.close()
    return parser.get_lines()


def note_data_to_plain_text(note_data: Dict[str, Any]) -> str:
    """
    Convert serialized note data to plain text with tab indentation.
    
    Args:
        note_data: Dictionary containing note content and children
        
    Returns:
        Plain text string with proper indentation
    """
    lines = []
    pending = [(note_data, 0)]
    visited = set()
    while pending:
        node, depth = pending.pop()
        if id(node) in visited:
            raise RuntimeError('Cycle in clipboard hierarchy')
        visited.add(id(node))
        content = str(node['content']).strip()
        if content:
            lines.extend('\t' * depth + line for line in _html_to_clipboard_plain_text_lines(content))
        children = node['children']
        if not isinstance(children, list):
            raise TypeError('note_data.children must be a list')
        pending.extend((child, depth + 1) for child in reversed(children))
    return '\n'.join(lines)


def render_note_data_read_only(note_data: Dict[str, Any]) -> Dict[str, Any]:
    """Create a deep-copied note tree rendered in read-only mode."""

    root = {}
    pending = [(note_data, root)]
    visited = set()
    while pending:
        node, rendered = pending.pop()
        if id(node) in visited:
            raise RuntimeError('Cycle in clipboard hierarchy')
        visited.add(id(node))
        content, tags = node['content'], node['tags']
        if not isinstance(content, str) or not isinstance(tags, str):
            raise TypeError('Note content and tags must be strings')
        children = node['children']
        if not isinstance(children, list):
            raise TypeError('note_data.children must be a list')
        child_payloads = [{} for _ in children]
        rendered.update(node)
        rendered['content'] = strip_latex_source_attributes(
            render_read_only_mode(SimpleNamespace(content=content, tags=tags))
        )
        rendered['children'] = child_payloads
        pending.extend(zip(children, child_payloads))
    return root
