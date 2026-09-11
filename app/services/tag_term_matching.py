from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import re

from app.config import TAG_SUGGESTION_CONNECTORS


_CONNECTOR_CHARS = TAG_SUGGESTION_CONNECTORS
if not isinstance(_CONNECTOR_CHARS, str):
    raise TypeError("TAG_SUGGESTION_CONNECTORS must be a string")
if _CONNECTOR_CHARS == "":
    raise ValueError("TAG_SUGGESTION_CONNECTORS must be non-empty")
if any(char.isspace() for char in _CONNECTOR_CHARS):
    raise ValueError("TAG_SUGGESTION_CONNECTORS must not include whitespace")

_CONNECTOR_RE = re.compile(f"[{re.escape(_CONNECTOR_CHARS)}]")
_MATCH_NOISE_RE = re.compile(r"[^\w@#+%&']+")
_WHITESPACE_RE = re.compile(r"\s+")
_NUMERIC_SEGMENT_RE = re.compile(r"^\d+$")
_LOW_SIGNAL_CONTENT_MATCH_SEGMENTS = frozenset(
    {
        "an",
        "and",
        "as",
        "at",
        "be",
        "but",
        "by",
        "for",
        "from",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "no",
        "nor",
        "not",
        "of",
        "off",
        "on",
        "or",
        "out",
        "per",
        "the",
        "than",
        "to",
        "too",
        "up",
        "via",
        "with",
    }
)
_LOW_SIGNAL_UPPERCASE_SINGLE_LETTER_SEGMENTS = frozenset({"a", "i"})


@dataclass(frozen=True, slots=True)
class TagContentMatch:
    raw_phrase_match: bool
    raw_partial_phrase_match: bool
    raw_partial_phrase_segment_count: int
    raw_partial_phrase_position: int
    phrase_match: bool
    matched_segment_count: int
    matched_segments: tuple[str, ...]
    segment_count: int
    raw_segment_count: int
    first_matched_raw_segment_index: int
    raw_phrase_position: int
    first_position: int
    normalized_length: int

    def sort_key(self) -> tuple[int, ...]:
        phrase_match_score = 0
        if self.phrase_match:
            phrase_match_score = 1
        raw_phrase_match_score = 0
        raw_partial_phrase_match_score = 0
        raw_phrase_specificity_score = 0
        raw_phrase_position_score = 0
        if self.raw_phrase_match:
            raw_phrase_match_score = 1
            raw_phrase_specificity_score = self.raw_segment_count
            raw_phrase_position_score = -self.raw_phrase_position
        elif self.raw_partial_phrase_match:
            raw_partial_phrase_match_score = 1
            raw_phrase_specificity_score = self.raw_partial_phrase_segment_count
            raw_phrase_position_score = -self.raw_partial_phrase_position
        return (
            raw_phrase_match_score,
            raw_partial_phrase_match_score,
            raw_phrase_specificity_score,
            raw_phrase_position_score,
            phrase_match_score,
            self.matched_segment_count,
            self.segment_count,
            -self.raw_segment_count,
            -self.first_matched_raw_segment_index,
            -self.first_position,
            self.normalized_length,
        )


@dataclass(frozen=True, slots=True)
class NormalizedContentMatchContext:
    tokens: tuple[str, ...]
    token_positions: dict[str, int]

    def matches_phrase_at(self, segments: tuple[str, ...], index: int) -> bool:
        assert segments
        assert 0 <= index <= len(self.tokens)
        tokens = self.tokens[index : index + len(segments)]
        if len(tokens) != len(segments):
            return False
        return all(
            token == segment or token == segment + "'s"
            for token, segment in zip(tokens, segments)
        )


def normalize_tag_match_text(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    casefolded = text.casefold().replace("’", "'")
    connectors_as_spaces = _CONNECTOR_RE.sub(" ", casefolded)
    stripped_noise = _MATCH_NOISE_RE.sub(" ", connectors_as_spaces)
    return _WHITESPACE_RE.sub(" ", stripped_noise).strip()


def split_tag_term_segments(term: str) -> tuple[str, ...]:
    if not isinstance(term, str):
        raise TypeError("term must be a string")

    return _split_tag_term_segments_cached(term)


@lru_cache(maxsize=32768)
def _split_tag_term_segments_cached(term: str) -> tuple[str, ...]:
    normalized = normalize_tag_match_text(term)
    if normalized == "":
        return ()
    return tuple(segment for segment in normalized.split(" ") if segment)


def split_tag_term_segments_preserving_case(term: str) -> tuple[str, ...]:
    if not isinstance(term, str):
        raise TypeError("term must be a string")

    return _split_tag_term_segments_preserving_case_cached(term)


@lru_cache(maxsize=32768)
def _split_tag_term_segments_preserving_case_cached(term: str) -> tuple[str, ...]:
    connectors_as_spaces = _CONNECTOR_RE.sub(" ", term.replace("’", "'"))
    stripped_noise = _MATCH_NOISE_RE.sub(" ", connectors_as_spaces)
    normalized_whitespace = _WHITESPACE_RE.sub(" ", stripped_noise).strip()
    if normalized_whitespace == "":
        return ()
    return tuple(segment for segment in normalized_whitespace.split(" ") if segment)


def _is_significant_content_match_segment(*, segment: str, raw_segment: str) -> bool:
    if not isinstance(segment, str):
        raise TypeError("segment must be a string")
    if not isinstance(raw_segment, str):
        raise TypeError("raw_segment must be a string")
    if len(segment) < 2:
        return (
            len(segment) == 1
            and raw_segment.isalpha()
            and raw_segment == raw_segment.upper()
            and raw_segment != raw_segment.lower()
            and segment not in _LOW_SIGNAL_UPPERCASE_SINGLE_LETTER_SEGMENTS
        )
    if _NUMERIC_SEGMENT_RE.fullmatch(segment):
        return False
    if segment in _LOW_SIGNAL_CONTENT_MATCH_SEGMENTS:
        return False
    return True


def list_significant_content_match_segments(term: str) -> tuple[str, ...]:
    if not isinstance(term, str):
        raise TypeError("term must be a string")

    return _list_significant_content_match_segments_cached(term)


@lru_cache(maxsize=32768)
def _list_significant_content_match_segments_cached(term: str) -> tuple[str, ...]:
    raw_segments = split_tag_term_segments_preserving_case(term)
    return tuple(
        raw_segment.casefold()
        for raw_segment in raw_segments
        if _is_significant_content_match_segment(
            segment=raw_segment.casefold(),
            raw_segment=raw_segment,
        )
    )


def _list_significant_content_match_segments_with_raw_indexes(
    term: str,
) -> tuple[tuple[str, ...], tuple[int, ...], int]:
    if not isinstance(term, str):
        raise TypeError("term must be a string")

    return _list_significant_content_match_segments_with_raw_indexes_cached(term)


@lru_cache(maxsize=32768)
def _list_significant_content_match_segments_with_raw_indexes_cached(
    term: str,
) -> tuple[tuple[str, ...], tuple[int, ...], int]:
    raw_segments = split_tag_term_segments_preserving_case(term)
    significant_segments: list[str] = []
    significant_raw_indexes: list[int] = []
    for raw_index, raw_segment in enumerate(raw_segments):
        normalized_segment = raw_segment.casefold()
        if not _is_significant_content_match_segment(
            segment=normalized_segment,
            raw_segment=raw_segment,
        ):
            continue
        significant_segments.append(normalized_segment)
        significant_raw_indexes.append(raw_index)
    return (
        tuple(significant_segments),
        tuple(significant_raw_indexes),
        len(raw_segments),
    )


def tag_term_matches_prefix(*, term: str, prefix: str) -> bool:
    if not isinstance(term, str):
        raise TypeError("term must be a string")
    if not isinstance(prefix, str):
        raise TypeError("prefix must be a string")
    if prefix == "":
        return True

    prefix_casefold = prefix.casefold()
    if term.casefold().startswith(prefix_casefold):
        return True

    for segment in split_tag_term_segments(term):
        if segment.startswith(prefix_casefold):
            return True
    return False


def build_normalized_content_match_context(*, normalized_content: str) -> NormalizedContentMatchContext:
    if not isinstance(normalized_content, str):
        raise TypeError("normalized_content must be a string")

    content_tokens = tuple(normalized_content.split())
    token_positions: dict[str, int] = {}
    for index, token in enumerate(content_tokens):
        if token not in token_positions:
            token_positions[token] = index
        # Keep the full token available for tags that contain an apostrophe.
        if token.endswith("'s") and len(token) > 2:
            base_token = token[:-2]
            if base_token not in token_positions:
                token_positions[base_token] = index
    return NormalizedContentMatchContext(tokens=content_tokens, token_positions=token_positions)


def match_tag_term_in_content_match_context(
    *,
    term: str,
    context: NormalizedContentMatchContext,
) -> TagContentMatch | None:
    if not isinstance(term, str):
        raise TypeError("term must be a string")
    if not isinstance(context, NormalizedContentMatchContext):
        raise TypeError("context must be a NormalizedContentMatchContext")

    raw_segments = split_tag_term_segments(term)
    segments, segment_raw_indexes, raw_segment_count = _list_significant_content_match_segments_with_raw_indexes(term)
    if not segments:
        return None

    raw_phrase_match = False
    raw_phrase_position = -1
    if len(context.tokens) >= len(raw_segments):
        for index in range(len(context.tokens) - len(raw_segments) + 1):
            if context.matches_phrase_at(raw_segments, index):
                raw_phrase_match = True
                raw_phrase_position = index
                break

    raw_partial_phrase_match = False
    raw_partial_phrase_segment_count = 0
    raw_partial_phrase_position = -1
    partial_phrase_segment_count = raw_segment_count - 1
    if not raw_phrase_match and partial_phrase_segment_count >= 2:
        significant_raw_index_set = set(segment_raw_indexes)
        for raw_start_index in range(raw_segment_count - partial_phrase_segment_count + 1):
            raw_end_index = raw_start_index + partial_phrase_segment_count
            if not any(
                raw_index in significant_raw_index_set
                for raw_index in range(raw_start_index, raw_end_index)
            ):
                continue
            raw_partial_phrase = raw_segments[raw_start_index:raw_end_index]
            if len(context.tokens) < partial_phrase_segment_count:
                continue
            for content_index in range(len(context.tokens) - partial_phrase_segment_count + 1):
                if not context.matches_phrase_at(raw_partial_phrase, content_index):
                    continue
                raw_partial_phrase_match = True
                raw_partial_phrase_segment_count = partial_phrase_segment_count
                raw_partial_phrase_position = content_index
                break
            if raw_partial_phrase_match:
                break

    phrase = " ".join(segments)

    phrase_match = False
    phrase_position = -1
    if len(context.tokens) >= len(segments):
        for index in range(len(context.tokens) - len(segments) + 1):
            if context.matches_phrase_at(segments, index):
                phrase_match = True
                phrase_position = index
                break

    matched_segments: list[str] = []
    matched_segment_count = 0
    matched_positions: list[int] = []
    matched_raw_indexes: list[int] = []
    for raw_index, segment in zip(segment_raw_indexes, segments):
        if segment in matched_segments:
            continue
        if segment in context.token_positions:
            matched_segments.append(segment)
            matched_segment_count += 1
            matched_positions.append(context.token_positions[segment])
            matched_raw_indexes.append(raw_index)

    # Numeric version chunks retain phrase-ranking evidence, but must not make
    # a tag harder to match than its non-numeric counterpart.
    non_numeric_segment_count = sum(
        1 for segment in raw_segments if not _NUMERIC_SEGMENT_RE.fullmatch(segment)
    )
    required_matched_segment_count = max(
        1,
        min(len(segments), non_numeric_segment_count - 1),
    )
    if matched_segment_count < required_matched_segment_count and not raw_partial_phrase_match:
        return None

    assert matched_raw_indexes

    first_position = phrase_position
    if not phrase_match:
        assert matched_positions
        first_position = min(matched_positions)

    return TagContentMatch(
        raw_phrase_match=raw_phrase_match,
        raw_partial_phrase_match=raw_partial_phrase_match,
        raw_partial_phrase_segment_count=raw_partial_phrase_segment_count,
        raw_partial_phrase_position=raw_partial_phrase_position,
        phrase_match=phrase_match,
        matched_segment_count=matched_segment_count,
        matched_segments=tuple(matched_segments),
        segment_count=len(segments),
        raw_segment_count=raw_segment_count,
        first_matched_raw_segment_index=min(matched_raw_indexes),
        raw_phrase_position=raw_phrase_position,
        first_position=first_position,
        normalized_length=len(phrase),
    )


def match_tag_term_in_normalized_content(*, term: str, normalized_content: str) -> TagContentMatch | None:
    if not isinstance(term, str):
        raise TypeError("term must be a string")
    context = build_normalized_content_match_context(normalized_content=normalized_content)
    return match_tag_term_in_content_match_context(term=term, context=context)


__all__ = [
    "build_normalized_content_match_context",
    "match_tag_term_in_content_match_context",
    "NormalizedContentMatchContext",
    "TagContentMatch",
    "list_significant_content_match_segments",
    "match_tag_term_in_normalized_content",
    "normalize_tag_match_text",
    "split_tag_term_segments",
    "split_tag_term_segments_preserving_case",
    "tag_term_matches_prefix",
]
