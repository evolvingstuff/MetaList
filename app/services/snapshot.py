from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
import re
import time
from typing import DefaultDict, Dict, List, Optional, Tuple, Set

from loguru import logger

from app.services.content_formatting import find_list_style
from app.services.embedded_references import collapsed_preview_source_has_image_file_embed
from app.services.embedded_references import collapsed_preview_source_has_hidden_content
from app.services.embedded_references import collapsed_preview_source_has_media
from app.services.embedded_references import collapsed_preview_source_has_note_embed
from app.services.embedded_references import EmbedRenderContext
from app.services.embedded_references import extract_collapsed_preview_source_html
from app.services.embedded_references import render_collapsed_note_content_with_embeds
from app.services.embedded_references import render_note_content_with_embeds
from app.services.file_registry import file_registry
from app.services.file_storage import get_file_reference_record
from app.services.note_store import store as note_store
from app.services.reference_presentation import decorate_note_references
from app.services.root_sorting import build_root_sort_buckets
from app.services.root_sorting import get_root_ids_for_sort_mode
from app.services.root_sorting import get_root_sort_timestamps
from app.services.root_sorting import normalize_sort_mode
from app.services.search_index import search_index
from app.services.search_query import ParsedSearchQuery, SearchClause, parse_search_query
from app.services.sync import get_all_locks
from app.services.view_state import ViewState
from app.utils.text_utils import strip_html

# Windowing constants (tuned later)
ROOT_CHUNK_SIZE = 50
ROOT_BUFFER_THRESHOLD = 25
_UUID_IN_TEXT_RE = re.compile(
    r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)


@dataclass(frozen=True)
class SearchScope:
    search_active: bool
    allowed_note_ids: Optional[Set[str]]
    search_root_ids_ordered: Optional[List[str]]
    search_root_count_total: int
    matched_note_ids: Optional[Set[str]] = None


@dataclass(frozen=True, slots=True)
class ResolvedViewScope:
    """Canonical, explicit note membership for one complete MetaList view."""

    filter_active: bool
    allowed_note_ids: frozenset[str]
    matched_note_ids: frozenset[str]
    ordered_root_ids: tuple[str, ...]
    total_root_count: int


def _extract_direct_uuid_note_ids(clause: SearchClause) -> Set[str]:
    candidates: Set[str] = set()
    for token in clause.required_tags:
        for match in _UUID_IN_TEXT_RE.finditer(token):
            candidates.add(match.group(0).lower())
    for phrase in clause.required_text:
        for match in _UUID_IN_TEXT_RE.finditer(phrase):
            candidates.add(match.group(0).lower())

    direct_ids: Set[str] = set()
    for candidate in candidates:
        if note_store.has_note(candidate):
            direct_ids.add(candidate)
    return direct_ids


def _has_search_terms(parsed: ParsedSearchQuery) -> bool:
    return any(
        clause.required_tags
        or clause.forbidden_tags
        or clause.required_text
        or clause.forbidden_text
        for clause in parsed.clauses
    )


def _include_ancestors(note_ids: Set[str], *, starting_ids: Set[str]) -> None:
    to_visit = list(starting_ids)
    while to_visit:
        current_id = to_visit.pop()
        if not note_store.has_note(current_id):
            continue
        parent_id = note_store.get_note(current_id).parent_id
        if parent_id is None:
            continue
        if parent_id in note_ids:
            continue
        note_ids.add(parent_id)
        to_visit.append(parent_id)


def _include_descendants(note_ids: Set[str], *, starting_ids: Set[str]) -> None:
    to_visit = list(starting_ids)
    while to_visit:
        current_id = to_visit.pop()
        if not note_store.has_note(current_id):
            continue
        for child_id in note_store.get_children(current_id):
            if child_id in note_ids:
                continue
            note_ids.add(child_id)
            to_visit.append(child_id)


def _positive_tag_clause(tag: str) -> SearchClause:
    return SearchClause(
        required_tags=frozenset({tag}),
        forbidden_tags=frozenset(),
        required_text=(),
        forbidden_text=(),
    )


def _positive_text_clause(phrase: str) -> SearchClause:
    return SearchClause(
        required_tags=frozenset(),
        forbidden_tags=frozenset(),
        required_text=(phrase,),
        forbidden_text=(),
    )


def _resolve_clause_note_sets(
    *,
    clause: SearchClause,
    ordered_root_ids: List[str],
) -> Tuple[Set[str], Set[str]]:
    has_positive_terms = bool(clause.required_tags)
    if clause.required_text:
        has_positive_terms = True
    direct_uuid_note_ids = _extract_direct_uuid_note_ids(clause)

    if has_positive_terms:
        positively_matched_note_ids = set(search_index.query_clause_note_ids(clause))
    else:
        positively_matched_note_ids = set(ordered_root_ids)
        _include_descendants(positively_matched_note_ids, starting_ids=set(ordered_root_ids))

    positively_matched_note_ids.update(direct_uuid_note_ids)
    allowed_note_ids = set(positively_matched_note_ids)

    excluded_note_ids: Set[str] = set()
    for tag in clause.forbidden_tags:
        excluded_note_ids.update(search_index.query_clause_note_ids(_positive_tag_clause(tag)))
    for phrase in clause.forbidden_text:
        excluded_note_ids.update(search_index.query_clause_note_ids(_positive_text_clause(phrase)))

    _include_ancestors(allowed_note_ids, starting_ids=set(allowed_note_ids))
    if not has_positive_terms:
        _include_descendants(allowed_note_ids, starting_ids=set(positively_matched_note_ids))
    if excluded_note_ids:
        allowed_note_ids.difference_update(excluded_note_ids)
        positively_matched_note_ids.difference_update(excluded_note_ids)
    if direct_uuid_note_ids:
        allowed_note_ids.update(direct_uuid_note_ids)
        positively_matched_note_ids.update(direct_uuid_note_ids)
        _include_ancestors(allowed_note_ids, starting_ids=set(direct_uuid_note_ids))
        _include_descendants(allowed_note_ids, starting_ids=set(direct_uuid_note_ids))
        _include_descendants(positively_matched_note_ids, starting_ids=set(direct_uuid_note_ids))

    return allowed_note_ids, positively_matched_note_ids


def resolve_search_scope(
    *,
    search: Optional[str],
    editing_note_id: Optional[str],
    sort_mode: str,
    ordered_root_ids: Optional[List[str]],
) -> SearchScope:
    normalized_sort_mode = normalize_sort_mode(sort_mode)
    if search is None:
        return SearchScope(
            search_active=False,
            allowed_note_ids=None,
            matched_note_ids=None,
            search_root_ids_ordered=None,
            search_root_count_total=0,
        )
    if not isinstance(search, str):
        raise TypeError(f"search must be a string or null, got {type(search)}")

    parsed = parse_search_query(search)
    if not _has_search_terms(parsed):
        return SearchScope(
            search_active=False,
            allowed_note_ids=None,
            matched_note_ids=None,
            search_root_ids_ordered=None,
            search_root_count_total=0,
        )

    if ordered_root_ids is None:
        if normalized_sort_mode == "normal":
            ordered_root_ids = note_store.get_children(None)
        else:
            root_sort_timestamps = get_root_sort_timestamps(normalized_sort_mode)
            ordered_root_ids = get_root_ids_for_sort_mode(
                normalized_sort_mode,
                root_timestamps=root_sort_timestamps,
            )
    search_allowed_note_ids: Set[str] = set()
    positively_matched_note_ids: Set[str] = set()
    for clause in parsed.clauses:
        clause_allowed_note_ids, clause_matched_note_ids = _resolve_clause_note_sets(
            clause=clause,
            ordered_root_ids=ordered_root_ids,
        )
        search_allowed_note_ids.update(clause_allowed_note_ids)
        positively_matched_note_ids.update(clause_matched_note_ids)

    search_root_ids_ordered = [
        root_id for root_id in ordered_root_ids if root_id in search_allowed_note_ids
    ]
    return SearchScope(
        search_active=True,
        allowed_note_ids=set(search_allowed_note_ids),
        matched_note_ids=set(positively_matched_note_ids),
        search_root_ids_ordered=search_root_ids_ordered,
        search_root_count_total=len(search_root_ids_ordered),
    )


def _apply_untagged_view(
    *,
    ordered_root_ids: List[str],
) -> SearchScope:
    matched_note_ids = search_index.query_untagged_note_ids()

    allowed_note_ids = set(matched_note_ids)
    _include_ancestors(allowed_note_ids, starting_ids=set(matched_note_ids))
    root_ids_ordered = [
        root_id for root_id in ordered_root_ids if root_id in allowed_note_ids
    ]
    return SearchScope(
        search_active=True,
        allowed_note_ids=allowed_note_ids,
        matched_note_ids=matched_note_ids,
        search_root_ids_ordered=root_ids_ordered,
        search_root_count_total=len(root_ids_ordered),
    )


def resolve_view_scope_membership(
    *,
    search: str,
    sort_mode: str,
    is_untagged_view: bool,
) -> ResolvedViewScope:
    """Resolve evidence membership using the same rules as ``/notes/view``.

    ``matched_note_ids`` contains only evidence-bearing matches. The separate
    ``allowed_note_ids`` set may additionally contain ancestors required to render
    the hierarchy and must never be treated as agent evidence.
    """
    if not isinstance(search, str):
        raise TypeError("search must be a string")
    if not isinstance(is_untagged_view, bool):
        raise TypeError("is_untagged_view must be a bool")
    normalized_sort_mode = normalize_sort_mode(sort_mode)
    if normalized_sort_mode == "normal":
        ordered_root_ids = note_store.get_children(None)
    else:
        root_sort_timestamps = get_root_sort_timestamps(normalized_sort_mode)
        ordered_root_ids = get_root_ids_for_sort_mode(
            normalized_sort_mode,
            root_timestamps=root_sort_timestamps,
        )
    if is_untagged_view:
        search_scope = _apply_untagged_view(ordered_root_ids=ordered_root_ids)
    else:
        search_scope = resolve_search_scope(
            search=search,
            editing_note_id=None,
            sort_mode=normalized_sort_mode,
            ordered_root_ids=ordered_root_ids,
        )

    filter_active = search_scope.search_active
    if search_scope.search_active:
        if search_scope.allowed_note_ids is None:
            raise RuntimeError("active search scope missing allowed_note_ids")
        if search_scope.matched_note_ids is None:
            raise RuntimeError("active search scope missing matched_note_ids")
        if search_scope.search_root_ids_ordered is None:
            raise RuntimeError("active search scope missing ordered root ids")
        allowed_note_ids = set(search_scope.allowed_note_ids)
        matched_note_ids = set(search_scope.matched_note_ids)
        scoped_root_ids = list(search_scope.search_root_ids_ordered)
    else:
        allowed_note_ids = set(note_store.list_note_ids())
        matched_note_ids = set(allowed_note_ids)
        scoped_root_ids = list(ordered_root_ids)

    return ResolvedViewScope(
        filter_active=filter_active,
        allowed_note_ids=frozenset(allowed_note_ids),
        matched_note_ids=frozenset(matched_note_ids),
        ordered_root_ids=tuple(scoped_root_ids),
        total_root_count=len(scoped_root_ids),
    )


def _compute_hash(
    content: str,
    tags: str,
    proposed_tags: str,
    flags: Dict[str, object],
    parent_id: Optional[str],
    prev_id: Optional[str],
    next_id: Optional[str],
) -> str:
    flags_json = json.dumps(flags, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    sha = hashlib.sha256()
    sha.update(content.encode("utf-8"))
    sha.update(b"|TAGS|")
    sha.update(tags.encode("utf-8"))
    sha.update(b"|PROPOSED_TAGS|")
    sha.update(proposed_tags.encode("utf-8"))
    sha.update(b"|FLAGS|")
    sha.update(flags_json.encode("utf-8"))
    sha.update(b"|STRUCT|")
    parts = [parent_id or "", prev_id or "", next_id or ""]
    sha.update("::".join(parts).encode("utf-8"))
    return sha.hexdigest()


def _determine_root_window_end(
    ordered_root_ids: List[str],
    root_index_map: Dict[str, int],
    client_known_note_ids: Set[str],
    seen_root_indices: Set[int],
    editing_note_id: Optional[str],
    anchor_root_id: Optional[str],
) -> int:
    if not ordered_root_ids:
        return -1
    window_end = min(len(ordered_root_ids) - 1, ROOT_CHUNK_SIZE - 1)
    for note_id in client_known_note_ids:
        if note_id not in root_index_map:
            continue
        window_end = max(window_end, root_index_map[note_id])
    if editing_note_id:
        # Expand to include the root containing the editing node
        # Find root id by walking parents in store
        current = note_store.get_note(editing_note_id)
        while current.parent_id:
            current = note_store.get_note(current.parent_id)
        editing_root_id = current.id
        if editing_root_id in root_index_map:
            window_end = max(window_end, root_index_map[editing_root_id])
    if seen_root_indices:
        highest_seen_index = max(seen_root_indices)
        while window_end < len(ordered_root_ids) - 1 and window_end - highest_seen_index <= ROOT_BUFFER_THRESHOLD:
            window_end = min(window_end + ROOT_CHUNK_SIZE, len(ordered_root_ids) - 1)
    if anchor_root_id:
        anchor_index: Optional[int] = None
        if anchor_root_id in root_index_map:
            anchor_index = root_index_map[anchor_root_id]
        else:
            known_root_indices = [
                root_index_map[note_id]
                for note_id in client_known_note_ids
                if note_id in root_index_map
            ]
            if known_root_indices:
                # The DOM anchor can disappear between polls. Continue from the
                # furthest root that is still valid in the current view.
                anchor_index = max(known_root_indices)
        if anchor_index is not None:
            while (
                window_end < len(ordered_root_ids) - 1
                and window_end - anchor_index <= ROOT_BUFFER_THRESHOLD
            ):
                window_end = min(window_end + ROOT_CHUNK_SIZE, len(ordered_root_ids) - 1)
    return window_end


def _timestamp_iso(record: object, field_name: str) -> str:
    timestamp = getattr(record, field_name, None)
    if not isinstance(timestamp, datetime):
        return ""
    return timestamp.isoformat()


class _SnapshotTraversalCache:
    """Request-local hierarchy cache shared by rendering and metadata building."""

    def __init__(self) -> None:
        self._children_by_parent: Dict[Optional[str], List[str]] = {}
        self._record_by_id: Dict[str, object] = {}
        self._path_by_id: Dict[str, List[Dict[str, str]]] = {}
        self._descendant_count_by_id: Dict[str, int] = {}
        self._proposal_subtree_count_by_id: Dict[str, int] = {}

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        if parent_id not in self._children_by_parent:
            self._children_by_parent[parent_id] = note_store.get_children(parent_id)
        return self._children_by_parent[parent_id]

    def get_note(self, note_id: str) -> object:
        if note_id not in self._record_by_id:
            self._record_by_id[note_id] = note_store.get_note(note_id)
        return self._record_by_id[note_id]

    def _build_path(self, note_id: str) -> List[Dict[str, str]]:
        if note_id in self._path_by_id:
            return self._path_by_id[note_id]

        uncached_records: List[object] = []
        current_id = note_id
        visited_ids: Set[str] = set()
        while current_id not in self._path_by_id:
            if current_id in visited_ids:
                raise RuntimeError(f"Hierarchy cycle detected while building path for {note_id}")
            visited_ids.add(current_id)
            record = self.get_note(current_id)
            uncached_records.append(record)
            if record.parent_id is None:
                path: List[Dict[str, str]] = []
                break
            current_id = record.parent_id
        else:
            path = list(self._path_by_id[current_id])

        for record in reversed(uncached_records):
            path.append({
                "id": record.id,
                "label": strip_html(record.content).strip()[:80],
            })
            self._path_by_id[record.id] = list(path)
        return self._path_by_id[note_id]

    def _count_descendants(self, note_id: str) -> int:
        if note_id in self._descendant_count_by_id:
            return self._descendant_count_by_id[note_id]

        stack: List[Tuple[str, bool]] = [(note_id, False)]
        visiting: Set[str] = set()
        while stack:
            current_id, is_expanded = stack.pop()
            if current_id in self._descendant_count_by_id:
                continue
            if is_expanded:
                children = self.get_children(current_id)
                self._descendant_count_by_id[current_id] = sum(
                    1 + self._descendant_count_by_id[child_id]
                    for child_id in children
                )
                visiting.remove(current_id)
                continue
            if current_id in visiting:
                raise RuntimeError(
                    f"Hierarchy cycle detected while counting descendants for {note_id}"
                )
            visiting.add(current_id)
            stack.append((current_id, True))
            for child_id in reversed(self.get_children(current_id)):
                if child_id not in self._descendant_count_by_id:
                    stack.append((child_id, False))
        return self._descendant_count_by_id[note_id]

    def build_metadata(self, note_id: str) -> Dict[str, object]:
        record = self.get_note(note_id)
        inherited_tags = sorted(note_store.get_inherited_non_meta_tag_terms(note_id))
        return {
            "createdAt": _timestamp_iso(record, "created_at"),
            "updatedAt": _timestamp_iso(record, "updated_at"),
            "inheritedTags": inherited_tags,
            "path": self._build_path(note_id),
            "childCount": len(self.get_children(note_id)),
            "subtreeCount": self._count_descendants(note_id),
        }

    def count_proposals_in_subtree(
        self,
        note_id: str,
        *,
        allowed_note_ids: Optional[Set[str]],
    ) -> int:
        if note_id in self._proposal_subtree_count_by_id:
            return self._proposal_subtree_count_by_id[note_id]
        record = self.get_note(note_id)
        direct_count = len(record.proposed_tag_terms)
        descendant_count = 0
        for child_id in self.get_children(note_id):
            if allowed_note_ids is not None and child_id not in allowed_note_ids:
                continue
            descendant_count += self.count_proposals_in_subtree(
                child_id,
                allowed_note_ids=allowed_note_ids,
            )
        total = direct_count + descendant_count
        self._proposal_subtree_count_by_id[note_id] = total
        return total


def build_view_state(
    *,
    editing_note_id: Optional[str],
    search: Optional[str],
    sort_mode: str,
    client_known_note_ids: Optional[Set[str]],
    client_seen_root_ids: Optional[Set[str]],
    anchor_root_id: Optional[str],
    is_untagged_view: bool,
) -> ViewState:
    if not isinstance(is_untagged_view, bool):
        raise TypeError("is_untagged_view must be a bool")
    t0 = time.perf_counter()
    structure: List[Dict[str, object]] = []
    payloads: Dict[str, Dict[str, object]] = {}
    children_by_parent: DefaultDict[Optional[str], List[str]] = defaultdict(list)
    hash_by_id: Dict[str, str] = {}

    filter_active = False
    allowed_note_ids: Optional[Set[str]] = None
    filtered_root_ids_ordered: Optional[List[str]] = None
    filtered_root_count_total = 0

    force_uncollapsed_ids: Set[str] = set()
    file_record_cache: Dict[str, object] = {}
    traversal_cache = _SnapshotTraversalCache()

    def _get_file_record(file_id: str) -> object:
        if file_id not in file_record_cache:
            file_record_cache[file_id] = get_file_reference_record(file_id, token=None)
        return file_record_cache[file_id]

    embed_render_context = EmbedRenderContext(
        has_note=note_store.has_note,
        get_note=traversal_cache.get_note,
        get_children=traversal_cache.get_children,
        has_file=file_registry.has_file,
        get_file=_get_file_record,
    )

    normalized_sort_mode = normalize_sort_mode(sort_mode)
    if normalized_sort_mode == "normal":
        ordered_root_ids = traversal_cache.get_children(None)
        root_sort_timestamps: Dict[str, datetime] = {}
    else:
        root_sort_timestamps = get_root_sort_timestamps(normalized_sort_mode)
        ordered_root_ids = get_root_ids_for_sort_mode(
            normalized_sort_mode,
            root_timestamps=root_sort_timestamps,
        )
    root_count_total = len(ordered_root_ids)
    if is_untagged_view:
        search_scope = _apply_untagged_view(
            ordered_root_ids=ordered_root_ids,
        )
    else:
        search_scope = resolve_search_scope(
            search=search,
            editing_note_id=editing_note_id,
            sort_mode=normalized_sort_mode,
            ordered_root_ids=ordered_root_ids,
        )
    if search_scope.search_active:
        filter_active = True
        allowed_note_ids = search_scope.allowed_note_ids
        filtered_root_ids_ordered = search_scope.search_root_ids_ordered
        filtered_root_count_total = search_scope.search_root_count_total

    # Determine root window
    if client_known_note_ids is None:
        client_known_note_ids = set()

    if editing_note_id is not None and note_store.has_note(editing_note_id):
        current = note_store.get_note(editing_note_id)
        while current.parent_id:
            force_uncollapsed_ids.add(current.parent_id)
            current = note_store.get_note(current.parent_id)

    if filter_active:
        if filtered_root_ids_ordered is None:
            filtered_roots = []
        else:
            filtered_roots = filtered_root_ids_ordered
        root_index_map = {rid: idx for idx, rid in enumerate(filtered_roots)}
        seen_root_indices = {
            root_index_map[rid]
            for rid in (client_seen_root_ids if client_seen_root_ids is not None else set())
            if rid in root_index_map
        }

        window_end = _determine_root_window_end(
            filtered_roots,
            root_index_map,
            client_known_note_ids,
            seen_root_indices,
            editing_note_id,
            anchor_root_id,
        )
        if window_end >= 0:
            visible_root_ids_ordered = filtered_roots[: window_end + 1]
        else:
            visible_root_ids_ordered = []
    else:
        root_index_map = {rid: idx for idx, rid in enumerate(ordered_root_ids)}
        seen_root_indices = {
            root_index_map[rid]
            for rid in (client_seen_root_ids if client_seen_root_ids is not None else set())
            if rid in root_index_map
        }
        window_end = _determine_root_window_end(
            ordered_root_ids,
            root_index_map,
            client_known_note_ids,
            seen_root_indices,
            editing_note_id,
            anchor_root_id,
        )
        if window_end >= 0:
            visible_root_ids_ordered = ordered_root_ids[: window_end + 1]
        else:
            visible_root_ids_ordered = []

    def traverse(parent_id: Optional[str]) -> None:
        pending = [(parent_id, visible_root_ids_ordered, index) for index in reversed(range(len(visible_root_ids_ordered)))]
        visited = set()
        while pending:
            parent_id, ids, idx = pending.pop()
            nid = ids[idx]
            if nid in visited:
                raise RuntimeError('Cycle in visible note hierarchy')
            visited.add(nid)
            is_search_redacted = (
                filter_active
                and allowed_note_ids is not None
                and parent_id is not None
                and nid not in allowed_note_ids
            )
            children_by_parent[parent_id].append(nid)
            rec = traversal_cache.get_note(nid)
            assert isinstance(rec.content, str)
            assert isinstance(rec.tags, str)
            assert isinstance(rec.proposed_tags, str)
            collapsed_preview_source = extract_collapsed_preview_source_html(rec.content)
            content_is_collapsible = False
            if collapsed_preview_source != "":
                if collapsed_preview_source_has_media(rec.content):
                    content_is_collapsible = True
                elif collapsed_preview_source_has_image_file_embed(
                    content_html=rec.content,
                    context=embed_render_context,
                ):
                    content_is_collapsible = True
                elif collapsed_preview_source_has_note_embed(
                    content_html=rec.content,
                    context=embed_render_context,
                ):
                    content_is_collapsible = True
                elif collapsed_preview_source_has_hidden_content(rec.content):
                    content_is_collapsible = True
            has_children = bool(traversal_cache.get_children(rec.id))
            is_collapsible = has_children
            if content_is_collapsible:
                is_collapsible = True
            if idx > 0:
                prev_id = ids[idx - 1]
            else:
                prev_id = None
            if idx + 1 < len(ids):
                next_id = ids[idx + 1]
            else:
                next_id = None
            flags = {
                "isCollapsed": bool(rec.is_collapsed),
                "isEditing": bool(editing_note_id == rec.id),
                "hasChildren": has_children,
                "isCollapsible": is_collapsible,
                "searchRedacted": bool(is_search_redacted),
                "listStyle": find_list_style(rec.tags),
                "createdAt": _timestamp_iso(rec, "created_at"),
                "updatedAt": _timestamp_iso(rec, "updated_at"),
            }

            # If a descendant is being edited, force ancestors open so the editing note remains visible.
            if rec.id in force_uncollapsed_ids:
                flags["isCollapsed"] = False

            proposal_count = len(rec.proposed_tag_terms)
            if flags["isCollapsed"]:
                proposal_scope = None
                if filter_active:
                    proposal_scope = allowed_note_ids
                proposal_count = traversal_cache.count_proposals_in_subtree(
                    rec.id,
                    allowed_note_ids=proposal_scope,
                )
            flags["proposalCount"] = proposal_count

            is_editing = bool(flags["isEditing"])
            if is_editing:
                rendered_content = rec.content
            else:
                if flags["isCollapsed"]:
                    rendered_content = render_collapsed_note_content_with_embeds(
                        note_id=rec.id,
                        content_html=rec.content,
                        tags=rec.tags,
                        context=embed_render_context,
                        static_export=False,
                        redact_passwords=False,
                    )
                else:
                    rendered_content = render_note_content_with_embeds(
                        note_id=rec.id,
                        content_html=rec.content,
                        tags=rec.tags,
                        context=embed_render_context,
                        static_export=False,
                        redact_passwords=False,
                    )

                rendered_content = decorate_note_references(
                    note_id=rec.id, content_html=rec.content, tags=rec.tags,
                    rendered_content=rendered_content, context=embed_render_context,
                    has_backlinks=note_store.has_backlinks(rec.id),
                )

            h = _compute_hash(
                rendered_content,
                rec.tags,
                rec.proposed_tags,
                flags,
                parent_id,
                prev_id,
                next_id,
            )
            structure.append({
                "id": rec.id,
                "parentId": parent_id,
                "prevId": prev_id,
                "nextId": next_id,
                "hash": h,
            })
            payloads[rec.id] = {
                "content": rendered_content,
                "tags": rec.tags,
                "proposedTags": rec.proposed_tags,
                "flags": flags,
                "metadata": traversal_cache.build_metadata(rec.id),
                "hash": h,
            }
            hash_by_id[rec.id] = h
            if rec.id in force_uncollapsed_ids:
                child_ids = traversal_cache.get_children(rec.id)
                pending.extend((rec.id, child_ids, index) for index in reversed(range(len(child_ids))))
            elif not flags["isCollapsed"]:
                child_ids = traversal_cache.get_children(rec.id)
                pending.extend((rec.id, child_ids, index) for index in reversed(range(len(child_ids))))

    traverse(None)
    visible_ids = {entry["id"] for entry in structure}
    locks: Dict[str, str] = {
        note_id: owner for note_id, owner in get_all_locks().items() if note_id in visible_ids
    }
    if None in children_by_parent:
        visible_root_ids = list(children_by_parent[None])
    else:
        visible_root_ids = []

    metadata = {
        "editingNoteId": editing_note_id,
        "search": search,
        "sortMode": normalized_sort_mode,
        "isUntaggedView": is_untagged_view,
        "rootCountTotal": root_count_total,
        "searchRootCountTotal": filtered_root_count_total,
        "rootSortBuckets": build_root_sort_buckets(
            visible_root_ids,
            normalized_sort_mode,
            root_timestamps=root_sort_timestamps,
        ),
    }

    if filter_active:
        elapsed_ms = (time.perf_counter() - t0) * 1000
        logger.bind(
            metrics={
                "elapsed_ms": elapsed_ms,
                "structure_count": len(structure),
                "payload_count": len(payloads),
                "root_count": len(children_by_parent[None]) if None in children_by_parent else 0,
            },
        ).info("notes.view_state.finish")

    return ViewState(
        structure=structure,
        payloads=payloads,
        locks=locks,
        children_by_parent={key: value[:] for key, value in children_by_parent.items()},
        hash_by_id=hash_by_id,
        metadata=metadata,
    )


def build_view_snapshot(
    *,
    editing_note_id: Optional[str],
    search: Optional[str],
    sort_mode: str,
    client_known_note_ids: Optional[Set[str]],
    client_seen_root_ids: Optional[Set[str]],
    anchor_root_id: Optional[str],
    is_untagged_view: bool,
) -> Tuple[List[Dict[str, object]], Dict[str, Dict[str, object]], Dict[str, str]]:
    state = build_view_state(
        editing_note_id=editing_note_id,
        search=search,
        sort_mode=sort_mode,
        client_known_note_ids=client_known_note_ids,
        client_seen_root_ids=client_seen_root_ids,
        anchor_root_id=anchor_root_id,
        is_untagged_view=is_untagged_view,
    )
    return state.structure, state.payloads, state.locks
