"""The only calls that send messages to an AI provider.

Every message list MetaList sends to an AI passes through one of these functions, and
each requires its messages to carry `cloud_disclosable`: built only from what the cloud
privacy rules let the AI see (docs/security/cloud-privacy-boundary.md). ShockHarness
checks every caller against that (property contracts, .shockharness.toml); it can because
these are plain functions, while the adapter's own methods are called on an object passed
in, which it cannot resolve. tests/unit/test_ai_send.py fails when any other module calls
an adapter's send methods, or when one of these loses its requires, so no send is left
unchecked.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable

from pydantic import BaseModel

from app.contracts import requires
from app.services.agent.inference import InferenceAdapter
from app.services.agent.inference import InferenceResponse
from app.services.agent.inference import StructuredInferenceProgress
from app.services.agent.tool_calling import AgentTool


async def send_structured(
    inference: InferenceAdapter,
    *,
    base_url: str,
    model: str,
    thinking_level: str,
    messages: list[dict[str, str]],
    response_model: type[BaseModel],
    on_progress: Callable[[StructuredInferenceProgress], None],
) -> InferenceResponse:
    requires(messages, "cloud_disclosable")
    return await inference.infer_structured(
        base_url=base_url, model=model, thinking_level=thinking_level, messages=messages,
        response_model=response_model, on_progress=on_progress,
    )


def send_text_stream(
    inference: InferenceAdapter,
    *,
    base_url: str,
    model: str,
    thinking_level: str,
    messages: list[dict[str, str]],
    max_output_tokens: int,
    on_request: Callable[[dict[str, object]], None],
) -> AsyncIterator[dict[str, object]]:
    requires(messages, "cloud_disclosable")
    return inference.stream_text(
        base_url=base_url, model=model, thinking_level=thinking_level, messages=messages,
        max_output_tokens=max_output_tokens, on_request=on_request,
    )


def send_tool_turn(
    inference: InferenceAdapter,
    *,
    base_url: str,
    model: str,
    thinking_level: str,
    messages: list[dict[str, object]],
    tools: tuple[AgentTool, ...],
    max_output_tokens: int,
    on_request: Callable[[dict[str, object]], None],
) -> AsyncIterator[dict[str, object]]:
    requires(messages, "cloud_disclosable")
    return inference.stream_tool_turn(
        base_url=base_url, model=model, thinking_level=thinking_level, messages=messages,
        tools=tools, max_output_tokens=max_output_tokens, on_request=on_request,
    )
