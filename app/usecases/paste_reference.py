"""Pasting a copied note's reference where the note itself would paste.

The reference is a new note holding [[UUID]] (an embed: its only content): below the target (or filling it
when it is empty with no children), or as its first child, exactly as
CmdPasteSibling and CmdPasteChild place a copy.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

from app.services.store import store
from app.usecases.base import QueryCommand
from app.usecases.paste_child import paste_snapshot_as_child
from app.usecases.paste_sibling import paste_snapshot_as_sibling


def reference_snapshot(reference_note_id: str) -> List[dict]:
    """One note whose text is the reference, in the clipboard's snapshot shape."""
    if not isinstance(reference_note_id, str) or reference_note_id == "":
        raise TypeError("reference_note_id must be a non-empty string")
    return [{
        "id": reference_note_id,
        "parent_id": None,
        "content": f"<div>[[{reference_note_id}]]</div>",
        "tags": "",
        "proposed_tags": "",
    }]


@dataclass
class CmdPasteReferenceSibling(QueryCommand):
    target_note_id: str
    reference_note_id: str
    search_query: str | None
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdPasteReferenceSibling(target={self.target_note_id}, reference={self.reference_note_id})"

    def execute(self) -> Dict[str, str]:
        # The copied note was deleted since: the same answer as an expired clipboard.
        if not store.contains(self.reference_note_id):
            return {"status": "clipboard_empty"}
        return paste_snapshot_as_sibling(
            snapshot=reference_snapshot(self.reference_note_id),
            target_note_id=self.target_note_id,
            search_query=self.search_query,
            token=self.token,
            client_id=self.client_id,
            undo_context=self.undo_context,
            viewport=self.viewport,
        )


@dataclass
class CmdPasteReferenceChild(QueryCommand):
    target_note_id: str
    reference_note_id: str
    search_query: str | None
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdPasteReferenceChild(target={self.target_note_id}, reference={self.reference_note_id})"

    def execute(self) -> Dict[str, str]:
        if not store.contains(self.reference_note_id):
            return {"status": "clipboard_empty"}
        return paste_snapshot_as_child(
            snapshot=reference_snapshot(self.reference_note_id),
            target_note_id=self.target_note_id,
            search_query=self.search_query,
            token=self.token,
            client_id=self.client_id,
            undo_context=self.undo_context,
            viewport=self.viewport,
        )
