"""Instructor for typed Ollama output; direct Ollama for streamed prose."""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from collections.abc import Callable
from dataclasses import dataclass
from typing import cast

import httpx
import instructor
from openai import AsyncOpenAI
from pydantic import BaseModel
from pydantic import ValidationError

from instructor.v2.core.client import AsyncInstructor
from instructor.v2.core.errors import InstructorRetryException

from app.services.agent.actions import AgentRouteEnvelope
from app.services.agent.actions import ScopedRouteEnvelope
from app.services.agent.actions import SearchQueryEnvelope
from app.services.agent.tagging import TagBatchResult, TagOperationIntent
from app.services.agent.inference import InferenceAttempt
from app.services.agent.inference import InferenceContextWindow
from app.services.agent.inference import InferenceResponse
from app.services.agent.inference import MINIMUM_AGENT_CONTEXT_TOKENS
from app.services.agent.inference import StructuredInferenceProgress
from app.services.agent.inference import StructuredInferenceError
from app.services.agent.inference import TARGET_AGENT_CONTEXT_TOKENS
from app.services.agent.token_estimation import estimate_text_tokens
from app.services.ollama_provider import OllamaProvider
from app.services.ollama_provider import normalize_ollama_base_url
from app.services.ollama_provider import resolve_ollama_think_value


_STRUCTURED_MAX_RETRIES = 1
_STRUCTURED_TIMEOUT_SECONDS = 300.0
_ROUTE_MAX_OUTPUT_TOKENS = 512
_SEARCH_QUERY_MAX_OUTPUT_TOKENS = 1_024


def _structured_max_output_tokens(response_model: type[BaseModel]) -> int:
    limits = {
        TagBatchResult: 8_192,
        TagOperationIntent: 1_024,
        AgentRouteEnvelope: _ROUTE_MAX_OUTPUT_TOKENS,
        ScopedRouteEnvelope: _ROUTE_MAX_OUTPUT_TOKENS,
        SearchQueryEnvelope: _SEARCH_QUERY_MAX_OUTPUT_TOKENS,
    }
    if response_model not in limits:
        raise RuntimeError(
            f"Structured output limit missing for {response_model.__name__}"
        )
    return limits[response_model]


@dataclass(slots=True)
class _PendingAttempt:
    request: dict[str, object]
    wire_request: dict[str, object]
    response: dict[str, object]
    error: str
    started_at: float
    duration_ms: float
    output_tokens_received: int
    output_text: str
    reasoning_text: str
    response_metadata: dict[str, object]
    last_reported_output_tokens: int


class _InstructorTraceCapture:
    def __init__(
        self,
        *,
        on_progress: Callable[[StructuredInferenceProgress], None],
    ) -> None:
        self._attempts: list[_PendingAttempt] = []
        self._on_progress = on_progress

    def record_request(self, **kwargs: object) -> None:
        self._attempts.append(
            _PendingAttempt(
                request=_json_object(kwargs),
                wire_request={},
                response={},
                error="",
                started_at=time.perf_counter(),
                duration_ms=0.0,
                output_tokens_received=0,
                output_text="",
                reasoning_text="",
                response_metadata={},
                last_reported_output_tokens=0,
            )
        )

    async def record_wire_request(self, request: httpx.Request) -> None:
        attempt = self._current_attempt()
        if attempt.wire_request:
            raise RuntimeError("Instructor emitted multiple HTTP requests for one attempt")
        raw_body = await request.aread()
        body = json.loads(raw_body)
        if not isinstance(body, dict):
            raise TypeError("Instructor wire request body must be an object")
        attempt.wire_request = {
            "method": request.method,
            "url": str(request.url),
            "body": body,
        }
        self._emit_progress(
            phase="attempt_started",
            failure_kind="",
            error_type="",
            error_message="",
        )

    def record_response(self, response: object) -> None:
        attempt = self._current_attempt()
        if not attempt.wire_request:
            raise RuntimeError("Instructor response arrived before its HTTP request")
        stream_iterator = getattr(response, "_iterator", None)
        if stream_iterator is not None:
            if not hasattr(stream_iterator, "__aiter__"):
                raise TypeError("Instructor streaming response iterator must be asynchronous")
            setattr(response, "_iterator", self._capture_stream(stream_iterator))
            return
        attempt.response = _json_object(response)
        attempt.duration_ms = (time.perf_counter() - attempt.started_at) * 1_000
        attempt.output_tokens_received = self._response_output_tokens(attempt.response)
        self._emit_progress(
            phase="response_received",
            failure_kind="",
            error_type="",
            error_message="",
        )

    async def _capture_stream(
        self,
        stream_iterator: AsyncIterator[object],
    ) -> AsyncIterator[object]:
        attempt = self._current_attempt()
        async for chunk in stream_iterator:
            self._capture_chunk(attempt=attempt, chunk=_json_object(chunk))
            yield chunk
        attempt.response = self._assembled_stream_response(attempt)
        attempt.duration_ms = (time.perf_counter() - attempt.started_at) * 1_000
        if attempt.output_tokens_received > attempt.last_reported_output_tokens:
            attempt.last_reported_output_tokens = attempt.output_tokens_received
            self._emit_progress(
                phase="output_progress",
                failure_kind="",
                error_type="",
                error_message="",
            )
        self._emit_progress(
            phase="response_received",
            failure_kind="",
            error_type="",
            error_message="",
        )

    def _capture_chunk(
        self,
        *,
        attempt: _PendingAttempt,
        chunk: dict[str, object],
    ) -> None:
        for metadata_field in ("id", "model", "created", "usage"):
            if metadata_field in chunk and chunk[metadata_field] is not None:
                attempt.response_metadata[metadata_field] = chunk[metadata_field]
        choices: object = []
        if "choices" in chunk:
            choices = chunk["choices"]
        if not isinstance(choices, list):
            raise TypeError("Instructor stream choices must be a list")
        if len(choices) > 0:
            first_choice = choices[0]
            if not isinstance(first_choice, dict):
                raise TypeError("Instructor stream choice must be an object")
            if "finish_reason" in first_choice and first_choice["finish_reason"] is not None:
                attempt.response_metadata["finish_reason"] = first_choice["finish_reason"]
            delta: object = {}
            if "delta" in first_choice:
                delta = first_choice["delta"]
            if not isinstance(delta, dict):
                raise TypeError("Instructor stream delta must be an object")
            content: object = ""
            if "content" in delta:
                content = delta["content"]
            if content is not None and not isinstance(content, str):
                raise TypeError("Instructor stream content delta must be text")
            if isinstance(content, str):
                attempt.output_text += content
            for field_name in ("reasoning", "reasoning_content", "thinking"):
                reasoning: object = ""
                if field_name in delta:
                    reasoning = delta[field_name]
                if reasoning is not None and not isinstance(reasoning, str):
                    raise TypeError("Instructor stream reasoning delta must be text")
                if isinstance(reasoning, str):
                    attempt.reasoning_text += reasoning
        generated_text = f"{attempt.reasoning_text}{attempt.output_text}"
        attempt.output_tokens_received = 0
        if generated_text != "":
            attempt.output_tokens_received = estimate_text_tokens(generated_text)
        if attempt.output_tokens_received >= attempt.last_reported_output_tokens + 8:
            attempt.last_reported_output_tokens = attempt.output_tokens_received
            self._emit_progress(
                phase="output_progress",
                failure_kind="",
                error_type="",
                error_message="",
            )

    @staticmethod
    def _assembled_stream_response(attempt: _PendingAttempt) -> dict[str, object]:
        message: dict[str, object] = {
            "role": "assistant",
            "content": attempt.output_text,
        }
        if attempt.reasoning_text != "":
            message["reasoning"] = attempt.reasoning_text
        choice: dict[str, object] = {"message": message}
        if "finish_reason" in attempt.response_metadata:
            choice["finish_reason"] = attempt.response_metadata["finish_reason"]
        response = {
            key: value
            for key, value in attempt.response_metadata.items()
            if key != "finish_reason"
        }
        response["choices"] = [choice]
        return response

    @staticmethod
    def _response_output_tokens(response: dict[str, object]) -> int:
        usage = _extract_usage(response)
        if "completion_tokens" in usage:
            return usage["completion_tokens"]
        choices: object = []
        if "choices" in response:
            choices = response["choices"]
        if not isinstance(choices, list) or len(choices) == 0:
            return 0
        first_choice = choices[0]
        if not isinstance(first_choice, dict):
            raise TypeError("Instructor completion choice must be an object")
        message: object = {}
        if "message" in first_choice:
            message = first_choice["message"]
        if not isinstance(message, dict):
            raise TypeError("Instructor completion message must be an object")
        generated_text = ""
        for field_name in ("reasoning", "reasoning_content", "thinking", "content"):
            value: object = ""
            if field_name in message:
                value = message[field_name]
            if value is not None and not isinstance(value, str):
                raise TypeError("Instructor completion generated text must be a string")
            if isinstance(value, str):
                generated_text += value
        if generated_text == "":
            return 0
        return estimate_text_tokens(generated_text)

    def record_completion_error(self, error: Exception, **metadata: object) -> None:
        del metadata
        self._record_error(error=error, failure_kind="Ollama request failed")

    def record_parse_error(self, error: Exception, **metadata: object) -> None:
        del metadata
        self._record_error(error=error, failure_kind="Structured output invalid")

    def record_success(self) -> None:
        attempt = self._current_attempt()
        if not attempt.wire_request:
            raise RuntimeError("Instructor success arrived before its HTTP request")
        if attempt.error != "":
            raise RuntimeError("Instructor reported success after an attempt error")
        self._emit_progress(
            phase="attempt_succeeded",
            failure_kind="",
            error_type="",
            error_message="",
        )

    def _record_error(self, *, error: Exception, failure_kind: str) -> None:
        attempt = self._current_attempt()
        error_type = type(error).__name__
        error_message = str(error)
        formatted_error = f"{error_type}: {error_message}"
        if attempt.error == formatted_error:
            return
        attempt.error = formatted_error
        attempt.duration_ms = (time.perf_counter() - attempt.started_at) * 1_000
        attempt_number = len(self._attempts)
        phase = "retrying"
        if attempt_number == self.max_attempts:
            phase = "attempt_failed"
        self._emit_progress(
            phase=phase,
            failure_kind=failure_kind,
            error_type=error_type,
            error_message=error_message,
        )

    def freeze(self) -> list[InferenceAttempt]:
        return [
            InferenceAttempt(
                request=attempt.request,
                response=attempt.response,
                error=attempt.error,
                duration_ms=attempt.duration_ms,
            )
            for attempt in self._attempts
        ]

    def current_response(self) -> dict[str, object]:
        response = self._current_attempt().response
        if not response:
            raise RuntimeError("Instructor attempt has no captured response")
        return dict(response)

    def has_current_response(self) -> bool:
        return bool(self._current_attempt().response)

    def _current_attempt(self) -> _PendingAttempt:
        if not self._attempts:
            raise RuntimeError("Instructor emitted an event before a request")
        return self._attempts[-1]

    @property
    def max_attempts(self) -> int:
        return _STRUCTURED_MAX_RETRIES + 1

    def _emit_progress(
        self,
        *,
        phase: str,
        failure_kind: str,
        error_type: str,
        error_message: str,
    ) -> None:
        attempt = self._current_attempt()
        if not attempt.wire_request:
            raise RuntimeError("Instructor progress has no HTTP wire request")
        self._on_progress(
            StructuredInferenceProgress(
                phase=phase,
                attempt=len(self._attempts),
                max_attempts=self.max_attempts,
                failure_kind=failure_kind,
                error_type=error_type,
                error_message=error_message,
                duration_ms=attempt.duration_ms,
                wire_request=dict(attempt.wire_request),
                output_tokens_received=attempt.output_tokens_received,
            )
        )


def _json_value(value: object) -> object:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, BaseModel):
        return _json_value(value.model_dump(mode="json"))
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return _json_value(model_dump(mode="json"))
    if isinstance(value, dict):
        converted: dict[str, object] = {}
        for key, nested_value in value.items():
            if not isinstance(key, str):
                raise TypeError("Instructor trace object keys must be strings")
            converted[key] = _json_value(nested_value)
        return converted
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    raise TypeError(f"Instructor trace value is not JSON-compatible: {type(value)}")


def _json_object(value: object) -> dict[str, object]:
    converted = _json_value(value)
    if not isinstance(converted, dict):
        raise TypeError("Instructor trace payload must be an object")
    return converted


def _extract_usage(raw_response: dict[str, object]) -> dict[str, int]:
    if "usage" not in raw_response:
        return {}
    raw_usage = raw_response["usage"]
    if not isinstance(raw_usage, dict):
        raise TypeError("Instructor completion usage must be an object")
    usage: dict[str, int] = {}
    for field_name in ("prompt_tokens", "completion_tokens", "total_tokens"):
        if field_name not in raw_usage:
            continue
        value = raw_usage[field_name]
        if not isinstance(value, int) or value < 0:
            raise TypeError(f"Instructor completion {field_name} must be a non-negative integer")
        usage[field_name] = value
    return usage


def _extract_reasoning(raw_response: dict[str, object]) -> str:
    choices: object = []
    if "choices" in raw_response:
        choices = raw_response["choices"]
    if not isinstance(choices, list) or len(choices) == 0:
        return ""
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        raise TypeError("Instructor completion choice must be an object")
    message: object = {}
    if "message" in first_choice:
        message = first_choice["message"]
    if not isinstance(message, dict):
        raise TypeError("Instructor completion message must be an object")
    for field_name in ("reasoning", "reasoning_content", "thinking"):
        value: object = ""
        if field_name in message:
            value = message[field_name]
        if value != "":
            if not isinstance(value, str):
                raise TypeError("Instructor completion reasoning must be a string")
            return value
    return ""


def _extract_content(raw_response: dict[str, object]) -> str:
    choices: object = []
    if "choices" in raw_response:
        choices = raw_response["choices"]
    if not isinstance(choices, list) or len(choices) == 0:
        raise ValueError("Instructor completion omitted choices")
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        raise TypeError("Instructor completion choice must be an object")
    message: object = {}
    if "message" in first_choice:
        message = first_choice["message"]
    if not isinstance(message, dict):
        raise TypeError("Instructor completion message must be an object")
    content: object = ""
    if "content" in message:
        content = message["content"]
    if not isinstance(content, str) or content == "":
        raise ValueError("Instructor completion content must be non-empty")
    return content


def _response_finish_reason(raw_response: dict[str, object]) -> str:
    if not isinstance(raw_response, dict):
        raise TypeError("Raw response must be an object")
    choices = raw_response["choices"]
    if not isinstance(choices, list) or len(choices) == 0:
        raise ValueError("Raw response choices must be a non-empty list")
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        raise TypeError("Raw response choice must be an object")
    finish_reason = first_choice["finish_reason"]
    if not isinstance(finish_reason, str) or finish_reason == "":
        raise ValueError("Raw response finish reason must be non-empty")
    return finish_reason


def _create_instructor_client(
    *,
    base_url: str,
    model: str,
    capture: _InstructorTraceCapture,
) -> AsyncInstructor:
    normalized_base_url = normalize_ollama_base_url(base_url)
    http_client = httpx.AsyncClient(
        event_hooks={"request": [capture.record_wire_request]},
        follow_redirects=False,
        trust_env=False,
    )
    openai_client = AsyncOpenAI(
        api_key="ollama",
        base_url=f"{normalized_base_url}/v1",
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


def _attach_trace_capture(
    *,
    client: AsyncInstructor,
    capture: _InstructorTraceCapture,
) -> None:
    client.on("completion:kwargs", capture.record_request)
    client.on("completion:response", capture.record_response)
    client.on("completion:error", capture.record_completion_error)
    client.on("parse:error", capture.record_parse_error)


async def _create_structured_completion(
    *,
    client: AsyncInstructor,
    capture: _InstructorTraceCapture,
    response_model: type[BaseModel],
    messages: list[dict[str, str]],
    request_options: dict[str, object],
) -> tuple[BaseModel, object]:
    try:
        return await _run_structured_attempt(
            client=client,
            capture=capture,
            response_model=response_model,
            original_messages=messages,
            attempt_messages=messages,
            request_options=request_options,
            attempt_number=1,
        )
    finally:
        await client.client.close()


async def _run_structured_attempt(
    *,
    client: AsyncInstructor,
    capture: _InstructorTraceCapture,
    response_model: type[BaseModel],
    original_messages: list[dict[str, str]],
    attempt_messages: list[dict[str, str]],
    request_options: dict[str, object],
    attempt_number: int,
) -> tuple[BaseModel, object]:
    last_partial: BaseModel | None = None
    # lint: allow-PY001 rationale="Ollama and model-produced structured JSON are external and receive one bounded retry"
    try:
        async for partial in client.create_partial(
            response_model=response_model,
            messages=attempt_messages,
            max_retries=0,
            timeout=_STRUCTURED_TIMEOUT_SECONDS,
            **request_options,
        ):
            last_partial = partial
        if last_partial is None:
            raise ValueError("Instructor stream returned no structured output")
        parsed = response_model.model_validate(
            last_partial.model_dump(exclude_none=True)
        )
        return parsed, capture.current_response()
    # lint: allow-PY001 rationale="retry one external Instructor stream after preserving its exact failed attempt"
    except InstructorRetryException as exc:
        if attempt_number == capture.max_attempts:
            raise StructuredInferenceError(attempts=capture.freeze()) from exc
        retry_messages = _structured_retry_messages(
            capture=capture,
            original_messages=original_messages,
            failure=exc,
        )
        return await _run_structured_attempt(
            client=client,
            capture=capture,
            response_model=response_model,
            original_messages=original_messages,
            attempt_messages=retry_messages,
            request_options=request_options,
            attempt_number=attempt_number + 1,
        )
    # lint: allow-PY001 rationale="retry one model-produced JSON validation failure through Instructor partial parsing"
    except (ValidationError, ValueError) as exc:
        capture.record_parse_error(exc)
        if attempt_number == capture.max_attempts:
            raise StructuredInferenceError(attempts=capture.freeze()) from exc
        retry_messages = _structured_retry_messages(
            capture=capture,
            original_messages=original_messages,
            failure=exc,
        )
        return await _run_structured_attempt(
            client=client,
            capture=capture,
            response_model=response_model,
            original_messages=original_messages,
            attempt_messages=retry_messages,
            request_options=request_options,
            attempt_number=attempt_number + 1,
        )


def _structured_retry_messages(
    *,
    capture: _InstructorTraceCapture,
    original_messages: list[dict[str, str]],
    failure: Exception,
) -> list[dict[str, str]]:
    if not capture.has_current_response():
        return list(original_messages)
    failed_response = capture.current_response()
    retry_instruction = (
        "The previous JSON failed schema validation. Correct it and return one "
        "complete, compact JSON object. Emit every required field and close the "
        "object well before the output limit. Do not repeat long source lists or "
        f"restate the request. Validation error: {failure}"
    )
    if _response_finish_reason(failed_response) == "length":
        return [
            *original_messages,
            {
                "role": "user",
                "content": (
                    "The previous response reached the output-token limit and was "
                    "discarded. Start over from the original evidence. Return one "
                    "complete compact JSON object, emit every required action field, "
                    "and close the object "
                    "well before the limit."
                ),
            },
        ]
    failed_content = _extract_content(failed_response)
    return [
        *original_messages,
        {"role": "assistant", "content": failed_content},
        {"role": "user", "content": retry_instruction},
    ]


class OllamaInferenceAdapter:
    def __init__(self, *, provider: OllamaProvider) -> None:
        self._provider = provider

    @property
    def provider_label(self) -> str:
        return "Ollama"

    async def inspect_context_window(
        self,
        *,
        base_url: str,
        model: str,
    ) -> InferenceContextWindow:
        model_context = await self._provider.inspect_model_context(
            base_url=base_url,
            model=model,
        )
        required_tokens = min(
            model_context.maximum_tokens,
            TARGET_AGENT_CONTEXT_TOKENS,
        )
        if model_context.maximum_tokens < MINIMUM_AGENT_CONTEXT_TOKENS:
            required_tokens = MINIMUM_AGENT_CONTEXT_TOKENS
        return InferenceContextWindow(
            model=model_context.model,
            maximum_tokens=model_context.maximum_tokens,
            loaded_tokens=model_context.loaded_tokens,
            required_tokens=required_tokens,
        )

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
        think_value = resolve_ollama_think_value(
            model=model,
            thinking_level=thinking_level,
        )
        capture = _InstructorTraceCapture(
            on_progress=on_progress,
        )
        client = _create_instructor_client(
            base_url=base_url,
            model=model,
            capture=capture,
        )
        _attach_trace_capture(client=client, capture=capture)
        parsed, raw_completion = await _create_structured_completion(
            client=client,
            capture=capture,
            response_model=response_model,
            messages=messages,
            request_options={
                "max_tokens": _structured_max_output_tokens(response_model),
                "temperature": 0,
                "extra_body": {"think": think_value},
            },
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
            usage=_extract_usage(raw_response),
            attempts=attempts,
        )

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
        async for event in self._provider.stream_chat(
            base_url=base_url,
            model=model,
            thinking_level=thinking_level,
            messages=messages,
            max_output_tokens=max_output_tokens,
            on_request=on_request,
        ):
            yield event
