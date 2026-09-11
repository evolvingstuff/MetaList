from __future__ import annotations

import re
from typing import Dict, List, Optional, Set

from app.services.note_store import store as note_store
from app.utils.text_utils import strip_html


_FIRST_LINE_BOUNDARY_RE = re.compile(
    r"(?i)<br\s*/?>|</(?:div|p|li|h[1-6]|pre|blockquote|ul|ol|table|tr|td|th|section|article|header|footer)>\s*|\n"
)
_REFERENCE_TOKEN_RE = re.compile(r"!?\[\[[^\[\]\n]+\]\]")
_WHITESPACE_RE = re.compile(r"\s+")


def list_backlinks_for_note(target_note_id: str, source_note_ids: Optional[Set[str]]) -> List[Dict[str, str]]:
    if not isinstance(target_note_id, str) or target_note_id == "":
        raise TypeError("target_note_id must be a non-empty string")
    if not note_store.has_note(target_note_id):
        raise KeyError(f"Note {target_note_id} not present in NoteStore")
    if source_note_ids is not None:
        if not isinstance(source_note_ids, set):
            raise TypeError("source_note_ids must be a set of note ids")
        for note_id in source_note_ids:
            if not isinstance(note_id, str) or note_id == "":
                raise TypeError("source_note_ids entries must be non-empty strings")

    counts = note_store.get_backlink_counts(target_note_id)
    if not counts:
        return []
    backlinks: List[Dict[str, str]] = []
    for note_id in _iterate_note_ids_depth_first():
        if source_note_ids is not None and note_id not in source_note_ids:
            continue
        if note_id not in counts:
            continue
        record = note_store.get_note(note_id)
        match_count = counts[note_id]

        preview = _extract_preview(record.content)
        for _ in range(match_count):
            backlinks.append({
                "id": note_id,
                "preview": preview,
            })
    return backlinks


def _iterate_note_ids_depth_first() -> List[str]:
    ordered_ids: List[str] = []
    stack: List[str] = list(reversed(note_store.get_children(None)))
    while stack:
        note_id = stack.pop()
        ordered_ids.append(note_id)
        child_ids = note_store.get_children(note_id)
        for child_id in reversed(child_ids):
            stack.append(child_id)
    return ordered_ids


def _extract_preview(content_html: str) -> str:
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")

    for segment in _FIRST_LINE_BOUNDARY_RE.split(content_html):
        preview = _strip_reference_tokens(strip_html(segment))
        if preview:
            return preview

    fallback = _strip_reference_tokens(strip_html(content_html))
    if fallback:
        return fallback
    return "(empty note)"


def _strip_reference_tokens(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    without_tokens = _REFERENCE_TOKEN_RE.sub(" ", text)
    normalized = _WHITESPACE_RE.sub(" ", without_tokens)
    return normalized.strip()
