"""The AI is shown a search term only if it can see at least one note the term
picks out: for a term, a note its OR clause finds; for an excluded term, a note
the exclusion removes. Every other term is withheld, whatever made its notes
private (a blacklisted tag, a synonym, an implication, a text rule, a phrase), and
a search that finds nothing is withheld like one that finds only private notes. A
search with nothing withheld is sent as typed."""

from dataclasses import dataclass

import pytest

from app.services.agent.cloud_privacy import disclosable_search_query
from app.services.search_query import SearchClause, format_search_query, parse_search_query


@dataclass(frozen=True)
class _Note:
    tags: frozenset[str]
    text: str
    is_visible: bool


# With `health` blacklisted: the first note is private through a text rule
# ("blood pressure" => health), the doctor visit through a combination rule
# ((doctor visit) => health), the diary through a synonym (diary = health).
_NOTES = (
    _Note(tags=frozenset({"diet"}), text="blood pressure log", is_visible=False),
    _Note(tags=frozenset({"diet"}), text="salad", is_visible=True),
    _Note(tags=frozenset({"diet"}), text="soup", is_visible=True),
    _Note(tags=frozenset({"groceries"}), text="milk", is_visible=True),
    _Note(tags=frozenset({"doctor", "visit"}), text="", is_visible=False),
    _Note(tags=frozenset({"health"}), text="", is_visible=False),
    _Note(tags=frozenset({"diary"}), text="", is_visible=False),
    _Note(tags=frozenset({"travel"}), text="", is_visible=True),
    _Note(tags=frozenset({"travel", "work"}), text="", is_visible=True),
)


def _clause_finds(clause: SearchClause, note: _Note) -> bool:
    text = note.text.casefold()
    return (clause.required_tags <= note.tags and not clause.forbidden_tags & note.tags
            and all(phrase.casefold() in text for phrase in clause.required_text)
            and not any(phrase.casefold() in text for phrase in clause.forbidden_text))


def _finds_visible_note(search: str) -> bool:
    clauses = parse_search_query(search).clauses
    return any(note.is_visible and any(_clause_finds(clause, note) for clause in clauses) for note in _NOTES)


@pytest.mark.parametrize("query", [
    "travel", "travel -work", '"door code" travel', 'a OR -"b c" d', "x -y OR z", '"say \\"hi\\""',
])
def test_a_rebuilt_search_means_the_same(query):
    assert parse_search_query(format_search_query(parse_search_query(query))) == parse_search_query(query)


@pytest.mark.parametrize("query, expected", [
    ('"blood pressure" diet', "[private]"),
    ('"blood pressure" OR groceries', "[private] OR groceries"),
    ('diet -"blood pressure"', "diet -[private]"),
    ("doctor visit", "[private]"),
    ("health", "[private]"),
    ("diary", "[private]"),
    # Excluding a tag no visible travel note carries removes nothing the AI can see.
    ("travel -health", "travel -[private]"),
    # Excluding what no note carries removes nothing either, so it is withheld the same way.
    ("diet -groceries", "diet -[private]"),
    ("nothing-has-this", "[private]"),
    ("-nothing-has-this", "-[private]"),
])
def test_a_term_is_withheld_unless_the_ai_can_see_a_note_it_picks_out(query, expected):
    assert disclosable_search_query(query, finds_visible_note=_finds_visible_note) == expected


@pytest.mark.parametrize("query", ["travel -work", "travel   -work", 'diet -"salad"', '"salad" OR travel'])
def test_a_search_with_nothing_withheld_is_sent_as_typed(query):
    assert disclosable_search_query(query, finds_visible_note=_finds_visible_note) == query


def test_a_view_without_a_search_has_nothing_to_withhold():
    assert disclosable_search_query("", finds_visible_note=_finds_visible_note) == ""
