"""Session-scoped, in-memory AI chat state."""

from __future__ import annotations

import math
from threading import Lock
from uuid import uuid4

from app.services.ai_chat_rendering import strip_note_citations_for_history


_MAX_MESSAGES_PER_SESSION = 100
_MAX_MESSAGE_CHARACTERS = 32_000


class AiChatActivityTimer:
    """Attach retained elapsed time to a stream of activity lifecycle events."""

    def __init__(self) -> None:
        self._started: dict[str, tuple[str, float]] = {}

    def stamp(
        self,
        *,
        event: dict[str, object],
        observed_at: float,
    ) -> dict[str, object]:
        if not isinstance(event, dict):
            raise TypeError("AI activity event must be an object")
        if not isinstance(observed_at, (int, float)) or isinstance(observed_at, bool):
            raise TypeError("AI activity observation time must be numeric")
        if not math.isfinite(observed_at) or observed_at < 0:
            raise ValueError("AI activity observation time must be non-negative and finite")
        action = event["action"]
        status = event["status"]
        label = event["label"]
        supplied_duration = event["duration_ms"]
        if not isinstance(action, str) or action == "":
            raise ValueError("AI activity action must be non-empty")
        if status not in {"started", "completed"}:
            raise ValueError("AI activity status is invalid")
        if not isinstance(label, str) or label == "":
            raise ValueError("AI activity label must be non-empty")
        if (
            not isinstance(supplied_duration, (int, float))
            or isinstance(supplied_duration, bool)
            or not math.isfinite(supplied_duration)
            or supplied_duration < 0
        ):
            raise ValueError("AI activity duration must be non-negative and finite")
        measured_duration = 0.0
        if status == "started":
            should_start = action not in self._started
            if action in self._started:
                prior_label, prior_started_at = self._started[action]
                should_start = prior_label != label
                if not should_start:
                    measured_duration = (observed_at - prior_started_at) * 1_000
            if should_start:
                self._started[action] = (
                    label,
                    observed_at - (float(supplied_duration) / 1_000),
                )
                measured_duration = float(supplied_duration)
        else:
            if action in self._started:
                _prior_label, prior_started_at = self._started.pop(action)
                measured_duration = (observed_at - prior_started_at) * 1_000
        duration_ms = max(float(supplied_duration), measured_duration)
        return {**event, "duration_ms": duration_ms}


class AiChatSessionStore:
    """Keep AI conversations isolated by opaque authenticated-session key."""

    def __init__(self) -> None:
        self._sessions: dict[str, list[dict[str, str]]] = {}
        self._activities: dict[str, dict[str, list[dict[str, object]]]] = {}
        self._lock = Lock()
        self._history_starts: dict[str, int] = {}
        self._disclosure_keys: dict[str, str] = {}

    def reset(self) -> None:
        with self._lock:
            self._history_starts.clear()
            self._disclosure_keys.clear()
            self._sessions.clear()
            self._activities.clear()

    def clear_session(self, *, session_key: str) -> None:
        self._validate_session_key(session_key)
        with self._lock:
            self._history_starts.pop(session_key, None)
            self._disclosure_keys.pop(session_key, None)
            self._sessions.pop(session_key, None)
            self._activities.pop(session_key, None)

    def snapshot(self, *, session_key: str) -> dict[str, list[dict[str, object]]]:
        self._validate_session_key(session_key)
        with self._lock:
            messages = self._sessions.get(session_key, [])
            session_activities: dict[str, list[dict[str, object]]] = {}
            if session_key in self._activities:
                session_activities = self._activities[session_key]
            elif messages:
                raise RuntimeError("AI activities missing for populated session")
            return {
                "messages": [
                    {
                        **message,
                        "activities": [
                            dict(activity)
                            for activity in session_activities[message["id"]]
                        ],
                    }
                    for message in messages
                ]
            }

    def start_turn(
        self,
        *,
        session_key: str,
        user_content: str,
        provider: str,
        model: str,
    ) -> str:
        self._validate_session_key(session_key)
        self._validate_message_text(user_content, label="user_content")
        self._validate_message_text(provider, label="provider")
        self._validate_message_text(model, label="model")
        with self._lock:
            messages = self._sessions.setdefault(session_key, [])
            session_activities = self._activities.setdefault(session_key, {})
            if any(message["status"] == "streaming" for message in messages):
                raise RuntimeError("AI chat session already streaming a turn")
            if messages and messages[-1]["provider"] != provider:
                self._history_starts[session_key] = len(messages)
            if len(messages) + 2 > _MAX_MESSAGES_PER_SESSION:
                removed_message_ids = [message["id"] for message in messages[:2]]
                del messages[:2]
                self._history_starts[session_key] = max(0, self._history_starts.get(session_key, 0) - 2)
                for removed_message_id in removed_message_ids:
                    if removed_message_id not in session_activities:
                        raise RuntimeError("AI activity list missing for removed message")
                    del session_activities[removed_message_id]
            user_message_id = str(uuid4())
            assistant_message_id = str(uuid4())
            messages.extend(
                [
                    {
                        "id": user_message_id,
                        "role": "user",
                        "content": user_content,
                        "thinking": "",
                        "status": "complete",
                        "error": "",
                        "provider": provider,
                        "model": model,
                    },
                    {
                        "id": assistant_message_id,
                        "role": "assistant",
                        "content": "",
                        "thinking": "",
                        "status": "streaming",
                        "error": "",
                        "provider": provider,
                        "model": model,
                    },
                ]
            )
            session_activities[user_message_id] = []
            session_activities[assistant_message_id] = []
            return assistant_message_id

    def append_activity(
        self,
        *,
        session_key: str,
        turn_id: str,
        action: str,
        status: str,
        label: str,
        approx_input_tokens: int,
        output_tokens_received: int,
        duration_ms: float,
    ) -> None:
        self._validate_session_key(session_key)
        self._validate_message_text(turn_id, label="turn_id")
        self._validate_message_text(action, label="action")
        if status not in {"started", "completed"}:
            raise ValueError(f"Unsupported AI activity status: {status}")
        self._validate_message_text(label, label="label")
        if (
            not isinstance(approx_input_tokens, int)
            or isinstance(approx_input_tokens, bool)
            or approx_input_tokens < 1
        ):
            raise ValueError("AI activity approximate input tokens must be positive")
        if (
            not isinstance(output_tokens_received, int)
            or isinstance(output_tokens_received, bool)
            or output_tokens_received < 0
        ):
            raise ValueError("AI activity output tokens must be non-negative")
        if (
            not isinstance(duration_ms, (int, float))
            or isinstance(duration_ms, bool)
            or not math.isfinite(duration_ms)
            or duration_ms < 0
        ):
            raise ValueError("AI activity duration must be non-negative and finite")
        with self._lock:
            self._require_streaming_turn(session_key=session_key, turn_id=turn_id)
            session_activities = self._activities.get(session_key)
            if session_activities is None or turn_id not in session_activities:
                raise RuntimeError("AI activity list missing for streaming turn")
            session_activities[turn_id].append(
                {
                    "action": action,
                    "status": status,
                    "label": label,
                    "approx_input_tokens": approx_input_tokens,
                    "output_tokens_received": output_tokens_received,
                    "duration_ms": float(duration_ms),
                }
            )

    def append_delta(
        self,
        *,
        session_key: str,
        turn_id: str,
        delta_kind: str,
        text: str,
    ) -> None:
        self._validate_session_key(session_key)
        self._validate_message_text(turn_id, label="turn_id")
        if delta_kind not in {"thinking", "content"}:
            raise ValueError(f"Unsupported AI delta kind: {delta_kind}")
        if not isinstance(text, str) or text == "":
            raise ValueError("AI delta text must be a non-empty string")
        with self._lock:
            message = self._require_streaming_turn(
                session_key=session_key,
                turn_id=turn_id,
            )
            updated_text = message[delta_kind] + text
            if len(updated_text) > _MAX_MESSAGE_CHARACTERS:
                raise RuntimeError(f"AI {delta_kind} exceeded {_MAX_MESSAGE_CHARACTERS} characters")
            message[delta_kind] = updated_text

    def complete_turn(
        self,
        *,
        session_key: str,
        turn_id: str,
        final_content: str,
    ) -> None:
        self._validate_session_key(session_key)
        self._validate_message_text(turn_id, label="turn_id")
        self._validate_message_text(final_content, label="final_content")
        with self._lock:
            message = self._require_streaming_turn(
                session_key=session_key,
                turn_id=turn_id,
            )
            message["content"] = final_content
            message["status"] = "complete"

    def is_streaming(self, *, session_key: str, turn_id: str) -> bool:
        with self._lock:
            return any(message['id'] == turn_id and message['status'] == 'streaming'
                       for message in self._sessions.get(session_key, []))

    def fail_turn(self, *, session_key: str, turn_id: str, error: str) -> None:
        self._validate_session_key(session_key)
        self._validate_message_text(turn_id, label="turn_id")
        self._validate_message_text(error, label="error")
        with self._lock:
            message = self._require_streaming_turn(
                session_key=session_key,
                turn_id=turn_id,
            )
            message["status"] = "error"
            message["error"] = error

    def synchronize_disclosure_boundary(self, *, session_key: str, disclosure_key: str) -> None:
        """Retain the display transcript, but never replay a previous disclosure context."""
        self._validate_session_key(session_key)
        if not disclosure_key:
            raise ValueError("A disclosure boundary key is required")
        with self._lock:
            if self._disclosure_keys.get(session_key) != disclosure_key:
                self._history_starts[session_key] = len(self._sessions.get(session_key, []))
                self._disclosure_keys[session_key] = disclosure_key

    def provider_messages(self, *, session_key: str) -> list[dict[str, str]]:
        self._validate_session_key(session_key)
        with self._lock:
            messages = self._sessions.get(session_key, [])
            assert len(messages) % 2 == 0, "AI chat history must contain complete turn pairs"
            provider_messages: list[dict[str, str]] = []
            start = self._history_starts.get(session_key, 0)
            for index in range(start, len(messages), 2):
                user_message = messages[index]
                assistant_message = messages[index + 1]
                assert user_message["role"] == "user"
                assert user_message["status"] == "complete"
                assert assistant_message["role"] == "assistant"
                if assistant_message["status"] == "error":
                    continue
                provider_messages.append(
                    {"role": "user", "content": user_message["content"]}
                )
                if assistant_message["status"] == "streaming":
                    assert index == len(messages) - 2, "only the current turn may be streaming"
                    continue
                assert assistant_message["status"] == "complete"
                assistant_content = assistant_message["content"]
                assert isinstance(assistant_content, str)
                provider_messages.append(
                    {
                        "role": "assistant",
                        "content": strip_note_citations_for_history(
                            assistant_content,
                        ),
                    }
                )
            return provider_messages

    def _require_streaming_turn(
        self,
        *,
        session_key: str,
        turn_id: str,
    ) -> dict[str, str]:
        messages = self._sessions.get(session_key)
        if messages is None:
            raise RuntimeError("AI chat session missing")
        for message in messages:
            if message["id"] != turn_id:
                continue
            if message["role"] != "assistant":
                raise RuntimeError("AI turn id does not identify an assistant message")
            if message["status"] != "streaming":
                raise RuntimeError("AI turn is not streaming")
            return message
        raise RuntimeError("AI streaming turn missing")

    @staticmethod
    def _validate_session_key(session_key: str) -> None:
        if not isinstance(session_key, str) or session_key == "":
            raise ValueError("session_key must be a non-empty string")

    @staticmethod
    def _validate_message_text(value: str, *, label: str) -> None:
        if not isinstance(label, str) or label == "":
            raise ValueError("label must be a non-empty string")
        if not isinstance(value, str) or value.strip() == "":
            raise ValueError(f"{label} must be a non-empty string")
        if len(value) > _MAX_MESSAGE_CHARACTERS:
            raise ValueError(f"{label} exceeds {_MAX_MESSAGE_CHARACTERS} characters")


ai_chat_store = AiChatSessionStore()
