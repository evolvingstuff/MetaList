"""Sibling indexes derived from immutable note records, the sole pointer authority."""

from dataclasses import replace
from typing import Mapping, Protocol, TypeVar


Record = TypeVar('Record', bound='OrderedNote')


class OrderedNote(Protocol):
    id: str
    parent_id: str | None
    prev_id: str | None
    next_id: str | None


class NoteOrdering:
    """Caller holds the NoteStore lock for every read or mutation."""

    def __init__(self) -> None:
        self.heads: dict[str | None, str] = {}
        self.tails: dict[str | None, str] = {}

    @classmethod
    def from_records(cls, records: Mapping[str, OrderedNote]) -> 'NoteOrdering':
        index = cls()
        counts: dict[str | None, int] = {}
        for note in records.values():
            parent = note.parent_id
            if parent not in counts:
                counts[parent] = 0
            counts[parent] += 1
            if note.prev_id is None:
                if parent in index.heads:
                    raise RuntimeError('Ordering has multiple sibling heads')
                index.heads[parent] = note.id
            if note.next_id is None:
                if parent in index.tails:
                    raise RuntimeError('Ordering has multiple sibling tails')
                index.tails[parent] = note.id
        for parent, count in counts.items():
            if parent not in index.heads or parent not in index.tails:
                raise RuntimeError('Ordering contains a cycle or has no boundary')
            if len(index.children(records, parent)) != count:
                raise RuntimeError('Ordering contains disconnected siblings')
        return index

    def children(self, records: Mapping[str, OrderedNote], parent: str | None) -> list[str]:
        if parent not in self.heads:
            return []
        current = self.heads[parent]
        previous = None
        visited = set()
        ordered = []
        while current is not None:
            if current in visited:
                raise RuntimeError('Cycle in sibling ordering')
            visited.add(current)
            note = records[current]
            if note.parent_id != parent or note.prev_id != previous:
                raise RuntimeError('Ordering has inconsistent parent or sibling links')
            ordered.append(current)
            previous, current = current, note.next_id
        if previous != self.tails[parent]:
            raise RuntimeError('Ordering has an inconsistent tail')
        return ordered

    def insert(self, records: dict[str, Record], note: Record, *,
               prev_id: str | None, next_id: str | None) -> None:
        parent = note.parent_id
        if prev_id is None and next_id is None and parent in self.tails:
            # An unanchored new sibling is explicitly appended to its parent.
            prev_id = self.tails[parent]
        if prev_id is not None:
            previous = records[prev_id]
            assert previous.parent_id == parent and previous.id != note.id
            if next_id is None:
                next_id = previous.next_id
        if next_id is not None:
            following = records[next_id]
            assert following.parent_id == parent and following.id != note.id
            if prev_id is None:
                prev_id = following.prev_id
        if prev_id is not None:
            assert records[prev_id].next_id == next_id, 'Insertion anchors must be adjacent'
        if next_id is not None:
            assert records[next_id].prev_id == prev_id, 'Insertion anchors must be adjacent'
        records[note.id] = replace(note, prev_id=prev_id, next_id=next_id)
        if prev_id is None:
            self.heads[parent] = note.id
        else:
            records[prev_id] = replace(records[prev_id], next_id=note.id)
        if next_id is None:
            self.tails[parent] = note.id
        else:
            records[next_id] = replace(records[next_id], prev_id=note.id)
        self.validate_neighbors(records, note.id)

    def remove(self, records: dict[str, Record], note: Record) -> None:
        parent, previous, following = note.parent_id, note.prev_id, note.next_id
        if previous is None:
            assert self.heads[parent] == note.id
            if following is None:
                del self.heads[parent], self.tails[parent]
            else:
                self.heads[parent] = following
        else:
            assert records[previous].next_id == note.id
            records[previous] = replace(records[previous], next_id=following)
        if following is None:
            if previous is not None:
                assert self.tails[parent] == note.id
                self.tails[parent] = previous
        else:
            assert records[following].prev_id == note.id
            records[following] = replace(records[following], prev_id=previous)
        if previous is not None:
            self.validate_neighbors(records, previous)
        if following is not None:
            self.validate_neighbors(records, following)

    def validate_neighbors(self, records: Mapping[str, OrderedNote], note_id: str) -> None:
        note = records[note_id]
        if note.prev_id is None:
            assert self.heads[note.parent_id] == note.id
        else:
            previous = records[note.prev_id]
            assert previous.parent_id == note.parent_id and previous.next_id == note.id
        if note.next_id is None:
            assert self.tails[note.parent_id] == note.id
        else:
            following = records[note.next_id]
            assert following.parent_id == note.parent_id and following.prev_id == note.id
