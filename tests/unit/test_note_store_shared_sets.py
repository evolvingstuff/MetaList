"""The note store keeps one copy of each distinct inherited tag set: siblings that
inherit the same tags share it, and a copy goes with its last use."""

from __future__ import annotations

import pytest

import app.services.note_store as note_store_module
from app.services.note_store import NoteStore
from app.services.search_index import SearchIndex
from app.services.tag_ontology import TagOntology

_TAG_SET_MAPS = (
    "_effective_non_meta_tag_terms", "_effective_proposed_non_meta_tag_terms",
    "_subtree_non_meta_tag_terms", "_subtree_proposed_non_meta_tag_terms",
)


def _row(note_id: str, parent_id: str | None, prev_id: str | None, next_id: str | None) -> dict[str, object]:
    return {"id": note_id, "parent_id": parent_id, "prev_id": prev_id, "next_id": next_id,
            "is_collapsed": 0, "created_at": None, "updated_at": None}


@pytest.fixture
def family(monkeypatch: pytest.MonkeyPatch) -> NoteStore:
    """A parent tagged "trip japan" with three untagged children, and a stranger."""
    tags = {"parent": "trip japan", "b": "", "c": "", "d": "", "stranger": "work"}
    monkeypatch.setattr(note_store_module, "search_index", SearchIndex())
    monkeypatch.setattr(note_store_module, "get_cached_content", lambda note_id: f"<div>{note_id}</div>")
    monkeypatch.setattr(note_store_module, "get_cached_tags", lambda note_id: tags[note_id])
    monkeypatch.setattr(note_store_module, "get_cached_proposed_tags", lambda note_id: "")
    monkeypatch.setattr(note_store_module, "get_cached_text", lambda note_id: note_id)
    monkeypatch.setattr(note_store_module, "get_ontology", lambda: TagOntology.empty())
    store = NoteStore()
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=[
        _row("parent", None, None, "stranger"),
        _row("b", "parent", None, "c"), _row("c", "parent", "b", "d"), _row("d", "parent", "c", None),
        _row("stranger", None, "parent", None),
    ])
    return store


def _held_sets(store: NoteStore) -> set[frozenset[str]]:
    held = set()
    for name in _TAG_SET_MAPS:
        tag_map = getattr(store, name)
        held.update(tag_map[note_id] for note_id in store.list_note_ids() if note_id in tag_map)
    return held


def test_siblings_that_inherit_the_same_tags_share_one_set(family: NoteStore) -> None:
    effective = family._effective_non_meta_tag_terms
    assert effective["b"] == frozenset({"trip", "japan"})
    assert effective["b"] is effective["c"] is effective["d"] is effective["parent"]


def test_a_set_goes_with_its_last_use(family: NoteStore) -> None:
    family.apply_bulk_tag_sources({"parent": ("work", "")})
    family.remove_note("stranger")
    held = family._shared_tag_sets.distinct_sets()
    assert frozenset({"trip", "japan"}) not in held
    # What the maps hold is all the shared copies hold: nothing is left over.
    assert held == _held_sets(family)
