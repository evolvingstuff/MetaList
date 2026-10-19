"""One chat turn's stream state, reference invariants, and cancellation lifecycle."""

import asyncio
import json
import math
import time
from collections.abc import AsyncGenerator

from app.security.http_error_diagnostics import describe_server_exception
from app.services.ai_chat import AiChatActivityTimer, AiChatSessionStore
from app.services.note_store import NoteStore
from app.services.ai_chat_rendering import render_ai_chat_streaming_markdown_to_html, render_ai_chat_markdown_to_html, render_ai_chat_thinking_to_html, sanitize_ai_chat_markdown_citations, strip_provider_citation_markup
from app.services.runtime_generation import register_current_task, unregister_task
from app.services.agent.runtime import AgentExecutionError
from app.services.agent.inference import InferenceProviderError
from app.services.agent.web_evidence import WebEvidenceStore
from app.services.agent.web_evidence import WebCitationReference


def event_reference_note_ids(event: dict[str, object]) -> tuple[str, ...]:
    raw_ids = event['reference_note_ids']
    if not isinstance(raw_ids, list):
        raise RuntimeError('Agent reference_note_ids event field must be a list')
    if any(not isinstance(note_id, str) or not note_id for note_id in raw_ids):
        raise RuntimeError('Agent reference note id must be non-empty')
    if len(set(raw_ids)) != len(raw_ids):
        raise RuntimeError('Agent reference_note_ids event field has duplicates')
    return tuple(raw_ids)


def event_reference_web_ids(event: dict[str, object]) -> tuple[str, ...]:
    raw_ids = event["reference_web_ids"]
    if not isinstance(raw_ids, list):
        raise RuntimeError("Agent reference_web_ids event field must be a list")
    if any(not isinstance(evidence_id, str) or not evidence_id for evidence_id in raw_ids):
        raise RuntimeError("Agent web evidence id must be non-empty")
    if len(set(raw_ids)) != len(raw_ids):
        raise RuntimeError("Agent reference_web_ids event field has duplicates")
    return tuple(raw_ids)


class ChatTurnStream:
    def __init__(self, *, store: AiChatSessionStore, notes: NoteStore,
                 session_key: str, turn_id: str, initial_input_tokens: int,
                 web_evidence_store: WebEvidenceStore) -> None:
        self.store, self.notes = store, notes
        self.web_evidence_store = web_evidence_store
        self.session_key, self.turn_id = session_key, turn_id
        self.thinking = self.content = ''
        # What the model wrote; self.content is what is shown (provider citation markup removed).
        self.model_content = ''
        self.reference_note_ids: tuple[str, ...] = ()
        self.reference_web_ids: tuple[str, ...] = ()
        self.has_reference_scope = False
        self.latest_input_tokens = initial_input_tokens
        self.latest_output_tokens = 0
        self.activity_timer = AiChatActivityTimer()
        # The run's steps as (label, status, observed_at), and an operation's latest
        # progress, for saying where a failed turn stopped (where_it_stopped).
        self.steps: list[tuple[str, str, float]] = []
        self.latest_progress_label = ''

    def is_streaming(self) -> bool:
        return self.store.is_streaming(session_key=self.session_key, turn_id=self.turn_id)

    def append_activity(self, event: dict[str, object]) -> None:
        self.store.append_activity(session_key=self.session_key, turn_id=self.turn_id,
            action=event['action'], status=event['status'], label=event['label'],
            approx_input_tokens=event['approx_input_tokens'], output_tokens_received=event['output_tokens_received'],
            duration_ms=event['duration_ms'])

    def where_it_stopped(self) -> str:
        """Where the run was when it failed: the step it was in (or had just
        finished), the step before, and an operation's latest progress."""
        if not self.steps:
            return 'Where it stopped: before the first step.'
        label, status, observed_at = self.steps[-1]
        completed_count = sum(1 for _label, step_status, _at in self.steps if step_status == 'completed')
        if status == 'completed':
            text = f'Where it stopped: after "{label}", step {completed_count} of the run'
        else:
            seconds = time.perf_counter() - observed_at
            text = (f'Where it stopped: during "{label}" ({seconds:.1f} s into that step), '
                    f'step {completed_count + 1} of the run')
            earlier = [step_label for step_label, step_status, _at in self.steps[:-1] if step_status == 'completed']
            if earlier:
                text += f'; before that: "{earlier[-1]}"'
        if self.latest_progress_label:
            text += f'; latest progress: "{self.latest_progress_label}"'
        return text + '.'

    def fail(self, message: str) -> None:
        self.store.fail_turn(session_key=self.session_key, turn_id=self.turn_id, error=message)

    def action_status(self, event: dict[str, object]) -> dict[str, object]:
        event = self.activity_timer.stamp(event=event, observed_at=time.perf_counter())
        input_tokens, output_tokens, duration = event['approx_input_tokens'], event['output_tokens_received'], event['duration_ms']
        if not isinstance(input_tokens, int) or isinstance(input_tokens, bool) or input_tokens < 1:
            raise RuntimeError('Agent action status approximate input tokens are invalid')
        if not isinstance(output_tokens, int) or isinstance(output_tokens, bool) or output_tokens < 0:
            raise RuntimeError('Agent action status output tokens are invalid')
        if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration) or duration < 0:
            raise RuntimeError('Agent action status duration is invalid')
        self.latest_input_tokens, self.latest_output_tokens = input_tokens, output_tokens
        self.steps.append((str(event['label']), str(event['status']), time.perf_counter()))
        self.append_activity(event)
        return event

    def content_delta(self, event: dict[str, object]) -> dict[str, object]:
        note_ids = event_reference_note_ids(event)
        web_ids = event_reference_web_ids(event)
        # A tool-using answer may gain references as tools return more notes and
        # pages, but never loses one: text already shown keeps its citations.
        if self.has_reference_scope and (
            note_ids[:len(self.reference_note_ids)] != self.reference_note_ids
            or web_ids[:len(self.reference_web_ids)] != self.reference_web_ids
        ):
            raise RuntimeError('Agent reference scope may only grow during a response')
        self.reference_note_ids = note_ids
        self.reference_web_ids = web_ids
        self.has_reference_scope = True
        web_evidence = self._reference_web_evidence()
        self.model_content += event['text']
        shown = strip_provider_citation_markup(self.model_content, is_final=False)
        if not shown.startswith(self.content):
            raise RuntimeError('Shown AI response text must only grow while streaming')
        new_text = shown[len(self.content):]
        if new_text != '':
            self.store.append_delta(session_key=self.session_key, turn_id=self.turn_id, delta_kind='content', text=new_text)
        self.content = shown
        return {**event, 'text': new_text, 'rendered_text': render_ai_chat_streaming_markdown_to_html(
            self.content,
            allowed_note_ids=note_ids,
            allowed_web_evidence=web_evidence,
        )}

    def complete(self, event: dict[str, object]) -> dict[str, object]:
        if not self.has_reference_scope:
            raise RuntimeError('Agent final response completed without a reference scope')
        if event_reference_note_ids(event) != self.reference_note_ids:
            raise RuntimeError('Agent completion reference scope does not match content')
        if event_reference_web_ids(event) != self.reference_web_ids:
            raise RuntimeError('Agent completion web reference scope does not match content')
        web_evidence = self._reference_web_evidence()
        content = sanitize_ai_chat_markdown_citations(
            strip_provider_citation_markup(self.model_content, is_final=True),
            notes=self.notes,
            allowed_note_ids=self.reference_note_ids,
            allowed_web_evidence=web_evidence,
        )
        # The agent's own record of this answer is kept for later turns and never
        # sent to the browser.
        actions = event['actions']
        if not isinstance(actions, list) or not all(isinstance(action, dict) for action in actions):
            raise RuntimeError('Agent completion actions must be a list of action log entries')
        self.store.complete_turn(session_key=self.session_key, turn_id=self.turn_id, final_content=content,
                                 actions=actions)
        event = {key: value for key, value in event.items() if key != 'actions'}
        return {**event, 'content': content, 'rendered_content': render_ai_chat_markdown_to_html(
            content,
            notes=self.notes,
            allowed_note_ids=self.reference_note_ids,
            allowed_web_evidence=web_evidence,
        )}

    def _reference_web_evidence(self) -> tuple[WebCitationReference, ...]:
        return tuple(
            self.web_evidence_store.get_reference(
                session_key=self.session_key,
                evidence_id=evidence_id,
            )
            for evidence_id in self.reference_web_ids
        )

    def transform(self, event: dict[str, object]) -> dict[str, object]:
        event_type = event['type']
        if event_type == 'bulk_progress':
            self.latest_progress_label = str(event['label'])
            return event
        if event_type == 'bulk_complete':
            self.latest_progress_label = ''
            return event
        if event_type in {'bulk_question', 'bulk_preferences', 'menu_open'}:
            return event
        if event_type == 'action_status':
            return self.action_status(event)
        if event_type == 'thinking_delta':
            self.store.append_delta(session_key=self.session_key, turn_id=self.turn_id, delta_kind='thinking', text=event['text'])
            self.thinking += event['text']
            return {**event, 'rendered_text': render_ai_chat_thinking_to_html(self.thinking)}
        if event_type == 'content_delta':
            return self.content_delta(event)
        if event_type == 'done':
            return self.complete(event)
        raise RuntimeError(f'Unknown agent stream event type: {event_type}')

    async def events(self, source: AsyncGenerator[dict[str, object], None]) -> AsyncGenerator[str, None]:
        if not self.is_streaming():
            await source.aclose()
            return
        task = register_current_task()
        # lint: allow-PY001 rationale="stream transport failures are delivered after headers; internal errors are re-raised"
        try:
            async for event in source:  # shockharness: ignore[EXC003] reason="each pull from the agent's stream is the external operation; the body forwards the event"
                yield json.dumps(self.transform(event), separators=(',', ':')) + '\n'
        # lint: allow-PY001 rationale="expected provider/network failures must be delivered after response headers"
        except (AgentExecutionError, InferenceProviderError) as exc:
            if not self.is_streaming():
                raise
            message = f'{exc}\n{self.where_it_stopped()}'
            self.fail(message)
            yield json.dumps({'type':'error', 'message':message}, separators=(',', ':')) + '\n'
        except asyncio.CancelledError:
            if self.is_streaming():
                self.append_activity(dict(action='cancel',status='completed',label='Cancelled by user',
                    approx_input_tokens=self.latest_input_tokens,output_tokens_received=self.latest_output_tokens,duration_ms=0.0))
                self.fail('Cancelled by user')
            raise
        # lint: allow-PY001 rationale="record the turn failure and re-raise the original internal defect"
        except Exception as exc:
            if self.is_streaming():
                diagnostic = describe_server_exception(exc)
                self.fail(
                    "Internal agent error "
                    f"({diagnostic['errorType']} at {diagnostic['codeLocation']})\n{self.where_it_stopped()}"
                )
            raise
        finally:
            unregister_task(task)
            await source.aclose()
