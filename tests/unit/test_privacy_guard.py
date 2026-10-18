"""An AI request stops before sending anything more once the cloud privacy
settings change while it runs: it was judged under the old settings."""

import asyncio

import pytest

from app.services.agent.privacy_guard import CloudPrivacyChanged, PrivacyGuardedInference, cloud_privacy_revision


class _RecordingInference:
    provider_label = "Recording"

    def __init__(self):
        self.calls = []

    async def inspect_context_window(self, **arguments):
        self.calls.append("inspect_context_window")
        return "window"

    async def infer_structured(self, **arguments):
        self.calls.append("infer_structured")
        return "structured"

    async def stream_text(self, **arguments):
        self.calls.append("stream_text")
        yield {"type": "done"}

    async def stream_tool_turn(self, **arguments):
        self.calls.append("stream_tool_turn")
        yield {"type": "done"}


async def _collect(stream):
    return [event async for event in stream]


def test_requests_pass_through_while_the_privacy_settings_are_unchanged():
    inner = _RecordingInference()
    guarded = PrivacyGuardedInference(inner=inner, privacy_revision_at_start=cloud_privacy_revision.current())
    assert guarded.provider_label == "Recording"
    assert asyncio.run(guarded.infer_structured(messages=[])) == "structured"
    assert asyncio.run(_collect(guarded.stream_text(messages=[]))) == [{"type": "done"}]
    assert asyncio.run(_collect(guarded.stream_tool_turn(messages=[]))) == [{"type": "done"}]
    assert inner.calls == ["infer_structured", "stream_text", "stream_tool_turn"]


@pytest.mark.parametrize("send", [
    lambda guarded: asyncio.run(guarded.infer_structured(messages=[])),
    lambda guarded: asyncio.run(_collect(guarded.stream_text(messages=[]))),
    lambda guarded: asyncio.run(_collect(guarded.stream_tool_turn(messages=[]))),
])
def test_nothing_more_is_sent_once_the_privacy_settings_change(send):
    inner = _RecordingInference()
    guarded = PrivacyGuardedInference(inner=inner, privacy_revision_at_start=cloud_privacy_revision.current())
    cloud_privacy_revision.advance()
    with pytest.raises(CloudPrivacyChanged, match="privacy settings changed"):
        send(guarded)
    assert inner.calls == [], "the provider was not called"


def test_reading_the_context_window_sends_no_note_text_and_is_not_stopped():
    inner = _RecordingInference()
    guarded = PrivacyGuardedInference(inner=inner, privacy_revision_at_start=cloud_privacy_revision.current())
    cloud_privacy_revision.advance()
    assert asyncio.run(guarded.inspect_context_window(base_url="x", model="m")) == "window"
