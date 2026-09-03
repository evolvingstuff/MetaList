from __future__ import annotations

from app.services import undo_state
from app.services.store import NodeRecord


def _record(
    note_id: str,
    *,
    parent_id: str | None,
    prev_id: str | None,
    next_id: str | None,
    content: str,
    tags: str,
) -> NodeRecord:
    return NodeRecord(
        id=note_id,
        parent_id=parent_id,
        prev_id=prev_id,
        next_id=next_id,
        is_collapsed=False,
        content=content,
        tags=tags,
        proposed_tags="",
        tag_terms=frozenset(),
        non_meta_tag_terms=frozenset(),
        proposed_tag_terms=frozenset(),
        proposed_non_meta_tag_terms=frozenset(),
        created_at=None,
        updated_at=None,
    )


def test_undo_and_redo_split_note_are_one_history_operation(monkeypatch) -> None:
    undo_state._clients.clear()

    calls: list[tuple[str, object]] = []

    monkeypatch.setattr(
        undo_state,
        "apply_update_content",
        lambda note_id, content, tags, token: calls.append(("update", (note_id, content, tags, token))),
    )
    monkeypatch.setattr(
        undo_state,
        "apply_delete_subtree",
        lambda note_id: calls.append(("delete", note_id)),
    )
    monkeypatch.setattr(
        undo_state,
        "apply_restore_records",
        lambda records, token: calls.append(("restore", ([record.id for record in records], token))),
    )
    monkeypatch.setattr(undo_state, "generate_new_uuid", lambda: None)
    monkeypatch.setattr(undo_state, "_root_ancestor_id", lambda note_id: note_id)

    client_id = "client-split"
    token = "token"
    undo_context = "tab:main|search:|epoch:0"
    viewport = {"scrollY": 0, "scrollAnchor": None}
    inserted_records = [
        _record("b", parent_id=None, prev_id="a", next_id="c", content="bar", tags="tag"),
        _record("c", parent_id=None, prev_id="b", next_id=None, content="baz", tags="tag"),
    ]

    undo_state.record_split_note(
        client_id,
        undo_context,
        note_id="a",
        before_content="foo bar baz",
        before_tags="tag",
        after_content="foo",
        after_tags="tag",
        inserted_records=inserted_records,
        viewport=viewport,
    )

    ctx = undo_state._ctx(client_id)
    assert len(ctx.history) == 1
    assert ctx.history[0]["type"] == "split_note"

    undo_payload = undo_state.undo(client_id, token)

    assert undo_payload is not None
    assert undo_payload["opType"] == "split_note"
    assert undo_payload["focusNoteId"] == "a"
    assert calls == [
        ("delete", "c"),
        ("delete", "b"),
        ("update", ("a", "foo bar baz", "tag", token)),
    ]
    assert len(ctx.history) == 0
    assert len(ctx.redo) == 1

    calls.clear()
    redo_payload = undo_state.redo(client_id, token)

    assert redo_payload is not None
    assert redo_payload["opType"] == "split_note"
    assert redo_payload["focusNoteId"] == "a"
    assert calls == [
        ("update", ("a", "foo", "tag", token)),
        ("restore", (["b", "c"], token)),
    ]
    assert len(ctx.history) == 1
    assert len(ctx.redo) == 0
