"""One shared copy of each distinct per-note tag set.

Notes inherit their tags, so siblings and whole subtrees carry equal sets; built note by
note, each held its own copy. The search index and the note store keep theirs in these
columns (lists by note number) and maps (dicts by note id), whose every write takes the
shared copy and gives the replaced one back, so no write can skip the sharing and no
copy outlives its last use.
"""

from __future__ import annotations

from typing import Dict, FrozenSet, List, Set


class SharedSets:
    """One copy of each distinct frozenset a structure's per-note columns and maps hold,
    and how many slots use it. Notes that inherit the same tags hold the same set, and
    a lowercased set equal to its original is that set; a copy goes with its last use."""

    def __init__(self) -> None:
        self._copies: Dict[FrozenSet[str], FrozenSet[str]] = {}
        self._uses: Dict[FrozenSet[str], int] = {}

    def take(self, value: FrozenSet[str]) -> FrozenSet[str]:
        assert isinstance(value, frozenset), "shared sets hold frozensets"
        if value in self._copies:
            copy = self._copies[value]
            self._uses[copy] += 1
            return copy
        self._copies[value] = value
        self._uses[value] = 1
        return value

    def give_back(self, copy: FrozenSet[str]) -> None:
        assert self._copies[copy] is copy, "only a shared copy is given back"
        remaining = self._uses[copy] - 1
        if remaining == 0:
            del self._uses[copy]
            del self._copies[copy]
            return
        self._uses[copy] = remaining

    def distinct_sets(self) -> Set[FrozenSet[str]]:
        return set(self._copies)


class SharedSetColumn:
    """A per-note list of frozensets whose every write takes a shared copy and gives the
    replaced one back, so no write can skip the sharing."""

    def __init__(self, shared: SharedSets) -> None:
        self._shared = shared
        self._items: List[FrozenSet[str]] = []

    def __getitem__(self, note_int_id: int) -> FrozenSet[str]:
        return self._items[note_int_id]

    def __setitem__(self, note_int_id: int, value: FrozenSet[str]) -> None:
        replaced = self._items[note_int_id]
        # Taken before the old one is given back: an equal value keeps its copy alive.
        self._items[note_int_id] = self._shared.take(value)
        self._shared.give_back(replaced)

    def append(self, value: FrozenSet[str]) -> None:
        self._items.append(self._shared.take(value))

    def clear(self) -> None:
        for value in self._items:
            self._shared.give_back(value)
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)


class SharedSetMap:
    """A per-note dict of frozensets whose every write takes a shared copy and gives the
    replaced one back (SharedSetColumn, keyed by note id)."""

    def __init__(self, shared: SharedSets) -> None:
        self._shared = shared
        self._items: Dict[str, FrozenSet[str]] = {}

    def __getitem__(self, note_id: str) -> FrozenSet[str]:
        return self._items[note_id]

    def __contains__(self, note_id: object) -> bool:
        return note_id in self._items

    def __setitem__(self, note_id: str, value: FrozenSet[str]) -> None:
        copy = self._shared.take(value)
        if note_id in self._items:
            self._shared.give_back(self._items[note_id])
        self._items[note_id] = copy

    def __delitem__(self, note_id: str) -> None:
        self._shared.give_back(self._items.pop(note_id))

    def clear(self) -> None:
        for value in self._items.values():
            self._shared.give_back(value)
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)
