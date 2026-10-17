from __future__ import annotations

from app.services.resource_limits import SENSITIVE_MEMO_BYTES
from dataclasses import dataclass
from app.security.sensitive_cache import sensitive_lru_cache
import re
from urllib.parse import urlsplit

from app.config import TAG_SUGGESTION_CONNECTORS
from app.utils.text_utils import strip_html


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
# A web address written in a note: a scheme (https://) or a leading www.
_URL_RE = re.compile(r"(?<![\w@])(?:[a-z][a-z0-9+.-]*://|www\.)[^\s<>\"]+", re.IGNORECASE)
# Host labels that say nothing about a site.
_GENERIC_HOST_PREFIXES = frozenset({"www", "m", "mobile"})
_URL_AUTHORITY_RE = re.compile(r"[^/?#]*")
# Second-level labels of country suffixes (bbc.co.uk is "bbc").
_SECOND_LEVEL_SUFFIXES = frozenset({"co", "com", "org", "net", "gov", "ac", "edu"})


def note_text_for_tag_matching(content_html: str) -> str:
    """A note's text as tags are matched against it.

    A web address counts only by its site's name: `https://www.youtube.com/watch?v=GYx4`
    reads as `youtube`. Its scheme, `www`, top-level domain, path and query say nothing
    about the note, yet would otherwise name tags such as `HTTPS` or `V-neuron`.
    """
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    plaintext = _URL_RE.sub(lambda url: f" {site_name_of_url(url.group(0))} ", strip_html(content_html))
    return normalize_tag_match_text(plaintext)


def site_name_of_url(url: str) -> str:
    """The site's own name in a web address (`youtube`, `wikipedia`, `bbc`), or "" when it has none."""
    if not isinstance(url, str):
        raise TypeError("url must be a string")
    candidate = url
    if "://" not in candidate:
        candidate = "http://" + candidate
    # An IPv6 host ([::1]) has no site name, and urlsplit rejects a broken one.
    authority = _URL_AUTHORITY_RE.match(candidate.split("://", 1)[1]).group(0)
    if "[" in authority or "]" in authority:
        return ""
    host = urlsplit(candidate).hostname
    if host is None:
        return ""
    labels = [label for label in host.split(".") if label != ""]
    if labels and all(label.isdigit() for label in labels):
        return ""
    if len(labels) > 1 and labels[0] in _GENERIC_HOST_PREFIXES:
        labels = labels[1:]
    if len(labels) > 1:
        labels = labels[:-1]
    if len(labels) > 1 and labels[-1] in _SECOND_LEVEL_SUFFIXES:
        labels = labels[:-1]
    if not labels:
        return ""
    return labels[-1]
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
_WORD_JOINER_RE = re.compile(r"[-_]+")
# Shorter segments count only as a lone capital letter ("C", "R").
_MIN_SIGNIFICANT_SEGMENT_CHARS = 2
_POSSESSIVE_SUFFIX = "'s"
# A partial phrase match (all but one of a tag's words) needs at least this many words.
_MIN_PARTIAL_PHRASE_SEGMENTS = 2


@dataclass(frozen=True, slots=True)
class TagContentMatch:
    # The tag spelling that was matched, and the indexes of its raw segments
    # found in the content: the whole phrase, the partial phrase, or each
    # matched segment (tag suggestions quote them to say why).
    term: str
    evidence_raw_indexes: tuple[int, ...]
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
    # Every ascending index where a segment matches a token (the token itself
    # or its possessive), so phrase lookups visit only real candidate starts
    # instead of scanning every content position.
    segment_match_indexes: dict[str, tuple[int, ...]]

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

    def find_first_phrase_index(self, segments: tuple[str, ...]) -> int:
        """Return the earliest index where `segments` match, or -1."""
        assert segments
        for segment in segments:
            if segment not in self.segment_match_indexes:
                return -1
        for index in self.segment_match_indexes[segments[0]]:
            if self.matches_phrase_at(segments, index):
                return index
        return -1


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


@sensitive_lru_cache(maxsize=32768, max_bytes=SENSITIVE_MEMO_BYTES)
def _split_tag_term_segments_cached(term: str) -> tuple[str, ...]:
    normalized = normalize_tag_match_text(term)
    if normalized == "":
        return ()
    return tuple(segment for segment in normalized.split(" ") if segment)


def split_tag_term_segments_preserving_case(term: str) -> tuple[str, ...]:
    if not isinstance(term, str):
        raise TypeError("term must be a string")

    return _split_tag_term_segments_preserving_case_cached(term)


@sensitive_lru_cache(maxsize=32768, max_bytes=SENSITIVE_MEMO_BYTES)
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
    if len(segment) < _MIN_SIGNIFICANT_SEGMENT_CHARS:
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


@sensitive_lru_cache(maxsize=32768, max_bytes=SENSITIVE_MEMO_BYTES)
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


@sensitive_lru_cache(maxsize=32768, max_bytes=SENSITIVE_MEMO_BYTES)
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
    match_indexes: dict[str, list[int]] = {}

    def record_match(segment: str, index: int) -> None:
        if segment not in match_indexes:
            match_indexes[segment] = []
        match_indexes[segment].append(index)

    for index, token in enumerate(content_tokens):
        record_match(token, index)
        # Keep the full token available for tags that contain an apostrophe.
        if token.endswith(_POSSESSIVE_SUFFIX) and len(token) > len(_POSSESSIVE_SUFFIX):
            record_match(token[:-len(_POSSESSIVE_SUFFIX)], index)
    segment_match_indexes = {segment: tuple(indexes) for segment, indexes in match_indexes.items()}
    token_positions = {segment: indexes[0] for segment, indexes in segment_match_indexes.items()}
    return NormalizedContentMatchContext(
        tokens=content_tokens,
        token_positions=token_positions,
        segment_match_indexes=segment_match_indexes,
    )


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

    raw_phrase_position = context.find_first_phrase_index(raw_segments)
    raw_phrase_match = raw_phrase_position >= 0

    raw_partial_phrase_match = False
    raw_partial_phrase_segment_count = 0
    raw_partial_phrase_position = -1
    raw_partial_phrase_indexes: tuple[int, ...] = ()
    partial_phrase_segment_count = raw_segment_count - 1
    if not raw_phrase_match and partial_phrase_segment_count >= _MIN_PARTIAL_PHRASE_SEGMENTS:
        significant_raw_index_set = set(segment_raw_indexes)
        for raw_start_index in range(raw_segment_count - partial_phrase_segment_count + 1):
            raw_end_index = raw_start_index + partial_phrase_segment_count
            if not any(
                raw_index in significant_raw_index_set
                for raw_index in range(raw_start_index, raw_end_index)
            ):
                continue
            raw_partial_phrase = raw_segments[raw_start_index:raw_end_index]
            content_index = context.find_first_phrase_index(raw_partial_phrase)
            if content_index < 0:
                continue
            raw_partial_phrase_match = True
            raw_partial_phrase_segment_count = partial_phrase_segment_count
            raw_partial_phrase_position = content_index
            raw_partial_phrase_indexes = tuple(range(raw_start_index, raw_end_index))
            break

    phrase = " ".join(segments)

    phrase_position = context.find_first_phrase_index(segments)
    phrase_match = phrase_position >= 0

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
    # One letter alone does not name a tag that has real words: a stray `v`
    # is not `V-neuron`. Tags made only of letters (`X-Y-Z`, `Z`) still match.
    if (
        matched_segment_count == 1 and len(matched_segments[0]) == 1
        and any(len(segment) > 1 for segment in segments)
    ):
        return None

    assert matched_raw_indexes

    first_position = phrase_position
    if not phrase_match:
        assert matched_positions
        first_position = min(matched_positions)

    if raw_phrase_match:
        evidence_raw_indexes = tuple(range(raw_segment_count))
    elif raw_partial_phrase_match:
        evidence_raw_indexes = raw_partial_phrase_indexes
    elif phrase_match:
        evidence_raw_indexes = tuple(segment_raw_indexes)
    else:
        evidence_raw_indexes = tuple(sorted(matched_raw_indexes))

    return TagContentMatch(
        term=term,
        evidence_raw_indexes=evidence_raw_indexes,
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


def quote_content_match(match: TagContentMatch) -> tuple[str, ...]:
    """The matched words in the tag's own capitalisation: one phrase when they
    are contiguous in the content, otherwise each word."""
    if not isinstance(match, TagContentMatch):
        raise TypeError("match must be a TagContentMatch")
    raw_segments = split_tag_term_segments_preserving_case(match.term)
    assert len(raw_segments) == len(split_tag_term_segments(match.term)), match.term
    assert match.evidence_raw_indexes, match.term
    if match.raw_phrase_match or match.raw_partial_phrase_match or match.phrase_match:
        # The tag's own text, `-` and `_` read as spaces (`5.6-sol` quotes `5.6 sol`).
        span = slice_tag_term_segments(
            term=match.term, first=match.evidence_raw_indexes[0], last=match.evidence_raw_indexes[-1],
        )
        return (_WORD_JOINER_RE.sub(" ", span),)
    return tuple(raw_segments[index] for index in match.evidence_raw_indexes)


def slice_tag_term_segments(*, term: str, first: int, last: int) -> str:
    """The tag's own text from its segment `first` through `last`, connectors kept
    (segments as `split_tag_term_segments_preserving_case` counts them)."""
    raw_segments = split_tag_term_segments_preserving_case(term)
    assert 0 <= first <= last < len(raw_segments), (term, first, last)
    text = term.replace("’", "'")
    position = 0
    starts: list[int] = []
    for segment in raw_segments:
        start = text.index(segment, position)
        starts.append(start)
        position = start + len(segment)
    return text[starts[first]:starts[last] + len(raw_segments[last])]


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
