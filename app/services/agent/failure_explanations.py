"""Plain-language explanations of failed structured AI steps.

When the model's reply to a structured step (summary batches, tag batches…)
is rejected on every attempt, the chat shows this explanation instead of a
bare "open Agent Debug": which step failed, what went wrong on each attempt,
the setup, and what the user can try. It is stored with the turn, so it stays
readable later without the debug trace.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.services.agent.inference import InferenceAttempt


# What the AI was doing, by the response format it had to produce.
_STEP_DESCRIPTIONS = {
    "SummaryBatchResult": "summarizing a batch of your notes",
    "SummaryFindingsResult": "summarizing your notes",
    "TagBatchResult": "proposing tags",
    "OutputJudgment": "checking its own answer",
}

_THINKING_LABELS = {"off": "thinking off", "low": "Low thinking", "medium": "Medium thinking", "high": "High thinking"}
_WEB_LABELS = {"none": "web access off", "contextual": "contextual web access", "full": "full web access"}

# Long free-text fields are left out of "It chose: …".
_FREE_TEXT_FIELDS = frozenset({"reason", "basis", "rationale", "answer"})
_SIMPLE_FIELD_RE = re.compile(r'"([A-Za-z_]+)"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\[\]]*\]|-?\d+(?:\.\d+)?|true|false|null)')

_CUT_OFF, _FORMAT, _EMPTY, _REFUSED, _SILENT, _OTHER = "cut_off", "format", "empty", "refused", "silent", "other"


@dataclass(frozen=True, slots=True)
class FailureSetup:
    model: str
    thinking_level: str
    web_mode: str


def explain_structured_failure(*, response_model: type, attempts: list[InferenceAttempt], setup: FailureSetup) -> str:
    step = _STEP_DESCRIPTIONS[response_model.__name__]
    lines = [f"MetaList's AI could not finish this request: it failed while {step}."]
    causes = []
    for number, attempt in enumerate(attempts, 1):
        cause, sentence = _describe_attempt(attempt)
        causes.append(cause)
        lines.append(f"Attempt {number}: {sentence}")
    lines.append(
        f"Setup: {setup.model}, {_THINKING_LABELS[setup.thinking_level]}, {_WEB_LABELS[setup.web_mode]}."
    )
    lines.append(f"What you can try: {_suggestion(causes)}")
    lines.append("Agent Debug has the raw request and response.")
    return "\n".join(lines)


def _describe_attempt(attempt: InferenceAttempt) -> tuple[str, str]:
    choice = _first_choice(attempt.response)
    content = _message_field(choice, "content")
    finish_reason = ""
    if "finish_reason" in choice and isinstance(choice["finish_reason"], str):
        finish_reason = choice["finish_reason"]

    if finish_reason == "length":
        return _CUT_OFF, _describe_cut_off(attempt, content)
    if finish_reason == "content_filter" or _message_field(choice, "refusal") != "":
        return _REFUSED, "OpenAI declined to produce an answer."
    if attempt.validation_errors:
        problems = "; ".join(_describe_broken_rule(rule) for rule in attempt.validation_errors)
        sentence = f"the answer did not match the required format: {problems}."
        chosen = _chosen_fields(content)
        if chosen != "":
            sentence += f" It chose: {chosen}."
        return _FORMAT, sentence
    if attempt.error.startswith("APITimeoutError"):
        # The silence limit ran out (openai_silence_limit_seconds): no reply arrived.
        if "timeout" not in attempt.request or not isinstance(attempt.request["timeout"], (int, float)):
            raise RuntimeError("A timed-out structured attempt must record its timeout")
        return _SILENT, f"OpenAI did not respond for {attempt.request['timeout']:g} seconds."
    if content.strip() == "":
        return _EMPTY, "the reply was empty."
    return _OTHER, f"it failed: {attempt.error}."


def _describe_cut_off(attempt: InferenceAttempt, content: str) -> str:
    limit_text = "the output limit"
    if "max_completion_tokens" in attempt.request:
        limit_text = f"the {attempt.request['max_completion_tokens']}-token output limit"
    completion, reasoning = _usage_tokens(attempt.response)
    if reasoning > 0 and reasoning >= completion and content.strip() == "":
        return f"the reply was cut off at {limit_text}; all {reasoning} tokens went to thinking, so no answer was written."
    if reasoning > 0:
        return f"the reply was cut off at {limit_text} after {reasoning} tokens of thinking, before the answer was complete."
    return f"the reply was cut off at {limit_text} before the answer was complete."


def _describe_broken_rule(rule: dict[str, str]) -> str:
    if rule["kind"] == "literal_error" and rule["value"] != "":
        return f"{rule['field']} was '{rule['value']}', which is not one of the allowed values"
    if rule["kind"] == "missing":
        return f"it left out {rule['field']}"
    problem = rule["problem"]
    if problem.startswith("Value error, "):
        problem = problem[len("Value error, "):]
    if rule["field"] == "":
        return problem
    return f"{rule['field']}: {problem}"


def _chosen_fields(content: str) -> str:
    parts = []
    for name, raw_value in _SIMPLE_FIELD_RE.findall(content):
        if name in _FREE_TEXT_FIELDS:
            continue
        if raw_value.startswith("["):
            items = [item.strip().strip('"') for item in raw_value[1:-1].split(",") if item.strip() != ""]
            parts.append(f"{name}=[{', '.join(items)}]")
        else:
            parts.append(f"{name}={raw_value.strip(chr(34))}")
    return ", ".join(parts)


def _suggestion(causes: list[str]) -> str:
    suggestions = []
    if _CUT_OFF in causes:
        suggestions.append("choose a lower thinking level (Low or Off) in the AI settings and ask again")
    if _FORMAT in causes:
        suggestions.append("ask again, or rephrase the request more specifically")
    if _REFUSED in causes:
        suggestions.append("rephrase the request")
    if _SILENT in causes:
        suggestions.append("check your internet connection and ask again")
    if not suggestions:
        suggestions.append("ask again")
    text = "; or ".join(suggestions)
    return text[0].upper() + text[1:] + "."


def _first_choice(response: dict[str, object]) -> dict[str, object]:
    if "choices" not in response:
        return {}
    choices = response["choices"]
    if not isinstance(choices, list) or len(choices) == 0 or not isinstance(choices[0], dict):
        return {}
    return choices[0]


def _message_field(choice: dict[str, object], field_name: str) -> str:
    if "message" not in choice or not isinstance(choice["message"], dict):
        return ""
    message = choice["message"]
    if field_name not in message or not isinstance(message[field_name], str):
        return ""
    return message[field_name]


def _usage_tokens(response: dict[str, object]) -> tuple[int, int]:
    if "usage" not in response or not isinstance(response["usage"], dict):
        return 0, 0
    usage = response["usage"]
    completion = 0
    if "completion_tokens" in usage and isinstance(usage["completion_tokens"], int):
        completion = usage["completion_tokens"]
    reasoning = 0
    if "completion_tokens_details" in usage and isinstance(usage["completion_tokens_details"], dict):
        details = usage["completion_tokens_details"]
        if "reasoning_tokens" in details and isinstance(details["reasoning_tokens"], int):
            reasoning = details["reasoning_tokens"]
    return completion, reasoning
