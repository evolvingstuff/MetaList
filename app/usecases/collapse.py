from __future__ import annotations

from dataclasses import dataclass
from typing import Dict
import os

from app.usecases.base import QueryCommand
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.embedded_references import resolve_held_source

from app.db.session import begin_writer
from app.db.notes_sql import update_links_preserving_updated_at as db_update_links_preserving_updated_at


def shown_collapse_note_id(note_id: str) -> str:
    """The note whose collapse a note shows: its source when it is only a
    reference (docs/ui/references.md), otherwise itself."""
    return resolve_held_source(note_id, has_note=store.contains, content_of=lambda held_id: store.get(held_id).content)


def is_shown_collapsed(note_id: str) -> bool:
    return bool(store.get(shown_collapse_note_id(note_id)).is_collapsed)


def apply_set_collapse_bulk(note_ids: list[str], collapsed: bool) -> None:
    if not isinstance(note_ids, list) or len(note_ids) == 0:
        raise TypeError("note_ids must be a non-empty list")
    for note_id in note_ids:
        if not isinstance(note_id, str) or not note_id:
            raise TypeError("note_ids must contain non-empty strings")

    # A note that is only a reference folds as its source: collapsing it
    # collapses the source everywhere, and the note's own children with it.
    targets: list[str] = []
    for note_id in note_ids:
        for target in (note_id, shown_collapse_note_id(note_id)):
            if target not in targets:
                targets.append(target)
    write_note_collapse(targets, bool(collapsed))


def write_note_collapse(note_ids: list[str], collapsed: bool) -> None:
    """Saves these notes' own collapse flags, and nothing else (a paste
    restoring copied notes as they were must not fold an embed's source)."""
    if not isinstance(note_ids, list) or len(note_ids) == 0:
        raise TypeError("note_ids must be a non-empty list")
    with begin_writer() as connection:
        for note_id in note_ids:
            db_update_links_preserving_updated_at(connection, note_id, is_collapsed=bool(collapsed))
    for note_id in note_ids:
        store.set_collapsed(note_id, bool(collapsed))


def apply_set_collapse(note_id: str, collapsed: bool) -> None:
    apply_set_collapse_bulk([note_id], collapsed)


@dataclass
class CmdCollapse(QueryCommand):
    note_id: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdCollapse(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        before = is_shown_collapsed(self.note_id)
        if before is True:
            # unchanged
            return {"status": "unchanged", "updateUUID": generate_new_uuid()}
        apply_set_collapse(self.note_id, True)
        after = is_shown_collapsed(self.note_id)
        if after is not True:
            print(f"FATAL: collapse failed for {self.note_id}")
            os._exit(1)

        # record undo
        # Deferred: undo_state imports this module's apply function to replay operations.
        from app.services.undo_state import record_collapse
        record_collapse(
            self.client_id,
            self.undo_context,
            self.note_id,
            before=before,
            after=True,
            viewport=self.viewport,
        )

        return {"status": "updated", "updateUUID": generate_new_uuid()}
