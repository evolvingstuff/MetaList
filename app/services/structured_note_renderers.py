"""JSON/CSV parsing, highlighting, and static rendering, independent of tag parsing."""
from __future__ import annotations

import csv
import html
import io
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Dict, FrozenSet, List, Mapping, Tuple

from app.services.inline_image_occurrences import INLINE_IMAGE_TAG_RE


@dataclass(frozen=True)
class CsvScopeFormatting:
    extract: Callable[..., tuple[str, Dict[str, str]]]
    restore: Callable[[str, Dict[str, str]], str]
    render: Callable[..., str]


_JSON_NUMBER_RE = re.compile(r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?")

_CSV_IMAGE_PLACEHOLDER_PREFIX = "MLCSVIMAGEPLACEHOLDER"

_CSV_IMAGE_PLACEHOLDER_SUFFIX = "TOKEN"


def _render_json_meta(*, content_html: str, formatting_tags: FrozenSet[str], extra_classes: str, size_style_attr: str) -> str:
    raw_text = _extract_plain_text(content_html)
    ok, pretty, error_message = _pretty_print_json(raw_text)
    if not ok:
        copy_attr = _copyable_attr(formatting_tags, raw_text)
        return _render_json_error(
            raw_text=raw_text,
            message=error_message,
            copy_attr=copy_attr,
        )

    highlighted = _highlight_json(pretty)
    copy_attr = _copyable_attr(formatting_tags, raw_text)

    code_class = "meta-json-code"
    if extra_classes:
        code_class = f"{code_class} {extra_classes}"

    return (
        f'<div class="meta-json"{copy_attr}>'
        f'<pre class="meta-json-pre"><code class="{code_class}"{size_style_attr}>{highlighted}</code></pre>'
        "</div>"
    )


def _render_json_error(*, raw_text: str, message: str, copy_attr: str) -> str:
    if not isinstance(raw_text, str):
        raise TypeError("raw_text must be a string")
    if not isinstance(message, str) or message == "":
        raise TypeError("message must be a non-empty string")
    if not isinstance(copy_attr, str):
        raise TypeError("copy_attr must be a string")

    escaped_message = html.escape(message, quote=True)
    escaped_text = html.escape(raw_text, quote=False)

    return (
        f'<div class="meta-json meta-json-error"{copy_attr}>'
        f'<span class="meta-json-badge" title="{escaped_message}">Invalid JSON</span>'
        f'<pre class="meta-json-pre"><code class="meta-json-code">{escaped_text}</code></pre>'
        "</div>"
    )


def _pretty_print_json(raw_text: str) -> tuple[bool, str, str]:
    if not isinstance(raw_text, str):
        raise TypeError("raw_text must be a string")

    completed = subprocess.run(
        [sys.executable, "-m", "json.tool"],
        input=raw_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        error_message = completed.stderr.strip()
        if error_message == "":
            error_message = "Invalid JSON"
        return False, "", error_message

    pretty = completed.stdout
    if pretty.endswith("\n"):
        pretty = pretty[:-1]
    pretty = _normalize_json_indent(pretty)
    return True, pretty, ""


def _normalize_json_indent(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    lines = text.splitlines()
    if not lines:
        return text

    adjusted_lines: List[str] = []
    for line in lines:
        stripped = line.lstrip(" ")
        leading_spaces = len(line) - len(stripped)
        if leading_spaces == 0:
            adjusted_lines.append(line)
            continue
        if leading_spaces % 4 != 0:
            adjusted_lines.append(line)
            continue
        indent_level = leading_spaces // 4
        adjusted_lines.append(("  " * indent_level) + stripped)

    return "\n".join(adjusted_lines)


def _extract_plain_text(content_html: str) -> str:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")

    text = re.sub(r"<br\s*/?>", "\n", content_html, flags=re.IGNORECASE)
    text = re.sub(r"<div[^>]*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<p[^>]*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</div>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"</p>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text.strip("\n")


def extract_plain_text_from_note_html(content_html: str) -> str:
    """Extract the editable plain-text source represented by note HTML."""
    return _extract_plain_text(content_html)


def _render_csv_meta(
    *,
    content_html: str,
    extra_classes: str,
    size_style_attr: str,
    scoped_formatting: CsvScopeFormatting,
    formatting_tags: FrozenSet[str],
    inline: bool,
    cell_wrappers: FrozenSet[Tuple[str, int]],
    cell_scoped_tags: Mapping[Tuple[str, int], FrozenSet[str]],
    cell_scoped_renderers: Mapping[Tuple[str, int], str],
) -> str:
    protected_html, image_placeholders = _extract_csv_image_placeholders(content_html)
    parse_raw_text = _extract_plain_text(protected_html)
    raw_text = _remove_csv_image_placeholders(
        text=parse_raw_text,
        image_placeholders=image_placeholders,
    )
    copy_attr = _copyable_attr(formatting_tags, raw_text)

    placeholder_map: Dict[str, str] = {}
    parse_text = parse_raw_text
    if cell_wrappers:
        parse_text, placeholder_map = scoped_formatting.extract(
            text=parse_text,
            wrappers_to_consume=cell_wrappers,
        )

    rows, error = _parse_csv_rows(
        parse_text,
        full_width_cell_tokens=frozenset(image_placeholders),
    )
    if error is not None:
        return _render_csv_error(
            raw_text=raw_text,
            message=error,
            inline=inline,
            copy_attr=copy_attr,
        )

    table_class = "meta-csv-table"
    if extra_classes:
        table_class = f"{table_class} {extra_classes}"

    meta_classes = ["meta-csv"]
    if inline:
        meta_classes.append("meta-csv-inline")

    output: List[str] = [
        f'<div class="{" ".join(meta_classes)}"{copy_attr}>',
        '<div class="meta-csv-table-wrap">',
        f'<table class="{table_class}"{size_style_attr}>',
        "<tbody>",
    ]
    effective_scoped_tags = cell_scoped_tags
    apply_cell_wrappers = bool(cell_wrappers)

    csv_column_count = _csv_column_count(
        rows=rows,
        full_width_cell_tokens=frozenset(image_placeholders),
    )
    for row in rows:
        output.append("<tr>")
        if _is_full_width_csv_media_row(
            row=row,
            full_width_cell_tokens=frozenset(image_placeholders),
        ):
            image_html = image_placeholders[row[0]]
            output.append(
                f'<td class="meta-csv-media-cell" colspan="{csv_column_count}">'
                f"{image_html}</td>"
            )
            output.append("</tr>")
            continue
        for cell in row:
            cell_text = cell
            if placeholder_map:
                cell_text = scoped_formatting.restore(cell_text, placeholder_map)
            if apply_cell_wrappers:
                cell_html = scoped_formatting.render(
                    text=cell_text,
                    wrappers_to_consume=cell_wrappers,
                    scoped_tags=effective_scoped_tags,
                    scoped_renderers=cell_scoped_renderers,
                    preserve_latex_placeholders=False,
                )
            else:
                cell_html = html.escape(cell_text, quote=False)
            cell_html = _restore_csv_image_placeholders(
                text=cell_html,
                image_placeholders=image_placeholders,
            )
            output.append(f"<td>{cell_html}</td>")
        output.append("</tr>")

    output.append("</tbody></table></div></div>")
    return "".join(output)


def _extract_csv_image_placeholders(content_html: str) -> tuple[str, Dict[str, str]]:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")

    output: List[str] = []
    image_placeholders: Dict[str, str] = {}
    cursor = 0
    for image_index, match in enumerate(INLINE_IMAGE_TAG_RE.finditer(content_html)):
        token = (
            f"{_CSV_IMAGE_PLACEHOLDER_PREFIX}{image_index}"
            f"{_CSV_IMAGE_PLACEHOLDER_SUFFIX}"
        )
        while token in content_html:
            token = f"{token}X"
        output.append(content_html[cursor:match.start()])
        output.append(token)
        image_placeholders[token] = match.group(0)
        cursor = match.end()
    output.append(content_html[cursor:])
    return "".join(output), image_placeholders


def _remove_csv_image_placeholders(
    *,
    text: str,
    image_placeholders: Mapping[str, str],
) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    output = text
    for token in image_placeholders:
        output = output.replace(token, "")
    return output


def _restore_csv_image_placeholders(
    *,
    text: str,
    image_placeholders: Mapping[str, str],
) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    output = text
    for token, image_html in image_placeholders.items():
        output = output.replace(token, image_html)
    return output


def _is_full_width_csv_media_row(
    *,
    row: List[str],
    full_width_cell_tokens: FrozenSet[str],
) -> bool:
    return len(row) == 1 and row[0] in full_width_cell_tokens


def _csv_column_count(
    *,
    rows: List[List[str]],
    full_width_cell_tokens: FrozenSet[str],
) -> int:
    for row in rows:
        if not _is_full_width_csv_media_row(
            row=row,
            full_width_cell_tokens=full_width_cell_tokens,
        ):
            return len(row)
    return 1


def _parse_csv_rows(
    text: str,
    *,
    full_width_cell_tokens: FrozenSet[str],
) -> tuple[list[list[str]], str | None]:
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    if text.strip() == "":
        return [], "CSV is empty"

    reader = csv.reader(io.StringIO(text))
    rows = [list(row) for row in reader if not all(cell == "" for cell in row)]

    if not rows:
        return [], "CSV is empty"

    expected_len = _csv_column_count(
        rows=rows,
        full_width_cell_tokens=full_width_cell_tokens,
    )
    if expected_len == 0:
        return [], "CSV has no columns"

    for idx, row in enumerate(rows[1:], start=2):
        if _is_full_width_csv_media_row(
            row=row,
            full_width_cell_tokens=full_width_cell_tokens,
        ):
            continue
        if len(row) != expected_len:
            return [], f"Row {idx} has {len(row)} columns, expected {expected_len}"

    return rows, None


def _render_csv_error(*, raw_text: str, message: str, inline: bool, copy_attr: str) -> str:
    if not isinstance(raw_text, str):
        raise TypeError("raw_text must be a string")
    if not isinstance(message, str) or message == "":
        raise TypeError("message must be a non-empty string")
    if not isinstance(copy_attr, str):
        raise TypeError("copy_attr must be a string")

    escaped_message = html.escape(message, quote=True)
    escaped_text = html.escape(raw_text, quote=False)
    meta_classes = ["meta-csv", "meta-csv-error"]
    if inline:
        meta_classes.append("meta-csv-inline")
    return (
        f'<div class="{" ".join(meta_classes)}"{copy_attr}>'
        f'<span class="meta-csv-badge" title="{escaped_message}">Invalid CSV</span>'
        f'<pre class="meta-csv-pre"><code class="meta-csv-code">{escaped_text}</code></pre>'
        "</div>"
    )


def _highlight_json(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    output: List[str] = []
    index = 0
    length = len(text)

    while index < length:
        char = text[index]

        if char == '"':
            token, next_index = _consume_json_string(text, index)
            is_key = _json_string_is_key(text, next_index)
            if is_key:
                css_class = "json-key"
            else:
                css_class = "json-string"
            output.append(_wrap_json_span(css_class, token))
            index = next_index
            continue

        if char == "-" or char.isdigit():
            match = _JSON_NUMBER_RE.match(text, index)
            if match:
                token = match.group(0)
                output.append(_wrap_json_span("json-number", token))
                index = match.end()
                continue

        word_match = _match_json_word(text, index)
        if word_match is not None:
            token, css_class = word_match
            output.append(_wrap_json_span(css_class, token))
            index += len(token)
            continue

        if char in "{}[]:,":
            output.append(_wrap_json_span("json-punct", char))
            index += 1
            continue

        output.append(html.escape(char, quote=False))
        index += 1

    return "".join(output)


def _consume_json_string(text: str, start: int) -> tuple[str, int]:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(start, int) or start < 0:
        raise TypeError("start must be a non-negative integer")

    index = start + 1
    length = len(text)
    while index < length:
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char == '"':
            index += 1
            break
        index += 1
    return text[start:index], index


def _json_string_is_key(text: str, index: int) -> bool:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(index, int) or index < 0:
        raise TypeError("index must be a non-negative integer")

    probe = index
    length = len(text)
    while probe < length and text[probe].isspace():
        probe += 1
    return probe < length and text[probe] == ":"


def _match_json_word(text: str, index: int) -> tuple[str, str] | None:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(index, int) or index < 0:
        raise TypeError("index must be a non-negative integer")

    for word, css_class in (("true", "json-boolean"), ("false", "json-boolean"), ("null", "json-null")):
        if text.startswith(word, index):
            end = index + len(word)
            if end == len(text) or not text[end].isalpha():
                return word, css_class
    return None


def _wrap_json_span(css_class: str, token: str) -> str:
    if not isinstance(css_class, str) or css_class == "":
        raise TypeError("css_class must be a non-empty string")
    if not isinstance(token, str):
        raise TypeError("token must be a string")
    return f'<span class="{css_class}">{html.escape(token, quote=False)}</span>'


def _copyable_attr(formatting_tags: FrozenSet[str], raw_text: str) -> str:
    if "copyable" not in formatting_tags:
        return ""
    escaped_text = html.escape(raw_text, quote=True)
    return f' data-copy-value="{escaped_text}"'
