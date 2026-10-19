"""The final sanitize pass over HTML the server renders for the browser.

Stored note HTML is sanitized on every write (note_html.py). What the browser receives
is not that HTML but a rendering of it (Markdown, CSV, embeds, reference decorations,
file previews) and chat replies rendered from the AI's Markdown, which are never stored.
Each renderer escapes its text, but nothing checked the result. This pass does: the
stored-note allowlist plus exactly the inert markup the renderers add (buttons, data-*
identifiers, ARIA, titles, fixed link and image hints, renderer class names), never an
event handler or a script-capable URL. Whatever a renderer does, the page receives only
allowlisted HTML (docs/security/html-sinks.md; the browser's sanitized_html
contracts rely on it).
"""

from __future__ import annotations

import re
from functools import lru_cache

import nh3

from app.security.note_html import load_note_html_policy, sanitize_note_attribute

# Markup only the renderers emit (stored notes never contain it). tests/unit/conftest.py
# fails any unit test whose rendering this pass would change, so the lists stay complete.
RENDERER_TAGS = frozenset({"article", "button", "path", "rect", "svg"})
RENDERER_ATTRIBUTES: dict[str, frozenset[str]] = {
    "a": frozenset({"aria-label", "class", "rel", "target"}),
    "article": frozenset({"class"}),
    "button": frozenset({
        "aria-expanded", "aria-label", "class", "data-embed-collapse-note-id", "data-file-ref-id",
        "data-footnote-number", "data-source-note-id", "title", "type",
    }),
    "div": frozenset({
        "aria-hidden", "aria-live", "class", "contenteditable", "data-copy-value", "data-embed-note-id",
        "data-embed-ref-id", "data-file-ref-id", "data-file-revision", "data-latex-source", "data-preview-state",
        "data-ref-host-note-id", "data-ref-mode", "data-ref-note-id", "data-ref-occurrence", "title",
    }),
    "img": frozenset({
        "class", "data-file-kind", "data-file-ref-id", "data-inline-image-occurrence", "data-preview-variant",
        "data-remote-image-proxy-src", "decoding", "draggable", "hidden", "loading",
    }),
    "li": frozenset({"class", "data-footnote-reference", "tabindex"}),
    "section": frozenset({"class"}),
    "span": frozenset({
        "aria-hidden", "aria-label", "class", "data-copy-value", "data-file-ref-id", "data-file-revision",
        "data-footnote-scope", "data-latex-source", "data-preview-state", "data-redacted", "data-status", "role",
    }),
    "sup": frozenset({"class"}),
    # The icons' inline SVG (credential, email and status icons): shapes only.
    "svg": frozenset({"aria-hidden", "class", "focusable", "viewBox"}),
    "path": frozenset({"d", "fill", "stroke", "stroke-linecap", "stroke-linejoin", "stroke-width"}),
    "rect": frozenset({"fill", "height", "rx", "ry", "stroke", "stroke-width", "width", "x", "y"}),
}
# Attributes whose renderer values are fixed: any other value is dropped.
_FIXED_VALUES: dict[tuple[str, str], frozenset[str]] = {
    ("a", "rel"): frozenset({"noopener noreferrer"}),
    ("a", "target"): frozenset({"_blank"}),
    ("button", "aria-expanded"): frozenset({"true", "false"}),
    ("button", "type"): frozenset({"button"}),
    ("div", "aria-hidden"): frozenset({"true"}),
    ("div", "aria-live"): frozenset({"polite"}),
    ("div", "contenteditable"): frozenset({"false"}),
    ("img", "decoding"): frozenset({"async"}),
    ("img", "draggable"): frozenset({"true", "false"}),
    ("img", "hidden"): frozenset({"", "hidden"}),
    ("img", "loading"): frozenset({"lazy"}),
    ("li", "tabindex"): frozenset({"-1"}),
    ("span", "aria-hidden"): frozenset({"true"}),
    ("span", "data-redacted"): frozenset({"true"}),
    ("span", "role"): frozenset({"img"}),
    ("svg", "aria-hidden"): frozenset({"true"}),
    ("svg", "focusable"): frozenset({"false"}),
}
# Renderer class names (note-embed-*, note-file-*, meta-footnote-*, link-title-*,
# ai-chat-web-*, Pygments' tok-*, the JSON view's json-*, full-screen notes' own): inert names the app's own CSS
# and scripts give meaning to.
RENDERER_CLASS_PREFIXES = ("note-", "meta-", "link-title", "ai-chat-", "tok-", "json-")
RENDERER_CLASS_NAMES = frozenset({"list-bulleted", "list-numbered", "note", "search-highlight"})
# The size tags' factor (@size=2), a CSS variable the stylesheet scales text by.
_SIZE_FACTOR_PROPERTY = "--meta-size-factor"
_SIZE_FACTOR_DECLARATION_RE = re.compile(r"^--meta-size-factor\s*:\s*[0-9]+(?:\.[0-9]+)?$")
# The remote image proxy's own path, the only value its data attribute may carry.
_REMOTE_IMAGE_PROXY_PATH_PREFIX = "/api2/remote-images/"


def _sanitize_renderer_classes(value: str) -> str | None:
    policy = load_note_html_policy()
    prefixes = (*policy["allowed_class_prefixes"], *RENDERER_CLASS_PREFIXES)
    kept = [
        name for name in value.split()
        if name in policy["allowed_class_names"] or name in RENDERER_CLASS_NAMES or name.startswith(prefixes)
    ]
    if len(kept) == 0:
        return None
    return " ".join(kept)


def _sanitize_renderer_style(tag_name: str, value: str) -> str | None:
    """The size factor as the renderer wrote it, then the stored-note style policy's
    check of every other declaration."""
    declarations = [declaration.strip() for declaration in value.split(";") if declaration.strip() != ""]
    size_factors = [declaration for declaration in declarations if _SIZE_FACTOR_DECLARATION_RE.match(declaration)]
    others = "; ".join(declaration for declaration in declarations if declaration not in size_factors)
    kept = list(size_factors)
    if others != "":
        sanitized_others = sanitize_note_attribute(tag_name, "style", others)
        if sanitized_others is not None:
            kept.append(sanitized_others)
    if len(kept) == 0:
        return None
    return "; ".join(kept)


def _sanitize_rendered_attribute(tag_name: str, attribute_name: str, value: str) -> str | None:
    # Renderer class names and the size factor go on any tag the renderers write.
    if attribute_name == "class":
        return _sanitize_renderer_classes(value)
    if attribute_name == "style":
        return _sanitize_renderer_style(tag_name, value)
    if tag_name not in RENDERER_ATTRIBUTES or attribute_name not in RENDERER_ATTRIBUTES[tag_name]:
        return sanitize_note_attribute(tag_name, attribute_name, value)
    if (tag_name, attribute_name) in _FIXED_VALUES:
        if value not in _FIXED_VALUES[(tag_name, attribute_name)]:
            return None
        return value
    if attribute_name == "data-remote-image-proxy-src" and not value.startswith(_REMOTE_IMAGE_PROXY_PATH_PREFIX):
        return None
    # Identifiers, labels and titles: plain text, escaped when the cleaner writes it out.
    return value


@lru_cache(maxsize=1)
def _build_rendered_cleaner() -> nh3.Cleaner:
    policy = load_note_html_policy()
    attributes = {tag: set(names) for tag, names in policy["allowed_attributes"].items()}
    for tag, names in RENDERER_ATTRIBUTES.items():
        attributes.setdefault(tag, set()).update(names)
    attributes.setdefault("*", set()).update({"class", "style"})
    return nh3.Cleaner(
        tags=set(policy["allowed_tags"]) | RENDERER_TAGS,
        # Stored notes drop a button with its content; rendered views keep the renderers' buttons.
        clean_content_tags=set(policy["clean_content_tags"]) - RENDERER_TAGS,
        attributes=attributes,
        attribute_filter=_sanitize_rendered_attribute,
        strip_comments=True,
        link_rel=None,
        url_schemes=set(policy["allowed_url_schemes"]),
        filter_style_properties={*policy["allowed_style_properties"], _SIZE_FACTOR_PROPERTY},
    )


def sanitize_rendered_html(html: str) -> str:
    """The rendered note view or chat reply, with anything outside the rendered-HTML
    allowlist removed."""
    if not isinstance(html, str):
        raise TypeError("html must be a string")
    return _build_rendered_cleaner().clean(html)
