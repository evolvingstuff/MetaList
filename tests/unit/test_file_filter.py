"""Files filter (app/services/file_kinds.py): which kind each file is, which notes a
tab shows with the filter, alone and with a search, and how a tab keeps it."""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Set

import pytest

import app.services.snapshot as snapshot
from app.models.database import SafeSession
from app.security.encryption import set_encryption_required
from app.services.file_kinds import FILE_KIND_MARKDOWN, FILE_KIND_OTHER, FILE_KIND_PDF, FILE_KIND_IMAGE, file_kind_of
from app.services.file_registry import FileDetails, FileRegistry
from app.services.input_errors import InputRejected
from app.services.snapshot import SearchScope
from app.services.tab_state import TabStateStore
from tests.unit.snapshot_note_fixture import SnapshotTestNote as _Note

IMAGE_ID = "11111111-aaaa-4aaa-8aaa-111111111111"
PDF_ID = "22222222-aaaa-4aaa-8aaa-222222222222"
MARKDOWN_ID = "33333333-aaaa-4aaa-8aaa-333333333333"
ZIP_ID = "44444444-aaaa-4aaa-8aaa-444444444444"


@pytest.mark.parametrize(("thumbnail_kind", "file_name", "kind"), [
    ("image", "photo.heic", FILE_KIND_IMAGE),
    ("pdf", "report.pdf", FILE_KIND_PDF),
    ("text", "README.MD", FILE_KIND_MARKDOWN),
    ("other", "notes.markdown", FILE_KIND_MARKDOWN),
    ("text", "notes.txt", FILE_KIND_OTHER),
    ("excalidraw", "plan.excalidraw", FILE_KIND_OTHER),
])
def test_a_file_kind_comes_from_its_thumbnail_kind_or_its_name(thumbnail_kind: str, file_name: str, kind: str) -> None:
    assert file_kind_of(thumbnail_kind=thumbnail_kind, file_name=file_name) == kind


def _registry() -> FileRegistry:
    registry = FileRegistry()
    registry.replace_all_with_thumbnail_kinds({IMAGE_ID: "image", PDF_ID: "pdf", MARKDOWN_ID: "text", ZIP_ID: "archive"})
    details = {
        IMAGE_ID: FileDetails(title="photo.png", thumbnail_kind="image"),
        PDF_ID: FileDetails(title="report.pdf", thumbnail_kind="pdf"),
        MARKDOWN_ID: FileDetails(title="plan.md", thumbnail_kind="text"),
        ZIP_ID: FileDetails(title="backup.zip", thumbnail_kind="archive"),
    }
    registry.install_details_loader(lambda: details)
    return registry


@pytest.mark.parametrize(("kind", "file_ids"), [
    ("any", {IMAGE_ID, PDF_ID, MARKDOWN_ID, ZIP_ID}),
    ("image", {IMAGE_ID}),
    ("pdf", {PDF_ID}),
    ("markdown", {MARKDOWN_ID}),
])
def test_the_registry_lists_the_files_of_a_kind(kind: str, file_ids: Set[str]) -> None:
    assert _registry().file_ids_of_kind(kind) == file_ids


def test_a_vault_read_while_locked_learns_its_files_kinds_once_unlocked() -> None:
    # An encrypted vault registers its files at startup and at lock time, before
    # their details can be decrypted: only their ids are known then.
    registry = FileRegistry()
    registry.replace_all({IMAGE_ID, PDF_ID, MARKDOWN_ID, ZIP_ID})
    details = {
        IMAGE_ID: FileDetails(title="photo.png", thumbnail_kind="image"),
        PDF_ID: FileDetails(title="report.pdf", thumbnail_kind="pdf"),
        MARKDOWN_ID: FileDetails(title="plan.md", thumbnail_kind="text"),
        ZIP_ID: FileDetails(title="backup.zip", thumbnail_kind="archive"),
    }
    registry.install_details_loader(lambda: details)
    assert registry.file_ids_of_kind("pdf") == {PDF_ID}
    assert registry.file_ids_of_kind("image") == {IMAGE_ID}
    assert registry.has_image_file(IMAGE_ID) is True
    assert registry.has_resizable_file(PDF_ID) is False


class _FakeNoteStore:
    """Notes and the files each one's own text references (as the backlink index keeps them)."""

    def __init__(self, *, notes: Dict[str, _Note], children_by_parent: Dict[Optional[str], List[str]],
                 references: Dict[str, Set[str]], inline_image_note_ids: Set[str]):
        self._notes = notes
        self._children_by_parent = children_by_parent
        self._references = references
        self._inline_image_note_ids = inline_image_note_ids

    def note_ids_referencing(self, target_ids: Set[str]) -> Set[str]:
        return {note_id for note_id, file_ids in self._references.items() if file_ids & target_ids}

    def note_ids_with_inline_images(self) -> Set[str]:
        return set(self._inline_image_note_ids)

    def has_backlinks(self, note_id: str) -> bool:
        return False

    def has_note(self, note_id: str) -> bool:
        return note_id in self._notes

    def get_note(self, note_id: str) -> _Note:
        return self._notes[note_id]

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        if parent_id in self._children_by_parent:
            return list(self._children_by_parent[parent_id])
        return []

    def list_note_ids(self) -> List[str]:
        return list(self._notes)

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> frozenset[str]:
        return frozenset()


def _note(note_id: str, parent_id: Optional[str]) -> _Note:
    return _Note(note_id, parent_id, None, None, False, f"<div>{note_id}</div>", "")


@pytest.fixture
def notes_with_files(monkeypatch: pytest.MonkeyPatch) -> None:
    """A trip whose child holds a photo, a report with a PDF, a readme with a Markdown
    file, a backup with a zip, a sketch with a picture pasted inline, and a plain note."""
    roots = ["trip", "report", "readme", "backup", "sketch", "plain"]
    notes = {note_id: _note(note_id, None) for note_id in roots}
    notes["photo-note"] = _note("photo-note", "trip")
    store = _FakeNoteStore(
        notes=notes,
        children_by_parent={None: roots, "trip": ["photo-note"]},
        references={"photo-note": {IMAGE_ID}, "report": {PDF_ID}, "readme": {MARKDOWN_ID}, "backup": {ZIP_ID}},
        inline_image_note_ids={"sketch"},
    )
    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "file_registry", _registry())
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})


def _shown(file_filter: Optional[str], *, editing_note_id: Optional[str]) -> Dict[Optional[str], List[str]]:
    state = snapshot.build_view_state(
        editing_note_id=editing_note_id, find_reveal_note_id=None, search=None, sort_mode="normal",
        date_filter=None, file_filter=file_filter, client_known_note_ids=set(), previous_root_ids=[],
        visible_top_root_id=None, visible_bottom_root_id=None, is_untagged_view=False, start_at_list_end=False,
    )
    # Without a search the browser pages through rootCountTotal roots: the ones shown.
    assert state.metadata["rootCountTotal"] == len(state.children_by_parent[None])
    return state.children_by_parent


@pytest.mark.parametrize(("file_filter", "shown"), [
    (None, {None: ["trip", "report", "readme", "backup", "sketch", "plain"], "trip": ["photo-note"]}),
    # A picture pasted inline is not an attached file.
    ("any", {None: ["trip", "report", "readme", "backup"], "trip": ["photo-note"]}),
    # A note deep in the tree shows with the notes above it; an inline picture is an image.
    ("image", {None: ["trip", "sketch"], "trip": ["photo-note"]}),
    ("pdf", {None: ["report"]}),
    ("markdown", {None: ["readme"]}),
])
def test_the_view_shows_the_notes_with_a_file_of_the_kind(
    notes_with_files, file_filter: Optional[str], shown: Dict[Optional[str], List[str]],
) -> None:
    assert _shown(file_filter, editing_note_id=None) == shown


def test_the_note_being_edited_stays_while_it_has_no_file_of_the_kind(notes_with_files) -> None:
    assert _shown("pdf", editing_note_id="plain") == {None: ["report", "plain"]}
    assert _shown("pdf", editing_note_id=None) == {None: ["report"]}


def test_with_a_search_the_view_shows_the_matches_with_a_file_of_the_kind(
    notes_with_files, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def search_matching_photo_and_plain(**kwargs: object) -> SearchScope:
        return SearchScope(
            search_active=True, allowed_note_ids={"trip", "photo-note", "plain"},
            search_root_ids_ordered=["trip", "plain"], search_root_count_total=2,
            matched_note_ids={"photo-note", "plain"},
        )

    monkeypatch.setattr(snapshot, "resolve_search_scope", search_matching_photo_and_plain)
    scope = snapshot.resolve_view_scope_membership(
        search="holiday", sort_mode="normal", date_filter=None, file_filter="image", is_untagged_view=False,
    )
    assert scope.matched_note_ids == frozenset({"photo-note"})
    assert scope.allowed_note_ids == frozenset({"trip", "photo-note"})
    assert scope.ordered_root_ids == ("trip",)
    with_pdf = snapshot.resolve_view_scope_membership(
        search="holiday", sort_mode="normal", date_filter=None, file_filter="pdf", is_untagged_view=False,
    )
    assert with_pdf.ordered_root_ids == ()


@pytest.fixture
def memory_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    set_encryption_required(False)
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    try:
        yield
    finally:
        set_encryption_required(False)
        SafeSession.use_file_db()


def test_a_tab_keeps_its_files_filter_across_a_reload_and_a_closed_tab_drops_it(memory_db) -> None:
    store = TabStateStore()
    tab_id = store.snapshot()["activeTabId"]
    result = store.set_file_filter(tab_id=tab_id, file_filter="pdf")
    assert result["changed"] is True
    assert result["fileFilters"] == {tab_id: "pdf"}
    assert store.set_file_filter(tab_id=tab_id, file_filter="pdf")["changed"] is False

    reloaded = TabStateStore()
    session = SafeSession()
    try:
        with SafeSession.allow_reads("tests:file_filter:bootstrap"):
            reloaded.bootstrap(connection=session.connection())
    finally:
        session.close()
    assert reloaded.get_file_filter(tab_id=tab_id) == "pdf"

    new_tab_id = store.create_tab(copy_from_tab_id=tab_id)["newTabId"]
    assert store.get_file_filter(tab_id=new_tab_id) is None
    store.set_file_filter(tab_id=new_tab_id, file_filter="image")
    assert list(store.delete_tab(tab_id=new_tab_id)["fileFilters"]) == [tab_id]

    cleared = store.set_file_filter(tab_id=tab_id, file_filter=None)
    assert cleared["changed"] is True
    assert cleared["fileFilters"] == {}


def test_an_unknown_file_kind_is_rejected(memory_db) -> None:
    store = TabStateStore()
    with pytest.raises(InputRejected):
        store.set_file_filter(tab_id=store.snapshot()["activeTabId"], file_filter="video")

