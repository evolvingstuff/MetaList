import asyncio

import httpx
import pytest
from pydantic import ValidationError

from app.services.agent.judging import OutputJudgment
from app.services.agent.staged_summary import SummaryBatchResult
from app.services.agent.staged_summary import SummaryFindingsResult
from app.services.agent.structured_inference import _InstructorTraceCapture
from app.services.agent.structured_inference import _finish_reason_or_empty, _structured_max_output_tokens
from app.services.agent.structured_inference import _structured_retry_messages
from instructor.v2.core.errors import InstructorRetryException
from app.services.agent.tagging import TagBatchResult


def test_structured_output_limits_are_bounded_by_response_type() -> None:
    for response_model in (SummaryBatchResult, SummaryFindingsResult, TagBatchResult, OutputJudgment):
        assert _structured_max_output_tokens(response_model) == 8_192

    class UnknownReply(SummaryFindingsResult):
        pass

    with pytest.raises(RuntimeError, match="limit missing"):
        _structured_max_output_tokens(UnknownReply)


def test_structured_retry_can_identify_output_limit_truncation() -> None:
    response = {
        "choices": [
            {
                "message": {"role": "assistant", "content": '{"partial":'},
                "finish_reason": "length",
            }
        ]
    }

    assert _finish_reason_or_empty(response) == "length"


def test_a_rejected_attempt_keeps_the_broken_rules_for_the_error_message() -> None:
    capture = _InstructorTraceCapture(on_progress=lambda progress: None)
    capture.record_request(messages=[], max_completion_tokens=8_192)
    asyncio.run(capture.record_wire_request(httpx.Request(
        "POST", "https://api.openai.com/v1/chat/completions", json={"model": "gpt-5.6-terra"},
    )))
    with pytest.raises(ValidationError) as rejected:
        SummaryBatchResult.model_validate({"covered_root_ids": [""], "findings": []})
    capture.record_parse_error(rejected.value)

    attempt = capture.freeze()[0]

    assert attempt.validation_errors == (
        {
            "field": "covered_root_ids",
            "kind": "value_error",
            "problem": rejected.value.errors()[0]["msg"],
            # Only simple values are shown; a list is described by its rule alone.
            "value": "",
        },
    )


def test_structured_steps_have_room_for_thinking_before_their_answer() -> None:
    # Reasoning tokens count against the output limit: at Medium or High
    # thinking, 512 tokens could be spent entirely on thinking.
    assert _structured_max_output_tokens(SummaryFindingsResult) >= 8_192


_ORIGINAL_MESSAGES = [
    {"role": "system", "content": "Summarize the batch."},
    {"role": "user", "content": "STAGED_SUMMARY_BATCH_REQUEST {}"},
]


def _started_attempt() -> _InstructorTraceCapture:
    capture = _InstructorTraceCapture(on_progress=lambda progress: None)
    capture.record_request(messages=_ORIGINAL_MESSAGES, max_completion_tokens=8_192)
    asyncio.run(capture.record_wire_request(httpx.Request(
        "POST", "https://api.openai.com/v1/chat/completions", json={"model": "gpt-5.6-luna"},
    )))
    return capture


def _missing_supporting_note_ids() -> ValidationError:
    with pytest.raises(ValidationError) as rejected:
        SummaryFindingsResult.model_validate({"findings": [{"text": "Themes [[n1]]"}]})
    return rejected.value


def test_a_reply_stopped_mid_stream_is_corrected_on_the_retry() -> None:
    # Validation stops the stream at the first finding that breaks a rule, so
    # the reply never completes. The retry must still show the model what it
    # wrote and what was wrong, not resend the same request.
    capture = _started_attempt()
    written = '{"findings":[{"text":"Themes [[n1]]"}'
    capture._capture_chunk(attempt=capture._current_attempt(), chunk={"choices": [{"delta": {"content": written}}]})
    failure = _missing_supporting_note_ids()

    retry = _structured_retry_messages(capture=capture, original_messages=_ORIGINAL_MESSAGES, failure=failure)

    assert retry[:2] == _ORIGINAL_MESSAGES
    assert retry[2] == {"role": "assistant", "content": written}
    assert retry[3]["role"] == "user"
    assert "supporting_note_ids" in retry[3]["content"]
    assert "Field required" in retry[3]["content"]
    assert len(retry) == 4


def test_a_retry_after_no_reply_still_says_what_was_wrong() -> None:
    capture = _started_attempt()
    failure = _missing_supporting_note_ids()

    retry = _structured_retry_messages(capture=capture, original_messages=_ORIGINAL_MESSAGES, failure=failure)

    assert retry[:2] == _ORIGINAL_MESSAGES
    assert len(retry) == 3
    assert retry[2]["role"] == "user"
    assert "supporting_note_ids" in retry[2]["content"]


def test_an_instructor_retry_failure_records_the_rule_the_attempt_broke() -> None:
    # Instructor wraps the attempt's real error; the explanation needs that
    # error, not a bare "the reply was empty".
    capture = _started_attempt()
    cause = _missing_supporting_note_ids()
    wrapped = InstructorRetryException(
        str(cause), last_completion=None, n_attempts=1, total_usage=0,
        messages=_ORIGINAL_MESSAGES, create_kwargs={}, failed_attempts=[],
    )
    wrapped.__cause__ = cause

    capture.record_attempt_failure(wrapped)

    attempt = capture.freeze()[0]
    assert attempt.validation_errors[0]["field"] == "findings.0.supporting_note_ids"
    assert attempt.validation_errors[0]["kind"] == "missing"
