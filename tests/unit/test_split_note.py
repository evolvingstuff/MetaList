from __future__ import annotations

import app.usecases.split_note as split_module
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


class _FakeStore:
    def __init__(self) -> None:
        self.records = {
            "a": _record(
                "a",
                parent_id=None,
                prev_id=None,
                next_id="old-next",
                content="foo bar baz",
                tags="tag",
            ),
            "old-next": _record(
                "old-next",
                parent_id=None,
                prev_id="a",
                next_id=None,
                content="old",
                tags="tag",
            ),
        }

    def get(self, note_id: str) -> NodeRecord:
        return self.records[note_id]


def test_split_note_updates_original_inserts_siblings_and_records_one_undo(monkeypatch) -> None:
    fake_store = _FakeStore()
    captured = {
        "updates": [],
        "inserts": [],
        "undo": None,
    }
    new_ids = iter(["b", "c"])

    def _fake_update(note_id: str, content: str, tags: str, token: str) -> None:
        captured["updates"].append((note_id, content, tags, token))
        record = fake_store.records[note_id]
        fake_store.records[note_id] = _record(
            note_id,
            parent_id=record.parent_id,
            prev_id=record.prev_id,
            next_id=record.next_id,
            content=content,
            tags=tags,
        )

    def _fake_insert(
        note_id: str,
        parent_id: str | None,
        prev_id: str | None,
        next_id: str | None,
        token: str,
        *,
        content: str,
        tags: str,
        proposed_tags: str,
    ) -> None:
        assert proposed_tags == ""
        captured["inserts"].append((note_id, parent_id, prev_id, next_id, token, content, tags))
        if prev_id is not None:
            previous = fake_store.records[prev_id]
            fake_store.records[prev_id] = _record(
                previous.id,
                parent_id=previous.parent_id,
                prev_id=previous.prev_id,
                next_id=note_id,
                content=previous.content,
                tags=previous.tags,
            )
        if next_id is not None:
            next_record = fake_store.records[next_id]
            fake_store.records[next_id] = _record(
                next_record.id,
                parent_id=next_record.parent_id,
                prev_id=note_id,
                next_id=next_record.next_id,
                content=next_record.content,
                tags=next_record.tags,
            )
        fake_store.records[note_id] = _record(
            note_id,
            parent_id=parent_id,
            prev_id=prev_id,
            next_id=next_id,
            content=content,
            tags=tags,
        )

    def _fake_record_split_note(*args, **kwargs) -> None:
        captured["undo"] = (args, kwargs)

    monkeypatch.setattr(split_module, "store", fake_store)
    monkeypatch.setattr(split_module, "apply_update_content", _fake_update)
    monkeypatch.setattr(split_module, "apply_insert_note", _fake_insert)
    monkeypatch.setattr(split_module, "record_split_note", _fake_record_split_note)
    monkeypatch.setattr(split_module.uuid, "uuid4", lambda: next(new_ids))
    monkeypatch.setattr(split_module, "generate_new_uuid", lambda: "uuid-split")

    command = split_module.CmdSplitNote(
        note_id="a",
        segments=["foo", "bar", "baz"],
        tags="tag",
        token="token",
        client_id="client",
        undo_context="tab:1|search:|epoch:0",
        viewport={"scrollY": 0, "scrollAnchor": None},
    )
    result = command.execute()

    assert captured["updates"] == [("a", "foo", "tag", "token")]
    assert captured["inserts"] == [
        ("b", None, "a", "old-next", "token", "bar", "tag"),
        ("c", None, "b", "old-next", "token", "baz", "tag"),
    ]
    assert captured["undo"] is not None
    _, undo_kwargs = captured["undo"]
    assert undo_kwargs["note_id"] == "a"
    assert undo_kwargs["before_content"] == "foo bar baz"
    assert undo_kwargs["after_content"] == "foo"
    assert [record.id for record in undo_kwargs["inserted_records"]] == ["b", "c"]
    assert result == {
        "status": "split",
        "id": "a",
        "createdIds": ["b", "c"],
        "updateUUID": "uuid-split",
    }
