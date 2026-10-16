from __future__ import annotations

import app.usecases.paste_child as paste_child_module
import app.usecases.paste_reference as paste_reference_module
import app.usecases.paste_sibling as paste_sibling_module
from tests.unit.test_paste_sibling import _FakeStore, _record

_VIEWPORT = {"scrollY": 0, "scrollAnchor": None}
_UNDO_CONTEXT = "tab:1|search:|epoch:0"


class _ReferenceStore(_FakeStore):
    def contains(self, note_id: str) -> bool:
        return note_id in self._records


def _store_with(records: dict, children_by_parent: dict, monkeypatch) -> _ReferenceStore:
    fake_store = _ReferenceStore(records=records, children_by_parent=children_by_parent)
    for module in (paste_sibling_module, paste_child_module, paste_reference_module):
        monkeypatch.setattr(module, "store", fake_store)
    return fake_store


def _note(note_id: str, content: str, tags: str):
    return _record(note_id=note_id, parent_id=None, prev_id=None, next_id=None, content=content, tags=tags, proposed_tags="")


def _recording_insert(calls: list[tuple]):
    def insert(snapshot, parent, prev, token, *, search_query):
        calls.append((snapshot, parent, prev))
        return "new"
    return insert


def _sibling_command(*, target: str, reference: str):
    return paste_reference_module.CmdPasteReferenceSibling(
        target_note_id=target, reference_note_id=reference, search_query=None, token="token",
        client_id="client", undo_context=_UNDO_CONTEXT, viewport=_VIEWPORT,
    )


def _child_command(*, target: str, reference: str):
    return paste_reference_module.CmdPasteReferenceChild(
        target_note_id=target, reference_note_id=reference, search_query=None, token="token",
        client_id="client", undo_context=_UNDO_CONTEXT, viewport=_VIEWPORT,
    )


def test_the_reference_is_one_note_holding_the_embed_token() -> None:
    assert paste_reference_module.reference_snapshot("copied") == [{
        "id": "copied", "parent_id": None, "is_collapsed": False, "content": "<div>[[copied]]</div>", "tags": "", "proposed_tags": "",
    }]


def test_a_reference_fills_an_empty_note_keeping_its_tags(monkeypatch) -> None:
    _store_with({"target": _note("target", "", "today"), "copied": _note("copied", "<div>Copied</div>", "x")},
                {None: ["target", "copied"]}, monkeypatch)
    captured: dict[str, object] = {}
    monkeypatch.setattr(paste_sibling_module, "apply_update_note_sources", lambda **kwargs: captured.update(updated=kwargs))
    monkeypatch.setattr(paste_sibling_module, "record_paste_into", lambda *args, **kwargs: captured.update(undo=kwargs))
    monkeypatch.setattr(paste_sibling_module, "generate_new_uuid", lambda: "uuid-pasted")

    result = _sibling_command(target="target", reference="copied").execute()

    assert result == {"status": "pasted", "id": "target", "updateUUID": "uuid-pasted"}
    assert captured["updated"] == {
        "note_id": "target", "content": "<div>[[copied]]</div>", "tags": "today", "proposed_tags": "", "token": "token",
    }
    assert captured["undo"]["after_content"] == "<div>[[copied]]</div>"


def test_a_reference_goes_below_a_note_with_text(monkeypatch) -> None:
    _store_with({"target": _note("target", "<div>Target</div>", ""), "copied": _note("copied", "<div>Copied</div>", "")},
                {None: ["target", "copied"]}, monkeypatch)
    calls: list[tuple] = []
    monkeypatch.setattr(paste_sibling_module, "_insert_cloned_subtree_at", _recording_insert(calls))
    monkeypatch.setattr(paste_sibling_module, "_collect_subtree_ids", lambda root: [])
    monkeypatch.setattr(paste_sibling_module, "record_paste", lambda *args, **kwargs: None)
    monkeypatch.setattr(paste_sibling_module, "generate_new_uuid", lambda: "uuid-pasted")

    result = _sibling_command(target="target", reference="copied").execute()

    assert result == {"status": "pasted", "id": "new", "updateUUID": "uuid-pasted"}
    assert calls == [(paste_reference_module.reference_snapshot("copied"), None, "target")]


def test_a_child_reference_comes_first_among_the_children(monkeypatch) -> None:
    _store_with({"target": _note("target", "<div>Target</div>", ""), "copied": _note("copied", "<div>Copied</div>", "")},
                {None: ["target", "copied"], "target": ["existing"]}, monkeypatch)
    calls: list[tuple] = []
    monkeypatch.setattr(paste_child_module, "_insert_cloned_subtree_at", _recording_insert(calls))
    monkeypatch.setattr(paste_child_module, "_collect_subtree_ids", lambda root: [])
    monkeypatch.setattr(paste_child_module, "record_paste", lambda *args, **kwargs: None)
    monkeypatch.setattr(paste_child_module, "generate_new_uuid", lambda: "uuid-pasted")

    result = _child_command(target="target", reference="copied").execute()

    assert result == {"status": "pasted", "id": "new", "updateUUID": "uuid-pasted"}
    assert calls == [(paste_reference_module.reference_snapshot("copied"), "target", None)]


def test_a_reference_to_a_note_deleted_since_reports_an_expired_clipboard(monkeypatch) -> None:
    _store_with({"target": _note("target", "<div>Target</div>", "")}, {None: ["target"]}, monkeypatch)

    assert _sibling_command(target="target", reference="gone").execute() == {"status": "clipboard_empty"}
    assert _child_command(target="target", reference="gone").execute() == {"status": "clipboard_empty"}
