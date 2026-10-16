from __future__ import annotations

from datetime import datetime, timezone

import app.usecases.collapse as collapse_module
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


def test_a_paste_keeps_each_copied_note_collapsed_or_expanded(monkeypatch) -> None:
    # A copied note's collapse state, and every child's, comes back on paste.
    inserted: dict[str, str] = {}
    collapsed_writes: dict[str, bool] = {}
    children: dict[str | None, list[str]] = {None: []}
    records: dict[str, NoteRecord] = {}

    def fake_insert(new_id, parent_id, prev_id, next_id, token, *, content, tags, proposed_tags) -> None:
        inserted[content] = new_id
        if parent_id not in children:
            children[parent_id] = []
        children[parent_id].append(new_id)
        children[new_id] = []
        records[new_id] = _record(note_id=new_id, parent_id=parent_id, prev_id=prev_id, next_id=next_id,
                                  content=content, tags=tags, proposed_tags=proposed_tags)

    fake_store = _FakeStore(records=records, children_by_parent=children)
    monkeypatch.setattr(paste_sibling_module, "store", fake_store)
    monkeypatch.setattr(paste_sibling_module, "apply_insert_note", fake_insert)
    monkeypatch.setattr(collapse_module, "begin_writer", lambda: _NullWriter())
    monkeypatch.setattr(collapse_module, "db_update_links_preserving_updated_at",
                        lambda connection, note_id, **updates: collapsed_writes.update({note_id: updates["is_collapsed"]}))
    monkeypatch.setattr(collapse_module.store, "set_collapsed", lambda note_id, value: None)

    snapshot = [
        {"id": "root", "parent_id": None, "is_collapsed": False, "content": "root", "tags": "", "proposed_tags": ""},
        {"id": "folded", "parent_id": "root", "is_collapsed": True, "content": "folded", "tags": "", "proposed_tags": ""},
        {"id": "inner", "parent_id": "folded", "is_collapsed": False, "content": "inner", "tags": "", "proposed_tags": ""},
        {"id": "open", "parent_id": "root", "is_collapsed": False, "content": "open", "tags": "", "proposed_tags": ""},
    ]
    paste_sibling_module._insert_cloned_subtree_at(snapshot, None, None, "token", search_query=None)

    assert collapsed_writes == {inserted["folded"]: True}


class _NullWriter:
    def __enter__(self):
        return None

    def __exit__(self, *exc_info) -> bool:
        return False
