from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace
from typing import Iterable, Mapping, Optional, List

from app.services.note_store import store as _note_store
from app.services.note_store import NoteRecord as NodeRecord


class _AdapterStore:
    """Adapter exposing the legacy store API on top of NoteStore.

    This keeps existing usecases working while consolidating on the
    canonical NoteStore implementation.
    """

    @property
    def loaded(self) -> bool:
        return _note_store.loaded

    # Reads -----------------------------------------------------------------
    def get(self, note_id: str) -> NodeRecord:
        return _note_store.get_note(note_id)

    def contains(self, note_id: str) -> bool:
        return _note_store.has_note(note_id)

    def children(self, parent_id: Optional[str]) -> List[str]:
        return _note_store.get_children(parent_id)

    # Mutations --------------------------------------------------------------
    def insert_after(self, note: NodeRecord, parent_id: Optional[str], prev_id: Optional[str]) -> None:
        # Compute next_id based on current links for the parent
        if prev_id is None:
            ids = _note_store.get_children(parent_id)
            next_id = None
            if ids:
                next_id = ids[0]
        else:
            previous = _note_store.get_note(prev_id)
            assert previous.parent_id == parent_id
            next_id = previous.next_id

        row = SimpleNamespace(
            id=note.id,
            parent_id=parent_id,
            prev_id=prev_id,
            next_id=next_id,
            is_collapsed=bool(getattr(note, 'is_collapsed', False)),
            created_at=getattr(note, 'created_at', None),
            updated_at=getattr(note, 'updated_at', None),
        )
        assert isinstance(note.content, str)
        assert isinstance(note.tags, str)
        assert isinstance(note.proposed_tags, str)
        _note_store.add_note_from_db(row, note.content, note.tags, note.proposed_tags)

    def update_content_and_tags(
        self,
        note_id: str,
        new_content: str,
        tags: str,
        *,
        updated_at: datetime,
    ) -> None:
        proposed_tags = _note_store.get_note(note_id).proposed_tags
        self.update_note_sources(
            note_id,
            new_content,
            tags,
            proposed_tags,
            updated_at=updated_at,
        )

    def update_note_sources(
        self,
        note_id: str,
        new_content: str,
        tags: str,
        proposed_tags: str,
        *,
        updated_at: datetime,
    ) -> None:
        row = SimpleNamespace(id=note_id, updated_at=updated_at)
        _note_store.update_note_from_db(row, new_content, tags, proposed_tags)

    def update_tag_sources(
        self,
        note_id: str,
        tags: str,
        proposed_tags: str,
        *,
        updated_at: datetime,
    ) -> None:
        record = _note_store.get_note(note_id)
        self.update_note_sources(
            note_id,
            record.content,
            tags,
            proposed_tags,
            updated_at=updated_at,
        )

    def delete_subtree(self, note_id: str) -> None:
        _note_store.remove_note(note_id)

    def restore_subtree(self, records: List[NodeRecord]) -> None:
        # Preorder restoration can reference a sibling restored later in this batch.
        pending_ids = {record.id for record in records}
        for rec in records:
            pending_ids.remove(rec.id)
            next_id = rec.next_id
            if next_id in pending_ids:
                next_id = None
            row = SimpleNamespace(
                id=rec.id,
                parent_id=rec.parent_id,
                prev_id=rec.prev_id,
                next_id=next_id,
                is_collapsed=bool(rec.is_collapsed),
                created_at=rec.created_at,
                updated_at=rec.updated_at,
            )
            assert isinstance(rec.content, str)
            assert isinstance(rec.tags, str)
            assert isinstance(rec.proposed_tags, str)
            _note_store.add_note_from_db(row, rec.content, rec.tags, rec.proposed_tags)

    def move_note(self, note_id: str, new_parent_id: Optional[str], prev_id: Optional[str]) -> None:
        # Determine next based on prev in destination parent
        if prev_id is None:
            ids = _note_store.get_children(new_parent_id)
            next_id = None
            if ids:
                next_id = ids[0]
        else:
            previous = _note_store.get_note(prev_id)
            assert previous.parent_id == new_parent_id
            next_id = previous.next_id

        row = SimpleNamespace(
            id=note_id,
            parent_id=new_parent_id,
            prev_id=prev_id,
            next_id=next_id,
        )
        _note_store.update_metadata_from_db(row, rebuild=False)

    def bulk_update_metadata(self, notes: Iterable[SimpleNamespace], *, rebuild: bool) -> None:
        _note_store.bulk_update_metadata(notes, rebuild=rebuild)

    def set_collapsed(self, note_id: str, collapsed: bool) -> None:
        _note_store.set_collapsed(note_id, bool(collapsed))


# Public adapter instance
store = _AdapterStore()


def hydrate_from_prefetched(rows: Iterable[Mapping[str, object]], *, get_plaintext) -> None:  # noqa: ARG001
    # Canonical NoteStore can load from prefetched rows using the decrypted cache.
    _note_store.load_from_db(None, prefetched_rows=list(rows))
