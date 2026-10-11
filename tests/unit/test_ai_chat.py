import asyncio
import json

import httpx
import pytest

from app.services.ai_chat import AiChatActivityTimer
from app.services.ai_chat import AiChatSessionStore


def test_chat_history_is_scoped_to_server_session_key() -> None:
    store = AiChatSessionStore()

    first_turn = store.start_turn(
        session_key="session-a",
        user_content="What is 2 + 2?",
        provider="openai",
        model="gpt-5.6-sol",
    )
    store.append_delta(
        session_key="session-a",
        turn_id=first_turn,
        delta_kind="thinking",
        text="I should add the numbers.",
    )
    store.append_delta(
        session_key="session-a",
        turn_id=first_turn,
        delta_kind="content",
        text="4",
    )
    store.append_activity(
        session_key="session-a",
        turn_id=first_turn,
        action="model_request",
        status="started",
        label="Waiting for OpenAI",
        approx_input_tokens=1_234,
        output_tokens_received=0,
        duration_ms=1_250.5,
    )
    store.complete_turn(
        session_key="session-a",
        turn_id=first_turn,
        final_content="4", actions=[])

    session_a = store.snapshot(session_key="session-a")
    session_b = store.snapshot(session_key="session-b")

    assert [message["role"] for message in session_a["messages"]] == ["user", "assistant"]
    assert session_a["messages"][1]["thinking"] == "I should add the numbers."
    assert session_a["messages"][1]["content"] == "4"
    assert session_a["messages"][1]["status"] == "complete"
    assert session_a["messages"][1]["activities"] == [
        {
            "action": "model_request",
            "status": "started",
            "label": "Waiting for OpenAI",
            "approx_input_tokens": 1_234,
            "output_tokens_received": 0,
            "duration_ms": 1_250.5,
        }
    ]
    assert session_a["messages"][0]["activities"] == []
    assert session_b == {"messages": []}


def test_chat_store_builds_provider_history_without_thinking_trace() -> None:
    store = AiChatSessionStore()
    turn_id = store.start_turn(
        session_key="session-a",
        user_content="Hello",
        provider="openai",
        model="gpt-5.6-sol",
    )
    store.append_delta(
        session_key="session-a",
        turn_id=turn_id,
        delta_kind="thinking",
        text="Private chain",
    )
    store.append_delta(
        session_key="session-a",
        turn_id=turn_id,
        delta_kind="content",
        text="Hi there",
    )
    store.append_activity(
        session_key="session-a",
        turn_id=turn_id,
        action="retry",
        status="started",
        label="Structured output invalid (ValidationError) · Instructor will retry",
        approx_input_tokens=1_567,
        output_tokens_received=0,
        duration_ms=250.0,
    )
    store.complete_turn(
        session_key="session-a",
        turn_id=turn_id,
        final_content="Hi there", actions=[])

    history = store.provider_messages(session_key="session-a")

    assert history == [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there"},
    ]


def test_activity_timer_retains_completed_step_duration() -> None:
    timer = AiChatActivityTimer()
    started = timer.stamp(
        event={
            "action": "search_notes",
            "status": "started",
            "label": "Searching notes",
            "duration_ms": 0.0,
        },
        observed_at=10.0,
    )
    completed = timer.stamp(
        event={
            "action": "search_notes",
            "status": "completed",
            "label": "Search complete",
            "duration_ms": 0.0,
        },
        observed_at=11.75,
    )

    assert started["duration_ms"] == 0.0
    assert completed["duration_ms"] == 1_750.0


def test_activity_timer_preserves_authoritative_model_duration() -> None:
    timer = AiChatActivityTimer()
    event = timer.stamp(
        event={
            "action": "validation",
            "status": "completed",
            "label": "Structured action validated",
            "duration_ms": 2_778.334,
        },
        observed_at=10.0,
    )

    assert event["duration_ms"] == 2_778.334


def test_chat_store_removes_prior_note_citations_from_provider_history() -> None:
    note_id = "75193dae-9e05-4a4e-94bf-417ffde18957"
    store = AiChatSessionStore()
    turn_id = store.start_turn(
        session_key="session-a",
        user_content="Summarize my testosterone notes",
        provider="openai",
        model="gpt-5.6-sol",
    )
    store.append_delta(
        session_key="session-a",
        turn_id=turn_id,
        delta_kind="content",
        text=f"Sleep can affect testosterone. [[{note_id}]]",
    )
    store.complete_turn(
        session_key="session-a",
        turn_id=turn_id,
        final_content=f"Sleep can affect testosterone. [[{note_id}]]", actions=[])
    store.start_turn(
        session_key="session-a",
        user_content="Please describe Bayes' theorem briefly",
        provider="openai",
        model="gpt-5.6-sol",
    )

    history = store.provider_messages(session_key="session-a")

    assert history == [
        {"role": "user", "content": "Summarize my testosterone notes"},
        {"role": "assistant", "content": "Sleep can affect testosterone."},
        {"role": "user", "content": "Please describe Bayes' theorem briefly"},
    ]


def test_a_failed_turn_stays_in_later_provider_context_with_what_the_user_saw() -> None:
    # The agent must know a request failed and why, so "try that again" or
    # "why did that fail?" makes sense; it is told this was not an answer.
    store = AiChatSessionStore()
    failed_turn_id = store.start_turn(
        session_key="session-a",
        user_content="What are the overall themes in my notes?",
        provider="openai",
        model="gpt-5.6-luna",
    )
    store.fail_turn(
        session_key="session-a",
        turn_id=failed_turn_id,
        error=(
            "MetaList's AI could not finish this request: it failed while summarizing your notes.\n"
            "Attempt 1: it left out supporting_note_ids. It chose: text=Applied AI "
            "[[3b1efae7-98b3-4675-9388-84b028e883af]].\n"
            "Attempt 2: the reply was empty."
        ),
    )
    store.start_turn(
        session_key="session-a",
        user_content="Try that again",
        provider="openai",
        model="gpt-5.6-luna",
    )

    history = store.provider_messages(session_key="session-a")

    assert history == [
        {"role": "user", "content": "What are the overall themes in my notes?"},
        {
            "role": "assistant",
            "content": (
                "(No answer: this request failed. The user was shown the explanation below. "
                "If they ask to try again, redo this request.)\n"
                "MetaList's AI could not finish this request: it failed while summarizing your notes.\n"
                "Attempt 1: it left out supporting_note_ids. It chose: text=Applied AI .\n"
                "Attempt 2: the reply was empty."
            ),
        },
        {"role": "user", "content": "Try that again"},
    ]


def test_chat_store_rejects_parallel_turns_in_one_session() -> None:
    store = AiChatSessionStore()
    store.start_turn(
        session_key="session-a",
        user_content="First",
        provider="openai",
        model="gpt-5.6-sol",
    )

    with pytest.raises(RuntimeError, match="already streaming"):
        store.start_turn(
            session_key="session-a",
            user_content="Second",
            provider="openai",
            model="gpt-5.6-sol",
        )


def test_the_agent_action_log_follows_the_provider_history() -> None:
    # The model's own record of what each earlier answer did (action_log.py),
    # kept beside the history and never shown to the user.
    store = AiChatSessionStore()
    searched = [{"tool": "open_web_pages", "pages": [
        {"url": "https://www.google.com/search?q=ssm", "status": "ok", "title": "Google Search"}]}]
    first = store.start_turn(session_key="session-a", user_content="Find recent papers",
                             provider="openai", model="gpt-5.6-luna")
    store.complete_turn(session_key="session-a", turn_id=first, final_content="Here are some.", actions=searched)
    failed = store.start_turn(session_key="session-a", user_content="And more?",
                              provider="openai", model="gpt-5.6-luna")
    store.fail_turn(session_key="session-a", turn_id=failed, error="Provider failed")
    store.start_turn(session_key="session-a", user_content="Did you search the web?",
                     provider="openai", model="gpt-5.6-luna")

    assert store.earlier_actions(session_key="session-a") == [
        {"answer": 1, "question": "Find recent papers", "actions": searched},
    ]
    assert "actions" not in str(store.snapshot(session_key="session-a"))


def test_the_action_log_starts_over_with_the_history() -> None:
    store = AiChatSessionStore()
    turn = store.start_turn(session_key="session-a", user_content="Find recent papers",
                            provider="openai", model="gpt-5.6-luna")
    store.complete_turn(session_key="session-a", turn_id=turn, final_content="Done.",
                        actions=[{"tool": "view_overview", "notes_in_view": 3, "trees_in_view": 3}])
    # A privacy boundary change hides the earlier history from the model, and its actions with it.
    store.synchronize_disclosure_boundary(session_key="session-a", disclosure_key="first")
    store.synchronize_disclosure_boundary(session_key="session-a", disclosure_key="second")
    assert store.earlier_actions(session_key="session-a") == []
