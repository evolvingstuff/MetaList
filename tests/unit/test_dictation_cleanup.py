"""Cleaning up dictated text pasted into the search bar or the tag bar.

Each case is one agreed behavior (see docs/ui/dictation-paste.md): text from a
speech-to-text tool such as Superwhisper becomes the user's existing tags.
"""

from __future__ import annotations

from pathlib import Path
import re

import pytest

import app.api.routes.notes as notes_route
from app.services.dictation_cleanup import KNOWN_META_TAGS, clean_dictated_paste


TAGS = {
    "neural-network": 5,
    "Neural-Network": 1,
    "neural": 1,
    "network": 1,
    "python": 3,
    "GPT": 2,
    "transformer": 1,
    "foo-bar": 1,
}


def _clean(text: str, *, target: str, current: str, tags: dict[str, int]) -> str:
    return clean_dictated_paste(text=text, target=target, existing_tag_frequencies=tags, current_value=current,
                                quote_open="quote", quote_close="end quote", negate_phrase="minus")


def _search(text: str) -> str:
    return _clean(text, target="search", current="", tags=TAGS)


def _tags(text: str) -> str:
    return _clean(text, target="tags", current="", tags=TAGS)


@pytest.mark.parametrize("pasted,expected", [
    # The reported example: punctuation, sentence case, repeats and "Neural-Dash".
    ("Neural network, neural network. Neural-Dash Network.", "neural-network"),
    ("Neural network and python", "neural-network python"),
    # Unknown words are dropped in search.
    ("Neural network transformers", "neural-network"),
    ("Quote attention is all you need end quote neural network", '"attention is all you need" neural-network'),
    ("Quote, attention is all you need. End quote, python", '"attention is all you need" python'),
    ("“attention is all you need” python", '"attention is all you need" python'),
    ("Neural network or python.", "neural-network OR python"),
    ("Neural network, minus python.", "neural-network -python"),
    # Only the configured exclusion phrase excludes ("minus" by default).
    ("Neural network, not python.", "neural-network python"),
    ("Minus python neural network", "-python neural-network"),
    # Operators with nothing to apply to are dropped.
    ("Or python", "python"),
    ("Python or", "python"),
    ("Python or bananas", "python"),
    ("Minus bananas python", "python"),
    ("And the.", ""),
    # Already-valid search syntax is kept as it is.
    ("neural-network -python", "neural-network -python"),
    ('neural-network OR "exact words"', 'neural-network OR "exact words"'),
])
def test_search_cases(pasted: str, expected: str) -> None:
    assert _search(pasted) == expected


@pytest.mark.parametrize("pasted,expected", [
    ("Neural network, transformers.", "neural-network transformers"),
    ("gpt and the transformer", "GPT transformer"),
    # Quote phrases quote nothing in the tag bar: their words are dropped.
    ("Quote machine learning end quote", "machine learning"),
    ("Quote neural network end quote", "neural-network"),
    ('"neural network" python', "neural-network python"),
    ("neural-network python", "neural-network python"),
    # New tags are lowercased unless they look like an acronym.
    ("LLM Evaluation", "LLM evaluation"),
    # Spoken operators are filler in the tag bar.
    ("Python or neural network, minus GPT", "python neural-network GPT"),
])
def test_tag_bar_cases(pasted: str, expected: str) -> None:
    assert _tags(pasted) == expected


@pytest.mark.parametrize("pasted", [
    # How Superwhisper writes "foo dash bar", and its variations.
    "foo-Dash bar",
    "Foo-Dash Bar.",
    "foo-dash bar",
    "foo -Dash bar",
    "foo - Dash bar",
    "foo dash bar",
    "foo-Hyphen bar",
    "foo hyphen bar",
])
def test_spoken_dash_joins_words(pasted: str) -> None:
    assert _search(pasted) == "foo-bar"
    assert _clean(pasted, target="tags", current="", tags={}) == "foo-bar"


@pytest.mark.parametrize("pasted,expected", [
    ("foo_Underscore bar", "foo_bar"),
    ("foo underscore bar", "foo_bar"),
    ("foo/Slash bar", "foo/bar"),
    ("foo slash bar", "foo/bar"),
])
def test_other_spoken_joiners(pasted: str, expected: str) -> None:
    assert _clean(pasted, target="tags", current="", tags={}) == expected


def test_the_longest_matching_phrase_wins_and_uses_the_most_used_spelling() -> None:
    # neural, network and neural-network all exist: the phrase is one tag, spelled
    # the way it is used most (neural-network 5 times, Neural-Network once).
    assert _search("NEURAL NETWORK") == "neural-network"


def test_a_spoken_word_that_is_a_tag_stays_a_tag() -> None:
    tags = {**TAGS, "not": 2, "and": 1, "tags": 1}
    assert _clean("not python", target="search", current="", tags=tags) == "not python"
    assert _clean("python and tags", target="tags", current="", tags=tags) == "python and tags"


def test_minus_is_an_operator_only_when_spelled_out_and_not_a_tag() -> None:
    assert _clean("minus python", target="search", current="", tags={**TAGS, "minus": 1}) == "minus python"
    assert _search("minus python") == "-python"


def test_tags_already_in_the_field_are_not_added_again() -> None:
    assert _clean("python GPT", target="tags", current="python", tags=TAGS) == "GPT"
    assert _clean("Neural network", target="tags", current="neural-network", tags=TAGS) == ""
    assert _clean("python neural network", target="search", current="python", tags=TAGS) == "neural-network"


def _one(text: str, tags: dict[str, int]) -> str:
    return clean_dictated_paste(text=text, target="tag", existing_tag_frequencies=tags, current_value="",
                                quote_open="quote", quote_close="end quote", negate_phrase="minus")


# Fields that take one tag (tag relationships, prioritize, tag filters): the
# whole paste is one tag, an existing one when it matches.
@pytest.mark.parametrize("pasted,tags,expected", [
    ("Dictation.", {"dictation": 3}, "dictation"),
    ("Dictation.", {}, "dictation"),
    ("The machine learning.", {"machine-learning": 1}, "machine-learning"),
    ("Machine learning", {}, "machine-learning"),
    ("scratch pad", {"scratchpad": 1}, "scratchpad"),
    ("At to do.", {}, "@todo"),
    ("GPT", {}, "GPT"),
    ("Quote machine learning end quote", {}, "machine-learning"),
    ("And the.", {}, ""),
])
def test_one_tag_fields(pasted: str, tags: dict[str, int], expected: str) -> None:
    assert _one(pasted, tags) == expected


def test_target_must_be_search_or_tags() -> None:
    with pytest.raises(ValueError):
        clean_dictated_paste(text="python", target="notes", existing_tag_frequencies=TAGS, current_value="",
                             quote_open="quote", quote_close="end quote", negate_phrase="minus")


class _FakeSearchIndex:
    def list_explicit_tag_frequencies(self) -> dict[str, int]:
        return dict(TAGS)


def test_the_endpoint_cleans_against_the_namespace_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(notes_route, "search_index", _FakeSearchIndex())
    payload = {"text": "Neural network, neural network. Neural-Dash Network.", "target": "search", "current_value": "",
               "quote_open": "quote", "quote_close": "end quote", "negate_phrase": "minus"}
    assert notes_route.dictation_paste(payload) == {"text": "neural-network"}


# Words run together: a phrase also matches a tag written as one word.
@pytest.mark.parametrize("pasted,tags,expected", [
    ("To do.", {"todo": 1}, "todo"),
    ("super whisper", {"superwhisper": 2}, "superwhisper"),
    ("Note book, python", {"notebook": 1, "python": 1}, "notebook python"),
    # Keeping the joiner wins over running the words together.
    ("to do", {"to-do": 1, "todo": 5}, "to-do"),
])
def test_spoken_words_match_a_one_word_tag(pasted: str, tags: dict[str, int], expected: str) -> None:
    assert _clean(pasted, target="search", current="", tags=tags) == expected
    assert _clean(pasted, target="tags", current="", tags=tags) == expected


# "at" (or a typed @) before a built-in meta tag is that meta tag.
@pytest.mark.parametrize("pasted,expected", [
    ("at to do", "@todo"),
    ("At todo.", "@todo"),
    ("@ to do", "@todo"),
    ("@todo", "@todo"),
    ("at done", "@done"),
    ("at list bulleted", "@list-bulleted"),
    ("At list-bulleted", "@list-bulleted"),
    ("At heading, at red.", "@heading @red"),
    ("neural network at to do", "neural-network @todo"),
])
def test_at_before_a_meta_tag_is_that_meta_tag(pasted: str, expected: str) -> None:
    assert _search(pasted) == expected
    assert _tags(pasted) == expected


def test_at_is_filler_unless_it_starts_a_meta_tag_or_is_a_tag() -> None:
    assert _tags("meeting at noon") == "meeting noon"
    assert _search("python at noon") == "python"
    assert _clean("meeting at noon", target="tags", current="", tags={"at": 1}) == "meeting at noon"
    # Not a meta tag: "at" is dropped and the words stay words.
    assert _tags("at foo") == "foo"


def test_the_meta_tag_list_matches_the_browser() -> None:
    source = (Path(__file__).resolve().parents[2]
              / "app/static/js/modules/mode-manager/services/tag-syntax-service.js").read_text(encoding="utf-8")
    block = re.search(r"const KNOWN_META_TAGS = new Set\(\[(.*?)\]\);", source, re.DOTALL)
    assert block is not None
    assert set(re.findall(r"'(@[^']+)'", block.group(1))) == set(KNOWN_META_TAGS)


def test_tags_dictated_alone_into_a_note_match_a_one_word_tag() -> None:
    # "Start tags, scratch pad." pasted into a note: the words after the phrase.
    assert _clean("scratch pad.", target="tags", current="python", tags={"scratchpad": 4}) == "scratchpad"


def test_the_quote_phrases_are_configurable() -> None:
    def search(text: str, quote_open: str, quote_close: str) -> str:
        return clean_dictated_paste(text=text, target="search", existing_tag_frequencies=TAGS, current_value="",
                                    quote_open=quote_open, quote_close=quote_close, negate_phrase="minus")
    assert search("begin text exact words finish text python", "begin text", "finish text") == '"exact words" python'
    # Only the configured phrases quote; quote marks always do.
    assert search("quote exact words end quote python", "begin text", "finish text") == "python"
    assert search('"exact words" python', "begin text", "finish text") == '"exact words" python'
    # Never closed: the phrase runs to the end.
    assert search("python quote exact words", "quote", "end quote") == 'python "exact words"'


def test_quote_phrases_must_be_words_and_differ() -> None:
    for quote_open, quote_close in [("quote", "quote"), ("quote", "end-quote"), ("", "end quote")]:
        with pytest.raises(ValueError):
            clean_dictated_paste(text="python", target="search", existing_tag_frequencies=TAGS, current_value="",
                                 quote_open=quote_open, quote_close=quote_close, negate_phrase="minus")


def test_the_exclusion_phrase_is_configurable() -> None:
    def search(text: str, negate_phrase: str) -> str:
        return clean_dictated_paste(text=text, target="search", existing_tag_frequencies=TAGS, current_value="",
                                    quote_open="quote", quote_close="end quote", negate_phrase=negate_phrase)
    assert search("neural network not python", "not") == "neural-network -python"
    assert search("neural network leave out python", "leave out") == "neural-network -python"
    assert search("neural network minus python", "leave out") == "neural-network python"


def test_the_phrases_must_differ() -> None:
    with pytest.raises(ValueError):
        clean_dictated_paste(text="python", target="search", existing_tag_frequencies=TAGS, current_value="",
                             quote_open="quote", quote_close="end quote", negate_phrase="quote")


# Superwhisper may type quote marks as well as the spoken quote phrases.
@pytest.mark.parametrize("pasted", [
    'Interesting quote "Fat. End quote.',
    'Interesting, quote, "Fat." End quote.',
    'Interesting quote “Fat” end quote',
    'Interesting quote "Fat" end quote.',
    'Interesting "Fat."',
    'Interesting quote fat end quote',
])
def test_quote_marks_inside_a_spoken_quote_are_dropped(pasted: str) -> None:
    tags = {"interesting": 1}
    result = _clean(pasted, target="search", current="", tags=tags)
    assert result.casefold() == 'interesting "fat"', result


# Superwhisper may type the exclusion as a symbol rather than the word.
@pytest.mark.parametrize("pasted,expected", [
    ('Interesting -"fat"', 'interesting -"fat"'),
    ('Interesting - "fat"', 'interesting -"fat"'),
    ("Interesting - quote fat end quote", 'interesting -"fat"'),
    ('Interesting – "fat"', 'interesting -"fat"'),
    ("Interesting -python", "interesting -python"),
    ("Interesting −python", "interesting -python"),
    ("Interesting - python", "interesting -python"),
    ("Interesting minus quote fat end quote", 'interesting -"fat"'),
])
def test_a_typed_minus_excludes_the_next_term(pasted: str, expected: str) -> None:
    assert _clean(pasted, target="search", current="", tags={"interesting": 1, "python": 2}) == expected


# Superwhisper's actual output for "interesting minus quote fat end quote".
SUPERWHISPER_MINUS_QUOTE = 'Interesting—"fat"—end quote.'


def test_superwhisper_minus_quote_excludes_the_quoted_text() -> None:
    assert _clean(SUPERWHISPER_MINUS_QUOTE, target="search", current="",
                  tags={"interesting": 1}) == 'interesting -"fat"'


def test_an_em_dash_before_a_tag_excludes_it_in_search() -> None:
    assert _clean("Neural network—python", target="search", current="", tags=TAGS) == "neural-network -python"


def test_a_leftover_end_quote_is_dropped() -> None:
    assert _clean("python end quote", target="tags", current="", tags=TAGS) == "python"
    assert _clean(SUPERWHISPER_MINUS_QUOTE, target="tags", current="",
                  tags={"interesting": 1}) == "interesting fat"


# Superwhisper drops a repeated "at": "at green at bold" arrives as "At green,
# bold." Once "at" starts a meta tag, following meta tag names continue the run.
@pytest.mark.parametrize("pasted,tags,expected", [
    ("At green, bold.", {}, "@green @bold"),
    ("At heading, red, python.", {"python": 1}, "@heading @red python"),
    ("At to do, done.", {}, "@todo @done"),
    # After "at", a meta tag name wins even over the user's own plain tag.
    ("At green, bold.", {"bold": 3}, "@green @bold"),
    ("Bold, python.", {"bold": 3, "python": 1}, "bold python"),
    ("Python, bold.", {"python": 1}, "python bold"),
    ("@green@bold", {}, "@green @bold"),
])
def test_a_run_of_meta_tags_after_one_at(pasted: str, tags: dict[str, int], expected: str) -> None:
    assert _clean(pasted, target="tags", current="", tags=tags) == expected
    search_expected = " ".join(word for word in expected.split() if word.startswith("@") or word in tags)
    assert _clean(pasted, target="search", current="", tags=tags) == search_expected
