"""A failed turn's explanation says where the run was when it stopped: the step
it was in (or had just finished), how long it had been there, the step before,
and an operation's latest progress, so a screenshot shows what went wrong."""

from __future__ import annotations

import asyncio
import json
import time

from app.services.ai_chat import AiChatSessionStore
from app.services.ai_chat_stream import ChatTurnStream
from app.services.agent.execution_errors import AgentExecutionError
from app.services.agent.web_evidence import WebEvidenceStore
from app.services.note_store import NoteStore


def _status(action: str, status: str, label: str) -> dict[str, object]:
    return {"type": "action_status", "action": action, "status": status, "label": label,
            "approx_input_tokens": 100, "output_tokens_received": 0, "duration_ms": 0.0}


def _failed_stream(events: list[dict[str, object]], pause_before_failure: float) -> tuple[str, str]:
    store = AiChatSessionStore()
    turn_id = store.start_turn(session_key="where", user_content="What's new in MetaList?", provider="openai", model="test")
    stream = ChatTurnStream(store=store, notes=NoteStore(), session_key="where", turn_id=turn_id,
                            initial_input_tokens=1, web_evidence_store=WebEvidenceStore())

    async def source():
        for event in events:
            yield event
        await asyncio.sleep(pause_before_failure)
        raise AgentExecutionError("OpenAI did not respond for 15 seconds. Check your internet connection and ask again.")

    async def consume() -> list[dict[str, object]]:
        return [json.loads(line) async for line in stream.events(source())]

    lines = asyncio.run(consume())
    assert lines[-1]["type"] == "error"
    stored = store.snapshot(session_key="where")
    return str(lines[-1]["message"]), json.dumps(stored)


def test_the_explanation_names_the_step_it_stopped_in_and_the_one_before() -> None:
    message, stored = _failed_stream([
        _status("scope", "completed", "Scope ready · All notes · 45479 notes in 3000 result trees"),
        _status("agent_turn", "started", "Thinking"),
    ], pause_before_failure=0.05)

    first_line, _, where = message.partition("\n")
    assert first_line == "OpenAI did not respond for 15 seconds. Check your internet connection and ask again."
    assert where.startswith('Where it stopped: during "Thinking" (')
    assert "s into that step), step 2 of the run; before that: \"Scope ready · All notes · 45479 notes in 3000 result trees\"." in where
    # The saved turn keeps the same explanation, so the AI and a later screenshot see it.
    assert "Where it stopped: during" in stored


def test_between_steps_it_says_what_had_just_finished() -> None:
    message, _ = _failed_stream([
        _status("agent_turn", "started", "Thinking"),
        _status("agent_turn", "completed", "Chose: search_view_notes"),
    ], pause_before_failure=0.0)

    # A step that started and completed is one step.
    assert '\nWhere it stopped: after "Chose: search_view_notes", step 1 of the run.' in message


def test_a_running_operation_adds_its_latest_progress() -> None:
    message, _ = _failed_stream([
        _status("agent_turn", "completed", "Chose: summarize_view"),
        {"type": "bulk_progress", "operation": "summary", "committing": False,
         "label": "Summarizing 9 batches · 6 complete · 3 writing · 0 queued",
         "completed_tokens": 6, "total_tokens": 9},
    ], pause_before_failure=0.0)

    assert 'latest progress: "Summarizing 9 batches · 6 complete · 3 writing · 0 queued".' in message


def test_a_failure_before_any_step_says_so() -> None:
    message, _ = _failed_stream([], pause_before_failure=0.0)

    assert message.endswith("\nWhere it stopped: before the first step.")
