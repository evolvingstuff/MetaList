from __future__ import annotations

import re
from typing import List


INLINE_IMAGE_TAG_RE = re.compile(
    r"<img\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*>",
    re.IGNORECASE,
)
_OCCURRENCE_ATTRIBUTE_RE = re.compile(
    r"\sdata-inline-image-occurrence\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)",
    re.IGNORECASE,
)
_IMAGE_TAG_OPENING_LENGTH = len("<img")


def annotate_inline_image_occurrences(content_html: str) -> str:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")

    pieces: List[str] = []
    cursor = 0
    for occurrence_index, match in enumerate(INLINE_IMAGE_TAG_RE.finditer(content_html)):
        image_tag = _OCCURRENCE_ATTRIBUTE_RE.sub("", match.group(0))
        pieces.append(content_html[cursor : match.start()])
        pieces.append(
            f'<img data-inline-image-occurrence="{occurrence_index}"{image_tag[_IMAGE_TAG_OPENING_LENGTH:]}'
        )
        cursor = match.end()
    pieces.append(content_html[cursor:])
    return "".join(pieces)
