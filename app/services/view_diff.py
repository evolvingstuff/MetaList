from __future__ import annotations

from typing import Dict, List, Optional, Sequence

from app.services.view_state import ViewState


def _children_in(view: ViewState, parent_id: Optional[str]) -> List[str]:
    """A note's children in a view; a note without children there has no entry."""
    if parent_id not in view.children_by_parent:  # shockharness: ignore[DEF002] reason="a note without children in the view has no entry"
        return []
    return view.children_by_parent[parent_id]


def generate_diff_ops(previous: ViewState, current: ViewState) -> List[Dict[str, object]]:
    if previous.children_by_parent == current.children_by_parent:
        return []

    operations: List[Dict[str, object]] = []

    def diff_branch(parent_id: Optional[str]) -> None:
        prev_children = _children_in(previous, parent_id)
        curr_children = _children_in(current, parent_id)
        sibling_ops = _diff_sibling_order(prev_children, curr_children)
        for op in sibling_ops:
            op['parentId'] = parent_id
            operations.append(op)

        for child_id in curr_children:
            if child_id in previous.hash_by_id:
                diff_branch(child_id)
            else:
                _diff_new_subtree(child_id)

    def _diff_new_subtree(node_id: str) -> None:
        curr_children = _children_in(current, node_id)
        if not curr_children:
            return
        sibling_ops = _diff_sibling_order([], curr_children)
        for op in sibling_ops:
            op['parentId'] = node_id
            operations.append(op)
        for child_id in curr_children:
            _diff_new_subtree(child_id)

    diff_branch(None)
    return operations


def _diff_sibling_order(previous_ids: Sequence[str], desired_ids: Sequence[str]) -> List[Dict[str, object]]:
    position = {note_id: idx for idx, note_id in enumerate(previous_ids)}
    working = list(previous_ids)
    desired_set = set(desired_ids)
    operations: List[Dict[str, object]] = []

    for idx in range(len(working) - 1, -1, -1):
        note_id = working[idx]
        if note_id not in desired_set:
            working.pop(idx)
            del position[note_id]
            operations.append({
                'type': 'remove',
                'noteId': note_id,
                'fromIndex': idx,
            })

    # Deletions shift sibling indices; keep the position map consistent before moves.
    _reindex(position, working, start=0)

    for target_index, note_id in enumerate(desired_ids):
        if note_id not in position:
            working.insert(target_index, note_id)
            _reindex(position, working, start=target_index)
            operations.append({
                'type': 'insert',
                'noteId': note_id,
                'toIndex': target_index,
            })
            continue

        existing_index = position[note_id]

        if existing_index == target_index:
            continue

        assert 0 <= existing_index < len(working), (
            f"diff invariant violated: index out of range: noteId={note_id} "
            f"index={existing_index} len={len(working)}"
        )
        assert working[existing_index] == note_id, (
            f"diff invariant violated: position map mismatch: noteId={note_id} "
            f"index={existing_index} actualId={working[existing_index]}"
        )

        working.pop(existing_index)
        working.insert(target_index, note_id)
        _reindex(position, working, start=min(existing_index, target_index))
        operations.append({
            'type': 'move',
            'noteId': note_id,
            'fromIndex': existing_index,
            'toIndex': target_index,
        })

    return operations


def _reindex(position: Dict[str, int], working: Sequence[str], start: int) -> None:
    for idx in range(start, len(working)):
        position[working[idx]] = idx
