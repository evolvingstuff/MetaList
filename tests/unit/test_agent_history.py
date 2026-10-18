import asyncio
import json

import httpx
import pytest
from fastapi import Response

import app.api.routes.ai as ai_routes
import app.services.agent.openai_inference as provider
from app.services.agent.staged_summary import SummaryFindingsResult
from app.services.agent.history import record_history
from app.services.agent.openai_cost_tracking import OpenAICostTracker
from app.services.agent.trace import AgentTraceStore


def install_transport(monkeypatch, handler):
    real_client = httpx.AsyncClient

    class Client(real_client):
        def __init__(self, **kwargs):
            super().__init__(**kwargs, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(provider.httpx, "AsyncClient", Client)
    return provider.OpenAIInferenceAdapter(api_key="sk-test-not-exported", cost_tracker=OpenAICostTracker())


def chunk(content, finish, usage):
    return {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
            "model": "gpt-5.6-luna", "choices": [{"index": 0,
            "delta": {"content": content}, "finish_reason": finish}], "usage": usage}


def response(chunks):
    text = "".join(f"data: {json.dumps(item)}\n\n" for item in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=text)


USAGE = {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}


def test_real_instructor_records_retry_pairs_and_preserves_all_turns(monkeypatch):
    requests = []

    def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        answer = {"findings": [{"text": "Hello", "supporting_note_ids": ["note-1"]}]}
        if len(requests) == 1:
            answer = {"findings": [{"text": "", "supporting_note_ids": []}]}
        return response([chunk(json.dumps(answer), None, None), chunk(None, "stop", USAGE)])

    adapter = install_transport(monkeypatch, handle)
    traces = AgentTraceStore()

    async def run():
        for turn in range(2):
            run_id = traces.start_run(session_key="a", model="gpt-5.6-luna", user_message="Hello")
            with record_history(traces, session_key="a", run_id=run_id):
                result = await adapter.infer_structured(
                    base_url=provider.OPENAI_API_BASE_URL, model="gpt-5.6-luna",
                    thinking_level="off", messages=[{"role": "user", "content": f"Hello {turn}"}],
                    response_model=SummaryFindingsResult, on_progress=lambda progress: None,
                )
                assert json.loads(result.content)["findings"][0]["text"] == "Hello"
            traces.complete_run(session_key="a", run_id=run_id)

    asyncio.run(run())
    pairs = traces.export_history(session_key="a")
    assert len(pairs) == 3
    assert [pair[0]["request"] for pair in pairs] == requests
    assert [pair[1]["status"] for pair in pairs] == ["error", "complete", "complete"]
    assert pairs[0][1]["response"]["choices"][0]["message"]["content"]
    assert pairs[0][0]["run_id"] != pairs[2][0]["run_id"]
    assert traces.export_history(session_key="b") == []
    assert "sk-test-not-exported" not in json.dumps(pairs)
    pairs[0][0]["request"].clear()
    assert traces.export_history(session_key="a")[0][0]["request"] == requests[0]
    traces.clear_trace(session_key="a")
    assert traces.export_history(session_key="a") == []


def test_text_partial_failure_and_running_export_are_preserved(monkeypatch):
    adapter = install_transport(monkeypatch, lambda request: response([
        chunk("partial answer", None, None), chunk(None, "length", None), chunk(None, None, USAGE),
    ]))
    traces = AgentTraceStore()
    run_id = traces.start_run(session_key="a", model="gpt-5.6-luna", user_message="Hi")

    async def run():
        with record_history(traces, session_key="a", run_id=run_id):
            with pytest.raises(provider.OpenAIProviderError):
                async for event in adapter.stream_text(
                    base_url=provider.OPENAI_API_BASE_URL, model="gpt-5.6-luna",
                    thinking_level="off", messages=[{"role": "user", "content": "Hi"}],
                    max_output_tokens=10, on_request=lambda request: None,
                ):
                    if event["type"] == "content_delta":
                        assert traces.export_history(session_key="a")[0][1]["status"] == "running"

    asyncio.run(run())
    output = traces.export_history(session_key="a")[0][1]
    assert output["status"] == "error"
    assert output["chunks"][0]["choices"][0]["delta"]["content"] == "partial answer"
    assert "output-token" in output["error"]


def test_cancelled_structured_stream_keeps_partial_response(monkeypatch):
    class InterruptedStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            partial_chunk = chunk('{"find', None, None)
            yield f'data: {json.dumps(partial_chunk)}\n\n'.encode()
            raise asyncio.CancelledError()

    adapter = install_transport(monkeypatch, lambda request: httpx.Response(
        200, headers={"content-type": "text/event-stream"}, stream=InterruptedStream(),
    ))
    traces = AgentTraceStore()
    run_id = traces.start_run(session_key="a", model="gpt-5.6-luna", user_message="Hi")

    async def run():
        with record_history(traces, session_key="a", run_id=run_id):
            with pytest.raises(asyncio.CancelledError):
                await adapter.infer_structured(
                    base_url=provider.OPENAI_API_BASE_URL, model="gpt-5.6-luna",
                    thinking_level="off", messages=[{"role": "user", "content": "Hi"}],
                    response_model=SummaryFindingsResult, on_progress=lambda progress: None,
                )

    asyncio.run(run())
    output = traces.export_history(session_key="a")[0][1]
    assert output["status"] == "cancelled"
    assert output["response"]["choices"][0]["message"]["content"] == '{"find'


def test_history_endpoint_uses_authenticated_session_and_no_cache(monkeypatch):
    traces = AgentTraceStore()
    monkeypatch.setattr(ai_routes, "agent_trace_store", traces)
    monkeypatch.setattr(ai_routes.token_service, "get_session_key", lambda token: "a")
    response = Response()
    assert ai_routes.get_ai_history(response=response, token="test") == []
    assert response.headers["Cache-Control"] == "no-store"


def test_clear_during_inference_does_not_resurrect_old_history():
    traces = AgentTraceStore()
    old_id = traces.start_run(session_key="a", model="gpt-5.6-luna", user_message="Old")
    traces.clear_trace(session_key="a")
    new_id = traces.start_run(session_key="a", model="gpt-5.6-luna", user_message="New")
    traces.fail_run(session_key="a", run_id=old_id, error="Late cancellation")
    snapshot = traces.snapshot(session_key="a")
    assert snapshot["run"]["run_id"] == new_id
    assert snapshot["run"]["status"] == "running"
    assert traces.export_history(session_key="a") == []


@pytest.mark.parametrize("has_history", [False, True])
def test_an_event_for_a_run_the_store_never_started_is_refused(has_history):
    """Reported 2026-10-18: Suggest title recorded its attempts under a run id it made up.
    A session with chat history refused it (a server error); one without dropped the
    events silently, which is how every test missed it. Both now refuse."""
    traces = AgentTraceStore()
    if has_history:
        traces.start_run(session_key="a", model="gpt-5.6-luna", user_message="Earlier")
    with pytest.raises(RuntimeError, match="does not match a recorded run"):
        traces.append_event(session_key="a", run_id="invented", event_type="EXPORT_TITLE_INFERENCE",
                            label="Export title", detail={}, duration_ms=1.0)
    with pytest.raises(RuntimeError, match="does not match a recorded run"):
        traces.complete_run(session_key="a", run_id="invented")


def test_a_late_event_after_a_reset_is_discarded_like_one_after_a_clear():
    traces = AgentTraceStore()
    old_id = traces.start_run(session_key="a", model="gpt-5.6-luna", user_message="Old")
    traces.reset()
    traces.fail_run(session_key="a", run_id=old_id, error="Late cancellation")
    assert traces.snapshot(session_key="a")["has_trace"] is False
