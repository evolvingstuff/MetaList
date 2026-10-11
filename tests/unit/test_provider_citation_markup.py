"""OpenAI models sometimes wrap a citation in ChatGPT's own markup:
U+E200 "cite" U+E202 <source> U+E201. The private-use characters show as boxes
and "cite" as a stray word, in the chat and in copied text. Only our own
[[note]] / [[web:…]] citations inside it are kept.
"""

from __future__ import annotations

import asyncio
import json

from app.services.ai_chat import AiChatSessionStore
from app.services.ai_chat_stream import ChatTurnStream
from app.services.agent.web_evidence import WebEvidenceStore
from app.services.ai_chat_rendering import strip_provider_citation_markup
from app.services.note_store import NoteStore

OPEN, SEPARATOR, CLOSE = "", "", ""
NOTE = "[[3b1efae7-98b3-4675-9388-84b028e883af]]"


def _wrapped(source: str) -> str:
    return f"{OPEN}cite{SEPARATOR}{source}{CLOSE}"


def test_the_markup_around_our_citation_is_removed_and_the_citation_kept() -> None:
    text = f"More reliable and useful. {_wrapped(NOTE)} {_wrapped('[[web:abc]]')}"
    assert strip_provider_citation_markup(text, is_final=True) == f"More reliable and useful. {NOTE} [[web:abc]]"


def test_markup_naming_only_the_providers_own_sources_disappears() -> None:
    assert strip_provider_citation_markup(f"Fact {_wrapped('turn0search0')}.", is_final=True) == "Fact ."


def test_ordinary_text_and_the_word_cite_are_untouched() -> None:
    text = f"Please cite your sources {NOTE} and quote [this]."
    assert strip_provider_citation_markup(text, is_final=True) == text


def test_unfinished_markup_at_the_end_is_held_back_while_streaming() -> None:
    assert strip_provider_citation_markup(f"Useful. {OPEN}ci", is_final=False) == "Useful. "
    assert strip_provider_citation_markup(f"Useful. {OPEN}cite{SEPARATOR}[[3b1e", is_final=False) == "Useful. "
    # At the end of the answer, unfinished markup is dropped and any citation in it kept.
    assert strip_provider_citation_markup(f"Useful. {OPEN}cite{SEPARATOR}{NOTE}", is_final=True) == f"Useful. {NOTE}"


def test_stray_markup_characters_are_removed() -> None:
    assert strip_provider_citation_markup(f"A{SEPARATOR}B{CLOSE}C", is_final=True) == "ABC"


def _streamed(deltas: list[str]) -> list[dict[str, object]]:
    store = AiChatSessionStore()
    turn_id = store.start_turn(session_key="markup", user_content="question", provider="openai", model="test")
    stream = ChatTurnStream(store=store, notes=NoteStore(), session_key="markup", turn_id=turn_id,
                            initial_input_tokens=1, web_evidence_store=WebEvidenceStore())

    async def source():
        for text in deltas:
            yield {"type": "content_delta", "text": text, "reference_note_ids": [], "reference_web_ids": []}
        yield {"type": "done", "reference_note_ids": [], "reference_web_ids": [], "actions": []}

    async def consume() -> list[dict[str, object]]:
        return [json.loads(line) async for line in stream.events(source())]

    return asyncio.run(consume())


def test_the_streamed_answer_never_shows_the_markup_even_when_split_across_chunks() -> None:
    lines = _streamed(["Useful. ", f"{OPEN}ci", f"te{SEPARATOR}turn0", f"search0{CLOSE} Next."])
    deltas = [line for line in lines if line["type"] == "content_delta"]
    shown = "".join(str(line["text"]) for line in deltas)
    assert shown == "Useful.  Next."
    for line in deltas:
        assert OPEN not in str(line["rendered_text"]) and "cite" not in str(line["rendered_text"])
    done = lines[-1]
    assert done["type"] == "done"
    assert done["content"] == "Useful.  Next."
