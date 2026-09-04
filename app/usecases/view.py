from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple, Dict, List

from app.usecases.base import QueryCommand
from app.services.snapshot import build_view_snapshot


@dataclass
class CmdView(QueryCommand):
    client_id: str
    editing_note_id: Optional[str]
    search: Optional[str]

    def describe(self) -> str:
        return f"CmdView(client={self.client_id}, editing={self.editing_note_id})"

    def execute(self) -> Tuple[List[Dict[str, object]], Dict[str, Dict[str, object]], Dict[str, str]]:
        return build_view_snapshot(
            editing_note_id=self.editing_note_id,
            search=self.search,
            sort_mode="normal",
            client_known_note_ids=None,
            client_seen_root_ids=None,
            anchor_root_id=None,
            is_untagged_view=False,
        )
