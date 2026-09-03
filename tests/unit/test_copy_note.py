from __future__ import annotations

from datetime import datetime, timezone

import pytest

import app.usecases.copy_note as copy_module
from app.services.note_store import NoteRecord


def _record(note_id: str, parent_id: str | None, proposed_tags: str) -> NoteRecord:
    timestamp = datetime(2026, 9, 3, tzinfo=timezone.utc)
    return NoteRecord(
        id=note_id,
        parent_id=parent_id,
        prev_id=None,
        next_id=None,
        is_collapsed=False,
        content=f"<div>{note_id}</div>",
        tags="human-tag",
        proposed_tags=proposed_tags,
        tag_terms=frozenset({"human-tag"}),
        non_meta_tag_terms=frozenset({"human-tag"}),
        proposed_tag_terms=frozenset(proposed_tags.split()),
        proposed_non_meta_tag_terms=frozenset(proposed_tags.split()),
        created_at=timestamp,
        updated_at=timestamp,
    )


def test_copy_subtree_preserves_each_notes_direct_proposals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    records = {
        "root": _record("root", None, "root-proposal"),
        "child": _record("child", "root", "child-a child-b"),
    }

    class _Store:
        def get(self, note_id: str) -> NoteRecord:
            return records[note_id]

        def children(self, note_id: str) -> list[str]:
            if note_id == "root":
                return ["child"]
            return []

    monkeypatch.setattr(copy_module, "store", _Store())
    clipboard_payloads: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        copy_module,
        "set_clipboard",
        lambda client_id, payload: clipboard_payloads.append(payload),
    )
    monkeypatch.setattr(copy_module, "render_note_data_read_only", lambda tree: tree)
    monkeypatch.setattr(copy_module, "note_data_to_html", lambda tree: "html")
    monkeypatch.setattr(copy_module, "note_data_to_plain_text", lambda tree: "text")
    monkeypatch.setattr(copy_module, "generate_new_uuid", lambda: "update-1")

    copy_module.CmdCopyNote(note_id="root", client_id="client").execute()

    assert [entry["proposed_tags"] for entry in clipboard_payloads[0]] == [
        "root-proposal",
        "child-a child-b",
    ]
