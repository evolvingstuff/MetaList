"""The tag postings only ever counted are counts (_NoteCounts), not sets of notes. After
any edits they equal a recount of the live notes' own tags, including a note whose
tags differ only in case (Trip, trip), which counts once in the lowercased count."""

from __future__ import annotations

import random
from collections import Counter

from app.services.search_index import SearchIndex, SearchRecord, extract_tags_for_search

_PROGRESS_INTERVAL = 1000
_SEED = 5
_STEPS = 400
_NOTES = 30
_TAGS = ["trip", "Trip", "japan", "work", "@code=python", "TRIP", "home"]


def _recount(index: SearchIndex) -> tuple[Counter, Counter, Counter, Counter]:
    tags, raw, explicit, explicit_casefold = Counter(), Counter(), Counter(), Counter()
    for note_int_id in index._alive:
        tags.update(index._note_tag_terms[note_int_id])
        raw.update({term.casefold() for term in index._note_raw_tag_terms[note_int_id]})
        explicit.update(index._note_explicit_tag_terms[note_int_id])
        explicit_casefold.update({term.casefold() for term in index._note_explicit_tag_terms[note_int_id]})
    return tags, raw, explicit, explicit_casefold


def _assert_counts_match(index: SearchIndex) -> None:
    tags, raw, explicit, explicit_casefold = _recount(index)
    assert dict(index._tag_notes.items()) == dict(tags)
    assert dict(index._explicit_tag_notes_casefold.items()) == dict(explicit_casefold)
    assert dict(index._raw_tag_notes_casefold.items()) == dict(raw)
    assert dict(index._explicit_tag_notes.items()) == dict(explicit)


def _random_terms(generator: random.Random) -> frozenset[str]:
    return frozenset(generator.sample(_TAGS, generator.randint(0, 3)))


def test_counts_equal_a_recount_after_any_edits() -> None:
    generator = random.Random(_SEED)
    index = SearchIndex()
    records = [
        SearchRecord(note_id=f"n{number}", content_text="text", tags=" ".join(sorted(terms)), tag_terms=terms)
        for number in range(_NOTES)
        for terms in [_random_terms(generator)]
    ]
    index.rebuild(
        records, raw_tag_terms_by_id={record.note_id: record.tag_terms for record in records},
        progress_update=lambda _count: None, progress_interval=_PROGRESS_INTERVAL,
    )
    _assert_counts_match(index)
    live = {record.note_id for record in records}
    for _ in range(_STEPS):
        note_id = generator.choice(sorted(live | {f"n{_NOTES + generator.randint(0, 5)}"}))
        action = generator.choice(["upsert", "inherited", "raw", "remove"])
        if action == "upsert":
            explicit = _random_terms(generator)
            index.upsert(note_id=note_id, content_text="text", tags=" ".join(sorted(explicit)),
                         raw_tag_terms=explicit | _random_terms(generator), tag_terms=explicit | _random_terms(generator))
            live.add(note_id)
        elif action == "inherited" and note_id in live:
            index.bulk_update_tag_terms({note_id: _random_terms(generator)})
        elif action == "raw" and note_id in live:
            index.bulk_update_raw_tag_terms({note_id: _random_terms(generator)})
        elif action == "remove" and note_id in live:
            index.remove_many({note_id})
            live.discard(note_id)
        _assert_counts_match(index)


def test_a_case_variant_counts_once_in_the_lowercased_count() -> None:
    index = SearchIndex()
    terms = frozenset({"Trip", "trip"})
    index.rebuild(
        [SearchRecord(note_id="a", content_text="text", tags="Trip trip", tag_terms=terms)],
        raw_tag_terms_by_id={"a": terms}, progress_update=lambda _count: None, progress_interval=_PROGRESS_INTERVAL,
    )
    assert index.list_raw_tag_frequencies_by_casefold() == {"trip": 1}
    assert dict(index._explicit_tag_notes_casefold.items()) == {"trip": 1}
    assert index.list_tag_frequencies() == {"Trip": 1, "trip": 1}
    index.remove_many({"a"})
    assert index.list_raw_tag_frequencies_by_casefold() == {} and index.list_tag_frequencies() == {}


def test_frequencies_are_unchanged_for_ordinary_tags() -> None:
    index = SearchIndex()
    records = [
        SearchRecord(note_id="a", content_text="text", tags="trip japan", tag_terms=extract_tags_for_search("trip japan")),
        SearchRecord(note_id="b", content_text="text", tags="trip", tag_terms=extract_tags_for_search("trip")),
    ]
    index.rebuild(
        records, raw_tag_terms_by_id={record.note_id: record.tag_terms for record in records},
        progress_update=lambda _count: None, progress_interval=_PROGRESS_INTERVAL,
    )
    assert index.list_tag_frequencies() == {"trip": 2, "japan": 1}
    assert index.list_explicit_tag_frequencies() == {"trip": 2, "japan": 1}


_EQUIVALENCE_NOTES = 200
_EQUIVALENCE_SEED = 23


def _index_state(index: SearchIndex) -> dict[str, object]:
    return {
        "tag_notes_casefold": {term: set(notes) for term, notes in index._tag_notes_casefold.items() if notes},
        "tag_notes": dict(index._tag_notes.items()),
        "raw_tag_notes_casefold": dict(index._raw_tag_notes_casefold.items()),
        "explicit_tag_notes": dict(index._explicit_tag_notes.items()),
        "explicit_tag_notes_casefold": dict(index._explicit_tag_notes_casefold.items()),
        "columns": [
            (index._note_explicit_tag_terms[note_int_id], index._note_raw_tag_terms[note_int_id],
             index._note_tag_terms[note_int_id], index._note_tag_terms_casefold[note_int_id],
             index._note_text_casefold[note_int_id])
            for note_int_id in range(len(index._id_to_uuid))
        ],
    }


def test_a_rebuild_indexes_exactly_what_adding_each_note_would() -> None:
    # The rebuild indexes each distinct tag set once for all its notes.
    generator = random.Random(_EQUIVALENCE_SEED)
    shared_sets = [_random_terms(generator) for _ in range(8)]
    records, raw_by_id = [], {}
    for number in range(_EQUIVALENCE_NOTES):
        explicit = _random_terms(generator)
        tag_terms = explicit | generator.choice(shared_sets)
        records.append(SearchRecord(
            note_id=f"n{number}", content_text=f"text {number}", tags=" ".join(sorted(explicit)), tag_terms=tag_terms,
        ))
        raw_by_id[f"n{number}"] = explicit | generator.choice(shared_sets)
    rebuilt = SearchIndex()
    rebuilt.rebuild(records, raw_tag_terms_by_id=raw_by_id, progress_update=lambda _count: None,
                    progress_interval=_PROGRESS_INTERVAL)
    added = SearchIndex()
    for record in records:
        added.upsert(note_id=record.note_id, content_text=record.content_text, tags=record.tags,
                     raw_tag_terms=raw_by_id[record.note_id], tag_terms=record.tag_terms)
    assert _index_state(rebuilt) == _index_state(added)
    for query in ("trip", "japan -work", "@code", "text 7"):
        assert rebuilt.query_note_ids(query) == added.query_note_ids(query)
