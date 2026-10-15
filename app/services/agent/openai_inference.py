"""OpenAI inference adapter using Instructor for typed output."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from collections.abc import Callable
from typing import cast

import httpx
import instructor
from openai import APIError
from openai import APITimeoutError
from openai import AsyncOpenAI
from pydantic import BaseModel

from instructor.v2.core.client import AsyncInstructor

from app.services.agent.history import record_provider_event, record_provider_chunk, record_structured_call, record_text_call, record_tool_turn
from app.services.agent.tool_calling import AgentTool, validate_tool_conversation
from app.services.agent.inference import InferenceContextWindow
from app.services.agent.inference import InferenceAttempt
from app.services.agent.inference import InferenceProviderError
from app.services.agent.inference import InferenceResponse
from app.services.agent.inference import StructuredInferenceProgress
from app.services.agent.inference import TARGET_AGENT_CONTEXT_TOKENS
from app.services.agent.openai_cost_tracking import OpenAICostTracker
# Registers strict structured outputs for every OpenAI JSON_SCHEMA request.
import app.services.agent.strict_structured_outputs  # noqa: F401
from app.services.agent.openai_cost_tracking import OpenAITokenUsage
from app.services.agent.structured_inference import _InstructorTraceCapture
from app.services.agent.structured_inference import _attach_trace_capture
from app.services.agent.structured_inference import _create_structured_completion
from app.services.agent.structured_inference import _extract_reasoning
from app.services.agent.structured_inference import _json_object
from app.services.agent.structured_inference import _structured_max_output_tokens


OPENAI_API_BASE_URL = "https://api.openai.com/v1"
OPENAI_MODEL_CONTEXT_TOKENS = 1_050_000
OPENAI_MODELS = (
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
)


class OpenAIProviderError(InferenceProviderError):
    """Expected OpenAI API or transport failure."""


def validate_openai_model(model: str) -> str:
    if not isinstance(model, str):
        raise TypeError("OpenAI model must be text")
    normalized = model.strip()
    if normalized not in OPENAI_MODELS:
        raise ValueError(f"Unsupported OpenAI model: {model}")
    return normalized


def resolve_openai_reasoning_effort(thinking_level: str) -> str:
    mapping = {
        "off": "none",
        "low": "low",
        "medium": "medium",
        "high": "high",
    }
    if thinking_level not in mapping:
        raise ValueError(f"Unsupported OpenAI thinking level: {thinking_level}")
    return mapping[thinking_level]


# How long OpenAI may stay silent (no reply yet, or no streamed data) before a
# request fails, instead of the library's 600 seconds. Off and Low are measured
# on Luna (first signal in 0.7-2 s, streaming gaps under 0.4 s, also with a
# 180,000-token input). Medium and High may think silently before their first
# word, so their limits are generous; they are not measured.
_OPENAI_SILENCE_LIMIT_SECONDS = {"off": 15.0, "low": 15.0, "medium": 60.0, "high": 120.0}


def openai_silence_limit_seconds(thinking_level: str) -> float:
    if thinking_level not in _OPENAI_SILENCE_LIMIT_SECONDS:
        raise ValueError(f"Unsupported OpenAI thinking level: {thinking_level}")
    return _OPENAI_SILENCE_LIMIT_SECONDS[thinking_level]


def openai_silence_message(seconds: float) -> str:
    return f"OpenAI did not respond for {seconds:g} seconds. Check your internet connection and ask again."


def _validate_base_url(base_url: str) -> None:
    if base_url != OPENAI_API_BASE_URL:
        raise ValueError("OpenAI inference requires the official API base URL")


def _create_instructor_client(
    *,
    api_key: str,
    model: str,
    capture: _InstructorTraceCapture,
) -> AsyncInstructor:
    http_client = httpx.AsyncClient(
        event_hooks={"request": [capture.record_wire_request]},
        follow_redirects=False,
        trust_env=False,
    )
    openai_client = AsyncOpenAI(
        api_key=api_key,
        base_url=OPENAI_API_BASE_URL,
        http_client=http_client,
        max_retries=0,
    )
    return cast(
        AsyncInstructor,
        instructor.from_openai(
            openai_client,
            model=model,
            mode=instructor.Mode.JSON_SCHEMA,
        ),
    )


def _provider_error_message(exc: APIError) -> str:
    detail = " ".join(str(exc).split())
    if detail == "":
        return "OpenAI API request failed"
    return f"OpenAI API request failed: {detail[:500]}"


def _required_usage_integer(*, usage: dict[str, object], field_name: str) -> int:
    if field_name not in usage:
        raise TypeError(f"OpenAI usage omitted {field_name}")
    value = usage[field_name]
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise TypeError(f"OpenAI usage {field_name} must be a non-negative integer")
    return value


def _detail_usage_integer(*, details: dict[str, object], field_name: str) -> int:
    if field_name not in details or details[field_name] is None:
        return 0
    value = details[field_name]
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise TypeError(f"OpenAI usage {field_name} must be a non-negative integer")
    return value


def _extract_openai_token_usage(raw_response: dict[str, object]) -> OpenAITokenUsage:
    if "usage" not in raw_response:
        raise TypeError("OpenAI response omitted usage")
    raw_usage = raw_response["usage"]
    if not isinstance(raw_usage, dict):
        raise TypeError("OpenAI response usage must be an object")
    raw_details: object = {}
    if "prompt_tokens_details" in raw_usage:
        raw_details = raw_usage["prompt_tokens_details"]
    if raw_details is None:
        raw_details = {}
    if not isinstance(raw_details, dict):
        raise TypeError("OpenAI prompt token details must be an object")
    return OpenAITokenUsage(
        prompt_tokens=_required_usage_integer(
            usage=raw_usage,
            field_name="prompt_tokens",
        ),
        cached_input_tokens=_detail_usage_integer(
            details=raw_details,
            field_name="cached_tokens",
        ),
        cache_write_tokens=_detail_usage_integer(
            details=raw_details,
            field_name="cache_write_tokens",
        ),
        output_tokens=_required_usage_integer(
            usage=raw_usage,
            field_name="completion_tokens",
        ),
        total_tokens=_required_usage_integer(
            usage=raw_usage,
            field_name="total_tokens",
        ),
    )


def _record_captured_openai_usage(
    *,
    cost_tracker: OpenAICostTracker,
    model: str,
    attempts: list[InferenceAttempt],
) -> None:
    for attempt in attempts:
        if not attempt.response:
            continue
        if "usage" not in attempt.response:
            if attempt.error == "":
                raise TypeError("Successful OpenAI structured response omitted usage")
            continue
        cost_tracker.record(
            model=model,
            usage=_extract_openai_token_usage(attempt.response),
        )


def _strict_json_schema(schema: object) -> object:
    """OpenAI strict mode: no titles, every object closed and fully required."""
    if isinstance(schema, list):
        return [_strict_json_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    strict = {key: _strict_json_schema(value) for key, value in schema.items() if key != "title"}
    if "properties" in strict:
        strict["additionalProperties"] = False
        strict["required"] = list(strict["properties"])
    return strict


def _openai_tool(tool: AgentTool) -> dict[str, object]:
    return {
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "strict": True,
        "parameters": _strict_json_schema(tool.arguments_schema()),
    }


def _responses_input(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    """Translate the provider-neutral tool conversation to Responses API input items."""
    validate_tool_conversation(messages)
    items: list[dict[str, object]] = []
    for message in messages:
        role = message["role"]
        if role == "tool":
            items.append({"type": "function_call_output", "call_id": message["tool_call_id"], "output": message["content"]})
            continue
        if role != "assistant":
            items.append({"role": role, "content": message["content"]})
            continue
        if "provider_state" in message:
            state = message["provider_state"]
            if state["provider"] != _OPENAI_PROVIDER_STATE:
                raise ValueError(f"Cannot hand {state['provider']} state to OpenAI")
            items.extend(dict(item) for item in state["items"])
        if message["content"] != "":
            items.append({"role": "assistant", "content": message["content"]})
        if "tool_calls" in message:
            for call in message["tool_calls"]:
                items.append({"type": "function_call", "call_id": call["id"], "name": call["name"], "arguments": call["arguments"]})
    return items


def _responses_usage(raw_usage: dict[str, object]) -> OpenAITokenUsage:
    """Responses API usage (input/output tokens) in the shared OpenAI usage shape."""
    details: object = {}
    if "input_tokens_details" in raw_usage and raw_usage["input_tokens_details"] is not None:
        details = raw_usage["input_tokens_details"]
    if not isinstance(details, dict):
        raise TypeError("OpenAI input token details must be an object")
    return OpenAITokenUsage(
        prompt_tokens=_required_usage_integer(usage=raw_usage, field_name="input_tokens"),
        cached_input_tokens=_detail_usage_integer(details=details, field_name="cached_tokens"),
        cache_write_tokens=_detail_usage_integer(details=details, field_name="cache_write_tokens"),
        output_tokens=_required_usage_integer(usage=raw_usage, field_name="output_tokens"),
        total_tokens=_required_usage_integer(usage=raw_usage, field_name="total_tokens"),
    )


# provider_state written and read only by this adapter.
_OPENAI_PROVIDER_STATE = "openai"
# Fields of a returned reasoning item that the Responses API accepts back as input.
_REASONING_INPUT_FIELDS = ("id", "type", "summary", "encrypted_content")


class OpenAIInferenceAdapter:
    def __init__(self, *, api_key: str, cost_tracker: OpenAICostTracker) -> None:
        if not isinstance(api_key, str) or api_key == "":
            raise ValueError("OpenAI inference requires an API key")
        if not isinstance(cost_tracker, OpenAICostTracker):
            raise TypeError("OpenAI inference requires an OpenAI cost tracker")
        self._api_key = api_key
        self._cost_tracker = cost_tracker

    @property
    def provider_label(self) -> str:
        return "OpenAI"

    async def inspect_context_window(
        self,
        *,
        base_url: str,
        model: str,
    ) -> InferenceContextWindow:
        _validate_base_url(base_url)
        normalized_model = validate_openai_model(model)
        return InferenceContextWindow(
            model=normalized_model,
            maximum_tokens=OPENAI_MODEL_CONTEXT_TOKENS,
            loaded_tokens=OPENAI_MODEL_CONTEXT_TOKENS,
            required_tokens=TARGET_AGENT_CONTEXT_TOKENS,
        )

    @record_structured_call
    async def infer_structured(
        self,
        *,
        base_url: str,
        model: str,
        thinking_level: str,
        messages: list[dict[str, str]],
        response_model: type[BaseModel],
        on_progress: Callable[[StructuredInferenceProgress], None],
    ) -> InferenceResponse:
        _validate_base_url(base_url)
        normalized_model = validate_openai_model(model)
        reasoning_effort = resolve_openai_reasoning_effort(thinking_level)
        capture = _InstructorTraceCapture(on_progress=on_progress)
        client = _create_instructor_client(
            api_key=self._api_key,
            model=normalized_model,
            capture=capture,
        )
        _attach_trace_capture(client=client, capture=capture)
        request_options = {
            "max_completion_tokens": _structured_max_output_tokens(response_model),
            "timeout": openai_silence_limit_seconds(thinking_level),
            "reasoning_effort": reasoning_effort,
            "stream_options": {"include_usage": True},
            "store": False,
        }
        # lint: allow-PY001 rationale="OpenAI API and transport failures are external provider failures"
        try:
            parsed, raw_completion = await _create_structured_completion(
                client=client,
                capture=capture,
                response_model=response_model,
                messages=messages,
                request_options=request_options,
            )
        # lint: allow-PY001 rationale="a request OpenAI never answers is a network failure, explained plainly"
        except APITimeoutError as exc:
            raise OpenAIProviderError(openai_silence_message(openai_silence_limit_seconds(thinking_level))) from exc
        # lint: allow-PY001 rationale="translate external OpenAI API failures into the provider-neutral contract"
        except APIError as exc:
            raise OpenAIProviderError(_provider_error_message(exc)) from exc
        finally:
            for number, attempt in enumerate(capture.freeze(), 1):
                record_provider_event("LLM_ATTEMPT_OUTPUT", {
                    "attempt": number, "response": attempt.response,
                    "error": attempt.error, "duration_ms": attempt.duration_ms,
                })
            _record_captured_openai_usage(
                cost_tracker=self._cost_tracker,
                model=normalized_model,
                attempts=capture.freeze(),
            )
        if not isinstance(parsed, response_model):
            raise TypeError("Instructor returned the wrong structured response type")
        capture.record_success()
        raw_response = _json_object(raw_completion)
        attempts = capture.freeze()
        if len(attempts) == 0:
            raise RuntimeError("Instructor returned without recording an inference attempt")
        return InferenceResponse(
            content=parsed.model_dump_json(),
            thinking=_extract_reasoning(raw_response),
            usage=_extract_openai_token_usage(raw_response).as_inference_usage(),
            attempts=attempts,
        )

    @record_text_call
    async def stream_text(
        self,
        *,
        base_url: str,
        model: str,
        thinking_level: str,
        messages: list[dict[str, str]],
        max_output_tokens: int,
        on_request: Callable[[dict[str, object]], None],
    ) -> AsyncIterator[dict[str, object]]:
        _validate_base_url(base_url)
        normalized_model = validate_openai_model(model)
        reasoning_effort = resolve_openai_reasoning_effort(thinking_level)
        if (
            not isinstance(max_output_tokens, int)
            or isinstance(max_output_tokens, bool)
            or max_output_tokens < 1
        ):
            raise ValueError("OpenAI maximum output tokens must be positive")

        async def capture_wire_request(request: httpx.Request) -> None:
            raw_body = await request.aread()
            body = json.loads(raw_body)
            if not isinstance(body, dict):
                raise TypeError("OpenAI wire request body must be an object")
            record_provider_event("LLM_WIRE_REQUEST", {"method": request.method, "url": str(request.url), "body": body})
            on_request(
                {
                    "method": request.method,
                    "url": str(request.url),
                    "body": body,
                }
            )

        http_client = httpx.AsyncClient(
            event_hooks={"request": [capture_wire_request]},
            follow_redirects=False,
            trust_env=False,
        )
        client = AsyncOpenAI(
            api_key=self._api_key,
            base_url=OPENAI_API_BASE_URL,
            http_client=http_client,
            max_retries=0,
        )
        did_finish = False
        finish_reason = ""
        has_provider_started = False
        # lint: allow-PY001 rationale="OpenAI streaming and transport failures are external provider failures"
        try:
            stream = await client.chat.completions.create(
                model=normalized_model,
                messages=cast(object, messages),
                reasoning_effort=cast(object, reasoning_effort),
                max_completion_tokens=max_output_tokens,
                timeout=openai_silence_limit_seconds(thinking_level),
                stream=True,
                stream_options={"include_usage": True},
                store=False,
            )
            async for chunk in stream:  # shockharness: ignore[EXC003] reason="each pull from OpenAI's stream is the external operation; the body forwards and accounts for the chunk"
                if not has_provider_started:
                    # OpenAI's first signal: the request was received (the chat stops showing "Waiting").
                    has_provider_started = True
                    yield {"type": "provider_started"}
                record_provider_chunk(chunk)
                if chunk.usage is not None:
                    usage_payload = chunk.usage.model_dump()
                    usage = _extract_openai_token_usage({"usage": usage_payload})
                    self._cost_tracker.record(model=normalized_model, usage=usage)
                    if finish_reason == "length":
                        raise OpenAIProviderError(
                            "OpenAI reached the maximum output-token limit before "
                            "finishing the response"
                        )
                    if finish_reason != "stop":
                        raise OpenAIProviderError(
                            f"OpenAI ended the response with finish reason "
                            f"{finish_reason!r}"
                        )
                    yield {"type": "done", "usage": usage.as_inference_usage()}
                    did_finish = True
                    continue
                for choice in chunk.choices:
                    content = choice.delta.content
                    if content is not None and content != "":
                        yield {"type": "content_delta", "text": content}
                    choice_finish_reason = choice.finish_reason
                    if choice_finish_reason is None:
                        continue
                    if (
                        not isinstance(choice_finish_reason, str)
                        or choice_finish_reason == ""
                    ):
                        raise TypeError("OpenAI finish reason must be non-empty text")
                    if finish_reason != "" and finish_reason != choice_finish_reason:
                        raise OpenAIProviderError(
                            "OpenAI returned conflicting stream finish reasons"
                        )
                    finish_reason = choice_finish_reason
        # lint: allow-PY001 rationale="a request OpenAI never answers is a network failure, explained plainly"
        except APITimeoutError as exc:
            raise OpenAIProviderError(openai_silence_message(openai_silence_limit_seconds(thinking_level))) from exc
        # lint: allow-PY001 rationale="translate external OpenAI stream failures into the provider-neutral contract"
        except APIError as exc:
            raise OpenAIProviderError(_provider_error_message(exc)) from exc
        finally:
            await client.close()
        if not did_finish:
            raise OpenAIProviderError("OpenAI response stream ended before completion")

    @record_tool_turn
    async def stream_tool_turn(
        self,
        *,
        base_url: str,
        model: str,
        thinking_level: str,
        messages: list[dict[str, object]],
        tools: tuple[AgentTool, ...],
        max_output_tokens: int,
        on_request: Callable[[dict[str, object]], None],
    ) -> AsyncIterator[dict[str, object]]:
        # Tool turns use the Responses API: Chat Completions rejects function
        # tools combined with reasoning effort. Reasoning items come back
        # encrypted (store=False) and are handed to the next turn as
        # provider_state, so a thinking model keeps its train of thought.
        _validate_base_url(base_url)
        normalized_model = validate_openai_model(model)
        reasoning_effort = resolve_openai_reasoning_effort(thinking_level)
        if not isinstance(tools, tuple) or not tools or not all(isinstance(tool, AgentTool) for tool in tools):
            raise TypeError("A tool turn needs a non-empty tuple of AgentTool")
        if len({tool.name for tool in tools}) != len(tools):
            raise ValueError("Tool names must be unique")
        if not isinstance(max_output_tokens, int) or isinstance(max_output_tokens, bool) or max_output_tokens < 1:
            raise ValueError("OpenAI maximum output tokens must be positive")
        provider_input = _responses_input(messages)

        async def capture_wire_request(request: httpx.Request) -> None:
            body = json.loads(await request.aread())
            if not isinstance(body, dict):
                raise TypeError("OpenAI wire request body must be an object")
            record_provider_event("LLM_WIRE_REQUEST", {"method": request.method, "url": str(request.url), "body": body})
            on_request({"method": request.method, "url": str(request.url), "body": body})

        http_client = httpx.AsyncClient(
            event_hooks={"request": [capture_wire_request]},
            follow_redirects=False,
            trust_env=False,
        )
        client = AsyncOpenAI(api_key=self._api_key, base_url=OPENAI_API_BASE_URL, http_client=http_client, max_retries=0)
        tool_calls: list[dict[str, str]] = []
        reasoning_items: list[dict[str, object]] = []
        did_finish = False
        has_provider_started = False
        # lint: allow-PY001 rationale="OpenAI streaming and transport failures are external provider failures"
        try:
            stream = await client.responses.create(
                model=normalized_model,
                input=cast(object, provider_input),
                tools=cast(object, [_openai_tool(tool) for tool in tools]),
                reasoning=cast(object, {"effort": reasoning_effort}),
                max_output_tokens=max_output_tokens,
                timeout=openai_silence_limit_seconds(thinking_level),
                stream=True,
                store=False,
                include=cast(object, ["reasoning.encrypted_content"]),
            )
            async for event in stream:  # shockharness: ignore[EXC003] reason="each pull from OpenAI's stream is the external operation; the body forwards and accounts for the event"
                if not has_provider_started:
                    # OpenAI's first signal: the request was received (the chat stops showing "Waiting").
                    has_provider_started = True
                    yield {"type": "provider_started"}
                record_provider_chunk(event)
                if event.type == "response.output_text.delta":
                    if event.delta != "":
                        yield {"type": "content_delta", "text": event.delta}
                elif event.type == "response.output_item.done":
                    item = event.item.model_dump(mode="json")
                    if item["type"] == "function_call":
                        tool_calls.append({"id": item["call_id"], "name": item["name"], "arguments": item["arguments"]})
                    elif item["type"] == "reasoning":
                        # Output-only fields (status, content) are rejected as input.
                        reasoning_items.append({key: item[key] for key in _REASONING_INPUT_FIELDS if key in item})
                elif event.type in {"response.completed", "response.incomplete"}:
                    usage = _responses_usage(event.response.usage.model_dump(mode="json"))
                    self._cost_tracker.record(model=normalized_model, usage=usage)
                    if event.type == "response.incomplete":
                        reason = event.response.incomplete_details.reason
                        if reason == "max_output_tokens":
                            raise OpenAIProviderError(
                                "OpenAI reached the maximum output-token limit before finishing the response"
                            )
                        raise OpenAIProviderError(f"OpenAI left the response incomplete: {reason}")
                    finish_reason = "stop"
                    if tool_calls:
                        finish_reason = "tool_calls"
                    for call in tool_calls:
                        yield {"type": "tool_call", **call}
                    done: dict[str, object] = {"type": "done", "finish_reason": finish_reason, "usage": usage.as_inference_usage()}
                    if reasoning_items:
                        done["provider_state"] = {"provider": _OPENAI_PROVIDER_STATE, "items": reasoning_items}
                    yield done
                    did_finish = True
                elif event.type in {"response.failed", "error"}:
                    raise OpenAIProviderError(f"OpenAI reported a failed response ({event.type})")
        # lint: allow-PY001 rationale="a request OpenAI never answers is a network failure, explained plainly"
        except APITimeoutError as exc:
            raise OpenAIProviderError(openai_silence_message(openai_silence_limit_seconds(thinking_level))) from exc
        # lint: allow-PY001 rationale="translate external OpenAI stream failures into the provider-neutral contract"
        except APIError as exc:
            raise OpenAIProviderError(_provider_error_message(exc)) from exc
        finally:
            await client.close()
        if not did_finish:
            raise OpenAIProviderError("OpenAI response stream ended before completion")
