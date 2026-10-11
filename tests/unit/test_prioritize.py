from __future__ import annotations

from datetime import date
from contextlib import contextmanager
from dataclasses import dataclass

import pytest

import app.api.routes.notes as notes_route
import app.usecases.prioritize as prioritize_module
from app.services.search_index import SearchIndex, SearchRecord
from app.usecases.prioritize import CmdPrioritize
from app.usecases.prioritize import list_prioritize_tag_suggestions


@dataclass
class _FakeRecord:
    id: str
    parent_id: str | None
    tags: str


class _FakeStore:
    def __init__(self, root_ids: list[str], *, tags_by_note_id: dict[str, str]) -> None:
        if not isinstance(tags_by_note_id, dict):
            raise TypeError("tags_by_note_id must be a dict")
        self.root_ids = list(root_ids)
        self._records = {}
        for note_id in root_ids:
            tags = ""
            if note_id in tags_by_note_id:
                tags = tags_by_note_id[note_id]
            self._records[note_id] = _FakeRecord(id=note_id, parent_id=None, tags=tags)

    def get(self, note_id: str) -> _FakeRecord:
        return self._records[note_id]

    def children(self, parent_id: str | None) -> list[str]:
        if parent_id is not None:
            return []
        return list(self.root_ids)

    def bulk_update_metadata(self, notes, *, rebuild: bool) -> None:
        assert rebuild is True
        payload = list(notes)
        self.root_ids = [note.id for note in payload]


def _install_root_reorder_fakes(
    *,
    monkeypatch: pytest.MonkeyPatch,
    fake_store: _FakeStore,
    module,
) -> list[tuple[str, str | None, str | None]]:
    monkeypatch.setattr(module, "store", fake_store)

    def fake_neighbors(note_id: str) -> tuple[str | None, str | None, str | None]:
        idx = fake_store.root_ids.index(note_id)
        prev_id = None
        if idx > 0:
            prev_id = fake_store.root_ids[idx - 1]
        next_id = None
        if idx + 1 < len(fake_store.root_ids):
            next_id = fake_store.root_ids[idx + 1]
        return None, prev_id, next_id

    update_calls: list[tuple[str, str | None, str | None]] = []

    @contextmanager
    def fake_begin_writer():
        yield object()

    def fake_db_update_links(
        connection,
        note_id: str,
        **updates,
    ) -> None:
        assert connection is not None
        assert updates["parent_id"] is None
        assert "updated_at" not in updates
        update_calls.append((note_id, updates["prev_id"], updates["next_id"]))

    monkeypatch.setattr(module, "_neighbors", fake_neighbors)
    monkeypatch.setattr(module, "begin_writer", fake_begin_writer)
    monkeypatch.setattr(module, "db_update_links_preserving_updated_at", fake_db_update_links)
    monkeypatch.setattr(module, "_assert_neighbors", lambda *args: None)
    return update_calls


def test_prioritize_front_reorders_global_roots_and_clears_undo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_store = _FakeStore(
        ["hidden-root", "root-b", "root-c", "root-d", "after-root"],
        tags_by_note_id={},
    )
    update_calls = _install_root_reorder_fakes(
        monkeypatch=monkeypatch,
        fake_store=fake_store,
        module=prioritize_module,
    )

    monkeypatch.setattr(
        prioritize_module.search_index,
        "query_note_ids",
        lambda query: {"root-d"} if query == "foo" else set(),
    )

    captured: dict[str, object] = {}
    monkeypatch.setattr(
        prioritize_module,
        "reset_undo_stack",
        lambda client_id, undo_context: captured.update(
            client_id=client_id,
            undo_context=undo_context,
        ),
    )
    monkeypatch.setattr(prioritize_module, "generate_new_uuid", lambda: "uuid-prioritize-front")

    result = CmdPrioritize(
        tag="foo",
        direction="front",
        search_query="journal",
        client_id="client-1",
        undo_context="undo-1",
        viewport={"scrollY": 0},
    ).execute()

    assert fake_store.root_ids == ["root-d", "hidden-root", "root-b", "root-c", "after-root"]
    assert update_calls == [
        ("root-d", None, "hidden-root"),
        ("hidden-root", "root-d", "root-b"),
        ("root-c", "root-b", "after-root"),
        ("after-root", "root-c", None),
    ]
    assert captured["client_id"] == "client-1"
    assert captured["undo_context"] == "undo-1"
    assert result == {
        "status": "moved",
        "movedRootCount": 1,
        "matchedRootCount": 1,
        "rootCount": 5,
        "updateUUID": "uuid-prioritize-front",
    }


def test_prioritize_back_keeps_match_and_non_match_order_stable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_store = _FakeStore(
        ["root-a", "root-b", "root-c", "root-d", "root-e", "root-f"],
        tags_by_note_id={},
    )
    _install_root_reorder_fakes(
        monkeypatch=monkeypatch,
        fake_store=fake_store,
        module=prioritize_module,
    )

    monkeypatch.setattr(
        prioritize_module.search_index,
        "query_note_ids",
        lambda query: {"root-b", "root-d"} if query == "foo" else set(),
    )
    monkeypatch.setattr(prioritize_module, "reset_undo_stack", lambda *args, **kwargs: None)
    monkeypatch.setattr(prioritize_module, "generate_new_uuid", lambda: "uuid-prioritize-back")

    result = CmdPrioritize(
        tag="foo",
        direction="back",
        search_query="journal",
        client_id="client-1",
        undo_context="undo-1",
        viewport={"scrollY": 0},
    ).execute()

    assert fake_store.root_ids == ["root-a", "root-c", "root-e", "root-f", "root-b", "root-d"]
    assert result == {
        "status": "moved",
        "movedRootCount": 2,
        "matchedRootCount": 2,
        "rootCount": 6,
        "updateUUID": "uuid-prioritize-back",
    }


def test_prioritize_noops_when_no_global_roots_match(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_store = _FakeStore(["root-a", "root-b", "root-c"], tags_by_note_id={})
    _install_root_reorder_fakes(
        monkeypatch=monkeypatch,
        fake_store=fake_store,
        module=prioritize_module,
    )
    monkeypatch.setattr(prioritize_module.search_index, "query_note_ids", lambda query: set())

    called = {"recorded": False}
    monkeypatch.setattr(
        prioritize_module,
        "reset_undo_stack",
        lambda *args, **kwargs: called.update(recorded=True),
    )

    result = CmdPrioritize(
        tag="foo",
        direction="front",
        search_query="journal",
        client_id="client-1",
        undo_context="undo-1",
        viewport={"scrollY": 0},
    ).execute()

    assert fake_store.root_ids == ["root-a", "root-b", "root-c"]
    assert called["recorded"] is False
    assert result == {
        "status": "noop",
        "reason": "no_matches",
        "matchedRootCount": 0,
        "rootCount": 3,
    }


def test_prioritize_noops_when_order_is_already_prioritized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_store = _FakeStore(
        ["root-b", "root-d", "root-a", "root-c", "root-e"],
        tags_by_note_id={},
    )
    _install_root_reorder_fakes(
        monkeypatch=monkeypatch,
        fake_store=fake_store,
        module=prioritize_module,
    )
    monkeypatch.setattr(
        prioritize_module.search_index,
        "query_note_ids",
        lambda query: {"root-b", "root-d"} if query == "foo" else set(),
    )

    called = {"recorded": False}
    monkeypatch.setattr(
        prioritize_module,
        "reset_undo_stack",
        lambda *args, **kwargs: called.update(recorded=True),
    )

    result = CmdPrioritize(
        tag="foo",
        direction="front",
        search_query="journal",
        client_id="client-1",
        undo_context="undo-1",
        viewport={"scrollY": 0},
    ).execute()

    assert fake_store.root_ids == ["root-b", "root-d", "root-a", "root-c", "root-e"]
    assert called["recorded"] is False
    assert result == {
        "status": "noop",
        "reason": "already_prioritized",
        "matchedRootCount": 2,
        "rootCount": 5,
    }


def test_prioritize_rejects_invalid_tag() -> None:
    with pytest.raises(ValueError, match="single valid tag token"):
        CmdPrioritize(
            tag="bad tag",
            direction="front",
            search_query=None,
            client_id="client-1",
            undo_context="undo-1",
            viewport={"scrollY": 0},
        ).execute()


def test_list_prioritize_tag_suggestions_uses_global_root_tags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_store = _FakeStore(
        ["hidden-root", "root-a", "root-b", "root-c"],
        tags_by_note_id={
            "hidden-root": "hidden",
            "root-a": "foo workspaces",
            "root-b": "Foo databricks-workspaces",
            "root-c": "bar",
        },
    )
    monkeypatch.setattr(prioritize_module, "store", fake_store)

    suggestions = list_prioritize_tag_suggestions(
        search_query="journal",
        query="",
        limit=10,
    )

    assert suggestions == ["foo", "bar", "databricks-workspaces", "hidden", "workspaces"]


def test_list_prioritize_tag_suggestions_filters_by_segment_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_store = _FakeStore(
        ["root-a", "root-b", "root-c"],
        tags_by_note_id={
            "root-a": "workspaces",
            "root-b": "databricks-workspaces",
            "root-c": "personal",
        },
    )
    monkeypatch.setattr(prioritize_module, "store", fake_store)

    suggestions = list_prioritize_tag_suggestions(
        search_query="journal",
        query="wor",
        limit=10,
    )

    assert suggestions == ["workspaces", "databricks-workspaces"]


def test_prioritize_route_normalizes_empty_search_query(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notes_route, "_require_viewport", lambda body: {"scrollY": 0})

    captured: dict[str, object] = {}

    class _FakeCmdPrioritize:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

        def execute(self) -> dict[str, str]:
            return {"status": "moved"}

    monkeypatch.setattr(notes_route, "CmdPrioritize", _FakeCmdPrioritize)

    result = notes_route.prioritize_in_view_endpoint(
        {
            "tag": "foo",
            "direction": "front",
            "search_query": "",
            "clientId": "client-1",
            "undoContext": "undo-1",
            "viewport": {"scrollY": 0},
        }
    )

    assert captured == {
        "tag": "foo",
        "direction": "front",
        "search_query": None,
        "client_id": "client-1",
        "undo_context": "undo-1",
        "viewport": {"scrollY": 0},
    }
    assert result == {"status": "moved"}


def test_prioritize_tag_suggestions_route_normalizes_empty_search_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        notes_route,
        "list_prioritize_tag_suggestions",
        lambda *, search_query, query, limit: captured.update(
            search_query=search_query,
            query=query,
            limit=limit,
        ) or ["foo"],
    )

    result = notes_route.prioritize_tag_suggestions(
        {
            "query": "fo",
            "search_query": "",
        }
    )

    assert captured == {
        "search_query": None,
        "query": "fo",
        "limit": 20,
    }
    assert result == {"suggestions": ["foo"]}


def test_search_suggestions_route_uses_configured_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(notes_route, "MAX_SEARCH_SUGGESTIONS", 7)
    monkeypatch.setattr(
        notes_route.search_index,
        "suggest_all_tag_completions",
        lambda *, query: captured.update(query=query) or [f"tag-{index}" for index in range(10)],
    )

    result = notes_route.search_suggestions(
        None,
        {"query": "foo bar", "windowDays": [1, 7, 30]},
    )

    assert captured == {
        "query": "foo bar",
    }
    assert result == {
        "suggestions": [f"tag-{index}" for index in range(7)],
        "personalizedSuggestions": [],
    }


def test_search_suggestions_route_excludes_nonexistent_tag_combination(monkeypatch) -> None:
    index = SearchIndex()
    records = [
        SearchRecord('prediction', '', 'prediction-future', frozenset({'prediction-future'})),
        SearchRecord('security', '', 'computer-security', frozenset({'computer-security'})),
    ]
    index.rebuild(
        records, raw_tag_terms_by_id={record.note_id: record.tag_terms for record in records},
        progress_update=lambda _processed: None, progress_interval=1000,
    )
    monkeypatch.setattr(notes_route, 'search_index', index)

    assert notes_route.search_suggestions(
        None, {'query': 'prediction-future security', 'windowDays': [1, 7, 30]},
    ) == {'suggestions': [], 'personalizedSuggestions': []}


def test_search_suggestions_route_reports_each_promoting_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        notes_route.search_index,
        "suggest_all_tag_completions",
        lambda *, query: ["short-story", "shortcut", "short-selling"],
    )
    monkeypatch.setattr(notes_route, "_require_bearer_token", lambda _request: "token")
    monkeypatch.setattr(notes_route, "current_local_date", lambda: date(2026, 8, 20))
    monkeypatch.setattr(
        notes_route,
        "list_recent_search_tag_selections_for_first_query",
        lambda **_kwargs: [
            notes_route.TagActivityWindowSelection(tag="shortcut", window_days=1),
            notes_route.TagActivityWindowSelection(tag="short-selling", window_days=7),
        ],
    )

    result = notes_route.search_suggestions(
        object(),
        {"query": "shor", "windowDays": [1, 7, 30]},
    )

    assert result == {
        "suggestions": ["shortcut", "short-selling", "short-story"],
        "personalizedSuggestions": [
            {"tag": "shortcut", "windowDays": 1},
            {"tag": "short-selling", "windowDays": 7},
        ],
    }


def test_delete_tag_interactions_route_resets_active_namespace_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(notes_route, "_require_bearer_token", lambda _request: "token")
    monkeypatch.setattr(
        notes_route,
        "reset_search_history",
        lambda *, token: captured.update(token=token) or 17,
    )

    result = notes_route.delete_tag_interactions(object())

    assert captured == {"token": "token"}
    assert result == {"deletedCount": 17}


def test_get_tag_interactions_route_returns_search_suggestion_statistics(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    statistics = {
        "retentionPopulatedDayLimit": 365,
        "days": [],
    }
    monkeypatch.setattr(notes_route, "_require_bearer_token", lambda _request: "token")
    monkeypatch.setattr(
        notes_route,
        "list_search_suggestion_statistics",
        lambda *, token: captured.update(token=token) or statistics,
    )

    result = notes_route.get_tag_interactions(object())

    assert captured == {"token": "token"}
    assert result == statistics


def test_tag_interactions_route_credits_the_note_not_the_search_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(notes_route, "_require_bearer_token", lambda _request: "token")
    monkeypatch.setattr(notes_route, "_require_note_present", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(notes_route, "current_local_date", lambda: date(2026, 8, 20))
    monkeypatch.setattr(
        notes_route,
        "record_note_interaction",
        lambda **kwargs: captured.update(kwargs) or True,
    )

    result = notes_route.tag_interactions(
        object(),
        {"noteId": "note-1", "interactionType": "expand"},
    )

    assert captured == {
        "note_id": "note-1",
        "interaction_type": "expand",
        "token": "token",
        "interacted_on": date(2026, 8, 20),
    }
    assert result == {"credited": True}


def test_prioritize_tag_suggestions_route_uses_configured_tag_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(notes_route, "MAX_TAG_SUGGESTIONS", 6)
    monkeypatch.setattr(
        notes_route,
        "list_prioritize_tag_suggestions",
        lambda *, search_query, query, limit: captured.update(
            search_query=search_query,
            query=query,
            limit=limit,
        ) or ["foo"],
    )

    result = notes_route.prioritize_tag_suggestions(
        {
            "query": "fo",
            "search_query": "active",
        }
    )

    assert captured == {
        "search_query": "active",
        "query": "fo",
        "limit": 6,
    }
    assert result == {"suggestions": ["foo"]}


def test_note_tag_suggestions_route_uses_configured_tag_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(notes_route, "MAX_TAG_SUGGESTIONS", 5)
    monkeypatch.setattr(notes_route, "_require_note_present", lambda note_id, *, context: None)
    monkeypatch.setattr(notes_route, "_require_bearer_token", lambda request: "session-token")
    # The Tag suggestions setting comes from the session's preferences in memory.
    monkeypatch.setattr(notes_route, "suggests_already_applying_tags", lambda *, token: token == "session-token")
    monkeypatch.setattr(
        notes_route,
        "suggest_tags_for_note",
        lambda *, note_id, anchors, explicit_tags, prefix, content_html, limit, include_already_applying: captured.update(
            note_id=note_id,
            anchors=anchors,
            explicit_tags=explicit_tags,
            prefix=prefix,
            content_html=content_html,
            limit=limit,
            include_already_applying=include_already_applying,
        ) or ["foo"],
    )

    result = notes_route.tag_suggestions(
        object(),
        {
            "note_id": "note-1",
            "anchors": ["alpha"],
            "explicit_tags": ["alpha"],
            "prefix": "f",
            "content_html": "<p>foo</p>",
        }
    )

    assert captured == {
        "note_id": "note-1",
        "anchors": ["alpha"],
        "explicit_tags": ["alpha"],
        "prefix": "f",
        "content_html": "<p>foo</p>",
        "limit": 5,
        "include_already_applying": True,
    }
    assert result == {"suggestions": ["foo"]}
