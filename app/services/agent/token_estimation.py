"""Provider-neutral token estimates for budgets and diagnostic feedback."""

from __future__ import annotations

import json
import unicodedata

# Added before dividing a letter run, so it rounds to the nearest token.
_LETTER_RUN_ROUNDING = 2
_DIGITS_PER_TOKEN = 3
_UTF8_BYTES_PER_TOKEN = 3
# Chat framing: the reply is primed with a few tokens, and each message adds its own.
REPLY_PRIMING_TOKENS = 3
PER_MESSAGE_OVERHEAD_TOKENS = 3


def estimate_text_tokens(text: str) -> int:
    """Estimate tokenizer cost without binding the harness to one model family."""
    if not isinstance(text, str):
        raise TypeError("Token estimation text must be a string")
    if text == "":
        return 1

    estimate = 0
    index = 0
    while index < len(text):
        character = text[index]
        if character.isascii() and character.isalpha():
            end = index + 1
            while end < len(text) and text[end].isascii() and text[end].isalpha():
                end += 1
            run_length = end - index
            estimate += max(1, (run_length + _LETTER_RUN_ROUNDING) // 4)
            index = end
            continue
        if character.isascii() and character.isdecimal():
            end = index + 1
            while end < len(text) and text[end].isascii() and text[end].isdecimal():
                end += 1
            run_length = end - index
            # Rounds a partial token up.
            estimate += (run_length + _DIGITS_PER_TOKEN - 1) // _DIGITS_PER_TOKEN
            index = end
            continue
        if character.isspace():
            if character in {"\n", "\r", "\t"}:
                estimate += 1
            index += 1
            continue
        if character.isascii():
            estimate += 1
            index += 1
            continue

        end = index + 1
        while end < len(text):
            candidate = text[end]
            if candidate.isascii() or candidate.isspace():
                break
            if unicodedata.category(candidate).startswith("P"):
                break
            end += 1
        utf8_byte_count = len(text[index:end].encode("utf-8"))
        estimate += max(1, (utf8_byte_count + _UTF8_BYTES_PER_TOKEN - 1) // _UTF8_BYTES_PER_TOKEN)
        index = end

    return max(1, estimate)


def estimate_input_tokens(value: object) -> int:
    """Estimate tokens from the compact JSON representation sent or retained."""
    serialized_value = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return estimate_text_tokens(serialized_value)


def estimate_message_tokens(messages: list[dict[str, str]]) -> int:
    """Estimate decoded chat messages without counting HTTP JSON escaping."""
    if not isinstance(messages, list) or not messages:
        raise ValueError("Message token estimation requires a non-empty message list")
    estimate = REPLY_PRIMING_TOKENS
    for message in messages:
        if not isinstance(message, dict):
            raise TypeError("Each estimated message must be an object")
        if set(message) != {"role", "content"}:
            raise ValueError("Estimated messages require exactly role and content")
        role = message["role"]
        content = message["content"]
        if not isinstance(role, str) or role == "":
            raise ValueError("Estimated message role must be non-empty text")
        if not isinstance(content, str):
            raise TypeError("Estimated message content must be text")
        estimate += PER_MESSAGE_OVERHEAD_TOKENS
        estimate += estimate_text_tokens(role)
        estimate += estimate_text_tokens(content)
    return estimate
