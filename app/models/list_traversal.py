from typing import Any, List, Optional
from types import SimpleNamespace

from app.db.notes_sql import fetch_children_ordered, fetch_note
from app.models.database import SafeSession
from app.services.note_store import store as note_store


class ListTraversal:
    """Handles traversal and validation of linked list structures"""
    
    @staticmethod
    def validate_list(db: SafeSession, parent_id: Optional[str]) -> bool:
        """Validate the linked list structure"""

        if note_store.loaded:
            child_ids = note_store.get_children(parent_id)
            if not child_ids:
                return True

            records = [note_store.get_note(note_id) for note_id in child_ids]

            for index, record in enumerate(records):
                if index > 0:
                    expected_prev = records[index - 1].id
                else:
                    expected_prev = None
                if index < len(records) - 1:
                    expected_next = records[index + 1].id
                else:
                    expected_next = None

                prev_id = None
                if record.prev_id is not None:
                    prev_id = record.prev_id
                next_id = None
                if record.next_id is not None:
                    next_id = record.next_id

                if prev_id != expected_prev:
                    return False
                if next_id != expected_next:
                    return False
                if record.parent_id != parent_id:
                    return False

            return True

        with SafeSession.allow_reads("list_traversal:validate"):
            rows = fetch_children_ordered(db.connection(), parent_id)

        if not rows:
            return True

        notes = [SimpleNamespace(**row) for row in rows]

        # Single note case
        if len(notes) == 1:
            note = notes[0]
            # Must be both head and tail, with correct parent
            return (note.prev_id is None and 
                   note.next_id is None and 
                   note.parent_id == parent_id)

        # Multiple notes - should have exactly one head and one tail
        heads = [note for note in notes if note.prev_id is None]
        tails = [note for note in notes if note.next_id is None]

        if len(heads) != 1 or len(tails) != 1:
            return False

        # Traverse from head and verify links
        head = heads[0]
        seen = {head.id}
        current = head

        # Verify head's parent
        if head.parent_id != parent_id:
            return False

        while current.next_id:
            next_note = next((note for note in notes if note.id == current.next_id))
            # Explicit checks for each condition
            if not next_note:
                return False  # Next note doesn't exist
            if next_note.id in seen:
                return False  # Circular reference
            if next_note.prev_id != current.id:
                return False  # Broken bidirectional link
            if next_note.parent_id != parent_id:
                return False  # Wrong parent
            seen.add(next_note.id)
            current = next_note

        # Verify we found all notes and the tail is correct
        return (len(seen) == len(notes) and 
                current.next_id is None and  # Explicit tail check
                current.parent_id == parent_id)  # Tail has correct parent

    @staticmethod
    def get_ordered_child_list(db: SafeSession, parent_id: Optional[str]) -> List[Any]:
        """Get an ordered list of child notes for the given parent_id"""

        if note_store.loaded:
            ordered_ids = note_store.get_children(parent_id)
            return [_NoteProxy(note_store.get_note(note_id)) for note_id in ordered_ids]

        with SafeSession.allow_reads("list_traversal:children"):
            rows = fetch_children_ordered(db.connection(), parent_id)

        all_notes = [SimpleNamespace(**row) for row in rows]
        if not all_notes:
            return []

        # Find notes with no prev_id
        first_notes = [note for note in all_notes if note.prev_id is None]
        if len(first_notes) > 1:
            raise ValueError(f"Invalid state: Multiple notes without prev_id found at same level: {[n.id for n in first_notes]}")
        elif len(first_notes) == 0:
            raise ValueError(f"Invalid state: No note without prev_id found at this level")
        
        first = first_notes[0]
        
        # Build ordered list
        ordered = [first]
        current = first
        seen = {first.id}
        
        # Follow next_id chain
        while current.next_id:
            next_note = next((note for note in all_notes if note.id == current.next_id))
            if not next_note:
                raise ValueError(f"Invalid state: Note {current.id} points to non-existent next_id {current.next_id}")
            if next_note.id in seen:
                raise ValueError(f"Invalid state: Circular reference detected at note {current.id}")
            ordered.append(next_note)
            seen.add(next_note.id)
            current = next_note
        
        # Verify we found all notes
        if len(ordered) != len(all_notes):
            missing = set(note.id for note in all_notes) - seen
            raise ValueError(f"Invalid state: Notes not in chain: {missing}")
        
        return ordered

    @staticmethod
    def would_create_cycle(db: SafeSession, note_id: str, new_parent_id: str) -> bool:
        """Check if moving note to new_parent would create a parent-child cycle"""
        if not new_parent_id:
            return False

        if note_store.loaded:
            current = new_parent_id
            seen = set()
            while current and current not in seen:
                if current == note_id:
                    return True
                seen.add(current)
                parent_record = note_store.get_note(current)
                current = parent_record.parent_id
            return False

        current = new_parent_id
        seen = set()
        while current and current not in seen:
            if current == note_id:
                return True
            seen.add(current)
            with SafeSession.allow_reads("list_traversal:cycle"):
                parent = fetch_note(db.connection(), current)
            if not parent:
                raise ValueError(f"Cycle check failed: parent id not found in db: {current}")
            if "parent_id" not in parent:
                raise RuntimeError(
                    f"Cycle check failed: fetched row missing parent_id for id {current}"
                )
            current = parent["parent_id"]
        return False


class _NoteProxy:
    """Lightweight note row for serving from the in-memory store."""

    __slots__ = (
        'id',
        'parent_id',
        'prev_id',
        'next_id',
        'is_collapsed',
        'created_at',
        'updated_at',
    )

    def __init__(self, record) -> None:
        self.id = record.id
        self.parent_id = record.parent_id
        self.prev_id = record.prev_id
        self.next_id = record.next_id
        self.is_collapsed = record.is_collapsed
        self.created_at = record.created_at
        self.updated_at = record.updated_at
