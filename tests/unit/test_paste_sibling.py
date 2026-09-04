from __future__ import annotations

from datetime import datetime, timezone

import app.usecases.paste_child as paste_child_module
import app.usecases.paste_sibling as paste_sibling_module
from app.services.note_store import NoteRecord


class _FakeStore:
    def __init__(self, records: dict[str, NoteRecord], children_by_parent: dict[str | None, list[str]]) -> None:
        self._records = records
        self._children_by_parent = children_by_parent

    def get(self, note_id: str) -> NoteRecord:
        return self._records[note_id]

    def children(self, parent_id: str | None) -> list[str]:
        if parent_id in self._children_by_parent:
            return list(self._children_by_parent[parent_id])
        return []


def _record(
    *,
    note_id: str,
    parent_id: str | None,
    prev_id: str | None,
    next_id: str | None,
    content: str,
    tags: str,
    proposed_tags: str,
) -> NoteRecord:
    return NoteRecord(
        id=note_id,
        parent_id=parent_id,
        prev_id=prev_id,
        next_id=next_id,
        is_collapsed=False,
        content=content,
        tags=tags,
        proposed_tags=proposed_tags,
        tag_terms=frozenset(),
        non_meta_tag_terms=frozenset(),
        proposed_tag_terms=frozenset(),
        proposed_non_meta_tag_terms=frozenset(),
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )


def test_paste_sibling_replaces_blank_target_even_when_target_has_tags(monkeypatch) -> None:
    target = _record(
        note_id="target",
        parent_id=None,
        prev_id=None,
        next_id=None,
        content="",
        tags="today ABC",
        proposed_tags="existing-proposal",
    )
    fake_store = _FakeStore(records={"target": target}, children_by_parent={None: ["target"], "target": []})
    monkeypatch.setattr(paste_sibling_module, "store", fake_store)
    monkeypatch.setattr(
        paste_sibling_module,
        "get_clipboard",
        lambda client_id: [
            {
                "id": "copied-root",
                "parent_id": None,
                "prev_id": None,
                "next_id": None,
                "is_collapsed": False,
                "content": "<div>Copied</div>",
                "tags": "copied-tag ABC abc",
                "proposed_tags": "copied-proposal EXISTING-PROPOSAL",
            }
        ],
    )

    captured: dict[str, object] = {}

    def _fake_apply_update_note_sources(**kwargs) -> None:
        captured["updated"] = kwargs

    def _fake_record_paste_into(*args, **kwargs) -> None:
        captured["undo"] = (args, kwargs)

    monkeypatch.setattr(
        paste_sibling_module,
        "apply_update_note_sources",
        _fake_apply_update_note_sources,
    )
    monkeypatch.setattr(paste_sibling_module, "record_paste_into", _fake_record_paste_into)
    monkeypatch.setattr(paste_sibling_module, "generate_new_uuid", lambda: "uuid-pasted")

    command = paste_sibling_module.CmdPasteSibling(
        target_note_id="target",
        search_query=None,
        token="token",
        client_id="client",
        undo_context="tab:1|search:|epoch:0",
        viewport={"scrollY": 0, "scrollAnchor": None},
    )
    result = command.execute()

    assert result == {"status": "pasted", "id": "target", "updateUUID": "uuid-pasted"}
    assert captured["updated"] == {
        "note_id": "target",
        "content": "<div>Copied</div>",
        "tags": "today ABC copied-tag",
        "proposed_tags": "existing-proposal copied-proposal",
        "token": "token",
    }
    assert captured["undo"] is not None


def test_paste_sibling_reports_expired_server_clipboard_without_crashing(monkeypatch) -> None:
    monkeypatch.setattr(paste_sibling_module, "get_clipboard", lambda client_id: [])

    command = paste_sibling_module.CmdPasteSibling(
        target_note_id="target",
        search_query=None,
        token="token",
        client_id="client",
        undo_context="tab:1|search:|epoch:0",
        viewport={"scrollY": 0, "scrollAnchor": None},
    )

    assert command.execute() == {"status": "clipboard_empty"}


def test_paste_child_reports_expired_server_clipboard_without_crashing(monkeypatch) -> None:
    monkeypatch.setattr(paste_child_module, "get_clipboard", lambda client_id: [])

    command = paste_child_module.CmdPasteChild(
        target_note_id="target",
        search_query=None,
        token="token",
        client_id="client",
        undo_context="tab:1|search:|epoch:0",
        viewport={"scrollY": 0, "scrollAnchor": None},
    )

    assert command.execute() == {"status": "clipboard_empty"}
