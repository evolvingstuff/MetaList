from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

import nh3


_POLICY_PATH = Path(__file__).resolve().parents[1] / "static" / "note-html-policy.json"
_DATA_IMAGE_PATTERN = re.compile(
    r"^data:image/(?:png|jpe?g|gif|webp|bmp|avif);base64,([a-z0-9+/=\s]+)$",
    re.IGNORECASE,
)
_DANGEROUS_STYLE_PATTERN = re.compile(
    r"(?:url\s*\(|expression\s*\(|@import|-moz-binding|behavior\s*:|javascript:|vbscript:|data:text/html|data:application/)",
    re.IGNORECASE,
)
_DISALLOWED_STYLE_CHARS_PATTERN = re.compile(r"[<>`]")
_TEXT_STYLE_PROPERTIES = frozenset(
    {
        "white-space",
        "font-weight",
        "font-style",
        "text-decoration",
        "text-decoration-line",
        "vertical-align",
    }
)
_LENGTH_PATTERN = re.compile(r"^(?:0|(?:\d+(?:\.\d+)?)(?:px|em|rem|%|vh|vw))$", re.IGNORECASE)
_IMAGE_LENGTH_PATTERN = re.compile(
    r"^(?:auto|0|(?:\d+(?:\.\d+)?)(?:px|em|rem|%|vh|vw))$",
    re.IGNORECASE,
)
_FONT_WEIGHT_PATTERN = re.compile(r"^(?:normal|bold|bolder|lighter|[1-9]00)$", re.IGNORECASE)
_VERTICAL_ALIGN_PATTERN = re.compile(
    r"^(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom|0|[-+]?\d+(?:\.\d+)?(?:px|em|rem|%))$",
    re.IGNORECASE,
)
_TEXT_DECORATION_PATTERN = re.compile(
    r"^(?:none|(?:underline|overline|line-through)(?:\s+(?:underline|overline|line-through))*)$",
    re.IGNORECASE,
)
_INTEGER_ATTRIBUTE_PATTERN = re.compile(r"^-?\d+$")
_POSITIVE_INTEGER_ATTRIBUTE_PATTERN = re.compile(r"^\d+$")
_IMAGE_DIMENSION_ATTRIBUTE_PATTERN = re.compile(r"^\d+(?:\.\d+)?$")
_UUID_ATTRIBUTE_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_REFERENCE_QUERY_ATTRIBUTE_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"(?: OR [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$",
    re.IGNORECASE,
)
_REFERENCE_ARIA_LABEL_PATTERN = re.compile(r"^Reference [1-9]\d*$")
_MATHML_LENGTH_VALUE_PATTERN = re.compile(r"^[a-z0-9.+%-]+(?:\s+[a-z0-9.+%-]+)*$", re.IGNORECASE)
_MATHML_COLOR_VALUE_PATTERN = re.compile(r"^(?:#[0-9a-f]{3,8}|[a-z]+)$", re.IGNORECASE)
_MATHML_TAGS = frozenset(
    {
        "math", "menclose", "mfrac", "mi", "mn", "mo", "mover", "mpadded",
        "mphantom", "mroot", "mrow", "mspace", "msqrt", "mstyle", "msub",
        "msubsup", "msup", "mtable", "mtd", "mtext", "mtr", "munder",
        "munderover",
    }
)
_MATHML_BOOLEAN_ATTRIBUTES = frozenset(
    {"accent", "displaystyle", "fence", "largeop", "movablelimits", "separator", "stretchy"}
)
_MATHML_LENGTH_ATTRIBUTES = frozenset(
    {
        "columnspacing", "depth", "height", "linethickness", "lspace", "maxsize",
        "minsize", "rowspacing", "rspace", "voffset", "width",
    }
)
_MATHML_VARIANTS = frozenset(
    {
        "bold", "bold-italic", "double-struck", "fraktur", "italic", "monospace",
        "normal", "sans-serif", "sans-serif-italic", "script",
    }
)
_MATHML_NOTATIONS = frozenset(
    {"box", "downdiagonalstrike", "horizontalstrike", "updiagonalstrike"}
)


@lru_cache(maxsize=1)
def load_note_html_policy() -> dict[str, Any]:
    with _POLICY_PATH.open(encoding="utf-8") as policy_file:
        policy = json.load(policy_file)
    if policy["version"] != 1:
        raise RuntimeError(f"Unsupported note HTML policy version: {policy['version']}")
    return policy


def _estimated_base64_bytes(payload: str) -> int:
    compact_payload = "".join(payload.split())
    if compact_payload == "":
        return 0
    padding = len(compact_payload) - len(compact_payload.rstrip("="))
    return (len(compact_payload) * 3) // 4 - padding


def _is_safe_data_image(value: str, *, max_bytes: int) -> bool:
    match = _DATA_IMAGE_PATTERN.fullmatch(value.strip())
    if match is None:
        return False
    return _estimated_base64_bytes(match.group(1)) <= max_bytes


def _is_safe_style_value(*, property_name: str, property_value: str, is_image: bool) -> bool:
    if _DANGEROUS_STYLE_PATTERN.search(property_value):
        return False
    if "&#" in property_value or "\\" in property_value:
        return False
    if _DISALLOWED_STYLE_CHARS_PATTERN.search(property_value):
        return False
    if property_name in {"margin-left", "padding-left", "text-indent"}:
        return _LENGTH_PATTERN.fullmatch(property_value) is not None
    if property_name in {"height", "max-height", "max-width", "width"}:
        return is_image and _IMAGE_LENGTH_PATTERN.fullmatch(property_value) is not None
    if property_name == "font-weight":
        return _FONT_WEIGHT_PATTERN.fullmatch(property_value) is not None
    if property_name == "font-style":
        return property_value.casefold() in {"normal", "italic", "oblique"}
    if property_name in {"text-decoration", "text-decoration-line"}:
        return _TEXT_DECORATION_PATTERN.fullmatch(property_value) is not None
    if property_name == "vertical-align":
        return _VERTICAL_ALIGN_PATTERN.fullmatch(property_value) is not None
    if property_name == "white-space":
        return property_value.casefold() in {"normal", "pre", "pre-line", "pre-wrap", "break-spaces"}
    return False


def _sanitize_style(*, raw_style: str, tag_name: str, policy: dict[str, Any]) -> str | None:
    allowed_properties = set(policy["allowed_style_properties"])
    block_properties = set(policy["block_style_properties"])
    image_properties = set(policy["image_style_properties"])
    known_properties = _TEXT_STYLE_PROPERTIES | block_properties | image_properties
    is_image = tag_name == "img"
    is_block = tag_name in {
        "blockquote", "code", "dd", "div", "dl", "dt", "h1", "h2", "h3", "h4",
        "h5", "h6", "li", "ol", "p", "pre", "table", "tbody", "td", "tfoot",
        "th", "thead", "tr", "ul",
    }
    declarations: list[str] = []
    for raw_declaration in raw_style.split(";"):
        declaration = raw_declaration.strip()
        if declaration == "" or ":" not in declaration:
            continue
        raw_property_name, raw_property_value = declaration.split(":", 1)
        property_name = raw_property_name.strip().casefold()
        property_value = raw_property_value.strip()
        if property_name not in allowed_properties:
            continue
        if property_name in block_properties and not is_block:
            continue
        if property_name in image_properties and not is_image:
            continue
        if property_name not in known_properties:
            continue
        if not _is_safe_style_value(
            property_name=property_name,
            property_value=property_value,
            is_image=is_image,
        ):
            continue
        declarations.append(f"{property_name}: {property_value}")
    if not declarations:
        return None
    return "; ".join(declarations) + ";"


def _sanitize_class_attribute(*, value: str, policy: dict[str, Any]) -> str | None:
    allowed_names = set(policy["allowed_class_names"])
    allowed_prefixes = tuple(policy["allowed_class_prefixes"])
    safe_names = [
        class_name
        for class_name in value.split()
        if class_name in allowed_names
        or any(class_name.startswith(prefix) for prefix in allowed_prefixes)
    ]
    if len(safe_names) == 0:
        return None
    return " ".join(safe_names)


def _sanitize_mathml_attribute(*, attribute_name: str, value: str) -> str | None:
    if attribute_name == "xmlns":
        if value != "http://www.w3.org/1998/Math/MathML":
            return None
        return value
    if attribute_name == "display":
        if value not in {"block", "inline"}:
            return None
        return value
    if attribute_name in _MATHML_BOOLEAN_ATTRIBUTES:
        if value not in {"false", "true"}:
            return None
        return value
    if attribute_name == "form":
        if value not in {"infix", "postfix", "prefix"}:
            return None
        return value
    if attribute_name == "scriptlevel":
        if value not in {"0", "1", "2"}:
            return None
        return value
    if attribute_name == "mathvariant":
        if value not in _MATHML_VARIANTS:
            return None
        return value
    if attribute_name == "linebreak":
        if value != "newline":
            return None
        return value
    if attribute_name == "columnalign":
        if value not in {"center", "left", "right"}:
            return None
        return value
    if attribute_name in {"columnlines", "rowlines"}:
        line_styles = value.split()
        if len(line_styles) == 0:
            return None
        if not all(style in {"dashed", "none", "solid"} for style in line_styles):
            return None
        return " ".join(line_styles)
    if attribute_name == "notation":
        notations = value.split()
        if len(notations) == 0:
            return None
        if not all(notation in _MATHML_NOTATIONS for notation in notations):
            return None
        return " ".join(notations)
    if attribute_name in {"mathbackground", "mathcolor"}:
        if _MATHML_COLOR_VALUE_PATTERN.fullmatch(value) is None:
            return None
        return value
    if attribute_name in _MATHML_LENGTH_ATTRIBUTES:
        if len(value) > 80:
            return None
        if _MATHML_LENGTH_VALUE_PATTERN.fullmatch(value) is None:
            return None
        return value
    raise AssertionError(f"Unvalidated MathML attribute: {attribute_name}")


def _sanitize_scalar_attribute(
    *,
    tag_name: str,
    attribute_name: str,
    value: str,
    policy: dict[str, Any],
) -> str | None:
    stripped_value = value.strip()
    if tag_name in _MATHML_TAGS:
        return _sanitize_mathml_attribute(
            attribute_name=attribute_name,
            value=stripped_value,
        )
    if attribute_name == "class":
        return _sanitize_class_attribute(value=stripped_value, policy=policy)
    if attribute_name == "data-ref-note-id":
        if _UUID_ATTRIBUTE_PATTERN.fullmatch(stripped_value) is None:
            return None
        return stripped_value
    if attribute_name == "data-ref-query":
        if _REFERENCE_QUERY_ATTRIBUTE_PATTERN.fullmatch(stripped_value) is None:
            return None
        return stripped_value
    if attribute_name == "data-markdown-rendered":
        if stripped_value != "true":
            return None
        return "true"
    if attribute_name == "aria-hidden":
        if stripped_value != "true":
            return None
        return "true"
    if attribute_name == "aria-label":
        if stripped_value == "References":
            return stripped_value
        if _REFERENCE_ARIA_LABEL_PATTERN.fullmatch(stripped_value) is not None:
            return stripped_value
        return None
    if tag_name == "img" and attribute_name in {"height", "width"}:
        if _IMAGE_DIMENSION_ATTRIBUTE_PATTERN.fullmatch(stripped_value) is None:
            return None
        return stripped_value
    if attribute_name in {"colspan", "rowspan"}:
        if _POSITIVE_INTEGER_ATTRIBUTE_PATTERN.fullmatch(stripped_value) is None:
            return None
        if int(stripped_value) <= 0:
            return None
        return stripped_value
    if (tag_name, attribute_name) in {("ol", "start"), ("li", "value")}:
        if _INTEGER_ATTRIBUTE_PATTERN.fullmatch(stripped_value) is None:
            return None
        return stripped_value
    if tag_name == "ol" and attribute_name == "type":
        if stripped_value not in {"1", "a", "A", "i", "I"}:
            return None
        return stripped_value
    if tag_name == "th" and attribute_name == "scope":
        normalized_value = stripped_value.casefold()
        if normalized_value not in {"row", "col", "rowgroup", "colgroup"}:
            return None
        return normalized_value
    return value


@lru_cache(maxsize=1)
def _build_cleaner() -> nh3.Cleaner:
    policy = load_note_html_policy()
    allowed_attributes = {
        tag_name: set(attribute_names)
        for tag_name, attribute_names in policy["allowed_attributes"].items()
    }
    max_data_image_bytes = policy["max_data_image_bytes"]

    def sanitize_attribute(tag_name: str, attribute_name: str, value: str) -> str | None:
        if attribute_name == "style":
            return _sanitize_style(raw_style=value, tag_name=tag_name, policy=policy)
        if attribute_name == "src" and value.lstrip().casefold().startswith("data:"):
            if tag_name != "img":
                return None
            if not _is_safe_data_image(value, max_bytes=max_data_image_bytes):
                return None
        return _sanitize_scalar_attribute(
            tag_name=tag_name,
            attribute_name=attribute_name,
            value=value,
            policy=policy,
        )

    return nh3.Cleaner(
        tags=set(policy["allowed_tags"]),
        clean_content_tags=set(policy["clean_content_tags"]),
        attributes=allowed_attributes,
        attribute_filter=sanitize_attribute,
        strip_comments=True,
        link_rel=None,
        url_schemes=set(policy["allowed_url_schemes"]),
        filter_style_properties=set(policy["allowed_style_properties"]),
    )


def sanitize_note_html(content: str) -> str:
    if not isinstance(content, str):
        raise TypeError("content must be a string")
    return _build_cleaner().clean(content)
