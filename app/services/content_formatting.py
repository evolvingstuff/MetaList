from __future__ import annotations

import base64
import csv
from decimal import Decimal
import html
import io
import json
import re
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass
from typing import Dict, FrozenSet, List, Mapping, Set, Tuple

from app.services.footnote_rendering import collect_footnotes, finish_footnotes
from app.services.latex_rendering import render_latex_to_html
from app.services.inline_image_occurrences import INLINE_IMAGE_TAG_RE
from app.utils.text_utils import strip_html
from app.services.markdown_rendering import render_markdown_to_html
from app.services.ontology_rules_store import get_ontology_if_ready
from app.services.link_titles import display_domain_for_url
from app.services.link_titles import link_title_store


_OPEN_TO_CLOSE = {
    "[": "]",
    "{": "}",
    "(": ")",
}
_CLOSE_TO_OPEN = {value: key for key, value in _OPEN_TO_CLOSE.items()}

_MAX_DELIMITER_DEPTH = 3

_META_TAG_TO_CLASS = {
    "footnote": "meta-footnote",
    "monospace": "meta-monospace",
    "heading": "meta-heading",
    "red": "meta-red",
    "green": "meta-green",
    "blue": "meta-blue",
    "grey": "meta-grey",
    "highlighter": "meta-highlighter",
    "bold": "meta-bold",
    "italic": "meta-italic",
    "strikethrough": "meta-strikethrough",
    "serif": "meta-serif",
    "copyable": "meta-copyable",
}

_SUGGESTED_SIZE_TAG_NAMES = (
    "size=0.1",
    "size=0.25",
    "size=0.5",
    "size=0.75",
    "size=1",
    "size=1.25",
    "size=1.5",
    "size=2",
    "size=3",
)

_LIST_STYLE_TAGS = {
    "list-bulleted": "bulleted",
    "list-numbered": "numbered",
}

_RENDERER_TAGS = frozenset({"markdown", "latex", "json", "csv", "shell"})
_REMOVABLE_FORMATTING_TAGS = frozenset(set(_META_TAG_TO_CLASS) | set(_RENDERER_TAGS))

_CREDENTIAL_TAGS = frozenset({"username", "password"})
_EMAIL_TAGS = frozenset({"email"})

_CREDENTIAL_META = {
    "username": {
        "label": "Username",
        "icon": (
            '<svg class="meta-credential-icon-svg" viewBox="0 0 24 24" '
            'aria-hidden="true" focusable="false">'
            '<path fill="currentColor" d="M12 12c2.761 0 5-2.239 5-5'
            's-2.239-5-5-5-5 2.239-5 5 2.239 5 5 5Zm0 2c-3.866 0-7'
            ' 2.239-7 5v3h14v-3c0-2.761-3.134-5-7-5Z"/>'
            "</svg>"
        ),
    },
    "password": {
        "label": "Password",
        "icon": (
            '<svg class="meta-credential-icon-svg" viewBox="0 0 24 24" '
            'aria-hidden="true" focusable="false">'
            '<path fill="currentColor" d="M7 10V7a5 5 0 0110 0v3h1a2'
            ' 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8a2 2 0 012-2'
            'h1zm2 0h6V7a3 3 0 00-6 0v3z"/>'
            "</svg>"
        ),
    },
}

_EMAIL_META = {
    "email": {
        "label": "Email",
        "icon": (
            '<svg class="meta-email-icon-svg" viewBox="0 0 24 24" '
            'aria-hidden="true" focusable="false">'
            '<path fill="currentColor" d="M4 4h16a2 2 0 012 2v12a2 2 '
            '0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm0 4.236V18h16V8.236'
            'l-7.4 5.18a1 1 0 01-1.2 0L4 8.236zm0-2.472l8 5.6 8-5.6V6H4v-.236z"/>'
            "</svg>"
        ),
    },
}

_STATUS_TAGS = frozenset({"todo", "done"})

_STATUS_META = {
    "todo": {
        "icon": (
            '<svg class="meta-status-icon-svg" viewBox="0 0 24 24" '
            'aria-hidden="true" focusable="false">'
            '<rect x="3" y="3" width="18" height="18" rx="3" ry="3" '
            'fill="none" stroke="currentColor" stroke-width="2" />'
            "</svg>"
        ),
    },
    "done": {
        "icon": (
            '<svg class="meta-status-icon-svg" viewBox="0 0 24 24" '
            'aria-hidden="true" focusable="false">'
            '<rect x="3" y="3" width="18" height="18" rx="3" ry="3" '
            'fill="none" stroke="currentColor" stroke-width="2" />'
            '<path d="M7 12l3 3 7-7" fill="none" stroke="currentColor" '
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />'
            "</svg>"
        ),
    },
}

_JSON_NUMBER_RE = re.compile(r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?")
_LATEX_PLACEHOLDER_PREFIX = "@@MLLATEX["
_LATEX_PLACEHOLDER_SUFFIX = "]@@"
_LATEX_PLACEHOLDER_RE = re.compile(r"@@MLLATEX\[([A-Za-z0-9+/=]+)\]@@")
_PLAIN_URL_RE = re.compile(r"https?://[^\s<]+", re.IGNORECASE)
_HTML_TAG_SPLIT_RE = re.compile(r"(<[^>]+>)")
_ANCHOR_START_TAG_RE = re.compile(r"<\s*a\b", re.IGNORECASE)
_ANCHOR_END_TAG_RE = re.compile(r"<\s*/\s*a\s*>", re.IGNORECASE)
_ANCHOR_HREF_ATTR_RE = re.compile(r'(\bhref\s*=\s*)(["\'])(.*?)\2', re.IGNORECASE)
_ANCHOR_TARGET_ATTR_RE = re.compile(r'(\btarget\s*=\s*)(["\'])(.*?)\2', re.IGNORECASE)
_ANCHOR_REL_ATTR_RE = re.compile(r'(\brel\s*=\s*)(["\'])(.*?)\2', re.IGNORECASE)
_URL_LABEL_ANCHOR_RE = re.compile(
    r'(?P<opener><a\b[^>]*>)(?P<label>https?://[^<]*)</a\s*>', re.IGNORECASE,
)
_NEW_TAB_REL_TOKENS = ("noopener", "noreferrer")
_BLOCK_HTML_TAG_RE = re.compile(
    r"<(?:blockquote|div|dl|fieldset|figure|figcaption|footer|form|h[1-6]|header|hr|li|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b",
    re.IGNORECASE,
)
_BLOCK_HTML_CLOSE_TAG_RE = re.compile(
    r"</(?:blockquote|div|dl|fieldset|figure|figcaption|footer|form|h[1-6]|header|li|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\s*>",
    re.IGNORECASE,
)
_SIZE_TAG_VALUE_RE = re.compile(r"(?:\d+(?:\.\d*)?|\.\d+)")
_CSV_IMAGE_PLACEHOLDER_PREFIX = "MLCSVIMAGEPLACEHOLDER"
_CSV_IMAGE_PLACEHOLDER_SUFFIX = "TOKEN"


def _canonical_meta_tag_name(tag_name: str) -> str:
    if not isinstance(tag_name, str) or tag_name == "":
        raise TypeError("tag_name must be a non-empty string")
    size_factor = _parse_size_factor(tag_name)
    if size_factor is None:
        return tag_name
    return f"size={_format_size_factor(size_factor)}"


def _parse_size_factor(tag_name: str) -> Decimal | None:
    if not isinstance(tag_name, str) or tag_name == "":
        raise TypeError("tag_name must be a non-empty string")
    if not tag_name.startswith("size="):
        return None
    raw_size_value = tag_name[len("size="):]
    if _SIZE_TAG_VALUE_RE.fullmatch(raw_size_value) is None:
        return None
    size_factor = Decimal(raw_size_value)
    if size_factor <= 0:
        return None
    return size_factor


def _format_size_factor(size_factor: Decimal) -> str:
    if not isinstance(size_factor, Decimal) or size_factor <= 0:
        raise TypeError("size_factor must be a positive Decimal")
    formatted = format(size_factor, "f")
    if "." in formatted:
        formatted = formatted.rstrip("0").rstrip(".")
    if formatted == "":
        raise AssertionError("Positive size factor formatted as empty text")
    return formatted


def _is_formatting_meta_tag_name(tag_name: str) -> bool:
    if not isinstance(tag_name, str) or tag_name == "":
        raise TypeError("tag_name must be a non-empty string")
    if tag_name in _META_TAG_TO_CLASS:
        return True
    return _parse_size_factor(tag_name) is not None


def list_known_meta_tag_terms() -> FrozenSet[str]:
    terms = {f"@{name}" for name in _META_TAG_TO_CLASS.keys()}
    terms.update(f"@{name}" for name in _SUGGESTED_SIZE_TAG_NAMES)
    terms.update(f"@{name}" for name in _LIST_STYLE_TAGS.keys())
    terms.update(f"@{name}" for name in _CREDENTIAL_TAGS)
    terms.update(f"@{name}" for name in _EMAIL_TAGS)
    terms.update(f"@{name}" for name in _STATUS_TAGS)
    terms.add("@markdown")
    terms.add("@llm")
    terms.add("@LaTeX")
    terms.add("@shell")
    terms.add("@json")
    terms.add("@csv")
    return frozenset(terms)


def find_global_credential_tag(tags: str) -> str | None:
    if not isinstance(tags, str):
        raise TypeError(f"tags must be a string, got {type(tags)}")
    return _find_global_credential_tag(tags)


def find_consumed_content_wrapper_keys(tags: str) -> FrozenSet[Tuple[str, int]]:
    if not isinstance(tags, str):
        raise TypeError(f"tags must be a string, got {type(tags)}")
    return _parse_meta_tags(tags).wrappers_to_consume


def remove_added_style_tags(tags: str) -> tuple[str, FrozenSet[Tuple[str, int]]]:
    if not isinstance(tags, str):
        raise TypeError(f"tags must be a string, got {type(tags)}")

    retained_tokens: List[str] = []
    removed_wrapper_keys: Set[Tuple[str, int]] = set()
    retained_wrapper_keys: Set[Tuple[str, int]] = set()

    for token in _tokenize_tag_bar_preserving_comments(tags):
        if token.startswith("/*"):
            retained_tokens.append(token)
            continue

        base, wrapper = _unwrap_tag_token(token)
        if wrapper is None:
            if _is_removable_formatting_tag(base):
                continue
            retained_tokens.append(token)
            continue

        inner_tokens = [inner for inner in base.split() if inner]
        retained_inner = [
            inner for inner in inner_tokens if not _is_removable_formatting_tag(inner)
        ]
        if len(retained_inner) == len(inner_tokens):
            retained_tokens.append(token)
            retained_wrapper_keys.add(wrapper)
            continue

        removed_wrapper_keys.add(wrapper)
        if retained_inner:
            opener, depth = wrapper
            open_token = opener * depth
            close_token = _OPEN_TO_CLOSE[opener] * depth
            retained_tokens.append(f"{open_token}{' '.join(retained_inner)}{close_token}")
            retained_wrapper_keys.add(wrapper)

    wrappers_to_remove = removed_wrapper_keys - retained_wrapper_keys
    return " ".join(retained_tokens), frozenset(wrappers_to_remove)


def remove_formatting_scope_delimiters(
    content_html: str,
    wrappers_to_remove: FrozenSet[Tuple[str, int]],
) -> str:
    if not isinstance(content_html, str):
        raise TypeError(f"content_html must be a string, got {type(content_html)}")
    if not isinstance(wrappers_to_remove, frozenset):
        raise TypeError("wrappers_to_remove must be a frozenset")
    if not wrappers_to_remove:
        return content_html

    for opener, depth in wrappers_to_remove:
        if opener not in _OPEN_TO_CLOSE:
            raise ValueError(f"Unsupported formatting scope opener: {opener}")
        if not isinstance(depth, int) or not 1 <= depth <= _MAX_DELIMITER_DEPTH:
            raise ValueError(f"Unsupported formatting scope depth: {depth}")

    return _apply_scoped_meta_tags(
        content_html=content_html,
        wrappers_to_consume=wrappers_to_remove,
        scoped_tags={},
        scoped_renderers={},
        preserve_latex_placeholders=False,
    )


def _is_removable_formatting_tag(token: str) -> bool:
    if not isinstance(token, str):
        raise TypeError(f"token must be a string, got {type(token)}")
    if not token.startswith("@"):
        return False
    tag_name = _canonical_meta_tag_name(token[1:].casefold())
    if tag_name in _REMOVABLE_FORMATTING_TAGS:
        return True
    return _parse_size_factor(tag_name) is not None


@dataclass(frozen=True, slots=True)
class MetaTagConfig:
    global_tags: FrozenSet[str]
    wrappers_to_consume: FrozenSet[Tuple[str, int]]
    scoped_tags: Mapping[Tuple[str, int], FrozenSet[str]]
    scoped_renderers: Mapping[Tuple[str, int], str]


def extract_note_text_for_agent(*, content_html: str, tags: str) -> tuple[str, bool]:
    """Return disclosure-safe plain text and whether content was withheld.

    Agent retrieval must never expose the value of a note tagged ``@password``.
    Search-redacted notes are excluded by the agent search tool before this helper
    is called; this function enforces the independent credential boundary.
    """
    if not isinstance(content_html, str):
        raise TypeError(f"content_html must be a string, got {type(content_html)}")
    if not isinstance(tags, str):
        raise TypeError(f"tags must be a string, got {type(tags)}")
    if _find_global_credential_tag(tags) == "password":
        return "[REDACTED: @password]", True
    return strip_html(content_html).strip(), False


def format_note_content_for_view(*, content_html: str, tags: str, redact_passwords: bool) -> str:
    if not isinstance(content_html, str):
        raise TypeError(f"content_html must be a string, got {type(content_html)}")
    if not isinstance(tags, str):
        raise TypeError(f"tags must be a string, got {type(tags)}")
    if not isinstance(redact_passwords, bool):
        raise TypeError(f"redact_passwords must be a bool, got {type(redact_passwords)}")

    footnotes: list[tuple[str, str]] = []
    output = _format_note_content_for_view(
        content_html=content_html, tags=tags, redact_passwords=redact_passwords,
        footnotes=footnotes,
    )
    if not footnotes or (redact_passwords and _find_global_credential_tag(tags) == "password"):
        return output
    return _linkify_view_links(finish_footnotes(output, footnotes, _render_footnote_url_titles))


def _format_note_content_for_view(
    *, content_html: str, tags: str, redact_passwords: bool,
    footnotes: list[tuple[str, str]],
) -> str:
    config = _parse_meta_tags(tags)
    config = _add_implied_meta_tags(tags=tags, config=config)
    config = MetaTagConfig(
        global_tags=config.global_tags - {"footnote"},
        wrappers_to_consume=config.wrappers_to_consume,
        scoped_tags=config.scoped_tags,
        scoped_renderers=config.scoped_renderers,
    )
    credential_tag = _find_global_credential_tag(tags)
    email_tag = _find_global_email_tag(tags)
    status_tag = _find_global_status_tag(tags)
    renderer_tag = _find_first_renderer_tag(tags)

    if (
        renderer_tag is None
        and not config.global_tags
        and not config.wrappers_to_consume
        and credential_tag is None
        and email_tag is None
        and status_tag is None
    ):
        return _linkify_view_links(content_html)

    output = content_html
    apply_wrappers = True
    if renderer_tag == "csv":
        apply_wrappers = False
    if apply_wrappers and config.wrappers_to_consume:
        preserve_latex_placeholders = renderer_tag == "markdown"
        output = _apply_scoped_meta_tags(
            content_html=output,
            wrappers_to_consume=config.wrappers_to_consume,
            scoped_tags=config.scoped_tags,
            scoped_renderers=config.scoped_renderers,
            preserve_latex_placeholders=preserve_latex_placeholders,
        )

    if any("footnote" in names for names in config.scoped_tags.values()):
        output, collected = collect_footnotes(output)
        footnotes.extend(collected)

    if renderer_tag is not None:
        if renderer_tag == "shell":
            return _render_shell_meta(
                content_html=output,
                formatting_tags=config.global_tags,
            )
        if renderer_tag == "markdown":
            return _render_markdown_meta(
                content_html=output,
                formatting_tags=config.global_tags,
            )
        if renderer_tag == "latex":
            return _render_latex_meta(
                content_html=output,
                formatting_tags=config.global_tags,
            )
        if renderer_tag == "json":
            return _render_json_meta(
                content_html=output,
                formatting_tags=config.global_tags,
            )
        if renderer_tag == "csv":
            return _render_csv_meta(
                content_html=output,
                formatting_tags=config.global_tags,
                inline=False,
                cell_wrappers=frozenset(),
                cell_scoped_tags={},
                cell_scoped_renderers={},
            )
        raise KeyError(f"Unknown renderer tag: {renderer_tag}")

    if credential_tag is not None:
        return _linkify_view_links(
            _render_credential_meta(
                content_html=output,
                credential_tag=credential_tag,
                formatting_tags=config.global_tags,
                redact_passwords=redact_passwords,
            )
        )

    if email_tag is not None:
        return _linkify_view_links(
            _render_email_meta(
                content_html=output,
                email_tag=email_tag,
                formatting_tags=config.global_tags,
            )
        )

    if status_tag is not None:
        return _linkify_view_links(
            _render_status_meta(
                content_html=output,
                status_tag=status_tag,
                formatting_tags=config.global_tags,
            )
        )

    if config.global_tags:
        copy_attr = ""
        if "copyable" in config.global_tags:
            plain_text = _extract_plain_text(output)
            copy_attr = _copyable_attr(config.global_tags, plain_text)
        output = _wrap_meta_html(
            inner_html=output,
            tag_names=config.global_tags,
            wrapper_class="meta-global",
            copy_attr=copy_attr,
            allow_block_wrapper=True,
        )

    return _linkify_view_links(output)


def _linkify_view_links(content_html: str) -> str:
    if not isinstance(content_html, str):
        raise TypeError(f"content_html must be a string, got {type(content_html)}")
    if content_html == "":
        return ""

    pieces = _HTML_TAG_SPLIT_RE.split(content_html)
    output: List[str] = []
    inside_anchor_depth = 0

    for piece in pieces:
        if piece == "":
            continue
        if piece.startswith("<") and piece.endswith(">"):
            normalized_tag = _normalize_anchor_tag(piece)
            output.append(normalized_tag)
            if _ANCHOR_END_TAG_RE.fullmatch(piece):
                if inside_anchor_depth > 0:
                    inside_anchor_depth -= 1
                continue
            if _ANCHOR_START_TAG_RE.match(piece):
                inside_anchor_depth += 1
            continue
        if inside_anchor_depth > 0:
            output.append(piece)
            continue
        output.append(_autolink_plain_urls_in_text(piece))

    return "".join(output)


def _autolink_plain_urls_in_text(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError(f"text must be a string, got {type(text)}")
    if text == "":
        return ""

    output: List[str] = []
    cursor = 0
    for match in _PLAIN_URL_RE.finditer(text):
        raw_url = match.group(0)
        link_text, trailing_suffix = _split_trailing_url_punctuation(raw_url)
        if link_text == "":
            continue
        output.append(text[cursor:match.start()])
        href_value = html.escape(html.unescape(link_text), quote=True)
        output.append(_render_plain_url_anchor(text=text, link_text=link_text, href_value=href_value))
        output.append(trailing_suffix)
        cursor = match.end()
    output.append(text[cursor:])
    return "".join(output)


def _render_plain_url_anchor(*, text: str, link_text: str, href_value: str) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(link_text, str) or link_text == "":
        raise TypeError("link_text must be a non-empty string")
    if not isinstance(href_value, str) or href_value == "":
        raise TypeError("href_value must be a non-empty string")

    stripped = text.strip()
    if stripped != link_text:
        return f'<a href="{href_value}" target="_blank" rel="noopener noreferrer">{link_text}</a>'

    decoded_url = html.unescape(link_text)
    title_html = render_standalone_link_title_html(decoded_url)
    if title_html is None:
        diagnostic = link_title_store.get_diagnostic(decoded_url)
        diagnostic_title_attr = ""
        if diagnostic is not None:
            escaped_diagnostic = html.escape(diagnostic.message, quote=True)
            diagnostic_title_attr = f' title="{escaped_diagnostic}"'
        return (
            f'<a href="{href_value}"{diagnostic_title_attr} '
            f'target="_blank" rel="noopener noreferrer">{link_text}</a>'
        )

    return (
        f'<a class="link-title" href="{href_value}" title="{href_value}" '
        'target="_blank" rel="noopener noreferrer">'
        f"{title_html}"
        "</a>"
    )


def _render_footnote_url_titles(content_html: str) -> str:
    return _URL_LABEL_ANCHOR_RE.sub(_render_footnote_url_title_match, content_html)


def _render_footnote_url_title_match(match: re.Match[str]) -> str:
    href_match = _ANCHOR_HREF_ATTR_RE.search(match.group("opener"))
    if href_match is None:
        return match.group(0)
    href = html.unescape(href_match.group(3))
    label = html.unescape(match.group("label"))
    if label != href:
        return match.group(0)
    escaped_url = html.escape(href, quote=True)
    return _render_plain_url_anchor(text=escaped_url, link_text=escaped_url, href_value=escaped_url)


def render_standalone_link_title_html(text: str) -> str | None:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    stripped = text.strip()
    if stripped == "":
        return None

    match = _PLAIN_URL_RE.fullmatch(stripped)
    if match is None:
        return None
    link_text, trailing_suffix = _split_trailing_url_punctuation(match.group(0))
    if link_text != stripped or trailing_suffix != "":
        return None

    title = link_title_store.get_ok_title(link_text)
    if title is None:
        link_title_store.maybe_enqueue_fetch(link_text)
        return None

    escaped_title = html.escape(title)
    escaped_domain = html.escape(display_domain_for_url(link_text))
    return (
        f'<span class="link-title-text">{escaped_title}</span>'
        f'<span class="link-title-domain"> · {escaped_domain}</span>'
    )


def _split_trailing_url_punctuation(raw_url: str) -> Tuple[str, str]:
    if not isinstance(raw_url, str):
        raise TypeError(f"raw_url must be a string, got {type(raw_url)}")
    if raw_url == "":
        return "", ""

    url_text = raw_url
    suffix = ""
    while url_text:
        last_char = url_text[-1]
        if last_char in {".", ",", "!", "?", ";", ":", "'", '"'}:
            suffix = last_char + suffix
            url_text = url_text[:-1]
            continue
        if last_char == ")":
            if url_text.count(")") > url_text.count("("):
                suffix = ")" + suffix
                url_text = url_text[:-1]
                continue
            break
        if last_char == "]":
            if url_text.count("]") > url_text.count("["):
                suffix = "]" + suffix
                url_text = url_text[:-1]
                continue
            break
        if last_char == "}":
            if url_text.count("}") > url_text.count("{"):
                suffix = "}" + suffix
                url_text = url_text[:-1]
                continue
            break
        break

    return url_text, suffix


def _normalize_anchor_tag(tag_html: str) -> str:
    if not isinstance(tag_html, str):
        raise TypeError(f"tag_html must be a string, got {type(tag_html)}")
    if not _ANCHOR_START_TAG_RE.match(tag_html):
        return tag_html

    href_match = _ANCHOR_HREF_ATTR_RE.search(tag_html)
    if href_match is None:
        return tag_html
    href_value = href_match.group(3)
    if href_value.startswith("#"):
        return tag_html

    normalized = _ensure_anchor_target_attr(tag_html)
    normalized = _ensure_anchor_rel_attr(normalized)
    return normalized


def _ensure_anchor_target_attr(tag_html: str) -> str:
    if _ANCHOR_TARGET_ATTR_RE.search(tag_html):
        return _ANCHOR_TARGET_ATTR_RE.sub(r'\1\2_blank\2', tag_html, count=1)
    if tag_html.endswith("/>"):
        return f'{tag_html[:-2]} target="_blank"/>'
    return f'{tag_html[:-1]} target="_blank">'


def _ensure_anchor_rel_attr(tag_html: str) -> str:
    rel_match = _ANCHOR_REL_ATTR_RE.search(tag_html)
    if rel_match is not None:
        existing_tokens = rel_match.group(3).split()
        merged_tokens = list(existing_tokens)
        for token in _NEW_TAB_REL_TOKENS:
            if token not in merged_tokens:
                merged_tokens.append(token)
        merged_value = " ".join(merged_tokens)
        return _ANCHOR_REL_ATTR_RE.sub(
            rf'\1\2{merged_value}\2',
            tag_html,
            count=1,
        )
    if tag_html.endswith("/>"):
        return f'{tag_html[:-2]} rel="noopener noreferrer"/>'
    return f'{tag_html[:-1]} rel="noopener noreferrer">'


def find_list_style(tags: str) -> str | None:
    if not isinstance(tags, str):
        raise TypeError("tags must be a string")

    list_style = None
    tokens = _tokenize_tag_bar(tags)
    for token in tokens:
        base, wrapper = _unwrap_tag_token(token)
        if wrapper is not None:
            continue
        if base.startswith("@"):
            tag_name = base[1:].casefold()
            if tag_name in _LIST_STYLE_TAGS:
                list_style = _LIST_STYLE_TAGS[tag_name]
    return list_style


def _add_implied_meta_tags(*, tags: str, config: MetaTagConfig) -> MetaTagConfig:
    if not isinstance(tags, str):
        raise TypeError("tags must be a string")
    if not isinstance(config, MetaTagConfig):
        raise TypeError("config must be a MetaTagConfig")

    ontology = get_ontology_if_ready()
    if ontology is None or ontology.is_empty:
        return config

    global_tags = set(config.global_tags)
    scoped_tags: Dict[Tuple[str, int], Set[str]] = {
        key: set(tag_names) for key, tag_names in config.scoped_tags.items()
    }
    for token in _tokenize_tag_bar(tags):
        base, wrapper = _unwrap_tag_token(token)
        source_terms = frozenset(
            term
            for term in base.split()
            if term and not term.startswith("@")
        )
        if not source_terms:
            continue
        implied_terms = ontology.infer_implication_only(base_tags=source_terms)
        implied_meta_tags: Set[str] = set()
        for term in implied_terms:
            if not term.startswith("@"):
                continue
            tag_name = _canonical_meta_tag_name(term[1:].casefold())
            if _is_formatting_meta_tag_name(tag_name):
                implied_meta_tags.add(tag_name)
        if not implied_meta_tags:
            continue
        if wrapper is None:
            global_tags.update(implied_meta_tags)
            continue
        assert wrapper in config.wrappers_to_consume
        if wrapper not in scoped_tags:
            scoped_tags[wrapper] = set()
        scoped_tags[wrapper].update(implied_meta_tags)

    return MetaTagConfig(
        global_tags=frozenset(global_tags),
        wrappers_to_consume=config.wrappers_to_consume,
        scoped_tags={
            key: frozenset(tag_names) for key, tag_names in scoped_tags.items()
        },
        scoped_renderers=config.scoped_renderers,
    )


def _find_first_renderer_tag(tags: str) -> str | None:
    tokens = _tokenize_tag_bar(tags)
    for token in tokens:
        base, wrapper = _unwrap_tag_token(token)
        if wrapper is not None:
            continue
        if not base.startswith("@"):
            continue
        tag_name = base[1:].casefold()
        if tag_name in _RENDERER_TAGS:
            return tag_name
    return None


def _find_global_credential_tag(tags: str) -> str | None:
    tokens = _tokenize_tag_bar(tags)
    found_password = False
    found_username = False
    for token in tokens:
        base, wrapper = _unwrap_tag_token(token)
        if wrapper is not None:
            continue
        if not base.startswith("@"):
            continue
        tag_name = base[1:].casefold()
        if tag_name == "password":
            found_password = True
            continue
        if tag_name == "username":
            found_username = True
            continue

    if found_password:
        return "password"
    if found_username:
        return "username"
    return None


def _find_global_email_tag(tags: str) -> str | None:
    tokens = _tokenize_tag_bar(tags)
    for token in tokens:
        base, wrapper = _unwrap_tag_token(token)
        if wrapper is not None:
            continue
        if base.casefold() == "@email":
            return "email"
    return None


def _render_credential_meta(
    *,
    content_html: str,
    credential_tag: str,
    formatting_tags: FrozenSet[str],
    redact_passwords: bool,
) -> str:
    if credential_tag not in _CREDENTIAL_TAGS:
        raise KeyError(f"Unknown credential meta tag: {credential_tag}")
    if not isinstance(redact_passwords, bool):
        raise TypeError(f"redact_passwords must be a bool, got {type(redact_passwords)}")

    credential_meta = _CREDENTIAL_META[credential_tag]
    label_text = credential_meta["label"]
    icon_html = credential_meta["icon"]

    value_text = strip_html(content_html)
    display_text = value_text
    if credential_tag == "password" and redact_passwords:
        display_text = "X" * len(value_text)
    escaped_value = html.escape(display_text, quote=True)

    extra_classes = ""
    if formatting_tags:
        extra_classes = _meta_classes_for_tag_names(formatting_tags)

    value_class = "meta-credential-value"
    if extra_classes:
        value_class = f"{value_class} {extra_classes}"
    size_style_attr = _meta_size_style_attr(formatting_tags)

    return (
        f'<div class="meta-credential meta-credential-{credential_tag}">'
        f'<span class="meta-credential-icon">{icon_html}</span>'
        f'<span class="meta-credential-label">{label_text}:</span>'
        f'<span class="{value_class}"{size_style_attr} data-copy-value="{escaped_value}">'
        f"{escaped_value}"
        "</span>"
        "</div>"
    )


def _render_email_meta(
    *,
    content_html: str,
    email_tag: str,
    formatting_tags: FrozenSet[str],
) -> str:
    if email_tag not in _EMAIL_TAGS:
        raise KeyError(f"Unknown email meta tag: {email_tag}")

    email_meta = _EMAIL_META[email_tag]
    label_text = email_meta["label"]
    icon_html = email_meta["icon"]

    value_text = strip_html(content_html)
    escaped_value = html.escape(value_text, quote=True)
    href_value = urllib.parse.quote(value_text, safe="@._+-")

    extra_classes = ""
    if formatting_tags:
        extra_classes = _meta_classes_for_tag_names(formatting_tags)

    value_class = "meta-email-value"
    if extra_classes:
        value_class = f"{value_class} {extra_classes}"
    size_style_attr = _meta_size_style_attr(formatting_tags)

    return (
        '<div class="meta-email">'
        f'<span class="meta-email-icon">{icon_html}</span>'
        f'<span class="meta-email-label">{label_text}:</span>'
        f'<a class="{value_class}"{size_style_attr} href="mailto:{href_value}">{escaped_value}</a>'
        "</div>"
    )


def _find_global_status_tag(tags: str) -> str | None:
    tokens = _tokenize_tag_bar(tags)
    found_todo = False
    found_done = False
    for token in tokens:
        base, wrapper = _unwrap_tag_token(token)
        if wrapper is not None:
            continue
        if not base.startswith("@"):
            continue
        tag_name = base[1:].casefold()
        if tag_name == "done":
            found_done = True
            continue
        if tag_name == "todo":
            found_todo = True
            continue

    if found_done:
        return "done"
    if found_todo:
        return "todo"
    return None


def _render_status_meta(
    *,
    content_html: str,
    status_tag: str,
    formatting_tags: FrozenSet[str],
) -> str:
    if status_tag not in _STATUS_TAGS:
        raise KeyError(f"Unknown status meta tag: {status_tag}")

    status_meta = _STATUS_META[status_tag]
    icon_html = status_meta["icon"]

    text_class = "meta-status-text"
    formatted_content = content_html
    if formatting_tags:
        if _should_use_box_wrapper(formatting_tags):
            formatted_content = _wrap_meta_html(
                inner_html=content_html,
                tag_names=formatting_tags,
                wrapper_class="meta-status-format",
                copy_attr="",
                allow_block_wrapper=True,
            )
        else:
            extra_classes = _meta_classes_for_tag_names(formatting_tags)
            if extra_classes:
                text_class = f"{text_class} {extra_classes}"

    return (
        f'<div class="meta-status meta-status-{status_tag}">'
        f'<span class="meta-status-toggle" data-status="{status_tag}">{icon_html}</span>'
        f'<div class="{text_class}">{formatted_content}</div>'
        "</div>"
    )


def _render_shell_meta(*, content_html: str, formatting_tags: FrozenSet[str]) -> str:
    raw_text = _extract_plain_text(content_html)
    escaped_text = html.escape(raw_text, quote=False)
    copy_attr = _copyable_attr(formatting_tags, raw_text)

    extra_classes = ""
    if formatting_tags:
        extra_classes = _meta_classes_for_tag_names(formatting_tags)

    code_class = "meta-shell-code"
    if extra_classes:
        code_class = f"{code_class} {extra_classes}"
    size_style_attr = _meta_size_style_attr(formatting_tags)

    return (
        f'<div class="meta-shell"{copy_attr}>'
        f'<pre class="meta-shell-script"><code class="{code_class}"{size_style_attr}>{escaped_text}</code></pre>'
        '<div class="meta-shell-output" aria-live="polite"></div>'
        "</div>"
    )


def _render_markdown_meta(*, content_html: str, formatting_tags: FrozenSet[str]) -> str:
    raw_text = _extract_plain_text(content_html)
    copy_attr = _copyable_attr(formatting_tags, raw_text)
    rendered_markdown = render_markdown_to_html(raw_text)
    rendered_markdown = _replace_latex_placeholders(rendered_markdown)

    extra_classes = ""
    if formatting_tags:
        extra_classes = _meta_classes_for_tag_names(formatting_tags)

    block_class = "meta-markdown"
    if extra_classes:
        block_class = f"{block_class} {extra_classes}"
    size_style_attr = _meta_size_style_attr(formatting_tags)

    return (
        f'<div class="{block_class}"{size_style_attr} data-markdown-rendered="true"{copy_attr}>'
        f"{_linkify_view_links(rendered_markdown)}"
        "</div>"
    )


def _render_latex_meta(*, content_html: str, formatting_tags: FrozenSet[str]) -> str:
    raw_text = _extract_plain_text(content_html)
    return _render_latex_container(
        raw_text=raw_text,
        formatting_tags=formatting_tags,
        wrapper_tag="div",
    )


def _render_json_meta(*, content_html: str, formatting_tags: FrozenSet[str]) -> str:
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

    extra_classes = ""
    if formatting_tags:
        extra_classes = _meta_classes_for_tag_names(formatting_tags)

    code_class = "meta-json-code"
    if extra_classes:
        code_class = f"{code_class} {extra_classes}"
    size_style_attr = _meta_size_style_attr(formatting_tags)

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
        parse_text, placeholder_map = _extract_wrapper_placeholders(
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

    extra_classes = ""
    if formatting_tags:
        extra_classes = _meta_classes_for_tag_names(formatting_tags)

    table_class = "meta-csv-table"
    if extra_classes:
        table_class = f"{table_class} {extra_classes}"
    size_style_attr = _meta_size_style_attr(formatting_tags)

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
                cell_text = _restore_wrapper_placeholders(cell_text, placeholder_map)
            if apply_cell_wrappers:
                cell_html = _apply_scoped_meta_tags_to_plain_text(
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


def _render_scoped_renderer(
    *,
    render_tag: str,
    content_html: str,
    formatting_tags: FrozenSet[str],
    wrappers_to_consume: FrozenSet[Tuple[str, int]],
    scoped_tags: Mapping[Tuple[str, int], FrozenSet[str]],
    scoped_renderers: Mapping[Tuple[str, int], str],
    render_key: Tuple[str, int] | None,
    preserve_latex_placeholders: bool,
) -> str:
    if render_tag == "latex":
        raw_text = _extract_plain_text(content_html)
        rendered_html = _render_latex_container(
            raw_text=raw_text,
            formatting_tags=formatting_tags,
            wrapper_tag="span",
        )
        if preserve_latex_placeholders:
            return _encode_latex_placeholder(rendered_html)
        return rendered_html
    if render_tag == "csv":
        filtered_wrappers = wrappers_to_consume
        filtered_scoped = scoped_tags
        filtered_renderers = scoped_renderers
        if render_key is not None:
            filtered_wrappers = frozenset(
                key for key in wrappers_to_consume if key != render_key
            )
            filtered_scoped = {
                key: value for key, value in scoped_tags.items() if key != render_key
            }
            filtered_renderers = {
                key: value for key, value in scoped_renderers.items() if key != render_key
            }
        return _render_csv_meta(
            content_html=content_html,
            formatting_tags=formatting_tags,
            inline=True,
            cell_wrappers=filtered_wrappers,
            cell_scoped_tags=filtered_scoped,
            cell_scoped_renderers=filtered_renderers,
        )
    if render_tag == "markdown":
        return _render_markdown_meta(
            content_html=content_html,
            formatting_tags=formatting_tags,
        )
    if render_tag == "json":
        return _render_json_meta(
            content_html=content_html,
            formatting_tags=formatting_tags,
        )
    if render_tag == "shell":
        return _render_shell_meta(
            content_html=content_html,
            formatting_tags=formatting_tags,
        )
    raise KeyError(f"Unknown scoped renderer: {render_tag}")


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


def _should_use_box_wrapper(tag_names: Set[str] | FrozenSet[str]) -> bool:
    if "strikethrough" in tag_names or "highlighter" in tag_names:
        return True
    return any(tag_name.startswith("size=") for tag_name in tag_names)


def _requires_layout_box(tag_names: Set[str] | FrozenSet[str]) -> bool:
    return any(tag_name.startswith("size=") for tag_name in tag_names)


def _html_contains_block_elements(content_html: str) -> bool:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    return _BLOCK_HTML_TAG_RE.search(content_html) is not None


def _wrap_meta_html(
    *,
    inner_html: str,
    tag_names: Set[str] | FrozenSet[str],
    wrapper_class: str,
    copy_attr: str,
    allow_block_wrapper: bool,
) -> str:
    if not isinstance(inner_html, str):
        raise TypeError("inner_html must be a string")
    if not isinstance(wrapper_class, str) or wrapper_class == "":
        raise TypeError("wrapper_class must be a non-empty string")
    if not isinstance(copy_attr, str):
        raise TypeError("copy_attr must be a string")

    classes = _meta_classes_for_tag_names(tag_names)
    if classes == "":
        raise AssertionError("Formatted wrapper requires at least one CSS class")

    class_names: List[str] = [wrapper_class]
    wrapper_tag = "span"
    if _should_use_box_wrapper(tag_names):
        if allow_block_wrapper and _html_contains_block_elements(inner_html):
            wrapper_tag = "div"
            class_names.append("meta-box-block")
        else:
            class_names.append("meta-box-inline")
    class_names.append(classes)
    class_attr = " ".join(class_names)
    size_style_attr = _meta_size_style_attr(tag_names)
    return (
        f'<{wrapper_tag} class="{class_attr}"{size_style_attr}{copy_attr}>'
        f"{inner_html}</{wrapper_tag}>"
    )


def _encode_latex_placeholder(rendered_html: str) -> str:
    if not isinstance(rendered_html, str):
        raise TypeError("rendered_html must be a string")
    encoded = base64.b64encode(rendered_html.encode("utf-8")).decode("ascii")
    return f"{_LATEX_PLACEHOLDER_PREFIX}{encoded}{_LATEX_PLACEHOLDER_SUFFIX}"


def _replace_latex_placeholders(html_text: str) -> str:
    if not isinstance(html_text, str):
        raise TypeError("html_text must be a string")

    def replace_match(match: re.Match[str]) -> str:
        encoded_html = match.group(1)
        decoded_html = base64.b64decode(encoded_html.encode("ascii")).decode("utf-8")
        return decoded_html

    return _LATEX_PLACEHOLDER_RE.sub(replace_match, html_text)


def _parse_meta_tags(tags: str) -> MetaTagConfig:
    tokens = _tokenize_tag_bar(tags)
    global_tags: Set[str] = set()
    wrappers_to_consume: Set[Tuple[str, int]] = set()
    scoped: Dict[Tuple[str, int], Set[str]] = {}
    scoped_renderers: Dict[Tuple[str, int], str] = {}

    for token in tokens:
        base, wrapper = _unwrap_tag_token(token)
        if wrapper is None:
            if not base.startswith("@"):
                continue
            tag_name = _canonical_meta_tag_name(base[1:].casefold())
            if not _is_formatting_meta_tag_name(tag_name):
                continue
            if tag_name == "footnote":
                continue
            global_tags.add(tag_name)
            continue

        inner_tokens = [inner for inner in base.split() if inner]
        if not inner_tokens:
            continue

        opener, depth = wrapper
        key = (opener, depth)
        wrappers_to_consume.add(key)
        for inner in inner_tokens:
            if not inner.startswith("@"):
                continue
            tag_name = _canonical_meta_tag_name(inner[1:].casefold())
            if not _is_formatting_meta_tag_name(tag_name):
                if tag_name in _RENDERER_TAGS:
                    existing = None
                    if key in scoped_renderers:
                        existing = scoped_renderers[key]
                    if existing is not None and existing != tag_name:
                        raise ValueError(
                            f"Wrapper {key} has conflicting scoped renderers: {existing} vs {tag_name}"
                        )
                    scoped_renderers[key] = tag_name
                continue
            if key not in scoped:
                scoped[key] = set()
            scoped[key].add(tag_name)

    frozen_scoped: Dict[Tuple[str, int], FrozenSet[str]] = {
        key: frozenset(value) for key, value in scoped.items()
    }
    return MetaTagConfig(
        global_tags=frozenset(global_tags),
        wrappers_to_consume=frozenset(wrappers_to_consume),
        scoped_tags=frozen_scoped,
        scoped_renderers=dict(scoped_renderers),
    )


def _tokenize_tag_bar(tags: str) -> List[str]:
    tokens: List[str] = []
    index = 0
    while index < len(tags):
        while index < len(tags) and tags[index].isspace():
            index += 1
        if index >= len(tags):
            break

        if tags.startswith("/*", index):
            end = tags.find("*/", index + 2)
            if end == -1:
                break
            index = end + 2
            continue

        start = index
        opener = tags[index]
        if opener in _OPEN_TO_CLOSE:
            opener_run = 1
            while index + opener_run < len(tags) and tags[index + opener_run] == opener:
                opener_run += 1
            if opener_run <= _MAX_DELIMITER_DEPTH:
                closer = _OPEN_TO_CLOSE[opener]
                needle = closer * opener_run
                close_at = tags.find(needle, index + opener_run)
                if close_at != -1:
                    index = close_at + opener_run
                    token = tags[start:index]
                    if token:
                        tokens.append(token)
                    continue

        while index < len(tags) and not tags[index].isspace():
            index += 1
        token = tags[start:index]
        if token:
            tokens.append(token)
    return tokens


def note_tags_include(tags: str, expected_tag: str) -> bool:
    if not isinstance(tags, str):
        raise TypeError("tags must be a string")
    if not isinstance(expected_tag, str) or expected_tag == "":
        raise TypeError("expected_tag must be a non-empty string")
    expected_key = expected_tag.casefold()
    return any(token.casefold() == expected_key for token in _tokenize_tag_bar(tags))


def _tokenize_tag_bar_preserving_comments(tags: str) -> List[str]:
    tokens: List[str] = []
    index = 0
    while index < len(tags):
        while index < len(tags) and tags[index].isspace():
            index += 1
        if index >= len(tags):
            break

        start = index
        if tags.startswith("/*", index):
            end = tags.find("*/", index + 2)
            if end == -1:
                tokens.append(tags[start:])
                break
            index = end + 2
            tokens.append(tags[start:index])
            continue

        opener = tags[index]
        if opener in _OPEN_TO_CLOSE:
            opener_run = 1
            while index + opener_run < len(tags) and tags[index + opener_run] == opener:
                opener_run += 1
            if opener_run <= _MAX_DELIMITER_DEPTH:
                closer = _OPEN_TO_CLOSE[opener]
                needle = closer * opener_run
                close_at = tags.find(needle, index + opener_run)
                if close_at != -1:
                    index = close_at + opener_run
                    tokens.append(tags[start:index])
                    continue

        while index < len(tags) and not tags[index].isspace():
            index += 1
        tokens.append(tags[start:index])
    return tokens


def _unwrap_tag_token(token: str) -> Tuple[str, Tuple[str, int] | None]:
    if not token:
        return token, None

    opener = token[0]
    if opener not in _OPEN_TO_CLOSE:
        return token, None

    opener_run = 1
    while opener_run < len(token) and token[opener_run] == opener:
        opener_run += 1
    if opener_run > _MAX_DELIMITER_DEPTH:
        return token, None
    depth = opener_run

    closer = _OPEN_TO_CLOSE[opener]
    if len(token) < depth * 2:
        return token, None

    if token[-1] != closer:
        return token, None

    closer_run = 1
    while closer_run < len(token) and token[-(closer_run + 1)] == closer:
        closer_run += 1
    if closer_run != depth:
        return token, None

    if token[-depth:] != closer * depth:
        return token, None

    inner = token[depth:-depth]
    if not inner:
        return token, None

    return inner, (opener, depth)


@dataclass(slots=True)
class _OpenFrame:
    opener: str
    closer: str
    depth: int
    placeholder_index: int
    opener_text: str
    open_html: str
    block_open_html: str
    close_html: str
    render_tag: str | None
    formatting_tags: FrozenSet[str] | None
    render_key: Tuple[str, int] | None
    renderer_nested_delimiter_depth: int
    was_crossed: bool
    block_close_placeholder_indices: List[int]
    block_open_placeholder_indices: List[int]


def _apply_scoped_meta_tags(
    *,
    content_html: str,
    wrappers_to_consume: FrozenSet[Tuple[str, int]],
    scoped_tags: Mapping[Tuple[str, int], FrozenSet[str]],
    scoped_renderers: Mapping[Tuple[str, int], str],
    preserve_latex_placeholders: bool,
) -> str:
    parts = re.split(r"(<[^>]+>)", content_html)
    output: List[str] = []
    stack: List[_OpenFrame] = []
    suspended_formatting_frames: List[_OpenFrame] = []

    for part in parts:
        if part.startswith("<") and part.endswith(">"):
            if _BLOCK_HTML_CLOSE_TAG_RE.fullmatch(part) is not None:
                has_active_renderer = any(frame.render_tag is not None for frame in stack)
                if not suspended_formatting_frames and not has_active_renderer:
                    suspended_formatting_frames = [
                        frame
                        for frame in stack
                        if frame.render_tag is None and frame.open_html != ""
                    ]
                    for frame in reversed(suspended_formatting_frames):
                        placeholder_index = len(output)
                        output.append("")
                        frame.block_close_placeholder_indices.append(placeholder_index)
            output.append(part)
            continue
        if suspended_formatting_frames and part.strip() != "":
            live_suspended_frames = [
                frame
                for frame in suspended_formatting_frames
                if any(active_frame is frame for active_frame in stack)
            ]
            for frame in live_suspended_frames:
                placeholder_index = len(output)
                output.append("")
                frame.block_open_placeholder_indices.append(placeholder_index)
            suspended_formatting_frames = []
        _process_text_segment(
            text=part,
            output=output,
            stack=stack,
            wrappers_to_consume=wrappers_to_consume,
            scoped_tags=scoped_tags,
            scoped_renderers=scoped_renderers,
            escape_text=False,
            preserve_latex_placeholders=preserve_latex_placeholders,
        )

    for frame in stack:
        output[frame.placeholder_index] = frame.opener_text

    return "".join(output)


def _apply_scoped_meta_tags_to_plain_text(
    *,
    text: str,
    wrappers_to_consume: FrozenSet[Tuple[str, int]],
    scoped_tags: Mapping[Tuple[str, int], FrozenSet[str]],
    scoped_renderers: Mapping[Tuple[str, int], str],
    preserve_latex_placeholders: bool,
) -> str:
    output: List[str] = []
    stack: List[_OpenFrame] = []
    _process_text_segment(
        text=text,
        output=output,
        stack=stack,
        wrappers_to_consume=wrappers_to_consume,
        scoped_tags=scoped_tags,
        scoped_renderers=scoped_renderers,
        escape_text=True,
        preserve_latex_placeholders=preserve_latex_placeholders,
    )
    for frame in stack:
        output[frame.placeholder_index] = frame.opener_text
    return "".join(output)


def _process_text_segment(
    *,
    text: str,
    output: List[str],
    stack: List[_OpenFrame],
    wrappers_to_consume: FrozenSet[Tuple[str, int]],
    scoped_tags: Mapping[Tuple[str, int], FrozenSet[str]],
    scoped_renderers: Mapping[Tuple[str, int], str],
    escape_text: bool,
    preserve_latex_placeholders: bool,
) -> None:
    index = 0
    while index < len(text):
        char = text[index]
        active_renderer: _OpenFrame | None = None
        for frame in reversed(stack):
            if frame.render_tag is not None:
                active_renderer = frame
                break
        if active_renderer is not None:
            if active_renderer.render_tag == "latex":
                index = _process_active_latex_renderer_text(
                    text=text,
                    index=index,
                    output=output,
                    stack=stack,
                    active_renderer=active_renderer,
                    wrappers_to_consume=wrappers_to_consume,
                    scoped_tags=scoped_tags,
                    scoped_renderers=scoped_renderers,
                    escape_text=escape_text,
                    preserve_latex_placeholders=preserve_latex_placeholders,
                )
                continue
            run = 1
            if char in _OPEN_TO_CLOSE or char in _CLOSE_TO_OPEN:
                run = _count_run(text=text, index=index, char=char)
            if char in _CLOSE_TO_OPEN:
                if run <= _MAX_DELIMITER_DEPTH:
                    if active_renderer.closer == char and active_renderer.depth == run:
                        _close_active_renderer(
                            output=output,
                            stack=stack,
                            active_renderer=active_renderer,
                            wrappers_to_consume=wrappers_to_consume,
                            scoped_tags=scoped_tags,
                            scoped_renderers=scoped_renderers,
                            preserve_latex_placeholders=preserve_latex_placeholders,
                        )
                        index += run
                        continue
            segment = text[index : index + run]
            _append_output_segment(
                output=output,
                segment=segment,
                escape_text=escape_text,
            )
            index += run
            continue
        if char in _OPEN_TO_CLOSE:
            run = _count_run(text=text, index=index, char=char)
            if run <= _MAX_DELIMITER_DEPTH and (char, run) in wrappers_to_consume:
                key = (char, run)
                open_html = ""
                block_open_html = ""
                close_html = ""
                render_tag = None
                formatting_tags = None
                render_key = None
                if key in scoped_renderers:
                    render_tag = scoped_renderers[key]
                    if key in scoped_tags:
                        formatting_tags = scoped_tags[key]
                    else:
                        formatting_tags = frozenset()
                    render_key = key
                if key in scoped_tags:
                    formatting_tags = scoped_tags[key]
                    classes = _meta_classes_for_tag_names(scoped_tags[key])
                    assert classes, "Scoped meta tags must resolve to at least one CSS class"
                    size_style_attr = _meta_size_style_attr(scoped_tags[key])
                    class_names = ["meta-scope"]
                    if _should_use_box_wrapper(scoped_tags[key]):
                        class_names.append("meta-box-inline")
                    class_names.append(classes)
                    class_attr = " ".join(class_names)
                    scope_attr = ""
                    if "footnote" in formatting_tags:
                        scope_attr = f' data-footnote-scope="{len(output)}"'
                    open_html = f'<span class="meta-scope {classes}"{size_style_attr}{scope_attr}>'
                    block_open_html = f'<span class="{class_attr}"{size_style_attr}{scope_attr}>'
                    close_html = "</span>"
                opener_text = text[index : index + run]
                placeholder_index = len(output)
                output.append("")
                stack.append(
                    _OpenFrame(
                        opener=char,
                        closer=_OPEN_TO_CLOSE[char],
                        depth=run,
                        placeholder_index=placeholder_index,
                        opener_text=opener_text,
                        open_html=open_html,
                        block_open_html=block_open_html,
                        close_html=close_html,
                        render_tag=render_tag,
                        formatting_tags=formatting_tags,
                        render_key=render_key,
                        renderer_nested_delimiter_depth=0,
                        was_crossed=False,
                        block_close_placeholder_indices=[],
                        block_open_placeholder_indices=[],
                    )
                )
                index += run
                continue
            segment = text[index : index + run]
            _append_output_segment(
                output=output,
                segment=segment,
                escape_text=escape_text,
            )
            index += run
            continue

        if char in _CLOSE_TO_OPEN:
            run = _count_run(text=text, index=index, char=char)
            if run <= _MAX_DELIMITER_DEPTH and stack:
                matching_index = None
                for stack_index in range(len(stack) - 1, -1, -1):
                    candidate = stack[stack_index]
                    if candidate.closer == char and candidate.depth == run:
                        matching_index = stack_index
                        break
                if matching_index is not None and matching_index < len(stack) - 1:
                    crossing_frames = stack[matching_index + 1 :]
                    matching_frame = stack[matching_index]
                    crossing_has_renderer = any(
                        frame.render_tag is not None
                        for frame in stack[matching_index:]
                    )
                    if not crossing_has_renderer:
                        for frame in reversed(crossing_frames):
                            frame.was_crossed = True
                            _materialize_frame_html(output=output, frame=frame)
                            output.append(frame.close_html)
                        _materialize_frame_html(output=output, frame=matching_frame)
                        output.append(matching_frame.close_html)
                        for frame in crossing_frames:
                            output.append(frame.open_html)
                        del stack[matching_index]
                        index += run
                        continue
                if matching_index == len(stack) - 1:
                    top = stack[-1]
                    stack.pop()
                    if (
                        top.render_tag is None
                        and top.formatting_tags is not None
                        and not top.was_crossed
                        and not top.block_close_placeholder_indices
                        and "footnote" not in top.formatting_tags
                        and _should_use_box_wrapper(top.formatting_tags)
                    ):
                        inner_parts = output[top.placeholder_index + 1 :]
                        inner_html = "".join(inner_parts)
                        if (
                            not _html_contains_block_elements(inner_html)
                            or _requires_layout_box(top.formatting_tags)
                        ):
                            rendered = _wrap_meta_html(
                                inner_html=inner_html,
                                tag_names=top.formatting_tags,
                                wrapper_class="meta-scope",
                                copy_attr="",
                                allow_block_wrapper=_requires_layout_box(top.formatting_tags),
                            )
                            del output[top.placeholder_index :]
                            output.append(rendered)
                            index += run
                            continue
                    _materialize_frame_html(output=output, frame=top)
                    output.append(top.close_html)
                    index += run
                    continue
            segment = text[index : index + run]
            _append_output_segment(
                output=output,
                segment=segment,
                escape_text=escape_text,
            )
            index += run
            continue

        _append_output_segment(
            output=output,
            segment=char,
            escape_text=escape_text,
        )
        index += 1


def _materialize_frame_html(*, output: List[str], frame: _OpenFrame) -> None:
    if not isinstance(output, list):
        raise TypeError("output must be a list")
    if not isinstance(frame, _OpenFrame):
        raise TypeError("frame must be an _OpenFrame")
    initial_open_html = frame.open_html
    if frame.block_close_placeholder_indices:
        initial_open_html = frame.block_open_html
    output[frame.placeholder_index] = initial_open_html
    for placeholder_index in frame.block_close_placeholder_indices:
        output[placeholder_index] = frame.close_html
    for placeholder_index in frame.block_open_placeholder_indices:
        output[placeholder_index] = frame.block_open_html


def _process_active_latex_renderer_text(
    *,
    text: str,
    index: int,
    output: List[str],
    stack: List[_OpenFrame],
    active_renderer: _OpenFrame,
    wrappers_to_consume: FrozenSet[Tuple[str, int]],
    scoped_tags: Mapping[Tuple[str, int], FrozenSet[str]],
    scoped_renderers: Mapping[Tuple[str, int], str],
    escape_text: bool,
    preserve_latex_placeholders: bool,
) -> int:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    if not isinstance(index, int):
        raise TypeError("index must be an int")

    char = text[index]
    if char == active_renderer.opener:
        active_renderer.renderer_nested_delimiter_depth += 1
        _append_output_segment(
            output=output,
            segment=char,
            escape_text=escape_text,
        )
        return index + 1

    if char == active_renderer.closer:
        if active_renderer.renderer_nested_delimiter_depth > 0:
            active_renderer.renderer_nested_delimiter_depth -= 1
            _append_output_segment(
                output=output,
                segment=char,
                escape_text=escape_text,
            )
            return index + 1
        if text.startswith(active_renderer.closer * active_renderer.depth, index):
            _close_active_renderer(
                output=output,
                stack=stack,
                active_renderer=active_renderer,
                wrappers_to_consume=wrappers_to_consume,
                scoped_tags=scoped_tags,
                scoped_renderers=scoped_renderers,
                preserve_latex_placeholders=preserve_latex_placeholders,
            )
            return index + active_renderer.depth
        _append_output_segment(
            output=output,
            segment=char,
            escape_text=escape_text,
        )
        return index + 1

    _append_output_segment(
        output=output,
        segment=char,
        escape_text=escape_text,
    )
    return index + 1


def _close_active_renderer(
    *,
    output: List[str],
    stack: List[_OpenFrame],
    active_renderer: _OpenFrame,
    wrappers_to_consume: FrozenSet[Tuple[str, int]],
    scoped_tags: Mapping[Tuple[str, int], FrozenSet[str]],
    scoped_renderers: Mapping[Tuple[str, int], str],
    preserve_latex_placeholders: bool,
) -> None:
    stack.pop()
    inner_parts = output[active_renderer.placeholder_index + 1 :]
    inner_html = "".join(inner_parts)
    formatting_tags = active_renderer.formatting_tags
    if formatting_tags is None:
        formatting_tags = frozenset()
    rendered = _render_scoped_renderer(
        render_tag=active_renderer.render_tag,
        content_html=inner_html,
        formatting_tags=formatting_tags,
        wrappers_to_consume=wrappers_to_consume,
        scoped_tags=scoped_tags,
        scoped_renderers=scoped_renderers,
        render_key=active_renderer.render_key,
        preserve_latex_placeholders=preserve_latex_placeholders,
    )
    del output[active_renderer.placeholder_index :]
    output.append(rendered)


def _append_output_segment(
    *,
    output: List[str],
    segment: str,
    escape_text: bool,
) -> None:
    if not isinstance(segment, str):
        raise TypeError("segment must be a string")
    if escape_text:
        output.append(html.escape(segment, quote=False))
        return
    output.append(segment)


def _count_run(*, text: str, index: int, char: str) -> int:
    run = 1
    while index + run < len(text) and text[index + run] == char:
        run += 1
    return run


def _extract_wrapper_placeholders(
    *,
    text: str,
    wrappers_to_consume: FrozenSet[Tuple[str, int]],
) -> tuple[str, Dict[str, str]]:
    if not isinstance(text, str):
        raise TypeError("text must be a string")

    if not wrappers_to_consume:
        return text, {}

    output: List[str] = []
    placeholders: Dict[str, str] = {}
    stack: List[Dict[str, object]] = []
    index = 0
    placeholder_index = 0

    while index < len(text):
        char = text[index]

        if char in _OPEN_TO_CLOSE:
            run = _count_run(text=text, index=index, char=char)
            key = (char, run)
            if run <= _MAX_DELIMITER_DEPTH and key in wrappers_to_consume:
                stack.append({
                    "opener": char,
                    "closer": _OPEN_TO_CLOSE[char],
                    "depth": run,
                    "content": [],
                })
                index += run
                continue

        if char in _CLOSE_TO_OPEN:
            run = _count_run(text=text, index=index, char=char)
            if run <= _MAX_DELIMITER_DEPTH and stack:
                top = stack[-1]
                if top["closer"] == char and top["depth"] == run:
                    stack.pop()
                    inner = "".join(top["content"])
                    opener_text = str(top["opener"]) * int(top["depth"])
                    closer_text = char * run
                    original = f"{opener_text}{inner}{closer_text}"
                    placeholder = f"@@CSV_WRAPPER_{placeholder_index}@@"
                    placeholder_index += 1
                    placeholders[placeholder] = original
                    if stack:
                        stack[-1]["content"].append(placeholder)
                    else:
                        output.append(placeholder)
                    index += run
                    continue

        if stack:
            target = stack[-1]["content"]
        else:
            target = output
        target.append(char)
        index += 1

    if stack:
        return text, {}

    return "".join(output), placeholders


def _restore_wrapper_placeholders(text: str, placeholders: Dict[str, str]) -> str:
    if not placeholders:
        return text

    output = text
    replaced = True
    while replaced:
        replaced = False
        for key, value in placeholders.items():
            if key in output:
                output = output.replace(key, value)
                replaced = True
    return output


def _meta_classes_for_tag_names(tag_names: Set[str] | FrozenSet[str]) -> str:
    classes: List[str] = []
    for name in sorted(tag_names):
        size_factor = _parse_size_factor(name)
        if size_factor is not None:
            classes.append("meta-size")
            continue
        if name not in _META_TAG_TO_CLASS:
            raise KeyError(f"Unknown meta tag name: {name}")
        css_class = _META_TAG_TO_CLASS[name]
        classes.append(css_class)
    return " ".join(classes)


def _meta_size_style_attr(tag_names: Set[str] | FrozenSet[str]) -> str:
    size_factors: List[Decimal] = []
    for tag_name in tag_names:
        size_factor = _parse_size_factor(tag_name)
        if size_factor is not None:
            size_factors.append(size_factor)
    if not size_factors:
        return ""
    effective_size_factor = max(size_factors)
    factor_text = _format_size_factor(effective_size_factor)
    return f' style="--meta-size-factor:{factor_text}"'


def _render_latex_container(
    *,
    raw_text: str,
    formatting_tags: FrozenSet[str],
    wrapper_tag: str,
) -> str:
    if not isinstance(raw_text, str):
        raise TypeError("raw_text must be a string")
    if not isinstance(wrapper_tag, str) or wrapper_tag == "":
        raise TypeError("wrapper_tag must be a non-empty string")

    copy_attr = _copyable_attr(formatting_tags, raw_text)
    render_result = render_latex_to_html(raw_text)

    class_names = ["meta-latex"]
    if render_result.has_error:
        class_names.append("meta-latex-error")
    elif wrapper_tag == "span" and 'display="block"' not in render_result.html:
        class_names.append("meta-latex-inline")
    else:
        class_names.append("meta-latex-display")

    if formatting_tags:
        class_names.append(_meta_classes_for_tag_names(formatting_tags))

    class_attr = " ".join(class_names)
    size_style_attr = _meta_size_style_attr(formatting_tags)
    return (
        f'<{wrapper_tag} class="{class_attr}"{size_style_attr}{copy_attr}>'
        f"{render_result.html}</{wrapper_tag}>"
    )
