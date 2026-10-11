import pytest

from app.services.agent.failure_explanations import FailureSetup
from app.services.agent.failure_explanations import explain_structured_failure
from app.services.agent.inference import InferenceAttempt
from app.services.agent.staged_summary import SummaryBatchResult
from app.services.agent.staged_summary import SummaryFindingsResult
from app.services.agent.tagging import TagBatchResult


_SETUP = FailureSetup(model="gpt-5.6-terra", thinking_level="medium", web_mode="none")


def _cut_off_attempt(*, limit: int, reasoning: int, content: str) -> InferenceAttempt:
    return InferenceAttempt(
        request={"max_completion_tokens": limit, "reasoning_effort": "medium"},
        response={
            "choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "length"}],
            "usage": {"completion_tokens": limit, "completion_tokens_details": {"reasoning_tokens": reasoning}},
        },
        error="IncompleteOutputException: The output is incomplete due to a max_tokens length limit.",
        duration_ms=4_000.0,
        validation_errors=(),
    )


def _rejected_attempt(*, content: str, validation_errors: tuple[dict[str, str], ...]) -> InferenceAttempt:
    return InferenceAttempt(
        request={"max_completion_tokens": 512, "reasoning_effort": "medium"},
        response={
            "choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "usage": {"completion_tokens": 120, "completion_tokens_details": {"reasoning_tokens": 64}},
        },
        error="ValidationError: 1 validation error for SummaryBatchResult",
        duration_ms=1_500.0,
        validation_errors=validation_errors,
    )


def test_a_step_cut_off_by_thinking_is_explained_in_plain_words() -> None:
    message = explain_structured_failure(
        response_model=SummaryFindingsResult,
        attempts=[
            _cut_off_attempt(limit=512, reasoning=512, content=""),
            _cut_off_attempt(limit=512, reasoning=498, content='{"findings":[{"te'),
        ],
        setup=_SETUP,
    )

    # Which step failed, what happened on each attempt, the setup, and what to try.
    assert "summarizing your notes" in message
    assert "Attempt 1: the reply was cut off at the 512-token output limit; all 512 tokens went to thinking, so no answer was written." in message
    assert "Attempt 2: the reply was cut off at the 512-token output limit after 498 tokens of thinking, before the answer was complete." in message
    assert "Setup: gpt-5.6-terra, Medium thinking, web access off." in message
    assert "lower thinking level" in message
    # The message stands on its own; Agent Debug is only for raw details.
    assert "Agent Debug" in message
    assert not message.startswith("Open Agent Debug")


def test_a_rejected_reply_shows_what_the_model_chose_and_which_rule_it_broke() -> None:
    message = explain_structured_failure(
        response_model=SummaryBatchResult,
        attempts=[
            _rejected_attempt(
                content='{"covered_root_ids":[],"findings":[]}',
                validation_errors=({"field": "covered_root_ids", "kind": "too_short",
                                    "problem": "List should have at least 1 item after validation, not 0", "value": ""},),
            ),
            _rejected_attempt(
                content='{"covered_root_ids":["root-9"],"findings":[]}',
                validation_errors=({"field": "", "kind": "value_error",
                                    "problem": "Covered roots must match the batch", "value": ""},),
            ),
        ],
        setup=_SETUP,
    )

    assert ("Attempt 1: the answer did not match the required format: covered_root_ids: List should have at "
            "least 1 item after validation, not 0. It chose: covered_root_ids=[], findings=[].") in message
    assert ("Attempt 2: the answer did not match the required format: Covered roots must match the batch. "
            "It chose: covered_root_ids=[root-9], findings=[].") in message
    assert "rephrase" in message


def test_other_steps_and_setups_are_named() -> None:
    tag_message = explain_structured_failure(
        response_model=TagBatchResult,
        attempts=[InferenceAttempt(
            request={"max_completion_tokens": 8192},
            response={"choices": [{"message": {"role": "assistant", "content": ""}, "finish_reason": "stop"}]},
            error="ValueError: Instructor stream returned no structured output",
            duration_ms=900.0,
            validation_errors=(),
        )],
        setup=FailureSetup(model="gpt-5.6-sol", thinking_level="high", web_mode="full"),
    )
    assert "proposing tags" in tag_message
    assert "Setup: gpt-5.6-sol, High thinking, full web access." in tag_message
    assert "Attempt 1: the reply was empty." in tag_message


def test_an_unknown_step_fails_loudly() -> None:
    class UnknownStep:
        pass

    # An unknown step must not get a made-up description.
    with pytest.raises(KeyError):
        explain_structured_failure(response_model=UnknownStep, attempts=[], setup=_SETUP)


def _silent_attempt(*, seconds: float) -> InferenceAttempt:
    # A request OpenAI never answered: no reply at all, Instructor's wrapped timeout.
    return InferenceAttempt(
        request={"max_completion_tokens": 8_192, "timeout": seconds, "reasoning_effort": "low"},
        response={"choices": [{"message": {"role": "assistant", "content": ""}}]},
        error="APITimeoutError: Request timed out.",
        duration_ms=seconds * 1_000,
        validation_errors=(),
    )


def test_a_step_openai_never_answered_says_so_and_suggests_the_connection() -> None:
    message = explain_structured_failure(
        response_model=SummaryFindingsResult,
        attempts=[_silent_attempt(seconds=15.0), _silent_attempt(seconds=15.0)],
        setup=FailureSetup(model="gpt-5.6-luna", thinking_level="low", web_mode="none"),
    )

    assert "Attempt 1: OpenAI did not respond for 15 seconds." in message
    assert "Attempt 2: OpenAI did not respond for 15 seconds." in message
    assert "the reply was empty" not in message
    assert "What you can try: Check your internet connection and ask again." in message
