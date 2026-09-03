from __future__ import annotations

from typing import Mapping

from types import SimpleNamespace

import pytest

import app.services.note_store as note_store_module
from app.services.note_store import NoteStore
from app.services.search_index import SearchIndex
from app.services.tag_ontology import compile_rules, parse_rules_text


def _load_store_with_ontology(
    monkeypatch: pytest.MonkeyPatch,
    *,
    content_by_id: Mapping[str, str],
    tags_by_id: Mapping[str, str],
    proposed_tags_by_id: Mapping[str, str],
    rows: list[dict[str, object]],
    rules_text: str,
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

    parsed = parse_rules_text(text=rules_text, filename="test_rules")
    ontology = compile_rules(rules=parsed, filename="test_rules")
    monkeypatch.setattr(note_store_module, "get_ontology", lambda: ontology)

    store = NoteStore()
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=rows)
    return store, index


def test_search_matches_ontology_implied_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    content_by_id = {"n": "<div>hello</div>"}
    tags_by_id = {"n": "alpha"}
    rows = [{"id": "n", "parent_id": None, "prev_id": None, "next_id": None, "is_collapsed": 0}]

    _, index = _load_store_with_ontology(
        monkeypatch,
        content_by_id=content_by_id,
        tags_by_id=tags_by_id,
        proposed_tags_by_id={"n": ""},
        rows=rows,
        rules_text="alpha => beta\n",
    )

    assert index.query_note_ids("beta") == {"n"}


def test_search_matches_ontology_text_matchers(monkeypatch: pytest.MonkeyPatch) -> None:
    content_by_id = {"n": "<div>TODO ship it</div>"}
    tags_by_id = {"n": ""}
    rows = [{"id": "n", "parent_id": None, "prev_id": None, "next_id": None, "is_collapsed": 0}]

    _, index = _load_store_with_ontology(
        monkeypatch,
        content_by_id=content_by_id,
        tags_by_id=tags_by_id,
        proposed_tags_by_id={"n": ""},
        rows=rows,
        rules_text='"TODO" => todo\n',
    )

    assert index.query_note_ids("todo") == {"n"}


def test_search_applies_ontology_to_proposed_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    content_by_id = {"n": "<div>hello</div>"}
    tags_by_id = {"n": "human"}
    rows = [
        {"id": "n", "parent_id": None, "prev_id": None, "next_id": None, "is_collapsed": 0}
    ]

    _, index = _load_store_with_ontology(
        monkeypatch,
        content_by_id=content_by_id,
        tags_by_id=tags_by_id,
        proposed_tags_by_id={"n": "transformer"},
        rows=rows,
        rules_text="transformer => machine-learning\nmachine-learning => AI\n",
    )

    assert index.query_note_ids("transformer") == {"n"}
    assert index.query_note_ids("machine-learning") == {"n"}
    assert index.query_note_ids("AI") == {"n"}
    assert index.query_note_ids("human AI") == {"n"}
    assert index.query_note_ids("-AI") == set()
    assert "transformer" in index.suggest_all_tag_completions(query="trans")
    assert "machine-learning" in index.suggest_all_tag_completions(query="machine")
    assert "AI" in index.suggest_all_tag_completions(query="A")
