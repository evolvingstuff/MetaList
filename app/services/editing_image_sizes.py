"""The size each inline image shows at while its note is being edited.

The editor shows a note's raw text, where a size is only a tag and braces. So
that an image still shows at its size, the text is rendered as the view renders
it, and each image's size is read from the size scopes around it there (nested
scopes multiply, as CSS zoom does). The editor applies it as a display-only
zoom, which saving drops (docs/ui/content-formatting.md).
"""

from __future__ import annotations

import re
from decimal import Decimal
from html.parser import HTMLParser

from app.services.content_formatting import format_note_content_for_view
from app.services.inline_image_occurrences import INLINE_IMAGE_TAG_RE, annotate_inline_image_occurrences

# An image the view shows without a size scope, or does not show as an image.
FULL_SIZE = Decimal(1)
_OCCURRENCE_ATTRIBUTE = "data-inline-image-occurrence"
_SIZE_FACTOR_RE = re.compile(r"--meta-size-factor\s*:\s*([0-9.]+)")
# Elements that never have content, so never close.
_VOID_ELEMENTS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
})


class _ImageSizeReader(HTMLParser):
    """Each annotated image's size: the product of the size scopes it is in."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.open_elements: list[tuple[str, Decimal]] = []
        self.sizes_by_occurrence: dict[int, Decimal] = {}

    def _current_size(self) -> Decimal:
        size = FULL_SIZE
        for _tag, factor in self.open_elements:
            size *= factor
        return size

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name: value for name, value in attrs if value is not None}
        if tag == "img":
            if _OCCURRENCE_ATTRIBUTE in attributes:
                occurrence = int(attributes[_OCCURRENCE_ATTRIBUTE])
                assert occurrence not in self.sizes_by_occurrence, "an image occurrence renders once"
                self.sizes_by_occurrence[occurrence] = self._current_size()
            return
        if tag in _VOID_ELEMENTS:
            return
        factor = FULL_SIZE
        if "style" in attributes:
            match = _SIZE_FACTOR_RE.search(attributes["style"])
            if match is not None:
                factor = Decimal(match.group(1))
        self.open_elements.append((tag, factor))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in _VOID_ELEMENTS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        # Close back to the matching element (rendered HTML may leave some open).
        for index in reversed(range(len(self.open_elements))):
            if self.open_elements[index][0] == tag:
                del self.open_elements[index:]
                return


def editing_image_size_factors(*, content_html: str, tags: str) -> list[float]:
    """The size of each inline image in `content_html`, in order: what the view
    renders it at with these tags."""
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if not isinstance(tags, str):
        raise TypeError("tags must be a string")
    image_count = len(INLINE_IMAGE_TAG_RE.findall(content_html))
    if image_count == 0:
        return []
    rendered = format_note_content_for_view(
        content_html=annotate_inline_image_occurrences(content_html), tags=tags, redact_credentials=False,
    )
    reader = _ImageSizeReader()
    reader.feed(rendered)
    reader.close()
    sizes = []
    for occurrence in range(image_count):
        size = FULL_SIZE
        if occurrence in reader.sizes_by_occurrence:
            size = reader.sizes_by_occurrence[occurrence]
        sizes.append(float(size))
    return sizes
