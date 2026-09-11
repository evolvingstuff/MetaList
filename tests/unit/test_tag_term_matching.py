import pytest

from app.services.tag_term_matching import list_significant_content_match_segments
from app.services.tag_term_matching import match_tag_term_in_normalized_content
from app.services.tag_term_matching import normalize_tag_match_text


@pytest.mark.parametrize("apostrophe", ["'", "’"])
@pytest.mark.parametrize("term, body", [
    ("Julie", "Julie's birthday is today..."),
    ("Julie-Smith", "Julie Smith's birthday is today..."),
    ("goat's-milk", "I bought goat's milk today"),
    ("O'Neill", "O'Neill's birthday is today"),
])
def test_possessive_content_matches_existing_tag(
    apostrophe: str, term: str, body: str,
) -> None:
    match = match_tag_term_in_normalized_content(
        term=term,
        normalized_content=normalize_tag_match_text(body.replace("'", apostrophe)),
    )

    assert match is not None
    assert match.raw_phrase_match
    assert match.phrase_match
    assert match.first_position >= 0


@pytest.mark.parametrize("body", ["Juliet's birthday", "Julies birthday", "Julie'son", "Julie's2"])
def test_possessive_matching_keeps_word_boundaries(body: str) -> None:
    assert match_tag_term_in_normalized_content(
        term="Julie", normalized_content=normalize_tag_match_text(body),
    ) is None


def test_list_significant_content_match_segments_excludes_common_stopwords() -> None:
    assert list_significant_content_match_segments("no-propranolol") == ("propranolol",)
    assert list_significant_content_match_segments("A-Programmer's-Introduction-to-Mathematics") == (
        "programmer's",
        "introduction",
        "mathematics",
    )
    assert list_significant_content_match_segments("I-plug-in") == ("plug",)


def test_match_tag_term_in_normalized_content_ignores_stopword_only_matches() -> None:
    normalized_content = normalize_tag_match_text("No more of that I guess")

    assert match_tag_term_in_normalized_content(
        term="no-propranolol",
        normalized_content=normalized_content,
    ) is None
    assert match_tag_term_in_normalized_content(
        term="A-Programmer's-Introduction-to-Mathematics",
        normalized_content=normalized_content,
    ) is None
    assert match_tag_term_in_normalized_content(
        term="I-plug-in",
        normalized_content=normalized_content,
    ) is None


def test_match_tag_term_in_normalized_content_keeps_non_prose_uppercase_single_letters() -> None:
    match = match_tag_term_in_normalized_content(
        term="X-Y-Z",
        normalized_content=normalize_tag_match_text("Y Z"),
    )

    assert match is not None
    assert match.matched_segments == ("y", "z")


def test_match_tag_term_in_normalized_content_requires_near_complete_raw_chunk_coverage() -> None:
    assert match_tag_term_in_normalized_content(
        term="X-Y-Z",
        normalized_content=normalize_tag_match_text("Y"),
    ) is None

    match = match_tag_term_in_normalized_content(
        term="X-Y-Z",
        normalized_content=normalize_tag_match_text("Y X"),
    )

    assert match is not None
    assert match.matched_segments == ("x", "y")

    assert match_tag_term_in_normalized_content(
        term="Tree-of-Thoughts",
        normalized_content=normalize_tag_match_text("misc thoughts"),
    ) is None


def test_match_tag_term_in_normalized_content_tracks_literal_padding_for_ranking() -> None:
    back_match = match_tag_term_in_normalized_content(
        term="back",
        normalized_content=normalize_tag_match_text("back"),
    )
    n_back_match = match_tag_term_in_normalized_content(
        term="n-back",
        normalized_content=normalize_tag_match_text("back"),
    )

    assert back_match is not None
    assert n_back_match is not None
    assert back_match.raw_phrase_match is True
    assert n_back_match.raw_phrase_match is False
    assert back_match.raw_segment_count == 1
    assert back_match.first_matched_raw_segment_index == 0
    assert n_back_match.raw_segment_count == 2
    assert n_back_match.first_matched_raw_segment_index == 1


def test_match_tag_term_in_normalized_content_keeps_stopwords_for_full_literal_phrase_match() -> None:
    match = match_tag_term_in_normalized_content(
        term="no-kings",
        normalized_content=normalize_tag_match_text("Going to the No Kings protest on Sunday"),
    )

    assert match is not None
    assert match.raw_phrase_match is True
    assert match.raw_phrase_position >= 0
    assert match.matched_segments == ("kings",)


def test_match_tag_term_in_normalized_content_does_not_match_stopword_only_overlap() -> None:
    assert match_tag_term_in_normalized_content(
        term="no-kings",
        normalized_content=normalize_tag_match_text("No more of that I guess"),
    ) is None


def test_match_tag_term_in_normalized_content_uses_numeric_near_complete_phrase() -> None:
    match = match_tag_term_in_normalized_content(
        term="GPT-5.6-sol",
        normalized_content=normalize_tag_match_text("trying 5.6 sol for the first time"),
    )

    assert match is not None
    assert match.raw_phrase_match is False
    assert match.raw_partial_phrase_match is True
    assert match.raw_partial_phrase_segment_count == 3

    assert match_tag_term_in_normalized_content(
        term="GPT-5.6",
        normalized_content=normalize_tag_match_text("trying 5.6 for the first time"),
    ) is None


@pytest.mark.parametrize(
    ("term", "content", "expected_segments"),
    [
        ("gpt-6-astra", "trying Astra in Codex for first time", ("astra",)),
        ("gpt-6-astra", "trying GPT", ("gpt",)),
        ("GPT-5.6-sol", "trying sol", ("sol",)),
        ("6-astra-gpt", "trying Astra", ("astra",)),
        ("astra_gpt_6", "trying Astra", ("astra",)),
    ],
)
def test_numeric_chunks_do_not_increase_required_content_coverage(
    term: str, content: str, expected_segments: tuple[str, ...],
) -> None:
    match = match_tag_term_in_normalized_content(
        term=term, normalized_content=normalize_tag_match_text(content),
    )

    assert match is not None
    assert match.matched_segments == expected_segments


@pytest.mark.parametrize(
    ("term", "content"),
    [
        ("gpt-6-astra", "trying 6"),
        ("gpt-6-astra", "trying Astral"),
        ("gpt-6-astra-preview", "trying Astra"),
        ("Tree-2-of-Thoughts", "misc thoughts"),
    ],
)
def test_ignoring_numeric_chunks_preserves_weak_overlap_rejection(term: str, content: str) -> None:
    assert match_tag_term_in_normalized_content(
        term=term, normalized_content=normalize_tag_match_text(content),
    ) is None
