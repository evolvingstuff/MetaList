from __future__ import annotations

from app.utils.byte_sizes import MIB
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
import re
import time
from typing import Dict, List, Optional, Tuple, Set

from loguru import logger

from app.services.content_formatting import COMMENT_CLOSE, COMMENT_OPEN, find_list_style
from app.services.content_formatting import recording_link_title_fetches
from app.services.content_formatting import replay_link_title_fetches
from app.services.embedded_references import EmbedRenderContext
from app.services.embedded_references import is_content_collapsible
from app.services.embedded_references import resolve_held_source
from app.services.embedded_references import render_collapsed_note_content_with_embeds
from app.services.embedded_references import render_note_content_with_embeds
from app.services.file_registry import file_registry
from app.services.file_storage import get_file_reference_record
from app.services.find_text import count_occurrences, read_comment_text, read_visible_text
from app.services.link_titles import link_title_store
from app.services.note_store import NoteRecord, store as note_store
from app.services.ontology_rules_store import get_ontology_if_ready
from app.services.reference_presentation import decorate_note_references
from app.services.inline_image_dimensions import add_inline_image_dimensions
from app.services.root_sorting import build_root_sort_buckets
from app.services.root_sorting import get_root_ids_for_sort_mode
from app.services.root_sorting import get_root_sort_timestamps
from app.services.root_sorting import normalize_sort_mode
from app.services.root_date_filter import RootDateFilter, filter_root_ids_by_date, local_today
from app.services.search_index import search_index
from app.services.search_query import ParsedSearchQuery, SearchClause, parse_search_query, search_highlight_phrases
from app.services.tag_properties import PropertyCondition
from app.services.sync import get_all_locks
from app.services.view_state import ViewState
from app.services.editing_image_sizes import editing_image_size_factors
from app.security.rendered_html import sanitize_rendered_html
from app.security.sensitive_cache import SensitiveMemo
from app.utils.text_utils import strip_html
from app.utils.time_units import MS_PER_SECOND

# Windowing constants (tuned later)
# The window is a band of roots around the ones the browser can see: this many
# beyond the top and bottom visible roots. An edge stays put while it is
# between half and twice this far from the visible roots, so ordinary
# scrolling changes nothing and unloading happens far from the viewport.
ROOT_BAND_MARGIN = 75
# The backlinks button (↖) on notes that are referenced; see _shows_backlinks_button.
SHOWS_BACKLINKS_BUTTON = False
# "Between half and twice": the near edge is the margin divided by this, the
# far edge the margin times this.
_BAND_EDGE_HOLD_FACTOR = 2
# A root has a neighbour only in a list of at least this many roots.
_MIN_ROOTS_WITH_NEIGHBOUR = 2
_UUID_IN_TEXT_RE = re.compile(
    r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)


@dataclass(frozen=True)
class SearchScope:
    search_active: bool
    allowed_note_ids: Optional[Set[str]]
    search_root_ids_ordered: Optional[List[str]]
    search_root_count_total: int
    matched_note_ids: Optional[Set[str]]


@dataclass(frozen=True, slots=True)
class ResolvedViewScope:
    """Canonical, explicit note membership for one complete MetaList view."""

    filter_active: bool
    allowed_note_ids: frozenset[str]
    matched_note_ids: frozenset[str]
    ordered_root_ids: tuple[str, ...]
    total_root_count: int


def _structure_part(note_id: Optional[str]) -> str:
    """A link in a note's structure hash: its id, or nothing for no note."""
    if note_id is None:
        return ""
    assert isinstance(note_id, str)
    return note_id


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


def view_search_highlight_phrases(search: Optional[str]) -> List[str]:
    """The quoted phrases the browser highlights in this view's notes; none without a search."""
    if search is None:
        return []
    if not isinstance(search, str):
        raise TypeError(f"search must be a string or null, got {type(search)}")
    return list(search_highlight_phrases(parse_search_query(search)))


def _has_search_terms(parsed: ParsedSearchQuery) -> bool:
    return any(
        clause.required_tags
        or clause.forbidden_tags
        or clause.required_text
        or clause.forbidden_text
        or clause.has_property_terms
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
        required_properties=(),
        forbidden_properties=(),
    )


def _positive_property_clause(condition: PropertyCondition) -> SearchClause:
    return SearchClause(
        required_tags=frozenset(),
        forbidden_tags=frozenset(),
        required_text=(),
        forbidden_text=(),
        required_properties=(condition,),
        forbidden_properties=(),
    )


def _positive_text_clause(phrase: str) -> SearchClause:
    return SearchClause(
        required_tags=frozenset(),
        forbidden_tags=frozenset(),
        required_text=(phrase,),
        forbidden_text=(),
        required_properties=(),
        forbidden_properties=(),
    )


def _resolve_clause_note_sets(
    *,
    clause: SearchClause,
    ordered_root_ids: List[str],
) -> Tuple[Set[str], Set[str]]:
    has_positive_terms = bool(clause.required_tags)
    if clause.required_text or clause.required_properties:
        has_positive_terms = True
    direct_uuid_note_ids = _extract_direct_uuid_note_ids(clause)

    if has_positive_terms:
        positively_matched_note_ids = set(search_index.query_clause_note_ids(clause))
    else:
        # Exclusion-only clause: every root and all its descendants is every
        # note (the store keeps all notes reachable from a root), so take the
        # ids directly instead of walking the whole tree.
        assert len(ordered_root_ids) == len(note_store.get_children(None)), "clauses resolve against all roots"
        positively_matched_note_ids = set(note_store.list_note_ids())

    positively_matched_note_ids.update(direct_uuid_note_ids)
    allowed_note_ids = set(positively_matched_note_ids)

    excluded_note_ids: Set[str] = set()
    for tag in clause.forbidden_tags:
        excluded_note_ids.update(search_index.query_clause_note_ids(_positive_tag_clause(tag)))
    for phrase in clause.forbidden_text:
        excluded_note_ids.update(search_index.query_clause_note_ids(_positive_text_clause(phrase)))
    for condition in clause.forbidden_properties:
        # -jogging:miles=MAX removes the longest of the notes the clause finds.
        excluding_clause = _positive_property_clause(condition)
        if condition.is_extreme:
            excluding_clause = clause.requiring(condition)
        excluded_note_ids.update(search_index.query_clause_note_ids(excluding_clause))

    # With every note already allowed, ancestor/descendant closure is a no-op.
    if has_positive_terms:
        _include_ancestors(allowed_note_ids, starting_ids=set(allowed_note_ids))
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
    date_filter: RootDateFilter | None,
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
        ordered_root_ids = _ordered_view_root_ids(normalized_sort_mode, date_filter)
    search_allowed_note_ids: Set[str] = set()
    positively_matched_note_ids: Set[str] = set()
    for clause in parsed.clauses:
        clause_allowed_note_ids, clause_matched_note_ids = _resolve_clause_note_sets(
            clause=clause,
            ordered_root_ids=ordered_root_ids,
        )
        search_allowed_note_ids.update(clause_allowed_note_ids)
        positively_matched_note_ids.update(clause_matched_note_ids)

    if date_filter is not None:
        # Only notes under the roots the date range keeps.
        kept_note_ids = _note_ids_under_roots(ordered_root_ids)
        search_allowed_note_ids &= kept_note_ids
        positively_matched_note_ids &= kept_note_ids
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


def _ordered_view_root_ids(normalized_sort_mode: str, date_filter: RootDateFilter | None) -> List[str]:
    """The roots a view lists, in its order, kept to the date range when it has one."""
    if normalized_sort_mode == "normal":
        ordered_root_ids = note_store.get_children(None)
    else:
        ordered_root_ids = get_root_ids_for_sort_mode(
            normalized_sort_mode,
            root_timestamps=get_root_sort_timestamps(normalized_sort_mode),
        )
    if date_filter is None:
        return ordered_root_ids
    return filter_root_ids_by_date(ordered_root_ids, date_filter, today=local_today())


def _note_ids_under_roots(root_ids: List[str]) -> Set[str]:
    note_ids = set(root_ids)
    _include_descendants(note_ids, starting_ids=set(root_ids))
    return note_ids


def resolve_view_scope_membership(
    *,
    search: str,
    sort_mode: str,
    date_filter: RootDateFilter | None,
    is_untagged_view: bool,
) -> ResolvedViewScope:
    """Resolve evidence membership using the same rules as ``/notes/view``.

    ``matched_note_ids`` contains only evidence-bearing matches. The separate
    ``allowed_note_ids`` set may additionally contain ancestors required to render
    the hierarchy. Broader agent investigation uses matches only; selected-tree
    context may include these visible ancestors, but never search-redacted nodes
    outside ``allowed_note_ids``. Privacy filtering applies independently.
    """
    if not isinstance(search, str):
        raise TypeError("search must be a string")
    if not isinstance(is_untagged_view, bool):
        raise TypeError("is_untagged_view must be a bool")
    normalized_sort_mode = normalize_sort_mode(sort_mode)
    ordered_root_ids = _ordered_view_root_ids(normalized_sort_mode, date_filter)
    if is_untagged_view:
        search_scope = _apply_untagged_view(ordered_root_ids=ordered_root_ids)
    else:
        search_scope = resolve_search_scope(
            search=search,
            editing_note_id=None,
            sort_mode=normalized_sort_mode,
            date_filter=date_filter,
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
    elif date_filter is not None:
        # No search: every note under the roots the date range keeps.
        filter_active = True
        allowed_note_ids = _note_ids_under_roots(ordered_root_ids)
        matched_note_ids = set(allowed_note_ids)
        scoped_root_ids = list(ordered_root_ids)
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
    parts = [_structure_part(parent_id), _structure_part(prev_id), _structure_part(next_id)]
    sha.update("::".join(parts).encode("utf-8"))
    return sha.hexdigest()


def _root_id_of_note(note_id: str, traversal_cache: "_SnapshotTraversalCache") -> Optional[str]:
    if not note_store.has_note(note_id):
        return None
    current = traversal_cache.get_note(note_id)
    visited: Set[str] = set()
    while current.parent_id is not None:
        if current.id in visited:
            raise RuntimeError(f"Cycle in note ancestry for {note_id}")
        visited.add(current.id)
        current = traversal_cache.get_note(current.parent_id)
    return current.id


def _root_index_of_note(
    note_id: str, root_index_map: Dict[str, int], traversal_cache: "_SnapshotTraversalCache",
) -> Optional[int]:
    root_id = _root_id_of_note(note_id, traversal_cache)
    if root_id is None or root_id not in root_index_map:
        return None
    return root_index_map[root_id]


def keep_edited_root_in_place(
    roots: List[str], edited_root_id: str, previous_root_ids: List[str],
) -> List[str]:
    """Sorted roots with the edited note's root kept where the tab last showed it.

    While a note is edited in a sorted tab, the root containing it stays right
    after the nearest earlier root of the tab's previous view (or right before
    the nearest later one) that is still listed, instead of jumping to its new
    sorted place on every save. Unchanged when the root was not shown before
    (e.g. just created) or is not listed (e.g. filtered out by a search).
    """
    if edited_root_id not in previous_root_ids or edited_root_id not in roots:
        return roots
    others = [root_id for root_id in roots if root_id != edited_root_id]
    listed = set(others)
    position = previous_root_ids.index(edited_root_id)
    for earlier in reversed(previous_root_ids[:position]):
        if earlier in listed:
            index = others.index(earlier) + 1
            return others[:index] + [edited_root_id] + others[index:]
    for later in previous_root_ids[position + 1:]:
        if later in listed:
            index = others.index(later)
            return others[:index] + [edited_root_id] + others[index:]
    return roots


def _keep_or_move_edge(*, current: int, near: int, far: int, target: int) -> int:
    """Keep an existing band edge while it sits between near and far, else move it to target."""
    low, high = min(near, far), max(near, far)
    if low <= current <= high:
        return current
    return target


def _determine_root_band(
    *,
    ordered_root_ids: List[str],
    root_index_map: Dict[str, int],
    client_known_note_ids: Set[str],
    visible_top_root_id: Optional[str],
    visible_bottom_root_id: Optional[str],
    editing_root_index: Optional[int],
    start_at_list_end: bool,
) -> Tuple[int, int]:
    """Inclusive [start, end] root indices of the window; (0, -1) when there are no roots."""
    if not isinstance(start_at_list_end, bool):
        raise TypeError("start_at_list_end must be a bool")
    last = len(ordered_root_ids) - 1
    if last < 0:
        return 0, -1
    margin = ROOT_BAND_MARGIN
    if start_at_list_end:
        # Go to Bottom: the band ends at the last root, whatever was loaded before.
        assert editing_root_index is None, "Go to Bottom leaves edit mode before asking for the list end"
        return max(0, last - margin), last
    current_indices = [root_index_map[note_id] for note_id in client_known_note_ids if note_id in root_index_map]
    visible = [
        root_index_map[root_id]
        for root_id in (visible_top_root_id, visible_bottom_root_id)
        if root_id is not None and root_id in root_index_map
    ]
    if visible:
        top, bottom = min(visible), max(visible)
        target_start, target_end = max(0, top - margin), min(last, bottom + margin)
        if current_indices:
            start = _keep_or_move_edge(
                current=min(current_indices), near=max(0, top - margin // _BAND_EDGE_HOLD_FACTOR),
                far=max(0, top - _BAND_EDGE_HOLD_FACTOR * margin), target=target_start,
            )
            end = _keep_or_move_edge(
                current=max(current_indices), near=min(last, bottom + margin // _BAND_EDGE_HOLD_FACTOR),
                far=min(last, bottom + _BAND_EDGE_HOLD_FACTOR * margin), target=target_end,
            )
        else:
            start, end = target_start, target_end
    elif current_indices:
        # No viewport report (e.g. a refresh after an action): keep the band.
        start, end = min(current_indices), max(current_indices)
    else:
        start, end = 0, min(last, margin)
    if editing_root_index is not None and not start <= editing_root_index <= end:
        # The edited note is what the user is looking at; centre on it.
        start, end = max(0, editing_root_index - margin), min(last, editing_root_index + margin)
    assert 0 <= start <= end <= last
    return start, end


def _timestamp_iso(record: object, field_name: str) -> str:
    timestamp = getattr(record, field_name)
    if not isinstance(timestamp, datetime):
        return ""
    return timestamp.isoformat()


class _SnapshotTraversalCache:
    """Request-local hierarchy cache shared by rendering and metadata building."""

    def __init__(self) -> None:
        self._children_by_parent: Dict[Optional[str], List[str]] = {}
        self._record_by_id: Dict[str, NoteRecord] = {}
        self._proposal_subtree_count_by_id: Dict[str, int] = {}

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        if parent_id not in self._children_by_parent:
            self._children_by_parent[parent_id] = note_store.get_children(parent_id)
        return self._children_by_parent[parent_id]

    def get_note(self, note_id: str) -> NoteRecord:
        if note_id not in self._record_by_id:
            self._record_by_id[note_id] = note_store.get_note(note_id)
        return self._record_by_id[note_id]

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


@dataclass(frozen=True)
class _ViewSelection:
    sort_mode: str
    root_timestamps: Dict[str, datetime]
    root_count: int
    scope: SearchScope
    visible_roots: List[str]
    forced_open_ids: Set[str]
    window_start: int
    root_before_window: Optional[str]


def _share_neighbour_timestamp(
    roots: List[str], edited_root_id: str, root_sort_timestamps: Dict[str, datetime],
) -> Dict[str, datetime]:
    """Date-bucketed sorts: a root held in place shows under its neighbour's date header."""
    if edited_root_id not in root_sort_timestamps or edited_root_id not in roots or len(roots) < _MIN_ROOTS_WITH_NEIGHBOUR:
        return root_sort_timestamps
    index = roots.index(edited_root_id)
    if index > 0:
        neighbour = roots[index - 1]
    else:
        neighbour = roots[index + 1]
    shared = dict(root_sort_timestamps)
    shared[edited_root_id] = root_sort_timestamps[neighbour]
    return shared


def _ancestor_ids(note_id: str, traversal_cache: _SnapshotTraversalCache) -> Set[str]:
    ancestor_ids: Set[str] = set()
    current = traversal_cache.get_note(note_id)
    while current.parent_id is not None:
        if current.parent_id in ancestor_ids:
            raise RuntimeError("Cycle in note ancestry")
        ancestor_ids.add(current.parent_id)
        current = traversal_cache.get_note(current.parent_id)
    return ancestor_ids


def _roots_in_date_range(
    ordered_root_ids: List[str], date_filter: RootDateFilter | None, *, editing_note_id: str | None,
    traversal_cache: "_SnapshotTraversalCache",
) -> List[str]:
    """The roots the date range keeps (all of them without one), in order. The note being
    edited stays while it is edited, also when saving it (or adding it, today) put its
    date outside the range."""
    if date_filter is None:
        return ordered_root_ids
    kept_root_ids = set(filter_root_ids_by_date(ordered_root_ids, date_filter, today=local_today()))
    if editing_note_id is not None:
        edited_root_id = _root_id_of_note(editing_note_id, traversal_cache)
        if edited_root_id is not None:
            kept_root_ids.add(edited_root_id)
    return [root_id for root_id in ordered_root_ids if root_id in kept_root_ids]


def _select_view(
    *, editing_note_id: str | None, find_reveal_note_id: str | None, search: str | None, sort_mode: str,
    date_filter: RootDateFilter | None, client_known_note_ids: Set[str], previous_root_ids: List[str], visible_top_root_id: str | None,
    visible_bottom_root_id: str | None, is_untagged_view: bool, start_at_list_end: bool,
    traversal_cache: _SnapshotTraversalCache,
) -> _ViewSelection:
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
    ordered_root_ids = _roots_in_date_range(
        ordered_root_ids, date_filter, editing_note_id=editing_note_id, traversal_cache=traversal_cache,
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
            date_filter=date_filter,
            ordered_root_ids=ordered_root_ids,
        )


    forced_open_ids: Set[str] = set()
    if editing_note_id is not None and note_store.has_note(editing_note_id):
        forced_open_ids |= _ancestor_ids(editing_note_id, traversal_cache)
    # Find shows a match folded away by opening the note and the notes above it for
    # this view only; their saved collapse stays (docs/ui/find.md).
    if find_reveal_note_id is not None and note_store.has_note(find_reveal_note_id):
        forced_open_ids |= _ancestor_ids(find_reveal_note_id, traversal_cache) | {find_reveal_note_id}

    roots = ordered_root_ids
    if search_scope.search_active:
        assert search_scope.search_root_ids_ordered is not None
        assert search_scope.allowed_note_ids is not None
        roots = search_scope.search_root_ids_ordered
    if normalized_sort_mode != "normal" and editing_note_id is not None:
        edited_root_id = _root_id_of_note(editing_note_id, traversal_cache)
        if edited_root_id is not None:
            roots = keep_edited_root_in_place(roots, edited_root_id, previous_root_ids)
            root_sort_timestamps = _share_neighbour_timestamp(roots, edited_root_id, root_sort_timestamps)
    root_index = {root_id: index for index, root_id in enumerate(roots)}
    editing_root_index = None
    if editing_note_id is not None:
        editing_root_index = _root_index_of_note(editing_note_id, root_index, traversal_cache)
    window_start, window_end = _determine_root_band(
        ordered_root_ids=roots, root_index_map=root_index, client_known_note_ids=client_known_note_ids,
        visible_top_root_id=visible_top_root_id, visible_bottom_root_id=visible_bottom_root_id,
        editing_root_index=editing_root_index, start_at_list_end=start_at_list_end,
    )
    root_before_window = None
    if window_start > 0:
        root_before_window = roots[window_start - 1]
    return _ViewSelection(
        normalized_sort_mode, root_sort_timestamps, root_count_total, search_scope,
        roots[window_start:window_end + 1], forced_open_ids, window_start, root_before_window,
    )


# Rendered view HTML reads shared state only through the render context
# (other notes, their children, files), link titles, the ontology, and
# remote-image proxy tokens. The cache key pins the note record, collapse
# state, backlink presence, ontology, and link-title render generation; every
# context lookup a render makes is recorded and re-checked before reuse, and
# the link-title fetches it requested are replayed. Proxy tokens are random and
# evictable, so renders that use them are never cached: notes whose own
# content has a literal URL image source are skipped up front, and renders
# that still emitted a proxy source (e.g. from an embedded note) are not stored.
_REMOTE_IMAGE_PROXY_MARKER = "data-remote-image-proxy-src="
_VIEW_RENDER_MEMO_ENTRIES = 65536
_VIEW_RENDER_MEMO_MIB = 64
_VIEW_RENDER_MEMO = SensitiveMemo(maxsize=_VIEW_RENDER_MEMO_ENTRIES, max_bytes=_VIEW_RENDER_MEMO_MIB * MIB)


def _is_render_cacheable(content_html: str) -> bool:
    return not ("://" in content_html and "<img" in content_html.lower())


class _IdentityKey:
    """Cache-key part matching only the very same object.

    The strong reference keeps the object alive, so its id cannot be reused
    by another object while a cache entry holds this key.
    """

    __slots__ = ("value",)

    def __init__(self, value: object) -> None:
        self.value = value

    def __hash__(self) -> int:
        return id(self.value)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, _IdentityKey) and other.value is self.value


@dataclass(frozen=True)
class _RenderDependencies:
    note_presence: Tuple[Tuple[str, bool], ...]
    note_records: Tuple[Tuple[str, _IdentityKey], ...]
    children: Tuple[Tuple[Optional[str], Tuple[str, ...]], ...]
    file_presence: Tuple[Tuple[str, bool], ...]
    file_records: Tuple[Tuple[str, object], ...]


class _DependencyRecorder:
    """Render context that forwards to the live context and records each lookup."""

    def __init__(self, live: EmbedRenderContext) -> None:
        self._live = live
        self._note_presence: Dict[str, bool] = {}
        self._note_records: Dict[str, _IdentityKey] = {}
        self._children: Dict[Optional[str], Tuple[str, ...]] = {}
        self._file_presence: Dict[str, bool] = {}
        self._file_records: Dict[str, object] = {}

    def context(self) -> EmbedRenderContext:
        return EmbedRenderContext(
            has_note=self._has_note, get_note=self._get_note, get_children=self._get_children,
            has_file=self._has_file, get_file=self._get_file, static_collapse_arrows=False,
        )

    def _has_note(self, note_id: str) -> bool:
        present = self._live.has_note(note_id)
        self._note_presence[note_id] = present
        return present

    def _get_note(self, note_id: str) -> object:
        record = self._live.get_note(note_id)
        self._note_records[note_id] = _IdentityKey(record)
        return record

    def _get_children(self, parent_id: Optional[str]) -> List[str]:
        child_ids = self._live.get_children(parent_id)
        self._children[parent_id] = tuple(child_ids)
        return child_ids

    def _has_file(self, file_id: str) -> bool:
        present = self._live.has_file(file_id)
        self._file_presence[file_id] = present
        return present

    def _get_file(self, file_id: str) -> object:
        record = self._live.get_file(file_id)
        self._file_records[file_id] = record
        return record

    def freeze(self) -> _RenderDependencies:
        return _RenderDependencies(
            note_presence=tuple(self._note_presence.items()),
            note_records=tuple(self._note_records.items()),
            children=tuple(self._children.items()),
            file_presence=tuple(self._file_presence.items()),
            file_records=tuple(self._file_records.items()),
        )


def _dependencies_hold(dependencies: _RenderDependencies, live: EmbedRenderContext) -> bool:
    for note_id, present in dependencies.note_presence:
        if live.has_note(note_id) != present:
            return False
    for note_id, record_key in dependencies.note_records:
        if not live.has_note(note_id) or live.get_note(note_id) is not record_key.value:
            return False
    for parent_id, child_ids in dependencies.children:
        if parent_id is not None and not live.has_note(parent_id):
            return False
        if tuple(live.get_children(parent_id)) != child_ids:
            return False
    for file_id, present in dependencies.file_presence:
        if live.has_file(file_id) != present:
            return False
    for file_id, file_record in dependencies.file_records:
        if not live.has_file(file_id) or live.get_file(file_id) != file_record:
            return False
    return True


@dataclass(frozen=True)
class _CachedViewRender:
    html: str
    fetch_urls: Tuple[str, ...]
    dependencies: _RenderDependencies


def _render_note_view_html(
    *, rec: NoteRecord, is_collapsed: bool, has_backlinks: bool, context: EmbedRenderContext,
) -> str:
    if is_collapsed:
        rendered_content = render_collapsed_note_content_with_embeds(
            note_id=rec.id,
            content_html=rec.content,
            tags=rec.tags,
            context=context,
            static_export=False,
            redact_credentials=False,
        )
    else:
        rendered_content = render_note_content_with_embeds(
            note_id=rec.id,
            content_html=rec.content,
            tags=rec.tags,
            context=context,
            static_export=False,
            redact_credentials=False,
        )
    # Sized inline images keep their space while decoding, so text below them
    # does not move after the note renders.
    rendered_content = add_inline_image_dimensions(rendered_content)
    return sanitize_rendered_html(decorate_note_references(
        note_id=rec.id, content_html=rec.content, tags=rec.tags,
        rendered_content=rendered_content, context=context,
        has_backlinks=has_backlinks,
    ))


def _cached_note_view_html(
    *, rec: NoteRecord, is_collapsed: bool, has_backlinks: bool, context: EmbedRenderContext,
) -> str:
    # NoteRecord is immutable and replaced on every change, so its identity
    # pins content, tags, and every other field; the ontology object is
    # likewise replaced whenever rules change.
    assert type(rec) is NoteRecord
    assert _is_render_cacheable(rec.content)
    key = (
        _IdentityKey(rec), is_collapsed, has_backlinks,
        _IdentityKey(get_ontology_if_ready()), link_title_store.get_render_generation(),
    )
    found, cached = _VIEW_RENDER_MEMO.lookup(key)
    if found and _dependencies_hold(cached.dependencies, context):
        # A fresh render requests these fetches every time (first lookups and
        # backoff retries); repeating a request is a no-op while in flight.
        replay_link_title_fetches(cached.fetch_urls)
        return cached.html

    recorder = _DependencyRecorder(context)
    with recording_link_title_fetches() as fetch_urls:
        rendered = _render_note_view_html(
            rec=rec, is_collapsed=is_collapsed, has_backlinks=has_backlinks,
            context=recorder.context(),
        )
    if _REMOTE_IMAGE_PROXY_MARKER not in rendered:
        _VIEW_RENDER_MEMO.store(key, _CachedViewRender(rendered, tuple(fetch_urls), recorder.freeze()))
    return rendered


def _sort_key_before_window(selection: _ViewSelection) -> str:
    if selection.root_before_window is None:
        return ""
    buckets = build_root_sort_buckets(
        [selection.root_before_window], selection.sort_mode, root_timestamps=selection.root_timestamps,
    )
    if selection.root_before_window not in buckets:
        return ""
    return buckets[selection.root_before_window]["key"]


def _is_shown_collapsed(rec: NoteRecord, context: EmbedRenderContext) -> bool:
    """Whether the list shows the note folded. A note that is only a reference shows its
    source's collapse (it folds as the source does, wherever that is folded)."""
    shown_state_id = resolve_held_source(
        rec.id, has_note=context.has_note,
        content_of=lambda note_id: context.get_note(note_id).content,
    )
    if shown_state_id != rec.id:
        return bool(context.get_note(shown_state_id).is_collapsed)
    return bool(rec.is_collapsed)


def _shows_backlinks_button(note_id: str) -> bool:
    """Whether the note gets the backlinks button (↖). Off for now: an arrow pointing
    back reads as "back to where I came from", which it is not; backlinks need
    another visual metaphor before they return (docs/ui/references.md)."""
    return SHOWS_BACKLINKS_BUTTON and note_store.has_backlinks(note_id)


def _render_note_content_html(rec: NoteRecord, *, is_collapsed: bool, context: EmbedRenderContext) -> str:
    """A note's content as the list shows it when it is not being edited."""
    has_backlinks = _shows_backlinks_button(rec.id)
    if type(rec) is NoteRecord and _is_render_cacheable(rec.content):
        # Identity keys are exact only for immutable records; any other record
        # type (e.g. test doubles) could change in place and renders directly.
        return _cached_note_view_html(
            rec=rec, is_collapsed=is_collapsed, has_backlinks=has_backlinks, context=context,
        )
    return _render_note_view_html(
        rec=rec, is_collapsed=is_collapsed, has_backlinks=has_backlinks, context=context,
    )


def _render_view_note(
    rec: NoteRecord, *, editing_note_id: str | None, is_search_redacted: bool,
    force_uncollapsed_ids: Set[str], filter_active: bool,
    allowed_note_ids: Set[str] | None, traversal_cache: _SnapshotTraversalCache,
    embed_render_context: EmbedRenderContext,
) -> Tuple[str, Dict[str, object]]:
    assert isinstance(rec.content, str)
    assert isinstance(rec.tags, str)
    assert isinstance(rec.proposed_tags, str)
    content_is_collapsible = is_content_collapsible(content_html=rec.content, context=embed_render_context)
    has_children = bool(traversal_cache.get_children(rec.id))
    is_collapsible = has_children
    if content_is_collapsible:
        is_collapsible = True
    flags = {
        "isCollapsed": _is_shown_collapsed(rec, embed_render_context),
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
    # Proposals no note has yet: accepting one creates a new tag, so the row marks them.
    flags["newProposedTags"] = " ".join(
        term for term in rec.proposed_tags.split() if not search_index.is_tag_on_any_note(term)
    )

    is_editing = bool(flags["isEditing"])
    if is_editing:
        rendered_content = rec.content
        # The editor shows each image at its size from the start (docs/ui/content-formatting.md).
        flags["editingImageSizes"] = editing_image_size_factors(content_html=rec.content, tags=rec.tags)
    else:
        rendered_content = _render_note_content_html(
            rec, is_collapsed=bool(flags["isCollapsed"]), context=embed_render_context,
        )

    return rendered_content, flags


def _new_embed_render_context(traversal_cache: _SnapshotTraversalCache) -> EmbedRenderContext:
    file_record_cache: Dict[str, object] = {}

    def _get_file_record(file_id: str) -> object:
        if file_id not in file_record_cache:
            file_record_cache[file_id] = get_file_reference_record(file_id, token=None)
        return file_record_cache[file_id]

    return EmbedRenderContext(
        has_note=note_store.has_note,
        get_note=traversal_cache.get_note,
        get_children=traversal_cache.get_children,
        has_file=file_registry.has_file,
        get_file=_get_file_record,
        static_collapse_arrows=False,
    )


def build_view_state(
    *,
    editing_note_id: Optional[str],
    find_reveal_note_id: Optional[str],
    search: Optional[str],
    sort_mode: str,
    date_filter: RootDateFilter | None,
    client_known_note_ids: Set[str],
    previous_root_ids: List[str],
    visible_top_root_id: Optional[str],
    visible_bottom_root_id: Optional[str],
    is_untagged_view: bool,
    start_at_list_end: bool,
) -> ViewState:
    if not isinstance(is_untagged_view, bool):
        raise TypeError("is_untagged_view must be a bool")
    t0 = time.perf_counter()
    structure: List[Dict[str, object]] = []
    payloads: Dict[str, Dict[str, object]] = {}
    children_by_parent: Dict[Optional[str], List[str]] = {}
    hash_by_id: Dict[str, str] = {}

    traversal_cache = _SnapshotTraversalCache()
    embed_render_context = _new_embed_render_context(traversal_cache)

    selection = _select_view(
        editing_note_id=editing_note_id, find_reveal_note_id=find_reveal_note_id, search=search, sort_mode=sort_mode,
        date_filter=date_filter, client_known_note_ids=client_known_note_ids, previous_root_ids=previous_root_ids,
        visible_top_root_id=visible_top_root_id,
        visible_bottom_root_id=visible_bottom_root_id, is_untagged_view=is_untagged_view,
        start_at_list_end=start_at_list_end, traversal_cache=traversal_cache,
    )
    filter_active = selection.scope.search_active
    allowed_note_ids = selection.scope.allowed_note_ids
    visible_root_ids_ordered = selection.visible_roots
    force_uncollapsed_ids = selection.forced_open_ids

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
            if parent_id not in children_by_parent:
                children_by_parent[parent_id] = []
            children_by_parent[parent_id].append(nid)
            rec = traversal_cache.get_note(nid)
            if idx > 0:
                prev_id = ids[idx - 1]
            else:
                prev_id = None
            if idx + 1 < len(ids):
                next_id = ids[idx + 1]
            else:
                next_id = None
            rendered_content, flags = _render_view_note(
                rec, editing_note_id=editing_note_id, is_search_redacted=is_search_redacted,
                force_uncollapsed_ids=force_uncollapsed_ids, filter_active=filter_active,
                allowed_note_ids=allowed_note_ids, traversal_cache=traversal_cache,
                embed_render_context=embed_render_context,
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
                # The client reads only the timestamps (note-timestamp-hover-service), already formatted in flags.
                "metadata": {"createdAt": flags["createdAt"], "updatedAt": flags["updatedAt"]},
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

    metadata: Dict[str, object] = {
        "editingNoteId": editing_note_id,
        "search": search,
        "searchHighlightPhrases": view_search_highlight_phrases(search),
        "sortMode": selection.sort_mode,
        "isUntaggedView": is_untagged_view,
        "rootCountTotal": selection.root_count,
        "searchRootCountTotal": selection.scope.search_root_count_total,
        "rootSortBuckets": build_root_sort_buckets(
            visible_root_ids,
            selection.sort_mode,
            root_timestamps=selection.root_timestamps,
        ),
        # Index of the first windowed root among all roots in this view, and
        # the date bucket just above the window, so the browser knows what lies
        # beyond each edge and only starts a date header where the day changes.
        "rootWindowStart": selection.window_start,
        "rootBandMargin": ROOT_BAND_MARGIN,
        "rootSortKeyBeforeWindow": _sort_key_before_window(selection),
    }

    if filter_active:
        elapsed_ms = (time.perf_counter() - t0) * MS_PER_SECOND
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


# Find in the list (docs/ui/find.md). One step reads whole roots in list order from a
# root position and stops after the root in which this many notes had a match, so a
# common word renders a few notes per step, never the whole list.
FIND_WINDOW_MATCHED_NOTES = 50
FIND_DIRECTIONS = ("forward", "backward")


@dataclass(frozen=True, slots=True)
class FindMatch:
    """A note the find's text occurs in. Its occurrences, in page order, are those of its
    content (content_count) and then of its tag-bar comments (comment_count). Shown
    without opening anything are the first preview_count of the content's (all of them
    unless the note is folded) and the comments', unless a note above it is folded."""

    note_id: str
    root_id: str
    root_index: int
    content_count: int
    comment_count: int
    preview_count: int
    is_under_folded_note: bool


@dataclass(frozen=True, slots=True)
class FindWindow:
    """The matches in roots [first_root_index, end_root_index), in list order."""

    matches: Tuple[FindMatch, ...]
    first_root_index: int
    end_root_index: int
    root_count: int


def _tag_bar_comments(tags: str) -> List[str]:
    """The tag bar's comments as it shows them, markers included (an unclosed one runs
    to the end), as tag-syntax-service.js splits them."""
    comments: List[str] = []
    index = 0
    while True:
        start = tags.find(COMMENT_OPEN, index)
        if start == -1:
            return comments
        end = tags.find(COMMENT_CLOSE, start + len(COMMENT_OPEN))
        if end == -1:
            comments.append(tags[start:])
            return comments
        comments.append(tags[start:end + len(COMMENT_CLOSE)])
        index = end + len(COMMENT_CLOSE)


def _find_candidates(find_text: str, traversal_cache: _SnapshotTraversalCache) -> Set[str]:
    """Every note that can show the text, read without rendering: notes whose own text
    holds each word, and the notes that reference or embed one of them or a note above
    one (an embed shows its source's children)."""
    words = tuple(find_text.casefold().split())
    assert words, "find text must hold a word"
    candidates = set(search_index.note_ids_containing_words(words))
    pending = list(candidates)
    reached: Set[str] = set()
    while pending:
        note_id = pending.pop()
        if note_id in reached:
            continue
        reached.add(note_id)
        for referrer_id in note_store.get_referrer_ids(note_id):
            candidates.add(referrer_id)
            pending.append(referrer_id)
        parent_id = traversal_cache.get_note(note_id).parent_id
        if parent_id is not None:
            pending.append(parent_id)
    return candidates


def _count_find_match(
    rec: NoteRecord, *, find_text: str, root_id: str, root_index: int, is_under_folded_note: bool,
    context: EmbedRenderContext,
) -> FindMatch | None:
    content_count = count_occurrences(
        read_visible_text(_render_note_content_html(rec, is_collapsed=False, context=context)), find_text,
    )
    comment_count = sum(
        count_occurrences(read_comment_text(comment), find_text) for comment in _tag_bar_comments(rec.tags)
    )
    if content_count == 0 and comment_count == 0:
        return None
    preview_count = content_count
    if content_count > 0 and _is_shown_collapsed(rec, context):
        preview_count = count_occurrences(
            read_visible_text(_render_note_content_html(rec, is_collapsed=True, context=context)), find_text,
        )
    return FindMatch(
        note_id=rec.id, root_id=root_id, root_index=root_index, content_count=content_count,
        comment_count=comment_count, preview_count=min(preview_count, content_count),
        is_under_folded_note=is_under_folded_note,
    )


def _find_in_root(
    root_id: str, root_index: int, *, find_text: str, candidates: Set[str], allowed_note_ids: frozenset[str],
    traversal_cache: _SnapshotTraversalCache, context: EmbedRenderContext,
) -> List[FindMatch]:
    """The root's matches in page order: each note, then its children (folded ones
    too; a placeholder for a note outside the search is no match, nor is what is under it)."""
    matches: List[FindMatch] = []
    pending: List[Tuple[str, bool]] = [(root_id, False)]
    visited: Set[str] = set()
    while pending:
        note_id, is_under_folded_note = pending.pop()
        if note_id in visited:
            raise RuntimeError("Cycle in note hierarchy")
        visited.add(note_id)
        rec = traversal_cache.get_note(note_id)
        if note_id in candidates:
            match = _count_find_match(
                rec, find_text=find_text, root_id=root_id, root_index=root_index,
                is_under_folded_note=is_under_folded_note, context=context,
            )
            if match is not None:
                matches.append(match)
        children_folded = any((is_under_folded_note, _is_shown_collapsed(rec, context)))
        child_ids = [child_id for child_id in traversal_cache.get_children(note_id) if child_id in allowed_note_ids]
        pending.extend((child_id, children_folded) for child_id in reversed(child_ids))
    return matches


def find_in_view(
    *, find_text: str, search: str, sort_mode: str, date_filter: RootDateFilter | None, is_untagged_view: bool,
    from_root_index: int, direction: str,
) -> FindWindow:
    """One step of find through the list a view shows: forward, the roots from
    from_root_index on; backward, the roots before it, until FIND_WINDOW_MATCHED_NOTES
    notes matched or the list ends."""
    if not isinstance(find_text, str) or find_text.strip() == "":
        raise ValueError("find_text must hold text")
    if direction not in FIND_DIRECTIONS:
        raise ValueError(f"direction must be one of {FIND_DIRECTIONS}, got {direction!r}")
    scope = resolve_view_scope_membership(
        search=search, sort_mode=sort_mode, date_filter=date_filter, is_untagged_view=is_untagged_view,
    )
    roots = scope.ordered_root_ids
    if not isinstance(from_root_index, int) or from_root_index < 0:
        raise ValueError(f"from_root_index must be a non-negative integer, got {from_root_index!r}")
    # The browser's position comes from an earlier step; if the list has lost roots since
    # (another tab deleted some), a position past its end is its end. The browser finds
    # again whenever the list changes (docs/ui/find.md).
    from_root_index = min(from_root_index, len(roots))
    traversal_cache = _SnapshotTraversalCache()
    context = _new_embed_render_context(traversal_cache)
    candidates = _find_candidates(find_text, traversal_cache)
    windows: List[List[FindMatch]] = []
    matched_notes = 0
    if direction == "forward":
        root_indexes = range(from_root_index, len(roots))
    else:
        root_indexes = range(from_root_index - 1, -1, -1)
    first_root_index = from_root_index
    end_root_index = from_root_index
    for root_index in root_indexes:
        root_matches = _find_in_root(
            roots[root_index], root_index, find_text=find_text, candidates=candidates,
            allowed_note_ids=scope.allowed_note_ids, traversal_cache=traversal_cache, context=context,
        )
        windows.append(root_matches)
        matched_notes += len(root_matches)
        if direction == "forward":
            end_root_index = root_index + 1
        else:
            first_root_index = root_index
        if matched_notes >= FIND_WINDOW_MATCHED_NOTES:
            break
    if direction == "backward":
        windows.reverse()
    matches = tuple(match for root_matches in windows for match in root_matches)
    assert first_root_index <= end_root_index
    return FindWindow(
        matches=matches, first_root_index=first_root_index, end_root_index=end_root_index, root_count=len(roots),
    )
