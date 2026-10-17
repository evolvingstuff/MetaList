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
# Base64 decodes in groups of 4 characters (3 bytes).
_BASE64_GROUP_CHARS = 4

# PNG: 8-byte signature, then the IHDR chunk (4-byte length, 4-byte type,
# 4-byte width, 4-byte height).
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_IHDR_TYPE = b"IHDR"
_PNG_CHUNK_LENGTH_BYTES = 4
_PNG_DIMENSION_BYTES = 4
_PNG_IHDR_TYPE_START = len(_PNG_SIGNATURE) + _PNG_CHUNK_LENGTH_BYTES
_PNG_WIDTH_START = _PNG_IHDR_TYPE_START + len(_PNG_IHDR_TYPE)
_PNG_HEIGHT_START = _PNG_WIDTH_START + _PNG_DIMENSION_BYTES
_PNG_SIZE_HEADER_END = _PNG_HEIGHT_START + _PNG_DIMENSION_BYTES

# GIF header: 6-byte signature, then 2-byte width and 2-byte height.
_GIF_SIGNATURES = (b"GIF87a", b"GIF89a")
_GIF_SIGNATURE_LENGTH = len(_GIF_SIGNATURES[0])
_GIF_DIMENSION_BYTES = 2
_GIF_HEIGHT_START = _GIF_SIGNATURE_LENGTH + _GIF_DIMENSION_BYTES
_GIF_SIZE_HEADER_END = _GIF_HEIGHT_START + _GIF_DIMENSION_BYTES

_JPEG_START_OF_IMAGE = b"\xff\xd8"
# A JPEG marker is 0xFF plus a code byte.
_JPEG_MARKER_PREFIX = 0xFF
_JPEG_MARKER_BYTES = 2
# Fill bytes before a marker repeat the prefix.
_JPEG_FILL_BYTE = _JPEG_MARKER_PREFIX
# A segment's length field is 2 bytes and counts itself.
_JPEG_SEGMENT_LENGTH_BYTES = 2
_JPEG_MARKER_AND_LENGTH_BYTES = _JPEG_MARKER_BYTES + _JPEG_SEGMENT_LENGTH_BYTES
_JPEG_MIN_LENGTH = len(_JPEG_START_OF_IMAGE) + _JPEG_MARKER_BYTES
# Restart markers RST0..RST7 (and TEM, 0x01) stand alone, with no length field.
_JPEG_RST0_MARKER = 0xD0
_JPEG_RST7_MARKER = 0xD7
_JPEG_STANDALONE_MARKERS = frozenset({0x01, *range(_JPEG_RST0_MARKER, _JPEG_RST7_MARKER + 1)})
# Start-of-frame markers SOF0..SOF15, except the three codes in that range that
# are not frames: DHT (Huffman tables), JPG (reserved) and DAC (arithmetic coding).
_JPEG_SOF0_MARKER = 0xC0
_JPEG_SOF15_MARKER = 0xCF
_JPEG_DHT_MARKER = 0xC4
_JPEG_JPG_MARKER = 0xC8
_JPEG_DAC_MARKER = 0xCC
_JPEG_FRAME_MARKERS = frozenset(range(_JPEG_SOF0_MARKER, _JPEG_SOF15_MARKER + 1)) - {
    _JPEG_DHT_MARKER,
    _JPEG_JPG_MARKER,
    _JPEG_DAC_MARKER,
}
# A frame header: marker, length, 1-byte sample precision, 2-byte height, 2-byte width.
_JPEG_SAMPLE_PRECISION_BYTES = 1
_JPEG_DIMENSION_BYTES = 2
_JPEG_FRAME_HEIGHT_OFFSET = _JPEG_MARKER_AND_LENGTH_BYTES + _JPEG_SAMPLE_PRECISION_BYTES
_JPEG_FRAME_WIDTH_OFFSET = _JPEG_FRAME_HEIGHT_OFFSET + _JPEG_DIMENSION_BYTES
_JPEG_FRAME_SIZE_END = _JPEG_FRAME_WIDTH_OFFSET + _JPEG_DIMENSION_BYTES

# WebP: "RIFF", 4-byte file size, "WEBP", then the first chunk's 4-byte type
# and 4-byte size before its payload.
_RIFF_SIGNATURE = b"RIFF"
_WEBP_FORM_TYPE = b"WEBP"
_RIFF_FOURCC_BYTES = 4
_RIFF_SIZE_FIELD_BYTES = 4
_WEBP_FORM_TYPE_START = len(_RIFF_SIGNATURE) + _RIFF_SIZE_FIELD_BYTES
_WEBP_CHUNK_TYPE_START = _WEBP_FORM_TYPE_START + len(_WEBP_FORM_TYPE)
_WEBP_CHUNK_TYPE_END = _WEBP_CHUNK_TYPE_START + _RIFF_FOURCC_BYTES
_WEBP_CHUNK_PAYLOAD_START = _WEBP_CHUNK_TYPE_END + _RIFF_SIZE_FIELD_BYTES
# VP8X (extended): 1 flags byte and 3 reserved bytes, then 3-byte canvas
# width and height, each stored minus one.
_VP8X_FLAGS_AND_RESERVED_BYTES = 4
_VP8X_DIMENSION_BYTES = 3
_VP8X_WIDTH_START = _WEBP_CHUNK_PAYLOAD_START + _VP8X_FLAGS_AND_RESERVED_BYTES
_VP8X_HEIGHT_START = _VP8X_WIDTH_START + _VP8X_DIMENSION_BYTES
_VP8X_SIZE_END = _VP8X_HEIGHT_START + _VP8X_DIMENSION_BYTES
# VP8 (lossy): 3-byte frame tag, 3-byte start code, then 2-byte width and
# height whose low 14 bits are the size (the top two bits are a scale).
_VP8_FRAME_TAG_BYTES = 3
_VP8_START_CODE = b"\x9d\x01\x2a"
_VP8_DIMENSION_BYTES = 2
_VP8_DIMENSION_BITS = 14
_VP8_DIMENSION_MASK = (1 << _VP8_DIMENSION_BITS) - 1
_VP8_START_CODE_START = _WEBP_CHUNK_PAYLOAD_START + _VP8_FRAME_TAG_BYTES
_VP8_WIDTH_START = _VP8_START_CODE_START + len(_VP8_START_CODE)
_VP8_HEIGHT_START = _VP8_WIDTH_START + _VP8_DIMENSION_BYTES
_VP8_SIZE_END = _VP8_HEIGHT_START + _VP8_DIMENSION_BYTES
# VP8L (lossless): a signature byte, then 4 bytes holding 14-bit width and
# height, each stored minus one.
_VP8L_SIGNATURE_BYTE = 0x2F
_VP8L_SIZE_BITS_START = _WEBP_CHUNK_PAYLOAD_START + 1
_VP8L_SIZE_BITS_BYTES = 4
_VP8L_DIMENSION_BITS = 14
_VP8L_DIMENSION_MASK = (1 << _VP8L_DIMENSION_BITS) - 1
# The VP8X and VP8 size fields both end here; VP8L's end earlier.
_WEBP_SIZE_HEADER_END = max(_VP8X_SIZE_END, _VP8_SIZE_END)


def _png_size(data: bytes) -> Optional[Tuple[int, int]]:
    if (
        len(data) < _PNG_SIZE_HEADER_END
        or data[:len(_PNG_SIGNATURE)] != _PNG_SIGNATURE
        or data[_PNG_IHDR_TYPE_START:_PNG_WIDTH_START] != _PNG_IHDR_TYPE
    ):
        return None
    return (
        int.from_bytes(data[_PNG_WIDTH_START:_PNG_HEIGHT_START], "big"),
        int.from_bytes(data[_PNG_HEIGHT_START:_PNG_SIZE_HEADER_END], "big"),
    )


def _gif_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < _GIF_SIZE_HEADER_END or data[:_GIF_SIGNATURE_LENGTH] not in _GIF_SIGNATURES:
        return None
    return (
        int.from_bytes(data[_GIF_SIGNATURE_LENGTH:_GIF_HEIGHT_START], "little"),
        int.from_bytes(data[_GIF_HEIGHT_START:_GIF_SIZE_HEADER_END], "little"),
    )


def _jpeg_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) < _JPEG_MIN_LENGTH or data[:len(_JPEG_START_OF_IMAGE)] != _JPEG_START_OF_IMAGE:
        return None
    index = len(_JPEG_START_OF_IMAGE)
    while index + _JPEG_MARKER_AND_LENGTH_BYTES <= len(data):
        if data[index] != _JPEG_MARKER_PREFIX:
            return None
        marker = data[index + 1]
        if marker == _JPEG_FILL_BYTE:
            index += 1
            continue
        if marker in _JPEG_STANDALONE_MARKERS:
            index += _JPEG_MARKER_BYTES
            continue
        segment_length = int.from_bytes(data[index + _JPEG_MARKER_BYTES:index + _JPEG_MARKER_AND_LENGTH_BYTES], "big")
        if marker in _JPEG_FRAME_MARKERS:
            if index + _JPEG_FRAME_SIZE_END > len(data):
                return None
            height = int.from_bytes(data[index + _JPEG_FRAME_HEIGHT_OFFSET:index + _JPEG_FRAME_WIDTH_OFFSET], "big")
            width = int.from_bytes(data[index + _JPEG_FRAME_WIDTH_OFFSET:index + _JPEG_FRAME_SIZE_END], "big")
            return width, height
        if segment_length < _JPEG_SEGMENT_LENGTH_BYTES:
            return None
        index += _JPEG_MARKER_BYTES + segment_length
    return None


def _webp_size(data: bytes) -> Optional[Tuple[int, int]]:
    if (
        len(data) < _WEBP_SIZE_HEADER_END
        or data[:_RIFF_FOURCC_BYTES] != _RIFF_SIGNATURE
        or data[_WEBP_FORM_TYPE_START:_WEBP_CHUNK_TYPE_START] != _WEBP_FORM_TYPE
    ):
        return None
    chunk = data[_WEBP_CHUNK_TYPE_START:_WEBP_CHUNK_TYPE_END]
    if chunk == b"VP8X":
        width = int.from_bytes(data[_VP8X_WIDTH_START:_VP8X_HEIGHT_START], "little") + 1
        height = int.from_bytes(data[_VP8X_HEIGHT_START:_VP8X_SIZE_END], "little") + 1
        return width, height
    if chunk == b"VP8 ":
        if data[_VP8_START_CODE_START:_VP8_WIDTH_START] != _VP8_START_CODE:
            return None
        return (
            int.from_bytes(data[_VP8_WIDTH_START:_VP8_HEIGHT_START], "little") & _VP8_DIMENSION_MASK,
            int.from_bytes(data[_VP8_HEIGHT_START:_VP8_SIZE_END], "little") & _VP8_DIMENSION_MASK,
        )
    if chunk == b"VP8L":
        if data[_WEBP_CHUNK_PAYLOAD_START] != _VP8L_SIGNATURE_BYTE:
            return None
        bits = int.from_bytes(data[_VP8L_SIZE_BITS_START:_VP8L_SIZE_BITS_START + _VP8L_SIZE_BITS_BYTES], "little")
        return (bits & _VP8L_DIMENSION_MASK) + 1, ((bits >> _VP8L_DIMENSION_BITS) & _VP8L_DIMENSION_MASK) + 1
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
    usable = len(compact) - len(compact) % _BASE64_GROUP_CHARS
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
