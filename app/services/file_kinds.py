"""Files filter: a tab shows only the notes that reference an attached file, or one of
a kind (an image, a PDF, a Markdown file), with the notes above them
(docs/ui/command-palette.md, Notes With Files).

A note matches by its own text: a [[file]] link or ![[file]] embed in it. Each
file's kind comes from what the file registry already holds: its thumbnail kind
and its name.
"""

from __future__ import annotations

from app.services.input_errors import InputRejected

FILE_KIND_IMAGE = "image"
FILE_KIND_PDF = "pdf"
FILE_KIND_MARKDOWN = "markdown"
# Every other file: kept by the registry, offered only as part of "any".
FILE_KIND_OTHER = "other"
# The filter for every attached file, whatever its kind.
FILE_FILTER_ANY = "any"
# What a request sends to show every note again (no filter).
FILE_FILTER_NONE = "none"
FILE_FILTER_KINDS = frozenset({FILE_FILTER_ANY, FILE_KIND_IMAGE, FILE_KIND_PDF, FILE_KIND_MARKDOWN})

# A file's thumbnail kind (file_storage._derive_thumbnail_kind) already marks
# images and PDFs; Markdown files are known by their name.
_THUMBNAIL_KINDS_FILTERED = {"image": FILE_KIND_IMAGE, "pdf": FILE_KIND_PDF}
_MARKDOWN_EXTENSIONS = (".md", ".markdown")


def file_kind_of(*, thumbnail_kind: str, file_name: str) -> str:
    """The kind a file is filtered by: image, pdf, markdown or other."""
    if not isinstance(thumbnail_kind, str) or not isinstance(file_name, str):
        raise TypeError("file_kind_of requires thumbnail_kind and file_name strings")
    if thumbnail_kind in _THUMBNAIL_KINDS_FILTERED:
        return _THUMBNAIL_KINDS_FILTERED[thumbnail_kind]
    if file_name.strip().lower().endswith(_MARKDOWN_EXTENSIONS):
        return FILE_KIND_MARKDOWN
    return FILE_KIND_OTHER


def make_file_filter(kind: str) -> str:
    """A validated filter kind; a request or saved tab state with another is rejected."""
    if kind not in FILE_FILTER_KINDS:
        raise InputRejected(f"Unknown file type to filter on: {kind!r}")
    return kind
