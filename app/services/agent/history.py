"""Capture inference calls in the owning session without changing model behavior."""

from __future__ import annotations

import asyncio
import time
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from functools import wraps
from uuid import uuid4

from app.utils.time_units import MS_PER_SECOND

_SINK: ContextVar[tuple] = ContextVar("agent_history_sink", default=())
_CALL: ContextVar[tuple] = ContextVar("agent_history_call", default=())


@contextmanager
def record_history(store, *, session_key: str, run_id: str):
    token = _SINK.set((store, session_key, run_id))
    try:
        yield
    finally:
        _SINK.reset(token)


def record_provider_event(kind: str, detail: dict) -> None:
    """Record only allowlisted provider bodies, never headers or credentials."""
    if not _SINK.get() or not _CALL.get():
        return
    store, session_key, run_id = _SINK.get()
    call_id, started_at = _CALL.get()
    store.append_event(
        session_key=session_key, run_id=run_id,
        event_type=kind, label=kind.replace("_", " ").title(),
        detail={"call_id": call_id, **detail},
        duration_ms=(time.perf_counter() - started_at) * MS_PER_SECOND,
    )


def record_provider_chunk(chunk) -> None:
    if _SINK.get():
        record_provider_event("LLM_RAW_CHUNK", chunk.model_dump(mode="json"))


@contextmanager
def _call(kind: str, arguments: dict):
    call_id = str(uuid4())
    token = _CALL.set((call_id, time.perf_counter()))
    response_model = None
    if kind == "structured":
        response_model = arguments["response_model"]
    request = {
        "kind": kind,
        "model": arguments["model"],
        "thinking_level": arguments["thinking_level"],
        "messages": deepcopy(arguments["messages"]),
        "response_model": response_model.__name__ if response_model else "",
        "response_schema": response_model.model_json_schema() if response_model else {},
        "max_output_tokens": arguments["max_output_tokens"] if kind in {"text", "tool"} else 0,
        "tools": [
            {"name": tool.name, "description": tool.description, "schema": tool.arguments_schema()}
            for tool in arguments["tools"]
        ] if kind == "tool" else [],
    }
    record_provider_event("LLM_CALL_STARTED", request)
    # lint: allow-PY001 rationale="record inference failure or cancellation and immediately re-raise"
    try:
        yield  # shockharness: ignore[EXC003] reason="the yield is the recorded inference call itself: the with-block's body"
    # lint: allow-PY001 rationale="preserve cancellation while recording the interrupted call"
    except (asyncio.CancelledError, GeneratorExit):
        record_provider_event("LLM_CALL_FINISHED", {"status": "cancelled", "error": "Interrupted"})
        raise
    # lint: allow-PY001 rationale="record internal and external errors without suppressing either"
    except Exception as exc:
        record_provider_event("LLM_CALL_FINISHED", {
            "status": "error", "error": f"{type(exc).__name__}: {exc}",
        })
        raise
    else:
        record_provider_event("LLM_CALL_FINISHED", {"status": "complete", "error": ""})
    finally:
        _CALL.reset(token)


def record_structured_call(function):
    @wraps(function)
    async def recorded(self, **arguments):
        with _call("structured", arguments):
            response = await function(self, **arguments)
            record_provider_event("LLM_CALL_OUTPUT", {
                "content": response.content, "thinking": response.thinking,
                "usage": response.usage,
            })
            return response
    return recorded


def record_tool_turn(function):
    @wraps(function)
    async def recorded(self, **arguments):
        with _call("tool", arguments):
            stream = function(self, **arguments)
            try:
                async for event in stream:
                    record_provider_event("LLM_STREAM_EVENT", event)
                    yield event
            finally:
                await stream.aclose()
    return recorded


def record_text_call(function):
    @wraps(function)
    async def recorded(self, **arguments):
        with _call("text", arguments):
            stream = function(self, **arguments)
            try:
                async for event in stream:
                    record_provider_event("LLM_STREAM_EVENT", event)
                    yield event
            finally:
                await stream.aclose()
    return recorded
