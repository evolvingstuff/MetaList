"""In-memory content cache for encrypted notes.

Provides fast search access to decrypted note content while maintaining
encrypted-at-rest storage. Cache is populated on startup and maintained
manually by the sqlite helper layer and service hooks.
"""

import logging
import time
from typing import Dict, Iterator, Mapping, Sequence

from app.db.content_migrations_sql import is_content_migration_complete
from app.db.content_migrations_sql import record_content_migration_complete
from app.db.notes_sql import count_notes, iter_all_for_cache
from app.db.notes_sql import update_note_fields_preserving_updated_at
from app.db.raw_connection import raw_sqlite_connection
from app.db.session import begin_writer

from ..models.database import SafeSession
from ..utils.encryption import encrypt, get_encryption_service
from app.services.hydration_state import hydration_state
from app.utils.text_utils import strip_sanitized_html
from app.security.note_html import sanitize_note_html, sanitizer_fingerprint

logger = logging.getLogger(__name__)

# Global in-memory caches: {note_id: decrypted_string}
_search_cache: Dict[str, str] = {}  # shockharness: ignore[STATE001] reason="touched only by write requests, which run one at a time, and by the bulk apply, which holds bulk_operation_guard.lock like the requests let through beside it; filled at startup before serving and by the hydration worker under bulk_operation_guard.lock"
_tag_cache: Dict[str, str] = {}  # shockharness: ignore[STATE001] reason="touched only by write requests, which run one at a time, and by the bulk apply, which holds bulk_operation_guard.lock like the requests let through beside it; filled at startup before serving and by the hydration worker under bulk_operation_guard.lock"
_proposed_tag_cache: Dict[str, str] = {}  # shockharness: ignore[STATE001] reason="touched only by write requests, which run one at a time, and by the bulk apply, which holds bulk_operation_guard.lock like the requests let through beside it; filled at startup before serving and by the hydration worker under bulk_operation_guard.lock"
_text_cache: Dict[str, str] = {}  # shockharness: ignore[STATE001] reason="touched only by write requests, which run one at a time, and by the bulk apply, which holds bulk_operation_guard.lock like the requests let through beside it; filled at startup before serving and by the hydration worker under bulk_operation_guard.lock"

_CACHE_TIMING_ENABLED = True
# Startup timing is reported once per this many decrypted notes.
_CACHE_TIMING_BATCH_NOTES = 1000
# Debug logs show only the start of a note id.
_LOGGED_NOTE_ID_PREFIX_LENGTH = 8


def get_cached_content(note_id: str) -> str:
    if note_id not in _search_cache:
        raise RuntimeError(f"Cache missing plaintext for note {note_id}")
    return _search_cache[note_id]


def get_cached_tags(note_id: str) -> str:
    if note_id not in _tag_cache:
        raise RuntimeError(f"Cache missing tags for note {note_id}")
    return _tag_cache[note_id]


def get_cached_proposed_tags(note_id: str) -> str:
    if note_id not in _proposed_tag_cache:
        raise RuntimeError(f"Cache missing proposed tags for note {note_id}")
    return _proposed_tag_cache[note_id]


def get_cached_text(note_id: str) -> str:
    if note_id not in _text_cache:
        raise RuntimeError(f"Cache missing raw text for note {note_id}")
    return _text_cache[note_id]


def cache_note(note_id: str, decrypted_content: str) -> None:
    """Add or update note content in cache.
    
    Args:
        note_id: ID of note to cache
        decrypted_content: Plain text content to store in cache
    """
    _search_cache[note_id] = sanitize_note_html(decrypted_content)
    logger.debug(f"Cached content for note {note_id[:_LOGGED_NOTE_ID_PREFIX_LENGTH]}...")


def cache_note_tags(note_id: str, tags: str) -> None:
    _tag_cache[note_id] = tags
    logger.debug(f"Cached tags for note {note_id[:_LOGGED_NOTE_ID_PREFIX_LENGTH]}...")


def cache_note_proposed_tags(note_id: str, proposed_tags: str) -> None:
    if not isinstance(proposed_tags, str):
        raise TypeError("proposed_tags must be a string")
    _proposed_tag_cache[note_id] = proposed_tags
    logger.debug(f"Cached proposed tags for note {note_id[:_LOGGED_NOTE_ID_PREFIX_LENGTH]}...")


def cache_note_text(note_id: str, raw_text: str) -> None:
    _text_cache[note_id] = raw_text
    logger.debug(f"Cached raw text for note {note_id[:_LOGGED_NOTE_ID_PREFIX_LENGTH]}...")


def clear_cache() -> None:
    """Clear all cached content."""
    global _search_cache, _tag_cache, _proposed_tag_cache, _text_cache
    _search_cache = {}
    _tag_cache = {}
    _proposed_tag_cache = {}
    _text_cache = {}
    logger.info("Cache cleared")


# What the note store reads from a row once the cache holds its decrypted text and tags.
_NOTE_STRUCTURE_FIELDS = ("id", "parent_id", "prev_id", "next_id", "is_collapsed", "created_at", "updated_at")

# The namespace_content_migrations record that every note in the database is stored as
# the current cleaning (sanitize_note_html) writes it; it ends in that cleaning's
# fingerprint, so a changed cleaning has no record yet.
STORED_HTML_CLEANED_PREFIX = "stored-note-html-cleaned:"


def stored_html_cleaned_migration_id() -> str:
    return STORED_HTML_CLEANED_PREFIX + sanitizer_fingerprint()


def populate_cache_from_db(db: SafeSession) -> Sequence[Mapping[str, object]]:
    """Fill the cache with every note, decrypted, and return each note's structure
    fields (_NOTE_STRUCTURE_FIELDS) for the note store.

    Every save cleans a note before storing it, so stored notes are cleaned already.
    Notes stored some other way (before cleaning existed, under an earlier cleaning, by
    a restore, an import or convert-from-legacy.py) are in a database without the
    record for the current cleaning: then every note is cleaned here once, and a note
    the cleaning changes is stored cleaned in the same write that adds the record.
    Cleaning every note took a quarter of unlocking (2026-10-19).

    Rows stream from the database one at a time and only their structure fields are
    kept, so no more than one row's ciphertext is ever held: holding them all until the
    note store had loaded made unlocking peak hundreds of MB above what it keeps.
    """
    logger.info("Populating content cache from database...")
    with SafeSession.allow_reads("cache:populate"):
        raw = raw_sqlite_connection(db.connection())
        migration_id = stored_html_cleaned_migration_id()
        clean_stored_html = not is_content_migration_complete(raw, migration_id)
        structures, cleaned_notes = _populate_from_rows(
            count_notes(raw), iter_all_for_cache(raw), clean_stored_html=clean_stored_html,
        )
    if clean_stored_html:
        _store_cleaned_notes(cleaned_notes, migration_id=migration_id)
    return structures


def _store_cleaned_notes(cleaned_notes: Mapping[str, str], *, migration_id: str) -> None:
    """Stores each note as cleaned, encrypted as a save would, keeping its updated time
    (the note reads as it always has: the cache has always held it cleaned), and records
    that the database is cleaned, all in one write."""
    with begin_writer() as writer:
        connection = raw_sqlite_connection(writer)
        for note_id, cleaned_content in cleaned_notes.items():
            content, nonce, tag = encrypt(cleaned_content, "")
            update_note_fields_preserving_updated_at(
                connection, note_id, content=content, encryption_nonce=nonce, encryption_tag=tag,
            )
        record_content_migration_complete(
            connection, migration_id=migration_id, converted_count=len(cleaned_notes),
            superseded_prefix=STORED_HTML_CLEANED_PREFIX,
        )
    logger.info("Cleaned stored note HTML once: %d notes changed", len(cleaned_notes))


def _populate_from_rows(
    note_count: int, notes: Iterator[dict], *, clean_stored_html: bool,
) -> tuple[Sequence[Mapping[str, object]], Mapping[str, str]]:
    """The structure rows, and when clean_stored_html, each note the cleaning changed
    with its cleaned content."""
    global _search_cache, _tag_cache, _proposed_tag_cache, _text_cache

    if _CACHE_TIMING_ENABLED:
        print(f"[startup] cache populating {note_count} notes")
        logger.info("[startup] cache populating %d notes", note_count)

    clear_cache()
    structures: list[Mapping[str, object]] = []

    hydrated_content: Dict[str, str] = {}
    hydrated_tags: Dict[str, str] = {}
    hydrated_proposed_tags: Dict[str, str] = {}
    hydrated_text: Dict[str, str] = {}

    if hydration_state.is_running():
        hydration_state.set_phase(
            phase="decrypt",
            message="Decrypting notes into memory",
            total=note_count,
        )

    encryption_service = get_encryption_service()

    loop_started = time.perf_counter()
    # Where unlocking spends its time, for the Memory Usage dialog's Last unlock.
    decrypt_seconds = 0.0
    sanitize_seconds = 0.0
    text_seconds = 0.0
    cleaned_notes: Dict[str, str] = {}
    processed = 0
    last_checkpoint = loop_started
    for note in notes:
        note_id = note["id"]
        content = note["content"]
        nonce = note["encryption_nonce"]
        tag = note["encryption_tag"]

        tags = note["tags"]
        tags_nonce = note["tags_encryption_nonce"]
        tags_tag = note["tags_encryption_tag"]
        proposed_tags = note["proposed_tags"]
        proposed_tags_nonce = note["proposed_tags_encryption_nonce"]
        proposed_tags_tag = note["proposed_tags_encryption_tag"]

        if content is None:
            raise RuntimeError(
                f"Cache population failed: Note {note_id} has NULL content."
            )

        if tags is None:
            raise RuntimeError(
                f"Cache population failed: Note {note_id} has NULL tags."
            )
        if proposed_tags is None:
            raise RuntimeError(
                f"Cache population failed: Note {note_id} has NULL proposed_tags."
            )

        encrypted = nonce is not None
        if not encrypted:
            encrypted = tag is not None
        if encrypted and (nonce is None or tag is None):
            raise RuntimeError(
                "Cache population failed: encrypted note has incomplete metadata: "
                f"note_id={note_id} nonce={nonce is not None} tag={tag is not None}"
            )

        tags_encrypted = tags_nonce is not None
        if not tags_encrypted:
            tags_encrypted = tags_tag is not None
        if tags_encrypted and (tags_nonce is None or tags_tag is None):
            raise RuntimeError(
                "Cache population failed: encrypted tags have incomplete metadata: "
                f"note_id={note_id} nonce={tags_nonce is not None} tag={tags_tag is not None}"
            )

        proposed_tags_encrypted = proposed_tags_nonce is not None
        if not proposed_tags_encrypted:
            proposed_tags_encrypted = proposed_tags_tag is not None
        if proposed_tags_encrypted and (
            proposed_tags_nonce is None or proposed_tags_tag is None
        ):
            raise RuntimeError(
                "Cache population failed: encrypted proposed tags have incomplete metadata: "
                f"note_id={note_id} nonce={proposed_tags_nonce is not None} "
                f"tag={proposed_tags_tag is not None}"
            )

        if encrypted:
            if not encryption_service or not encryption_service.dek:
                raise RuntimeError(
                    "Cache population failed: encrypted note encountered without DEK. "
                    "This means the database contains encrypted rows but the "
                    "app_settings table does not have an active password/DEK. "
                    "The ciphertext is not recoverable without the DEK. "
                    f"note_id={note_id}"
                )
            step_started = time.perf_counter()
            decrypted_content = encryption_service.decrypt_from_storage(content, nonce, tag)
            decrypt_seconds += time.perf_counter() - step_started
        else:
            decrypted_content = content

        if tags_encrypted:
            if not encryption_service or not encryption_service.dek:
                raise RuntimeError(
                    "Cache population failed: encrypted tags encountered without DEK. "
                    "This means the database contains encrypted rows but the "
                    "app_settings table does not have an active password/DEK. "
                    "The ciphertext is not recoverable without the DEK. "
                    f"note_id={note_id}"
                )
            decrypted_tags = encryption_service.decrypt_from_storage(tags, tags_nonce, tags_tag)
        else:
            decrypted_tags = tags

        if proposed_tags_encrypted:
            if not encryption_service or not encryption_service.dek:
                raise RuntimeError(
                    "Cache population failed: encrypted proposed tags encountered without DEK. "
                    f"note_id={note_id}"
                )
            decrypted_proposed_tags = encryption_service.decrypt_from_storage(
                proposed_tags,
                proposed_tags_nonce,
                proposed_tags_tag,
            )
        else:
            decrypted_proposed_tags = proposed_tags

        sanitized_content = decrypted_content
        if clean_stored_html:
            step_started = time.perf_counter()
            sanitized_content = sanitize_note_html(decrypted_content)
            sanitize_seconds += time.perf_counter() - step_started
            if sanitized_content != decrypted_content:
                cleaned_notes[note_id] = sanitized_content
        hydrated_content[note_id] = sanitized_content
        hydrated_tags[note_id] = decrypted_tags
        hydrated_proposed_tags[note_id] = decrypted_proposed_tags
        # The sanitizer's output: its text without Python's HTML parser, same result.
        # It refuses a comment, script or style, which the sanitizer never writes.
        step_started = time.perf_counter()
        hydrated_text[note_id] = strip_sanitized_html(sanitized_content)
        text_seconds += time.perf_counter() - step_started
        structures.append({field: note[field] for field in _NOTE_STRUCTURE_FIELDS})

        processed += 1
        if _CACHE_TIMING_ENABLED and processed % _CACHE_TIMING_BATCH_NOTES == 0:
            now = time.perf_counter()
            batch_elapsed = now - last_checkpoint
            total_elapsed = now - loop_started
            print(
                f"[startup] cache decrypted {processed} notes | last {_CACHE_TIMING_BATCH_NOTES} in {batch_elapsed:.2f}s | total {total_elapsed:.2f}s"
            )
            logger.info(
                "[startup] cache decrypted %d notes | last %d in %.2fs | total %.2fs",
                processed,
                _CACHE_TIMING_BATCH_NOTES,
                batch_elapsed,
                total_elapsed,
            )
            last_checkpoint = now
            if hydration_state.is_running():
                hydration_state.update(processed)

    if hydration_state.is_running():
        hydration_state.update(processed)
        steps = {"decrypt note text": decrypt_seconds}
        if clean_stored_html:
            steps["sanitize note HTML (once)"] = sanitize_seconds
        steps["extract note text"] = text_seconds
        hydration_state.record_steps(steps)
    if processed != note_count:
        raise RuntimeError(f"Cache population read {processed} notes but the database counted {note_count}")

    _search_cache = hydrated_content
    _tag_cache = hydrated_tags
    _proposed_tag_cache = hydrated_proposed_tags
    _text_cache = hydrated_text

    if _CACHE_TIMING_ENABLED:
        total_loop = time.perf_counter() - loop_started
        print(
            f"[startup] cache decrypt loop processed {processed} notes in {total_loop:.2f}s"
        )
        logger.info(
            "[startup] cache decrypt loop processed %d notes in %.2fs",
            processed,
            total_loop,
        )

    logger.info(f"Content cache populated with {processed} notes")

    return structures, cleaned_notes
