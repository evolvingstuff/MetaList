"""Give inline (data-URI) images their pixel size so the page reserves space.

A freshly inserted <img> has no height until the browser decodes it, so text
below it moves once it does (for example right after a note leaves edit mode).
With width/height attributes the browser lays the image out at its final size
immediately. The attributes equal the image's natural size, which is how inline
images already display (`@size` scales them with CSS zoom, which scales the
attributes too), so nothing changes visually.

Sizes are read from the image header only (PNG, GIF, JPEG, WebP). Anything
unrecognised or truncated simply gets no attributes.
"""

from __future__ import annotations

import base64
import re
from typing import Optional, Tuple

from app.services.inline_image_occurrences import INLINE_IMAGE_TAG_RE

_DATA_SRC_RE = re.compile(
    r"""\ssrc\s*=\s*(["'])data:image/[a-z0-9.+-]+;base64,(?P<payload>[A-Za-z0-9+/=\s]+)\1""",
    re.IGNORECASE,
)
_SIZE_ATTRIBUTE_RE = re.compile(r"\s(?:width|height)\s*=", re.IGNORECASE)
# Enough base64 to cover the header of any common image (JPEG metadata blocks
# before the frame header can be long).
_HEADER_BASE64_CHARS = 131_072
_JPEG_STANDALONE_MARKERS = frozenset({0x01, *range(0xD0, 0xD8)})
_JPEG_FRAME_MARKERS = frozenset({0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF})
# GIF header: 6-byte signature, then 2-byte width and 2-byte height.
_GIF_SIZE_HEADER_END = 10
_JPEG_START_OF_IMAGE = b"\xff\xd8"
# A JPEG marker is 0xFF plus a code byte.
_JPEG_MARKER_BYTES = 2
# A segment's length field is 2 bytes and counts itself.
_JPEG_SEGMENT_LENGTH_BYTES = 2


def _png_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _gif_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < _GIF_SIZE_HEADER_END or data[:6] not in (b"GIF87a", b"GIF89a"):
        return None
    return int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:_GIF_SIZE_HEADER_END], "little")


def _jpeg_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < 4 or data[:len(_JPEG_START_OF_IMAGE)] != _JPEG_START_OF_IMAGE:
        return None
    index = len(_JPEG_START_OF_IMAGE)
    while index + 4 <= len(data):
        if data[index] != 0xFF:
            return None
        marker = data[index + 1]
        if marker == 0xFF:
            index += 1
            continue
        if marker in _JPEG_STANDALONE_MARKERS:
            index += _JPEG_MARKER_BYTES
            continue
        segment_length = int.from_bytes(data[index + _JPEG_MARKER_BYTES:index + 4], "big")
        if marker in _JPEG_FRAME_MARKERS:
            if index + 9 > len(data):
                return None
            height = int.from_bytes(data[index + 5:index + 7], "big")
            width = int.from_bytes(data[index + 7:index + 9], "big")
            return width, height
        if segment_length < _JPEG_SEGMENT_LENGTH_BYTES:
            return None
        index += _JPEG_MARKER_BYTES + segment_length
    return None


def _webp_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    chunk = data[12:16]
    if chunk == b"VP8X":
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    if chunk == b"VP8 ":
        if data[23:26] != b"\x9d\x01\x2a":
            return None
        return int.from_bytes(data[26:28], "little") & 0x3FFF, int.from_bytes(data[28:30], "little") & 0x3FFF
    if chunk == b"VP8L":
        if data[20] != 0x2F:
            return None
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    return None


def image_size_from_header(data: bytes) -> Optional[Tuple[int, int]]:
    """(width, height) from a PNG/GIF/JPEG/WebP header, or None."""
    if not isinstance(data, bytes):
        raise TypeError(f"data must be bytes, got {type(data)}")
    for reader in (_png_size, _gif_size, _jpeg_size, _webp_size):
        size = reader(data)
        if size is not None:
            width, height = size
            if width > 0 and height > 0:
                return width, height
            return None
    return None


def _decode_header(base64_payload: str) -> bytes:
    compact = "".join(base64_payload.split())[:_HEADER_BASE64_CHARS]
    usable = len(compact) - len(compact) % 4
    prefix = compact[:usable]
    # Padding may only end the full payload; a truncated prefix has none inside.
    if "=" in prefix.rstrip("="):
        return b""
    if usable == 0:
        return b""
    return base64.b64decode(prefix, validate=True)


def add_inline_image_dimensions(html: str) -> str:
    """Add width/height to data-URI <img> tags that have neither."""
    if not isinstance(html, str):
        raise TypeError(f"html must be a string, got {type(html)}")

    def stamp(match: re.Match[str]) -> str:
        tag = match.group(0)
        if _SIZE_ATTRIBUTE_RE.search(tag):
            return tag
        source = _DATA_SRC_RE.search(tag)
        if source is None:
            return tag
        size = image_size_from_header(_decode_header(source.group("payload")))
        if size is None:
            return tag
        width, height = size
        closing = ">"
        if tag.endswith("/>"):
            closing = "/>"
        return f'{tag[:-len(closing)].rstrip()} width="{width}" height="{height}"{closing}'

    return INLINE_IMAGE_TAG_RE.sub(stamp, html)
