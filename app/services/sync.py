from __future__ import annotations

import uuid
from copy import deepcopy
from functools import wraps
from threading import RLock
from typing import Dict, Tuple

_state_lock = RLock()

def _synchronized(func):
    @wraps(func)
    def wrapped(*args, **kwargs):
        with _state_lock:
            return func(*args, **kwargs)
    return wrapped


_update_uuid: str = uuid.uuid4().hex
_locks: Dict[str, str] = {}
_clipboards: Dict[str, list] = {}


@_synchronized
def generate_new_uuid() -> str:
    global _update_uuid
    _update_uuid = uuid.uuid4().hex
    return _update_uuid


@_synchronized
def get_current_sync_uuid() -> str:
    return _update_uuid


@_synchronized
def set_server_sync_uuid(value: str) -> None:
    global _update_uuid
    _update_uuid = value


@_synchronized
def acquire_note_lock(note_id: str, client_id: str) -> Tuple[bool, bool]:
    if note_id in _locks:
        current = _locks[note_id]
        if current and current != client_id:
            return False, False
    _locks[note_id] = client_id
    generate_new_uuid()
    return True, False


@_synchronized
def release_note_lock(note_id: str, client_id: str) -> None:
    if note_id not in _locks:
        return
    if _locks[note_id] == client_id:
        del _locks[note_id]
        generate_new_uuid()


@_synchronized
def get_all_locks() -> Dict[str, str]:
    return dict(_locks)


@_synchronized
def set_clipboard(client_id: str, records: list) -> None:
    _clipboards[client_id] = deepcopy(records)
    generate_new_uuid()


@_synchronized
def get_clipboard(client_id: str) -> list:
    if client_id not in _clipboards:
        return []
    records = _clipboards[client_id]
    if records:
        return deepcopy(records)
    return []


@_synchronized
def clear_all_locks() -> None:
    """Release every lock and bump the sync UUID to force client refresh."""
    if _locks:
        _locks.clear()
        generate_new_uuid()


@_synchronized
def reset_state() -> None:
    """Clear all in-memory sync state for deterministic test setup."""
    global _update_uuid
    _locks.clear()
    _clipboards.clear()
    _update_uuid = uuid.uuid4().hex


@_synchronized
def capture_sync_state() -> tuple:
    return _update_uuid, dict(_locks), deepcopy(_clipboards)


@_synchronized
def restore_sync_state(snapshot: tuple) -> None:
    global _update_uuid
    _update_uuid, locks, clipboards = snapshot
    _locks.clear()
    _locks.update(locks)
    _clipboards.clear()
    _clipboards.update(deepcopy(clipboards))
