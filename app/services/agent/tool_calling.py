"""Provider-neutral tool calling: tool definitions and the tool conversation.

The agent loop talks to every provider in these shapes; each inference adapter
translates them to and from its own API (OpenAI today, possibly Claude later).

Conversation messages are plain dicts so traces and history exports stay JSON:

- ``{"role": "system" | "user", "content": str}``
- ``{"role": "assistant", "content": str}`` or, when the model called tools,
  ``{"role": "assistant", "content": str, "tool_calls": [ToolCall dicts]}``
- ``{"role": "tool", "tool_call_id": str, "name": str, "content": str}`` — the
  result of one tool call, answering the assistant message that requested it.

A tool call dict is ``{"id": str, "name": str, "arguments": str}`` where
``arguments`` is the JSON text the model produced.

An assistant message may also carry ``"provider_state": {"provider": str,
"items": [...]}``: opaque data only the provider that produced it reads, such as
OpenAI's encrypted reasoning items (or Claude's thinking blocks), handed back so
a thinking model keeps its train of thought across tool calls.

Tool arguments are Pydantic models whose fields are all required and independent
of each other: no field's validity may depend on another field, so the schema
alone describes every valid call (see docs/design/agent-harness.md).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from pydantic import BaseModel

from app.services.agent.token_estimation import PER_MESSAGE_OVERHEAD_TOKENS, REPLY_PRIMING_TOKENS, estimate_text_tokens


_TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_PLAIN_ROLES = frozenset({"system", "user"})
# Chat framing: the reply is primed with a few tokens, and each message and tool call adds its own.
_PER_TOOL_CALL_OVERHEAD_TOKENS = 3


@dataclass(frozen=True, slots=True)
class AgentTool:
    name: str
    description: str
    arguments_model: type[BaseModel]

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or _TOOL_NAME_RE.fullmatch(self.name) is None:
            raise ValueError(f"Tool name must be lowercase snake_case: {self.name!r}")
        if not isinstance(self.description, str) or self.description.strip() == "":
            raise ValueError(f"Tool {self.name} needs a description")
        if not isinstance(self.arguments_model, type) or not issubclass(self.arguments_model, BaseModel):
            raise TypeError(f"Tool {self.name} arguments must be a Pydantic model")
        schema = self.arguments_model.model_json_schema()
        properties: dict[str, object] = {}
        if "properties" in schema:
            properties = schema["properties"]
        required: list[str] = []
        if "required" in schema:
            required = schema["required"]
        if sorted(properties) != sorted(required):
            raise ValueError(f"Every argument of tool {self.name} must be required")

    def arguments_schema(self) -> dict[str, object]:
        return self.arguments_model.model_json_schema()


def validate_tool_conversation(messages: list[dict[str, object]]) -> None:
    """Fail fast on a malformed conversation before it reaches a provider."""
    if not isinstance(messages, list) or not messages:
        raise ValueError("A tool conversation needs at least one message")
    pending_call_ids: set[str] = set()
    for message in messages:
        if not isinstance(message, dict) or "role" not in message:
            raise TypeError("Each tool conversation message must be an object with a role")
        role = message["role"]
        if role in _PLAIN_ROLES:
            _require_keys(message, {"role", "content"})
            _require_text(message["content"], f"{role} content")
        elif role == "assistant":
            extra_keys = set(message) - {"role", "content"}
            if not extra_keys <= {"tool_calls", "provider_state"} or "content" not in message:
                raise ValueError(f"Unexpected assistant message keys: {sorted(message)}")
            _require_text(message["content"], "assistant content")
            if "provider_state" in message:
                _validate_provider_state(message["provider_state"])
            if "tool_calls" in message:
                calls = message["tool_calls"]
                if not isinstance(calls, list) or not calls:
                    raise ValueError("Assistant tool_calls must be a non-empty list")
                for call in calls:
                    _validate_tool_call(call)
                    pending_call_ids.add(call["id"])
        elif role == "tool":
            _require_keys(message, {"role", "tool_call_id", "name", "content"})
            _require_text(message["content"], "tool result content")
            if message["tool_call_id"] not in pending_call_ids:
                raise ValueError(f"Tool result answers no pending tool call: {message['tool_call_id']}")
            pending_call_ids.discard(message["tool_call_id"])
        else:
            raise ValueError(f"Unknown tool conversation role: {role!r}")


def estimate_tool_conversation_tokens(messages: list[dict[str, object]]) -> int:
    """Approximate input tokens of a tool conversation (messages only, not tool schemas)."""
    validate_tool_conversation(messages)
    estimate = REPLY_PRIMING_TOKENS
    for message in messages:
        estimate += PER_MESSAGE_OVERHEAD_TOKENS + estimate_text_tokens(message["role"])
        estimate += estimate_text_tokens(message["content"])
        if "tool_calls" in message:
            for call in message["tool_calls"]:
                estimate += _PER_TOOL_CALL_OVERHEAD_TOKENS + estimate_text_tokens(call["name"]) + estimate_text_tokens(call["arguments"])
        if message["role"] == "tool":
            estimate += estimate_text_tokens(message["name"])
    return estimate


def _validate_provider_state(state: object) -> None:
    if not isinstance(state, dict):
        raise TypeError("provider_state must be an object")
    _require_keys(state, {"provider", "items"})
    if not isinstance(state["provider"], str) or state["provider"] == "":
        raise ValueError("provider_state needs the provider that produced it")
    if not isinstance(state["items"], list) or not all(isinstance(item, dict) for item in state["items"]):
        raise TypeError("provider_state items must be a list of objects")


def _validate_tool_call(call: object) -> None:
    if not isinstance(call, dict):
        raise TypeError("A tool call must be an object")
    _require_keys(call, {"id", "name", "arguments"})
    for field_name in ("id", "name"):
        if not isinstance(call[field_name], str) or call[field_name] == "":
            raise ValueError(f"A tool call needs a non-empty {field_name}")
    if not isinstance(call["arguments"], str):
        raise TypeError("Tool call arguments must be JSON text")


def _require_keys(message: dict[str, object], keys: set[str]) -> None:
    if set(message) != keys:
        raise ValueError(f"Expected exactly {sorted(keys)}, got {sorted(message)}")


def _require_text(value: object, label: str) -> None:
    if not isinstance(value, str):
        raise TypeError(f"{label} must be text")
