"""Reference edges owned by NoteStore and protected by its lock.

Only UUIDs and occurrence counts are retained, never note text. Targets may be
missing (or files); retaining those edges lets a restored note regain backlinks
without reparsing its referrers. It also keeps which notes show a picture inline
(an <img> in their own text), for the Files filter's Images (file_kinds.py).
"""

from collections import Counter
import re

from app.services.embedded_references import collect_active_reference_tokens

_INLINE_IMAGE_RE = re.compile(r"<img\b", re.IGNORECASE)


class BacklinkIndex:
    def __init__(self) -> None:
        self._outgoing: dict[str, dict[str, int]] = {}
        self._incoming: dict[str, dict[str, int]] = {}
        self._inline_image_note_ids: set[str] = set()

    def clear(self) -> None:
        self._outgoing.clear()
        self._incoming.clear()
        self._inline_image_note_ids.clear()

    def upsert(self, note_id: str, content: str, tags: str) -> None:
        assert isinstance(note_id, str) and note_id
        counts = dict(Counter(
            token.note_id for token in collect_active_reference_tokens(content)
            if token.note_id != note_id
        ))
        self.remove(note_id)
        if _INLINE_IMAGE_RE.search(content) is not None:
            self._inline_image_note_ids.add(note_id)
        if not counts:
            return
        self._outgoing[note_id] = counts
        for target_id, count in counts.items():
            if target_id not in self._incoming:
                self._incoming[target_id] = {}
            self._incoming[target_id][note_id] = count

    def remove(self, note_id: str) -> None:
        self._inline_image_note_ids.discard(note_id)
        if note_id not in self._outgoing:
            return
        for target_id in self._outgoing.pop(note_id):
            sources = self._incoming[target_id]
            assert note_id in sources
            del sources[note_id]
            if not sources:
                del self._incoming[target_id]

    def has_backlinks(self, note_id: str) -> bool:
        return note_id in self._incoming

    def get_target_ids(self, note_id: str) -> frozenset[str]:
        if note_id not in self._outgoing:
            return frozenset()
        return frozenset(self._outgoing[note_id])

    def inline_image_note_ids(self) -> frozenset[str]:
        return frozenset(self._inline_image_note_ids)

    def get_counts(self, note_id: str) -> dict[str, int]:
        if note_id not in self._incoming:
            return {}
        return dict(self._incoming[note_id])
