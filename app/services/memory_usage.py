"""What the Memory Usage dialog shows: this namespace server process's memory, and the
notes it holds decrypted in memory."""

from __future__ import annotations

from app.process_memory import current_resident_bytes, peak_resident_bytes, seconds_since_start
from app.services.hydration_state import hydration_state
from app.services.note_store import store as note_store


def describe_memory_usage() -> dict[str, object]:
    """The server process's resident memory now and at its peak, the notes the note store
    holds (decrypted, for an unlocked namespace) and their text in UTF-8 bytes, and how
    long the server has run. `notesLoaded` is false until the namespace has hydrated."""
    note_count = 0
    note_text_bytes = 0
    if note_store.loaded:
        for note_id in note_store.list_note_ids():
            record = note_store.get_note(note_id)
            note_count += 1
            note_text_bytes += len(record.content.encode("utf-8")) + len(record.tags.encode("utf-8"))
    return {
        "residentBytes": current_resident_bytes(),
        "peakResidentBytes": peak_resident_bytes(),
        "notesLoaded": note_store.loaded,
        "noteCount": note_count,
        "noteTextBytes": note_text_bytes,
        "uptimeSeconds": seconds_since_start(),
        # The last unlock's phases and steps in seconds (none before the first unlock).
        "lastUnlock": hydration_state.last_run_timings(),
    }
