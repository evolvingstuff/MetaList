"""Structured AI steps ask OpenAI for strict structured outputs.

Without `strict: true` OpenAI treats the response schema as a hint: a summary
step once left out the required `supporting_note_ids` and wrote the IDs into
the text instead, and the step failed. With it, every required field is
guaranteed. The real Instructor request path is exercised here; only the
network is faked.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import instructor
import pytest
from openai import AsyncOpenAI

import app.services.agent.openai_inference  # noqa: F401  (registers the strict handler, as in production)
from app.services.agent.judging import OutputJudgment
from app.services.agent.staged_summary import SummaryBatchResult
from app.services.agent.staged_summary import SummaryFindingsResult
from app.services.agent.strict_structured_outputs import strict_openai_schema
from app.services.agent.tagging import TagBatchResult


_STREAMED_EMPTY_FINDINGS = (
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-5.6-luna",'
    '"choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"findings\\":[]}"},"finish_reason":"stop"}]}\n\n'
    "data: [DONE]\n\n"
)


def _sent_response_format(response_model: type) -> dict[str, object]:
    sent: dict[str, object] = {}

    def respond(request: httpx.Request) -> httpx.Response:
        sent["body"] = json.loads(request.content)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=_STREAMED_EMPTY_FINDINGS)

    openai_client = AsyncOpenAI(
        api_key="test-key",
        base_url="https://api.openai.com/v1",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
        max_retries=0,
    )
    client = instructor.from_openai(openai_client, model="gpt-5.6-luna", mode=instructor.Mode.JSON_SCHEMA)

    async def consume() -> None:
        stream = client.create_partial(
            response_model=response_model, messages=[{"role": "user", "content": "Summarize."}], max_retries=0,
        )
        async for _partial in stream:
            pass

    if response_model is SummaryFindingsResult:
        asyncio.run(consume())
    else:
        # Only the request matters here; the canned reply fits SummaryFindingsResult.
        with pytest.raises(Exception):
            asyncio.run(consume())
    body = sent["body"]
    assert isinstance(body, dict)
    response_format = body["response_format"]
    assert isinstance(response_format, dict)
    return response_format


def _keywords(schema: object) -> set[str]:
    found: set[str] = set()
    if isinstance(schema, dict):
        for key, value in schema.items():
            if key in ("properties", "$defs"):
                assert isinstance(value, dict)
                for nested in value.values():
                    found |= _keywords(nested)
                continue
            found.add(key)
            found |= _keywords(value)
    elif isinstance(schema, list):
        for item in schema:
            found |= _keywords(item)
    return found


@pytest.mark.parametrize("response_model", [SummaryFindingsResult, SummaryBatchResult, TagBatchResult, OutputJudgment])
def test_every_structured_step_is_sent_as_a_strict_schema(response_model: type) -> None:
    response_format = _sent_response_format(response_model)
    assert response_format["type"] == "json_schema"
    json_schema = response_format["json_schema"]
    assert isinstance(json_schema, dict)
    assert json_schema["strict"] is True
    # String length limits are checked locally after the reply (Pydantic), not sent.
    assert not {"minLength", "maxLength"} & _keywords(json_schema["schema"])


def test_the_summary_schema_still_requires_the_supporting_note_ids() -> None:
    schema = _sent_response_format(SummaryFindingsResult)["json_schema"]["schema"]
    finding = next(definition for name, definition in schema["$defs"].items() if name.endswith("SummaryFinding"))
    assert finding["required"] == ["text", "supporting_note_ids"]
    assert finding["properties"]["supporting_note_ids"]["minItems"] == 1
    assert finding["additionalProperties"] is False


def test_a_schema_that_strict_mode_cannot_express_fails_loudly() -> None:
    optional_field = {
        "type": "object", "additionalProperties": False,
        "properties": {"text": {"type": "string"}, "note": {"type": "string"}},
        "required": ["text"],
    }
    with pytest.raises(ValueError, match="every property required"):
        strict_openai_schema(optional_field)
    open_object = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}
    with pytest.raises(ValueError, match="additionalProperties"):
        strict_openai_schema(open_object)
