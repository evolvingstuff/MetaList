from __future__ import annotations

import base64
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Dict, List, Optional

import pytest
from starlette.requests import Request

import app.api.routes.notes as notes_route
import app.services.html_export as export_module
import app.services.snapshot as snapshot_module
from app.services.content_formatting import CREDENTIAL_MASK
from app.services.html_export import build_notes_export_document
from app.services.search_index import SearchIndex
from app.services.search_index import SearchRecord
from app.services.search_index import extract_tags_for_search


@dataclass(frozen=True)
class _Note:
    id: str
    parent_id: Optional[str]
    prev_id: Optional[str]
    next_id: Optional[str]
    is_collapsed: bool
    content: str
    tags: str


class _FakeNoteStore:
    def __init__(self, *, notes: Dict[str, _Note], children_by_parent: Dict[Optional[str], List[str]]):
        self._notes = notes
        self._children_by_parent = children_by_parent

    def has_note(self, note_id: str) -> bool:
        return note_id in self._notes

    def get_note(self, note_id: str) -> _Note:
        return self._notes[note_id]

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        return list(self._children_by_parent.get(parent_id, []))

    def list_note_ids(self) -> List[str]:
        return list(self._notes)


class _FakeFileRegistry:
    def __init__(self, file_ids: set[str]) -> None:
        self._file_ids = file_ids

    def has_file(self, file_id: str) -> bool:
        return file_id in self._file_ids


class _FakePresenceStore:
    def __init__(self, note_ids: set[str]) -> None:
        self._note_ids = note_ids

    def has_note(self, note_id: str) -> bool:
        return note_id in self._note_ids


ROOT_ID = "11111111-1111-1111-1111-111111111111"
LINKED_ID = "22222222-2222-2222-2222-222222222222"
CHILD_ID = "33333333-3333-3333-3333-333333333333"


def test_build_notes_export_document_expands_collapsed_notes_and_redacts_passwords(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "root": _Note("root", None, None, None, True, "<div>Parent</div>", ""),
        "child": _Note("child", "root", None, None, False, "<div>sekret</div>", "@password"),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["root"], "root": ["child"]},
    )

    monkeypatch.setattr(export_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(export_module, "file_registry", _FakeFileRegistry(set()))

    html = build_notes_export_document(
        purpose="download",
        title="",
        include_credentials=False,
        sort_mode="normal",
        is_untagged_view=False,
        search=None,
        theme="light",
        token="token",
        root_note_id=None,
    )

    assert 'data-theme="light"' in html
    assert "Parent" in html
    assert "meta-credential-password" in html
    assert "sekret" not in html
    assert f'data-redacted="true" data-copy-value="{CREDENTIAL_MASK}">{CREDENTIAL_MASK}<' in html
    # A note with children gets MetaList's arrow, starting expanded.
    assert '<button type="button" class="note-collapse-toggle" aria-expanded="true"' in html
    assert 'class="note-children"' in html
    assert "filter: blur(4px)" in html
    assert 'id="login-page"' not in html
    assert 'id="main-app"' not in html
    assert 'id="search-input"' not in html
    assert "\n" in html
    assert '  <main id="notes-container">' in html
    assert '    <article class="note" id="note-root" data-can-collapse="true">' in html
    assert '      <div class="note-content">' in html


def test_build_notes_export_document_can_export_single_note_subtree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "root-a": _Note("root-a", None, None, "root-b", True, "<div>Selected root</div>", ""),
        "child-a": _Note("child-a", "root-a", None, None, True, "<div>sekret</div>", "@password"),
        "root-b": _Note("root-b", None, "root-a", None, False, "<div>Other root</div>", ""),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["root-a", "root-b"], "root-a": ["child-a"]},
    )

    monkeypatch.setattr(export_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(export_module, "file_registry", _FakeFileRegistry(set()))

    html = build_notes_export_document(
        purpose="download",
        title="",
        include_credentials=False,
        sort_mode="normal",
        is_untagged_view=False,
        search="other",
        theme="light",
        token="token",
        root_note_id="root-a",
    )

    assert "Selected root" in html
    assert "Other root" not in html
    assert "sekret" not in html
    assert f'data-redacted="true" data-copy-value="{CREDENTIAL_MASK}">{CREDENTIAL_MASK}<' in html
    # A note with children gets MetaList's arrow, starting expanded.
    assert '<button type="button" class="note-collapse-toggle" aria-expanded="true"' in html
    assert 'class="note-children"' in html


def test_export_notes_html_route_passes_note_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(notes_route, "_require_bearer_token", lambda request: "token")
    monkeypatch.setattr(notes_route, "note_store", _FakePresenceStore({"note-123"}))
    monkeypatch.setattr(notes_route, "build_notes_export_filename", lambda title: "export.html")
    monkeypatch.setattr(notes_route, "_resolve_tab_sort_mode", lambda tab_id: "alphabetical")

    def _build_document(
        *, search, sort_mode, is_untagged_view, theme, token, root_note_id, purpose, title, include_credentials,
    ):
        captured["include_credentials"] = include_credentials
        captured["purpose"] = purpose
        captured["title"] = title
        captured["search"] = search
        captured["sort_mode"] = sort_mode
        captured["is_untagged_view"] = is_untagged_view
        captured["theme"] = theme
        captured["token"] = token
        captured["root_note_id"] = root_note_id
        return "<!DOCTYPE html><html></html>"

    monkeypatch.setattr(notes_route, "build_notes_export_document", _build_document)

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api2/notes/export-html",
            "headers": [],
            "query_string": b"search_query=tag&theme=dark&note_id=note-123&tab_id=tab-1&is_untagged_view=true&purpose=print&title=Trip&include_credentials=true",
        }
    )

    response = notes_route.export_notes_html(request)

    assert response.status_code == 200
    assert captured == {
        "include_credentials": True,
        "purpose": "print",
        "title": "Trip",
        "search": "tag",
        "sort_mode": "alphabetical",
        "is_untagged_view": True,
        "theme": "light",
        "token": "token",
        "root_note_id": "note-123",
    }


def test_export_notes_html_route_rejects_missing_note_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(notes_route, "_require_bearer_token", lambda request: "token")
    monkeypatch.setattr(notes_route, "note_store", _FakePresenceStore(set()))

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api2/notes/export-html",
            "headers": [],
            "query_string": b"search_query=&theme=light&note_id=missing&tab_id=tab-1&is_untagged_view=false&purpose=download&title=&include_credentials=false",
        }
    )

    with pytest.raises(notes_route.HTTPException) as excinfo:
        notes_route.export_notes_html(request)

    assert excinfo.value.status_code == 404
    assert excinfo.value.detail == "Note not found: missing"


def test_build_notes_export_document_uses_search_scope_and_static_reference_markup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    file_id = "f9989d26-5ec9-4b09-9647-909c58ad997a"
    notes = {
        ROOT_ID: _Note(ROOT_ID, None, None, LINKED_ID, False, f"<div>[[{LINKED_ID}]] ![[{file_id}]]</div>", "match"),
        LINKED_ID: _Note(LINKED_ID, None, ROOT_ID, None, False, "<div>linked first line</div><div>linked second line</div>", ""),
        CHILD_ID: _Note(CHILD_ID, ROOT_ID, None, None, False, "<div>hidden child</div>", ""),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: [ROOT_ID, LINKED_ID], ROOT_ID: [CHILD_ID]},
    )
    index = SearchIndex()
    index.rebuild(
        [
            SearchRecord(
                note_id=note.id,
                content_text=note.content,
                tags=note.tags,
                tag_terms=extract_tags_for_search(note.tags),
            )
            for note in notes.values()
        ],
        raw_tag_terms_by_id={
            note.id: extract_tags_for_search(note.tags)
            for note in notes.values()
        },
        progress_update=lambda _: None,
        progress_interval=1000,
    )
    file_record = SimpleNamespace(
        id=file_id,
        title="photo.png",
        original_filename="photo.png",
        mime_type="image/png",
        size_bytes=8192,
        thumbnail_kind="image",
    )

    monkeypatch.setattr(export_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "search_index", index)
    monkeypatch.setattr(export_module, "file_registry", _FakeFileRegistry({file_id}))
    monkeypatch.setattr(export_module, "get_file_reference_record", lambda file_id, token: file_record)
    monkeypatch.setattr(
        export_module,
        "download_file",
        lambda file_id, token: SimpleNamespace(record=file_record, content_bytes=b"png-bytes"),
    )

    html = build_notes_export_document(
        purpose="download",
        title="",
        include_credentials=False,
        sort_mode="normal",
        is_untagged_view=False,
        search="match",
        theme="dark",
        token="token",
        root_note_id=None,
    )

    assert 'data-theme="dark"' in html
    assert "linked first line" in html
    assert "linked second line" not in html
    assert "hidden child" not in html
    assert 'class="note-reference-toggle"' not in html
    assert "download image" not in html
    assert "Image attachment: photo.png" not in html
    assert "note-file-image-static" in html
    assert 'src="data:image/png;base64,' in html
    assert base64.b64encode(b"png-bytes").decode("ascii") in html
    assert 'id="login-page"' not in html
    assert 'id="main-app"' not in html


def test_build_notes_export_document_redacts_password_reference_preview(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        ROOT_ID: _Note(ROOT_ID, None, None, LINKED_ID, False, f"<div>[[{LINKED_ID}]]</div>", ""),
        LINKED_ID: _Note(LINKED_ID, None, ROOT_ID, None, False, "<div>sekret</div>", "@password"),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: [ROOT_ID, LINKED_ID]},
    )

    monkeypatch.setattr(export_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(export_module, "file_registry", _FakeFileRegistry(set()))

    html = build_notes_export_document(
        purpose="download",
        title="",
        include_credentials=False,
        sort_mode="normal",
        is_untagged_view=False,
        search=None,
        theme="light",
        token="token",
        root_note_id=None,
    )

    assert "sekret" not in html
    assert CREDENTIAL_MASK in html
    assert "note-reference-link-static meta-credential-password" in html
    assert 'id="login-page"' not in html
    assert 'id="main-app"' not in html


def test_build_notes_export_document_renders_markdown_meta_server_side(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "root": _Note(
            "root",
            None,
            None,
            None,
            False,
            "<div># Title</div><div>Paragraph with [docs](https://example.com)</div><div>- one</div><div>- two</div>",
            "@markdown",
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["root"]},
    )

    monkeypatch.setattr(export_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(export_module, "file_registry", _FakeFileRegistry(set()))

    html = build_notes_export_document(
        purpose="download",
        title="",
        include_credentials=False,
        sort_mode="normal",
        is_untagged_view=False,
        search=None,
        theme="light",
        token="token",
        root_note_id=None,
    )

    assert 'data-markdown-rendered="true"' in html
    assert "<h1>Title</h1>" in html
    assert '<ul><li>one</li><li>two</li></ul>' in html
    assert (
        '<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>'
        in html
    )
    assert "# Title" not in html


def test_build_notes_export_document_renders_latex_meta_server_side(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = {
        "root": _Note(
            "root",
            None,
            None,
            None,
            False,
            "<div>\\frac{1}{2}</div>",
            "@latex",
        ),
    }
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: ["root"]},
    )

    monkeypatch.setattr(export_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "note_store", store)
    monkeypatch.setattr(export_module, "file_registry", _FakeFileRegistry(set()))

    html = build_notes_export_document(
        purpose="download",
        title="",
        include_credentials=False,
        sort_mode="normal",
        is_untagged_view=False,
        search=None,
        theme="dark",
        token="token",
        root_note_id=None,
    )

    assert '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">' in html
    assert "<mfrac>" in html
    assert "\\frac{1}{2}" not in html


def test_an_exported_view_is_the_view_as_shown(monkeypatch: pytest.MonkeyPatch) -> None:
    # Its search, sort order and kind decide the roots and their order, as /notes/view does;
    # children the search hides (gray bars on screen) are left out.
    notes = {
        ROOT_ID: _Note(ROOT_ID, None, None, LINKED_ID, False, "<div>Banana</div>", "fruit"),
        LINKED_ID: _Note(LINKED_ID, None, ROOT_ID, None, False, "<div>Apple</div>", "fruit"),
        CHILD_ID: _Note(CHILD_ID, ROOT_ID, None, None, False, "<div>excluded child</div>", ""),
    }
    store = _FakeNoteStore(notes=notes, children_by_parent={None: [ROOT_ID, LINKED_ID], ROOT_ID: [CHILD_ID]})
    monkeypatch.setattr(export_module, "note_store", store)
    calls = []

    def resolve(*, search, sort_mode, is_untagged_view):
        calls.append((search, sort_mode, is_untagged_view))
        return snapshot_module.ResolvedViewScope(
            filter_active=True, allowed_note_ids=frozenset({ROOT_ID, LINKED_ID}),
            matched_note_ids=frozenset({ROOT_ID, LINKED_ID}), ordered_root_ids=(LINKED_ID, ROOT_ID), total_root_count=2,
        )

    monkeypatch.setattr(export_module, "resolve_view_scope_membership", resolve)
    html = build_notes_export_document(
        sort_mode="alphabetical", is_untagged_view=True, search="fruit", theme="light", token="token", root_note_id=None,
        purpose="download", title="", include_credentials=False,
    )
    assert calls == [("fruit", "alphabetical", True)]
    assert html.index("Apple") < html.index("Banana"), "the view's order"
    assert "excluded child" not in html



def _export(
    monkeypatch: pytest.MonkeyPatch, notes: dict, children_by_parent: dict, *, purpose: str, title: str,
    include_credentials: bool,
) -> str:
    store = _FakeNoteStore(notes=notes, children_by_parent=children_by_parent)
    monkeypatch.setattr(export_module, "note_store", store)
    monkeypatch.setattr(snapshot_module, "note_store", store)
    return build_notes_export_document(
        purpose=purpose, title=title, sort_mode="normal", is_untagged_view=False,
        search=None, theme="dark", token="token", root_note_id=None, include_credentials=include_credentials,
    )


def _tree() -> tuple[dict, dict]:
    notes = {
        ROOT_ID: _Note(ROOT_ID, None, None, LINKED_ID, True, "<div>Trip plan</div>", ""),
        CHILD_ID: _Note(CHILD_ID, ROOT_ID, None, None, False, "<div>Day one</div>", ""),
        LINKED_ID: _Note(LINKED_ID, None, ROOT_ID, None, False, "<div>Short</div>", ""),
    }
    return notes, {None: [ROOT_ID, LINKED_ID], ROOT_ID: [CHILD_ID]}


def test_a_download_has_arrows_where_metalist_does_and_starts_expanded(monkeypatch: pytest.MonkeyPatch) -> None:
    notes, children = _tree()
    notes[LINKED_ID] = _Note(LINKED_ID, None, ROOT_ID, None, False, "<div>First line</div><div>More text</div>", "")
    html = _export(monkeypatch, notes, children, purpose="download", title="", include_credentials=False)

    root = html[html.index(f'id="note-{ROOT_ID}"') - 40:html.index("Day one")]
    assert 'data-can-collapse="true"' in root and 'class="note-collapse-toggle"' in root, "a note with children"
    assert 'aria-expanded="true"' in root, "everything starts expanded, even a note collapsed in MetaList"
    assert 'class="note collapsed' not in html
    assert '<div class="note-content note-content-collapsed">' in html, "the first line is rendered ahead"
    linked = html[html.index(f'id="note-{LINKED_ID}"') - 40:]
    assert 'data-can-collapse="true"' in linked, "a note with more than one line"
    child = html[html.index(f'id="note-{CHILD_ID}"') - 40:html.index("Day one")]
    assert "note-collapse-toggle" not in child, "a short note without children has no arrow"
    assert "<script>" in html and ".note-collapse-toggle" in html[html.index("<script>"):]
    assert "@media print" in html


def test_a_print_has_no_arrows_or_script_and_carries_its_title(monkeypatch: pytest.MonkeyPatch) -> None:
    notes, children = _tree()
    html = _export(monkeypatch, notes, children, purpose="print", title="Kyoto <trip>", include_credentials=False)
    assert "note-collapse-toggle" not in html.split("<style>")[0] + html.split("</style>")[1]
    assert "note-content-collapsed\">" not in html and "<script>" not in html
    assert "<title>Kyoto &lt;trip&gt;</title>" in html
    assert '<h1 class="html-export-title">Kyoto &lt;trip&gt;</h1>' in html

    blank = _export(monkeypatch, notes, children, purpose="print", title="  ", include_credentials=False)
    assert "<title>MetaList</title>" in blank and "html-export-title\"" not in blank, "a blank title: no heading"
    download = _export(monkeypatch, notes, children, purpose="download", title="Kyoto <trip>", include_credentials=False)
    assert "<title>Kyoto &lt;trip&gt;</title>" in download, "a download carries its title too"
    assert download.index('<h1 class="html-export-title">Kyoto &lt;trip&gt;</h1>') < download.index('<main id="notes-container">'), (
        "above the notes, so collapsing them leaves it in place"
    )


def test_an_export_is_named_after_its_title() -> None:
    name = export_module.build_notes_export_filename
    assert name("Spring in Kyoto") == "Spring in Kyoto.html"
    assert name('Plans: 2026/27 "draft" <v2>?') == "Plans- 2026-27 -draft- -v2--.html", "what a file name cannot hold"
    assert name("  .hidden.  ") == "hidden.html"
    assert name("x" * 300) == "x" * 120 + ".html"
    assert name("   ").startswith("metalist-export-") and name("   ").endswith(".html"), "a blank title: the time"


def test_the_default_export_title(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        ROOT_ID: _Note(ROOT_ID, None, None, None, False, f"<div>![[{LINKED_ID}]]</div><div>Kyoto in April</div>", ""),
        LINKED_ID: _Note(LINKED_ID, None, None, None, False, "<div>secret value</div>", "@password"),
    }
    monkeypatch.setattr(export_module, "note_store", _FakeNoteStore(notes=notes, children_by_parent={}))
    title = export_module.default_export_title
    assert title(search=None, is_untagged_view=False, root_note_id=ROOT_ID) == "Kyoto in April", "embed-only lines skipped"
    assert title(search=None, is_untagged_view=False, root_note_id=LINKED_ID) == "MetaList", "never a password"
    assert title(search="travel japan", is_untagged_view=False, root_note_id=None) == "MetaList — travel japan"
    assert title(search="", is_untagged_view=False, root_note_id=None) == "MetaList"
    assert title(search="", is_untagged_view=True, root_note_id=None) == "MetaList — Untagged notes"
    assert title(search=f"id:{ROOT_ID} OR id:{LINKED_ID}", is_untagged_view=False, root_note_id=None) == "MetaList"


def _passwords_tree() -> tuple[dict, dict]:
    notes = {
        ROOT_ID: _Note(ROOT_ID, None, None, None, False, "<div>Accounts</div>", ""),
        CHILD_ID: _Note(CHILD_ID, ROOT_ID, None, None, False, "<div>sekret</div>", "@password"),
    }
    return notes, {None: [ROOT_ID], ROOT_ID: [CHILD_ID]}


@pytest.mark.parametrize("purpose", ["download", "print"])
def test_passwords_show_only_when_the_user_includes_them(monkeypatch: pytest.MonkeyPatch, purpose: str) -> None:
    notes, children = _passwords_tree()
    hidden = _export(monkeypatch, notes, children, purpose=purpose, title="", include_credentials=False)
    assert "sekret" not in hidden
    assert f'data-redacted="true" data-copy-value="{CREDENTIAL_MASK}">{CREDENTIAL_MASK}<' in hidden, "the same mask whatever the length"

    included = _export(monkeypatch, notes, children, purpose=purpose, title="", include_credentials=True)
    assert 'data-copy-value="sekret">sekret<' in included
    assert "data-redacted" not in included.split("</style>")[1].split("<script>")[0]
    rule = ".meta-credential-password .meta-credential-value:not([data-redacted]) { filter: none; }"
    assert rule in " ".join(included.split()), (
        "readable, not blurred: on paper or in a backup a blurred password is no use"
    )


def test_a_download_copies_like_metalist_and_a_print_has_no_script(monkeypatch: pytest.MonkeyPatch) -> None:
    notes, children = _passwords_tree()
    download = _export(monkeypatch, notes, children, purpose="download", title="", include_credentials=False)
    script = download[download.index("<script>"):]
    assert "closest('.meta-credential-value')" in script and "hasAttribute('data-redacted')" in script, (
        "a username or an included password copies; a hidden one does not"
    )
    assert "closest('.meta-copyable')" in script and "navigator.clipboard.writeText" in script
    assert "<script>" not in _export(monkeypatch, notes, children, purpose="print", title="", include_credentials=False)


def test_the_credential_counts_are_what_the_export_would_show(monkeypatch: pytest.MonkeyPatch) -> None:
    embedded_id = "44444444-4444-4444-4444-444444444444"
    embedded_child_id = "55555555-5555-5555-5555-555555555555"
    excluded_id = "66666666-6666-6666-6666-666666666666"
    other_id = "77777777-7777-7777-7777-777777777777"
    holder_id = "88888888-8888-8888-8888-888888888888"
    notes = {
        # A password child, a child that embeds a note whose child is a password
        # (a note that is only the reference), and a link to a password note (its
        # preview shows it, masked or not).
        ROOT_ID: _Note(ROOT_ID, None, None, other_id, False, f"<div>Accounts [[{LINKED_ID}]]</div>", "keep"),
        CHILD_ID: _Note(CHILD_ID, ROOT_ID, None, None, False, "<div>one</div>", "@password keep"),
        excluded_id: _Note(excluded_id, ROOT_ID, CHILD_ID, holder_id, False, "<div>gray bar</div>", "@password"),
        holder_id: _Note(holder_id, ROOT_ID, excluded_id, None, False, f"<div>![[{embedded_id}]]</div>", "keep"),
        embedded_id: _Note(embedded_id, other_id, None, None, False, "<div>Embedded</div>", ""),
        embedded_child_id: _Note(embedded_child_id, embedded_id, None, None, False, "<div>two</div>", "@password"),
        LINKED_ID: _Note(LINKED_ID, other_id, embedded_id, None, False, "<div>three</div>", "@password"),
        other_id: _Note(other_id, None, ROOT_ID, None, False, f"<div>[[{LINKED_ID}]]</div>", "keep"),
    }
    children = {
        None: [ROOT_ID, other_id], ROOT_ID: [CHILD_ID, excluded_id, holder_id],
        other_id: [embedded_id, LINKED_ID], embedded_id: [embedded_child_id],
    }
    monkeypatch.setattr(export_module, "note_store", _FakeNoteStore(notes=notes, children_by_parent=children))
    count = lambda **kwargs: export_module.exported_credential_counts(**kwargs).passwords  # noqa: E731

    assert count(search=None, sort_mode="normal", is_untagged_view=False, root_note_id=ROOT_ID) == 4
    assert count(search=None, sort_mode="normal", is_untagged_view=False, root_note_id=CHILD_ID) == 1
    assert count(search=None, sort_mode="normal", is_untagged_view=False, root_note_id=embedded_id) == 1

    # A view: notes its search leaves out (gray bars) are not exported, so not
    # counted; a password shown twice counts once.
    def resolve(*, search, sort_mode, is_untagged_view):
        allowed = frozenset({ROOT_ID, CHILD_ID, holder_id, other_id})
        return snapshot_module.ResolvedViewScope(
            filter_active=True, allowed_note_ids=allowed, matched_note_ids=allowed,
            ordered_root_ids=(ROOT_ID, other_id), total_root_count=2,
        )

    monkeypatch.setattr(export_module, "resolve_view_scope_membership", resolve)
    assert count(search="keep", sort_mode="normal", is_untagged_view=False, root_note_id=None) == 3

    notes[ROOT_ID] = _Note(ROOT_ID, None, None, other_id, False, "<div>Accounts</div>", "keep")
    notes[other_id] = _Note(other_id, None, ROOT_ID, None, False, "<div>Other</div>", "keep")
    notes[CHILD_ID] = _Note(CHILD_ID, ROOT_ID, None, None, False, "<div>one</div>", "keep")
    notes[holder_id] = _Note(holder_id, ROOT_ID, excluded_id, None, False, "<div>Holder</div>", "keep")
    assert count(search="keep", sort_mode="normal", is_untagged_view=False, root_note_id=None) == 0


def test_the_export_summary_route(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    monkeypatch.setattr(notes_route, "_require_bearer_token", lambda request: "token")
    monkeypatch.setattr(notes_route, "note_store", _FakePresenceStore({"note-123"}))
    monkeypatch.setattr(notes_route, "_resolve_tab_sort_mode", lambda tab_id: "alphabetical")
    monkeypatch.setattr(notes_route, "default_export_title", lambda **kwargs: calls.append(("title", kwargs)) or "Trip")
    monkeypatch.setattr(notes_route, "exported_credential_counts",
                        lambda **kwargs: calls.append(("count", kwargs)) or export_module.CredentialCounts(passwords=2, usernames=1))

    def summary(query: bytes) -> dict:
        return notes_route.export_summary(Request({
            "type": "http", "method": "GET", "path": "/api2/notes/export-summary", "headers": [], "query_string": query,
        }))

    assert summary(b"search_query=&tab_id=tab-1&is_untagged_view=false&note_id=note-123") == {"title": "Trip", "password_count": 2, "username_count": 1}
    assert calls == [
        ("count", {"search": None, "sort_mode": "alphabetical", "is_untagged_view": False, "root_note_id": "note-123"}),
        ("title", {"search": "", "is_untagged_view": False, "root_note_id": "note-123"}),
    ]
    with pytest.raises(notes_route.HTTPException) as missing_tab:
        summary(b"search_query=&is_untagged_view=false")
    assert missing_tab.value.status_code == 400


def test_a_title_the_first_note_already_says_is_not_repeated(monkeypatch: pytest.MonkeyPatch) -> None:
    notes, children = _tree()
    for purpose in ("download", "print"):
        same = _export(monkeypatch, notes, children, purpose=purpose, title="  trip   PLAN ", include_credentials=False)
        assert "html-export-title\">" not in same, "the first note's first line already heads the page"
        assert "<title>trip   PLAN</title>" in same, "it still names the tab and the file"
        other = _export(monkeypatch, notes, children, purpose=purpose, title="Spring", include_credentials=False)
        assert '<h1 class="html-export-title">Spring</h1>' in other


def test_on_paper_the_print_sets_its_margins_and_uses_the_full_width(monkeypatch: pytest.MonkeyPatch) -> None:
    notes, children = _tree()
    flat = " ".join(_export(monkeypatch, notes, children, purpose="print", title="", include_credentials=False).split())
    assert "@page { margin: 0; }" in flat, "no room for the browser's header and footer"
    assert ("body.html-export-body { max-width: none; margin: 0; padding: 15mm; "
            "-webkit-box-decoration-break: clone; box-decoration-break: clone; }") in flat, "its own margins on every page"
    assert ".html-export-body #notes-container { margin-left: 0; }" in flat, "no room kept for arrows"


def test_usernames_are_counted_and_hidden_like_passwords(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = {
        ROOT_ID: _Note(ROOT_ID, None, None, None, False, f"<div>Accounts [[{LINKED_ID}]]</div>", ""),
        CHILD_ID: _Note(CHILD_ID, ROOT_ID, None, None, False, "<div>evolvingstuff</div>", "@username"),
        LINKED_ID: _Note(LINKED_ID, None, None, None, False, "<div>linked-user</div>", "@username"),
    }
    children = {None: [ROOT_ID], ROOT_ID: [CHILD_ID]}
    monkeypatch.setattr(export_module, "note_store", _FakeNoteStore(notes=notes, children_by_parent=children))
    counts = export_module.exported_credential_counts(search=None, sort_mode="normal", is_untagged_view=False, root_note_id=ROOT_ID)
    assert counts == export_module.CredentialCounts(passwords=0, usernames=2), "the child, and the note a reference points to"

    hidden = _export(monkeypatch, notes, children, purpose="download", title="", include_credentials=False)
    assert "evolvingstuff" not in hidden and "linked-user" not in hidden
    assert f'data-redacted="true" data-copy-value="{CREDENTIAL_MASK}">{CREDENTIAL_MASK}<' in hidden
    assert ('<span class="note-reference-link note-reference-link-static meta-credential-username">'
            f'<span class="meta-credential-value" data-redacted="true">{CREDENTIAL_MASK}</span>') in hidden, (
        "a reference's preview hides it with the same mask, and copies nothing"
    )
    shown = _export(monkeypatch, notes, children, purpose="download", title="", include_credentials=True)
    assert 'data-copy-value="evolvingstuff">evolvingstuff<' in shown
