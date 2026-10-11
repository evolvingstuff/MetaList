"""OpenAI requests give up after a silence limit instead of the library's 10 minutes.

A request that gets no reply (a network change, a dead connection) used to wait
up to 600 seconds before failing. Measured on Luna at Low thinking, OpenAI's
first signal arrives in 0.7-2 s and gaps while streaming are under 0.4 s, even
with a 180,000-token input, so Off and Low use 15 s. Medium and High may think
silently for longer before the first word; their limits are generous and not
measured.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from openai import APITimeoutError

import app.services.agent.openai_inference as openai_inference_module
from app.services.agent.inference import InferenceProviderError
from app.services.agent.openai_cost_tracking import OpenAICostTracker
from app.services.agent.openai_inference import OPENAI_API_BASE_URL
from app.services.agent.openai_inference import OpenAIInferenceAdapter
from app.services.agent.openai_inference import openai_silence_limit_seconds
from tests.unit.test_openai_inference import _API_KEY, _SEARCH_TOOL


def test_the_silence_limit_follows_the_thinking_level() -> None:
    assert openai_silence_limit_seconds("off") == 15.0
    assert openai_silence_limit_seconds("low") == 15.0
    assert openai_silence_limit_seconds("medium") == 60.0
    assert openai_silence_limit_seconds("high") == 120.0
    with pytest.raises(ValueError):
        openai_silence_limit_seconds("extreme")


def _fake_client(monkeypatch, *, attribute: str, behaviour) -> dict[str, object]:
    created: dict[str, object] = {}

    class FakeEndpoint:
        def __init__(self, http_client):
            self._http_client = http_client

        async def create(self, **kwargs):
            created.update(kwargs)
            request = httpx.Request("POST", "https://api.openai.com/v1/x", json={k: v for k, v in kwargs.items() if k != "timeout"})
            for hook in self._http_client.event_hooks["request"]:
                await hook(request)
            return await behaviour(request)

    class FakeChat:
        def __init__(self, http_client):
            self.completions = FakeEndpoint(http_client)

    class FakeOpenAIClient:
        def __init__(self, *, api_key, base_url, http_client, max_retries) -> None:
            self._http_client = http_client
            if attribute == "responses":
                self.responses = FakeEndpoint(http_client)
            else:
                self.chat = FakeChat(http_client)

        async def close(self) -> None:
            await self._http_client.aclose()

    monkeypatch.setattr(openai_inference_module, "AsyncOpenAI", FakeOpenAIClient)
    return created


async def _silent(request: httpx.Request):
    raise APITimeoutError(request=request)


def _tool_turn(thinking_level: str) -> list[dict[str, object]]:
    adapter = OpenAIInferenceAdapter(api_key=_API_KEY, cost_tracker=OpenAICostTracker())

    async def collect():
        return [event async for event in adapter.stream_tool_turn(
            base_url=OPENAI_API_BASE_URL, model="gpt-5.6-luna", thinking_level=thinking_level,
            messages=[{"role": "user", "content": "What's new in MetaList?"}], tools=(_SEARCH_TOOL,),
            max_output_tokens=8_192, on_request=lambda request: None,
        )]

    return asyncio.run(collect())


def _text_stream(thinking_level: str) -> list[dict[str, object]]:
    adapter = OpenAIInferenceAdapter(api_key=_API_KEY, cost_tracker=OpenAICostTracker())

    async def collect():
        return [event async for event in adapter.stream_text(
            base_url=OPENAI_API_BASE_URL, model="gpt-5.6-luna", thinking_level=thinking_level,
            messages=[{"role": "user", "content": "Summarize."}], max_output_tokens=8_192,
            on_request=lambda request: None,
        )]

    return asyncio.run(collect())


@pytest.mark.parametrize(("thinking_level", "seconds"), [("low", 15), ("high", 120)])
def test_an_agent_turn_that_gets_no_reply_fails_with_a_clear_message(monkeypatch, thinking_level, seconds) -> None:
    created = _fake_client(monkeypatch, attribute="responses", behaviour=_silent)

    with pytest.raises(InferenceProviderError) as failure:
        _tool_turn(thinking_level)

    assert created["timeout"] == float(seconds)
    assert str(failure.value) == (
        f"OpenAI did not respond for {seconds} seconds. "
        "Check your internet connection and ask again."
    )


def test_a_streamed_answer_that_gets_no_reply_fails_with_a_clear_message(monkeypatch) -> None:
    created = _fake_client(monkeypatch, attribute="chat", behaviour=_silent)

    with pytest.raises(InferenceProviderError, match="OpenAI did not respond for 15 seconds"):
        _text_stream("off")

    assert created["timeout"] == 15.0
