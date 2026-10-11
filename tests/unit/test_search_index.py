import random

import pytest

from app.services import search_index as search_index_module
from app.services.search_index import (
    SearchIndex,
    SearchRecord,
    _parse_search_query_for_suggestions,
    extract_tags_for_search,
)
from app.services.input_errors import InputRejected
from app.services.search_query import parse_search_query
from app.services.search_text import text_term_matches
from app.utils.text_utils import strip_html


def _build_index(records: list[SearchRecord]) -> SearchIndex:
    index = SearchIndex()
    index.rebuild(
        records,
        raw_tag_terms_by_id={
            record.note_id: extract_tags_for_search(record.tags)
            for record in records
        },
        progress_update=lambda _processed: None,
        progress_interval=1000,
    )
    return index


def test_strip_html_ignores_script_and_inserts_whitespace() -> None:
    assert strip_html("<div>Hello</div><div>world</div>") == "Hello world"
    assert strip_html("<div>ok</div><script>alert(1)</script>hi") == "ok hi"


def test_search_query_parser_tags_and_text() -> None:
    parsed = parse_search_query("foo -bar \"hello world\" -'bad'")
    assert len(parsed.clauses) == 1
    clause = parsed.clauses[0]
    assert clause.required_tags == frozenset({"foo"})
    assert clause.forbidden_tags == frozenset({"bar"})
    assert clause.required_text == ("hello world",)
    assert clause.forbidden_text == ("bad",)


def test_search_query_parser_builds_ordered_or_clauses() -> None:
    parsed = parse_search_query('A B C OR D -E OR "some text"')

    assert len(parsed.clauses) == 3
    assert parsed.clauses[0].required_tags == frozenset({"A", "B", "C"})
    assert parsed.clauses[1].required_tags == frozenset({"D"})
    assert parsed.clauses[1].forbidden_tags == frozenset({"E"})
    assert parsed.clauses[2].required_text == ("some text",)


def test_search_query_parser_rejects_empty_or_clauses_and_prefixed_or() -> None:
    for query in ("OR A", "A OR", "A OR OR B", "+OR", "-OR"):
        with pytest.raises(ValueError):
            parse_search_query(query)


def test_search_query_parser_rejects_a_space_after_a_prefix_with_a_helpful_message() -> None:
    # "- tag" is not accepted as "-tag" (so it does not become a habit); the
    # message, shown to the user as a polite warning, says how to fix it.
    for query in ("foo - bar", "+ baz", "foo -"):
        with pytest.raises(InputRejected, match="directly followed by the tag or quoted text, with no space"):
            parse_search_query(query)


def test_search_index_tag_and_text_queries() -> None:
    index = _build_index(
        [
            SearchRecord(
                note_id="n1",
                content_text="Hello world",
                tags="foo",
                tag_terms=extract_tags_for_search("foo"),
            ),
            SearchRecord(
                note_id="n2",
                content_text="Other",
                tags="bar",
                tag_terms=extract_tags_for_search("bar"),
            ),
            SearchRecord(
                note_id="n3",
                content_text="Hello there",
                tags="foo bar",
                tag_terms=extract_tags_for_search("foo bar"),
            ),
        ]
    )

    assert index.query_note_ids('"hello"') == {"n1", "n3"}
    assert index.query_note_ids("foo") == {"n1", "n3"}
    assert index.query_note_ids("foo \"world\"") == {"n1"}
    assert index.query_note_ids("foo -bar") == {"n1"}
    assert index.query_note_ids("-\"world\"") == {"n2", "n3"}


def test_search_index_unions_or_clauses_with_clause_local_negative_terms() -> None:
    index = _build_index(
        [
            SearchRecord(
                note_id="n1",
                content_text="Hello world",
                tags="A B",
                tag_terms=extract_tags_for_search("A B"),
            ),
            SearchRecord(
                note_id="n2",
                content_text="Other",
                tags="C",
                tag_terms=extract_tags_for_search("C"),
            ),
            SearchRecord(
                note_id="n3",
                content_text="Other",
                tags="C blocked",
                tag_terms=extract_tags_for_search("C blocked"),
            ),
            SearchRecord(
                note_id="lowercase-or",
                content_text="Other",
                tags="or",
                tag_terms=extract_tags_for_search("or"),
            ),
        ]
    )

    assert index.query_note_ids("A B OR C -blocked") == {"n1", "n2"}
    assert index.query_note_ids("or") == {"lowercase-or"}


def test_quoted_or_remains_a_text_term() -> None:
    index = _build_index(
        [
            SearchRecord(
                note_id="text-or",
                content_text="This or that",
                tags="",
                tag_terms=frozenset(),
            ),
        ]
    )

    assert index.query_note_ids('"OR"') == {"text-or"}


def test_search_suggestion_context_resets_anchors_after_or() -> None:
    assert _parse_search_query_for_suggestions("alpha beta OR gam") == ((), "gam")


@pytest.mark.parametrize('prefix', ['sec', 'security', 'computer-s'])
def test_search_suggestions_exclude_security_without_prediction_future(prefix) -> None:
    index = _build_index([
        SearchRecord('prediction', '', 'prediction-future', frozenset({'prediction-future'})),
        SearchRecord('security', '', 'computer-security', frozenset({'computer-security'})),
    ])

    assert index.query_note_ids('prediction-future computer-security') == set()
    assert index.suggest_all_tag_completions(query=f'prediction-future {prefix}') == []
    assert index.suggest_all_tag_completions(query=prefix) == ['computer-security']
    # Note-tag recommendations may still suggest new combinations.
    assert index.suggest_tag_completions(query=f'prediction-future {prefix}', limit=20) == ['computer-security']


@pytest.mark.parametrize('query,expected', [
    ('prediction-future sec', {'security-valid', 'security-blocked'}),
    ('prediction-future horizon sec', {'security-valid'}),
    ('prediction-future missing sec', set()),
    ('prediction-future -blocked sec', {'security-valid'}),
    ('prediction-future "safe" sec', {'security-valid'}),
    ('prediction-future -"danger" sec', {'security-valid'}),
    ('prediction-future @todo sec', {'security-valid'}),
    ('unrelated OR prediction-future sec', {'security-valid', 'security-blocked'}),
    ('prediction-future OR unrelated sec', {'security-unrelated'}),
    ('prediction-future OR sec', {'security-valid', 'security-blocked', 'security-unrelated'}),
    ('"say \\"OR\\"" sec', {'security-valid'}),
    ('prediction-future +sec', {'security-valid', 'security-blocked'}),
    ('prediction-future -"danger" -sec', {'security-blocked', 'security-unrelated'}),
    ('prediction-future horizon ', {'security-valid'}),
])
def test_search_suggestions_require_matches_in_active_clause(query, expected) -> None:
    index = _build_index([
        SearchRecord('valid', 'safe say "OR"', '', frozenset({'prediction-future', 'horizon', 'security-valid', '@todo'})),
        SearchRecord('blocked', 'danger', '', frozenset({'prediction-future', 'blocked', 'security-blocked'})),
        SearchRecord('other', 'other', '', frozenset({'unrelated', 'security-unrelated'})),
    ])

    assert set(index.suggest_all_tag_completions(query=query)) == expected


def test_exact_uppercase_or_is_not_indexed_as_a_tag() -> None:
    assert extract_tags_for_search("OR or [alpha OR]") == frozenset({"or", "alpha"})


def test_search_index_untagged_query_ignores_meta_tags() -> None:
    index = _build_index(
        [
            SearchRecord(note_id="empty", content_text="Empty", tags="", tag_terms=frozenset()),
            SearchRecord(
                note_id="formatted",
                content_text="Formatted",
                tags="@markdown",
                tag_terms=frozenset({"@markdown"}),
            ),
            SearchRecord(
                note_id="classified",
                content_text="Classified",
                tags="technology",
                tag_terms=frozenset({"technology"}),
            ),
            SearchRecord(
                note_id="inherited",
                content_text="Inherited",
                tags="",
                tag_terms=frozenset({"technology"}),
            ),
        ]
    )

    assert index.query_untagged_note_ids() == {"empty", "formatted"}


def test_search_index_short_text_term_falls_back_to_verification() -> None:
    index = _build_index(
        [
            SearchRecord(
                note_id="n1",
                content_text="Hello",
                tags="",
                tag_terms=extract_tags_for_search(""),
            ),
            SearchRecord(
                note_id="n2",
                content_text="Other",
                tags="",
                tag_terms=extract_tags_for_search(""),
            ),
        ]
    )
    assert index.query_note_ids('"ll"') == {"n1"}


def test_search_index_tag_suggestions_rank_by_anchor_overlap() -> None:
    index = _build_index(
        [
            SearchRecord(
                note_id="n1",
                content_text="Alpha",
                tags="a b c alpine",
                tag_terms=extract_tags_for_search("a b c alpine"),
            ),
            SearchRecord(
                note_id="n2",
                content_text="Beta",
                tags="a b alpha",
                tag_terms=extract_tags_for_search("a b alpha"),
            ),
            SearchRecord(
                note_id="n3",
                content_text="Gamma",
                tags="alto",
                tag_terms=extract_tags_for_search("alto"),
            ),
        ]
    )

    suggestions = index.suggest_tag_completions(query="a b c al", limit=20)
    assert suggestions[:3] == ["alpine", "alpha", "alto"]

    suggestions = index.suggest_tag_completions(query="alpha ", limit=20)
    assert suggestions == ["a", "b"]

    suggestions = index.suggest_tag_completions(query="alpha", limit=20)
    assert suggestions == []


def test_search_index_tag_suggestions_ignore_quotes_and_include_prefix_only() -> None:
    index = _build_index(
        [
            SearchRecord(
                note_id="n1",
                content_text="Socrates",
                tags="socrates philosopher",
                tag_terms=extract_tags_for_search("socrates philosopher"),
            ),
            SearchRecord(
                note_id="n2",
                content_text="Other",
                tags="journal",
                tag_terms=extract_tags_for_search("journal"),
            ),
        ]
    )

    suggestions = index.suggest_tag_completions(query="socrates \"ancient greece\" phil", limit=20)
    assert suggestions == ["philosopher"]

    suggestions = index.suggest_tag_completions(query="a b c jour", limit=20)
    assert suggestions == ["journal"]


def test_search_index_tag_suggestions_include_meta_tags() -> None:
    index = _build_index([])

    suggestions = index.suggest_tag_completions(query="@", limit=100)
    assert "@json" in suggestions
    assert "@markdown" in suggestions
    assert "@LaTeX" in suggestions
    assert "@shell" in suggestions
    assert "@email" in suggestions
    assert "@heading" in suggestions
    assert "@list-bulleted" in suggestions
    assert "@list-numbered" in suggestions
    assert "@todo" in suggestions
    assert "@monospace" in suggestions
    assert "@dark-theme" not in suggestions

    suggestions = index.suggest_tag_completions(query="@d", limit=20)
    assert suggestions == ["@diff", "@done"]


def test_search_index_meta_tag_suggestions_rank_by_usage() -> None:
    index = _build_index(
        [
            SearchRecord(
                note_id="n1",
                content_text="One",
                tags="@todo alpha",
                tag_terms=extract_tags_for_search("@todo alpha"),
            ),
            SearchRecord(
                note_id="n2",
                content_text="Two",
                tags="@todo beta",
                tag_terms=extract_tags_for_search("@todo beta"),
            ),
            SearchRecord(
                note_id="n3",
                content_text="Three",
                tags="@todo gamma",
                tag_terms=extract_tags_for_search("@todo gamma"),
            ),
            SearchRecord(
                note_id="n4",
                content_text="Four",
                tags="@done delta",
                tag_terms=extract_tags_for_search("@done delta"),
            ),
            SearchRecord(
                note_id="n5",
                content_text="Five",
                tags="@done epsilon",
                tag_terms=extract_tags_for_search("@done epsilon"),
            ),
            SearchRecord(
                note_id="n6",
                content_text="Six",
                tags="@LaTeX zeta",
                tag_terms=extract_tags_for_search("@LaTeX zeta"),
            ),
        ]
    )

    suggestions = index.suggest_tag_completions(query="@", limit=20)
    assert suggestions[:3] == ["@todo", "@done", "@LaTeX"]

    suggestions = index.suggest_tag_completions(query="@d", limit=20)
    assert suggestions == ["@done", "@diff"]


def test_search_index_tag_suggestions_collapse_case_equivalent_terms() -> None:
    index = _build_index(
        [
            SearchRecord(
                note_id="n1",
                content_text="One",
                tags="databricks",
                tag_terms=extract_tags_for_search("databricks"),
            ),
            SearchRecord(
                note_id="n2",
                content_text="Two",
                tags="databricks",
                tag_terms=extract_tags_for_search("databricks"),
            ),
            SearchRecord(
                note_id="n3",
                content_text="Three",
                tags="Databricks",
                tag_terms=extract_tags_for_search("Databricks"),
            ),
            SearchRecord(
                note_id="n4",
                content_text="Four",
                tags="delta",
                tag_terms=extract_tags_for_search("delta"),
            ),
        ]
    )

    suggestions = index.suggest_tag_completions(query="", limit=20)
    assert "Databricks" not in suggestions
    assert suggestions[:2] == ["databricks", "delta"]

    suggestions = index.suggest_tag_completions(query="databricks", limit=20)
    assert suggestions == []

    suggestions = index.suggest_tag_completions(query="Databricks ", limit=20)
    assert suggestions == []


def test_search_index_tracks_raw_inherited_frequency_separately_from_ontology() -> None:
    records = [
        SearchRecord(
            note_id="n1",
            content_text="",
            tags="ML3",
            tag_terms=frozenset({"ML3", "math"}),
        ),
        SearchRecord(
            note_id="n2",
            content_text="",
            tags="",
            tag_terms=frozenset({"ML3", "math"}),
        ),
    ]
    index = SearchIndex()
    index.rebuild(
        records,
        raw_tag_terms_by_id={
            "n1": frozenset({"ML3"}),
            "n2": frozenset({"ML3"}),
        },
        progress_update=lambda _processed: None,
        progress_interval=1000,
    )

    assert index.list_tag_frequencies()["math"] == 2
    assert "math" not in index.list_raw_tag_frequencies_by_casefold()
    assert index.list_raw_tag_frequencies_by_casefold()["ml3"] == 2

    index.bulk_update_raw_tag_terms({"n2": frozenset({"ML3", "money"})})
    assert index.list_raw_tag_frequencies_by_casefold()["money"] == 1

    index.remove_many({"n2"})
    assert "money" not in index.list_raw_tag_frequencies_by_casefold()


def test_suggestion_co_occurrence_strategies_rank_identically(monkeypatch: pytest.MonkeyPatch) -> None:
    rng = random.Random(11)
    vocabulary = [f"tag{index}" for index in range(30)] + ["Mixed", "mixed", "tag-long"]
    records = []
    for index in range(300):
        tags = frozenset(rng.sample(vocabulary, rng.randrange(1, 8)))
        records.append(SearchRecord(f"n{index}", "", " ".join(sorted(tags)), tags))
    index = _build_index(records)
    queries = [
        "tag0 ", "Mixed ", "tag1 tag2 ", "tag1 tag2 tag3 ", "tag0 ta", "tag4 -tag5 ", "tag6 tag7 t", "nosuch ", "tag8 m",
    ]
    rankings = []
    for ratio in (0, 10**9):
        monkeypatch.setattr(search_index_module, "SUGGESTION_INTERSECT_COST_RATIO", ratio)
        rankings.append([
            (index.suggest_tag_completions(query=query, limit=40), index.suggest_all_tag_completions(query=query))
            for query in queries
        ])
    assert rankings[0] == rankings[1]
    assert any(suggestions for suggestions, _ in rankings[0])


# A space at the edge of a quoted term marks a word boundary on that side
# (docs/ui/search-semantics.md): "fat " ends a word, " fat" starts one.
@pytest.mark.parametrize("term,text,expected", [
    ("fat", "a father-of-two", True),
    ("fat", "sulfate", True),
    ("fat ", "a fat cat", True),
    ("fat ", "it was fat.", True),
    ("fat ", "it was fat, really", True),
    ("fat ", "the end is fat", True),
    ("fat ", "a father-of-two", False),
    (" fat", "fat cat", True),
    (" fat", "the fat", True),
    (" fat", "(fat)", True),
    (" fat", "sulfate", False),
    (" fat ", "the fat cat", True),
    (" fat ", "a father", False),
    (" fat ", "sulfate", False),
    (" fat ", "Fat.", True),
])
def test_quoted_text_edge_spaces_mark_word_boundaries(term: str, text: str, expected: bool) -> None:
    assert text_term_matches(term, text.casefold()) is expected


def test_search_query_parser_keeps_one_edge_space_in_quoted_text() -> None:
    clause = parse_search_query('interesting "Fat "').first_clause
    assert clause.required_text == ("Fat ",)
    assert parse_search_query('"  fat   cat  "').first_clause.required_text == (" fat cat ",)
    assert parse_search_query('"hello world"').first_clause.required_text == ("hello world",)


def test_search_index_matches_word_boundaries_in_quoted_text() -> None:
    index = _build_index(
        [
            SearchRecord(note_id="n1", content_text="Rhys Hibbert, a father-of-two",
                         tags="interesting", tag_terms=extract_tags_for_search("interesting")),
            SearchRecord(note_id="n2", content_text="A fat cat.", tags="interesting",
                         tag_terms=extract_tags_for_search("interesting")),
            SearchRecord(note_id="n3", content_text="Saturated fat", tags="interesting",
                         tag_terms=extract_tags_for_search("interesting")),
        ]
    )
    assert index.query_note_ids('interesting "Fat"') == {"n1", "n2", "n3"}
    assert index.query_note_ids('interesting "Fat "') == {"n2", "n3"}
    assert index.query_note_ids('interesting -"fat "') == {"n1"}
