"""Unlocking cleans the stored notes once per cleaning, not every time.

Every save cleans a note before storing it. A note stored some other way (before
cleaning existed, a restore, an import, convert-from-legacy.py) is in a database
without the record for the current cleaning: the first unlock cleans every note,
stores the ones it changed and records it. Later unlocks trust what is stored, until
the cleaning changes. Cleaning every note was a quarter of unlocking (2026-10-19)."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import pytest

import app.services.content_cache as content_cache
from app.db.notes_sql import insert_note
from app.db.schema import NAMESPACE_CONTENT_MIGRATIONS_TABLE
from app.db.session import begin_writer
from app.models.database import SafeSession
from app.security.encryption import clear_encryption_key, set_encryption_required, set_session_dek
from app.security.note_html import sanitize_note_html
from app.services.content_cache import clear_cache, populate_cache_from_db, stored_html_cleaned_migration_id
from app.utils.encryption import encrypt, get_encryption_service

_UNSAFE = '<div onclick="steal()">kept <b>bold</b></div><script>steal()</script>'
_CLEANED = sanitize_note_html(_UNSAFE)
_SAFE = "<div>already <i>clean</i></div>"
_UPDATED_AT = datetime(2026, 3, 4, 5, 6, 7, tzinfo=timezone.utc)
_DEK_BYTES = 32


@pytest.fixture
def namespace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    set_encryption_required(False)
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    clear_cache()
    try:
        yield
    finally:
        clear_cache()
        clear_encryption_key()
        set_encryption_required(False)
        SafeSession.use_file_db()


def _store_raw(note_id: str, html: str, *, prev_id: str | None, next_id: str | None) -> None:
    """Stores html as it is, the way a restore or convert-from-legacy.py brings notes."""
    content, nonce, tag = encrypt(html, "")
    with begin_writer() as connection:
        insert_note(
            connection, note_id=note_id, content=content, encryption_nonce=nonce, encryption_tag=tag,
            tags="", tags_encryption_nonce=None, tags_encryption_tag=None,
            proposed_tags="", proposed_tags_encryption_nonce=None, proposed_tags_encryption_tag=None,
            parent_id=None, prev_id=prev_id, next_id=next_id, is_collapsed=False,
            created_at=_UPDATED_AT, updated_at=_UPDATED_AT,
        )


def _unlock() -> None:
    clear_cache()
    session = SafeSession()
    try:
        populate_cache_from_db(session)
        session.commit()
    finally:
        session.close()


def _stored(note_id: str) -> tuple[str, str]:
    with begin_writer() as connection:
        row = connection.execute(
            "SELECT content, encryption_nonce, encryption_tag, updated_at FROM notes WHERE id = ?", (note_id,),
        ).fetchone()
    content, nonce, tag, updated_at = row
    if nonce is not None:
        content = get_encryption_service().decrypt_from_storage(content, nonce, tag)
    return content, updated_at


def _records() -> list[tuple[str, str, int]]:
    with begin_writer() as connection:
        return [tuple(row) for row in connection.execute(
            f"SELECT migration_id, status, converted_count FROM {NAMESPACE_CONTENT_MIGRATIONS_TABLE}",
        ).fetchall()]


def _old_notes() -> None:
    _store_raw("unsafe", _UNSAFE, prev_id=None, next_id="safe")
    _store_raw("safe", _SAFE, prev_id="unsafe", next_id=None)


def test_the_first_unlock_stores_cleaned_notes_and_records_it(namespace) -> None:
    _old_notes()
    _unlock()
    assert content_cache.get_cached_content("unsafe") == _CLEANED
    assert content_cache.get_cached_text("unsafe") == "kept bold"
    # Stored cleaned, its updated time kept: the note reads as it always has.
    assert _stored("unsafe") == (_CLEANED, _UPDATED_AT.isoformat())
    assert _stored("safe") == (_SAFE, _UPDATED_AT.isoformat())
    assert _records() == [(stored_html_cleaned_migration_id(), "complete", 1)]


def test_later_unlocks_do_not_clean_again(namespace, monkeypatch: pytest.MonkeyPatch) -> None:
    _old_notes()
    _unlock()
    monkeypatch.setattr(content_cache, "sanitize_note_html", lambda _html: pytest.fail("cleaned again"))
    _unlock()
    assert content_cache.get_cached_content("unsafe") == _CLEANED
    assert content_cache.get_cached_content("safe") == _SAFE


def test_a_changed_cleaning_cleans_once_more_and_replaces_the_record(namespace, monkeypatch) -> None:
    _old_notes()
    _unlock()
    first_record = stored_html_cleaned_migration_id()
    monkeypatch.setattr(content_cache, "sanitizer_fingerprint", lambda: "a-new-cleaning")
    cleaned: list[str] = []

    def record_cleaning(html: str) -> str:
        cleaned.append(html)
        return html

    monkeypatch.setattr(content_cache, "sanitize_note_html", record_cleaning)
    _unlock()
    assert sorted(cleaned) == sorted([_CLEANED, _SAFE])
    assert _records() == [(content_cache.STORED_HTML_CLEANED_PREFIX + "a-new-cleaning", "complete", 0)]
    assert first_record != _records()[0][0]


def test_an_encrypted_namespace_stores_the_cleaned_note_encrypted(namespace) -> None:
    set_session_dek(os.urandom(_DEK_BYTES))
    set_encryption_required(True)
    _old_notes()
    _unlock()
    with begin_writer() as connection:
        content, nonce, tag = connection.execute(
            "SELECT content, encryption_nonce, encryption_tag FROM notes WHERE id = 'unsafe'",
        ).fetchone()
    assert isinstance(nonce, bytes) and isinstance(tag, bytes)
    assert "kept" not in content
    assert get_encryption_service().decrypt_from_storage(content, nonce, tag) == _CLEANED


def test_a_database_without_the_record_is_cleaned_even_after_an_earlier_one(namespace) -> None:
    # A restore installs a whole database: one from before cleaning has no record.
    _old_notes()
    _unlock()
    with begin_writer() as connection:
        connection.execute(f"DELETE FROM {NAMESPACE_CONTENT_MIGRATIONS_TABLE}")
        connection.execute("DELETE FROM notes")
    _old_notes()
    _unlock()
    assert content_cache.get_cached_content("unsafe") == _CLEANED
    assert _stored("unsafe")[0] == _CLEANED


def test_markup_the_cleaning_never_writes_stops_unlocking(namespace) -> None:
    # With the record, a stored note is trusted; text extraction still refuses what
    # cleaning removes, so a note stored around the cleaning fails loudly.
    _unlock()
    _store_raw("smuggled", "<div>a<!-- hidden --></div>", prev_id=None, next_id=None)
    with pytest.raises(ValueError):
        _unlock()
