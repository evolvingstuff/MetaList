from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

from app.usecases.base import QueryCommand
from app.services.store import store, NodeRecord
from app.services.document_references import clone_clipboard_documents
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

    def describe(self) -> str:
        return f"CmdPasteChild(target={self.target_note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        snapshot = get_clipboard(self.client_id)
        if not snapshot:
            return {"status": "clipboard_empty"}
        snapshot = clone_clipboard_documents(snapshot)

        target = store.get(self.target_note_id)
        children = store.children(target.id)
        prev_id = None
        new_root_id = _insert_cloned_subtree_at(
            snapshot,
            target.id,
            prev_id,
            self.token,
            search_query=self.search_query,
        )

        new_ids = _collect_subtree_ids(new_root_id)
        records: List[NodeRecord] = [store.get(nid) for nid in new_ids]
        record_paste(self.client_id, self.undo_context, records, viewport=self.viewport)

        return {"status": "pasted", "id": new_root_id, "updateUUID": generate_new_uuid()}
