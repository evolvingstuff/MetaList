"""Tag properties (docs/design/tag-properties.md): tokens with values, search terms that
compare them, and a token counting as its tag everywhere else."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.services.input_errors import InputRejected
from app.services.search_index import SearchIndex, SearchRecord, extract_ordered_tags_for_search, extract_tags_for_search
from app.services.search_query import format_search_query, parse_search_query
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
