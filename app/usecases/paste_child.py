from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

from app.usecases.base import QueryCommand
from app.services.store import store, NodeRecord
from app.services.sync import get_clipboard, generate_new_uuid
from app.usecases.paste_sibling import _insert_cloned_subtree_at
from app.usecases.delete_subtree import _collect_subtree_ids
from app.services.undo_state import record_paste


@dataclass
class CmdPasteChild(QueryCommand):
    target_note_id: str
    search_query: str | None
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, str]:
        snapshot = get_clipboard(self.client_id)
        if not snapshot:
            return {"status": "clipboard_empty"}
        return paste_snapshot_as_child(
            snapshot=snapshot,
            target_note_id=self.target_note_id,
            search_query=self.search_query,
            token=self.token,
            client_id=self.client_id,
            undo_context=self.undo_context,
            viewport=self.viewport,
        )


def paste_snapshot_as_child(
    *,
    snapshot: List[dict],
    target_note_id: str,
    search_query: str | None,
    token: str,
    client_id: str,
    undo_context: str,
    viewport: Dict[str, object],
) -> Dict[str, str]:
    """Pastes the notes as the target note's first child."""
    assert snapshot, "paste_snapshot_as_child requires notes to paste"
    target = store.get(target_note_id)
    new_root_id = _insert_cloned_subtree_at(
        snapshot,
        target.id,
        None,
        token,
        search_query=search_query,
    )

    new_ids = _collect_subtree_ids(new_root_id)
    records: List[NodeRecord] = [store.get(nid) for nid in new_ids]
    record_paste(client_id, undo_context, records, viewport=viewport)

    return {"status": "pasted", "id": new_root_id, "updateUUID": generate_new_uuid()}
