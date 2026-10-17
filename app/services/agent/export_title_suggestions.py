"""Suggest with AI, for the title of an export or print (docs/ui/controls.md).

The user presses the button; nothing is asked otherwise. The AI sees what goes
out that it may see: the notes in their order (a note and its children, or the
view as it is shown), as text with their tags and depth, from the top until
about EXPORT_TITLE_INPUT_TOKENS. Notes the AI privacy settings hide are left out
with everything under them, @password and @username notes included, as
everywhere the AI reads. Nothing says that anything was left out, and the search text is never
sent, since a search can name a private tag. The answer is one line, at most
MAX_TITLE_CHARACTERS long. Asked again, the AI is told the titles it already
gave, to give another.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field

from app.services.agent.cloud_privacy import CloudPrivacyBoundary
from app.services.agent.cloud_privacy import cloud_privacy_evaluator
from app.services.agent.failure_explanations import FailureSetup
from app.services.agent.failure_explanations import explain_structured_failure
from app.services.agent.inference import InferenceAdapter
from app.services.agent.inference import InferenceProviderError
from app.services.agent.inference import StructuredInferenceError
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.agent.trace import agent_trace_store
from app.services.content_formatting import extract_note_text_for_agent
from app.services.content_formatting import is_password_note
from app.services.content_formatting import is_username_note
from app.services.note_store import store as note_store
from app.services.search_index import extract_ordered_tags_for_search


# How much of it the AI reads, from the top: a title needs the gist.
EXPORT_TITLE_INPUT_TOKENS = 3000
# Of one note, so a long first note does not take it all.
_MAX_NOTE_CHARACTERS = 2000
MAX_TITLE_CHARACTERS = 80
# The longest answer the schema accepts; a longer-than-MAX_TITLE_CHARACTERS answer is cut.
_MAX_ANSWER_TITLE_CHARACTERS = 400
# Titles already suggested that one request may name.
MAX_PREVIOUS_TITLES = 10

# Whether the button can ask: "nothing" (no text to title, so no button),
# "private" (all of it hidden from the AI, so the button is dimmed), "partial"
# (some hidden: the dialog says private notes are not sent), "ready".
ExportTitleAvailability = Literal["nothing", "private", "partial", "ready"]

_REFERENCE_TOKEN = re.compile(r"!?\[\[[^\]]+\]\]")

_INSTRUCTIONS = (
    "You title a document made of the user's notes, to be printed or saved as a file. Give one "
    "short title for the whole document: what these notes are about, as a person would title it. "
    "Write it in the language the notes are written in. At most 8 words and 80 characters, on one "
    "line, without quotes, a final period, or words like \"Notes\", \"Document\" or \"MetaList\" "
    "unless the notes are about them. The notes come in document order; depth 0 is a top-level "
    "note, and deeper notes sit under the note before them. Return only the required JSON."
)


class ExportTitleAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., max_length=_MAX_ANSWER_TITLE_CHARACTERS)


@dataclass(frozen=True, slots=True)
class ExportTitleRequest:
    # The notes going out that the AI may see, in order: {"depth", "content_text", "tags"}.
    notes: tuple[dict[str, object], ...]
    # Whether a note going out was left out: hidden from the AI, a password or a username.
    has_hidden_notes: bool

    @property
    def availability(self) -> ExportTitleAvailability:
        if self.notes and self.has_hidden_notes:
            return "partial"
        if self.notes:
            return "ready"
        if self.has_hidden_notes:
            return "private"
        return "nothing"


def build_export_title_request(
    *, root_ids: list[str], allowed_note_ids: set[str] | None, boundary: CloudPrivacyBoundary,
) -> ExportTitleRequest:
    """What the AI may read of an export or print of root_ids and their children
    (those in allowed_note_ids, or all), in their order."""
    assert isinstance(root_ids, list)
    ordered: list[tuple[str, int]] = []
    pending = [(root_id, 0) for root_id in reversed(root_ids)]
    while pending:
        note_id, depth = pending.pop()
        ordered.append((note_id, depth))
        children = [
            child for child in note_store.get_children(note_id)
            if allowed_note_ids is None or child in allowed_note_ids
        ]
        pending.extend((child, depth + 1) for child in reversed(children))
    # Hidden with everything under it: the evaluator follows the hierarchy.
    hidden = cloud_privacy_evaluator.hidden_note_ids(
        note_ids=tuple(note_id for note_id, _depth in ordered), boundary=boundary,
    )
    notes: list[dict[str, object]] = []
    has_hidden_notes = False
    is_full = False
    for note_id, depth in ordered:
        record = note_store.get_note(note_id)
        if note_id in hidden or is_password_note(record.tags) or is_username_note(record.tags):
            has_hidden_notes = True
            continue
        if is_full:
            continue
        text, redacted = extract_note_text_for_agent(content_html=record.content, tags=record.tags)
        assert not redacted, "A note the AI may read is never a password"
        # Embedded notes and files are references, not words.
        words = " ".join(_REFERENCE_TOKEN.sub(" ", text).split())[:_MAX_NOTE_CHARACTERS]
        if words == "":
            continue
        note = {"depth": depth, "content_text": words, "tags": list(extract_ordered_tags_for_search(record.tags))}
        if notes and estimate_input_tokens([*notes, note]) > EXPORT_TITLE_INPUT_TOKENS:
            is_full = True
            continue
        notes.append(note)
    return ExportTitleRequest(notes=tuple(notes), has_hidden_notes=has_hidden_notes)


def export_title_messages(request: ExportTitleRequest, previous_titles: tuple[str, ...]) -> list[dict[str, str]]:
    assert request.notes, "There is nothing the AI may read to title"
    assert len(previous_titles) <= MAX_PREVIOUS_TITLES
    payload: dict[str, object] = {"notes": list(request.notes)}
    messages = [{"role": "system", "content": _INSTRUCTIONS}]
    if previous_titles:
        payload["titles_already_suggested"] = list(previous_titles)
        messages.append({"role": "system", "content": (
            "The user asked for another title: give one that differs from every title in "
            "titles_already_suggested, not a rewording of one."
        )})
    messages.append({"role": "user", "content": json.dumps(payload, ensure_ascii=False)})
    return messages


def _one_line_title(answer: str) -> str:
    title = " ".join(answer.split()).strip(" \"'“”‘’«».")
    if len(title) > MAX_TITLE_CHARACTERS:
        cut = title[:MAX_TITLE_CHARACTERS + 1].rsplit(" ", 1)[0]
        title = (cut if cut != "" else title[:MAX_TITLE_CHARACTERS]).rstrip(" ,;:-–—")
    return title


def _ignore_progress(progress: object) -> None:
    return None


async def suggest_export_title(
    *, request: ExportTitleRequest, previous_titles: tuple[str, ...], inference: InferenceAdapter,
    base_url: str, model: str, thinking_level: str, web_mode: str, session_key: str,
) -> str:
    """The AI's title for the export or print; InferenceProviderError when it gives none."""
    messages = export_title_messages(request, previous_titles)
    # lint: allow-PY001 rationale="the model's replies were rejected on every attempt: say why, in plain words"
    try:
        response = await inference.infer_structured(
            base_url=base_url, model=model, thinking_level=thinking_level,
            messages=messages, response_model=ExportTitleAnswer, on_progress=_ignore_progress,
        )
    # lint: allow-PY001 rationale="the model's replies were rejected on every attempt: say why, in plain words"
    except StructuredInferenceError as exc:
        raise InferenceProviderError(explain_structured_failure(
            response_model=ExportTitleAnswer, attempts=exc.attempts,
            setup=FailureSetup(model=model, thinking_level=thinking_level, web_mode=web_mode),
        )) from exc
    run_id = str(uuid4())
    for attempt in response.attempts:
        agent_trace_store.append_event(
            session_key=session_key, run_id=run_id, event_type="EXPORT_TITLE_INFERENCE",
            label="Export title · ExportTitleAnswer",
            detail={"request": attempt.request, "response": attempt.response, "error": attempt.error},
            duration_ms=attempt.duration_ms,
        )
    title = _one_line_title(ExportTitleAnswer.model_validate_json(response.content).title)
    if title == "":
        raise InferenceProviderError("The AI answered without a title")
    return title
