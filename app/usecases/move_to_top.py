from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from app.services.snapshot import resolve_search_scope
from app.services.store import store
from app.services.sync import generate_new_uuid
from app.services.undo_state import record_move
from app.usecases.base import QueryCommand
from app.usecases.move import _assert_neighbors, _neighbors, apply_move


def _resolve_search_root_ids(note_id: str, search_query: Optional[str]) -> List[str]:
    if search_query is not None and not isinstance(search_query, str):
        raise TypeError(f"search_query must be a string or None, got {type(search_query)}")

    if not isinstance(search_query, str) or search_query.strip() == "":
        root_ids = store.children(None)
        if note_id not in root_ids:
            raise RuntimeError(
                "Integrity failure: move-to-top root missing from root list: "
                f"note_id={note_id}"
            )
        return root_ids

    search_scope = resolve_search_scope(
        search=search_query,
        editing_note_id=None,
        sort_mode="normal",
        ordered_root_ids=None,
    )
    root_ids = search_scope.search_root_ids_ordered
    if root_ids is None:
        raise RuntimeError("Search scope for move-to-top roots must provide ordered root ids")
    if note_id not in root_ids:
        raise RuntimeError(
            "Integrity failure: move-to-top root missing from visible search roots: "
            f"note_id={note_id} search_query={search_query!r}"
        )
    return root_ids


def _resolve_bottom_destination(note_id: str, parent_id: Optional[str], search_query: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """The (prev, next) placing the note after its last sibling, or after the last
    root this view shows (a search shows only matching roots). (None, None) when it
    is already there."""
    if parent_id is not None:
        sibling_ids = store.children(parent_id)
        if note_id not in sibling_ids:
            raise RuntimeError(
                "Integrity failure: move-to-bottom target missing from siblings list: "
                f"note_id={note_id} parent_id={parent_id}"
            )
        last_id = sibling_ids[-1]
        if last_id == note_id:
            return None, None
        return last_id, None

    visible_root_ids = _resolve_search_root_ids(note_id, search_query)
    last_visible_root_id = visible_root_ids[-1]
    if last_visible_root_id == note_id:
        return None, None

    last_parent_id, _, last_next_id = _neighbors(last_visible_root_id)
    if last_parent_id is not None:
        raise RuntimeError(
            "Integrity failure: expected visible search root to be a root note: "
            f"note_id={last_visible_root_id} parent_id={last_parent_id}"
        )
    assert last_next_id != note_id, "the last visible root cannot precede the visible note being moved"
    return last_visible_root_id, last_next_id


def _resolve_destination(note_id: str, parent_id: Optional[str], search_query: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    if parent_id is not None:
        sibling_ids = store.children(parent_id)
        if note_id not in sibling_ids:
            raise RuntimeError(
                "Integrity failure: move-to-top target missing from siblings list: "
                f"note_id={note_id} parent_id={parent_id}"
            )
        first_id = sibling_ids[0]
        if first_id == note_id:
            return None, None
        return None, first_id

    visible_root_ids = _resolve_search_root_ids(note_id, search_query)
    first_visible_root_id = visible_root_ids[0]
    if first_visible_root_id == note_id:
        return None, None

    first_parent_id, first_prev_id, _ = _neighbors(first_visible_root_id)
    if first_parent_id is not None:
        raise RuntimeError(
            "Integrity failure: expected visible search root to be a root note: "
            f"note_id={first_visible_root_id} parent_id={first_parent_id}"
        )
    return first_prev_id, first_visible_root_id


@dataclass
class CmdMoveToTop(QueryCommand):
    note_id: str
    search_query: Optional[str]
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdMoveToTop(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        record = store.get(self.note_id)
        parent_id = record.parent_id
        dest_prev, dest_next = _resolve_destination(self.note_id, parent_id, self.search_query)
        if dest_next is None:
            return {"status": "noop"}
        return _move_to(self.note_id, record.parent_id, record.tags, dest_prev, dest_next, self.client_id, self.undo_context, self.viewport)


@dataclass
class CmdMoveToBottom(QueryCommand):
    note_id: str
    search_query: Optional[str]
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdMoveToBottom(note={self.note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        record = store.get(self.note_id)
        dest_prev, dest_next = _resolve_bottom_destination(self.note_id, record.parent_id, self.search_query)
        if dest_prev is None:
            return {"status": "noop"}
        return _move_to(self.note_id, record.parent_id, record.tags, dest_prev, dest_next, self.client_id, self.undo_context, self.viewport)


def _move_to(
    note_id: str,
    parent_id: Optional[str],
    tags: object,
    dest_prev: Optional[str],
    dest_next: Optional[str],
    client_id: str,
    undo_context: str,
    viewport: Dict[str, object],
) -> Dict[str, str]:
    """Move the note between dest_prev and dest_next under its own parent, as one undo step."""
    before_parent, before_prev, before_next = _neighbors(note_id)
    if not isinstance(tags, str):
        raise RuntimeError(f"Note tags must be a string | note_id={note_id}")
    before_tags = tags
    after_tags = tags

    dest_parent = parent_id

    apply_move(note_id, dest_parent, dest_prev, dest_next)
    _assert_neighbors(note_id, dest_parent, dest_prev, dest_next)

    record_move(
        client_id,
        undo_context,
        note_id,
        before_parent=before_parent,
        before_prev=before_prev,
        before_next=before_next,
        before_tags=before_tags,
        after_parent=dest_parent,
        after_prev=dest_prev,
        after_next=dest_next,
        after_tags=after_tags,
        viewport=viewport,
    )

    update_uuid = generate_new_uuid()
    return {"status": "moved", "updateUUID": update_uuid}
