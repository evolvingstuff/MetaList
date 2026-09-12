from __future__ import annotations

import logging
import os
from types import SimpleNamespace
from typing import Dict, List, Optional

from app.usecases.collapse import apply_set_collapse
from app.usecases.delete_subtree import apply_delete_subtree, apply_restore_records
from app.usecases.move import apply_move
from app.usecases.update_content import apply_update_content, apply_update_note_sources
from app.services.store import store, NodeRecord
from app.services.sync import generate_new_uuid


logger = logging.getLogger(__name__)


def _summarize_op(op: dict) -> str:
    if not isinstance(op, dict):
        raise TypeError(f"Undo op must be a dict, got {type(op)}")
    if "type" not in op:
        raise RuntimeError(f"Undo op missing required key 'type' | op={op}")

    op_type = op["type"]
    if not isinstance(op_type, str) or not op_type:
        raise RuntimeError(f"Undo op type must be a non-empty string | op={op}")

    if op_type in {
        "update_content",
        "tag_sources",
        "move",
        "collapse",
        "paste_into",
        "split_note",
    }:
        note_id = op["note_id"]
        if not isinstance(note_id, str) or not note_id:
            raise RuntimeError(f"Undo op {op_type}.note_id must be a non-empty string | op={op}")
        return f"{op_type}({note_id})"

    if op_type == "move_batch":
        moves = op["moves"]
        if not isinstance(moves, list) or len(moves) == 0:
            raise RuntimeError(f"Undo op move_batch.moves must be a non-empty list | op={op}")
        first = moves[0]
        if not isinstance(first, dict):
            raise RuntimeError(f"Undo op move_batch.moves[0] must be a dict | op={op}")
        note_id = first["note_id"]
        if not isinstance(note_id, str) or not note_id:
            raise RuntimeError(f"Undo op move_batch.moves[0].note_id must be a non-empty string | op={op}")
        return f"move_batch({len(moves)}:{note_id})"

    if op_type == "create_note":
        record = op["record"]
        if not isinstance(record, dict):
            raise RuntimeError(f"Undo op create_note.record must be a dict | op={op}")
        if "id" not in record:
            raise RuntimeError(f"Undo op create_note.record missing id | op={op}")
        created_id = record["id"]
        if not isinstance(created_id, str) or not created_id:
            raise RuntimeError(
                f"Undo op create_note.record.id must be a non-empty string | op={op}"
            )
        return f"create_note({created_id})"

    if op_type in {"delete_subtree", "paste_subtree"}:
        records = op["records"]
        if not isinstance(records, list) or not records:
            raise RuntimeError(f"Undo op {op_type}.records must be a non-empty list | op={op}")
        root_id = records[0].id
        if not isinstance(root_id, str) or not root_id:
            raise RuntimeError(f"Undo op {op_type}.records[0].id must be a non-empty string | op={op}")
        return f"{op_type}({root_id})"

    return op_type


def _summarize_stack(ops: List[dict], max_items: int) -> str:
    if not isinstance(max_items, int) or max_items <= 0:
        raise ValueError("max_items must be a positive integer")
    start = max(0, len(ops) - max_items)
    return "[" + ", ".join(_summarize_op(op) for op in ops[start:]) + "]"


def _normalize_viewport_snapshot(viewport: Dict[str, object]) -> Dict[str, object]:
    if not isinstance(viewport, dict):
        raise ValueError("viewport must be an object")
    if "scrollY" not in viewport:
        raise ValueError("viewport.scrollY is required")
    scroll_y = viewport["scrollY"]
    if not isinstance(scroll_y, int) or scroll_y < 0:
        raise ValueError("viewport.scrollY must be a non-negative integer")

    if "scrollAnchor" not in viewport:
        raise ValueError("viewport.scrollAnchor is required")
    scroll_anchor = viewport["scrollAnchor"]
    normalized_scroll_anchor: Optional[Dict[str, object]] = None
    if scroll_anchor is not None:
        if not isinstance(scroll_anchor, dict):
            raise ValueError("viewport.scrollAnchor must be an object or null")

        if "anchorId" not in scroll_anchor:
            raise ValueError("viewport.scrollAnchor.anchorId is required")
        if "anchorBias" not in scroll_anchor:
            raise ValueError("viewport.scrollAnchor.anchorBias is required")
        if "intraOffset" not in scroll_anchor:
            raise ValueError("viewport.scrollAnchor.intraOffset is required")
        if "beltPrev" not in scroll_anchor:
            raise ValueError("viewport.scrollAnchor.beltPrev is required")
        if "beltNext" not in scroll_anchor:
            raise ValueError("viewport.scrollAnchor.beltNext is required")
        if "anchorSortKey" not in scroll_anchor:
            raise ValueError("viewport.scrollAnchor.anchorSortKey is required")

        anchor_id = scroll_anchor["anchorId"]
        anchor_bias = scroll_anchor["anchorBias"]
        intra_offset = scroll_anchor["intraOffset"]
        belt_prev = scroll_anchor["beltPrev"]
        belt_next = scroll_anchor["beltNext"]
        anchor_sort_key = scroll_anchor["anchorSortKey"]

        if not isinstance(anchor_id, str) or not anchor_id:
            raise ValueError("viewport.scrollAnchor.anchorId must be a non-empty string")
        if anchor_bias not in ("center", "top"):
            raise ValueError("viewport.scrollAnchor.anchorBias must be 'center' or 'top'")
        if not isinstance(intra_offset, int) or intra_offset < 0:
            raise ValueError("viewport.scrollAnchor.intraOffset must be a non-negative integer")
        if not isinstance(belt_prev, list) or not isinstance(belt_next, list):
            raise ValueError("viewport.scrollAnchor belt arrays must be lists")

        def _normalize_belt(payload: List[object]) -> List[str]:
            return [entry for entry in payload if isinstance(entry, str) and entry]

        normalized_prev = _normalize_belt(belt_prev)
        normalized_next = _normalize_belt(belt_next)

        if not isinstance(anchor_sort_key, dict):
            raise ValueError("viewport.scrollAnchor.anchorSortKey must be an object")
        if "domIndex" not in anchor_sort_key:
            raise ValueError("viewport.scrollAnchor.anchorSortKey.domIndex is required")
        dom_index = anchor_sort_key["domIndex"]
        if not isinstance(dom_index, int) or dom_index < 0:
            raise ValueError("viewport.scrollAnchor.anchorSortKey.domIndex must be a non-negative integer")

        normalized_scroll_anchor = {
            "anchorId": anchor_id,
            "anchorBias": anchor_bias,
            "intraOffset": intra_offset,
            "beltPrev": normalized_prev,
            "beltNext": normalized_next,
            "anchorSortKey": {"domIndex": dom_index},
        }

    return {"scrollY": scroll_y, "scrollAnchor": normalized_scroll_anchor}


def _anchor_root_id(viewport: Dict[str, object]) -> Optional[str]:
    scroll_anchor = viewport["scrollAnchor"]
    if not isinstance(scroll_anchor, dict):
        return None
    if "anchorId" not in scroll_anchor:
        return None
    anchor_id = scroll_anchor["anchorId"]
    if isinstance(anchor_id, str) and anchor_id:
        return anchor_id
    return None


def _root_ancestor_id(note_id: str) -> str:
    current = store.get(note_id)
    while current.parent_id:
        current = store.get(current.parent_id)
    return current.id


def _pick_focus_neighbor(prev_id: Optional[str], next_id: Optional[str]) -> str:
    for candidate in (next_id, prev_id):
        if isinstance(candidate, str) and candidate:
            return candidate
    return ""


def _compute_focus_note_id(op: dict, *, direction: str) -> str:
    if "type" not in op:
        raise RuntimeError(f"Redo op missing required key: type | op={op}")
    op_type = op["type"]

    if op_type in {
        "update_content",
        "tag_sources",
        "move",
        "collapse",
        "paste_into",
        "split_note",
    }:
        if "note_id" not in op:
            raise RuntimeError(f"Undo op missing required key: note_id | op={op}")
        note_id = op["note_id"]
        if not isinstance(note_id, str) or not note_id:
            raise RuntimeError(f"Undo op note_id must be a non-empty string | op={op}")
        return note_id

    if op_type == "move_batch":
        moves = op["moves"]
        if not isinstance(moves, list) or len(moves) == 0:
            raise RuntimeError(f"Undo op move_batch.moves must be a non-empty list | op={op}")
        first = moves[0]
        if not isinstance(first, dict):
            raise RuntimeError(f"Undo op move_batch.moves[0] must be a dict | op={op}")
        note_id = first["note_id"]
        if not isinstance(note_id, str) or not note_id:
            raise RuntimeError(f"Undo op move_batch.moves[0].note_id must be a non-empty string | op={op}")
        return note_id

    if op_type == "create_note":
        record = op["record"]
        if not isinstance(record, dict):
            raise RuntimeError(f"Undo op create_note.record must be an object | op={op}")
        if "id" not in record:
            raise RuntimeError(f"Undo op create_note.record missing id | op={op}")
        created_id = record["id"]
        if direction == "redo" and isinstance(created_id, str):
            return created_id
        if "parent_id" not in record:
            raise RuntimeError(f"Undo op create_note.record missing parent_id | op={op}")

        if not isinstance(created_id, str) or not created_id:
            raise RuntimeError(f"Undo op create_note.record.id must be a non-empty string | op={op}")
        parent_id = record["parent_id"]

        if "prev_id" not in record:
            raise RuntimeError(f"Undo op create_note.record missing prev_id | op={op}")
        prev_id = record["prev_id"]
        if prev_id is not None and not isinstance(prev_id, str):
            raise RuntimeError(f"Undo op create_note.record.prev_id must be a string or null | op={op}")

        if prev_id is not None and not isinstance(prev_id, str):
            raise RuntimeError(f"Undo op create_note.record.prev_id must be a string or null | op={op}")
        if parent_id is not None and not isinstance(parent_id, str):
            raise RuntimeError(f"Undo op create_note.record.parent_id must be a string or null | op={op}")

        # Undoing a create should usually return focus to:
        # - the reference note (sibling creation): prev_id is set
        # - the parent note (child creation): parent_id is set and prev_id is null
        # - nothing (root creation from empty selection): parent_id is null and prev_id is null
        if isinstance(prev_id, str) and prev_id:
            return prev_id
        if isinstance(parent_id, str) and parent_id:
            logger.info(
                "undo.create_note focus parent: created_id=%s parent_id=%s",
                created_id,
                parent_id,
            )
            return parent_id
        return ""

    if op_type in {"delete_subtree", "paste_subtree"}:
        records = op["records"]
        if not isinstance(records, list) or not records:
            raise RuntimeError(f"Undo op {op_type}.records must be a non-empty list | op={op}")
        first = records[0]
        root_id = getattr(first, "id", None)
        if root_id is None:
            raise RuntimeError(f"Undo op {op_type}.records[0] missing id | op={op}")
        if not isinstance(root_id, str) or not root_id:
            raise RuntimeError(f"Undo op {op_type}.records[0].id must be a non-empty string | op={op}")
        if direction == "redo" and op_type == "delete_subtree":
            return _pick_focus_neighbor(getattr(first, "prev_id", None), getattr(first, "next_id", None))
        if direction == "undo" and op_type == "paste_subtree":
            prev_id = getattr(first, "prev_id", None)
            if isinstance(prev_id, str) and prev_id:
                return prev_id
            parent_id = getattr(first, "parent_id", None)
            if isinstance(parent_id, str) and parent_id:
                return parent_id
            next_id = getattr(first, "next_id", None)
            if isinstance(next_id, str) and next_id:
                return next_id
            return ""
        return root_id

    return ""


class _ClientUndo:
    __slots__ = ("history", "redo", "last_undo_context")

    def __init__(self) -> None:
        self.history: List[dict] = []
        self.redo: List[dict] = []
        self.last_undo_context: str = ""


_clients: Dict[str, _ClientUndo] = {}


def capture_undo_state() -> dict:
    # Operations are immutable once recorded; only the stack lists change.
    return {key: (list(value.history), list(value.redo), value.last_undo_context)
            for key, value in _clients.items()}


def restore_undo_state(snapshot: dict) -> None:
    _clients.clear()
    for key, (history, redo, context) in snapshot.items():
        value = _ClientUndo()
        value.history = history
        value.redo = redo
        value.last_undo_context = context
        _clients[key] = value


def reset_all_undo_state() -> None:
    """Discard every client's undo/redo payloads, which may contain plaintext notes."""
    _clients.clear()


def _ctx(client_id: str) -> _ClientUndo:
    if client_id not in _clients:
        _clients[client_id] = _ClientUndo()
    return _clients[client_id]


def record_update(
    client_id: str,
    undo_context: str,
    note_id: str,
    *,
    before: str,
    after: str,
    before_tags: str,
    after_tags: str,
    viewport: Dict[str, object],
) -> None:
    maybe_reset_on_context(client_id, undo_context)
    ctx = _ctx(client_id)
    normalized_viewport = _normalize_viewport_snapshot(viewport)
    view_anchor_root_id = _anchor_root_id(normalized_viewport)
    ctx.history.append({
        "type": "update_content",
        "note_id": note_id,
        "before": before,
        "after": after,
        "before_tags": before_tags,
        "after_tags": after_tags,
        "viewport": normalized_viewport,
        "viewAnchorRootId": view_anchor_root_id,
    })
    ctx.redo.clear()


def record_tag_sources(
    client_id: str,
    undo_context: str,
    note_id: str,
    *,
    before_tags: str,
    before_proposed_tags: str,
    after_tags: str,
    after_proposed_tags: str,
    viewport: Dict[str, object],
) -> None:
    if not isinstance(note_id, str) or not note_id:
        raise ValueError("note_id must be a non-empty string")
    if not isinstance(before_tags, str):
        raise TypeError("before_tags must be a string")
    if not isinstance(before_proposed_tags, str):
        raise TypeError("before_proposed_tags must be a string")
    if not isinstance(after_tags, str):
        raise TypeError("after_tags must be a string")
    if not isinstance(after_proposed_tags, str):
        raise TypeError("after_proposed_tags must be a string")
    if before_tags == after_tags and before_proposed_tags == after_proposed_tags:
        raise ValueError("tag-source undo operation must change tags or proposals")

    maybe_reset_on_context(client_id, undo_context)
    ctx = _ctx(client_id)
    normalized_viewport = _normalize_viewport_snapshot(viewport)
    view_anchor_root_id = _anchor_root_id(normalized_viewport)
    ctx.history.append({
        "type": "tag_sources",
        "note_id": note_id,
        "before_tags": before_tags,
        "before_proposed_tags": before_proposed_tags,
        "after_tags": after_tags,
        "after_proposed_tags": after_proposed_tags,
        "viewport": normalized_viewport,
        "viewAnchorRootId": view_anchor_root_id,
    })
    ctx.redo.clear()


def _apply_tag_sources_snapshot(op: dict, *, prefix: str, token: str) -> None:
    if prefix != "before" and prefix != "after":
        raise ValueError("prefix must be before or after")
    note_id = op["note_id"]
    if not isinstance(note_id, str) or not note_id:
        raise RuntimeError(f"Undo op tag_sources.note_id must be a non-empty string | op={op}")
    tags = op[f"{prefix}_tags"]
    proposed_tags = op[f"{prefix}_proposed_tags"]
    if not isinstance(tags, str):
        raise RuntimeError(f"Undo op tag_sources.{prefix}_tags must be a string | op={op}")
    if not isinstance(proposed_tags, str):
        raise RuntimeError(
            f"Undo op tag_sources.{prefix}_proposed_tags must be a string | op={op}"
        )
    record = store.get(note_id)
    if not isinstance(record.content, str):
        raise RuntimeError(f"Note content must be a string | note_id={note_id}")
    apply_update_note_sources(
        note_id=note_id,
        content=record.content,
        tags=tags,
        proposed_tags=proposed_tags,
        token=token,
    )


def record_create(client_id: str, undo_context: str, record: dict, *, viewport: Dict[str, object]) -> None:
    maybe_reset_on_context(client_id, undo_context)
    ctx = _ctx(client_id)
    normalized_viewport = _normalize_viewport_snapshot(viewport)
    view_anchor_root_id = _anchor_root_id(normalized_viewport)
    ctx.history.append({
        "type": "create_note",
        "record": record,
        "viewport": normalized_viewport,
        "viewAnchorRootId": view_anchor_root_id,
    })
    ctx.redo.clear()


def record_delete(
    client_id: str,
    undo_context: str,
    records: List[NodeRecord],
    *,
    viewport: Dict[str, object],
) -> None:
    maybe_reset_on_context(client_id, undo_context)
    ctx = _ctx(client_id)
    normalized_viewport = _normalize_viewport_snapshot(viewport)
    view_anchor_root_id = _anchor_root_id(normalized_viewport)
    ctx.history.append({
        "type": "delete_subtree",
        "records": records,
        "viewport": normalized_viewport,
        "viewAnchorRootId": view_anchor_root_id,
    })
    ctx.redo.clear()


def record_move(
    client_id: str,
    undo_context: str,
    note_id: str,
    *,
    before_parent: Optional[str],
    before_prev: Optional[str],
    before_next: Optional[str],
    before_tags: str,
    after_parent: Optional[str],
    after_prev: Optional[str],
    after_next: Optional[str],
    after_tags: str,
    viewport: Dict[str, object],
) -> None:
    maybe_reset_on_context(client_id, undo_context)
    ctx = _ctx(client_id)
    if not isinstance(before_tags, str):
        raise TypeError("before_tags must be a string")
    if not isinstance(after_tags, str):
        raise TypeError("after_tags must be a string")
    normalized_viewport = _normalize_viewport_snapshot(viewport)
    view_anchor_root_id = _anchor_root_id(normalized_viewport)
    ctx.history.append({
        "type": "move",
        "note_id": note_id,
        "before_parent": before_parent,
        "before_prev": before_prev,
        "before_next": before_next,
        "before_tags": before_tags,
        "after_parent": after_parent,
        "after_prev": after_prev,
        "after_next": after_next,
        "after_tags": after_tags,
        "viewport": normalized_viewport,
        "viewAnchorRootId": view_anchor_root_id,
    })
    ctx.redo.clear()


def record_move_batch(
    client_id: str,
    undo_context: str,
    *,
    move_ops: List[Dict[str, object]],
    viewport: Dict[str, object],
) -> None:
    maybe_reset_on_context(client_id, undo_context)
    if len(move_ops) == 0:
        raise ValueError("move_ops must be a non-empty list")

    normalized_moves: List[Dict[str, object]] = []
    for move_op in move_ops:
        if not isinstance(move_op, dict):
            raise TypeError(f"move_ops entries must be dicts, got {type(move_op)}")
        note_id = move_op["note_id"]
        if not isinstance(note_id, str) or not note_id:
            raise ValueError("move_ops.note_id must be a non-empty string")
        before_tags = move_op["before_tags"]
        after_tags = move_op["after_tags"]
        if not isinstance(before_tags, str):
            raise TypeError("move_ops.before_tags must be a string")
        if not isinstance(after_tags, str):
            raise TypeError("move_ops.after_tags must be a string")
        normalized_moves.append(
            {
                "note_id": note_id,
                "before_parent": move_op["before_parent"],
                "before_prev": move_op["before_prev"],
                "before_next": move_op["before_next"],
                "before_tags": before_tags,
                "after_parent": move_op["after_parent"],
                "after_prev": move_op["after_prev"],
                "after_next": move_op["after_next"],
                "after_tags": after_tags,
            }
        )

    ctx = _ctx(client_id)
    normalized_viewport = _normalize_viewport_snapshot(viewport)
    view_anchor_root_id = _anchor_root_id(normalized_viewport)
    ctx.history.append({
        "type": "move_batch",
        "moves": normalized_moves,
        "viewport": normalized_viewport,
        "viewAnchorRootId": view_anchor_root_id,
    })
    ctx.redo.clear()


def _assert_neighbors(note_id: str, exp_parent: Optional[str], exp_prev: Optional[str], exp_next: Optional[str]) -> None:
    parent_id = store.get(note_id).parent_id
    links_by_parent = store._links  # type: ignore[attr-defined]
    if parent_id not in links_by_parent:
        raise RuntimeError(f"Missing link scope for parent_id={parent_id}")
    links = links_by_parent[parent_id]
    if note_id not in links:
        raise RuntimeError(f"Missing note_id={note_id} in links for parent_id={parent_id}")
    cur = links[note_id]
    if cur is None:
        raise RuntimeError(f"Missing note_id={note_id} in links for parent_id={parent_id}")
    if 'prev' not in cur or 'next' not in cur:
        raise RuntimeError(f"Malformed link entry for note_id={note_id} parent_id={parent_id}: {cur}")
    prev_id = cur['prev']
    next_id = cur['next']
    if parent_id != exp_parent or prev_id != exp_prev or next_id != exp_next:
        logging.error(
            "FATAL: undo/redo move invariant failed for %s | expected parent=%s prev=%s next=%s | actual parent=%s prev=%s next=%s",
            note_id, exp_parent, exp_prev, exp_next, parent_id, prev_id, next_id,
        )
        os._exit(1)


def _apply_move_tags(op: dict, *, tags_key: str, token: str) -> None:
    if not isinstance(op, dict):
        raise TypeError(f"Undo op must be a dict, got {type(op)}")
    if tags_key not in op:
        return
    tags_value = op[tags_key]
    if not isinstance(tags_value, str):
        raise RuntimeError(f"Undo op move.{tags_key} must be a string | op={op}")
    note_id = op["note_id"]
    if not isinstance(note_id, str) or not note_id:
        raise RuntimeError(f"Undo op move.note_id must be a non-empty string | op={op}")
    record = store.get(note_id)
    if not isinstance(record.tags, str):
        raise RuntimeError(f"Note tags must be a string | note_id={note_id}")
    if record.tags == tags_value:
        return
    if not isinstance(record.content, str):
        raise RuntimeError(f"Note content must be a string | note_id={note_id}")
    apply_update_content(note_id, record.content, tags_value, token)


def record_collapse(
    client_id: str,
    undo_context: str,
    note_id: str,
    *,
    before: bool,
    after: bool,
    viewport: Dict[str, object],
) -> None:
    maybe_reset_on_context(client_id, undo_context)
    ctx = _ctx(client_id)

    normalized_viewport = _normalize_viewport_snapshot(viewport)
    view_anchor_root_id = _anchor_root_id(normalized_viewport)
    ctx.history.append({
        "type": "collapse",
        "note_id": note_id,
        "before": bool(before),
        "after": bool(after),
        "viewport": normalized_viewport,
        "viewAnchorRootId": view_anchor_root_id,
    })
    ctx.redo.clear()


def record_paste(
    client_id: str,
    undo_context: str,
    records: List[NodeRecord],
    *,
    viewport: Dict[str, object],
) -> None:
    maybe_reset_on_context(client_id, undo_context)
    ctx = _ctx(client_id)
    normalized_viewport = _normalize_viewport_snapshot(viewport)
    view_anchor_root_id = _anchor_root_id(normalized_viewport)
    ctx.history.append({
        "type": "paste_subtree",
        "records": records,
        "viewport": normalized_viewport,
        "viewAnchorRootId": view_anchor_root_id,
    })
    ctx.redo.clear()


def record_paste_into(
    client_id: str,
    undo_context: str,
    *,
    note_id: str,
    before_content: str,
    before_tags: str,
    before_proposed_tags: str,
    after_content: str,
    after_tags: str,
    after_proposed_tags: str,
    inserted_records: List[NodeRecord],
    viewport: Dict[str, object],
) -> None:
    if not isinstance(note_id, str) or not note_id:
        raise ValueError("note_id must be a non-empty string")
    if not isinstance(before_content, str):
        raise TypeError("before_content must be a string")
    if not isinstance(before_tags, str):
        raise TypeError("before_tags must be a string")
    if not isinstance(before_proposed_tags, str):
        raise TypeError("before_proposed_tags must be a string")
    if not isinstance(after_content, str):
        raise TypeError("after_content must be a string")
    if not isinstance(after_tags, str):
        raise TypeError("after_tags must be a string")
    if not isinstance(after_proposed_tags, str):
        raise TypeError("after_proposed_tags must be a string")
    if not isinstance(inserted_records, list):
        raise TypeError("inserted_records must be a list")
    for record in inserted_records:
        if not isinstance(record, NodeRecord):
            raise TypeError("inserted_records entries must be NodeRecord objects")

    maybe_reset_on_context(client_id, undo_context)
    ctx = _ctx(client_id)
    normalized_viewport = _normalize_viewport_snapshot(viewport)
    view_anchor_root_id = _anchor_root_id(normalized_viewport)
    ctx.history.append({
        "type": "paste_into",
        "note_id": note_id,
        "before_content": before_content,
        "before_tags": before_tags,
        "before_proposed_tags": before_proposed_tags,
        "after_content": after_content,
        "after_tags": after_tags,
        "after_proposed_tags": after_proposed_tags,
        "inserted_records": inserted_records,
        "viewport": normalized_viewport,
        "viewAnchorRootId": view_anchor_root_id,
    })
    ctx.redo.clear()


def record_split_note(
    client_id: str,
    undo_context: str,
    *,
    note_id: str,
    before_content: str,
    before_tags: str,
    after_content: str,
    after_tags: str,
    inserted_records: List[NodeRecord],
    viewport: Dict[str, object],
) -> None:
    if not isinstance(note_id, str) or not note_id:
        raise ValueError("note_id must be a non-empty string")
    if not isinstance(before_content, str):
        raise TypeError("before_content must be a string")
    if not isinstance(before_tags, str):
        raise TypeError("before_tags must be a string")
    if not isinstance(after_content, str):
        raise TypeError("after_content must be a string")
    if not isinstance(after_tags, str):
        raise TypeError("after_tags must be a string")
    if not isinstance(inserted_records, list):
        raise TypeError("inserted_records must be a list")
    if len(inserted_records) == 0:
        raise ValueError("inserted_records must be non-empty")
    for record in inserted_records:
        if not isinstance(record, NodeRecord):
            raise TypeError("inserted_records entries must be NodeRecord objects")

    maybe_reset_on_context(client_id, undo_context)
    ctx = _ctx(client_id)
    normalized_viewport = _normalize_viewport_snapshot(viewport)
    view_anchor_root_id = _anchor_root_id(normalized_viewport)
    ctx.history.append({
        "type": "split_note",
        "note_id": note_id,
        "before_content": before_content,
        "before_tags": before_tags,
        "after_content": after_content,
        "after_tags": after_tags,
        "inserted_records": inserted_records,
        "viewport": normalized_viewport,
        "viewAnchorRootId": view_anchor_root_id,
    })
    ctx.redo.clear()


def maybe_reset_on_context(client_id: str, undo_context: str) -> None:
    ctx = _ctx(client_id)
    if not isinstance(undo_context, str):
        raise TypeError("undo_context must be a string")
    if undo_context == "":
        raise ValueError("undo_context must be a non-empty string")

    if ctx.last_undo_context != undo_context:
        logger.info(
            "undo.stack reset client=%s from=%s to=%s",
            client_id,
            ctx.last_undo_context,
            undo_context,
        )
        ctx.history.clear()
        ctx.redo.clear()
        ctx.last_undo_context = undo_context


def reset_undo_stack(client_id: str, undo_context: str) -> None:
    if not isinstance(undo_context, str):
        raise TypeError('undo_context must be a string')
    if undo_context == "":
        raise ValueError('undo_context must be a non-empty string')

    ctx = _ctx(client_id)
    ctx.history.clear()
    ctx.redo.clear()
    ctx.last_undo_context = undo_context


def undo(client_id: str, token: str) -> Optional[Dict[str, object]]:
    ctx = _ctx(client_id)
    if not ctx.history:
        return None

    logger.info(
        "undo.stack undo_start client=%s history_len=%s redo_len=%s history_tail=%s redo_tail=%s",
        client_id,
        len(ctx.history),
        len(ctx.redo),
        _summarize_stack(ctx.history, 12),
        _summarize_stack(ctx.redo, 12),
    )

    op = ctx.history.pop()

    logger.info(
        "undo.stack undo_pop client=%s op=%s history_len=%s redo_len=%s",
        client_id,
        _summarize_op(op),
        len(ctx.history),
        len(ctx.redo),
    )

    if "type" not in op:
        raise RuntimeError(f"Undo op missing required key: type | op={op}")
    op_type = op["type"]

    undo_viewport = op["viewport"]

    if op_type == "update_content":
        apply_update_content(op["note_id"], op["before"], op["before_tags"], token)  # apply inverse
        ctx.redo.append(op)
        generate_new_uuid()
    elif op_type == "tag_sources":
        _apply_tag_sources_snapshot(op, prefix="before", token=token)
        ctx.redo.append(op)
        generate_new_uuid()
    elif op_type == "create_note":
        rec = op["record"]
        apply_delete_subtree(rec["id"])  # delete the created note
        ctx.redo.append(op)
        generate_new_uuid()
    elif op_type == "delete_subtree":
        records = op["records"]
        apply_restore_records(records, token)
        ctx.redo.append(op)
        generate_new_uuid()
    elif op_type == "move":
        apply_move(
            op["note_id"],
            op["before_parent"],
            op["before_prev"],
            op["before_next"],
        )
        _assert_neighbors(op["note_id"], op["before_parent"], op["before_prev"], op["before_next"]) 
        _apply_move_tags(op, tags_key="before_tags", token=token)
        ctx.redo.append(op)
        generate_new_uuid()
    elif op_type == "move_batch":
        moves = op["moves"]
        if not isinstance(moves, list) or len(moves) == 0:
            raise RuntimeError(f"Undo op move_batch.moves must be a non-empty list | op={op}")
        for move_op in reversed(moves):
            if not isinstance(move_op, dict):
                raise RuntimeError(f"Undo op move_batch entry must be a dict | op={op}")
            note_id = move_op["note_id"]
            before_parent = move_op["before_parent"]
            before_prev = move_op["before_prev"]
            before_next = move_op["before_next"]
            apply_move(
                note_id,
                before_parent,
                before_prev,
                before_next,
            )
            _assert_neighbors(note_id, before_parent, before_prev, before_next)
            _apply_move_tags(move_op, tags_key="before_tags", token=token)
        ctx.redo.append(op)
        generate_new_uuid()
    elif op_type == "collapse":
        # invert collapse
        apply_set_collapse(op["note_id"], bool(op["before"]))
        ctx.redo.append(op)
        generate_new_uuid()
    elif op_type == "paste_into":
        note_id = op["note_id"]
        if not isinstance(note_id, str) or not note_id:
            raise RuntimeError(f"Undo op paste_into.note_id must be a non-empty string | op={op}")
        before_content = op["before_content"]
        before_tags = op["before_tags"]
        before_proposed_tags = op["before_proposed_tags"]
        if not isinstance(before_content, str):
            raise RuntimeError(f"Undo op paste_into.before_content must be a string | op={op}")
        if not isinstance(before_tags, str):
            raise RuntimeError(f"Undo op paste_into.before_tags must be a string | op={op}")
        if not isinstance(before_proposed_tags, str):
            raise RuntimeError(
                f"Undo op paste_into.before_proposed_tags must be a string | op={op}"
            )
        inserted_records = op["inserted_records"]
        if not isinstance(inserted_records, list):
            raise RuntimeError(f"Undo op paste_into.inserted_records must be a list | op={op}")

        apply_update_note_sources(
            note_id=note_id,
            content=before_content,
            tags=before_tags,
            proposed_tags=before_proposed_tags,
            token=token,
        )

        inserted_root_ids: list[str] = []
        for record in inserted_records:
            if not isinstance(record, NodeRecord):
                raise RuntimeError(
                    f"Undo op paste_into.inserted_records must contain NodeRecords | op={op}"
                )
            if record.parent_id == note_id:
                inserted_root_ids.append(record.id)

        for root_id in inserted_root_ids:
            apply_delete_subtree(root_id)

        ctx.redo.append(op)
        generate_new_uuid()
    elif op_type == "split_note":
        note_id = op["note_id"]
        if not isinstance(note_id, str) or not note_id:
            raise RuntimeError(f"Undo op split_note.note_id must be a non-empty string | op={op}")
        before_content = op["before_content"]
        before_tags = op["before_tags"]
        if not isinstance(before_content, str):
            raise RuntimeError(f"Undo op split_note.before_content must be a string | op={op}")
        if not isinstance(before_tags, str):
            raise RuntimeError(f"Undo op split_note.before_tags must be a string | op={op}")
        inserted_records = op["inserted_records"]
        if not isinstance(inserted_records, list) or len(inserted_records) == 0:
            raise RuntimeError(f"Undo op split_note.inserted_records must be a non-empty list | op={op}")

        for record in reversed(inserted_records):
            if not isinstance(record, NodeRecord):
                raise RuntimeError(f"Undo op split_note.inserted_records must contain NodeRecords | op={op}")
            apply_delete_subtree(record.id)
        apply_update_content(note_id, before_content, before_tags, token)

        ctx.redo.append(op)
        generate_new_uuid()
    elif op_type == "paste_subtree":
        # delete the pasted subtree
        if op["records"]:
            root_id = op["records"][0].id
        else:
            root_id = None
        if not root_id:
            print("FATAL: paste_subtree undo missing root record")
            os._exit(1)
        apply_delete_subtree(root_id)
        ctx.redo.append(op)
        generate_new_uuid()
    else:
        raise RuntimeError(f"Unsupported undo op: {op_type}")

    focus_note_id = _compute_focus_note_id(op, direction="undo")
    if focus_note_id:
        view_anchor_root_id = _root_ancestor_id(focus_note_id)
    else:
        view_anchor_root_id = op["viewAnchorRootId"]
    payload = {
        **undo_viewport,
        "opType": op_type,
        "viewAnchorRootId": view_anchor_root_id,
        "focusNoteId": focus_note_id,
    }
    logger.info(
        "undo.finish opType=%s focusNoteId=%s viewAnchorRootId=%s",
        op_type,
        focus_note_id,
        view_anchor_root_id,
    )

    logger.info(
        "undo.stack undo_finish client=%s opType=%s focusNoteId=%s history_len=%s redo_len=%s history_tail=%s redo_tail=%s",
        client_id,
        op_type,
        focus_note_id,
        len(ctx.history),
        len(ctx.redo),
        _summarize_stack(ctx.history, 12),
        _summarize_stack(ctx.redo, 12),
    )
    return payload


def redo(client_id: str, token: str) -> Optional[Dict[str, object]]:
    ctx = _ctx(client_id)
    if not ctx.redo:
        return None

    logger.info(
        "undo.stack redo_start client=%s history_len=%s redo_len=%s history_tail=%s redo_tail=%s",
        client_id,
        len(ctx.history),
        len(ctx.redo),
        _summarize_stack(ctx.history, 12),
        _summarize_stack(ctx.redo, 12),
    )

    op = ctx.redo.pop()

    logger.info(
        "undo.stack redo_pop client=%s op=%s history_len=%s redo_len=%s",
        client_id,
        _summarize_op(op),
        len(ctx.history),
        len(ctx.redo),
    )
    redo_viewport = op["viewport"]

    if "type" not in op:
        raise RuntimeError(f"Undo op missing required key: type | op={op}")
    op_type = op["type"]

    if op_type == "update_content":
        apply_update_content(op["note_id"], op["after"], op["after_tags"], token)  # reapply
        ctx.history.append(op)
        generate_new_uuid()
    elif op_type == "tag_sources":
        _apply_tag_sources_snapshot(op, prefix="after", token=token)
        ctx.history.append(op)
        generate_new_uuid()
    elif op_type == "create_note":
        # recreate
        rec = op["record"]
        apply_restore_records([SimpleNamespace(**rec)], token)
        ctx.history.append(op)
        generate_new_uuid()

    elif op_type == "delete_subtree":
        # re-delete
        first = op["records"][0]
        apply_delete_subtree(first.id)
        ctx.history.append(op)
        generate_new_uuid()
    elif op_type == "move":
        apply_move(
            op["note_id"],
            op["after_parent"],
            op["after_prev"],
            op["after_next"],
        )
        _assert_neighbors(op["note_id"], op["after_parent"], op["after_prev"], op["after_next"]) 
        _apply_move_tags(op, tags_key="after_tags", token=token)
        ctx.history.append(op)
        generate_new_uuid()
    elif op_type == "move_batch":
        moves = op["moves"]
        if not isinstance(moves, list) or len(moves) == 0:
            raise RuntimeError(f"Redo op move_batch.moves must be a non-empty list | op={op}")
        for move_op in moves:
            if not isinstance(move_op, dict):
                raise RuntimeError(f"Redo op move_batch entry must be a dict | op={op}")
            note_id = move_op["note_id"]
            after_parent = move_op["after_parent"]
            after_prev = move_op["after_prev"]
            after_next = move_op["after_next"]
            apply_move(
                note_id,
                after_parent,
                after_prev,
                after_next,
            )
            _assert_neighbors(note_id, after_parent, after_prev, after_next)
            _apply_move_tags(move_op, tags_key="after_tags", token=token)
        ctx.history.append(op)
        generate_new_uuid()
    elif op_type == "collapse":
        apply_set_collapse(op["note_id"], bool(op["after"]))
        ctx.history.append(op)
        generate_new_uuid()
    elif op_type == "paste_into":
        note_id = op["note_id"]
        if not isinstance(note_id, str) or not note_id:
            raise RuntimeError(f"Redo op paste_into.note_id must be a non-empty string | op={op}")
        after_content = op["after_content"]
        after_tags = op["after_tags"]
        after_proposed_tags = op["after_proposed_tags"]
        if not isinstance(after_content, str):
            raise RuntimeError(f"Redo op paste_into.after_content must be a string | op={op}")
        if not isinstance(after_tags, str):
            raise RuntimeError(f"Redo op paste_into.after_tags must be a string | op={op}")
        if not isinstance(after_proposed_tags, str):
            raise RuntimeError(
                f"Redo op paste_into.after_proposed_tags must be a string | op={op}"
            )
        inserted_records = op["inserted_records"]
        if not isinstance(inserted_records, list):
            raise RuntimeError(f"Redo op paste_into.inserted_records must be a list | op={op}")

        apply_update_note_sources(
            note_id=note_id,
            content=after_content,
            tags=after_tags,
            proposed_tags=after_proposed_tags,
            token=token,
        )
        if inserted_records:
            apply_restore_records(inserted_records, token)
        ctx.history.append(op)
        generate_new_uuid()
    elif op_type == "split_note":
        note_id = op["note_id"]
        if not isinstance(note_id, str) or not note_id:
            raise RuntimeError(f"Redo op split_note.note_id must be a non-empty string | op={op}")
        after_content = op["after_content"]
        after_tags = op["after_tags"]
        if not isinstance(after_content, str):
            raise RuntimeError(f"Redo op split_note.after_content must be a string | op={op}")
        if not isinstance(after_tags, str):
            raise RuntimeError(f"Redo op split_note.after_tags must be a string | op={op}")
        inserted_records = op["inserted_records"]
        if not isinstance(inserted_records, list) or len(inserted_records) == 0:
            raise RuntimeError(f"Redo op split_note.inserted_records must be a non-empty list | op={op}")

        apply_update_content(note_id, after_content, after_tags, token)
        apply_restore_records(inserted_records, token)

        ctx.history.append(op)
        generate_new_uuid()
    elif op_type == "paste_subtree":
        # restore the subtree
        apply_restore_records(op["records"], token)
        ctx.history.append(op)
        generate_new_uuid()
    else:
        raise RuntimeError(f"Unsupported redo op: {op_type}")

    focus_note_id = _compute_focus_note_id(op, direction="redo")
    if focus_note_id:
        view_anchor_root_id = _root_ancestor_id(focus_note_id)
    else:
        view_anchor_root_id = op["viewAnchorRootId"]
    payload = {
        **redo_viewport,
        "opType": op_type,
        "viewAnchorRootId": view_anchor_root_id,
        "focusNoteId": focus_note_id,
    }
    logger.info(
        "redo.finish opType=%s focusNoteId=%s viewAnchorRootId=%s",
        op_type,
        focus_note_id,
        view_anchor_root_id,
    )

    logger.info(
        "undo.stack redo_finish client=%s opType=%s focusNoteId=%s history_len=%s redo_len=%s history_tail=%s redo_tail=%s",
        client_id,
        op_type,
        focus_note_id,
        len(ctx.history),
        len(ctx.redo),
        _summarize_stack(ctx.history, 12),
        _summarize_stack(ctx.redo, 12),
    )
    return payload
