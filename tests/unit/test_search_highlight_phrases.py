"""The quoted phrases the notes list highlights (docs/ui/search-semantics.md)."""

from __future__ import annotations

import pytest

from app.services.search_query import parse_search_query, search_highlight_phrases
from app.services.snapshot import view_search_highlight_phrases


@pytest.mark.parametrize(("search", "expected"), [
    ('"fat"', ("fat",)),
    # A space at an edge is kept: it limits the match to a word edge there.
    ('"fat "', ("fat ",)),
    ('" fat"', (" fat",)),
    ('"fat" "cat"', ("fat", "cat")),
    # Phrases on both sides of OR, each once.
    ('"fat" OR "cat" OR "fat"', ("fat", "cat")),
    # Excluded phrases and tags are never highlighted.
    ('"fat" -"cat"', ("fat",)),
    ('-"cat"', ()),
    ("recipes", ()),
    ("recipes -dinner", ()),
    ('recipes "fat"', ("fat",)),
])
def test_highlight_phrases_are_the_required_quoted_text_of_every_clause(search, expected):
    assert search_highlight_phrases(parse_search_query(search)) == expected


def test_no_search_highlights_nothing():
    assert view_search_highlight_phrases(None) == []
    assert view_search_highlight_phrases("") == []
    assert view_search_highlight_phrases('"fat" OR "cat"') == ["fat", "cat"]
