"""Every place that writes a note's content, and why what it writes is cleaned.

Unlocking trusts stored notes once the database records that they are cleaned
(content_cache.populate_cache_from_db). That holds only while every write cleans first
or happens in a database without the record. A new writer fails this test until it is
added here with the reason its content is cleaned."""

from __future__ import annotations

import ast
from pathlib import Path

_REPOSITORY = Path(__file__).resolve().parents[2]
_WRITERS = {
    "insert_note", "update_note_fields", "update_note_fields_preserving_updated_at",
    "db_insert_note", "db_update_note_fields", "db_update_note_fields_preserving_updated_at",
}
_CONTENT_SQL = ("SET content", "INSERT INTO notes")

_KNOWN_WRITERS = {
    ("app/usecases/create_note.py", "apply_insert_note"): "cleans the content first",
    ("app/usecases/update_content.py", "apply_update_note_sources"): "cleans the content first",
    ("app/usecases/delete_subtree.py", "apply_restore_records"): "cleans each restored note first",
    ("app/services/auth_service.py", "_persist_note_rewrites"):
        "password_note_fields.prepare_note_rewrite cleans each note it re-encrypts",
    ("app/services/content_cache.py", "_store_cleaned_notes"): "stores the cleaning's output",
    ("app/usecases/bulk_tag_proposals.py", "apply_bulk_proposals"): "writes proposed tags only",
    # The two below store uncleaned content, into databases without the record (a
    # version below 8; a newly converted one), so their first unlock cleans them.
    ("app/db/migrations.py", "_remove_retired_document_references"): "runs on databases below version 8",
    ("convert-from-legacy.py", "_import_item"): "fills a new database",
}


def _python_files() -> list[Path]:
    return sorted([*(_REPOSITORY / "app").rglob("*.py"), *_REPOSITORY.glob("*.py")])


def _called_name(called: ast.expr) -> str:
    if isinstance(called, ast.Attribute):
        return called.attr
    if isinstance(called, ast.Name):
        return called.id
    return ""


def _content_writers(path: Path) -> set[tuple[str, str]]:
    relative = path.relative_to(_REPOSITORY).as_posix()
    found = set()
    for function in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for node in ast.walk(function):
            if isinstance(node, ast.Call):
                name = _called_name(node.func)
                keywords = {keyword.arg for keyword in node.keywords}
                # A **mapping may hold content: it counts until listed with its reason.
                if name in _WRITERS and ("content" in keywords or None in keywords):
                    found.add((relative, function.name))
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if any(fragment in node.value for fragment in _CONTENT_SQL):
                    found.add((relative, function.name))
    return found


def test_every_note_content_writer_is_known_to_write_cleaned_html() -> None:
    found = set().union(*(_content_writers(path) for path in _python_files()))
    assert found == set(_KNOWN_WRITERS)
