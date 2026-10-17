import uuid
import time
from typing import Dict, Optional, Any

NOTE_LOCK_TIMEOUT_SECONDS = 5.0

# Global in-memory sync state - THIS IS MUTABLE SERVER STATE
_current_update_uuid = str(uuid.uuid4())

# Global in-memory note locks - THIS IS MUTABLE SERVER STATE  
# Format: {note_id: {"client_id": str, "timestamp": float}}
_note_locks: Dict[str, Dict[str, Any]] = {}

# Global in-memory clipboard storage - THIS IS MUTABLE SERVER STATE
# Format: {client_id: serialized_note_data} - stores the serialized note data for each client
_client_clipboards: Dict[str, Optional[Dict[str, Any]]] = {}


def reset_state() -> None:
    """Discard legacy locks and clipboard payloads."""
    global _current_update_uuid
    _note_locks.clear()
    _client_clipboards.clear()
    _current_update_uuid = str(uuid.uuid4())


def generate_new_uuid() -> str:
    """Generate a new UUID (pure function, no side effects)."""
    return str(uuid.uuid4())


def set_server_sync_uuid(new_uuid: str) -> None:
    """SIDE EFFECT: Updates the global sync UUID on the server."""
    global _current_update_uuid
    _current_update_uuid = new_uuid


def get_current_sync_uuid() -> str:
    """Get the current sync UUID from server state (read-only)."""
    return _current_update_uuid


def cleanup_expired_locks() -> bool:
    """Remove expired locks and return True if any were removed."""
    global _note_locks
    
    current_time = time.time()
    expired_notes = []
    
    for note_id, lock_info in _note_locks.items():
        if current_time - lock_info["timestamp"] >= NOTE_LOCK_TIMEOUT_SECONDS:
            expired_notes.append(note_id)
    
    for note_id in expired_notes:
        del _note_locks[note_id]
    
    return len(expired_notes) > 0


# Note locking functions
def acquire_note_lock(note_id: str, client_id: str) -> tuple[bool, bool]:
    """SIDE EFFECT: Try to acquire a lock on a note.
    
    Returns:
        tuple[bool, bool]: (success, expired_lock_removed)
            - success: True if lock acquired, False if already locked by different client
            - expired_lock_removed: True if an expired lock was removed
    """
    global _note_locks
    
    current_time = time.time()
    expired_lock_removed = False
    
    # Check if note is already locked
    if note_id in _note_locks:
        lock_info = _note_locks[note_id]
        
        # If locked by same client, refresh timestamp
        if lock_info["client_id"] == client_id:
            lock_info["timestamp"] = current_time
            return True, False
            
        # If locked by different client, check if lock is expired (5 second timeout)
        if current_time - lock_info["timestamp"] < NOTE_LOCK_TIMEOUT_SECONDS:
            return False, False
        
        # Lock is expired, remove it and continue to acquire
        del _note_locks[note_id]
        expired_lock_removed = True
    
    # Acquire the lock with current timestamp
    _note_locks[note_id] = {
        "client_id": client_id,
        "timestamp": current_time
    }
    return True, expired_lock_removed


def release_note_lock(note_id: str, client_id: str) -> None:
    """SIDE EFFECT: Release a lock on a note if owned by the client."""
    global _note_locks
    
    # Only release if this client owns the lock
    if note_id not in _note_locks:
        return

    lock_info = _note_locks[note_id]
    if lock_info["client_id"] == client_id:
        del _note_locks[note_id]


def get_note_lock_owner(note_id: str) -> Optional[str]:
    """Get the client ID that owns the lock for a note (read-only)."""
    if note_id not in _note_locks:
        return None
    return _note_locks[note_id]["client_id"]


def get_all_locks() -> Dict[str, str]:
    """Get all current note locks (read-only)."""
    return {note_id: lock_info["client_id"] for note_id, lock_info in _note_locks.items()}


def is_note_locked_by_other_client(note_id: str, client_id: str) -> bool:
    """Check if a note is locked by a different client (read-only)."""
    if note_id not in _note_locks:
        return False

    lock_info = _note_locks[note_id]
    
    # Check if lock is expired (5 second timeout)
    current_time = time.time()
    if current_time - lock_info["timestamp"] >= NOTE_LOCK_TIMEOUT_SECONDS:
        return False
        
    return lock_info["client_id"] != client_id


# Clipboard management functions
def set_client_clipboard(client_id: str, note_data: Optional[Dict[str, Any]]) -> None:
    """SIDE EFFECT: Set the clipboard content for a client."""
    global _client_clipboards
    _client_clipboards[client_id] = note_data


def get_client_clipboard(client_id: str) -> Optional[Dict[str, Any]]:
    """Get the clipboard content for a client (read-only)."""
    if client_id not in _client_clipboards:
        return None
    return _client_clipboards[client_id]


def clear_client_clipboard(client_id: str) -> None:
    """SIDE EFFECT: Clear the clipboard for a client."""
    global _client_clipboards
    _client_clipboards[client_id] = None
