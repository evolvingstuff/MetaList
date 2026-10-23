"""In-memory UUID registry for encrypted file references."""

from __future__ import annotations

from collections.abc import Callable
import re
from threading import RLock

# A reference written in a note's text: [[id]] links, ![[id]] embeds.
_FILE_REFERENCE_TOKEN_RE = re.compile(
    r"!?\[\[([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]\]"
)


class FileRegistry:
    def __init__(self) -> None:
        self._lock = RLock()
        self._ids: set[str] = set()
        self._thumbnail_kinds_by_id: dict[str, str] = {}
        # File names by id, read from the files database the first time one is
        # needed (an encrypted vault's names can be read only once it is unlocked,
        # and notes are read, and searched, only then). None: not read yet.
        self._titles_by_id: dict[str, str] | None = None
        self._title_loader: Callable[[], dict[str, str]] | None = None

    def install_title_loader(self, loader: Callable[[], dict[str, str]]) -> None:
        """How to read every file's name (file_storage.py, which this module cannot import)."""
        if not callable(loader):
            raise TypeError("install_title_loader requires a callable")
        with self._lock:
            self._title_loader = loader

    def reset(self) -> None:
        with self._lock:
            self._ids.clear()
            self._thumbnail_kinds_by_id.clear()
            self._titles_by_id = None

    def replace_all(self, file_ids: set[str]) -> None:
        if not isinstance(file_ids, set):
            raise TypeError(f"file_ids must be a set, got {type(file_ids)}")
        for file_id in file_ids:
            if not isinstance(file_id, str) or file_id == "":
                raise TypeError("file_ids must contain non-empty strings")
        with self._lock:
            self._ids = set(file_ids)
            self._thumbnail_kinds_by_id = {}
            self._titles_by_id = None

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
            self._titles_by_id = None

    def add(self, file_id: str) -> None:
        if not isinstance(file_id, str) or file_id == "":
            raise TypeError("file_id must be a non-empty string")
        with self._lock:
            self._ids.add(file_id)

    def add_with_thumbnail_kind(self, file_id: str, *, thumbnail_kind: str, title: str) -> None:
        if not isinstance(file_id, str) or file_id == "":
            raise TypeError("file_id must be a non-empty string")
        if not isinstance(thumbnail_kind, str) or thumbnail_kind == "":
            raise TypeError("thumbnail_kind must be a non-empty string")
        if not isinstance(title, str) or title == "":
            raise TypeError("title must be a non-empty string")
        with self._lock:
            self._ids.add(file_id)
            self._thumbnail_kinds_by_id[file_id] = thumbnail_kind
            if self._titles_by_id is not None:
                self._titles_by_id[file_id] = title

    def remove_many(self, file_ids: set[str]) -> None:
        if not isinstance(file_ids, set):
            raise TypeError(f"file_ids must be a set, got {type(file_ids)}")
        with self._lock:
            self._ids.difference_update(file_ids)
            for file_id in file_ids:
                # Removing files may name some the registry never had.
                if file_id in self._thumbnail_kinds_by_id:
                    del self._thumbnail_kinds_by_id[file_id]
                if self._titles_by_id is not None and file_id in self._titles_by_id:
                    del self._titles_by_id[file_id]

    def has_file(self, file_id: str) -> bool:
        if not isinstance(file_id, str) or file_id == "":
            raise TypeError("file_id must be a non-empty string")
        with self._lock:
            return file_id in self._ids

    def title_of(self, file_id: str) -> str | None:
        """The file's name, or None when the id is no file's (a [[id]] naming a note)."""
        if not isinstance(file_id, str) or file_id == "":
            raise TypeError("file_id must be a non-empty string")
        with self._lock:
            if file_id not in self._ids:
                return None
            if self._titles_by_id is None:
                if self._title_loader is None:
                    raise RuntimeError("File names are read before file storage installed their loader")
                self._titles_by_id = dict(self._title_loader())
            if file_id not in self._titles_by_id:
                raise RuntimeError(f"File {file_id} is registered but has no stored name")
            return self._titles_by_id[file_id]

    def referenced_file_names(self, text: str) -> list[tuple[str, str]]:
        """(id, name) of each file a note's text references, in order, once each."""
        if not isinstance(text, str):
            raise TypeError(f"text must be a string, got {type(text)}")
        if "[[" not in text:
            # Most notes reference nothing; skip the scan during hydration.
            return []
        names: list[tuple[str, str]] = []
        seen: set[str] = set()
        for match in _FILE_REFERENCE_TOKEN_RE.finditer(text):
            file_id = match.group(1)
            if file_id in seen:
                continue
            seen.add(file_id)
            title = self.title_of(file_id)
            if title is not None:
                names.append((file_id, title))
        return names

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
