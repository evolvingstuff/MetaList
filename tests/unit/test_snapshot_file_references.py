from __future__ import annotations

from types import SimpleNamespace
from typing import Dict, List, Optional

import app.services.snapshot as snapshot_module
import pytest

from app.services.snapshot import build_view_state
from tests.unit.snapshot_note_fixture import SnapshotTestNote as _Note


class _FakeNoteStore:
    def __init__(self, *, notes: Dict[str, _Note], children_by_parent: Dict[Optional[str], List[str]]):
        self._notes = notes
        self._children_by_parent = children_by_parent

    def has_backlinks(self, note_id: str) -> bool:
        return False

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
        editing_note_id=None, find_reveal_note_id=None,
        search=None,
        sort_mode="normal", date_filter=None, file_filter=None,
        client_known_note_ids=set(), previous_root_ids=[],
        visible_top_root_id=None,
        visible_bottom_root_id=None,
        is_untagged_view=False,
        start_at_list_end=False,
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


def test_embed_excalidraw_file_reference_renders_light_and_dark_previews(monkeypatch: pytest.MonkeyPatch) -> None:
    file_id = "4b0cf5b3-8d5a-4c43-9f63-5c3cc6a3f1e2"
    notes = {
        "a": _Note("a", None, None, None, False, f"<div>![[{file_id}]]</div>", ""),
    }
    file_record = SimpleNamespace(
        id=file_id,
        title="Diagram.excalidraw",
        original_filename="Diagram.excalidraw",
        mime_type="application/vnd.excalidraw+json",
        size_bytes=512,
        thumbnail_kind="excalidraw",
        content_revision=7,
    )
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        file_ids={file_id},
        file_record=file_record,
    )

    rendered = state.payloads["a"]["content"]
    assert "note-reference-file-excalidraw" in rendered
    assert f'class="note-file-excalidraw-embed" data-file-ref-id="{file_id}" data-file-revision="7"' in rendered
    assert 'data-preview-variant="light"' in rendered
    assert 'data-preview-variant="dark"' in rendered
    assert rendered.count('data-file-kind="excalidraw"') == 2
    assert "note-file-reference-badge" not in rendered
    assert state.payloads["a"]["flags"]["isCollapsible"] is True


def test_linked_excalidraw_file_reference_renders_a_file_card(monkeypatch: pytest.MonkeyPatch) -> None:
    file_id = "0f1d3c9e-7a55-4a8c-9c6f-1b8e2d7a4c11"
    notes = {
        "a": _Note("a", None, None, None, False, f"<div>[[{file_id}]]</div>", ""),
    }
    file_record = SimpleNamespace(
        id=file_id,
        title="Diagram.excalidraw",
        original_filename="Diagram.excalidraw",
        mime_type="application/vnd.excalidraw+json",
        size_bytes=512,
        thumbnail_kind="excalidraw",
        content_revision=1,
    )
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        file_ids={file_id},
        file_record=file_record,
    )

    rendered = state.payloads["a"]["content"]
    assert "note-file-excalidraw-embed" not in rendered
    assert "note-file-reference-link" in rendered
    assert "DRAW" in rendered


_DIAGRAM_ID = "6d5f8a41-0c3e-4f7b-9a2d-58e1b7c4d903"
_SOURCE_ID = "1c9e7b52-3f4a-4d8e-a6b0-7e2f9d1c5a38"


def _diagram_record() -> SimpleNamespace:
    return SimpleNamespace(
        id=_DIAGRAM_ID,
        title="Diagram.excalidraw",
        original_filename="Diagram.excalidraw",
        mime_type="application/vnd.excalidraw+json",
        size_bytes=512,
        thumbnail_kind="excalidraw",
        content_revision=4,
    )


@pytest.mark.parametrize(
    ("host_content", "host_collapsed"),
    # A link (text around the reference), and a collapsed note that is only the reference.
    [(f"<div>See [[{_SOURCE_ID}]]</div>", False), (f"<div>![[{_SOURCE_ID}]]</div>", True)],
)
def test_compact_reference_to_a_diagram_note_shows_the_diagram_thumbnail(
    monkeypatch: pytest.MonkeyPatch, host_content: str, host_collapsed: bool,
) -> None:
    notes = {
        "host": _Note("host", None, None, _SOURCE_ID, host_collapsed, host_content, ""),
        _SOURCE_ID: _Note(_SOURCE_ID, None, "host", None, True, f"<div>![[{_DIAGRAM_ID}]]</div><div>later line</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["host", _SOURCE_ID]},
        file_ids={_DIAGRAM_ID},
        file_record=_diagram_record(),
    )

    rendered = state.payloads["host"]["content"]
    assert "(empty note)" not in rendered
    assert "later line" not in rendered
    assert 'class="note-reference-link-title note-reference-link-title-media"' in rendered
    assert (
        '<span class="note-reference-link-thumbnail note-reference-link-thumbnail-diagram note-file-excalidraw-embed" '
        f'data-file-ref-id="{_DIAGRAM_ID}" data-file-revision="4" data-preview-state="idle">'
    ) in rendered
    assert 'data-preview-variant="light"' in rendered and 'data-preview-variant="dark"' in rendered
    # Thumbnails are not editable diagrams or file images with their own context-menu actions.
    assert 'data-file-kind="excalidraw"' not in rendered
    assert "Double-click to edit" not in rendered
    assert rendered.index("note-reference-link-icon") < rendered.index("note-reference-link-thumbnail")


def test_compact_reference_keeps_text_when_the_source_starts_with_text(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        "host": _Note("host", None, None, _SOURCE_ID, False, f"<div>See [[{_SOURCE_ID}]]</div>", ""),
        _SOURCE_ID: _Note(_SOURCE_ID, None, "host", None, False, f"<div>Kyoto hotel</div><div>![[{_DIAGRAM_ID}]]</div>", ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["host", _SOURCE_ID]},
        file_ids={_DIAGRAM_ID},
        file_record=_diagram_record(),
    )

    rendered = state.payloads["host"]["content"]
    assert "note-reference-link-thumbnail" not in rendered
    assert '<span class="note-reference-link-title">Kyoto hotel</span>' in rendered


def test_compact_reference_shows_an_inline_image_thumbnail_with_its_line_text(monkeypatch: pytest.MonkeyPatch) -> None:
    image = "data:image/png;base64,iVBORw0KGgo="
    notes = {
        "host": _Note("host", None, None, _SOURCE_ID, False, f"<div>See [[{_SOURCE_ID}]]</div>", ""),
        _SOURCE_ID: _Note(_SOURCE_ID, None, "host", None, False, f'<div><img src="{image}" alt="map"> Route map</div>', ""),
    }
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["host", _SOURCE_ID]},
        file_ids=set(),
        file_record=None,
    )

    rendered = state.payloads["host"]["content"]
    assert (
        '<span class="note-reference-link-thumbnail note-reference-link-thumbnail-image">'
        f'<img class="note-reference-link-thumbnail-inline" src="{image}" alt="" draggable="false"></span>'
    ) in rendered
    assert '<span class="note-reference-link-caption">Route map</span>' in rendered


def test_redacted_password_and_ai_chat_references_stay_text_only() -> None:
    from app.services.embedded_references import (
        EmbedRenderContext,
        render_compact_note_reference_link,
        render_note_content_with_embeds,
    )

    def context_for(source: _Note) -> EmbedRenderContext:
        return EmbedRenderContext(
            has_note=lambda note_id: note_id == _SOURCE_ID,
            get_note=lambda note_id: source,
            get_children=lambda parent_id: [],
            has_file=lambda file_id: file_id == _DIAGRAM_ID,
            get_file=lambda file_id: _diagram_record(),
            static_collapse_arrows=False,
        )

    password_source = _Note(_SOURCE_ID, None, None, None, False, f"<div>![[{_DIAGRAM_ID}]] hunter2</div>", "@password")
    exported = render_note_content_with_embeds(
        note_id="host",
        content_html=f"<div>See [[{_SOURCE_ID}]]</div>",
        tags="",
        context=context_for(password_source),
        static_export=True,
        redact_credentials=True,
    )
    assert "note-reference-link-thumbnail" not in exported
    assert "hunter2" not in exported

    plain_source = _Note(_SOURCE_ID, None, None, None, False, f"<div>![[{_DIAGRAM_ID}]]</div>", "")
    chat_link = render_compact_note_reference_link(
        reference_note_id=_SOURCE_ID,
        context=context_for(plain_source),
        redact_credentials=True,
    )
    assert "note-reference-link-thumbnail" not in chat_link
    assert "(empty note)" in chat_link


def test_exported_compact_reference_embeds_the_diagram_preview() -> None:
    from app.services.embedded_references import EmbedRenderContext, render_note_content_with_embeds

    source = _Note(_SOURCE_ID, None, None, None, False, f"<div>![[{_DIAGRAM_ID}]]</div>", "")
    record = _diagram_record()

    def export(data_url: str) -> str:
        return render_note_content_with_embeds(
            note_id="host",
            content_html=f"<div>See [[{_SOURCE_ID}]]</div>",
            tags="",
            context=EmbedRenderContext(
                has_note=lambda note_id: note_id == _SOURCE_ID,
                get_note=lambda note_id: source,
                get_children=lambda parent_id: [],
                has_file=lambda file_id: file_id == _DIAGRAM_ID,
                get_file=lambda file_id: SimpleNamespace(**vars(record), export_data_url=data_url),
                static_collapse_arrows=False,
            ),
            static_export=True,
            redact_credentials=True,
        )

    rendered = export("data:image/svg+xml;base64,PHN2Zy8+")
    assert '<img class="note-reference-link-thumbnail-static" src="data:image/svg+xml;base64,PHN2Zy8+" alt="" />' in rendered
    assert "data-file-ref-id" not in rendered
    assert "(empty note)" in export("")


def test_file_pill_tooltip_says_clicking_downloads_the_file(monkeypatch: pytest.MonkeyPatch) -> None:
    file_id = "9ec1c81f-2d96-46f1-a455-e3e77798ae1f"
    notes = {"a": _Note("a", None, None, None, False, f"![[{file_id}]]", "")}
    file_record = SimpleNamespace(
        id=file_id,
        title='Q&A "notes".md',
        original_filename='Q&A "notes".md',
        mime_type="text/markdown",
        size_bytes=10,
        thumbnail_kind="text",
    )
    state = _state_for(
        monkeypatch=monkeypatch,
        notes=notes,
        children_by_parent={None: ["a"]},
        file_ids={file_id},
        file_record=file_record,
    )

    rendered = state.payloads["a"]["content"]
    assert 'title="Click to download Q&amp;A &quot;notes&quot;.md"' in rendered
    assert '<span class="note-file-reference-badge">.MD</span>' in rendered
