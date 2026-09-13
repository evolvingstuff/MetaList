from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional
import uuid

from app.usecases.base import QueryCommand
from app.services.store import store, NodeRecord
from app.services.search_index import search_index
from app.services.sync import get_clipboard, generate_new_uuid
from app.usecases.create_note import apply_insert_note
from app.usecases.delete_subtree import _collect_subtree_ids
from app.usecases.search_context_tags import ensure_tags_match_search_query
from app.usecases.update_content import apply_update_note_sources
from app.services.content_formatting import _tokenize_tag_bar
from app.services.undo_state import record_paste, record_paste_into
from app.utils.text_utils import strip_html


def _merge_note_tags(current_tags: str, next_tags: str) -> str:
    if not isinstance(current_tags, str):
        raise TypeError("current_tags must be a string")
    if not isinstance(next_tags, str):
        raise TypeError("next_tags must be a string")

    merged: list[str] = []
    seen: set[str] = set()
    for source in (current_tags, next_tags):
        for token in _tokenize_tag_bar(source):
            dedupe_key = token.casefold()
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            merged.append(token)
    return " ".join(merged)


def _note_has_positive_matching_ancestor(parent_id: Optional[str], positive_matches: set[str]) -> bool:
    current_id = parent_id
    while current_id is not None:
        if current_id in positive_matches:
            return True
        current_id = store.get(current_id).parent_id
    return False


def _should_force_root_match(parent_id: Optional[str], search_query: str | None) -> bool:
    if search_query is None:
        return False
    if not isinstance(search_query, str):
        raise TypeError(f"search_query must be a string or None, got {type(search_query)}")
    if search_query.strip() == "":
        return False
    positive_matches = set(search_index.query_note_ids(search_query))
    return not _note_has_positive_matching_ancestor(parent_id, positive_matches)


def _is_empty_target_note(target: NodeRecord) -> bool:
    if not isinstance(target, NodeRecord):
        raise TypeError(f"target must be a NodeRecord, got {type(target)}")
    if strip_html(target.content) != "":
        return False
    if store.children(target.id):
        return False
    return True


def _collect_inserted_records(parent_id: str) -> List[NodeRecord]:
    if not isinstance(parent_id, str) or not parent_id:
        raise TypeError("parent_id must be a non-empty string")
    records: List[NodeRecord] = []
    for root_id in store.children(parent_id):
        for note_id in _collect_subtree_ids(root_id):
            records.append(store.get(note_id))
    return records


def _insert_cloned_subtree_at(
    snapshot: List[dict],
    dest_parent: Optional[str],
    dest_prev: Optional[str],
    token: str,
    *,
    search_query: str | None,
) -> str:
    if not isinstance(snapshot, list) or not snapshot:
        raise ValueError("Clipboard snapshot must be a non-empty list")
    for entry in snapshot:
        if not isinstance(entry, dict):
            raise ValueError("Clipboard snapshot entries must be objects")

    # Map old->new ids
    id_map: Dict[str, str] = {}
    # Track last inserted child per parent
    last_per_parent: Dict[Optional[str], Optional[str]] = {}
    last_per_parent[dest_parent] = dest_prev

    new_root_id: Optional[str] = None
    snapshot_ids: set[str] = set()
    positive_matches: set[str] = set()
    should_force_root_match = False
    if search_query is not None:
        if not isinstance(search_query, str):
            raise TypeError(f"search_query must be a string or None, got {type(search_query)}")
        if search_query.strip() != "":
            positive_matches = set(search_index.query_note_ids(search_query))
            if not _note_has_positive_matching_ancestor(dest_parent, positive_matches):
                should_force_root_match = True

    for rec in snapshot:
        if "id" not in rec:
            raise ValueError("Clipboard snapshot missing required key: id")
        note_id = rec["id"]
        if not isinstance(note_id, str) or not note_id:
            raise ValueError("Clipboard snapshot id must be a non-empty string")
        snapshot_ids.add(note_id)

    for rec in snapshot:
        old_id = rec["id"]
        new_id = str(uuid.uuid4())
        id_map[old_id] = new_id

        if "parent_id" not in rec:
            raise ValueError("Clipboard snapshot missing required key: parent_id")
        old_parent = rec["parent_id"]
        if old_parent is None or old_parent not in snapshot_ids:
            new_parent = dest_parent
        elif old_parent in id_map:
            new_parent = id_map[old_parent]
        else:
            raise RuntimeError(
                f"Clipboard snapshot missing parent {old_parent} for node {old_id}"
            )

        if new_parent not in last_per_parent:
            last_per_parent[new_parent] = None
        prev_id = last_per_parent[new_parent]
        # Compute next from current store state
        if prev_id is None:
            children = store.children(new_parent)
            next_id = None
            if children:
                next_id = children[0]
        else:
            previous = store.get(prev_id)
            assert previous.parent_id == new_parent
            next_id = previous.next_id


        if "content" not in rec:
            raise ValueError("Clipboard snapshot missing required key: content")
        content = rec["content"]
        if not isinstance(content, str):
            raise ValueError("Clipboard snapshot content must be a string")

        if "tags" not in rec:
            raise ValueError("Clipboard snapshot missing required key: tags")
        tags = rec["tags"]
        if not isinstance(tags, str):
            raise ValueError("Clipboard snapshot tags must be a string")
        if "proposed_tags" not in rec:
            raise ValueError("Clipboard snapshot missing required key: proposed_tags")
        proposed_tags = rec["proposed_tags"]
        if not isinstance(proposed_tags, str):
            raise ValueError("Clipboard snapshot proposed_tags must be a string")

        is_new_root = new_root_id is None and new_parent == dest_parent
        if is_new_root and should_force_root_match:
            tags = ensure_tags_match_search_query(
                parent_id=dest_parent,
                content=content,
                tags=tags,
                search_query=search_query,
            )

        apply_insert_note(
            new_id,
            new_parent,
            prev_id,
            next_id,
            token,
            content=content,
            tags=tags,
            proposed_tags=proposed_tags,
        )

        if new_id not in last_per_parent:
            last_per_parent[new_id] = None

        last_per_parent[new_parent] = new_id
        if new_root_id is None and new_parent == dest_parent:
            new_root_id = new_id

    if new_root_id is None:
        raise RuntimeError("Clipboard paste did not produce a new root id")
    return new_root_id


@dataclass
class CmdPasteSibling(QueryCommand):
    target_note_id: str
    search_query: str | None
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdPasteSibling(target={self.target_note_id}, client={self.client_id})"

    def execute(self) -> Dict[str, str]:
        snapshot = get_clipboard(self.client_id)
        if not snapshot:
            return {"status": "clipboard_empty"}

        target = store.get(self.target_note_id)
        if _is_empty_target_note(target):
            root_snapshot = snapshot[0]
            if not isinstance(root_snapshot, dict):
                raise ValueError("Clipboard root entry must be an object")
            if "content" not in root_snapshot:
                raise ValueError("Clipboard root missing required key: content")
            if "tags" not in root_snapshot:
                raise ValueError("Clipboard root missing required key: tags")
            if "proposed_tags" not in root_snapshot:
                raise ValueError("Clipboard root missing required key: proposed_tags")

            content = root_snapshot["content"]
            if not isinstance(content, str):
                raise ValueError("Clipboard root content must be a string")
            tags = root_snapshot["tags"]
            if not isinstance(tags, str):
                raise ValueError("Clipboard root tags must be a string")
            proposed_tags = root_snapshot["proposed_tags"]
            if not isinstance(proposed_tags, str):
                raise ValueError("Clipboard root proposed_tags must be a string")
            if target.tags.strip() != "":
                tags = _merge_note_tags(target.tags, tags)
            if target.proposed_tags.strip() != "":
                proposed_tags = _merge_note_tags(target.proposed_tags, proposed_tags)

            if _should_force_root_match(target.parent_id, self.search_query):
                if not isinstance(self.search_query, str):
                    raise TypeError(
                        f"search_query must be a string when forcing root match, got {type(self.search_query)}"
                    )
                tags = ensure_tags_match_search_query(
                    parent_id=target.parent_id,
                    content=content,
                    tags=tags,
                    search_query=self.search_query,
                )

            before_content = target.content
            before_tags = target.tags
            before_proposed_tags = target.proposed_tags
            apply_update_note_sources(
                note_id=target.id,
                content=content,
                tags=tags,
                proposed_tags=proposed_tags,
                token=self.token,
            )

            inserted_records: List[NodeRecord] = []
            if len(snapshot) > 1:
                _insert_cloned_subtree_at(
                    snapshot[1:],
                    target.id,
                    None,
                    self.token,
                    search_query=None,
                )
                inserted_records = _collect_inserted_records(target.id)

            record_paste_into(
                self.client_id,
                self.undo_context,
                note_id=target.id,
                before_content=before_content,
                before_tags=before_tags,
                before_proposed_tags=before_proposed_tags,
                after_content=content,
                after_tags=tags,
                after_proposed_tags=proposed_tags,
                inserted_records=inserted_records,
                viewport=self.viewport,
            )

            return {"status": "pasted", "id": target.id, "updateUUID": generate_new_uuid()}
        siblings = store.children(target.parent_id)
        if target.id not in siblings:
            raise RuntimeError(
                "Integrity failure: paste target missing from siblings list: "
                f"note_id={target.id} parent_id={target.parent_id}"
            )
        prev_id = target.id
        new_root_id = _insert_cloned_subtree_at(
            snapshot,
            target.parent_id,
            prev_id,
            self.token,
            search_query=self.search_query,
        )

        # Record for undo: as paste_subtree (undo deletes, redo restores)
        new_ids = _collect_subtree_ids(new_root_id)
        records: List[NodeRecord] = [store.get(nid) for nid in new_ids]
        record_paste(self.client_id, self.undo_context, records, viewport=self.viewport)

        return {"status": "pasted", "id": new_root_id, "updateUUID": generate_new_uuid()}
