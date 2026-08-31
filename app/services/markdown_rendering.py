from __future__ import annotations

import html
import re
from dataclasses import dataclass
from typing import List
from urllib.parse import urlsplit

from app.services.latex_rendering import render_latex_math_to_html


_ORDERED_LIST_RE = re.compile(r"^(\d+)\.\s+(.*)$")
_UNORDERED_LIST_RE = re.compile(r"^[-+*]\s+(.*)$")
_ATX_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_FENCE_RE = re.compile(r"^```([^\s`]*)\s*$")
_TABLE_DELIMITER_CELL_RE = re.compile(r"^\s*:?-{3,}:?\s*$")
_AUTO_LINK_RE = re.compile(r"(?<![\"'=])(https?://[^\s<]+)")
_ALLOWED_MARKDOWN_LINK_SCHEMES = frozenset({"http", "https", "mailto"})


@dataclass(frozen=True, slots=True)
class _InlinePlaceholder:
    token: str
    html_value: str


@dataclass(frozen=True, slots=True)
class _LatexDelimiter:
    opener: str
    closer: str
    display: str


_LATEX_DELIMITERS = (
    _LatexDelimiter(opener=r"\[", closer=r"\]", display="block"),
    _LatexDelimiter(opener=r"\(", closer=r"\)", display="inline"),
    _LatexDelimiter(opener="$$", closer="$$", display="block"),
    _LatexDelimiter(opener="$", closer="$", display="inline"),
)


def render_markdown_to_html(markdown_text: str) -> str:
    if not isinstance(markdown_text, str):
        raise TypeError(f"markdown_text must be a string, got {type(markdown_text)}")
    if markdown_text == "":
        return ""

    normalized_text = markdown_text.replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized_text.split("\n")
    renderer = _MarkdownRenderer(lines=lines)
    return renderer.render()


class _MarkdownRenderer:
    def __init__(self, *, lines: List[str]):
        if not isinstance(lines, list):
            raise TypeError(f"lines must be a list, got {type(lines)}")
        self._lines = lines
        self._index = 0

    def render(self) -> str:
        blocks: List[str] = []
        while self._index < len(self._lines):
            current_line = self._lines[self._index]
            if current_line.strip() == "":
                self._index += 1
                continue
            if self._is_fence_start(current_line):
                blocks.append(self._render_fence_block())
                continue
            if self._is_heading(current_line):
                blocks.append(self._render_heading_block())
                continue
            if self._is_table_start():
                blocks.append(self._render_table_block())
                continue
            if self._is_blockquote_start(current_line):
                blocks.append(self._render_blockquote_block())
                continue
            if self._is_list_start(current_line):
                blocks.append(self._render_list_block())
                continue
            if self._is_horizontal_rule(current_line):
                blocks.append("<hr>")
                self._index += 1
                continue
            blocks.append(self._render_paragraph_block())
        return "".join(blocks)

    def _render_fence_block(self) -> str:
        opening_line = self._lines[self._index]
        match = _FENCE_RE.match(opening_line)
        assert match is not None
        language = match.group(1)
        self._index += 1

        content_lines: List[str] = []
        while self._index < len(self._lines):
            line = self._lines[self._index]
            if line.strip() == "```":
                self._index += 1
                break
            content_lines.append(line)
            self._index += 1

        escaped_code = html.escape("\n".join(content_lines), quote=False)
        if language.casefold() == "mermaid":
            return (
                '<pre class="meta-mermaid-source">'
                f'<code class="language-mermaid">{escaped_code}</code>'
                "</pre>"
            )

        language_attr = ""
        if language != "":
            escaped_language = html.escape(language, quote=True)
            language_attr = f' class="language-{escaped_language}"'
        return f"<pre><code{language_attr}>{escaped_code}</code></pre>"

    def _render_heading_block(self) -> str:
        line = self._lines[self._index]
        match = _ATX_HEADING_RE.match(line)
        assert match is not None
        level = len(match.group(1))
        content = match.group(2).strip()
        self._index += 1
        rendered = _render_inline_markdown(content)
        return f"<h{level}>{rendered}</h{level}>"

    def _render_table_block(self) -> str:
        header_line = self._lines[self._index]
        delimiter_line = self._lines[self._index + 1]
        header_cells = _split_table_row(header_line)
        delimiter_cells = _split_table_row(delimiter_line)
        assert len(header_cells) == len(delimiter_cells)

        self._index += 2
        body_rows: List[List[str]] = []
        while self._index < len(self._lines):
            line = self._lines[self._index]
            if line.strip() == "" or not _looks_like_table_row(line):
                break
            cells = _split_table_row(line)
            if len(cells) != len(header_cells):
                break
            body_rows.append(cells)
            self._index += 1

        parts: List[str] = ["<table>", "<thead>", "<tr>"]
        for cell in header_cells:
            parts.append(f"<th>{_render_inline_markdown(cell.strip())}</th>")
        parts.extend(["</tr>", "</thead>"])
        if body_rows:
            parts.append("<tbody>")
            for row in body_rows:
                parts.append("<tr>")
                for cell in row:
                    parts.append(f"<td>{_render_inline_markdown(cell.strip())}</td>")
                parts.append("</tr>")
            parts.append("</tbody>")
        parts.append("</table>")
        return "".join(parts)

    def _render_blockquote_block(self) -> str:
        quote_lines: List[str] = []
        while self._index < len(self._lines):
            line = self._lines[self._index]
            if line.strip() == "":
                quote_lines.append("")
                self._index += 1
                continue
            if not self._is_blockquote_start(line):
                break
            stripped = line.lstrip()
            assert stripped.startswith(">")
            stripped = stripped[1:]
            if stripped.startswith(" "):
                stripped = stripped[1:]
            quote_lines.append(stripped)
            self._index += 1
        inner_html = render_markdown_to_html("\n".join(quote_lines))
        return f"<blockquote>{inner_html}</blockquote>"

    def _render_list_block(self) -> str:
        first_line = self._lines[self._index]
        ordered_match = _ORDERED_LIST_RE.match(first_line.strip())
        is_ordered = ordered_match is not None
        tag_name = "ul"
        opening_tag = "<ul>"
        if is_ordered:
            tag_name = "ol"
            assert ordered_match is not None
            start_number = int(ordered_match.group(1))
            opening_tag = "<ol>"
            if start_number != 1:
                opening_tag = f'<ol start="{start_number}">'
        items: List[str] = []

        while self._index < len(self._lines):
            line = self._lines[self._index]
            if line.strip() == "":
                next_content_index = self._index
                while (
                    next_content_index < len(self._lines)
                    and self._lines[next_content_index].strip() == ""
                ):
                    next_content_index += 1
                if (
                    next_content_index < len(self._lines)
                    and self._is_matching_list_item(
                        line=self._lines[next_content_index],
                        is_ordered=is_ordered,
                    )
                ):
                    self._index = next_content_index
                    continue
                self._index = next_content_index
                break
            if not self._is_matching_list_item(line=line, is_ordered=is_ordered):
                break
            items.append(self._render_list_item(is_ordered=is_ordered))

        return f"{opening_tag}{''.join(items)}</{tag_name}>"

    def _render_list_item(self, *, is_ordered: bool) -> str:
        line = self._lines[self._index]
        stripped = line.strip()
        if is_ordered:
            match = _ORDERED_LIST_RE.match(stripped)
        else:
            match = _UNORDERED_LIST_RE.match(stripped)
        assert match is not None
        item_content = match.group(1)
        if is_ordered:
            item_content = match.group(2)
        item_lines = [item_content]
        self._index += 1

        while self._index < len(self._lines):
            next_line = self._lines[self._index]
            if next_line.strip() == "":
                break
            if self._is_list_start(next_line):
                break
            if self._is_block_start(next_line):
                break
            if next_line.startswith("  ") or next_line.startswith("\t"):
                item_lines.append(next_line.lstrip())
                self._index += 1
                continue
            break

        rendered = _render_inline_markdown("\n".join(item_lines))
        rendered = rendered.replace("\n", "<br>\n")
        return f"<li>{rendered}</li>"

    def _render_paragraph_block(self) -> str:
        paragraph_lines: List[str] = []
        while self._index < len(self._lines):
            line = self._lines[self._index]
            if line.strip() == "":
                break
            if paragraph_lines and self._is_block_start(line):
                break
            paragraph_lines.append(line)
            self._index += 1

        rendered = _render_inline_markdown("\n".join(paragraph_lines))
        rendered = rendered.replace("\n", "<br>\n")
        return f"<p>{rendered}</p>"

    def _is_block_start(self, line: str) -> bool:
        if self._is_heading(line):
            return True
        if self._is_fence_start(line):
            return True
        if self._is_blockquote_start(line):
            return True
        if self._is_list_start(line):
            return True
        if self._is_horizontal_rule(line):
            return True
        if self._is_table_start():
            return True
        return False

    def _is_heading(self, line: str) -> bool:
        return _ATX_HEADING_RE.match(line.strip()) is not None

    def _is_fence_start(self, line: str) -> bool:
        return _FENCE_RE.match(line.strip()) is not None

    def _is_blockquote_start(self, line: str) -> bool:
        return line.lstrip().startswith(">")

    def _is_list_start(self, line: str) -> bool:
        stripped = line.strip()
        if _UNORDERED_LIST_RE.match(stripped) is not None:
            return True
        if _ORDERED_LIST_RE.match(stripped) is not None:
            return True
        return False

    def _is_matching_list_item(self, *, line: str, is_ordered: bool) -> bool:
        stripped = line.strip()
        if is_ordered:
            return _ORDERED_LIST_RE.match(stripped) is not None
        return _UNORDERED_LIST_RE.match(stripped) is not None

    def _is_horizontal_rule(self, line: str) -> bool:
        stripped = line.strip()
        if len(stripped) < 3:
            return False
        if any(ch not in {"-", "*", "_"} for ch in stripped):
            return False
        return len(set(stripped)) == 1

    def _is_table_start(self) -> bool:
        if self._index + 1 >= len(self._lines):
            return False
        header_line = self._lines[self._index]
        delimiter_line = self._lines[self._index + 1]
        if not _looks_like_table_row(header_line):
            return False
        if not _is_table_delimiter_row(delimiter_line):
            return False
        return len(_split_table_row(header_line)) == len(
            _split_table_row(delimiter_line)
        )


def _split_table_row(line: str) -> list[str]:
    trimmed = line.strip()
    if trimmed.startswith("|"):
        trimmed = trimmed[1:]
    if trimmed.endswith("|"):
        trimmed = trimmed[:-1]
    return [cell.strip() for cell in trimmed.split("|")]


def _looks_like_table_row(line: str) -> bool:
    return "|" in line


def _is_table_delimiter_row(line: str) -> bool:
    if not _looks_like_table_row(line):
        return False
    cells = _split_table_row(line)
    if not cells:
        return False
    return all(_TABLE_DELIMITER_CELL_RE.match(cell) is not None for cell in cells)


def _render_inline_markdown(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text)}")
    if text == "":
        return ""

    placeholders: List[_InlinePlaceholder] = []
    rendered = html.escape(text, quote=False)
    rendered = _extract_code_spans(rendered, placeholders)
    rendered = _extract_markdown_links(rendered, placeholders)
    rendered = _extract_auto_links(rendered, placeholders)
    rendered = _extract_latex_math(rendered, placeholders)
    rendered = _replace_strong(rendered)
    rendered = _replace_emphasis(rendered)
    rendered = _replace_strikethrough(rendered)
    rendered = rendered.replace("\\\n", "\n")
    for placeholder in placeholders:
        rendered = rendered.replace(placeholder.token, placeholder.html_value)
    return rendered


def _extract_code_spans(text: str, placeholders: List[_InlinePlaceholder]) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    output: List[str] = []
    cursor = 0
    while cursor < len(text):
        start = text.find("`", cursor)
        if start == -1:
            output.append(text[cursor:])
            break
        fence_len = _count_repeated_char(text=text, start=start, char="`")
        end = text.find("`" * fence_len, start + fence_len)
        if end == -1:
            output.append(text[cursor:])
            break
        output.append(text[cursor:start])
        code_content = text[start + fence_len : end]
        code_content = code_content.replace("\n", " ")
        placeholder = _make_placeholder(
            placeholders=placeholders,
            html_value=f"<code>{code_content}</code>",
        )
        output.append(placeholder)
        cursor = end + fence_len
    return "".join(output)


def _extract_markdown_links(text: str, placeholders: List[_InlinePlaceholder]) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    output: List[str] = []
    cursor = 0
    while cursor < len(text):
        start = text.find("[", cursor)
        if start == -1:
            output.append(text[cursor:])
            break
        open_paren = text.find("](", start)
        if open_paren == -1:
            output.append(text[cursor:])
            break
        close_paren = _find_unescaped_char(text=text, start=open_paren + 2, target=")")
        if close_paren == -1:
            output.append(text[cursor:])
            break
        output.append(text[cursor:start])
        link_text = text[start + 1 : open_paren]
        href = text[open_paren + 2 : close_paren].strip()
        if href == "":
            output.append(text[start : close_paren + 1])
            cursor = close_paren + 1
            continue
        parsed_href = urlsplit(html.unescape(href))
        if (
            parsed_href.scheme != ""
            and parsed_href.scheme.casefold() not in _ALLOWED_MARKDOWN_LINK_SCHEMES
        ):
            output.append(text[start : close_paren + 1])
            cursor = close_paren + 1
            continue
        link_html = (
            f'<a href="{html.escape(href, quote=True)}" '
            'target="_blank" rel="noopener noreferrer">'
            f"{_render_inline_markdown(link_text)}"
            "</a>"
        )
        placeholder = _make_placeholder(placeholders=placeholders, html_value=link_html)
        output.append(placeholder)
        cursor = close_paren + 1
    return "".join(output)


def _extract_auto_links(text: str, placeholders: List[_InlinePlaceholder]) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    output: List[str] = []
    cursor = 0
    for match in _AUTO_LINK_RE.finditer(text):
        output.append(text[cursor:match.start()])
        url = match.group(1)
        placeholder = _make_placeholder(
            placeholders=placeholders,
            html_value=(
                f'<a href="{html.escape(url, quote=True)}" '
                'target="_blank" rel="noopener noreferrer">'
                f"{url}"
                "</a>"
            ),
        )
        output.append(placeholder)
        cursor = match.end()
    output.append(text[cursor:])
    return "".join(output)


def _extract_latex_math(text: str, placeholders: List[_InlinePlaceholder]) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    output: List[str] = []
    cursor = 0
    while cursor < len(text):
        delimiter = _latex_delimiter_at(text=text, index=cursor)
        if delimiter is None:
            output.append(text[cursor])
            cursor += 1
            continue

        content_start = cursor + len(delimiter.opener)
        close_index = _find_latex_closing_delimiter(
            text=text,
            start=content_start,
            delimiter=delimiter,
        )
        if close_index == -1:
            output.append(text[cursor])
            cursor += 1
            continue

        escaped_source = text[content_start:close_index]
        latex_source = html.unescape(escaped_source)
        if latex_source.strip() == "":
            output.append(text[cursor : close_index + len(delimiter.closer)])
            cursor = close_index + len(delimiter.closer)
            continue

        rendered_math = render_latex_math_to_html(
            latex_source,
            display=delimiter.display,
        )
        class_names = ["meta-latex"]
        if rendered_math.has_error:
            class_names.append("meta-latex-error")
        elif delimiter.display == "inline":
            class_names.append("meta-latex-inline")
        else:
            class_names.append("meta-latex-display")
        placeholder = _make_placeholder(
            placeholders=placeholders,
            html_value=(
                f'<span class="{" ".join(class_names)}">'
                f"{rendered_math.html}"
                "</span>"
            ),
        )
        output.append(placeholder)
        cursor = close_index + len(delimiter.closer)

    return "".join(output)


def _latex_delimiter_at(*, text: str, index: int) -> _LatexDelimiter | None:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(index, int):
        raise TypeError("index must be an int")

    for delimiter in _LATEX_DELIMITERS:
        if not text.startswith(delimiter.opener, index):
            continue
        if _is_escaped_delimiter(text=text, index=index):
            continue
        if delimiter.opener == "$" and not _is_valid_inline_dollar_opener(
            text=text,
            index=index,
        ):
            continue
        return delimiter
    return None


def _find_latex_closing_delimiter(
    *,
    text: str,
    start: int,
    delimiter: _LatexDelimiter,
) -> int:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(start, int):
        raise TypeError("start must be an int")

    cursor = start
    while cursor < len(text):
        if not text.startswith(delimiter.closer, cursor):
            cursor += 1
            continue
        if _is_escaped_delimiter(text=text, index=cursor):
            cursor += 1
            continue
        if delimiter.closer == "$" and not _is_valid_inline_dollar_closer(
            text=text,
            index=cursor,
        ):
            cursor += 1
            continue
        return cursor
    return -1


def _is_escaped_delimiter(*, text: str, index: int) -> bool:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(index, int):
        raise TypeError("index must be an int")

    backslash_count = 0
    cursor = index - 1
    while cursor >= 0 and text[cursor] == "\\":
        backslash_count += 1
        cursor -= 1
    return backslash_count % 2 == 1


def _is_valid_inline_dollar_opener(*, text: str, index: int) -> bool:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(index, int):
        raise TypeError("index must be an int")

    next_index = index + 1
    if next_index >= len(text):
        return False
    if text[next_index] == "$":
        return False
    return not text[next_index].isspace()


def _is_valid_inline_dollar_closer(*, text: str, index: int) -> bool:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(index, int):
        raise TypeError("index must be an int")

    if index == 0 or text[index - 1].isspace():
        return False
    next_index = index + 1
    if next_index >= len(text):
        return True
    return text[next_index] != "$"


def _replace_strong(text: str) -> str:
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    return re.sub(r"__(.+?)__", r"<strong>\1</strong>", text)


def _replace_emphasis(text: str) -> str:
    text = re.sub(r"(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)", r"<em>\1</em>", text)
    return re.sub(r"(?<!_)_(?!\s)(.+?)(?<!\s)_(?!_)", r"<em>\1</em>", text)


def _replace_strikethrough(text: str) -> str:
    return re.sub(r"~~(.+?)~~", r"<s>\1</s>", text)


def _count_repeated_char(*, text: str, start: int, char: str) -> int:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(start, int):
        raise TypeError("start must be an int")
    if not isinstance(char, str) or len(char) != 1:
        raise TypeError("char must be a single-character string")

    cursor = start
    while cursor < len(text) and text[cursor] == char:
        cursor += 1
    return cursor - start


def _find_unescaped_char(*, text: str, start: int, target: str) -> int:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(start, int):
        raise TypeError("start must be an int")
    if not isinstance(target, str) or len(target) != 1:
        raise TypeError("target must be a single-character string")

    cursor = start
    while cursor < len(text):
        if text[cursor] == target and (cursor == 0 or text[cursor - 1] != "\\"):
            return cursor
        cursor += 1
    return -1


def _make_placeholder(*, placeholders: List[_InlinePlaceholder], html_value: str) -> str:
    if not isinstance(html_value, str):
        raise TypeError(f"html_value must be a string, got {type(html_value)}")
    token = f"@@MLMD[{len(placeholders)}]@@"
    placeholders.append(_InlinePlaceholder(token=token, html_value=html_value))
    return token
