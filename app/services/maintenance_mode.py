"""Maintenance mode service for bulk operations."""

import threading
from contextlib import contextmanager
from typing import Optional


class MaintenanceModeService:
    """Service for managing maintenance mode during bulk operations."""
    
    def __init__(self):
        self._maintenance_active = False
        self._operation_description = ""
        self._transaction_holds: list[str] = []
        self._lock = threading.Lock()
    
    def enter_maintenance(self, operation_description: str) -> None:
        """Enter maintenance mode with optional description.
        
        Args:
            operation_description: Description of the operation in progress
        """
        with self._lock:
            self._maintenance_active = True
            self._operation_description = operation_description
            print(f"[MaintenanceMode] Entered maintenance mode: {operation_description}")
    
    def exit_maintenance(self) -> None:
        """Exit maintenance mode."""
        with self._lock:
            operation = self._operation_description
            self._maintenance_active = False
            self._operation_description = ""
            print(f"[MaintenanceMode] Exited maintenance mode: {operation}")
    
    def is_active(self) -> bool:
        """Check if maintenance mode is currently active."""
        with self._lock:
            if self._maintenance_active:
                return True
            return bool(self._transaction_holds)
    
    def get_operation_description(self) -> str:
        """Get current operation description."""
        with self._lock:
            if self._transaction_holds:
                return self._transaction_holds[-1]
            return self._operation_description

    @contextmanager
    def hold_for_transaction(self, description: str):
        """Keep readers blocked through commit and any rollback recovery."""
        with self._lock:
            self._transaction_holds.append(description)
        try:
            yield
        finally:
            with self._lock:
                self._transaction_holds.remove(description)


# Global maintenance mode service instance
maintenance_service = MaintenanceModeService()
