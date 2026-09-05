from __future__ import annotations

import asyncio
import json
from types import MappingProxyType

from app.services.agent.context import AgentContextBuilder
from app.services.agent.inference import InferenceAttempt
from app.services.agent.inference import InferenceContextWindow
from app.services.agent.inference import InferenceResponse
from app.services.agent.inference import StructuredInferenceProgress
from app.services.agent.model_policy import SingleModelPolicy
from app.services.agent.permissions import AgentPermissionPolicy
from app.services.agent.prompt_settings import DEFAULT_AGENT_PROMPTS
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.runtime import AgentRuntime
from app.services.agent.scope import AgentScopeDescriptor
from app.services.agent.scope import FrozenScopedNote
from app.services.agent.scope import FrozenScopedTreeNode
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.agent.trace import AgentTraceStore


def _descriptor() -> AgentScopeDescriptor:
    return AgentScopeDescriptor(
        scope_kind="search",
        active_tab_id="tab-1",
        scope_tab_id="tab-1",
        search_query="testosterone",
        sort_mode="normal",
        reference_root_ids=[],
        label="testosterone",
    )


def _note(
    note_id: str,
    root_note_id: str,
    parent_id: str,
    content: str,
    index: int,
) -> FrozenScopedNote:
    return FrozenScopedNote(
        note_id=note_id,
        parent_id=parent_id,
        root_note_id=root_note_id,
        content_text=content,
        explicit_tags_text="testosterone",
        explicit_tag_terms=("testosterone",),
        proposed_tags_text="",
        proposed_tag_terms=(),
        created_at="2026-08-29T00:00:00+00:00",
        updated_at="2026-08-29T00:00:00+00:00",
        order_index=index,
    )


def _snapshot(*, large_tail: bool) -> ScopedSearchSnapshot:
    tail = "TAIL"
    if large_tail:
        tail = "TAIL " * 10_000
    notes = {
        "root-a": _note("root-a", "root-a", "", "ROOT_ALPHA", 0),
        "child-a": _note("child-a", "root-a", "root-a", "CHILD_ALPHA", 1),
        "root-b": _note("root-b", "root-b", "", tail, 2),
    }
    nodes = {
        "root-a": FrozenScopedTreeNode(
            note_id="root-a",
            parent_id="",
            root_note_id="root-a",
            child_ids=("child-a",),
        ),
        "child-a": FrozenScopedTreeNode(
            note_id="child-a",
            parent_id="root-a",
            root_note_id="root-a",
            child_ids=(),
        ),
        "root-b": FrozenScopedTreeNode(
            note_id="root-b",
            parent_id="",
            root_note_id="root-b",
            child_ids=(),
        ),
    }
    return ScopedSearchSnapshot(
        run_id="scope-run",
        session_key="session-1",
        descriptor=_descriptor(),
        created_at="2026-08-29T00:00:00+00:00",
        ordered_root_ids=("root-a", "root-b"),
        ordered_note_ids=("root-a", "child-a", "root-b"),
        notes_by_id=MappingProxyType(notes),
        tree_nodes_by_id=MappingProxyType(nodes),
    )


class _FakeInference:
    provider_label = "Ollama"

    def __init__(self, *, route_kind: str) -> None:
        self.route_kind = route_kind
        self.final_messages: list[dict[str, str]] = []

    async def inspect_context_window(
        self,
        *,
        base_url: str,
        model: str,
    ) -> InferenceContextWindow:
        del base_url
        return InferenceContextWindow(
            model=model,
            maximum_tokens=32_768,
            loaded_tokens=32_768,
            required_tokens=32_768,
        )

    async def infer_structured(
        self,
        *,
        base_url,
        model,
        thinking_level,
        messages,
        response_model,
        on_progress,
    ) -> InferenceResponse:
        del thinking_level
        payload = {
            "kind": self.route_kind,
            "reason": "Saved-note evidence is required."
            if self.route_kind == "investigate_current_scope"
            else "No saved-note evidence is required.",
        }
        content = json.dumps(payload)
        response_model.model_validate_json(content)
        wire_request = {
            "method": "POST",
            "url": f"{base_url}/v1/chat/completions",
            "body": {"model": model, "messages": messages},
        }
        for phase in ("attempt_started", "response_received", "attempt_succeeded"):
            on_progress(
                StructuredInferenceProgress(
                    phase=phase,
                    attempt=1,
                    max_attempts=2,
                    failure_kind="",
                    error_type="",
                    error_message="",
                    duration_ms=1.0,
                    wire_request=wire_request,
                    output_tokens_received=10,
                )
            )
        return InferenceResponse(
            content=content,
            thinking="",
            usage={},
            attempts=[
                InferenceAttempt(
                    request=wire_request,
                    response={"content": content},
                    error="",
                    duration_ms=1.0,
                )
            ],
        )

    async def stream_text(self, **arguments):
        self.final_messages = arguments["messages"]
        arguments["on_request"]({
            "method": "POST",
            "url": f'{arguments["base_url"]}/api/chat',
            "body": {
                "model": arguments["model"],
                "messages": arguments["messages"],
            },
        })
        yield {"type": "content_delta", "text": "Answer [[child-a]]"}
        yield {"type": "done"}


class _UnusedTools:
    pass


def _runtime(inference: _FakeInference) -> AgentRuntime:
    return AgentRuntime(
        context_builder=AgentContextBuilder(),
        inference=inference,
        model_policy=SingleModelPolicy(),
        permission_policy=AgentPermissionPolicy(),
        tool_registry=_UnusedTools(),
        trace_store=AgentTraceStore(),
        provider_label="Ollama",
    )


def _events(
    *,
    inference: _FakeInference,
    snapshot: ScopedSearchSnapshot,
    message: str,
    token_limit: int,
) -> list[dict[str, object]]:
    async def collect() -> list[dict[str, object]]:
        return [
            event
            async for event in _runtime(inference).stream_scoped(
                tag_handler=None,
                session_key="session-1",
                base_url="http://127.0.0.1:11434",
                selected_model="qwen2.5:7b-instruct",
                thinking_level="off",
                canonical_messages=[{"role": "user", "content": message}],
                prompts=DEFAULT_AGENT_PROMPTS,
                skills=DEFAULT_AGENT_SKILLS,
                retrieval_settings=AgentRetrievalSettings(
                    max_page_approximate_tokens=token_limit,
                ),
                frozen_scope=snapshot,
            )
        ]

    return asyncio.run(collect())


def test_scoped_request_sends_one_full_nested_evidence_payload_directly() -> None:
    inference = _FakeInference(route_kind="investigate_current_scope")
    events = _events(
        inference=inference,
        snapshot=_snapshot(large_tail=False),
        message="please summarize my notes about testosterone",
        token_limit=24_000,
    )

    final_requests = [
        message
        for message in inference.final_messages
        if message["content"].startswith("FINAL_RESPONSE_REQUEST\n")
    ]
    assert len(final_requests) == 1
    final_payload = json.loads(inference.final_messages[-1]["content"].split("\n", 1)[1])
    assert len(final_payload["authoritative_result_trees"]) == 2
    assert final_payload["authoritative_result_trees"][0]["content_text"] == "ROOT_ALPHA"
    assert final_payload["authoritative_result_trees"][0]["children"][0][
        "content_text"
    ] == "CHILD_ALPHA"
    assert all("working_summary" not in message["content"] for message in inference.final_messages)
    assert any(event.get("type") == "done" for event in events)


def test_oversized_scope_omits_only_trailing_complete_roots() -> None:
    inference = _FakeInference(route_kind="investigate_current_scope")
    events = _events(
        inference=inference,
        snapshot=_snapshot(large_tail=True),
        message="please summarize my notes about testosterone",
        token_limit=500,
    )

    final_payload = json.loads(inference.final_messages[-1]["content"].split("\n", 1)[1])
    assert len(final_payload["authoritative_result_trees"]) == 1
    assert final_payload["authoritative_result_trees"][0]["note_id"] == "root-a"
    assert final_payload["evidence_coverage"]["omitted_result_tree_count"] == 1
    labels = [event.get("label", "") for event in events]
    assert "Only using 1 of 2 root notes for answer" in labels


def test_direct_response_does_not_send_note_content() -> None:
    inference = _FakeInference(route_kind="respond")
    _events(
        inference=inference,
        snapshot=_snapshot(large_tail=False),
        message="please explain Bayes theorem",
        token_limit=24_000,
    )

    serialized_messages = json.dumps(inference.final_messages)
    assert "ROOT_ALPHA" not in serialized_messages
    assert "CHILD_ALPHA" not in serialized_messages
