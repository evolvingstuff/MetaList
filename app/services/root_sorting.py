from __future__ import annotations

from app.services.resource_limits import SENSITIVE_MEMO_BYTES
from threading import RLock

from datetime import datetime
from typing import Dict, List, Optional

from app.services.note_store import store as note_store
from app.utils.text_utils import strip_html
from app.security.sensitive_cache import sensitive_lru_cache


SORT_MODE_NORMAL = "normal"
SORT_MODE_CREATED = "created"
SORT_MODE_UPDATED = "updated"
SORT_MODE_ALPHABETICAL = "alphabetical"
SORT_MODE_CONTENT_VOLUME = "content-volume"
SORT_MODES = frozenset(
    {
        SORT_MODE_NORMAL,
        SORT_MODE_CREATED,
        SORT_MODE_UPDATED,
        SORT_MODE_ALPHABETICAL,
        SORT_MODE_CONTENT_VOLUME,
    }
)
TIMESTAMP_SORT_MODES = frozenset({SORT_MODE_CREATED, SORT_MODE_UPDATED})
_ALPHABETICAL_KEY_MEMO_ENTRIES = 32768
# The missing-parents error names at most this many of them.
_MISSING_PARENTS_SHOWN = 5


def normalize_sort_mode(sort_mode: object) -> str:
    if not isinstance(sort_mode, str):
        raise TypeError(f"sort_mode must be a string, got {type(sort_mode)}")
    normalized = sort_mode.strip().lower()
    if normalized not in SORT_MODES:
        raise ValueError(f"Unsupported sort mode: {sort_mode!r}")
    return normalized


def is_root_reorder_locked(sort_mode: object) -> bool:
    return normalize_sort_mode(sort_mode) != SORT_MODE_NORMAL


def is_timestamp_sort_mode(sort_mode: object) -> bool:
    return normalize_sort_mode(sort_mode) in TIMESTAMP_SORT_MODES


def _get_note_timestamp(note_id: str, sort_mode: str) -> datetime:
    record = note_store.get_note(note_id)
    if sort_mode == SORT_MODE_CREATED:
        timestamp = record.created_at
        field_name = "created_at"
    elif sort_mode == SORT_MODE_UPDATED:
        timestamp = record.updated_at
        field_name = "updated_at"
    else:
        raise ValueError(f"Timestamp lookup unsupported for sort mode {sort_mode!r}")

    if not isinstance(timestamp, datetime):
        raise RuntimeError(
            f"Root note {note_id} is missing required {field_name} for sort mode {sort_mode}"
        )
    return timestamp


_metric_lock = RLock()


class _RootMetrics:
    """Per-root subtree aggregates ('updated' max, 'volume' sum) at one store revision.

    Note records are immutable, so comparing the new snapshot with the previous
    one by identity finds exactly the notes an edit touched; only the roots
    above them (before and after the edit) are re-aggregated.
    """

    def __init__(self, store, records, *, include_text):
        self.store = store
        self.include_text = include_text
        self.records = {}
        self.children = {None: set()}
        self.own = {}
        self.text_keys = {}
        self.roots = {}
        self.revision = -1
        for note_id, record in records.items():
            if note_id not in self.children:
                self.children[note_id] = set()
            if record.parent_id not in self.children:
                self.children[record.parent_id] = set()
            self.children[record.parent_id].add(note_id)
            self.own[note_id] = self._own_values(note_id, record)
        missing_parents = set(self.children) - set(records) - {None}
        if missing_parents:
            raise RuntimeError(f'Root sorting parents are missing: {sorted(missing_parents)[:_MISSING_PARENTS_SHOWN]}')
        reached = 0
        for root_id in self.children[None]:
            self.roots[root_id], size = self._aggregate(root_id)
            reached += size
        # Notes no root reaches sit on disconnected cycles.
        if reached != len(records):
            raise RuntimeError('Disconnected cycle in root sorting hierarchy')
        self.records = records

    def _own_values(self, note_id, record):
        volume = 0
        if self.include_text:
            if note_id in self.text_keys and self.text_keys[note_id][0] is record.content:
                volume = self.text_keys[note_id][1]
            else:
                volume = len(strip_html(record.content))
                self.text_keys[note_id] = (record.content, volume)
        return record.updated_at, volume

    @staticmethod
    def _root_of(records, note_id):
        steps = 0
        while records[note_id].parent_id is not None:
            parent_id = records[note_id].parent_id
            if parent_id not in records:
                raise RuntimeError(f'Root sorting parent {parent_id} of {note_id} is missing')
            note_id = parent_id
            steps += 1
            if steps > len(records):
                raise RuntimeError('Cycle in root sorting hierarchy')
        return note_id

    def _aggregate(self, root_id):
        updated, volume = self.own[root_id]
        pending = [root_id]
        visited = {root_id}
        while pending:
            for child in self.children[pending.pop()]:
                if child in visited:
                    raise RuntimeError('Cycle in root sorting hierarchy')
                visited.add(child)
                pending.append(child)
                child_updated, child_volume = self.own[child]
                volume += child_volume
                if not isinstance(updated, datetime) or not isinstance(child_updated, datetime):
                    updated = None
                elif child_updated > updated:
                    updated = child_updated
        return {'updated': updated, 'volume': volume}, len(visited)

    def apply(self, records):
        previous = self.records
        changed = [note_id for note_id, record in records.items()
                   if note_id not in previous or previous[note_id] is not record]
        removed = [note_id for note_id in previous if note_id not in records]
        dirty_roots = set()
        for note_id in (*changed, *removed):
            if note_id in previous:
                dirty_roots.add(self._root_of(previous, note_id))
                self.children[previous[note_id].parent_id].discard(note_id)
        for note_id in removed:
            del self.own[note_id]
            del self.children[note_id]
            if note_id in self.text_keys:
                del self.text_keys[note_id]
        for note_id in changed:
            if note_id not in self.children:
                self.children[note_id] = set()
        for note_id in changed:
            record = records[note_id]
            # Any new cycle passes through a changed note, so this finds it.
            dirty_roots.add(self._root_of(records, note_id))
            if record.parent_id not in self.children:
                raise RuntimeError(f'Root sorting parent {record.parent_id} of {note_id} is missing')
            self.children[record.parent_id].add(note_id)
            self.own[note_id] = self._own_values(note_id, record)
        for root_id in dirty_roots:
            if root_id in records and records[root_id].parent_id is None:
                self.roots[root_id], _ = self._aggregate(root_id)
            elif root_id in self.roots:
                del self.roots[root_id]
        self.records = records
        assert len(self.roots) == len(self.children[None])


_metric_state = None


def _metrics(*, include_text):
    global _metric_state
    with _metric_lock:
        revision = note_store.revision
        state = _metric_state
        if state is not None and state.store is note_store and (state.include_text or not include_text):
            if state.revision != revision:
                state.apply(note_store.snapshot())
                state.revision = revision
            return state.roots
        state = _RootMetrics(note_store, note_store.snapshot(), include_text=include_text)
        state.revision = revision
        _metric_state = state
        return state.roots


def clear_root_sort_cache() -> None:
    global _metric_state
    with _metric_lock:
        _metric_state = None
        _alphabetical_key.cache_clear()


def _get_root_subtree_updated_timestamp(root_id: str):
    value = _metrics(include_text=False)[root_id]['updated']
    if not isinstance(value, datetime):
        raise RuntimeError('Root subtree is missing valid timestamps')
    return value


@sensitive_lru_cache(maxsize=_ALPHABETICAL_KEY_MEMO_ENTRIES, max_bytes=SENSITIVE_MEMO_BYTES)
def _alphabetical_key(content: str):
    text = strip_html(content).strip()
    return text.casefold(), text, len(text)


def _get_root_content_sort_key(note_id: str):
    return _alphabetical_key(note_store.get_note(note_id).content)


def _get_root_subtree_content_volume(root_id: str) -> int:
    return _metrics(include_text=True)[root_id]['volume']


def get_root_sort_timestamps(sort_mode: object) -> Dict[str, datetime]:
    normalized = normalize_sort_mode(sort_mode)
    canonical_root_ids = note_store.get_children(None)
    if normalized not in TIMESTAMP_SORT_MODES:
        return {}

    root_timestamps: Dict[str, datetime] = {}
    for root_id in canonical_root_ids:
        if normalized == SORT_MODE_CREATED:
            root_timestamps[root_id] = _get_note_timestamp(root_id, normalized)
        else:
            root_timestamps[root_id] = _get_root_subtree_updated_timestamp(root_id)
    return root_timestamps


def _alphabetical_sort_key(item: tuple[str, object, int]) -> tuple[object, int]:
    _root_id, content_key, canonical_index = item
    return content_key, canonical_index


def _content_volume_sort_key(item: tuple[str, int, int]) -> tuple[int, int]:
    _root_id, character_count, canonical_index = item
    return -character_count, canonical_index


def _newest_first_sort_key(item: tuple[str, datetime, int]) -> tuple[float, int]:
    _root_id, timestamp, canonical_index = item
    return -timestamp.timestamp(), canonical_index


def get_root_ids_for_sort_mode(
    sort_mode: object,
    *,
    root_timestamps: Dict[str, datetime],
) -> List[str]:
    normalized = normalize_sort_mode(sort_mode)
    canonical_root_ids = note_store.get_children(None)
    if normalized == SORT_MODE_NORMAL:
        return canonical_root_ids
    if normalized == SORT_MODE_ALPHABETICAL:
        decorated_alpha = []
        for canonical_index, root_id in enumerate(canonical_root_ids):
            content_key = _get_root_content_sort_key(root_id)
            decorated_alpha.append((root_id, content_key, canonical_index))
        decorated_alpha.sort(key=_alphabetical_sort_key)
        return [root_id for root_id, _, _ in decorated_alpha]
    if normalized == SORT_MODE_CONTENT_VOLUME:
        decorated_volume = []
        for canonical_index, root_id in enumerate(canonical_root_ids):
            character_count = _get_root_subtree_content_volume(root_id)
            decorated_volume.append((root_id, character_count, canonical_index))
        decorated_volume.sort(key=_content_volume_sort_key)
        return [root_id for root_id, _, _ in decorated_volume]

    decorated = []
    for canonical_index, root_id in enumerate(canonical_root_ids):
        if root_id not in root_timestamps:
            raise RuntimeError(f"Missing root sort timestamp for {root_id}")
        timestamp = root_timestamps[root_id]
        decorated.append((root_id, timestamp, canonical_index))

    decorated.sort(key=_newest_first_sort_key)
    return [root_id for root_id, _, _ in decorated]


def build_root_sort_buckets(
    root_ids: List[str],
    sort_mode: object,
    *,
    root_timestamps: Dict[str, datetime],
) -> Dict[str, Dict[str, str]]:
    normalized = normalize_sort_mode(sort_mode)
    if normalized not in TIMESTAMP_SORT_MODES:
        return {}

    buckets: Dict[str, Dict[str, str]] = {}
    for root_id in root_ids:
        if root_id not in root_timestamps:
            raise RuntimeError(f"Missing root sort timestamp for {root_id}")
        timestamp = root_timestamps[root_id].astimezone()
        buckets[root_id] = {
            "key": timestamp.strftime("%Y-%m-%d"),
            "label": timestamp.strftime("%Y/%m/%d - %A"),
        }
    return buckets
