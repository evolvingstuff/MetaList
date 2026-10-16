from __future__ import annotations

from dataclasses import dataclass

import pytest

import app.api.routes.notes as notes_route
import app.usecases.alphabetize_root_notes as alphabetize_module
from app.services.snapshot import SearchScope
from app.usecases.alphabetize_root_notes import CmdAlphabetizeRootNotes


@dataclass
class _FakeRecord:
    id: str
    parent_id: str | None
    content: str
    tags: str


class _FakeStore:
    def __init__(self, root_ids: list[str], *, content_by_note_id: dict[str, str]) -> None:
        if not isinstance(content_by_note_id, dict):
            raise TypeError("content_by_note_id must be a dict")
        self.root_ids = list(root_ids)
        self._records = {}
        for note_id in root_ids:
            content = ""
            if note_id in content_by_note_id:
                content = content_by_note_id[note_id]
            self._records[note_id] = _FakeRecord(
                id=note_id,
                parent_id=None,
                content=content,
                tags="",
            )

    def get(self, note_id: str) -> _FakeRecord:
        return self._records[note_id]

    def children(self, parent_id: str | None) -> list[str]:
        if parent_id is not None:
            return []
        return list(self.root_ids)


def _install_root_move_fakes(
    *,
    monkeypatch: pytest.MonkeyPatch,
    fake_store: _FakeStore,
) -> list[tuple[str, str | None, str | None, str | None]]:
    monkeypatch.setattr(alphabetize_module, "store", fake_store)

    def fake_neighbors(note_id: str) -> tuple[str | None, str | None, str | None]:
        idx = fake_store.root_ids.index(note_id)
        prev_id = None
        if idx > 0:
            prev_id = fake_store.root_ids[idx - 1]
        next_id = None
        if idx + 1 < len(fake_store.root_ids):
            next_id = fake_store.root_ids[idx + 1]
        return None, prev_id, next_id

    move_calls: list[tuple[str, str | None, str | None, str | None]] = []

    def fake_apply_move(
        note_id: str,
        new_parent_id: str | None,
        prev_id: str | None,
        next_id: str | None,
    ) -> None:
        assert new_parent_id is None
        root_ids = fake_store.root_ids
        root_ids.remove(note_id)
        if prev_id is None:
            insert_index = 0
        else:
            insert_index = root_ids.index(prev_id) + 1
        if next_id is not None:
            assert insert_index == root_ids.index(next_id)
        root_ids.insert(insert_index, note_id)
        move_calls.append((note_id, new_parent_id, prev_id, next_id))

    monkeypatch.setattr(alphabetize_module, "_neighbors", fake_neighbors)
    monkeypatch.setattr(alphabetize_module, "apply_move", fake_apply_move)
    monkeypatch.setattr(alphabetize_module, "_assert_neighbors", lambda *args: None)
    return move_calls


def test_alphabetize_ascending_reorders_only_visible_roots_and_clears_undo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_store = _FakeStore(
        ["hidden-before", "root-c", "root-a", "root-b", "hidden-after"],
        content_by_note_id={
            "hidden-before": "000",
            "root-a": "Apple",
            "root-b": "<p>banana</p>",
            "root-c": "Cherry",
            "hidden-after": "zzz",
        },
    )
    move_calls = _install_root_move_fakes(monkeypatch=monkeypatch, fake_store=fake_store)

    monkeypatch.setattr(
        alphabetize_module,
        "resolve_search_scope",
        lambda *, search, editing_note_id, sort_mode, ordered_root_ids: SearchScope(
            search_active=True,
            allowed_note_ids={"root-c", "root-a", "root-b"},
            search_root_ids_ordered=["root-c", "root-a", "root-b"],
            search_root_count_total=3,
            matched_note_ids=None,
        ),
    )

    captured: dict[str, object] = {}
    monkeypatch.setattr(
        alphabetize_module,
        "reset_undo_stack",
        lambda client_id, undo_context: captured.update(
            client_id=client_id,
            undo_context=undo_context,
        ),
    )
    monkeypatch.setattr(alphabetize_module, "generate_new_uuid", lambda: "uuid-alpha-asc")

    result = CmdAlphabetizeRootNotes(
        direction="asc",
        search_query="journal",
        client_id="client-1",
        undo_context="undo-1",
        viewport={"scrollY": 0},
    ).execute()

    assert fake_store.root_ids == ["hidden-before", "root-a", "root-b", "root-c", "hidden-after"]
    assert move_calls == [
        ("root-a", None, "hidden-before", "root-c"),
        ("root-b", None, "root-a", "root-c"),
    ]
    assert captured["client_id"] == "client-1"
    assert captured["undo_context"] == "undo-1"
    assert result == {
        "status": "moved",
        "movedRootCount": 2,
        "visibleRootCount": 3,
        "updateUUID": "uuid-alpha-asc",
    }


def test_alphabetize_descending_reorders_current_search_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_store = _FakeStore(
        ["root-a", "root-b", "root-c", "root-d"],
        content_by_note_id={
            "root-a": "alpha",
            "root-b": "bravo",
            "root-c": "charlie",
            "root-d": "delta",
        },
    )
    _install_root_move_fakes(monkeypatch=monkeypatch, fake_store=fake_store)

    monkeypatch.setattr(
        alphabetize_module,
        "resolve_search_scope",
        lambda *, search, editing_note_id, sort_mode, ordered_root_ids: SearchScope(
            search_active=True,
            allowed_note_ids={"root-a", "root-b", "root-c"},
            search_root_ids_ordered=["root-a", "root-b", "root-c"],
            search_root_count_total=3,
            matched_note_ids=None,
        ),
    )
    monkeypatch.setattr(alphabetize_module, "reset_undo_stack", lambda *args, **kwargs: None)
    monkeypatch.setattr(alphabetize_module, "generate_new_uuid", lambda: "uuid-alpha-desc")

    result = CmdAlphabetizeRootNotes(
        direction="desc",
        search_query="journal",
        client_id="client-1",
        undo_context="undo-1",
        viewport={"scrollY": 0},
    ).execute()

    assert fake_store.root_ids == ["root-c", "root-b", "root-a", "root-d"]
    assert result == {
        "status": "moved",
        "movedRootCount": 2,
        "visibleRootCount": 3,
        "updateUUID": "uuid-alpha-desc",
    }


def test_alphabetize_noops_when_already_ordered(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_store = _FakeStore(
        ["root-a", "root-b", "root-c"],
        content_by_note_id={
            "root-a": "alpha",
            "root-b": "bravo",
            "root-c": "charlie",
        },
    )
    _install_root_move_fakes(monkeypatch=monkeypatch, fake_store=fake_store)

    called = {"recorded": False}
    monkeypatch.setattr(
        alphabetize_module,
        "reset_undo_stack",
        lambda *args, **kwargs: called.update(recorded=True),
    )

    result = CmdAlphabetizeRootNotes(
        direction="asc",
        search_query=None,
        client_id="client-1",
        undo_context="undo-1",
        viewport={"scrollY": 0},
    ).execute()

    assert called["recorded"] is False
    assert result == {
        "status": "noop",
        "reason": "already_alphabetized",
        "visibleRootCount": 3,
    }


def test_alphabetize_noops_with_fewer_than_two_visible_roots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_store = _FakeStore(["root-a"], content_by_note_id={"root-a": "alpha"})
    _install_root_move_fakes(monkeypatch=monkeypatch, fake_store=fake_store)

    called = {"recorded": False}
    monkeypatch.setattr(
        alphabetize_module,
        "reset_undo_stack",
        lambda *args, **kwargs: called.update(recorded=True),
    )

    result = CmdAlphabetizeRootNotes(
        direction="asc",
        search_query=None,
        client_id="client-1",
        undo_context="undo-1",
        viewport={"scrollY": 0},
    ).execute()

    assert called["recorded"] is False
    assert result == {
        "status": "noop",
        "reason": "not_enough_roots",
        "visibleRootCount": 1,
    }


def test_alphabetize_rejects_invalid_direction() -> None:
    with pytest.raises(ValueError, match="direction must be 'asc' or 'desc'"):
        CmdAlphabetizeRootNotes(
            direction="sideways",
            search_query=None,
            client_id="client-1",
            undo_context="undo-1",
            viewport={"scrollY": 0},
        ).execute()


def test_alphabetize_route_normalizes_empty_search_query(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notes_route, "_require_viewport", lambda body: {"scrollY": 0})
    monkeypatch.setattr(notes_route, "_block_root_prioritization_when_sorted", lambda *, tab_id: None)

    captured: dict[str, object] = {}

    class _FakeCmdAlphabetizeRootNotes:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

        def execute(self) -> dict[str, str]:
            return {"status": "moved"}

    monkeypatch.setattr(notes_route, "CmdAlphabetizeRootNotes", _FakeCmdAlphabetizeRootNotes)

    result = notes_route.alphabetize_root_notes_endpoint(
        {
            "direction": "asc",
            "search_query": "",
            "clientId": "client-1",
            "undoContext": "undo-1",
            "viewport": {"scrollY": 0},
        }
    )

    assert captured == {
        "direction": "asc",
        "search_query": None,
        "client_id": "client-1",
        "undo_context": "undo-1",
        "viewport": {"scrollY": 0},
    }
    assert result == {"status": "moved"}
