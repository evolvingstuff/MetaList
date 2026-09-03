from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Dict, List, Optional

import app.services.snapshot as snapshot_module
import pytest

from app.services.snapshot import build_view_state


@dataclass
class _Note:
    id: str
    parent_id: Optional[str]
    prev_id: Optional[str]
    next_id: Optional[str]
    is_collapsed: bool
    content: str
    tags: str
    created_at: datetime = datetime(2026, 1, 1, tzinfo=timezone.utc)
    updated_at: datetime = datetime(2026, 1, 2, tzinfo=timezone.utc)
    proposed_tags: str = ""
    proposed_tag_terms: frozenset[str] = frozenset()


class _FakeNoteStore:
    def __init__(self, *, notes: Dict[str, _Note], children_by_parent: Dict[Optional[str], List[str]]):
        self._notes = notes
        self._children_by_parent = children_by_parent

    def has_note(self, note_id: str) -> bool:
        return note_id in self._notes

    def get_note(self, note_id: str) -> _Note:
        return self._notes[note_id]

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        if parent_id in self._children_by_parent:
            return list(self._children_by_parent[parent_id])
        return []

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> frozenset[str]:
        assert note_id in self._notes
        return frozenset()


class _FakeFileRegistry:
    def __init__(self, file_ids: set[str]) -> None:
        self._file_ids = file_ids

    def has_file(self, file_id: str) -> bool:
        return file_id in self._file_ids


def _state_for(
    *,
    monkeypatch: pytest.MonkeyPatch,
    notes: Dict[str, _Note],
    children_by_parent: Dict[Optional[str], List[str]],
    file_ids: set[str],
    file_record: object,
):
    store = _FakeNoteStore(notes=notes, children_by_parent=children_by_parent)
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "file_registry", _FakeFileRegistry(file_ids))
    monkeypatch.setattr(snapshot_module, "get_all_locks", lambda: {})
    monkeypatch.setattr(snapshot_module, "get_file_reference_record", lambda file_id, token: file_record)
    return build_view_state(
        editing_note_id=None,
        search=None,
        sort_mode="normal",
        date_filter=None,
        client_known_note_ids=set(),
        client_seen_root_ids=set(),
        anchor_root_id=None,
        is_untagged_view=False,
    )


def test_embed_file_reference_renders_file_card(monkeypatch: pytest.MonkeyPatch) -> None:
    file_id = "9ec1c81f-2d96-46f1-a455-e3e77798ae1f"
    notes = {
        "a": _Note("a", None, None, None, False, f"<div>before ![[{file_id}]] after</div>", ""),
    }
    file_record = SimpleNamespace(
        id=file_id,
        title="report.pdf",
        original_filename="report.pdf",
        mime_type="application/pdf",
        size_bytes=2048,
        thumbnail_kind="pdf",
    )
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        file_ids={file_id},
        file_record=file_record,
    )

    rendered = state.payloads["a"]["content"]
    assert "note-reference-file" in rendered
    assert "note-file-reference-link" in rendered
    assert "report.pdf" in rendered
    assert "PDF" in rendered
    assert "note-file-reference-meta" not in rendered
    assert "application/pdf" not in rendered


def test_link_file_reference_renders_compact_file_link(monkeypatch: pytest.MonkeyPatch) -> None:
    file_id = "2a7ba8f6-98ea-4c07-9515-b45726c1f58d"
    notes = {
        "a": _Note("a", None, None, None, False, f"<div>[[{file_id}]]</div>", ""),
    }
    file_record = SimpleNamespace(
        id=file_id,
        title="clip.mp4",
        original_filename="clip.mp4",
        mime_type="video/mp4",
        size_bytes=5_120,
        thumbnail_kind="video",
    )
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        file_ids={file_id},
        file_record=file_record,
    )

    rendered = state.payloads["a"]["content"]
    assert "note-reference-file" in rendered
    assert "note-file-reference-link" in rendered
    assert "note-file-reference-meta" not in rendered
    assert "clip.mp4" in rendered
    assert "VID" in rendered


def test_embed_image_file_reference_renders_preview_with_download_link(monkeypatch: pytest.MonkeyPatch) -> None:
    file_id = "f9989d26-5ec9-4b09-9647-909c58ad997a"
    notes = {
        "a": _Note("a", None, None, None, False, f"<div>![[{file_id}]]</div>", ""),
    }
    file_record = SimpleNamespace(
        id=file_id,
        title="photo.png",
        original_filename="photo.png",
        mime_type="image/png",
        size_bytes=8_192,
        thumbnail_kind="image",
    )
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        file_ids={file_id},
        file_record=file_record,
    )

    rendered = state.payloads["a"]["content"]
    assert "note-reference-file-image" in rendered
    assert "note-file-image-embed" in rendered
    assert "note-file-image-preview" in rendered
    assert "download image" in rendered
    assert "note-file-reference-badge" not in rendered
    assert state.payloads["a"]["flags"]["isCollapsible"] is True


def test_collapsed_image_file_reference_preview_skips_leading_blank_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    file_id = "a9df9c6a-9adf-475b-a842-35091be558b9"
    notes = {
        "a": _Note(
            "a",
            None,
            None,
            None,
            True,
            f"<div><br></div><div>![[{file_id}]]</div><div>trailing text</div>",
            "",
        ),
    }
    file_record = SimpleNamespace(
        id=file_id,
        title="photo.png",
        original_filename="photo.png",
        mime_type="image/png",
        size_bytes=8_192,
        thumbnail_kind="image",
    )
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        file_ids={file_id},
        file_record=file_record,
    )

    rendered = state.payloads["a"]["content"]
    assert "note-file-image-preview" in rendered
    assert state.payloads["a"]["flags"]["isCollapsible"] is True
    assert "trailing text" not in rendered
