from __future__ import annotations

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
_metric_revision = -1
_metric_store = None
_metric_values = {}
_metric_has_text = False
_text_keys = {}


def _metrics(*, include_text):
    global _metric_revision, _metric_store, _metric_values, _text_keys, _metric_has_text
    with _metric_lock:
        revision = note_store.revision
        if _metric_store is note_store and _metric_revision == revision and (not include_text or _metric_has_text):
            return _metric_values
        records = note_store.snapshot()
        text_keys = {}
        values = {}
        for note_id, record in records.items():
            volume = 0
            if include_text:
                if note_id in _text_keys and _text_keys[note_id][0] is record.content:
                    text_keys[note_id] = _text_keys[note_id]
                else:
                    text_keys[note_id] = (record.content, len(strip_html(record.content)))
                volume = text_keys[note_id][1]
            values[note_id] = {'updated':record.updated_at, 'volume':volume}
        # Parent aggregation is postorder and visits every edge once.
        children = {note_id: [] for note_id in records}
        roots = []
        for note_id, record in records.items():
            if record.parent_id is None:
                roots.append(note_id)
            else:
                children[record.parent_id].append(note_id)
        pending = [(root, False) for root in roots]
        visited = set()
        while pending:
            note_id, finishing = pending.pop()
            if not finishing:
                if note_id in visited:
                    raise RuntimeError('Cycle in root sorting hierarchy')
                visited.add(note_id)
                pending.append((note_id, True))
                pending.extend((child, False) for child in children[note_id])
                continue
            for child in children[note_id]:
                values[note_id]['volume'] += values[child]['volume']
                current, descendant = values[note_id]['updated'], values[child]['updated']
                if not isinstance(current, datetime) or not isinstance(descendant, datetime):
                    values[note_id]['updated'] = None
                elif descendant > current:
                    values[note_id]['updated'] = descendant
        if len(visited) != len(records):
            raise RuntimeError('Disconnected cycle in root sorting hierarchy')
        _metric_values = values
        if include_text:
            _text_keys = text_keys
        else:
            _text_keys = {key: entry for key, entry in _text_keys.items() if key in records and entry[0] is records[key].content}
        _metric_has_text = include_text
        _metric_revision, _metric_store = revision, note_store
        return values


def clear_root_sort_cache() -> None:
    global _metric_revision, _metric_values, _text_keys
    with _metric_lock:
        _metric_revision = -1
        _metric_values = {}
        _text_keys = {}
        _alphabetical_key.cache_clear()


def _get_root_subtree_updated_timestamp(root_id: str):
    value = _metrics(include_text=False)[root_id]['updated']
    if not isinstance(value, datetime):
        raise RuntimeError('Root subtree is missing valid timestamps')
    return value


@sensitive_lru_cache(maxsize=32768, max_bytes=16 * 1024 * 1024)
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
        decorated_alpha.sort(key=lambda item: (item[1], item[2]))
        return [root_id for root_id, _, _ in decorated_alpha]
    if normalized == SORT_MODE_CONTENT_VOLUME:
        decorated_volume = []
        for canonical_index, root_id in enumerate(canonical_root_ids):
            character_count = _get_root_subtree_content_volume(root_id)
            decorated_volume.append((root_id, character_count, canonical_index))
        decorated_volume.sort(key=lambda item: (-item[1], item[2]))
        return [root_id for root_id, _, _ in decorated_volume]

    decorated = []
    for canonical_index, root_id in enumerate(canonical_root_ids):
        if root_id not in root_timestamps:
            raise RuntimeError(f"Missing root sort timestamp for {root_id}")
        timestamp = root_timestamps[root_id]
        decorated.append((root_id, timestamp, canonical_index))

    decorated.sort(key=lambda item: (-item[1].timestamp(), item[2]))
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
