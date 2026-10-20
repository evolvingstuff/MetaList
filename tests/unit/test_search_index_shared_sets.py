"""The search index keeps one copy of each distinct per-note tag set: notes that inherit
the same tags share it, and a lowercased set equal to its original is that same set.
A copy goes when no note uses it any more, so edits leave nothing behind."""

from __future__ import annotations

from app.services.search_index import SearchIndex, SearchRecord, extract_tags_for_search

_PROGRESS_INTERVAL = 1000


def _record(note_id: str, tags: str) -> SearchRecord:
    return SearchRecord(note_id=note_id, content_text="text", tags=tags, tag_terms=extract_tags_for_search(tags))


def _index(*records: SearchRecord) -> SearchIndex:
    index = SearchIndex()
    index.rebuild(
        list(records),
        raw_tag_terms_by_id={record.note_id: record.tag_terms for record in records},
        progress_update=lambda _count: None,
        progress_interval=_PROGRESS_INTERVAL,
    )
    return index


def _tag_sets(index: SearchIndex, note_id: str) -> tuple[frozenset[str], ...]:
    note_int_id = index._uuid_to_id[note_id]
    return (
        index._note_tag_terms[note_int_id], index._note_tag_terms_casefold[note_int_id],
        index._note_raw_tag_terms[note_int_id], index._note_explicit_tag_terms[note_int_id],
    )


def test_notes_with_the_same_tags_share_one_copy() -> None:
    index = _index(_record("a", "trip japan"), _record("b", "japan trip"), _record("c", "work"))
    for first, second in zip(_tag_sets(index, "a"), _tag_sets(index, "b")):
        assert first is second
    assert _tag_sets(index, "a")[0] is not _tag_sets(index, "c")[0]


def test_a_lowercase_set_is_its_own_lowercased_copy() -> None:
    index = _index(_record("a", "trip japan"), _record("b", "Trip"))
    tag_terms, casefold, _raw, _explicit = _tag_sets(index, "a")
    assert casefold is tag_terms
    upper_terms, upper_casefold, _raw, _explicit = _tag_sets(index, "b")
    assert upper_casefold == frozenset({"trip"}) and upper_casefold is not upper_terms


def test_notes_without_links_share_one_empty_set() -> None:
    index = _index(_record("a", "trip"), _record("b", "work"))
    assert index._note_link_title_urls[0] is index._note_link_title_urls[1]


def _retag(index: SearchIndex, note_id: str, tags: str) -> None:
    terms = extract_tags_for_search(tags)
    index.upsert(note_id=note_id, content_text="text", tags=tags, raw_tag_terms=terms, tag_terms=terms)


def test_a_copy_goes_when_no_note_uses_it() -> None:
    index = _index(_record("a", "trip"), _record("b", "trip"), _record("c", "work"))
    _retag(index, "a", "work")
    index.remove_many({"b"})
    held = index._shared_tag_sets.distinct_sets()
    assert frozenset({"trip"}) not in held
    assert frozenset({"work"}) in held
    index.remove_many({"a", "c"})
    # Only the empty set, which removed notes keep, is left.
    assert index._shared_tag_sets.distinct_sets() == {frozenset()}


def test_searching_is_unchanged() -> None:
    index = _index(_record("a", "trip japan"), _record("b", "Trip"), _record("c", "work"))
    assert index.query_note_ids("trip") == {"a", "b"}
    assert index.query_note_ids("japan -work") == {"a"}
    _retag(index, "c", "trip")
    assert index.query_note_ids("trip") == {"a", "b", "c"}
