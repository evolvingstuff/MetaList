"""Undo contexts embed the executed search query and must accept long reference queries."""

from __future__ import annotations

import uuid

import pytest
from pydantic import TypeAdapter
from pydantic import ValidationError

from app.api.note_requests import CreateSiblingRequest
from app.api.note_requests import ViewDiffRequest


def _client_undo_context(search_query: str) -> str:
    # Mirrors captureUndoContext() in api-client.js and tab-state-service.js.
    return f"tab:{uuid.uuid4()}|search:{search_query}|epoch:3"


def _view_request(undo_context: str) -> dict[str, object]:
    return {
        "clientId": "client-1",
        "editingNoteId": None,
        "search": None,
        "tabId": "tab-1",
        "undoContext": undo_context,
        "tabViewEmpty": True,
        "visibleTopRootId": None,
            "visibleBottomRootId": None,
            "startAtListEnd": False,
        "isUntaggedView": False,
    }


def test_view_diff_accepts_open_all_references_query_undo_context() -> None:
    # "Open all references" searches "<id> OR <id> OR ..." for every cited note.
    reference_query = " OR ".join(str(uuid.uuid4()) for _ in range(300))
    undo_context = _client_undo_context(reference_query)
    assert len(undo_context) > 10_000

    validated = TypeAdapter(ViewDiffRequest).validate_python(_view_request(undo_context))

    assert validated["undoContext"] == undo_context


def test_mutations_accept_the_same_long_undo_context() -> None:
    reference_query = " OR ".join(str(uuid.uuid4()) for _ in range(300))
    payload = {
        "search_query": reference_query,
        "clientId": "client-1",
        "undoContext": _client_undo_context(reference_query),
        "viewport": {"scrollY": 0, "scrollAnchor": None},
    }

    TypeAdapter(CreateSiblingRequest).validate_python(payload)


def test_undo_context_still_rejects_empty_and_unbounded_values() -> None:
    adapter = TypeAdapter(ViewDiffRequest)
    with pytest.raises(ValidationError):
        adapter.validate_python(_view_request(""))
    with pytest.raises(ValidationError):
        adapter.validate_python(_view_request("x" * (2 * 1024 * 1024)))
