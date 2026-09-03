from __future__ import annotations

from types import SimpleNamespace

import pytest

import app.services.note_store as note_store_module
from app.services.note_store import NoteStore
from app.services.search_index import SearchIndex
from app.services.tag_ontology import TagOntology


def _load_store(
    monkeypatch: pytest.MonkeyPatch,
    *,
    content_by_id: dict[str, str],
    tags_by_id: dict[str, str],
    proposed_tags_by_id: dict[str, str],
    rows: list[dict[str, object]],
) -> tuple[NoteStore, SearchIndex]:
    index = SearchIndex()
    monkeypatch.setattr(note_store_module, "search_index", index)
    monkeypatch.setattr(note_store_module, "get_cached_content", lambda note_id: content_by_id[note_id])
    monkeypatch.setattr(note_store_module, "get_cached_tags", lambda note_id: tags_by_id[note_id])
    monkeypatch.setattr(
        note_store_module,
        "get_cached_proposed_tags",
        lambda note_id: proposed_tags_by_id[note_id],
    )
    monkeypatch.setattr(
        note_store_module,
        "get_cached_text",
        lambda note_id: note_store_module.strip_html(content_by_id[note_id]),
    )
    monkeypatch.setattr(note_store_module, "get_ontology", lambda: TagOntology.empty())

    store = NoteStore()
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=rows)
    return store, index


def test_implicit_tag_inheritance_excludes_meta_and_comments(monkeypatch: pytest.MonkeyPatch) -> None:
    # Tree:
    # a(@monospace x /*secret*/)
    #   b(y)
    #     c(z)
    content_by_id = {"a": "<div>a</div>", "b": "<div>b</div>", "c": "<div>c</div>"}
    tags_by_id = {"a": "@monospace x /*secret*/", "b": "y", "c": "z"}
    rows = [
        {"id": "a", "parent_id": None, "prev_id": None, "next_id": None, "is_collapsed": 0},
        {"id": "b", "parent_id": "a", "prev_id": None, "next_id": None, "is_collapsed": 0},
        {"id": "c", "parent_id": "b", "prev_id": None, "next_id": None, "is_collapsed": 0},
    ]
    _, index = _load_store(
        monkeypatch,
        content_by_id=content_by_id,
        tags_by_id=tags_by_id,
        proposed_tags_by_id={"a": "", "b": "", "c": ""},
        rows=rows,
    )

    assert index.query_note_ids("x y z") == {"c"}
    assert index.query_note_ids("@monospace x y z") == set()
    assert index.query_note_ids('"secret"') == {"a"}


def test_local_effective_tags_exclude_ancestor_inheritance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content_by_id = {"root": "<div>root</div>", "child": "<div>child</div>"}
    tags_by_id = {"root": "ancestor-tag", "child": "child-tag"}
    rows = [
        {
            "id": "root",
            "parent_id": None,
            "prev_id": None,
            "next_id": None,
            "is_collapsed": 0,
        },
        {
            "id": "child",
            "parent_id": "root",
            "prev_id": None,
            "next_id": None,
            "is_collapsed": 0,
        },
    ]
    store, index = _load_store(
        monkeypatch,
        content_by_id=content_by_id,
        tags_by_id=tags_by_id,
        proposed_tags_by_id={"root": "", "child": ""},
        rows=rows,
    )

    assert index.list_effective_tag_terms_for_note("child") == frozenset(
        {"ancestor-tag", "child-tag"}
    )
    assert store.list_local_effective_tag_terms(
        note_id="child",
        plaintext="child",
    ) == frozenset({"child-tag"})


def test_implicit_tag_inheritance_updates_when_ancestor_tags_change(monkeypatch: pytest.MonkeyPatch) -> None:
    # Tree:
    # a(x)
    #   b(y)
    #     c(z)
    content_by_id = {"a": "<div>a</div>", "b": "<div>b</div>", "c": "<div>c</div>"}
    tags_by_id = {"a": "x", "b": "y", "c": "z"}
    rows = [
        {"id": "a", "parent_id": None, "prev_id": None, "next_id": None, "is_collapsed": 0},
        {"id": "b", "parent_id": "a", "prev_id": None, "next_id": None, "is_collapsed": 0},
        {"id": "c", "parent_id": "b", "prev_id": None, "next_id": None, "is_collapsed": 0},
    ]
    store, index = _load_store(
        monkeypatch,
        content_by_id=content_by_id,
        tags_by_id=tags_by_id,
        proposed_tags_by_id={"a": "", "b": "", "c": ""},
        rows=rows,
    )

    assert index.query_note_ids("x y z") == {"c"}

    store.update_note_from_db(SimpleNamespace(id="a"), "<div>a</div>", "x2", "")
    assert index.query_note_ids("x y z") == set()
    assert index.query_note_ids("x2 y z") == {"c"}


def test_implicit_tag_inheritance_updates_when_notes_move(monkeypatch: pytest.MonkeyPatch) -> None:
    # Tree:
    # a(x)
    # d
    #   b(y)
    #     c(z)
    content_by_id = {
        "a": "<div>a</div>",
        "d": "<div>d</div>",
        "b": "<div>b</div>",
        "c": "<div>c</div>",
    }
    tags_by_id = {"a": "x", "d": "", "b": "y", "c": "z"}
    rows = [
        {"id": "a", "parent_id": None, "prev_id": None, "next_id": "d", "is_collapsed": 0},
        {"id": "d", "parent_id": None, "prev_id": "a", "next_id": None, "is_collapsed": 0},
        {"id": "b", "parent_id": "d", "prev_id": None, "next_id": None, "is_collapsed": 0},
        {"id": "c", "parent_id": "b", "prev_id": None, "next_id": None, "is_collapsed": 0},
    ]
    store, index = _load_store(
        monkeypatch,
        content_by_id=content_by_id,
        tags_by_id=tags_by_id,
        proposed_tags_by_id={"a": "", "b": "", "c": "", "d": ""},
        rows=rows,
    )

    assert index.query_note_ids("x y z") == set()

    store.update_metadata_from_db(
        SimpleNamespace(id="b", parent_id="a", prev_id=None, next_id=None),
        rebuild=False,
    )

    assert index.query_note_ids("x y z") == {"c"}


def test_proposed_tags_are_searchable_and_inherited_but_meta_proposals_are_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content_by_id = {"root": "<div>root</div>", "child": "<div>child</div>"}
    tags_by_id = {"root": "human-root", "child": "human-child"}
    proposed_tags_by_id = {"root": "robot-root @red", "child": "robot-child"}
    rows = [
        {
            "id": "root",
            "parent_id": None,
            "prev_id": None,
            "next_id": None,
            "is_collapsed": 0,
        },
        {
            "id": "child",
            "parent_id": "root",
            "prev_id": None,
            "next_id": None,
            "is_collapsed": 0,
        },
    ]
    store, index = _load_store(
        monkeypatch,
        content_by_id=content_by_id,
        tags_by_id=tags_by_id,
        proposed_tags_by_id=proposed_tags_by_id,
        rows=rows,
    )

    assert index.query_note_ids("robot-root") == {"root", "child"}
    assert index.query_note_ids("human-child robot-root robot-child") == {"child"}
    assert index.query_note_ids("@red") == {"root"}
    assert index.query_untagged_note_ids() == set()

    store.update_note_from_db(
        SimpleNamespace(id="root"),
        "<div>root</div>",
        "human-root",
        "",
    )
    assert index.query_note_ids("robot-root") == set()
    assert index.query_note_ids("human-child robot-child") == {"child"}
