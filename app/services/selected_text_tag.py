from __future__ import annotations

from collections.abc import Mapping
import re

from app.config import TAG_SUGGESTION_CONNECTORS


MAX_SELECTED_TEXT_TAG_CHARACTERS = 25
# Tags keep printable ASCII only: space (0x20) through tilde (0x7E).
_FIRST_PRINTABLE_ASCII_CODEPOINT = ord(" ")
_LAST_PRINTABLE_ASCII_CODEPOINT = ord("~")

_TAG_CONTAINS_DISALLOWED = frozenset(
    {
        ":",
        ",",
        '"',
        "\\",
        ">",
        "<",
        "=",
        "[",
        "]",
        "{",
        "}",
        "(",
        ")",
        "*",
        "|",
        ";",
        "~",
        "`",
    }
)
_TOKEN_START_DISALLOWED = frozenset({"-", "+", "/"})
_WHITESPACE_RE = re.compile(r"\s+")
_EQUIVALENCE_SEPARATOR_RE = re.compile(
    f"[{re.escape(TAG_SUGGESTION_CONNECTORS)}\\s]+"
)


class SelectedTextTagValidationError(ValueError):
    """The user's selected text cannot produce a valid tag."""


def _normalize_selected_text(selected_text: str) -> str:
    if not isinstance(selected_text, str):
        raise TypeError("selected_text must be a string")
    if len(selected_text) > MAX_SELECTED_TEXT_TAG_CHARACTERS:
        raise SelectedTextTagValidationError(
            f"Selected text must be {MAX_SELECTED_TEXT_TAG_CHARACTERS} characters or fewer"
        )

    normalized = _WHITESPACE_RE.sub(" ", selected_text).strip()
    if normalized == "":
        raise SelectedTextTagValidationError("Selected text must not be blank")
    return normalized


def build_default_tag_from_selected_text(selected_text: str) -> str:
    normalized = _normalize_selected_text(selected_text)
    spaces_joined = normalized.replace(" ", "-")

    candidate_characters: list[str] = []
    for char in spaces_joined:
        codepoint = ord(char)
        if codepoint < _FIRST_PRINTABLE_ASCII_CODEPOINT or codepoint > _LAST_PRINTABLE_ASCII_CODEPOINT:
            continue
        if char in _TAG_CONTAINS_DISALLOWED:
            continue
        candidate_characters.append(char)

    candidate = "".join(candidate_characters)
    while candidate and candidate[0] in _TOKEN_START_DISALLOWED:
        candidate = candidate[1:]

    if candidate == "":
        raise SelectedTextTagValidationError(
            "Selected text does not contain usable tag characters"
        )
    if candidate == "OR":
        raise SelectedTextTagValidationError("OR is reserved for search")
    if any(char.isspace() for char in candidate):
        raise RuntimeError("Generated selected-text tag contains whitespace")
    return candidate


def _tag_equivalence_key(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    return _EQUIVALENCE_SEPARATOR_RE.sub(" ", text.casefold()).strip()


def find_equivalent_existing_tag(
    *,
    selected_text: str,
    existing_tag_frequencies: Mapping[str, int],
) -> str | None:
    default_tag = build_default_tag_from_selected_text(selected_text)
    selection_key = _tag_equivalence_key(default_tag)
    if selection_key == "":
        raise SelectedTextTagValidationError(
            "Selected text does not contain usable tag characters"
        )

    matches: list[tuple[str, int]] = []
    for tag, frequency in existing_tag_frequencies.items():
        if not isinstance(tag, str) or tag == "":
            raise TypeError("existing tag names must be non-empty strings")
        if not isinstance(frequency, int) or frequency < 0:
            raise TypeError("existing tag frequencies must be non-negative integers")
        if _tag_equivalence_key(tag) == selection_key:
            matches.append((tag, frequency))

    if not matches:
        return None

    matches.sort(key=lambda item: (-item[1], item[0].casefold(), item[0]))
    return matches[0][0]


def resolve_selected_text_tag(
    *,
    selected_text: str,
    existing_tag_frequencies: Mapping[str, int],
) -> str:
    existing_tag = find_equivalent_existing_tag(
        selected_text=selected_text,
        existing_tag_frequencies=existing_tag_frequencies,
    )
    if existing_tag is not None:
        return existing_tag
    return build_default_tag_from_selected_text(selected_text)
