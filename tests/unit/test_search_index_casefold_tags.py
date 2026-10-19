from __future__ import annotations

from app.services.search_index import SearchIndex
from app.services.search_index import SearchRecord
from app.services.search_index import extract_tags_for_search


def _build_index() -> SearchIndex:
    index = SearchIndex()
    records = [
        SearchRecord(
            note_id="n1",
            content_text="Dad birthday details",
            tags="Dad birthday",
            tag_terms=extract_tags_for_search("Dad birthday"),
        ),
        SearchRecord(
            note_id="n2",
            content_text="Mom birthday details",
            tags="mom birthday",
            tag_terms=extract_tags_for_search("mom birthday"),
        ),
    ]
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


def test_query_note_ids_matches_required_tags_case_insensitively() -> None:
    index = _build_index()

    assert index.query_note_ids("dad birthday") == {"n1"}
    assert index.query_note_ids("Dad birthday") == {"n1"}


def test_query_note_ids_matches_forbidden_tags_case_insensitively() -> None:
    index = _build_index()

    assert index.query_note_ids("birthday -dad") == {"n2"}
    assert index.query_note_ids("birthday -Dad") == {"n2"}


def test_is_tag_on_any_note_counts_only_tags_written_on_notes() -> None:
    index = SearchIndex()
    # n1 has Kyoto in its own tags and sakura only proposed (searchable, but on no note).
    record = SearchRecord(
        note_id="n1",
        content_text="Temples",
        tags="Kyoto",
        tag_terms=frozenset({"Kyoto", "sakura"}),
    )
    index.rebuild(
        [record],
        raw_tag_terms_by_id={"n1": frozenset({"Kyoto", "sakura"})},
        progress_update=lambda _processed: None,
        progress_interval=1000,
    )

    assert index.is_tag_on_any_note("kyoto") is True
    assert index.is_tag_on_any_note("KYOTO") is True
    assert index.is_tag_on_any_note("sakura") is False

    index.upsert(note_id="n1", content_text="Temples", tags="Sakura",
                 raw_tag_terms=frozenset({"Sakura"}), tag_terms=frozenset({"Sakura"}))
    assert index.is_tag_on_any_note("kyoto") is False
    assert index.is_tag_on_any_note("sakura") is True

    index.upsert(note_id="n2", content_text="Gion", tags="kyoto",
                 raw_tag_terms=frozenset({"kyoto"}), tag_terms=frozenset({"kyoto"}))
    assert index.is_tag_on_any_note("Kyoto") is True

    index.remove_many({"n1", "n2"})
    assert index.is_tag_on_any_note("sakura") is False
    assert index.is_tag_on_any_note("kyoto") is False


def test_a_tag_whose_last_note_is_gone_is_no_longer_listed() -> None:
    index = SearchIndex()
    index.upsert(note_id="n1", content_text="Edge", tags="edgefixture",
                 raw_tag_terms=frozenset({"edgefixture"}), tag_terms=frozenset({"edgefixture"}))
    index.upsert(note_id="n2", content_text="Kept", tags="kept",
                 raw_tag_terms=frozenset({"kept"}), tag_terms=frozenset({"kept"}))
    assert index.list_explicit_tag_frequencies() == {"edgefixture": 1, "kept": 1}

    index.remove_many({"n1"})

    assert "edgefixture" not in index.suggest_tag_completions(query="", limit=10), "nor in the search bar's suggestions"
    assert "edgefixture" not in index.suggest_tag_completions(query="edge", limit=10)
    assert index.list_explicit_tag_frequencies() == {"kept": 1}
    assert index.list_tag_frequencies() == {"kept": 1}
    # Retagging empties a tag the same way.
    index.upsert(note_id="n2", content_text="Kept", tags="other",
                 raw_tag_terms=frozenset({"other"}), tag_terms=frozenset({"other"}))
    assert index.list_explicit_tag_frequencies() == {"other": 1}
    assert index.list_tag_frequencies() == {"other": 1}
