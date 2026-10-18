from __future__ import annotations

import asyncio
import json
import re
from dataclasses import replace
from types import MappingProxyType

import pytest

from app.services.agent.context import AgentContextBuilder
from app.services.agent.inference import InferenceAttempt
from app.services.agent.inference import InferenceContextWindow
from app.services.agent.inference import InferenceResponse
from app.services.agent.inference import StructuredInferenceError
from app.services.agent.inference import StructuredInferenceProgress
from app.services.agent.model_policy import SingleModelPolicy
from app.services.agent.prompt_settings import DEFAULT_AGENT_PROMPTS
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent import runtime as runtime_module
from app.services.agent.runtime import AgentExecutionError
from app.services.agent.runtime import AgentRuntime
from app.services.agent.scope import AgentScopeDescriptor, NO_SELECTED_NOTE
from app.services.agent.scope import FrozenScopedNote
from app.services.agent.scope import NoteText
from app.services.agent.scope import FrozenScopedTreeNode
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.scope import TextExtractionMeter
from app.services.agent.scope import SelectedNoteContext, SelectedTreeNote
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.agent.web_settings import DEFAULT_AGENT_WEB_SETTINGS
from app.services.agent.web_settings import AgentWebSettings
from app.services.agent.web_evidence import web_evidence_store
from app.services.agent.summary_batch_store import summary_batch_store
from app.services.agent.web_fetch import WebPageFetchResult
from app.services.agent.trace import AgentTraceStore
from app.services.bulk_operation import bulk_operation_guard

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
        note_text=NoteText.from_text(content),
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
        note_records_at_send=MappingProxyType({}),
        disclosable_search_query=_descriptor().search_query,
        preparation_ms=0.0, text_extraction=TextExtractionMeter.start(),
        selected_note=NO_SELECTED_NOTE,
    )


class _FakeInference:
    """Plays an agent that asks to summarize the view, then the summary model calls."""

    provider_label = "OpenAI"

    def __init__(self) -> None:
        self.large_summary_results = False
        self.failed_summary_root_id = ""
        self.omit_summary_coverage = False
        self.summary_batch_citation_note_id = ""
        self.summary_delay_seconds_by_root_id: dict[str, float] = {}
        self.summary_citation_corrections = 0
        self.summary_instructions: list[str] = []
        self.summary_requests: list[str] = []
        self.summary_tool_arguments = '{"continues_failed_summary":false}'
        self.failed_summary_as_agent_error = False
        self.ignore_summary_citation_corrections = False
        self.final_messages: list[dict[str, str]] = []
        self.agent_messages: list[dict[str, object]] = []
        self.summary_batch_calls: list[tuple[str, ...]] = []
        self.active_summary_calls = 0
        self.maximum_parallel_summary_calls = 0
        self.summary_reduction_calls = 0

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
        if response_model.__name__ in {"SummaryBatchResult", "SummaryFindingsResult"}:
            request_message = next(
                message["content"] for message in reversed(messages)
                if message["content"].startswith((
                    "STAGED_SUMMARY_BATCH_REQUEST\n",
                    "STAGED_SUMMARY_REDUCTION_REQUEST\n",
                ))
            )
            request = json.loads(request_message.split("\n", 1)[1])
            self.summary_instructions.append(request["instruction"])
            self.summary_requests.append(request["current_user_request"])
            is_correction = messages[-1]["content"].startswith(
                "STAGED_SUMMARY_CITATION_CORRECTION\n"
            )
            if is_correction:
                self.summary_citation_corrections += 1
            is_reduction = "reduction" in request
            if is_reduction:
                expected_root_ids = tuple(
                    request["reduction"]["expected_root_ids"]
                )
                supporting_note_id = request["reduction"][
                    "verified_findings"
                ][0]["findings"][0]["supporting_note_ids"][0]
                self.summary_reduction_calls += 1
            else:
                expected_root_ids = tuple(request["batch"]["expected_root_ids"])
                first_tree = request["batch"]["result_trees"][0]
                # Deliberately naive: cite the first tree node, which may be a
                # structural placeholder, until asked to correct the citation.
                supporting_note_id = first_tree["note_id"]
                if is_correction and not self.ignore_summary_citation_corrections:
                    supporting_note_id = _first_evidence_note_id(first_tree)
                if self.summary_batch_citation_note_id != "":
                    supporting_note_id = self.summary_batch_citation_note_id
            self.summary_batch_calls.append(expected_root_ids)
            self.active_summary_calls += 1
            self.maximum_parallel_summary_calls = max(
                self.maximum_parallel_summary_calls,
                self.active_summary_calls,
            )
            try:
                await asyncio.sleep(
                    self.summary_delay_seconds_by_root_id.get(
                        expected_root_ids[0],
                        0.01,
                    )
                )
            finally:
                self.active_summary_calls -= 1
            if self.failed_summary_root_id in expected_root_ids and self.failed_summary_as_agent_error:
                raise AgentExecutionError(f"Fixture summary failure for {self.failed_summary_root_id}")
            if self.failed_summary_root_id in expected_root_ids:
                raise RuntimeError(
                    f"Fixture summary failure for {self.failed_summary_root_id}"
                )
            finding_text = f"Finding for {expected_root_ids[0]}"
            if self.large_summary_results and not is_reduction:
                finding_text = (finding_text + " detail") * 60
            payload = {
                "findings": [{
                    "text": finding_text,
                    "supporting_note_ids": [supporting_note_id],
                }],
            }
            if response_model.__name__ == "SummaryBatchResult" and not self.omit_summary_coverage:
                payload["covered_root_ids"] = list(expected_root_ids)
            content = json.dumps(payload)
            response_model.model_validate_json(content)
            for streamed_text in (finding_text[: len(finding_text) // 2], finding_text):
                on_progress(
                    StructuredInferenceProgress(
                        phase="output_progress",
                        attempt=1,
                        max_attempts=2,
                        failure_kind="",
                        error_type="",
                        error_message="",
                        duration_ms=1.0,
                        wire_request={
                            "method": "POST",
                            "url": f"{base_url}/v1/chat/completions",
                            "body": {"model": model, "messages": messages},
                        },
                        output_tokens_received=len(streamed_text),
                        partial_output={"findings": [{"text": streamed_text}]},
                    )
                )
            return InferenceResponse(content=content, thinking="", usage={}, attempts=[])
        raise AssertionError(f"Unexpected structured request: {response_model.__name__}")

    async def stream_tool_turn(self, *, base_url, model, thinking_level, messages, tools,
                               max_output_tokens, on_request):
        del base_url, model, thinking_level, max_output_tokens
        assert self.agent_messages == [], "The summary operation ends the agent's turn"
        assert "summarize_view" in {tool.name for tool in tools}
        self.agent_messages = [dict(message) for message in messages]
        on_request({"messages": len(messages)})
        yield {"type": "tool_call", "id": "call-summary", "name": "summarize_view",
               "arguments": self.summary_tool_arguments}
        yield {"type": "done", "finish_reason": "tool_calls", "usage": {}}

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


def _runtime(inference: _FakeInference) -> AgentRuntime:
    return AgentRuntime(
        context_builder=AgentContextBuilder(),
        inference=inference,
        model_policy=SingleModelPolicy(),
        trace_store=AgentTraceStore(),
        provider_label="OpenAI",
    )


def _first_evidence_note_id(tree: dict[str, object]) -> str:
    pending = [tree]
    while pending:
        node = pending.pop(0)
        if "content_text" in node:
            return node["note_id"]
        pending.extend(node["children"])
    raise AssertionError("Fixture tree has no evidence note")


def _events_with_summary_answer(
    *,
    inference: _FakeInference,
    snapshot: ScopedSearchSnapshot,
    message: str,
    token_limit: int,
    answer: str,
) -> tuple[list[dict[str, object]], int]:
    events: list[dict[str, object]] = []
    calls_at_question = _collect_summary_events(
        inference=inference,
        snapshot=snapshot,
        message=message,
        token_limit=token_limit,
        answer=answer,
        events=events,
    )
    return events, calls_at_question


def _collect_summary_events(
    *,
    inference: _FakeInference,
    snapshot: ScopedSearchSnapshot,
    message: str,
    token_limit: int,
    answer: str,
    events: list[dict[str, object]],
) -> int:
    """Append streamed events to ``events`` so callers can inspect them after a failure."""

    async def collect() -> int:
        calls_at_question = -1
        async for event in _runtime(inference).stream_agent(earlier_actions=[], 
            tagging_run=None,
            session_key="session-1",
            base_url="https://api.openai.com/v1",
            selected_model="gpt-5.6-sol",
            thinking_level="off",
            canonical_messages=[{"role": "user", "content": message}],
            prompts=DEFAULT_AGENT_PROMPTS,
            skills=DEFAULT_AGENT_SKILLS,
            retrieval_settings=AgentRetrievalSettings(
                max_page_approximate_tokens=token_limit,
            ),
            web_settings=DEFAULT_AGENT_WEB_SETTINGS,
            frozen_scope=snapshot,
        ):
            events.append(event)
            if event["type"] == "bulk_question":
                calls_at_question = len(inference.summary_batch_calls)
                bulk_operation_guard.answer(
                    "session-1",
                    event["question_id"],
                    answer,
                )
        return calls_at_question

    return asyncio.run(collect())


def _summary_previews(events: list[dict[str, object]]) -> list[dict[str, object]]:
    return [
        event["summary_batch_preview"]
        for event in events if "summary_batch_preview" in event
    ]


def _summary_snapshot(root_count: int) -> ScopedSearchSnapshot:
    roots = tuple(f"root-{index}" for index in range(root_count))
    notes = {
        root_id: _note(
            root_id,
            root_id,
            "",
            f"EVIDENCE_{index} " * 150,
            index,
        )
        for index, root_id in enumerate(roots)
    }
    nodes = {
        root_id: FrozenScopedTreeNode(
            note_id=root_id,
            parent_id="",
            root_note_id=root_id,
            child_ids=(),
        )
        for root_id in roots
    }
    return ScopedSearchSnapshot(
        run_id="summary-scope",
        session_key="session-1",
        descriptor=_descriptor(),
        created_at="2026-08-29T00:00:00+00:00",
        ordered_root_ids=roots,
        ordered_note_ids=roots,
        notes_by_id=MappingProxyType(notes),
        tree_nodes_by_id=MappingProxyType(nodes),
        note_records_at_send=MappingProxyType({}),
        disclosable_search_query=_descriptor().search_query,
        preparation_ms=0.0, text_extraction=TextExtractionMeter.start(),
        selected_note=NO_SELECTED_NOTE,
    )


def _multi_batch_summary_snapshot() -> ScopedSearchSnapshot:
    return _summary_snapshot(5)


def test_complete_scope_summary_asks_before_any_batch_and_then_runs_in_parallel() -> None:
    inference = _FakeInference()

    events, calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=_multi_batch_summary_snapshot(),
        message="Summarize all of these notes.",
        token_limit=900,
        answer="summarize_all",
    )

    question = next(event for event in events if event["type"] == "bulk_question")
    assert question["kind"] == "summary_confirmation"
    assert calls_at_question == 0
    assert re.match(
        r"This scope uses approximately \d+\.\d\d× the evidence budget: its 5 root "
        r"notes need 5 evidence batches plus a final synthesis",
        question["label"],
    )
    assert question["batch_count"] == len(inference.summary_batch_calls)
    assert inference.summary_batch_calls[0] == ("root-0",)
    assert inference.maximum_parallel_summary_calls >= 2
    previews = _summary_previews(events)
    assert {preview["batch_number"] for preview in previews} == set(range(1, 6))
    assert all(preview["batch_count"] == 5 for preview in previews)
    assert all(
        preview["finding_count"] == 1
        for preview in previews if preview["status"] == "complete"
    )
    final_payload = json.loads(
        inference.final_messages[-1]["content"].split("\n", 1)[1]
    )
    assert final_payload["evidence_coverage"]["omitted_result_tree_count"] == 0
    assert tuple(
        root_id
        for summary in final_payload["authoritative_batch_findings"]
        for root_id in summary["covered_root_ids"]
    ) == _multi_batch_summary_snapshot().ordered_root_ids


def test_staged_summary_previews_show_writing_before_each_completion() -> None:
    inference = _FakeInference()
    snapshot = _summary_snapshot(11)

    events, _calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=snapshot,
        message="Summarize every note in this scope.",
        token_limit=900,
        answer="summarize_all",
    )

    previews = [
        preview for preview in _summary_previews(events)
        if preview["status"] != "streaming"
    ]
    transitions = [
        (preview["batch_number"], preview["status"]) for preview in previews
    ]
    assert transitions[:2] == [(1, "writing"), (1, "complete")]
    assert sorted(transitions) == sorted(
        [(number, "writing") for number in range(1, 12)]
        + [(number, "complete") for number in range(1, 12)]
    )
    writing_batches: set[int] = set()
    maximum_visible_writing = 0
    for preview in previews:
        assert preview["batch_count"] == 11
        if preview["status"] == "writing":
            assert preview["finding_count"] == 0
            assert preview["latest_text"] == ""
            assert preview["batch_number"] not in writing_batches
            writing_batches.add(preview["batch_number"])
        else:
            assert preview["status"] == "complete"
            assert preview["finding_count"] == 1
            writing_batches.remove(preview["batch_number"])
        maximum_visible_writing = max(maximum_visible_writing, len(writing_batches))
    assert writing_batches == set()
    assert maximum_visible_writing == 4
    labels = [
        event["label"]
        for event in events
        if event["type"] == "bulk_progress" and "summary_batch_preview" in event
    ]
    assert all("11 batches" in label for label in labels)
    assert any("queued" in label for label in labels)


def test_staged_summary_streams_compact_previews_between_start_and_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime_module, "_SUMMARY_STREAM_INTERVAL_SECONDS", 0.0)
    inference = _FakeInference()
    inference.large_summary_results = True

    events, _calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=_multi_batch_summary_snapshot(),
        message="Summarize all of these notes.",
        token_limit=900,
        answer="summarize_all",
    )

    batch_one = [
        preview for preview in _summary_previews(events)
        if preview["batch_number"] == 1
    ]
    assert [preview["status"] for preview in batch_one] == [
        "writing", "streaming", "streaming", "complete",
    ]
    first_stream, second_stream = batch_one[1], batch_one[2]
    assert first_stream["finding_count"] == 1
    assert 0 < first_stream["output_tokens"] < second_stream["output_tokens"]
    # Only the newest tail is sent so the card stays compact.
    full_text = ("Finding for root-0 detail") * 60
    assert len(full_text) > 240
    assert first_stream["latest_text"] == full_text[: len(full_text) // 2][-240:]
    assert second_stream["latest_text"] == full_text[-240:]
    completed = batch_one[3]
    assert completed["finding_count"] == 1
    assert completed["latest_text"] == full_text[:240]
    assert completed["output_tokens"] == second_stream["output_tokens"]


def test_staged_summary_stream_previews_are_throttled_per_batch() -> None:
    inference = _FakeInference()

    events, _calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=_multi_batch_summary_snapshot(),
        message="Summarize all of these notes.",
        token_limit=900,
        answer="summarize_all",
    )

    for batch_number in range(1, 6):
        streaming = [
            preview for preview in _summary_previews(events)
            if preview["batch_number"] == batch_number
            and preview["status"] == "streaming"
        ]
        # The fixture streams twice within far less than the throttle interval.
        assert len(streaming) == 1


def test_staged_summary_previews_arrive_out_of_order_but_synthesis_is_canonical() -> None:
    inference = _FakeInference()
    snapshot = _multi_batch_summary_snapshot()
    inference.summary_delay_seconds_by_root_id = {
        "root-1": 0.08,
        "root-2": 0.06,
        "root-3": 0.04,
        "root-4": 0.01,
    }

    events, _calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=snapshot,
        message="Summarize every note in this scope.",
        token_limit=900,
        answer="summarize_all",
    )

    completion_order = [
        preview["batch_number"]
        for preview in _summary_previews(events)
        if preview["status"] == "complete"
    ]
    assert completion_order == [1, 5, 4, 3, 2]
    final_payload = json.loads(
        inference.final_messages[-1]["content"].split("\n", 1)[1]
    )
    assert tuple(
        root_id
        for summary in final_payload["authoritative_batch_findings"]
        for root_id in summary["covered_root_ids"]
    ) == snapshot.ordered_root_ids


def test_closing_staged_summary_stream_cancels_running_batch_workers() -> None:
    inference = _FakeInference()
    inference.summary_delay_seconds_by_root_id = {
        root_id: 5.0 for root_id in ("root-1", "root-2", "root-3", "root-4")
    }

    async def run() -> None:
        stream = _runtime(inference).stream_agent(earlier_actions=[], 
            tagging_run=None,
            session_key="session-1",
            base_url="https://api.openai.com/v1",
            selected_model="gpt-5.6-sol",
            thinking_level="off",
            canonical_messages=[{"role": "user", "content": "Summarize all notes."}],
            prompts=DEFAULT_AGENT_PROMPTS,
            skills=DEFAULT_AGENT_SKILLS,
            retrieval_settings=AgentRetrievalSettings(max_page_approximate_tokens=900),
            web_settings=DEFAULT_AGENT_WEB_SETTINGS,
            frozen_scope=_multi_batch_summary_snapshot(),
        )
        async for event in stream:
            if event["type"] == "bulk_question":
                bulk_operation_guard.answer(
                    "session-1", event["question_id"], "summarize_all"
                )
            if (
                "summary_batch_preview" in event
                and event["summary_batch_preview"]["batch_number"] > 1
            ):
                break
        await stream.aclose()
        await asyncio.sleep(0)
        assert inference.active_summary_calls == 0

    asyncio.run(asyncio.wait_for(run(), timeout=2.0))
    assert inference.final_messages == []


def test_staged_summary_shows_first_batch_writing_before_it_fails() -> None:
    inference = _FakeInference()
    inference.failed_summary_root_id = "root-0"
    events: list[dict[str, object]] = []

    with pytest.raises(RuntimeError, match="Fixture summary failure for root-0"):
        _collect_summary_events(
            inference=inference,
            snapshot=_multi_batch_summary_snapshot(),
            message="Summarize all of these notes.",
            token_limit=900,
            answer="summarize_all",
            events=events,
        )

    assert [
        (preview["batch_number"], preview["status"])
        for preview in _summary_previews(events)
    ] == [(1, "writing")]
    assert inference.summary_batch_calls == [("root-0",)]
    assert inference.final_messages == []


def test_complete_scope_summary_has_no_total_batch_cap_but_runs_only_four_at_once() -> None:
    inference = _FakeInference()
    snapshot = _summary_snapshot(11)

    events, _calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=snapshot,
        message="Summarize every note in this scope.",
        token_limit=900,
        answer="summarize_all",
    )

    question = next(event for event in events if event["type"] == "bulk_question")
    assert question["batch_count"] == 11
    assert len(inference.summary_batch_calls) == 11
    assert inference.maximum_parallel_summary_calls == 4
    final_payload = json.loads(
        inference.final_messages[-1]["content"].split("\n", 1)[1]
    )
    assert tuple(
        root_id
        for summary in final_payload["authoritative_batch_findings"]
        for root_id in summary["covered_root_ids"]
    ) == snapshot.ordered_root_ids


def test_summary_coverage_is_attached_by_application_instead_of_echoed_by_model() -> None:
    inference = _FakeInference()
    inference.omit_summary_coverage = True
    snapshot = _multi_batch_summary_snapshot()

    _events_with_summary_answer(
        inference=inference,
        snapshot=snapshot,
        message="Summarize every note in this scope.",
        token_limit=900,
        answer="summarize_all",
    )

    final_payload = json.loads(
        inference.final_messages[-1]["content"].split("\n", 1)[1]
    )
    assert tuple(
        root_id
        for summary in final_payload["authoritative_batch_findings"]
        for root_id in summary["covered_root_ids"]
    ) == snapshot.ordered_root_ids


def test_summary_batches_and_consolidation_keep_note_ids_out_of_the_finding_text() -> None:
    # The system prompt asks for [[note_id]] citations in answers; a batch
    # finding once followed that and left out its required supporting_note_ids.
    inference = _FakeInference()
    _events_with_summary_answer(
        inference=inference,
        snapshot=_multi_batch_summary_snapshot(),
        message="Summarize every note in this scope.",
        token_limit=900,
        answer="summarize_all",
    )
    assert inference.summary_instructions != []
    for instruction in inference.summary_instructions:
        assert "Put note IDs only in supporting_note_ids" in instruction
        assert "must not contain [[note_id]] citations" in instruction


def test_complete_scope_summary_can_keep_the_single_payload_prefix() -> None:
    inference = _FakeInference()

    events, calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=_multi_batch_summary_snapshot(),
        message="Summarize all of these notes.",
        token_limit=900,
        answer="use_prefix",
    )

    assert calls_at_question == 0
    assert inference.summary_batch_calls == []
    final_payload = json.loads(
        inference.final_messages[-1]["content"].split("\n", 1)[1]
    )
    assert final_payload["evidence_coverage"]["omitted_result_tree_count"] > 0
    assert any(
        event["label"].startswith("Only using ")
        for event in events if "label" in event
    )


def test_complete_scope_summary_cancel_starts_no_batch_calls() -> None:
    inference = _FakeInference()

    events, calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=_multi_batch_summary_snapshot(),
        message="Summarize all of these notes.",
        token_limit=900,
        answer="cancel",
    )

    assert calls_at_question == 0
    assert inference.summary_batch_calls == []
    assert any(
        event["text"] == "Summary cancelled."
        for event in events if "text" in event
    )


def test_single_payload_scope_summary_starts_without_a_question() -> None:
    # One payload is one ordinary model call: nothing to choose, so no dialog.
    inference = _FakeInference()

    events, calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=_snapshot(large_tail=False),
        message="Summarize all of these notes.",
        token_limit=24_000,
        answer="summarize_all",
    )

    assert not any(event["type"] in {"bulk_question", "bulk_complete"} for event in events)
    assert calls_at_question == -1
    assert inference.summary_batch_calls == []
    assert inference.final_messages
    assert any(event["type"] == "done" for event in events)


def test_staged_summary_recursively_reduces_large_intermediate_findings() -> None:
    inference = _FakeInference()
    inference.large_summary_results = True

    events, _calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=_multi_batch_summary_snapshot(),
        message="Summarize all of these notes.",
        token_limit=900,
        answer="summarize_all",
    )

    assert inference.summary_reduction_calls > 0
    assert any(
        event["label"] == "Condensing batch summaries for final synthesis"
        for event in events if "label" in event
    )
    final_payload = json.loads(
        inference.final_messages[-1]["content"].split("\n", 1)[1]
    )
    assert final_payload["evidence_coverage"]["omitted_result_tree_count"] == 0


def test_staged_summary_failure_cancels_remaining_work_and_never_synthesizes() -> None:
    inference = _FakeInference()
    inference.failed_summary_root_id = "root-1"

    with pytest.raises(RuntimeError, match="Fixture summary failure for root-1"):
        _events_with_summary_answer(
            inference=inference,
            snapshot=_multi_batch_summary_snapshot(),
            message="Summarize all of these notes.",
            token_limit=900,
            answer="summarize_all",
        )

    assert inference.active_summary_calls == 0
    assert inference.final_messages == []


def _selected_note_outside_summary_scope() -> SelectedNoteContext:
    return SelectedNoteContext(
        "available",
        "selected-child",
        (
            SelectedTreeNote("selected-root", "", "SELECTED_ROOT_CONTEXT", ""),
            SelectedTreeNote(
                "selected-child",
                "selected-root",
                "SELECTED_CHILD_CONTEXT",
                "",
            ),
        ),
        unavailable_reason="",
    )


def test_staged_summary_batch_may_cite_permitted_selected_note_context() -> None:
    inference = _FakeInference()
    inference.summary_batch_citation_note_id = "selected-child"
    snapshot = replace(
        _multi_batch_summary_snapshot(),
        selected_note=_selected_note_outside_summary_scope(),
    )
    assert "selected-child" not in snapshot.ordered_note_ids

    events, _calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=snapshot,
        message="Summarize all of these notes.",
        token_limit=900,
        answer="summarize_all",
    )

    question = next(event for event in events if event["type"] == "bulk_question")
    assert question["batch_count"] > 1
    assert len(inference.summary_batch_calls) == question["batch_count"]
    final_payload = json.loads(
        inference.final_messages[-1]["content"].split("\n", 1)[1]
    )
    assert "selected-child" in [
        entry["note_id"] for entry in final_payload["reference_catalog"]
    ]
    assert any(event["type"] == "done" for event in events)


def test_staged_summary_final_catalog_includes_permitted_selected_note_tree() -> None:
    inference = _FakeInference()
    snapshot = replace(
        _multi_batch_summary_snapshot(),
        selected_note=_selected_note_outside_summary_scope(),
    )

    _events_with_summary_answer(
        inference=inference,
        snapshot=snapshot,
        message="Summarize all of these notes.",
        token_limit=900,
        answer="summarize_all",
    )

    final_payload = json.loads(
        inference.final_messages[-1]["content"].split("\n", 1)[1]
    )
    catalog_ids = [entry["note_id"] for entry in final_payload["reference_catalog"]]
    assert {"selected-root", "selected-child"} <= set(catalog_ids)
    assert catalog_ids.index("root-0") < catalog_ids.index("selected-root")


def _structural_root_summary_snapshot(root_count: int) -> ScopedSearchSnapshot:
    """Search matches only children; each root is structure without disclosed content."""
    roots = tuple(f"heading-{index}" for index in range(root_count))
    matches = tuple(f"match-{index}" for index in range(root_count))
    notes = {
        match_id: _note(match_id, root_id, root_id, f"EVIDENCE_{index} " * 150, index)
        for index, (root_id, match_id) in enumerate(zip(roots, matches))
    }
    nodes: dict[str, FrozenScopedTreeNode] = {}
    for root_id, match_id in zip(roots, matches):
        nodes[root_id] = FrozenScopedTreeNode(
            note_id=root_id,
            parent_id="",
            root_note_id=root_id,
            child_ids=(match_id,),
        )
        nodes[match_id] = FrozenScopedTreeNode(
            note_id=match_id,
            parent_id=root_id,
            root_note_id=root_id,
            child_ids=(),
        )
    return ScopedSearchSnapshot(
        run_id="structural-summary-scope",
        session_key="session-1",
        descriptor=_descriptor(),
        created_at="2026-08-29T00:00:00+00:00",
        ordered_root_ids=roots,
        ordered_note_ids=matches,
        notes_by_id=MappingProxyType(notes),
        tree_nodes_by_id=MappingProxyType(nodes),
        note_records_at_send=MappingProxyType({}),
        disclosable_search_query=_descriptor().search_query,
        preparation_ms=0.0, text_extraction=TextExtractionMeter.start(),
        selected_note=NO_SELECTED_NOTE,
    )


def test_staged_summary_asks_once_to_correct_structural_placeholder_citations() -> None:
    inference = _FakeInference()
    snapshot = _structural_root_summary_snapshot(5)

    events, _calls_at_question = _events_with_summary_answer(
        inference=inference,
        snapshot=snapshot,
        message="Summarize all of these notes.",
        token_limit=900,
        answer="summarize_all",
    )

    question = next(event for event in events if event["type"] == "bulk_question")
    assert question["batch_count"] > 1
    assert inference.summary_citation_corrections == question["batch_count"]
    final_payload = json.loads(
        inference.final_messages[-1]["content"].split("\n", 1)[1]
    )
    catalog_ids = {entry["note_id"] for entry in final_payload["reference_catalog"]}
    assert catalog_ids == set(snapshot.ordered_note_ids)
    assert not catalog_ids & set(snapshot.ordered_root_ids)
    assert any(event["type"] == "done" for event in events)


def test_staged_summary_reports_structural_citation_after_failed_correction() -> None:
    inference = _FakeInference()
    inference.ignore_summary_citation_corrections = True

    with pytest.raises(
        AgentExecutionError,
        match=(
            "Summary batch 1 returned invalid findings: .*even after a correction "
            "request: heading-0 \\(structural placeholder without disclosed content\\)"
        ),
    ):
        _events_with_summary_answer(
            inference=inference,
            snapshot=_structural_root_summary_snapshot(5),
            message="Summarize all of these notes.",
            token_limit=900,
            answer="summarize_all",
        )

    assert inference.summary_citation_corrections == 1
    assert inference.final_messages == []


@pytest.mark.parametrize(
    "unavailable_reason",
    ["blacklisted", "search_redacted", "password_protected", "username_protected", "not_whitelisted"],
)
def test_staged_summary_rejects_citations_to_unavailable_selected_notes(
    unavailable_reason: str,
) -> None:
    inference = _FakeInference()
    inference.summary_batch_citation_note_id = "selected-child"
    snapshot = replace(
        _multi_batch_summary_snapshot(),
        selected_note=SelectedNoteContext(
            "unavailable",
            "",
            (),
            unavailable_reason,
        ),
    )

    with pytest.raises(
        AgentExecutionError,
        match="Summary batch 1 returned invalid findings: .*selected-child",
    ):
        _events_with_summary_answer(
            inference=inference,
            snapshot=snapshot,
            message="Summarize all of these notes.",
            token_limit=900,
            answer="summarize_all",
        )

    assert "SELECTED_CHILD_CONTEXT" not in json.dumps(inference.agent_messages)
    assert inference.final_messages == []


def _active_skill_ids(messages: list[dict[str, str]]) -> list[str]:
    return [
        message["content"].split("\n", 1)[0].removeprefix("ACTIVE_SKILL ")
        for message in messages
        if message["role"] == "system" and message["content"].startswith("ACTIVE_SKILL ")
    ]


@pytest.mark.parametrize(
    ("snapshot_factory", "token_limit", "answer"),
    [
        (lambda: _snapshot(large_tail=False), 24_000, "summarize_all"),
        (_multi_batch_summary_snapshot, 900, "use_prefix"),
    ],
)
def test_single_payload_summaries_send_the_summary_skill(
    snapshot_factory,
    token_limit: int,
    answer: str,
) -> None:
    inference = _FakeInference()

    _events_with_summary_answer(
        inference=inference,
        snapshot=snapshot_factory(),
        message="Summarize all of these notes.",
        token_limit=token_limit,
        answer=answer,
    )

    assert inference.summary_batch_calls == []
    assert _active_skill_ids(inference.final_messages) == ["staged_summary_v1"]



def test_a_summary_never_blocks_other_changes() -> None:
    # A summary only reads notes: while its question waits and while its
    # batches run, editing notes (or anything else) stays allowed.
    inference = _FakeInference()
    blocked_while_running: list[str] = []

    async def collect() -> None:
        async for event in _runtime(inference).stream_agent(earlier_actions=[], 
            tagging_run=None,
            session_key="session-1",
            base_url="https://api.openai.com/v1",
            selected_model="gpt-5.6-sol",
            thinking_level="off",
            canonical_messages=[{"role": "user", "content": "Summarize all of these notes."}],
            prompts=DEFAULT_AGENT_PROMPTS,
            skills=DEFAULT_AGENT_SKILLS,
            retrieval_settings=AgentRetrievalSettings(max_page_approximate_tokens=900),
            web_settings=DEFAULT_AGENT_WEB_SETTINGS,
            frozen_scope=_multi_batch_summary_snapshot(),
        ):
            if bulk_operation_guard.operation_id:
                blocked_while_running.append(str(event["type"]))
            if event["type"] == "bulk_question":
                bulk_operation_guard.answer("session-1", event["question_id"], "summarize_all")

    asyncio.run(collect())
    assert blocked_while_running == []
    assert inference.summary_batch_calls



# Resumable whole-view summaries (summary_batch_store.py): a failed summary keeps
# its finished batches, and continuing it runs only the rest.

@pytest.fixture(autouse=True)
def _clear_kept_summary_batches():
    summary_batch_store.reset()
    yield
    summary_batch_store.reset()


_ORIGINAL_SUMMARY_REQUEST = "What is a high-level summary of all my notes?"


def _summary_run(
    *, inference: _FakeInference, snapshot: ScopedSearchSnapshot, message: str, selected_model: str,
    events: list[dict[str, object]],
) -> None:
    async def collect() -> None:
        async for event in _runtime(inference).stream_agent(
            earlier_actions=[], tagging_run=None, session_key="session-1",
            base_url="https://api.openai.com/v1", selected_model=selected_model, thinking_level="off",
            canonical_messages=[{"role": "user", "content": message}],
            prompts=DEFAULT_AGENT_PROMPTS, skills=DEFAULT_AGENT_SKILLS,
            retrieval_settings=AgentRetrievalSettings(max_page_approximate_tokens=900),
            web_settings=DEFAULT_AGENT_WEB_SETTINGS, frozen_scope=snapshot,
        ):
            events.append(event)
            if event["type"] == "bulk_question":
                bulk_operation_guard.answer("session-1", event["question_id"], "summarize_all")

    asyncio.run(collect())


def _failed_summary_of_seven_roots() -> _FakeInference:
    """Batch 1 alone, then roots 1-4 at once: root-2 fails first while 1, 3 and 4 finish."""
    inference = _FakeInference()
    inference.failed_summary_root_id = "root-2"
    inference.failed_summary_as_agent_error = True
    inference.summary_delay_seconds_by_root_id = {"root-1": 0.2, "root-3": 0.2, "root-4": 0.2}
    events: list[dict[str, object]] = []
    with pytest.raises(AgentExecutionError) as failure:
        _summary_run(inference=inference, snapshot=_summary_snapshot(7), message=_ORIGINAL_SUMMARY_REQUEST,
                     selected_model="gpt-5.6-sol", events=events)
    inference.failure_message = str(failure.value)
    return inference


def _continuing(snapshot: ScopedSearchSnapshot, selected_model: str, continues: bool) -> tuple[_FakeInference, list[dict[str, object]]]:
    inference = _FakeInference()
    inference.summary_tool_arguments = json.dumps({"continues_failed_summary": continues})
    events: list[dict[str, object]] = []
    _summary_run(inference=inference, snapshot=snapshot, message="try that again",
                 selected_model=selected_model, events=events)
    return inference, events


def test_a_failed_batch_keeps_the_finished_ones_and_starts_no_more() -> None:
    inference = _failed_summary_of_seven_roots()

    # The batches already running finished; the two still queued never started.
    assert sorted(inference.summary_batch_calls) == [("root-0",), ("root-1",), ("root-2",), ("root-3",), ("root-4",)]
    kept = summary_batch_store.kept(session_key="session-1")
    assert kept is not None
    assert kept.request == _ORIGINAL_SUMMARY_REQUEST
    assert len(kept.results) == 4
    assert "4 of 7 batches finished and were kept" in inference.failure_message


def test_continuing_reuses_the_kept_batches_and_runs_only_the_rest_with_the_original_question() -> None:
    _failed_summary_of_seven_roots()

    inference, events = _continuing(_summary_snapshot(7), "gpt-5.6-sol", True)

    assert sorted(inference.summary_batch_calls) == [("root-2",), ("root-5",), ("root-6",)]
    assert set(inference.summary_requests) == {_ORIGINAL_SUMMARY_REQUEST}
    # You already chose to summarize everything: no scope question this time.
    assert not any(event["type"] == "bulk_question" for event in events)
    assert any("label" in event and "Reused 4 of 7 batches from your earlier attempt" in str(event["label"]) for event in events)
    final_payload = json.loads(inference.final_messages[-1]["content"].split("\n", 1)[1])
    assert [root for summary in final_payload["authoritative_batch_findings"] for root in summary["covered_root_ids"]] == [
        f"root-{index}" for index in range(7)
    ]
    assert events[-1]["type"] == "done"
    # A successful summary drops what was kept.
    assert summary_batch_store.kept(session_key="session-1") is None


def test_a_new_summary_question_does_not_reuse_kept_batches() -> None:
    _failed_summary_of_seven_roots()

    inference, events = _continuing(_summary_snapshot(7), "gpt-5.6-sol", False)

    assert any(event["type"] == "bulk_question" for event in events)
    assert sorted(inference.summary_batch_calls) == [(f"root-{index}",) for index in range(7)]
    assert set(inference.summary_requests) == {"try that again"}


def test_an_edited_note_reruns_its_batch_when_continuing() -> None:
    _failed_summary_of_seven_roots()
    snapshot = _summary_snapshot(7)
    edited = replace(snapshot.notes_by_id["root-3"], note_text=NoteText.from_text("EDITED " * 150))
    snapshot = replace(snapshot, notes_by_id=MappingProxyType({**snapshot.notes_by_id, "root-3": edited}))

    inference, _events = _continuing(snapshot, "gpt-5.6-sol", True)

    assert sorted(inference.summary_batch_calls) == [("root-2",), ("root-3",), ("root-5",), ("root-6",)]


def test_a_different_model_reruns_every_batch_when_continuing() -> None:
    _failed_summary_of_seven_roots()

    inference, events = _continuing(_summary_snapshot(7), "gpt-5.6-luna", True)

    # Nothing matches, so it is an ordinary summary: the scope question comes back.
    assert any(event["type"] == "bulk_question" for event in events)
    assert sorted(inference.summary_batch_calls) == [(f"root-{index}",) for index in range(7)]
