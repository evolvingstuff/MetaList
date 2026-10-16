"""In-memory UUID registry for encrypted file references."""

from __future__ import annotations

from threading import RLock


class FileRegistry:
    def __init__(self) -> None:
        self._lock = RLock()
        self._ids: set[str] = set()
        self._thumbnail_kinds_by_id: dict[str, str] = {}

    def reset(self) -> None:
        with self._lock:
            self._ids.clear()
            self._thumbnail_kinds_by_id.clear()

    def replace_all(self, file_ids: set[str]) -> None:
        if not isinstance(file_ids, set):
            raise TypeError(f"file_ids must be a set, got {type(file_ids)}")
        for file_id in file_ids:
            if not isinstance(file_id, str) or file_id == "":
                raise TypeError("file_ids must contain non-empty strings")
        with self._lock:
            self._ids = set(file_ids)
            self._thumbnail_kinds_by_id = {}

    def replace_all_with_thumbnail_kinds(self, thumbnail_kinds_by_id: dict[str, str]) -> None:
        if not isinstance(thumbnail_kinds_by_id, dict):
            raise TypeError(
                f"thumbnail_kinds_by_id must be a dict, got {type(thumbnail_kinds_by_id)}"
            )
        for file_id, thumbnail_kind in thumbnail_kinds_by_id.items():
            if not isinstance(file_id, str) or file_id == "":
                raise TypeError("thumbnail_kinds_by_id keys must be non-empty strings")
            if not isinstance(thumbnail_kind, str) or thumbnail_kind == "":
                raise TypeError("thumbnail_kinds_by_id values must be non-empty strings")
        with self._lock:
            self._ids = set(thumbnail_kinds_by_id.keys())
            self._thumbnail_kinds_by_id = dict(thumbnail_kinds_by_id)

    def add(self, file_id: str) -> None:
        if not isinstance(file_id, str) or file_id == "":
            raise TypeError("file_id must be a non-empty string")
        with self._lock:
            self._ids.add(file_id)

    def add_with_thumbnail_kind(self, file_id: str, *, thumbnail_kind: str) -> None:
        if not isinstance(file_id, str) or file_id == "":
            raise TypeError("file_id must be a non-empty string")
        if not isinstance(thumbnail_kind, str) or thumbnail_kind == "":
            raise TypeError("thumbnail_kind must be a non-empty string")
        with self._lock:
            self._ids.add(file_id)
            self._thumbnail_kinds_by_id[file_id] = thumbnail_kind

    def remove_many(self, file_ids: set[str]) -> None:
        if not isinstance(file_ids, set):
            raise TypeError(f"file_ids must be a set, got {type(file_ids)}")
        with self._lock:
            self._ids.difference_update(file_ids)
            for file_id in file_ids:
                # Removing files may name some the registry never had.
                if file_id in self._thumbnail_kinds_by_id:
                    del self._thumbnail_kinds_by_id[file_id]

    def has_file(self, file_id: str) -> bool:
        if not isinstance(file_id, str) or file_id == "":
            raise TypeError("file_id must be a non-empty string")
        with self._lock:
            return file_id in self._ids

    def list_ids(self) -> set[str]:
        with self._lock:
            return set(self._ids)

    def has_resizable_file(self, file_id: str) -> bool:
        """Embedded files whose rendered size can be changed with a size wrapper: images and diagrams."""
        if not isinstance(file_id, str) or file_id == "":
            raise TypeError("file_id must be a non-empty string")
        with self._lock:
            return file_id in self._thumbnail_kinds_by_id and self._thumbnail_kinds_by_id[file_id] in {"image", "excalidraw"}

    def has_image_file(self, file_id: str) -> bool:
        if not isinstance(file_id, str) or file_id == "":
            raise TypeError("file_id must be a non-empty string")
        with self._lock:
            return file_id in self._thumbnail_kinds_by_id and self._thumbnail_kinds_by_id[file_id] == "image"


file_registry = FileRegistry()
