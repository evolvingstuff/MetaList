"""Tag properties (docs/design/tag-properties.md): tokens with values, search terms that
compare them, and a token counting as its tag everywhere else."""

from __future__ import annotations

from decimal import Decimal

import pytest

import app.services.search_index as search_index_module
from app.services.input_errors import InputRejected
from app.services.search_index import SearchIndex, SearchRecord, extract_ordered_tags_for_search, extract_tags_for_search
from app.services.search_query import format_search_query, parse_search_query
from app.services.tag_ontology import compile_rules, parse_rules_text
from app.services.tag_properties import (
    VALUE_NUMBER,
    VALUE_TEMPORAL,
    VALUE_TEXT,
    VALUE_TIME,
    parse_property_term,
    parse_property_value,
    token_properties,
)
from app.services.tag_rename import delete_tag_from_tag_bar, rename_tag_in_tag_bar
from app.usecases import search_context_tags

# Seconds after midnight of 22:30.
HALF_PAST_TEN_PM = (22 * 60 + 30) * 60


def test_a_token_with_properties_is_its_tag_for_search_and_inheritance() -> None:
    assert extract_ordered_tags_for_search("foo jogging:miles=3:duration=30 @size=2 jogging=3:miles=1") == (
        "foo", "jogging", "@size=2", "jogging=3",
    )


def test_renaming_a_tag_keeps_its_properties_and_deleting_it_removes_them() -> None:
    assert rename_tag_in_tag_bar(tags="foo jogging:miles=3", old="jogging", new="running") == (
        "foo running:miles=3", True,
    )
    assert delete_tag_from_tag_bar(tags="foo jogging:miles=3", tag="jogging") == ("foo ", True)


@pytest.mark.parametrize(("text", "kind", "sort_key", "unit"), [
    ("3", VALUE_NUMBER, Decimal("3"), ""),
    ("-2.5", VALUE_NUMBER, Decimal("-2.5"), ""),
    ("10mg", VALUE_NUMBER, Decimal("10"), "mg"),
    ("40%", VALUE_NUMBER, Decimal("40"), "%"),
    ("2026", VALUE_NUMBER, Decimal("2026"), ""),
    ("22:30", VALUE_TIME, HALF_PAST_TEN_PM, ""),
    ("10:30pm", VALUE_TIME, HALF_PAST_TEN_PM, ""),
    ("10:30P.M.", VALUE_TIME, HALF_PAST_TEN_PM, ""),
    ("12am", VALUE_TIME, 0, ""),
    ("Ursula-Le-Guin", VALUE_TEXT, "ursula-le-guin", ""),
    ("2024-02-30", VALUE_TEXT, "2024-02-30", ""),
])
def test_values_are_read_as_the_first_kind_they_parse_as(text: str, kind: str, sort_key: object, unit: str) -> None:
    value = parse_property_value(text)
    assert (value.kind, value.sort_key, value.unit) == (kind, sort_key, unit)


def test_a_month_is_its_first_day_and_date_times_compare_with_dates() -> None:
    assert parse_property_value("2024-01").sort_key == parse_property_value("2024-01-01T00:00").sort_key
    assert parse_property_value("2024-01-15T10:30").kind == VALUE_TEMPORAL


def test_a_token_lists_its_complete_properties_once_including_the_implicit_value() -> None:
    tag, values = token_properties("Jogging=3:Miles=3:start=10:30pm:miles=5:note")
    assert tag == "jogging"
    assert sorted(values) == ["miles", "start", "value"]
    assert values["miles"].sort_key == Decimal("3")


@pytest.mark.parametrize(("term", "message"), [
    ("jogging:miles>", "Write a value after >"),
    ("jogging:3>2", "A property name starts with a letter"),
    ("jogging:miles>2:duration<40", "One property per search term"),
    (":miles>2", "Name the tag before the property"),
    ("OR:miles>2", "OR is reserved"),
])
def test_a_malformed_property_term_says_how_to_write_it(term: str, message: str) -> None:
    with pytest.raises(InputRejected, match=message):
        parse_property_term(term)


def test_property_terms_parse_into_conditions_and_format_back() -> None:
    parsed = parse_search_query("jogging:miles>2 -jogging:miles? date>=2024-01 priority=high OR drug:dosage<=5mg")
    first, second = parsed.clauses
    assert [condition.format() for condition in first.required_properties] == ["jogging:miles>2", "date>=2024-01"]
    assert [condition.format() for condition in first.forbidden_properties] == ["jogging:miles?"]
    assert first.required_tags == frozenset({"priority=high"})
    assert [condition.format() for condition in second.required_properties] == ["drug:dosage<=5mg"]
    assert parse_search_query(format_search_query(parsed)) == parsed


NOTES = {
    "three-miles": "jogging:miles=3:duration=30:start=10:30pm",
    "one-mile": "jogging:miles=1",
    "no-miles": "jogging",
    "far": "jogging:miles=far",
    "ten-mg": "drug:dosage=10mg",
    "ten-kg": "drug:dosage=10kg",
    "dated": "date=2024-03-05",
}


@pytest.fixture
def index() -> SearchIndex:
    search_index = SearchIndex()
    records = [
        SearchRecord(note_id=note_id, content_text="", tags=tags, tag_terms=extract_tags_for_search(tags))
        for note_id, tags in NOTES.items()
    ]
    search_index.rebuild(
        records, raw_tag_terms_by_id={note_id: extract_tags_for_search(tags) for note_id, tags in NOTES.items()},
        progress_update=lambda processed: None, progress_interval=len(NOTES),
    )
    return search_index


@pytest.mark.parametrize(("search", "found"), [
    ("jogging", {"three-miles", "one-mile", "no-miles", "far"}),
    ("jogging:miles>2", {"three-miles"}),
    ("jogging:miles<=1", {"one-mile"}),
    ("jogging:miles=3", {"three-miles"}),
    ("jogging:miles=far", {"far"}),
    ("jogging:miles?", {"no-miles"}),
    ("jogging:miles", {"three-miles", "one-mile", "far"}),
    ("jogging -jogging:miles>2", {"one-mile", "no-miles", "far"}),
    ("jogging:start>9pm", {"three-miles"}),
    ("jogging:start<9pm", set()),
    ("drug:dosage>5", {"ten-mg", "ten-kg"}),
    ("drug:dosage>5mg", {"ten-mg"}),
    ("date>=2024-01", {"dated"}),
    ("date<2024-01", set()),
    ("jogging:miles>2 OR drug:dosage<20mg", {"three-miles", "ten-mg"}),
])
def test_searches_compare_a_notes_own_values(index: SearchIndex, search: str, found: set[str]) -> None:
    assert index.query_note_ids(search) == found


def test_changing_a_notes_tags_changes_its_values(index: SearchIndex) -> None:
    tags = "jogging:miles=5"
    index.upsert(note_id="one-mile", content_text="", tags=tags, raw_tag_terms=extract_tags_for_search(tags),
                 tag_terms=extract_tags_for_search(tags))
    assert index.query_note_ids("jogging:miles>2") == {"three-miles", "one-mile"}
    index.upsert(note_id="one-mile", content_text="", tags="jogging", raw_tag_terms=frozenset({"jogging"}),
                 tag_terms=frozenset({"jogging"}))
    assert index.query_note_ids("jogging:miles?") == {"no-miles", "one-mile"}


def test_a_note_added_in_a_property_search_gets_its_tag_and_the_values_it_names(monkeypatch) -> None:
    monkeypatch.setattr(search_context_tags.search_index, "list_tag_frequencies", lambda: {})
    add = lambda search: search_context_tags.ensure_tags_match_search_query(  # noqa: E731
        parent_id=None, content="", tags="", search_query=search,
    )
    assert add("jogging:miles=3 jogging:duration=30") == "jogging:miles=3:duration=30"
    assert add("jogging:miles>2") == "jogging"
    assert add("run jogging:miles?") == "run jogging"


UPWARD_NOTES = {
    "run": "jogging:miles=3",
    "trail": "trail-run:miles=5",
    "ride": "cycling:miles=10:duration=40",
    "swim": "swimming:miles=4",
    "synonym": "Run:miles=1",
    "no-miles": "jogging",
    "general": "exercise:miles=9",
    "two-activities": "jogging:miles=1 cycling:miles=10",
}
RULES = "jogging => exercise\ntrail-run => jogging\ncycling => exercise\nrun = jogging\n"


@pytest.fixture
def upward_index(monkeypatch: pytest.MonkeyPatch) -> SearchIndex:
    ontology = compile_rules(rules=parse_rules_text(text=RULES, filename="test"), filename="test")
    monkeypatch.setattr(search_index_module, "get_ontology_if_ready", lambda: ontology)
    search_index = SearchIndex()
    search_index.rebuild(
        [SearchRecord(note_id=note_id, content_text="", tags=tags, tag_terms=extract_tags_for_search(tags))
         for note_id, tags in UPWARD_NOTES.items()],
        raw_tag_terms_by_id={note_id: extract_tags_for_search(tags) for note_id, tags in UPWARD_NOTES.items()},
        progress_update=lambda processed: None, progress_interval=len(UPWARD_NOTES),
    )
    return search_index


@pytest.mark.parametrize(("search", "found"), [
    # Every tag implying exercise, at any depth; swimming has no rule.
    ("exercise:miles>2", {"run", "trail", "ride", "general", "two-activities"}),
    # Any one value meeting the term is enough.
    ("exercise:miles<2", {"synonym", "two-activities"}),
    ("jogging:miles>2", {"run", "trail"}),
    ("exercise:duration", {"ride"}),
    ("exercise:miles?", {"no-miles"}),
    # A synonym reads both ways.
    ("run:miles>0", {"run", "trail", "synonym", "two-activities"}),
])
def test_a_property_term_reads_the_values_of_tags_implying_its_tag(
    upward_index: SearchIndex, search: str, found: set[str],
) -> None:
    assert upward_index.query_note_ids(search) == found


def test_a_rule_change_is_seen_by_the_next_property_search(upward_index: SearchIndex, monkeypatch) -> None:
    assert "swim" not in upward_index.query_note_ids("exercise:miles>2")
    ontology = compile_rules(rules=parse_rules_text(text=RULES + "swimming => exercise\n", filename="test"), filename="test")
    monkeypatch.setattr(search_index_module, "get_ontology_if_ready", lambda: ontology)
    assert "swim" in upward_index.query_note_ids("exercise:miles>2")


SUGGESTION_NOTES = {
    "run": "jogging:miles=3:duration=30",
    "long-run": "jogging:miles=5",
    "gym": "exercise:duration=40:heart=150bpm",
    "ride": "cycling:miles=10:watts=200w",
    "pill": "drug:dosage=10mg",
    "small-pill": "drug:dosage=5mg",
    "powder": "drug:dosage=1g",
}


@pytest.fixture
def suggestion_index(monkeypatch: pytest.MonkeyPatch) -> SearchIndex:
    ontology = compile_rules(
        rules=parse_rules_text(text="jogging => exercise\ncycling => exercise\n", filename="test"), filename="test",
    )
    monkeypatch.setattr(search_index_module, "get_ontology_if_ready", lambda: ontology)
    search_index = SearchIndex()
    search_index.rebuild(
        [SearchRecord(note_id=note_id, content_text="", tags=tags, tag_terms=extract_tags_for_search(tags))
         for note_id, tags in SUGGESTION_NOTES.items()],
        raw_tag_terms_by_id={note_id: extract_tags_for_search(tags) for note_id, tags in SUGGESTION_NOTES.items()},
        progress_update=lambda processed: None, progress_interval=len(SUGGESTION_NOTES),
    )
    return search_index


@pytest.mark.parametrize(("typed", "place", "expected"), [
    # The tag bar: names used with the tag and the tags it implies, most used first.
    ("jogging:", "tag-bar", [("jogging:duration=", "duration="), ("jogging:miles=", "miles="), ("jogging:heart=", "heart=")]),
    # A name the token has is not offered again.
    ("jogging:miles=3:", "tag-bar", [("jogging:miles=3:duration=", "duration="), ("jogging:miles=3:heart=", "heart=")]),
    ("jogging:d", "tag-bar", [("jogging:duration=", "duration=")]),
    # A search: names used with the tag and the tags implying it.
    ("exercise:", "search", [("exercise:miles", "miles"), ("exercise:duration", "duration"),
                             ("exercise:heart", "heart"), ("exercise:watts", "watts")]),
    # Units after a number, most used first.
    ("drug:dosage=10", "tag-bar", [("drug:dosage=10mg", "10mg"), ("drug:dosage=10g", "10g")]),
    ("drug:dosage>5m", "search", [("drug:dosage>5mg", "5mg")]),
    ("drug:dosage>5mg", "search", []),
    # MAX and MIN after a search's =.
    ("jogging:miles=", "search", [("jogging:miles=MAX", "MAX"), ("jogging:miles=MIN", "MIN")]),
    ("jogging", "search", []),
])
def test_property_names_units_and_keywords_are_suggested(
    suggestion_index: SearchIndex, typed: str, place: str, expected: list[tuple[str, str]],
) -> None:
    suggestions = suggestion_index.suggest_property_completions(typed=typed, place=place, limit=10)
    assert [(suggestion.replacement, suggestion.label) for suggestion in suggestions] == expected


def test_a_suggestion_says_which_tags_use_it(suggestion_index: SearchIndex) -> None:
    [duration, *_rest] = suggestion_index.suggest_property_completions(typed="jogging:", place="tag-bar", limit=10)
    assert duration.reasons == ("On 1 note tagged exercise", "On 1 note tagged jogging")


EXTREME_NOTES = {
    "old-run": "jogging:miles=3 y2025",
    "long-run": "jogging:miles=5 y2026",
    "tie": "jogging:miles=5",
    "ride": "cycling:miles=10",
    "far": "jogging:miles=far",
    "short-run": "jogging:miles=1 y2026",
    "early": "run:at=2026-01-02",
    "late": "run:at=2026-03-05",
}


@pytest.mark.parametrize(("search", "found"), [
    # Ties are kept; the text value is skipped among numbers.
    ("jogging:miles=MAX", {"long-run", "tie"}),
    ("jogging:miles=MIN", {"short-run"}),
    ("exercise:miles=MAX", {"ride"}),
    # The rest of the clause decides among which notes.
    ("jogging:miles=MAX y2025", {"old-run"}),
    ("y2026 jogging:miles=MIN", {"short-run"}),
    ("jogging -jogging:miles=MAX", {"old-run", "far", "short-run"}),
    ("run:at=MAX", {"late"}),
    ("jogging:miles=MAX OR run:at=MIN", {"long-run", "tie", "early"}),
])
def test_max_and_min_keep_the_extreme_notes_among_those_found(
    monkeypatch: pytest.MonkeyPatch, search: str, found: set[str],
) -> None:
    ontology = compile_rules(
        rules=parse_rules_text(text="jogging => exercise\ncycling => exercise\n", filename="test"), filename="test",
    )
    monkeypatch.setattr(search_index_module, "get_ontology_if_ready", lambda: ontology)
    search_index = SearchIndex()
    search_index.rebuild(
        [SearchRecord(note_id=note_id, content_text="", tags=tags, tag_terms=extract_tags_for_search(tags))
         for note_id, tags in EXTREME_NOTES.items()],
        raw_tag_terms_by_id={note_id: extract_tags_for_search(tags) for note_id, tags in EXTREME_NOTES.items()},
        progress_update=lambda processed: None, progress_interval=len(EXTREME_NOTES),
    )
    assert search_index.query_note_ids(search) == found


def test_max_and_min_go_after_equals_only_and_name_no_value_for_a_new_note(monkeypatch) -> None:
    with pytest.raises(InputRejected, match="MAX goes after ="):
        parse_property_term("jogging:miles>MAX")
    monkeypatch.setattr(search_context_tags.search_index, "list_tag_frequencies", lambda: {})
    assert search_context_tags.ensure_tags_match_search_query(
        parent_id=None, content="", tags="", search_query="jogging:miles=MAX",
    ) == "jogging"
