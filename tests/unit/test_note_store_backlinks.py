from types import SimpleNamespace

import pytest

import app.services.backlink_index as backlink_index_module
import app.services.note_store as note_store_module
from app.services.note_store import NoteStore
from app.services.search_index import SearchIndex
from app.services.tag_ontology import TagOntology


TARGET = "11111111-1111-4111-8111-111111111111"
REFERRER = "22222222-2222-4222-8222-222222222222"
CHILD = "33333333-3333-4333-8333-333333333333"


def _row(note_id, parent_id, prev_id, next_id):
    return dict(id=note_id, parent_id=parent_id, prev_id=prev_id,
                next_id=next_id, is_collapsed=False, created_at=None, updated_at=None)


@pytest.fixture
def hydrated_store(monkeypatch):
    contents = {TARGET: "Source", REFERRER: f"[[{TARGET}]] ![[{TARGET}]]",
                CHILD: f"[[{TARGET}]]"}
    rows = [_row(TARGET, None, None, REFERRER), _row(REFERRER, None, TARGET, None),
            _row(CHILD, REFERRER, None, None)]
    monkeypatch.setattr(note_store_module, "search_index", SearchIndex())
    monkeypatch.setattr(note_store_module, "get_cached_content", contents.__getitem__)
    monkeypatch.setattr(note_store_module, "get_cached_text", contents.__getitem__)
    monkeypatch.setattr(note_store_module, "get_cached_tags", lambda _: "")
    monkeypatch.setattr(note_store_module, "get_cached_proposed_tags", lambda _: "")
    monkeypatch.setattr(note_store_module, "get_ontology", TagOntology.empty)
    store = NoteStore()
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=rows)
    return store


def test_hydration_counts_and_collapse_reads_never_parse(hydrated_store, monkeypatch):
    def unexpected_parse(*args):
        pytest.fail("Collapse and backlink reads must reuse the hydrated index")

    monkeypatch.setattr(backlink_index_module, "collect_active_reference_tokens", unexpected_parse)
    for collapsed in (True, False, True):
        hydrated_store.set_collapsed(TARGET, collapsed)
        assert hydrated_store.has_backlinks(TARGET)
        assert hydrated_store.get_backlink_counts(TARGET) == {REFERRER: 2, CHILD: 1}
    counts = hydrated_store.get_backlink_counts(TARGET)
    counts.clear()
    assert hydrated_store.get_backlink_counts(TARGET) == {REFERRER: 2, CHILD: 1}


def test_edits_reindex_only_changed_content_or_accepted_tags(hydrated_store, monkeypatch):
    parsed = []
    original = backlink_index_module.collect_active_reference_tokens

    def track_parse(content):
        parsed.append(content)
        return original(content)

    monkeypatch.setattr(backlink_index_module, "collect_active_reference_tokens", track_parse)
    content = f"[[{TARGET}]]"
    hydrated_store.update_note_content(note_id=REFERRER, plaintext=content, tags="", proposed_tags="", updated_at=None)
    assert parsed == [content]
    assert hydrated_store.get_backlink_counts(TARGET) == {REFERRER: 1, CHILD: 1}
    hydrated_store.update_note_content(note_id=REFERRER, plaintext=content, tags="", proposed_tags="suggestion", updated_at=None)
    hydrated_store.apply_bulk_tag_sources({REFERRER: ("", "other-proposal")})
    assert parsed == [content]
    # A note-id link is a link even beside a [[...]] formatting wrapper tag.
    hydrated_store.update_note_content(note_id=REFERRER, plaintext=content, tags="[[@red]]", proposed_tags="", updated_at=None)
    assert hydrated_store.get_backlink_counts(TARGET) == {REFERRER: 1, CHILD: 1}
    hydrated_store.apply_bulk_tag_sources({REFERRER: ("", "")})
    assert parsed == [content, content, content]
    assert hydrated_store.get_backlink_counts(TARGET) == {REFERRER: 1, CHILD: 1}


def test_delete_and_restore_target_preserves_existing_incoming_edges(hydrated_store):
    hydrated_store.remove_note(TARGET)
    assert not hydrated_store.has_backlinks(TARGET)
    with pytest.raises(KeyError):
        hydrated_store.get_backlink_counts(TARGET)
    hydrated_store.add_note_from_db(
        SimpleNamespace(**_row(TARGET, None, REFERRER, None)), "Restored source", "", "")
    assert hydrated_store.get_backlink_counts(TARGET) == {REFERRER: 2, CHILD: 1}


def test_subtree_deletion_clears_all_outgoing_edges(hydrated_store):
    hydrated_store.remove_note(REFERRER)
    assert not hydrated_store.has_backlinks(TARGET)
    assert hydrated_store.get_backlink_counts(TARGET) == {}
    hydrated_store.add_note_from_db(
        SimpleNamespace(**_row(REFERRER, None, TARGET, None)), f"![[{TARGET}]]", "", "")
    assert hydrated_store.get_backlink_counts(TARGET) == {REFERRER: 1}


def test_reset_and_rehydration_discard_previous_namespace_edges(hydrated_store):
    hydrated_store.reset()
    assert not hydrated_store.has_backlinks(TARGET)
    assert hydrated_store._backlink_index.get_counts(TARGET) == {}
    hydrated_store.load_from_db(None, prefetched_rows=[_row(TARGET, None, None, None)])
    assert not hydrated_store.has_backlinks(TARGET)
    hydrated_store.add_note_from_db(
        SimpleNamespace(**_row(REFERRER, None, TARGET, None)), f"[[{TARGET}]]", "", "")
    assert hydrated_store.has_backlinks(TARGET)
    hydrated_store.load_from_db(None, prefetched_rows=[_row(TARGET, None, None, None)])
    assert hydrated_store.get_backlink_counts(TARGET) == {}


def test_self_references_never_count_as_backlinks(hydrated_store):
    hydrated_store.update_note_content(
        note_id=TARGET, plaintext=f"[[{TARGET}]] ![[{TARGET}]]", tags="", proposed_tags="", updated_at=None)
    assert hydrated_store.get_backlink_counts(TARGET) == {REFERRER: 2, CHILD: 1}


def _store_from(monkeypatch, rows, contents):
    monkeypatch.setattr(note_store_module, "search_index", SearchIndex())
    monkeypatch.setattr(note_store_module, "get_cached_content", contents.__getitem__)
    monkeypatch.setattr(note_store_module, "get_cached_text", contents.__getitem__)
    monkeypatch.setattr(note_store_module, "get_cached_tags", lambda _: "")
    monkeypatch.setattr(note_store_module, "get_cached_proposed_tags", lambda _: "")
    monkeypatch.setattr(note_store_module, "get_ontology", TagOntology.empty)
    store = NoteStore()
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=rows)
    return store


def test_outside_referrers_are_the_notes_a_deletion_would_break(monkeypatch):
    # PARENT > KEPT_CHILD; OUTSIDE references KEPT_CHILD, OTHER references PARENT
    # twice (one note), and PARENT references its own child (inside: not counted).
    parent, kept_child, outside, other = (
        "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777",
    )
    contents = {parent: f"Parent ![[{kept_child}]]", kept_child: "Child", outside: f"[[{kept_child}]]",
                other: f"![[{parent}]] [[{parent}]]"}
    rows = [_row(parent, None, None, outside), _row(kept_child, parent, None, None),
            _row(outside, None, parent, other), _row(other, None, outside, None)]
    store = _store_from(monkeypatch, rows, contents)

    assert store.get_outside_referrer_ids(parent) == frozenset({outside, other})
    assert store.get_outside_referrer_ids(kept_child) == frozenset({outside, parent})
    assert store.get_outside_referrer_ids(other) == frozenset()


def test_outside_referrers_count_each_referring_note_once(hydrated_store):
    assert hydrated_store.get_outside_referrer_ids(TARGET) == frozenset({REFERRER, CHILD})
    # REFERRER's subtree holds both referring notes and nothing refers to it.
    assert hydrated_store.get_outside_referrer_ids(REFERRER) == frozenset()
