"""A search tag without = matches its whole family: @code finds every @code=<language>
note (docs/ui/search-semantics.md), and suggestions offer the family and its members."""

from __future__ import annotations

import random

import pytest

from app.services.search_index import SearchIndex, SearchRecord, extract_tags_for_search

_PROGRESS_INTERVAL = 1000


def _index() -> SearchIndex:
    records = [
        SearchRecord(note_id=note_id, content_text="text", tags=tags, tag_terms=extract_tags_for_search(tags))
        for note_id, tags in (
            ("python", "@code=python"),
            ("javascript", "@code=javascript"),
            ("recipes", "recipes"),
            ("sized", "@size=2 recipes"),
            ("priority", "priority=high"),
        )
    ]
    index = SearchIndex()
    index.rebuild(
        records,
        raw_tag_terms_by_id={record.note_id: record.tag_terms for record in records},
        progress_update=lambda _count: None,
        progress_interval=_PROGRESS_INTERVAL,
    )
    return index


@pytest.mark.parametrize(("search", "expected"), [
    ("@code", {"python", "javascript"}),
    ("@CODE", {"python", "javascript"}),
    ("@code=python", {"python"}),
    ("@code=PYTHON", {"python"}),
    ("-@code", {"recipes", "sized", "priority"}),
    ("@size", {"sized"}),
    ("recipes -@size", {"recipes"}),
    ("priority", {"priority"}),
    ("@code OR recipes", {"python", "javascript", "recipes", "sized"}),
    # A family is the part before =, never a shorter prefix.
    ("@cod", set()),
    ("@code=py", set()),
])
def test_a_tag_without_a_value_matches_every_value(search, expected):
    assert _index().query_note_ids(search) == expected


@pytest.mark.parametrize(("query", "expected"), [
    # The family first (it covers both notes), then its members.
    ("@c", ["@code", "@code=javascript", "@code=python"]),
    ("@code", ["@code=javascript", "@code=python"]),
    ("@code=", ["@code=javascript", "@code=python"]),
    ("@code=p", ["@code=python"]),
    ("recipes @", ["@size", "@size=2"]),
    # Plain tags match their family, but only @ tags suggest the family name.
    ("pri", ["priority=high"]),
])
def test_suggestions_offer_tags_in_use_with_their_family(query, expected):
    assert _index().suggest_all_tag_completions(query=query) == expected


_FAMILY_SEED = 31
_FAMILY_STEPS = 300
_FAMILY_TERMS = ["@code", "@code=python", "@code=sql", "@Code=Rust", "priority=high", "priority",
                 "priority=low=now", "trip", "a=b=c", "a=b", "journal"]


def _scanned_family_posting(index: SearchIndex, tag_casefold: str) -> set[int]:
    """The family as the old full scan found it: every term starting with tag=."""
    prefix = f"{tag_casefold}="
    found = set(index._tag_notes_casefold.get(tag_casefold, set()))
    for term, notes in index._tag_notes_casefold.items():
        if "=" not in tag_casefold and term.startswith(prefix):
            found |= notes
    return found


def test_a_family_is_the_terms_the_old_scan_found_after_any_edits() -> None:
    generator = random.Random(_FAMILY_SEED)
    index = SearchIndex()
    index.rebuild([], raw_tag_terms_by_id={}, progress_update=lambda _count: None,
                  progress_interval=_PROGRESS_INTERVAL)
    for step in range(_FAMILY_STEPS):
        note_id = f"n{generator.randint(0, 20)}"
        terms = frozenset(generator.sample(_FAMILY_TERMS, generator.randint(0, 4)))
        if generator.random() < 0.15:
            index.remove_many({note_id})
        else:
            index.upsert(note_id=note_id, content_text="text", tags=" ".join(sorted(terms)),
                         raw_tag_terms=terms, tag_terms=terms)
        for term in _FAMILY_TERMS:
            tag_casefold = term.casefold()
            with index._lock:
                assert set(index._tag_family_posting_locked(tag_casefold)) == _scanned_family_posting(index, tag_casefold), (step, term)
