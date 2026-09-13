from typing import List, Optional, Any

from .enums import MovePosition
from .database import SafeSession

# Import the new specialized classes
from .list_traversal import ListTraversal
from .note_crud import NoteCRUD
from .list_operations import ListOperations


class LinkedListManager:
    """
    Facade class that maintains the original API while delegating to specialized classes.
    This ensures backward compatibility while following the Single Responsibility Principle.
    """

    # Delegate to ListTraversal
    @staticmethod
    def validate_list(db: SafeSession, parent_id: Optional[str]) -> bool:
        return ListTraversal.validate_list(db, parent_id)

    @staticmethod
    def get_ordered_child_list(db: SafeSession, parent_id: Optional[str]) -> List[Any]:
        return ListTraversal.get_ordered_child_list(db, parent_id)

    @staticmethod
    def _would_create_cycle(db: SafeSession, note_id: str, new_parent_id: str) -> bool:
        return ListTraversal.would_create_cycle(db, note_id, new_parent_id)

    # Undo/redo operations are handled by app.services.undo_state
    # These methods are deprecated and should not be used
    @staticmethod
    def undo(db: SafeSession) -> bool:
        raise NotImplementedError("Use UndoRedoService instead")

    @staticmethod
    def redo(db: SafeSession) -> bool:
        raise NotImplementedError("Use UndoRedoService instead")

    # Delegate to NoteCRUD
    @staticmethod
    def create_note_top(db: SafeSession, note_id: str, parent_id: Optional[str]) -> None:
        return NoteCRUD.create_note_top(db, note_id, parent_id)

    @staticmethod
    def get_note(db: SafeSession, note_id: str):
        return NoteCRUD.get_note(db, note_id)

    @staticmethod
    def update_note(db: SafeSession, note_id: str, content: str):
        return NoteCRUD.update_note(db, note_id, content)

    @staticmethod
    def delete_note(db: SafeSession, note_id: str) -> None:
        return NoteCRUD.delete_note(db, note_id)

    # Delegate to ListOperations
    @staticmethod
    def move_note(
        db: SafeSession,
        note_id: str,
        new_parent_id: Optional[str],
        sibling_id: Optional[str],
        position: Optional[MovePosition],
    ):
        return ListOperations.move_note(db, note_id, new_parent_id, sibling_id, position)
