"""What holds this server's memory: the size of each of its large structures (the
note caches, the note store, the search index, ...), for the Memory Usage dialog.

Sizes only, never content. Each structure is walked while holding its lock (the
route holds the lock every write holds), counting every object it reaches with
sys.getsizeof. An object two structures share is counted once, in the first. The
walk keeps its record of counted objects in one packed array, and reads a dataclass's
fields rather than vars(), which would give every instance a dict it did not have:
measuring changes the memory it measures as little as possible.
"""

from __future__ import annotations

import dataclasses
import sys
import time
from array import array
from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager, nullcontext
from types import BuiltinFunctionType, FunctionType, MethodType, ModuleType

from app.security import sensitive_cache
from app.services import content_cache, snapshot, undo_state
from app.services.file_registry import file_registry
from app.services.link_titles import link_title_store
from app.services.note_store import store as note_store
from app.services.search_index import search_index
from app.services.view_cache import view_cache

# Objects the walk does not count: code and types belong to no structure, and small
# numbers and flags are shared interpreter-wide.
_UNCOUNTED_TYPES = (type, ModuleType, FunctionType, MethodType, BuiltinFunctionType, int, float, bool, type(None))
# References an object reached by the walk has without being shared: its container's,
# the walk's list of the container's children, the call's argument, and getrefcount's
# own. Above this, another structure holds it too.
_UNSHARED_REFERENCE_COUNT = 4
_EMPTY_SLOT = 0
# Object ids are 16-byte aligned: the low bits carry no information for the hash.
_ID_ALIGNMENT_BITS = 4
_INITIAL_CAPACITY_BITS = 16
_BYTES_PER_SLOT = 8
_MAXIMUM_FILL_DIVISOR = 2


class _PackedIdSet:
    """Object ids in one packed array (open addressing): no int object per id, so
    recording them costs 8 bytes each and one block the system takes back after."""

    def __init__(self) -> None:
        self._mask = (1 << _INITIAL_CAPACITY_BITS) - 1
        self._slots = array("Q", bytes(_BYTES_PER_SLOT << _INITIAL_CAPACITY_BITS))
        self._count = 0

    def add_if_new(self, key: int) -> bool:
        assert key != _EMPTY_SLOT, "an object id is never 0"
        if self._count * _MAXIMUM_FILL_DIVISOR > self._mask:
            self._grow()
        slots = self._slots
        index = (key >> _ID_ALIGNMENT_BITS) & self._mask
        while True:
            current = slots[index]
            if current == key:
                return False
            if current == _EMPTY_SLOT:
                slots[index] = key
                self._count += 1
                return True
            index = (index + 1) & self._mask

    def _grow(self) -> None:
        old_slots = self._slots
        self._mask = (self._mask << 1) | 1
        self._slots = array("Q", bytes(_BYTES_PER_SLOT * (self._mask + 1)))
        self._count = 0
        for key in old_slots:
            if key != _EMPTY_SLOT:
                self.add_if_new(key)


def _children(obj: object) -> list[object]:
    """A new list of what obj refers to: each child gains the same one reference from
    it, whatever its container, which _UNSHARED_REFERENCE_COUNT counts on."""
    if isinstance(obj, dict):
        return [*obj.keys(), *obj.values()]
    if isinstance(obj, (list, tuple, set, frozenset)):
        return list(obj)
    if dataclasses.is_dataclass(obj):
        return [getattr(obj, field.name) for field in dataclasses.fields(obj)]
    attributes: list[object] = []
    if hasattr(obj, "__dict__"):
        attributes.append(vars(obj))
    for klass in type(obj).__mro__:
        for slot in getattr(klass, "__slots__", ()):
            if hasattr(obj, slot):
                attributes.append(getattr(obj, slot))
    return attributes


def _size_and_children(obj: object, counted: _PackedIdSet) -> tuple[int, Sequence[object] | None]:
    if isinstance(obj, _UNCOUNTED_TYPES):
        return 0, None
    if sys.getrefcount(obj) > _UNSHARED_REFERENCE_COUNT and not counted.add_if_new(id(obj)):
        return 0, None
    size = sys.getsizeof(obj)
    if isinstance(obj, (str, bytes)):
        return size, None
    return size, _children(obj)


def _deep_size(root: object, counted: _PackedIdSet) -> int:
    """The bytes reachable from root that were not counted before. The stack holds each
    open container's children and the next one to visit, so it is only as long as the
    data is deep."""
    total, children = _size_and_children(root, counted)
    if children is None:
        return total
    stack: list[tuple[Sequence[object], int]] = [(children, 0)]
    while stack:
        siblings, index = stack[-1]
        if index == len(siblings):
            stack.pop()
            continue
        stack[-1] = (siblings, index + 1)
        size, grandchildren = _size_and_children(siblings[index], counted)
        total += size
        if grandchildren is not None:
            stack.append((grandchildren, 0))
    return total


@dataclasses.dataclass(frozen=True)
class _Part:
    label: str
    roots: Callable[[], tuple[object, ...]]
    lock: Callable[[], AbstractContextManager[object]]
    # A part made of one object whose fields are listed too, largest first.
    lists_fields: bool


# In order: a shared object is counted in the first part that holds it. The content
# cache and undo history change only under the lock the route holds; every other part
# is measured holding its own lock.
_PARTS = (
    _Part("Note text cache", lambda: (
        content_cache._search_cache, content_cache._text_cache,
        content_cache._tag_cache, content_cache._proposed_tag_cache,
    ), nullcontext, False),
    _Part("Note store (tree, tags, references)", lambda: (note_store,), lambda: note_store._lock, True),
    _Part("Search index", lambda: (search_index,), lambda: search_index._lock, True),
    _Part("Rendered note views", lambda: (snapshot._VIEW_RENDER_MEMO,), lambda: sensitive_cache._lock, False),
    _Part("Open views per tab", lambda: (view_cache,), lambda: view_cache._lock, False),
    _Part("Link titles", lambda: (link_title_store,), lambda: link_title_store._lock, False),
    _Part("Attachments index", lambda: (file_registry,), lambda: file_registry._lock, False),
    _Part("Undo history", lambda: (undo_state._clients,), nullcontext, False),
)


def _field_sizes(owner: object, counted: _PackedIdSet) -> list[tuple[str, int]]:
    """Each field of owner (named as in the code, without its leading underscore) and
    what only it holds, largest first."""
    counted.add_if_new(id(owner))
    sizes = [(name.lstrip("_"), _deep_size(value, counted)) for name, value in vars(owner).items()]
    return sorted(sizes, key=lambda field: -field[1])


def measure_memory_breakdown() -> dict[str, object]:
    """Each part's size in bytes, in the order counted, and how long measuring took.
    The caller holds the lock every write holds."""
    started = time.perf_counter()
    counted = _PackedIdSet()
    parts: list[dict[str, object]] = []
    for part in _PARTS:
        with part.lock():
            roots = part.roots()
            fields: list[tuple[str, int]] = []
            if part.lists_fields:
                assert len(roots) == 1, f"{part.label} lists the fields of one object"
                fields = _field_sizes(roots[0], counted)
                # The object and its table of fields, then what each field holds.
                size = sys.getsizeof(roots[0]) + sys.getsizeof(vars(roots[0])) + sum(size for _, size in fields)
            else:
                size = sum(_deep_size(root, counted) for root in roots)
        parts.append({
            "label": part.label,
            "bytes": size,
            "fields": [{"label": label, "bytes": field_size} for label, field_size in fields],
        })
    return {"parts": parts, "seconds": time.perf_counter() - started}
