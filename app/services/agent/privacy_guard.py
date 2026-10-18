"""Stop an AI request once the cloud privacy settings change while it runs.

A request's notes are judged by the privacy rules once, when it starts (the
boundary resolved at Send). If the user tightens the rules while it is still
running (bulk tagging waiting on its scope card, Suggest Tags sending its later
batches, a chat run several model turns in), what it would send next was judged
under the old rules. So every AI connection is wrapped in a guard that remembers
the settings' revision at the start and refuses to send once it has moved.
Provider-neutral: it wraps whichever adapter connect_to_ai builds.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from threading import Lock

from app.services.agent.inference import InferenceAdapter
from app.services.agent.inference import InferenceProviderError


class CloudPrivacyRevision:
    """Counts the saves that changed the cloud privacy policy."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._value = 0

    def current(self) -> int:
        with self._lock:
            return self._value

    def advance(self) -> None:
        with self._lock:
            self._value += 1


cloud_privacy_revision = CloudPrivacyRevision()


class CloudPrivacyChanged(InferenceProviderError):
    def __init__(self) -> None:
        super().__init__(
            "Your cloud privacy settings changed while this was running, so it stopped "
            "before sending anything more to the AI. Ask again to use the new settings."
        )


class PrivacyGuardedInference:
    """An InferenceAdapter that sends only while the privacy settings are as they were at its start."""

    def __init__(self, *, inner: InferenceAdapter, privacy_revision_at_start: int) -> None:
        if not isinstance(privacy_revision_at_start, int):
            raise TypeError("privacy_revision_at_start must be an int")
        self._inner = inner
        self._privacy_revision_at_start = privacy_revision_at_start

    def _require_privacy_unchanged(self) -> None:
        if cloud_privacy_revision.current() != self._privacy_revision_at_start:
            raise CloudPrivacyChanged()

    @property
    def provider_label(self) -> str:
        return self._inner.provider_label

    # Reads the model's limits; sends no note text.
    async def inspect_context_window(self, **arguments):
        return await self._inner.inspect_context_window(**arguments)

    async def infer_structured(self, **arguments):
        self._require_privacy_unchanged()
        return await self._inner.infer_structured(**arguments)

    async def stream_text(self, **arguments) -> AsyncIterator[dict[str, object]]:
        self._require_privacy_unchanged()
        async for event in self._inner.stream_text(**arguments):
            yield event

    async def stream_tool_turn(self, **arguments) -> AsyncIterator[dict[str, object]]:
        self._require_privacy_unchanged()
        async for event in self._inner.stream_tool_turn(**arguments):
            yield event
