"""In-memory content cache for encrypted notes.

Provides fast search access to decrypted note content while maintaining
encrypted-at-rest storage. Cache is populated on startup and maintained
manually by the sqlite helper layer and service hooks.
"""

import logging
import time
from typing import Dict, Mapping, Optional, Sequence

from app.db.session import connect_reader
from app.db.notes_sql import fetch_all_for_cache

from ..models.database import SafeSession
from ..utils.encryption import get_encryption_service
from app.services.hydration_state import hydration_state
from app.utils.text_utils import strip_html
from app.security.note_html import sanitize_note_html

logger = logging.getLogger(__name__)

# Global in-memory caches: {note_id: decrypted_string}
_search_cache: Dict[str, str] = {}
_tag_cache: Dict[str, str] = {}
_proposed_tag_cache: Dict[str, str] = {}
_text_cache: Dict[str, str] = {}

_CACHE_TIMING_ENABLED = True


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
    logger.debug(f"Cached content for note {note_id[:8]}...")


def cache_note_tags(note_id: str, tags: str) -> None:
    _tag_cache[note_id] = tags
    logger.debug(f"Cached tags for note {note_id[:8]}...")


def cache_note_proposed_tags(note_id: str, proposed_tags: str) -> None:
    if not isinstance(proposed_tags, str):
        raise TypeError("proposed_tags must be a string")
    _proposed_tag_cache[note_id] = proposed_tags
    logger.debug(f"Cached proposed tags for note {note_id[:8]}...")


def cache_note_text(note_id: str, raw_text: str) -> None:
    _text_cache[note_id] = raw_text
    logger.debug(f"Cached raw text for note {note_id[:8]}...")


def remove_cached_note(note_id: str) -> None:
    """Remove note from cache.
    
    Args:
        note_id: ID of note to remove
    """
    if note_id in _search_cache:
        del _search_cache[note_id]
        logger.debug(f"Removed cached content for note {note_id[:8]}...")
    if note_id in _tag_cache:
        del _tag_cache[note_id]
        logger.debug(f"Removed cached tags for note {note_id[:8]}...")
    if note_id in _proposed_tag_cache:
        del _proposed_tag_cache[note_id]
        logger.debug(f"Removed cached proposed tags for note {note_id[:8]}...")
    if note_id in _text_cache:
        del _text_cache[note_id]
        logger.debug(f"Removed cached raw text for note {note_id[:8]}...")


def get_cache_size() -> int:
    """Get current number of notes in cache.
    
    Returns:
        Number of cached notes
    """
    return len(_search_cache)


def clear_cache() -> None:
    """Clear all cached content."""
    global _search_cache, _tag_cache, _proposed_tag_cache, _text_cache
    _search_cache = {}
    _tag_cache = {}
    _proposed_tag_cache = {}
    _text_cache = {}
    logger.info("Cache cleared")


def populate_cache_from_db(db: SafeSession | None) -> Sequence[Mapping[str, object]]:
    """Populate cache with all notes from database on startup.

    The optional ``db`` parameter is retained for backwards compatibility but
    is no longer used now that the helper layer opens its own read
    connections.
    """
    global _search_cache, _tag_cache, _proposed_tag_cache, _text_cache

    logger.info("Populating content cache from database...")

    fetch_start = time.perf_counter()
    if db is None:
        with connect_reader("cache:populate") as connection:
            notes = list(fetch_all_for_cache(connection))
    else:
        with SafeSession.allow_reads("cache:populate"):
            notes = list(fetch_all_for_cache(db.connection()))
    if _CACHE_TIMING_ENABLED:
        fetch_duration = time.perf_counter() - fetch_start
        print(f"[startup] cache query returned {len(notes)} rows in {fetch_duration:.2f}s")
        logger.info(
            "[startup] cache query returned %d rows in %.2fs",
            len(notes),
            fetch_duration,
        )

    clear_cache()

    hydrated_content: Dict[str, str] = {}
    hydrated_tags: Dict[str, str] = {}
    hydrated_proposed_tags: Dict[str, str] = {}
    hydrated_text: Dict[str, str] = {}

    if hydration_state.is_running():
        hydration_state.set_phase(
            phase="decrypt",
            message="Decrypting notes into memory",
            total=len(notes),
        )

    encryption_service = get_encryption_service()

    loop_started = time.perf_counter()
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
            decrypted_content = encryption_service.decrypt_from_storage(content, nonce, tag)
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

        sanitized_content = sanitize_note_html(decrypted_content)
        hydrated_content[note_id] = sanitized_content
        hydrated_tags[note_id] = decrypted_tags
        hydrated_proposed_tags[note_id] = decrypted_proposed_tags
        hydrated_text[note_id] = strip_html(sanitized_content)

        processed += 1
        if _CACHE_TIMING_ENABLED and processed % 1000 == 0:
            now = time.perf_counter()
            batch_elapsed = now - last_checkpoint
            total_elapsed = now - loop_started
            print(
                f"[startup] cache decrypted {processed} notes | last 1000 in {batch_elapsed:.2f}s | total {total_elapsed:.2f}s"
            )
            logger.info(
                "[startup] cache decrypted %d notes | last 1000 in %.2fs | total %.2fs",
                processed,
                batch_elapsed,
                total_elapsed,
            )
            last_checkpoint = now
            if hydration_state.is_running():
                hydration_state.update(processed)

    if hydration_state.is_running():
        hydration_state.update(processed)

    _search_cache = hydrated_content
    _tag_cache = hydrated_tags
    _proposed_tag_cache = hydrated_proposed_tags
    _text_cache = hydrated_text

    if _CACHE_TIMING_ENABLED:
        total_loop = time.perf_counter() - loop_started
        print(
            f"[startup] cache decrypt loop processed {len(notes)} notes in {total_loop:.2f}s"
        )
        logger.info(
            "[startup] cache decrypt loop processed %d notes in %.2fs",
            len(notes),
            total_loop,
        )

    logger.info(f"Content cache populated with {len(notes)} notes")

    return notes


def refresh_encrypted_cache(db: SafeSession) -> None:
    """Refresh cache for encrypted notes when encryption key becomes available.
    
    This should be called after user logs in and encryption key is set.
    
    Args:
        db: Database session to read from
    """
    logger.info("Refreshing encrypted content in cache...")

    encryption_service = get_encryption_service()
    if not encryption_service or not encryption_service.dek:
        raise RuntimeError("Cache refresh requested but no encryption key is available")

    with SafeSession.allow_reads("cache:refresh_encrypted"):
        rows = fetch_all_for_cache(db.connection())

    encrypted_notes = []
    for row in rows:
        if "encryption_nonce" not in row or "encryption_tag" not in row:
            raise KeyError("Missing encryption metadata columns in cache row.")
        if "tags_encryption_nonce" not in row or "tags_encryption_tag" not in row:
            raise KeyError("Missing tag encryption metadata columns in cache row.")
        if (
            "proposed_tags_encryption_nonce" not in row
            or "proposed_tags_encryption_tag" not in row
        ):
            raise KeyError("Missing proposed-tag encryption metadata columns in cache row.")
        has_content_encryption = (
            row["encryption_nonce"] is not None and row["encryption_tag"] is not None
        )
        has_tags_encryption = (
            row["tags_encryption_nonce"] is not None and row["tags_encryption_tag"] is not None
        )
        has_proposed_tags_encryption = (
            row["proposed_tags_encryption_nonce"] is not None
            and row["proposed_tags_encryption_tag"] is not None
        )
        if has_content_encryption or has_tags_encryption or has_proposed_tags_encryption:
            encrypted_notes.append(row)

    refreshed_count = 0

    for note in encrypted_notes:
        content = note["content"]
        nonce = note["encryption_nonce"]
        tag = note["encryption_tag"]
        note_id = note["id"]
        tags = note["tags"]
        tags_nonce = note["tags_encryption_nonce"]
        tags_tag = note["tags_encryption_tag"]
        proposed_tags = note["proposed_tags"]
        proposed_tags_nonce = note["proposed_tags_encryption_nonce"]
        proposed_tags_tag = note["proposed_tags_encryption_tag"]

        if content is None:
            raise RuntimeError(
                f"Cache refresh failed: Encrypted note {note_id} has NULL content."
            )
        if tags is None:
            raise RuntimeError(
                f"Cache refresh failed: Encrypted note {note_id} has NULL tags."
            )
        if proposed_tags is None:
            raise RuntimeError(
                f"Cache refresh failed: Encrypted note {note_id} has NULL proposed_tags."
            )

        if (nonce is None) != (tag is None):
            raise RuntimeError(
                "Cache refresh failed: encrypted note has incomplete metadata: "
                f"note_id={note_id} nonce={nonce is not None} tag={tag is not None}"
            )
        if nonce is not None and tag is not None:
            decrypted_content = encryption_service.decrypt_from_storage(
                content,
                nonce,
                tag,
            )
            decrypted_content = sanitize_note_html(decrypted_content)
            cache_note(note_id, decrypted_content)
            raw_text = strip_html(decrypted_content)
            cache_note_text(note_id, raw_text)

        if (tags_nonce is None) != (tags_tag is None):
            raise RuntimeError(
                "Cache refresh failed: encrypted tags have incomplete metadata: "
                f"note_id={note_id} nonce={tags_nonce is not None} tag={tags_tag is not None}"
            )
        if tags_nonce is not None and tags_tag is not None:
            decrypted_tags = encryption_service.decrypt_from_storage(
                tags,
                tags_nonce,
                tags_tag,
            )
            cache_note_tags(note_id, decrypted_tags)

        if (proposed_tags_nonce is None) != (proposed_tags_tag is None):
            raise RuntimeError(
                "Cache refresh failed: encrypted proposed tags have incomplete metadata: "
                f"note_id={note_id} nonce={proposed_tags_nonce is not None} "
                f"tag={proposed_tags_tag is not None}"
            )
        if proposed_tags_nonce is not None and proposed_tags_tag is not None:
            decrypted_proposed_tags = encryption_service.decrypt_from_storage(
                proposed_tags,
                proposed_tags_nonce,
                proposed_tags_tag,
            )
            cache_note_proposed_tags(note_id, decrypted_proposed_tags)

        refreshed_count += 1

    logger.info(f"Refreshed {refreshed_count} encrypted notes in cache")


def get_all_cached_notes() -> Dict[str, str]:
    """Get all cached content (for debugging).
    
    Returns:
        Copy of entire cache dictionary
    """
    return _search_cache.copy()
