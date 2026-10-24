"""A file referenced in a note ([[id]], ![[id]]) shows by its name, so search, find and
the AI read that name too (docs/ui/search-semantics.md)."""

from __future__ import annotations

import json

import pytest

import app.services.content_formatting as content_formatting
import app.services.search_text as search_text
from app.services.file_registry import FileDetails, FileRegistry

PDF_ID = "9a7ddc26-a797-4af7-a8ab-f4ac3ca43357"
IMAGE_ID = "1c9e7b52-3f4a-4d8e-a6b0-7e2f9d1c5a38"
NOTE_ID = "5b0c1e7f-2d3a-4b5c-8d9e-0f1a2b3c4d5e"
PDF_NAME = "0025018697_FilingCorrespondence_CongratulationLetter.pdf"
IMAGE_NAME = "Kyoto temple.png"


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> tuple[FileRegistry, list[int]]:
    """Two files; the loader counts how often the names are read."""
    loads: list[int] = []
    registry = FileRegistry()
    registry.replace_all_with_thumbnail_kinds({PDF_ID: "pdf", IMAGE_ID: "image"})

    def load() -> dict[str, FileDetails]:
        loads.append(1)
        return {
            PDF_ID: FileDetails(title=PDF_NAME, thumbnail_kind="pdf"),
            IMAGE_ID: FileDetails(title=IMAGE_NAME, thumbnail_kind="image"),
        }

    registry.install_details_loader(load)
    monkeypatch.setattr(search_text, "file_registry", registry)
    monkeypatch.setattr(content_formatting, "file_registry", registry)
    return registry, loads


def test_file_names_are_read_once_and_a_notes_id_has_none(registry) -> None:
    files, loads = registry
    assert files.title_of(PDF_ID) == PDF_NAME
    assert files.title_of(IMAGE_ID) == IMAGE_NAME
    assert files.title_of(NOTE_ID) is None
    assert loads == [1]
    # A file added later is known by name without reading them all again.
    added_id = "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"
    files.add_with_thumbnail_kind(added_id, thumbnail_kind="pdf", title="later.pdf")
    assert files.title_of(added_id) == "later.pdf"
    assert loads == [1]
    files.remove_many({added_id})
    assert files.title_of(added_id) is None


def test_referenced_file_names_lists_each_file_once_in_order(registry) -> None:
    files, _loads = registry
    text = f"see ![[{IMAGE_ID}]] and [[{NOTE_ID}]], then [[{PDF_ID}]] and again ![[{IMAGE_ID}]]"
    assert files.referenced_file_names(text) == [(IMAGE_ID, IMAGE_NAME), (PDF_ID, PDF_NAME)]
    assert files.referenced_file_names("no references here") == []


def test_search_text_holds_the_names_of_the_files_a_note_references(registry) -> None:
    text = search_text.build_searchable_text_casefold(f"<div>no tags here</div><div>![[{PDF_ID}]]</div>", "")
    assert search_text.text_term_matches("congratulation", text)
    assert search_text.text_term_matches("_onlinereport", text) is False
    # A note's own reference ([[id]] of a note) adds nothing.
    assert search_text.build_searchable_text_casefold(f"<div>[[{NOTE_ID}]]</div>", "") == f"[[{NOTE_ID}]]".casefold()


def test_the_ai_reads_the_names_of_the_files_a_note_references(registry) -> None:
    text, redacted = content_formatting.extract_agent_note_text(
        content_html=f"<div>Formation papers ![[{PDF_ID}]] [[{NOTE_ID}]]</div>", tags="",
        title_lookup=lambda url: None,
    )
    assert redacted is False
    body, files_line = text.split("\n")
    assert body == f"Formation papers ![[{PDF_ID}]] [[{NOTE_ID}]]"
    label = "Referenced files (names only, not file contents): "
    assert files_line.startswith(label)
    assert json.loads(files_line.removeprefix(label)) == [{"id": PDF_ID, "name": PDF_NAME}]


def test_a_credential_note_shows_the_ai_no_file_names(registry) -> None:
    text, redacted = content_formatting.extract_agent_note_text(
        content_html=f"<div>![[{PDF_ID}]]</div>", tags="@password", title_lookup=lambda url: None,
    )
    assert (text, redacted) == ("[REDACTED: @password]", True)
