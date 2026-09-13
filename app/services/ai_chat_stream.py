"""One chat turn's stream state, reference invariants, and cancellation lifecycle."""

import asyncio
import json
import math
import time
from collections.abc import AsyncGenerator

from app.services.ai_chat import AiChatActivityTimer, AiChatSessionStore
from app.services.note_store import NoteStore
from app.services.ai_chat_rendering import render_ai_chat_streaming_markdown_to_html, render_ai_chat_markdown_to_html, sanitize_ai_chat_markdown_citations
from app.services.markdown_rendering import render_markdown_to_html
from app.services.runtime_generation import register_current_task, unregister_task
from app.services.agent.runtime import AgentExecutionError
from app.services.agent.inference import InferenceProviderError
from app.services.managed_ollama_runtime import ManagedOllamaRuntimeError


def event_reference_note_ids(event: dict[str, object]) -> tuple[str, ...]:
    raw_ids = event['reference_note_ids']
    if not isinstance(raw_ids, list):
        raise RuntimeError('Agent reference_note_ids event field must be a list')
    if any(not isinstance(note_id, str) or not note_id for note_id in raw_ids):
        raise RuntimeError('Agent reference note id must be non-empty')
    if len(set(raw_ids)) != len(raw_ids):
        raise RuntimeError('Agent reference_note_ids event field has duplicates')
    return tuple(raw_ids)


class ChatTurnStream:
    def __init__(self, *, store: AiChatSessionStore, notes: NoteStore, session_key: str,
                 turn_id: str, initial_input_tokens: int) -> None:
        self.store, self.notes = store, notes
        self.session_key, self.turn_id = session_key, turn_id
        self.thinking = self.content = ''
        self.reference_note_ids: tuple[str, ...] = ()
        self.has_reference_scope = False
        self.latest_input_tokens = initial_input_tokens
        self.latest_output_tokens = 0
        self.activity_timer = AiChatActivityTimer()

    def is_streaming(self) -> bool:
        return self.store.is_streaming(session_key=self.session_key, turn_id=self.turn_id)

    def append_activity(self, event: dict[str, object]) -> None:
        self.store.append_activity(session_key=self.session_key, turn_id=self.turn_id,
            action=event['action'], status=event['status'], label=event['label'],
            approx_input_tokens=event['approx_input_tokens'], output_tokens_received=event['output_tokens_received'],
            duration_ms=event['duration_ms'])

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
        self.append_activity(event)
        return event

    def content_delta(self, event: dict[str, object]) -> dict[str, object]:
        note_ids = event_reference_note_ids(event)
        if self.has_reference_scope and note_ids != self.reference_note_ids:
            raise RuntimeError('Agent reference scope changed during final response')
        self.reference_note_ids, self.has_reference_scope = note_ids, True
        self.store.append_delta(session_key=self.session_key, turn_id=self.turn_id, delta_kind='content', text=event['text'])
        self.content += event['text']
        return {**event, 'rendered_text': render_ai_chat_streaming_markdown_to_html(self.content, allowed_note_ids=note_ids)}

    def complete(self, event: dict[str, object]) -> dict[str, object]:
        if not self.has_reference_scope:
            raise RuntimeError('Agent final response completed without a reference scope')
        if event_reference_note_ids(event) != self.reference_note_ids:
            raise RuntimeError('Agent completion reference scope does not match content')
        content = sanitize_ai_chat_markdown_citations(self.content, notes=self.notes, allowed_note_ids=self.reference_note_ids)
        self.store.complete_turn(session_key=self.session_key, turn_id=self.turn_id, final_content=content)
        return {**event, 'content': content, 'rendered_content': render_ai_chat_markdown_to_html(content, notes=self.notes, allowed_note_ids=self.reference_note_ids)}

    def transform(self, event: dict[str, object]) -> dict[str, object]:
        event_type = event['type']
        if event_type in {'bulk_question', 'bulk_progress', 'bulk_complete', 'bulk_preferences'}:
            return event
        if event_type == 'action_status':
            return self.action_status(event)
        if event_type == 'thinking_delta':
            self.store.append_delta(session_key=self.session_key, turn_id=self.turn_id, delta_kind='thinking', text=event['text'])
            self.thinking += event['text']
            return {**event, 'rendered_text': render_markdown_to_html(self.thinking)}
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
            async for event in source:
                yield json.dumps(self.transform(event), separators=(',', ':')) + '\n'
        # lint: allow-PY001 rationale="expected provider/network failures must be delivered after response headers"
        except (AgentExecutionError, InferenceProviderError, ManagedOllamaRuntimeError) as exc:
            if not self.is_streaming():
                raise
            self.fail(str(exc))
            yield json.dumps({'type':'error', 'message':str(exc)}, separators=(',', ':')) + '\n'
        except asyncio.CancelledError:
            if self.is_streaming():
                self.append_activity(dict(action='cancel',status='completed',label='Cancelled by user',
                    approx_input_tokens=self.latest_input_tokens,output_tokens_received=self.latest_output_tokens,duration_ms=0.0))
                self.fail('Cancelled by user')
            raise
        # lint: allow-PY001 rationale="record the turn failure and re-raise the original internal defect"
        except Exception:
            if self.is_streaming():
                self.fail('Internal agent error')
            raise
        finally:
            unregister_task(task)
            await source.aclose()
