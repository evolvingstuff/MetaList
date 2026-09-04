from __future__ import annotations

import pytest

import app.services.content_cache as content_cache
import app.services.note_store as note_store_module
from app.services.note_store import NoteStore
from app.services.search_index import SearchIndex, SearchRecord
from app.services.tag_ontology import TagOntology


class _FakeDatabase:
    def connection(self) -> object:
        return object()


def _cache_row(note_id: str, content: str, tags: str) -> dict[str, object]:
    return {
        "id": note_id,
        "content": content,
        "tags": tags,
        "proposed_tags": "",
        "encryption_nonce": None,
        "encryption_tag": None,
        "tags_encryption_nonce": None,
        "tags_encryption_tag": None,
        "proposed_tags_encryption_nonce": None,
        "proposed_tags_encryption_tag": None,
        "parent_id": None,
        "prev_id": None,
        "next_id": None,
        "is_collapsed": False,
        "created_at": None,
        "updated_at": None,
    }


def test_cache_hydration_sanitizes_and_extracts_text_once_per_note(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [
        _cache_row("one", "<div>One</div>", "alpha"),
        _cache_row("two", "<div>Two</div>", "beta"),
    ]
    sanitize_calls: list[str] = []
    strip_calls: list[str] = []

    def sanitize_once(content: str) -> str:
        sanitize_calls.append(content)
        return content

    def strip_once(content: str) -> str:
        strip_calls.append(content)
        return content.removeprefix("<div>").removesuffix("</div>")

    monkeypatch.setattr(content_cache, "fetch_all_for_cache", lambda _connection: rows)
    monkeypatch.setattr(content_cache, "sanitize_note_html", sanitize_once)
    monkeypatch.setattr(content_cache, "strip_html", strip_once)
    monkeypatch.setattr(content_cache, "_CACHE_TIMING_ENABLED", False)
    monkeypatch.setattr(content_cache, "_search_cache", {})
    monkeypatch.setattr(content_cache, "_tag_cache", {})
    monkeypatch.setattr(content_cache, "_proposed_tag_cache", {})
    monkeypatch.setattr(content_cache, "_text_cache", {})

    returned_rows = content_cache.populate_cache_from_db(_FakeDatabase())

    assert returned_rows == rows
    assert sanitize_calls == ["<div>One</div>", "<div>Two</div>"]
    assert strip_calls == ["<div>One</div>", "<div>Two</div>"]
    assert content_cache.get_cached_content("one") == "<div>One</div>"
    assert content_cache.get_cached_tags("two") == "beta"
    assert content_cache.get_cached_text("two") == "Two"


def test_note_store_reuses_plain_text_created_during_cache_hydration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [
        {
            "id": "one",
            "parent_id": None,
            "prev_id": None,
            "next_id": None,
            "is_collapsed": False,
        }
    ]
    monkeypatch.setattr(note_store_module, "get_cached_content", lambda _note_id: "<div>One</div>")
    monkeypatch.setattr(note_store_module, "get_cached_tags", lambda _note_id: "alpha")
    monkeypatch.setattr(note_store_module, "get_cached_proposed_tags", lambda _note_id: "")
    monkeypatch.setattr(note_store_module, "get_cached_text", lambda _note_id: "One")
    monkeypatch.setattr(
        note_store_module,
        "strip_html",
        lambda _content: (_ for _ in ()).throw(AssertionError("plain text must be reused")),
    )
    monkeypatch.setattr(note_store_module, "get_ontology", TagOntology.empty)
    monkeypatch.setattr(note_store_module, "search_index", SearchIndex())

    store = NoteStore()
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=rows)

    assert store.snapshot()["one"].content == "<div>One</div>"
    assert note_store_module.search_index.query_note_ids('"one"') == {"one"}


def test_text_search_uses_in_memory_text_without_eager_trigram_postings() -> None:
    index = SearchIndex()
    records = [
        SearchRecord(
            note_id="one",
            content_text="The quick brown fox",
            tags="animal",
            tag_terms=frozenset({"animal"}),
        ),
        SearchRecord(
            note_id="two",
            content_text="The slow green turtle",
            tags="animal",
            tag_terms=frozenset({"animal"}),
        ),
    ]
    index.rebuild(
        records,
        raw_tag_terms_by_id={"one": frozenset({"animal"}), "two": frozenset({"animal"})},
        progress_update=lambda _processed: None,
        progress_interval=1000,
    )

    assert index.query_note_ids('"quick brown"') == {"one"}
    assert index.query_note_ids('animal "green turtle"') == {"two"}
    assert index.query_note_ids('-"quick brown"') == {"two"}
    assert not hasattr(index, "_tri_notes")
