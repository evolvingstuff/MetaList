from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.services.agent.actions import ReadNotesByIdAction
from app.services.agent.actions import RespondAction
from app.services.agent.actions import SearchNotesAction
from app.services.agent.actions import SearchQueryEnvelope
from app.services.agent.actions import agent_action_adapter
from app.services.agent.actions import agent_route_response_schema
from app.services.agent.actions import parse_agent_route_json
from app.services.agent.actions import parse_search_query_json
from app.services.agent.inference import StructuredInferenceProgress
from app.services.agent.model_policy import InferencePurpose
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.runtime import AgentRuntime
from app.services.agent.runtime import _final_response_max_output_tokens
from app.services.agent.tools import ReadOnlyAgentToolRegistry


TEST_TIMESTAMP = datetime(2026, 8, 29, tzinfo=timezone.utc)


def test_agent_action_schema_has_no_search_page() -> None:
    action = agent_action_adapter.validate_python({
        "kind": "search_notes",
        "query": '"SQLite"',
        "rationale": "Find the relevant decision note.",
    })
    assert isinstance(action, SearchNotesAction)
    assert "page" not in action.model_dump()
    with pytest.raises(ValidationError, match="page"):
        agent_action_adapter.validate_python({
            "kind": "search_notes",
            "query": '"SQLite"',
            "page": 1,
            "rationale": "Legacy paging is forbidden.",
        })


def test_route_schema_remains_flat_and_read_only() -> None:
    schema = agent_route_response_schema()
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == {"kind", "note_ids", "reason"}
    assert set(schema["properties"]["kind"]["enum"]) == {
        "search_notes",
        "read_notes_by_id",
        "respond",
    }
    action = parse_agent_route_json(json.dumps({
        "kind": "respond",
        "note_ids": [],
        "reason": "Reply directly.",
    }))
    assert action == RespondAction(kind="respond", basis="Reply directly.")


@pytest.mark.parametrize(
    "query",
    ['-"Pydantic AI"', "-private", 'Pydantic OR -"Pydantic AI"'],
)
def test_search_query_requires_a_positive_term_per_clause(query: str) -> None:
    with pytest.raises(ValidationError, match="positive term"):
        parse_search_query_json(json.dumps({
            "search_query": query,
            "reason": "Find relevant notes.",
        }))


def test_search_query_schema_and_parser_have_no_page_field() -> None:
    schema = SearchQueryEnvelope.model_json_schema()
    assert set(schema["required"]) == {"search_query", "reason"}
    assert "page" not in schema["properties"]
    action = parse_search_query_json(json.dumps({
        "search_query": '"Pydantic AI" -deprecated',
        "reason": "Find current notes.",
    }))
    assert action == SearchNotesAction(
        kind="search_notes",
        query='"Pydantic AI" -deprecated',
        rationale="Find current notes.",
    )


class _FakeNotes:
    def __init__(self, records: dict[str, object], children: dict[object, list[str]]):
        self.records = records
        self.children = children

    def list_note_ids(self) -> list[str]:
        return list(self.records)

    def get_children(self, parent_id: str | None) -> list[str]:
        return list(self.children[parent_id])

    def get_note(self, note_id: str):
        return self.records[note_id]

    def has_note(self, note_id: str) -> bool:
        return note_id in self.records


class _FakeSearches:
    def __init__(self, matches: set[str]) -> None:
        self.matches = matches

    def query_note_ids(self, query: str) -> set[str]:
        assert query == "foo"
        return set(self.matches)


def _record(
    note_id: str,
    *,
    parent_id: str | None,
    content: str,
    tags: str,
    proposed_tags: str,
) -> object:
    return SimpleNamespace(
        id=note_id,
        parent_id=parent_id,
        content=f"<p>{content}</p>",
        tags=tags,
        proposed_tags=proposed_tags,
        created_at=TEST_TIMESTAMP,
        updated_at=TEST_TIMESTAMP,
    )


def test_search_returns_one_ordered_full_content_payload_grouped_by_root() -> None:
    records = {
        "root-a": _record(
            "root-a",
            parent_id=None,
            content="root",
            tags="foo",
            proposed_tags="machine-learning",
        ),
        "child-a": _record(
            "child-a", parent_id="root-a", content="child", tags="foo", proposed_tags=""
        ),
        "root-b": _record(
            "root-b", parent_id=None, content="second", tags="foo", proposed_tags=""
        ),
    }
    registry = ReadOnlyAgentToolRegistry(
        notes=_FakeNotes(
            records,
            {
                None: ["root-a", "root-b"],
                "root-a": ["child-a"],
                "child-a": [],
                "root-b": [],
            },
        ),
        searches=_FakeSearches({"root-a", "child-a", "root-b"}),
    )
    result = registry.execute(
        SearchNotesAction(kind="search_notes", query="foo", rationale="Search."),
        settings=AgentRetrievalSettings(max_page_approximate_tokens=24_000),
    )

    assert result.payload["matched_count"] == 2
    assert result.payload["returned_count"] == 2
    assert result.payload["omitted_count"] == 0
    assert "total_pages" not in result.payload
    notes = result.payload["notes"]
    assert isinstance(notes, list)
    assert [note["note_id"] for note in notes] == [
        "root-a",
        "child-a",
        "root-b",
    ]
    assert [note["content_text"] for note in notes] == ["root", "child", "second"]
    assert notes[0]["proposed_tags"] == "machine-learning"
    assert "proposed_tags" not in notes[1]
    assert all("content_is_truncated" not in note for note in notes)


def test_search_token_limit_omits_trailing_roots_without_splitting() -> None:
    records = {
        "root-a": _record(
            "root-a", parent_id=None, content="small", tags="foo", proposed_tags=""
        ),
        "root-b": _record(
            "root-b",
            parent_id=None,
            content="large " * 10_000,
            tags="foo",
            proposed_tags="",
        ),
    }
    registry = ReadOnlyAgentToolRegistry(
        notes=_FakeNotes(
            records,
            {None: ["root-a", "root-b"], "root-a": [], "root-b": []},
        ),
        searches=_FakeSearches({"root-a", "root-b"}),
    )
    result = registry.execute(
        SearchNotesAction(kind="search_notes", query="foo", rationale="Search."),
        settings=AgentRetrievalSettings(max_page_approximate_tokens=500),
    )

    assert result.payload["returned_count"] == 1
    assert result.payload["omitted_count"] == 1
    assert [note["note_id"] for note in result.payload["notes"]] == ["root-a"]


def test_read_by_id_returns_full_content_or_fails_the_total_token_limit() -> None:
    records = {
        "note-a": _record(
            "note-a",
            parent_id=None,
            content="x" * 20_000,
            tags="foo",
            proposed_tags="",
        ),
    }
    registry = ReadOnlyAgentToolRegistry(
        notes=_FakeNotes(records, {None: ["note-a"], "note-a": []}),
        searches=_FakeSearches(set()),
    )
    action = ReadNotesByIdAction(
        kind="read_notes_by_id",
        note_ids=["note-a"],
        rationale="Read it.",
    )
    with pytest.raises(ValueError, match="configured evidence limit"):
        registry.execute(
            action,
            settings=AgentRetrievalSettings(max_page_approximate_tokens=500),
        )
    result = registry.execute(
        action,
        settings=AgentRetrievalSettings(max_page_approximate_tokens=24_000),
    )
    assert result.payload["notes"][0]["content_text"] == "x" * 20_000


def test_structured_progress_uses_only_current_action_purposes() -> None:
    progress = StructuredInferenceProgress(
        phase="output_progress",
        attempt=1,
        max_attempts=2,
        failure_kind="",
        error_type="",
        error_message="",
        duration_ms=50.0,
        wire_request={
            "method": "POST",
            "url": "http://127.0.0.1/v1/chat/completions",
            "body": {"messages": [{"role": "user", "content": "Route"}]},
        },
        output_tokens_received=24,
    )
    event = AgentRuntime._progress_status_event(
        progress,
        purpose=InferencePurpose.ACTION_SELECTION,
        provider_label="Ollama",
    )
    assert event["output_tokens_received"] == 24
    assert "choosing next action" in event["label"]


def test_final_response_output_limit_is_provider_specific() -> None:
    assert _final_response_max_output_tokens(provider_label="Ollama") == 1_024
    assert _final_response_max_output_tokens(provider_label="OpenAI") == 8_192
