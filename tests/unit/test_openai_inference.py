from __future__ import annotations

import asyncio
from decimal import Decimal
from types import SimpleNamespace

import httpx
import instructor
import pytest
from pydantic import BaseModel, Field
from openai import AsyncOpenAI
from openai import APIError

from app.services.agent.staged_summary import SummaryFindingsResult
from app.services.agent.tool_calling import AgentTool
from app.services.agent.history import record_history
from app.services.agent.trace import AgentTraceStore
from app.services.agent.inference import InferenceAttempt
from app.services.agent.inference import StructuredInferenceProgress
from app.services.agent.openai_inference import OPENAI_API_BASE_URL
from app.services.agent.openai_inference import OpenAIInferenceAdapter
from app.services.agent.openai_inference import resolve_openai_reasoning_effort
from app.services.agent.openai_inference import validate_openai_model
from app.services.agent.openai_cost_tracking import OpenAICostTracker
import app.services.agent.openai_inference as openai_inference_module
from app.services.agent.staged_summary import SummaryFinding
from app.services.agent.staged_summary import SummaryFindingsResult
from app.services.agent.structured_inference import _InstructorTraceCapture


_API_KEY = "sk-test-0123456789abcdefghijklmnop"


def test_openai_structured_cost_records_every_completed_retry_attempt() -> None:
    tracker = OpenAICostTracker()
    attempts = [
        InferenceAttempt(
            request={},
            response={
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 2,
                    "total_tokens": 12,
                    "prompt_tokens_details": {
                        "cached_tokens": 5,
                        "cache_write_tokens": 0,
                    },
                }
            },
            error="ValidationError: invalid action",
            duration_ms=1.0,
            validation_errors=(),
        ),
        InferenceAttempt(
            request={},
            response={
                "usage": {
                    "prompt_tokens": 20,
                    "completion_tokens": 3,
                    "total_tokens": 23,
                    "prompt_tokens_details": {
                        "cached_tokens": 10,
                        "cache_write_tokens": 2,
                    },
                }
            },
            error="",
            duration_ms=1.0,
            validation_errors=(),
        ),
    ]

    openai_inference_module._record_captured_openai_usage(
        cost_tracker=tracker,
        model="gpt-5.6-sol",
        attempts=attempts,
    )

    snapshot = tracker.snapshot()
    assert snapshot.uncached_input_tokens == 13
    assert snapshot.cached_input_tokens == 15
    assert snapshot.cache_write_tokens == 2
    assert snapshot.output_tokens == 5


class FakeInstructorClient:
    def __init__(self) -> None:
        self.handlers: dict[str, object] = {}
        self.create_kwargs: dict[str, object] = {}
        self.client = SimpleNamespace(close=self.close)
        self.http_clients: list[httpx.AsyncClient] = []
        self.wire_request_hooks = []
        self.is_closed = False

    def on(self, event_name: str, handler) -> None:
        self.handlers[event_name] = handler

    async def close(self) -> None:
        self.is_closed = True
        for http_client in self.http_clients:
            await http_client.aclose()

    async def create_partial(self, **kwargs):
        self.create_kwargs = kwargs
        request_handler = self.handlers["completion:kwargs"]
        response_handler = self.handlers["completion:response"]
        response_format = {
            "type": "json_schema",
            "json_schema": {
                "name": "SummaryFindingsResult",
                "schema": SummaryFindingsResult.model_json_schema(),
            },
        }
        request_handler(
            model="gpt-5.6-sol",
            messages=kwargs["messages"],
            response_format=response_format,
            max_completion_tokens=kwargs["max_completion_tokens"],
            reasoning_effort=kwargs["reasoning_effort"],
            stream_options=kwargs["stream_options"],
            store=kwargs["store"],
        )
        assert len(self.wire_request_hooks) == 1
        wire_request = httpx.Request(
            "POST",
            "https://api.openai.com/v1/chat/completions",
            json={
                "model": "gpt-5.6-sol",
                "messages": kwargs["messages"],
                "response_format": response_format,
                "stream": True,
                "max_completion_tokens": kwargs["max_completion_tokens"],
                "reasoning_effort": kwargs["reasoning_effort"],
                "stream_options": kwargs["stream_options"],
                "store": kwargs["store"],
            },
        )
        await self.wire_request_hooks[0](wire_request)
        response_chunk = SimpleNamespace(
            model_dump=lambda **options: {
                "id": "chatcmpl-action",
                "model": "gpt-5.6-sol",
                "choices": [
                    {
                        "delta": {
                            "content": '{"findings":[]}',
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 31,
                    "completion_tokens": 8,
                    "total_tokens": 39,
                    "prompt_tokens_details": {
                        "cached_tokens": 10,
                        "cache_write_tokens": 2,
                    },
                },
            },
        )

        async def chunk_iterator():
            yield response_chunk

        class FakeStream:
            def __init__(self) -> None:
                self._iterator = chunk_iterator()

            def __aiter__(self):
                return self._iterator

        stream = FakeStream()
        response_handler(stream)
        async for _chunk in stream:
            pass
        response_model = kwargs["response_model"]
        yield response_model(findings=[])


def test_openai_structured_inference_uses_schema_and_disables_storage(
    monkeypatch,
) -> None:
    fake_client = FakeInstructorClient()
    factory_call: dict[str, object] = {}

    def fake_from_openai(openai_client: AsyncOpenAI, **kwargs):
        factory_call.update({"openai_client": openai_client, **kwargs})
        http_client = openai_client._client
        assert isinstance(http_client, httpx.AsyncClient)
        fake_client.http_clients.append(http_client)
        fake_client.wire_request_hooks = http_client.event_hooks["request"]
        return fake_client

    monkeypatch.setattr(instructor, "from_openai", fake_from_openai)
    progress_events: list[StructuredInferenceProgress] = []
    cost_tracker = OpenAICostTracker()
    adapter = OpenAIInferenceAdapter(
        api_key=_API_KEY,
        cost_tracker=cost_tracker,
    )

    response = asyncio.run(
        adapter.infer_structured(
            base_url=OPENAI_API_BASE_URL,
            model="gpt-5.6-sol",
            thinking_level="medium",
            messages=[
                {"role": "system", "content": "Summarize the notes."},
                {"role": "user", "content": "Are you there?"},
            ],
            response_model=SummaryFindingsResult,
            on_progress=progress_events.append,
        )
    )

    openai_client = factory_call["openai_client"]
    assert isinstance(openai_client, AsyncOpenAI)
    assert str(openai_client.base_url) == "https://api.openai.com/v1/"
    assert openai_client.max_retries == 0
    assert factory_call["model"] == "gpt-5.6-sol"
    assert factory_call["mode"] is instructor.Mode.JSON_SCHEMA
    assert fake_client.create_kwargs["response_model"] is SummaryFindingsResult
    assert fake_client.create_kwargs["max_completion_tokens"] == 8_192
    assert fake_client.create_kwargs["reasoning_effort"] == "medium"
    # Medium thinking may be silent longer before its first word (test_openai_stall_limits.py).
    assert fake_client.create_kwargs["timeout"] == 60.0
    assert fake_client.create_kwargs["stream_options"] == {"include_usage": True}
    assert fake_client.create_kwargs["store"] is False
    assert fake_client.is_closed is True
    assert response.content == '{"findings":[]}'
    assert response.usage == {
        "prompt_tokens": 31,
        "completion_tokens": 8,
        "total_tokens": 39,
        "uncached_input_tokens": 19,
        "cached_input_tokens": 10,
        "cache_write_tokens": 2,
    }
    assert cost_tracker.snapshot().estimated_cost_usd == Decimal("0.00025")
    wire_body = progress_events[0].wire_request["body"]
    assert wire_body["model"] == "gpt-5.6-sol"
    assert wire_body["store"] is False
    assert wire_body["messages"][1] == {
        "role": "user",
        "content": "Are you there?",
    }
    assert _API_KEY not in str(wire_body)


def test_openai_text_stream_disables_storage_and_reports_usage(monkeypatch) -> None:
    created: dict[str, object] = {}

    class FakeStream:
        async def __aiter__(self):
            yield SimpleNamespace(
                usage=None,
                choices=[SimpleNamespace(
                    delta=SimpleNamespace(content="Hello"),
                    finish_reason=None,
                )],
            )
            yield SimpleNamespace(
                usage=None,
                choices=[SimpleNamespace(
                    delta=SimpleNamespace(content=None),
                    finish_reason="stop",
                )],
            )
            yield SimpleNamespace(
                usage=SimpleNamespace(
                    model_dump=lambda: {
                        "prompt_tokens": 10,
                        "completion_tokens": 2,
                        "total_tokens": 12,
                        "prompt_tokens_details": {
                            "cached_tokens": 4,
                            "cache_write_tokens": 1,
                        },
                    }
                ),
                choices=[],
            )

    class FakeCompletions:
        def __init__(self, http_client: httpx.AsyncClient) -> None:
            self._http_client = http_client

        async def create(self, **kwargs):
            created.update(kwargs)
            request = httpx.Request(
                "POST",
                "https://api.openai.com/v1/chat/completions",
                json=kwargs,
            )
            for hook in self._http_client.event_hooks["request"]:
                await hook(request)
            return FakeStream()

    class FakeOpenAIClient:
        def __init__(self, *, api_key, base_url, http_client, max_retries) -> None:
            assert api_key == _API_KEY
            assert base_url == OPENAI_API_BASE_URL
            assert max_retries == 0
            self._http_client = http_client
            self.chat = SimpleNamespace(
                completions=FakeCompletions(http_client),
            )

        async def close(self) -> None:
            await self._http_client.aclose()

    monkeypatch.setattr(openai_inference_module, "AsyncOpenAI", FakeOpenAIClient)
    cost_tracker = OpenAICostTracker()
    adapter = OpenAIInferenceAdapter(
        api_key=_API_KEY,
        cost_tracker=cost_tracker,
    )
    wire_requests: list[dict[str, object]] = []

    async def collect_events() -> list[dict[str, object]]:
        return [
            event
            async for event in adapter.stream_text(
                base_url=OPENAI_API_BASE_URL,
                model="gpt-5.6-luna",
                thinking_level="off",
                messages=[{"role": "user", "content": "Hello"}],
                max_output_tokens=256,
                on_request=wire_requests.append,
            )
        ]

    events = asyncio.run(collect_events())

    assert created["model"] == "gpt-5.6-luna"
    assert created["reasoning_effort"] == "none"
    assert created["max_completion_tokens"] == 256
    assert created["stream"] is True
    assert created["store"] is False
    assert events == [
        # OpenAI's first signal, before any content (the chat stops showing "Waiting").
        {"type": "provider_started"},
        {"type": "content_delta", "text": "Hello"},
        {
            "type": "done",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 2,
                "total_tokens": 12,
                "uncached_input_tokens": 5,
                "cached_input_tokens": 4,
                "cache_write_tokens": 1,
            },
        },
    ]
    assert cost_tracker.snapshot().estimated_cost_usd == Decimal("0.00000373")
    assert len(wire_requests) == 1
    assert wire_requests[0]["body"]["store"] is False
    assert _API_KEY not in str(wire_requests[0])


def test_openai_text_stream_rejects_output_limit_truncation(monkeypatch) -> None:
    class FakeStream:
        async def __aiter__(self):
            yield SimpleNamespace(
                usage=None,
                choices=[SimpleNamespace(
                    delta=SimpleNamespace(content="Partial response"),
                    finish_reason=None,
                )],
            )
            yield SimpleNamespace(
                usage=None,
                choices=[SimpleNamespace(
                    delta=SimpleNamespace(content=None),
                    finish_reason="length",
                )],
            )
            yield SimpleNamespace(
                usage=SimpleNamespace(
                    model_dump=lambda: {
                        "prompt_tokens": 10,
                        "completion_tokens": 256,
                        "total_tokens": 266,
                    }
                ),
                choices=[],
            )

    class FakeCompletions:
        async def create(self, **kwargs):
            del kwargs
            return FakeStream()

    class FakeOpenAIClient:
        def __init__(self, *, api_key, base_url, http_client, max_retries) -> None:
            del api_key, base_url, max_retries
            self._http_client = http_client
            self.chat = SimpleNamespace(completions=FakeCompletions())

        async def close(self) -> None:
            await self._http_client.aclose()

    monkeypatch.setattr(openai_inference_module, "AsyncOpenAI", FakeOpenAIClient)
    cost_tracker = OpenAICostTracker()
    adapter = OpenAIInferenceAdapter(
        api_key=_API_KEY,
        cost_tracker=cost_tracker,
    )

    async def collect_events() -> list[dict[str, object]]:
        return [
            event
            async for event in adapter.stream_text(
                base_url=OPENAI_API_BASE_URL,
                model="gpt-5.6-sol",
                thinking_level="off",
                messages=[{"role": "user", "content": "Summarize"}],
                max_output_tokens=256,
                on_request=lambda request: None,
            )
        ]

    with pytest.raises(
        openai_inference_module.OpenAIProviderError,
        match="maximum output-token limit",
    ):
        asyncio.run(collect_events())
    assert cost_tracker.snapshot().output_tokens == 256


def test_openai_models_and_reasoning_levels_are_strict() -> None:
    assert validate_openai_model(" gpt-5.6-terra ") == "gpt-5.6-terra"
    assert resolve_openai_reasoning_effort("off") == "none"
    assert resolve_openai_reasoning_effort("high") == "high"

    for invalid_model in ("gpt-5.6", "gpt-4o", ""):
        with pytest.raises(ValueError, match="Unsupported OpenAI model"):
            validate_openai_model(invalid_model)


def test_structured_output_progress_carries_latest_partial_object() -> None:
    progress_events: list[StructuredInferenceProgress] = []
    capture = _InstructorTraceCapture(on_progress=progress_events.append)

    async def run() -> None:
        capture.record_request(model="gpt-5.6-sol", messages=[])
        await capture.record_wire_request(httpx.Request(
            "POST",
            "https://api.openai.com/v1/chat/completions",
            json={"model": "gpt-5.6-sol", "messages": []},
        ))
        capture.record_partial(SummaryFindingsResult(findings=[
            SummaryFinding(text="Streaming finding", supporting_note_ids=["note-a"]),
        ]))

        async def chunk_iterator():
            yield SimpleNamespace(model_dump=lambda **options: {
                "choices": [{"delta": {"content": "x" * 80}}],
            })

        stream = SimpleNamespace(_iterator=chunk_iterator())
        capture.record_response(stream)
        async for _chunk in stream._iterator:
            pass

    asyncio.run(run())

    output_events = [
        event for event in progress_events if event.phase == "output_progress"
    ]
    assert output_events
    assert output_events[0].partial_output == {
        "findings": [{
            "text": "Streaming finding",
            "supporting_note_ids": ["note-a"],
        }],
    }
    started = next(
        event for event in progress_events if event.phase == "attempt_started"
    )
    assert started.partial_output == {}


# --- Tool turns (OpenAI Responses API) -------------------------------------
# Chat Completions rejects function tools combined with reasoning effort, so
# tool turns use the Responses API; its reasoning items are handed back to the
# next turn as opaque provider_state.


class _SearchArguments(BaseModel):
    query: str = Field(..., description="Words to search for")


_SEARCH_TOOL = AgentTool(name="search_view_notes", description="Search notes in the current view.", arguments_model=_SearchArguments)

_RESPONSES_USAGE = {
    "input_tokens": 100, "input_tokens_details": {"cached_tokens": 40, "cache_write_tokens": 0},
    "output_tokens": 20, "output_tokens_details": {"reasoning_tokens": 9}, "total_tokens": 120,
}

_REASONING_ITEM = {"id": "rs_1", "type": "reasoning", "summary": [], "encrypted_content": "opaque-reasoning"}


class _Event(SimpleNamespace):
    """A Responses stream event; the history recorder stores events through model_dump."""

    def model_dump(self, mode: str) -> dict[str, object]:
        assert mode == "json"
        return {"type": self.type}


def _item_done(item):
    return _Event(type="response.output_item.done", item=SimpleNamespace(model_dump=lambda mode: dict(item)))


def _text_delta(text):
    return _Event(type="response.output_text.delta", delta=text)


def _completed():
    return _Event(type="response.completed", response=SimpleNamespace(
        status="completed", incomplete_details=None, usage=SimpleNamespace(model_dump=lambda mode: dict(_RESPONSES_USAGE)),
    ))


def _incomplete(reason):
    return _Event(type="response.incomplete", response=SimpleNamespace(
        status="incomplete", incomplete_details=SimpleNamespace(reason=reason),
        usage=SimpleNamespace(model_dump=lambda mode: dict(_RESPONSES_USAGE)),
    ))


def _run_tool_turn(monkeypatch, events, messages):
    created: dict[str, object] = {}

    class FakeStream:
        async def __aiter__(self):
            for event in events:
                yield event

    class FakeResponses:
        def __init__(self, http_client):
            self._http_client = http_client

        async def create(self, **kwargs):
            created.update(kwargs)
            request = httpx.Request("POST", "https://api.openai.com/v1/responses", json=kwargs)
            for hook in self._http_client.event_hooks["request"]:
                await hook(request)
            return FakeStream()

    class FakeOpenAIClient:
        def __init__(self, *, api_key, base_url, http_client, max_retries) -> None:
            assert max_retries == 0
            self._http_client = http_client
            self.responses = FakeResponses(http_client)

        async def close(self) -> None:
            await self._http_client.aclose()

    monkeypatch.setattr(openai_inference_module, "AsyncOpenAI", FakeOpenAIClient)
    adapter = OpenAIInferenceAdapter(api_key=_API_KEY, cost_tracker=OpenAICostTracker())

    async def collect():
        return [event async for event in adapter.stream_tool_turn(
            base_url=OPENAI_API_BASE_URL, model="gpt-5.6-luna", thinking_level="low",
            messages=messages, tools=(_SEARCH_TOOL,), max_output_tokens=8_192, on_request=lambda request: None,
        )]

    return asyncio.run(collect()), created


_EXPECTED_USAGE = {
    "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
    "uncached_input_tokens": 60, "cached_input_tokens": 40, "cache_write_tokens": 0,
}


def test_a_tool_turn_sends_strict_tools_and_returns_tool_calls_with_reasoning_state(monkeypatch) -> None:
    messages = [
        {"role": "system", "content": "You are MetaList's assistant."},
        {"role": "user", "content": "Find my garden notes"},
        {"role": "assistant", "content": "", "provider_state": {"provider": "openai", "items": [_REASONING_ITEM]},
         "tool_calls": [{"id": "call-0", "name": "search_view_notes", "arguments": '{"query":"roses"}'}]},
        {"role": "tool", "tool_call_id": "call-0", "name": "search_view_notes", "content": "No matches."},
    ]
    events, created = _run_tool_turn(monkeypatch, [
        # The API returns output-only fields (status, content) that it rejects
        # as input; only the input fields are kept for the next turn.
        _item_done({**_REASONING_ITEM, "status": None, "content": []}),
        _item_done({"type": "function_call", "id": "fc_1", "call_id": "call-1", "name": "search_view_notes",
                    "arguments": '{"query":"garden"}', "status": "completed"}),
        _completed(),
    ], messages)

    assert events == [
        # OpenAI's first signal, before any content (the chat stops showing "Waiting").
        {"type": "provider_started"},
        {"type": "tool_call", "id": "call-1", "name": "search_view_notes", "arguments": '{"query":"garden"}'},
        {"type": "done", "finish_reason": "tool_calls", "usage": _EXPECTED_USAGE,
         "provider_state": {"provider": "openai", "items": [_REASONING_ITEM]}},
    ]
    assert created["tools"] == [{
        "type": "function",
        "name": "search_view_notes",
        "description": "Search notes in the current view.",
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "Words to search for"}},
            "required": ["query"],
            "additionalProperties": False,
        },
    }]
    # The neutral conversation becomes Responses input items; the earlier
    # turn's reasoning is handed back ahead of its tool call.
    assert created["input"] == [
        {"role": "system", "content": "You are MetaList's assistant."},
        {"role": "user", "content": "Find my garden notes"},
        _REASONING_ITEM,
        {"type": "function_call", "call_id": "call-0", "name": "search_view_notes", "arguments": '{"query":"roses"}'},
        {"type": "function_call_output", "call_id": "call-0", "output": "No matches."},
    ]
    assert created["reasoning"] == {"effort": "low"}
    assert created["max_output_tokens"] == 8_192
    assert created["store"] is False
    assert created["stream"] is True
    assert created["include"] == ["reasoning.encrypted_content"]


def test_a_tool_turn_that_answers_streams_its_text(monkeypatch) -> None:
    events, _created = _run_tool_turn(monkeypatch, [
        _text_delta("Your garden "), _text_delta("notes mention roses."), _completed(),
    ], [{"role": "user", "content": "Summarize"}])

    assert [event["type"] for event in events] == ["provider_started", "content_delta", "content_delta", "done"]
    assert "".join(event["text"] for event in events if event["type"] == "content_delta") == "Your garden notes mention roses."
    assert events[-1]["finish_reason"] == "stop"


def test_a_tool_turn_cut_off_at_the_output_limit_fails_loudly(monkeypatch) -> None:
    with pytest.raises(openai_inference_module.OpenAIProviderError, match="output-token limit"):
        _run_tool_turn(monkeypatch, [_text_delta("Partial"), _incomplete("max_output_tokens")],
                       [{"role": "user", "content": "Summarize"}])


def test_a_tool_turn_appears_in_the_llm_history_export(monkeypatch) -> None:
    trace_store = AgentTraceStore()
    run_id = trace_store.start_run(session_key="session-1", model="gpt-5.6-luna", user_message="Find my garden notes")
    with record_history(trace_store, session_key="session-1", run_id=run_id):
        _run_tool_turn(monkeypatch, [
            _item_done({"type": "function_call", "id": "fc_1", "call_id": "call-1", "name": "search_view_notes",
                        "arguments": '{"query":"garden"}', "status": "completed"}),
            _completed(),
        ], [{"role": "user", "content": "Find my garden notes"}])

    pairs = trace_store.export_history(session_key="session-1")

    assert len(pairs) == 1
    request, output = pairs[0]
    assert request["invocation"]["kind"] == "tool"
    assert request["invocation"]["tools"][0]["name"] == "search_view_notes"
    assert request["request"]["tools"][0]["strict"] is True
    assert output["status"] == "complete"
