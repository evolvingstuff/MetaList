"""Migration 9→10: let MetaList edit some attachments in place (Excalidraw diagrams).

The sibling files database gains `files.content_revision` and the encrypted `file_previews`
table. Opening a files database also adds them (see `initialize_file_schema`), so this step is
idempotent; it exists so the upgrade is recorded in the namespace version like every other
schema change, and so the encryption audit can require the new schema from version 10 on.
"""

from contextlib import closing
from pathlib import Path
import sqlite3

from app.db.file_schema import FILE_PREVIEWS_TABLE, FILES_TABLE, initialize_file_schema

# Same shared in-memory database FileSession uses when the notes database is in memory.
_FILE_MEMORY_URI = "file:metalist_files_memory?mode=memory&cache=shared"
# PRAGMA database_list rows are (seq, name, file).
_DATABASE_LIST_FILE_COLUMN = 2


def _upgrade(files: sqlite3.Connection) -> None:
    initialize_file_schema(files)
    files.commit()
    columns = {row[1] for row in files.execute(f"PRAGMA table_info({FILES_TABLE})").fetchall()}
    if "content_revision" not in columns:
        raise RuntimeError("Database migration 9→10 did not add files.content_revision")
    preview_table = files.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (FILE_PREVIEWS_TABLE,)
    ).fetchone()
    if preview_table is None:
        raise RuntimeError(f"Database migration 9→10 did not create {FILE_PREVIEWS_TABLE}")


def add_editable_file_schema(
    *,
    connection: sqlite3.Connection,
    encryption_enabled: bool,  # noqa: ARG001
    encryption_service: object,  # noqa: ARG001
) -> int:
    database = connection.execute("PRAGMA database_list").fetchone()[_DATABASE_LIST_FILE_COLUMN]
    if not database:
        with closing(sqlite3.connect(_FILE_MEMORY_URI, uri=True)) as files:
            _upgrade(files)
        return 0
    notes = Path(database)
    target = notes.with_name(f"{notes.stem}.files{notes.suffix}")
    # A namespace without attachments gets the current schema when its files database is created.
    if not target.exists():
        return 0
    with closing(sqlite3.connect(target)) as files:
        _upgrade(files)
    return 0
