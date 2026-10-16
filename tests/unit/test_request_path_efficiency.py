from __future__ import annotations

import dataclasses
import random

import pytest

import app.security.sensitive_cache as sensitive_cache
import app.services.embedded_references as embedded_references
import app.services.snapshot as snapshot_module
import app.services.sync as sync
import app.services.undo_state as undo_state
from app.services.embedded_references import EmbedRenderContext
from app.services.embedded_references import collapsed_preview_source_has_hidden_content
from app.services.embedded_references import extract_collapsed_preview_source_html
from app.services.link_titles import LinkTitleStore
from app.services.note_store import NoteRecord
from app.services.snapshot import _SnapshotTraversalCache


_VIEWPORT = {"scrollY": 0, "scrollAnchor": None}


def test_collapsed_preview_head_matches_full_fragment_scan() -> None:
    rng = random.Random(23)
    pieces = [
        "<div>", "</div>", "<p>", "</p>", "<br>", "<br/>", "\n", "text", " ", "<img src=x>",
        "<b>", "</b>", "[[00000000-0000-0000-0000-000000000000]]", "&nbsp;", "<span></span>",
    ]
    for _ in range(3000):
        content = "".join(rng.choice(pieces) for _ in range(rng.randint(0, 14)))
        fragments = list(embedded_references._iter_collapsed_preview_meaningful_fragments(content))

        assert extract_collapsed_preview_source_html(content) == "".join(fragments[:1])
        assert collapsed_preview_source_has_hidden_content(content) == (len(fragments) > 1)


def test_collapsed_preview_head_stops_after_second_fragment(monkeypatch: pytest.MonkeyPatch) -> None:
    yielded: list[str] = []
    original = embedded_references._iter_collapsed_preview_meaningful_fragments

    def counting(content_html: str):
        for fragment in original(content_html):
            yielded.append(fragment)
            yield fragment

    monkeypatch.setattr(embedded_references, "_iter_collapsed_preview_meaningful_fragments", counting)
    monkeypatch.setattr(sensitive_cache, "_enabled", True)
    embedded_references._collapsed_preview_head.cache_clear()
    content = "".join(f"<div>line {index}</div>" for index in range(50))

    assert embedded_references._collapsed_preview_head(content) == ("<div>line 0</div>", True)
    assert yielded == ["<div>line 0</div>", "<div>line 1</div>"]
    embedded_references._collapsed_preview_head.cache_clear()


def test_view_metadata_carries_only_client_timestamps(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Record:
        created_at = None
        updated_at = None

    cache = _SnapshotTraversalCache()
    monkeypatch.setattr(cache, "get_note", lambda _note_id: _Record())

    assert cache.build_metadata("note") == {"createdAt": "", "updatedAt": ""}


def test_undo_budget_walk_skipped_for_existing_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    undo_state.reset_all_undo_state()
    undo_state.record_update("client", "context", "note", before="a", after="b",
                             before_tags="", after_tags="", viewport=_VIEWPORT)
    walks: list[object] = []
    original = undo_state.retained_bytes
    monkeypatch.setattr(undo_state, "retained_bytes", lambda value: walks.append(value) or original(value))  # shockharness: ignore[DEF003] reason="the stub records its call, then returns its value (append/update return None)"

    undo_state.maybe_reset_on_context("client", "context")
    assert walks == []

    undo_state.record_update("client", "context", "note", before="b", after="c",
                             before_tags="", after_tags="", viewport=_VIEWPORT)
    assert len(walks) == 1
    undo_state.reset_all_undo_state()


def test_undo_budget_still_enforced_when_undo_moves_an_operation(monkeypatch: pytest.MonkeyPatch) -> None:
    undo_state.reset_all_undo_state()
    undo_state.record_update("client", "context", "note", before="a", after="b",
                             before_tags="", after_tags="", viewport=_VIEWPORT)
    monkeypatch.setattr(undo_state, "apply_update_content", lambda *_args: None)
    monkeypatch.setattr(undo_state, "generate_new_uuid", lambda: None)
    monkeypatch.setattr(undo_state, "_compute_focus_note_id", lambda _op, *, direction: None)
    monkeypatch.setattr(undo_state, "UNDO_BYTES", 1)

    undo_state.undo("client", "token")

    assert undo_state._clients["client"].history == []
    assert undo_state._clients["client"].redo == []
    assert undo_state.undo_history_limited("client")
    undo_state.reset_all_undo_state()


def test_sync_capture_shares_immutable_clipboards_until_restore() -> None:
    sync.set_clipboard("fixture", [{"content": {"text": "original"}}])
    live = sync._clipboards["fixture"]

    snapshot = sync.capture_sync_state()

    assert snapshot[2]["fixture"] is live
    sync.restore_sync_state(snapshot)
    assert sync._clipboards["fixture"] is not live
    assert sync._clipboards["fixture"] == live
    sync.reset_state()



def _record(note_id: str, content: str) -> NoteRecord:
    return NoteRecord(
        id=note_id, parent_id=None, prev_id=None, next_id=None, is_collapsed=False,
        content=content, tags="", proposed_tags="", tag_terms=frozenset(), non_meta_tag_terms=frozenset(),
        proposed_tag_terms=frozenset(), proposed_non_meta_tag_terms=frozenset(), created_at=None, updated_at=None,
    )


@pytest.mark.parametrize("content", [
    "<img src=\"https://example.test/a.png\">",
    "<IMG SRC=https://example.test/a.png>",
])
def test_remote_image_notes_are_never_render_cached(content: str) -> None:
    assert not snapshot_module._is_render_cacheable(content)


@pytest.mark.parametrize("content", [
    "<div><b>plain</b> &amp; &#8217; &nbsp; <img src=\"data:image/png;base64,AA==\"></div>",
    "https://example.test/page",
    "<a href=\"http://x.test\">x</a>",
    "see [[00000000-0000-0000-0000-000000000000]]",
])
def test_plain_link_and_reference_notes_are_render_cacheable(content: str) -> None:
    assert snapshot_module._is_render_cacheable(content)


class _LiveWorld:
    """Mutable stand-in for the store and file registry behind a render context."""

    def __init__(self) -> None:
        self.notes: dict[str, NoteRecord] = {}
        self.children: dict[str | None, list[str]] = {}
        self.files: dict[str, object] = {}

    def context(self) -> EmbedRenderContext:
        def get_children(parent_id: str | None) -> list[str]:
            if parent_id in self.children:
                return list(self.children[parent_id])
            return []

        return EmbedRenderContext(
            has_note=lambda note_id: note_id in self.notes,
            get_note=lambda note_id: self.notes[note_id],
            get_children=get_children,
            has_file=lambda file_id: file_id in self.files,
            get_file=lambda file_id: self.files[file_id],
        )


def _prepare_render_cache(monkeypatch: pytest.MonkeyPatch, fake_render) -> None:
    monkeypatch.setattr(sensitive_cache, "_enabled", True)
    monkeypatch.setattr(snapshot_module.link_title_store, "get_render_generation", lambda: 0)
    monkeypatch.setattr(snapshot_module, "get_ontology_if_ready", lambda: None)
    monkeypatch.setattr(snapshot_module, "_render_note_view_html", fake_render)
    snapshot_module._VIEW_RENDER_MEMO.clear()


def _render_cached(rec: NoteRecord, world: _LiveWorld, *, collapsed: bool, backlinks: bool) -> str:
    return snapshot_module._cached_note_view_html(
        rec=rec, is_collapsed=collapsed, has_backlinks=backlinks, context=world.context(),
    )


def test_render_cache_rerenders_whenever_a_key_input_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    renders: list[tuple[str, bool, bool]] = []

    def fake_render(*, rec, is_collapsed, has_backlinks, context):
        renders.append((rec.content, is_collapsed, has_backlinks))
        return f"{rec.content}|{is_collapsed}|{has_backlinks}"

    _prepare_render_cache(monkeypatch, fake_render)
    ontology = [object()]
    generation = [0]
    monkeypatch.setattr(snapshot_module, "get_ontology_if_ready", lambda: ontology[0])
    monkeypatch.setattr(snapshot_module.link_title_store, "get_render_generation", lambda: generation[0])
    world = _LiveWorld()
    original = _record("note", "<div>one</div>")

    assert _render_cached(original, world, collapsed=False, backlinks=False) == "<div>one</div>|False|False"
    assert _render_cached(original, world, collapsed=False, backlinks=False) == "<div>one</div>|False|False"
    assert len(renders) == 1

    # A replaced record re-renders even when it compares equal field by field.
    _render_cached(dataclasses.replace(original), world, collapsed=False, backlinks=False)
    _render_cached(_record("note", "<div>two</div>"), world, collapsed=False, backlinks=False)
    assert _render_cached(original, world, collapsed=True, backlinks=False) == "<div>one</div>|True|False"
    assert _render_cached(original, world, collapsed=False, backlinks=True) == "<div>one</div>|False|True"
    ontology[0] = object()
    _render_cached(original, world, collapsed=False, backlinks=False)
    generation[0] = 1
    _render_cached(original, world, collapsed=False, backlinks=False)
    assert len(renders) == 7
    snapshot_module._VIEW_RENDER_MEMO.clear()


def test_render_cache_revalidates_every_referenced_note_and_file(monkeypatch: pytest.MonkeyPatch) -> None:
    renders: list[str] = []

    def fake_render(*, rec, is_collapsed, has_backlinks, context):
        # Mimic an embed render: reads the target, its children, and a file.
        target = context.get_note("target")
        child_ids = context.get_children("target")
        file_label = "no-file"
        if context.has_file("file"):
            file_label = context.get_file("file")
        missing = context.has_note("missing")
        rendered = f"{target.content}|{child_ids}|{file_label}|{missing}"
        renders.append(rendered)
        return rendered

    _prepare_render_cache(monkeypatch, fake_render)
    world = _LiveWorld()
    world.notes["target"] = _record("target", "<div>target v1</div>")
    world.children["target"] = ["child-a"]
    world.files["file"] = "file rev 1"
    host = _record("host", "<div>![[target]]</div>")

    def render() -> str:
        return _render_cached(host, world, collapsed=False, backlinks=False)

    render()
    render()
    assert len(renders) == 1

    world.notes["target"] = _record("target", "<div>target v2</div>")
    assert "target v2" in render()
    world.children["target"] = ["child-a", "child-b"]
    assert "child-b" in render()
    world.files["file"] = "file rev 2"
    assert "file rev 2" in render()
    del world.files["file"]
    assert "no-file" in render()
    world.notes["missing"] = _record("missing", "<div>now exists</div>")
    assert render().endswith("|True")
    assert len(renders) == 6
    render()
    assert len(renders) == 6
    snapshot_module._VIEW_RENDER_MEMO.clear()


def test_renders_with_remote_image_proxy_sources_are_not_stored(monkeypatch: pytest.MonkeyPatch) -> None:
    renders: list[str] = []

    def fake_render(*, rec, is_collapsed, has_backlinks, context):
        renders.append(rec.id)
        return '<img data-remote-image-proxy-src="/api2/remote-images/token">'

    _prepare_render_cache(monkeypatch, fake_render)
    world = _LiveWorld()
    host = _record("host", "<div>![[target]]</div>")

    _render_cached(host, world, collapsed=False, backlinks=False)
    _render_cached(host, world, collapsed=False, backlinks=False)

    assert len(renders) == 2
    snapshot_module._VIEW_RENDER_MEMO.clear()


def test_render_cache_hits_replay_link_title_fetch_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    requested: list[str] = []
    monkeypatch.setattr(sensitive_cache, "_enabled", True)
    monkeypatch.setattr(snapshot_module.link_title_store, "get_render_generation", lambda: 0)
    monkeypatch.setattr(snapshot_module.link_title_store, "get_ok_title", lambda _url: None)
    monkeypatch.setattr(snapshot_module.link_title_store, "maybe_enqueue_fetch", requested.append)
    monkeypatch.setattr(snapshot_module, "get_ontology_if_ready", lambda: None)
    snapshot_module._VIEW_RENDER_MEMO.clear()
    world = _LiveWorld()
    rec = _record("note", "<div>https://example.test/page</div>")
    world.notes["note"] = rec

    first = _render_cached(rec, world, collapsed=False, backlinks=False)
    second = _render_cached(rec, world, collapsed=False, backlinks=False)

    assert first == second
    assert snapshot_module._VIEW_RENDER_MEMO.info().hits == 1
    # The fresh render requested the fetch once; the hit replays that request.
    assert requested == ["https://example.test/page"] * 2
    snapshot_module._VIEW_RENDER_MEMO.clear()


def test_render_cache_shows_link_title_after_it_arrives(monkeypatch: pytest.MonkeyPatch) -> None:
    titles: dict[str, str] = {}
    generation = [0]
    store = snapshot_module.link_title_store
    monkeypatch.setattr(sensitive_cache, "_enabled", True)
    monkeypatch.setattr(store, "get_render_generation", lambda: generation[0])

    def lookup_title(url: str) -> str | None:
        if url in titles:
            return titles[url]
        return None

    monkeypatch.setattr(store, "get_ok_title", lookup_title)
    monkeypatch.setattr(store, "get_diagnostic", lambda _url: None)
    monkeypatch.setattr(store, "maybe_enqueue_fetch", lambda _url: None)
    monkeypatch.setattr(snapshot_module, "get_ontology_if_ready", lambda: None)
    snapshot_module._VIEW_RENDER_MEMO.clear()
    url = "https://example.test/page"
    world = _LiveWorld()
    rec = _record("note", f"<div>{url}</div>")
    world.notes["note"] = rec

    before = _render_cached(rec, world, collapsed=False, backlinks=False)
    titles[url] = "Example Page Title"
    generation[0] += 1
    after = _render_cached(rec, world, collapsed=False, backlinks=False)

    assert "Example Page Title" not in before
    assert "Example Page Title" in after
    snapshot_module._VIEW_RENDER_MEMO.clear()


def test_sensitive_memo_stores_nothing_while_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    memo = sensitive_cache.SensitiveMemo(maxsize=4, max_bytes=1024 * 1024)
    monkeypatch.setattr(sensitive_cache, "_enabled", False)
    memo.store("key", "plaintext")
    monkeypatch.setattr(sensitive_cache, "_enabled", True)

    assert memo.lookup("key") == (False, None)
    memo.store("key", "plaintext")
    assert memo.lookup("key") == (True, "plaintext")
    sensitive_cache.clear_sensitive_caches()
    assert memo.lookup("key") == (False, None)


def test_link_title_render_generation_tracks_changes_the_revision_skips() -> None:
    store = LinkTitleStore()
    start = store.get_render_generation()

    store.discard_in_flight("https://example.test/page")
    after_discard = store.get_render_generation()
    store.reset()

    assert store.get_revision() == 0
    assert start < after_discard < store.get_render_generation()
