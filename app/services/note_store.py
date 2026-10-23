"""In-memory snapshot of the note hierarchy.

The store is responsible for eagerly loading the note table at startup and
providing fast, read-only access to decrypted content plus linked-list
metadata that the rest of the application relies on.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from threading import RLock
from typing import Dict, FrozenSet, Iterable, List, Optional, Protocol, Sequence, Mapping, Set
from types import SimpleNamespace
import time
import logging

from app.db.session import connect_reader
from app.db.notes_sql import fetch_all_for_cache

from app.models.database import SafeSession
from app.services.backlink_index import BacklinkIndex
from app.services.content_cache import (
    get_cached_content,
    get_cached_proposed_tags,
    get_cached_tags,
    get_cached_text,
)
from app.services.file_registry import file_registry
from app.services.shared_sets import SharedSetMap, SharedSets
from app.services.hydration_state import hydration_state
from app.services.hierarchy import hierarchy_depths
from app.services.note_ordering import NoteOrdering
from app.services.tag_ontology import TagOntology
from app.services.note_image_tags import infer_image_tag_terms
from app.services.ontology_rules_store import get_ontology, get_ontology_if_ready
from app.services.search_index import SearchRecord, extract_tags_for_search, search_index, tag_bar_values
from app.services.tag_ontology import rule_text_conditions
from app.services.tag_properties import PROPERTY_ASSIGNMENT
from app.utils.text_utils import strip_html, strip_sanitized_html_keeping_link_urls

# Hydration reports its progress after every this many notes.
_HYDRATION_PROGRESS_INTERVAL_NOTES = 1000
# Startup timing logs one line per this many hydrated notes.
_STARTUP_TIMING_LOG_INTERVAL_NOTES = 1000

def _search_text(content_html: str, visible_text: str) -> str:
    """The text search sees: the visible text plus the URLs that link labels hide
    (docs/ui/search-semantics.md). Ontology text matchers keep the visible text.
    Stored notes are the sanitizer's output (content_cache), read without Python's
    HTML parser."""
    if "href" not in content_html:
        # No link: the visible text, already computed, is the same.
        return visible_text
    return strip_sanitized_html_keeping_link_urls(content_html)


def _derive_own_tag_terms(*, tags: str, content_html: str) -> tuple[FrozenSet[str], FrozenSet[str]]:
    return _combine_own_tag_terms(
        explicit_terms=_parse_tag_string_terms(tags),
        content_html=content_html,
    )


def _combine_own_tag_terms(
    *, explicit_terms: tuple[FrozenSet[str], FrozenSet[str]], content_html: str,
) -> tuple[FrozenSet[str], FrozenSet[str]]:
    tag_terms, non_meta_tag_terms = explicit_terms
    image_terms = infer_image_tag_terms(
        content_html=content_html,
        is_image_file=file_registry.has_image_file,
    )
    # Inferred image tags are meta tags, so they never change non-meta terms.
    assert all(term.startswith("@") for term in image_terms)
    if image_terms:
        tag_terms = tag_terms | image_terms
    return tag_terms, non_meta_tag_terms


def _parse_tag_string_terms(tag_string: str) -> tuple[FrozenSet[str], FrozenSet[str]]:
    if not isinstance(tag_string, str):
        raise TypeError("tag_string must be a string")
    tag_terms = extract_tags_for_search(tag_string)
    non_meta_tag_terms = frozenset(term for term in tag_terms if not term.startswith("@"))
    return tag_terms, non_meta_tag_terms


def _components_sources_first(dependencies: Mapping[str, Set[str]]) -> List[List[str]]:
    """Strongly connected components of note -> source edges, sources first.

    Iterative Tarjan: a component is emitted only after every component it
    draws from, so one pass in emission order sees finalized sources.
    """
    index: Dict[str, int] = {}
    low: Dict[str, int] = {}
    stack: List[str] = []
    on_stack: set[str] = set()
    components: List[List[str]] = []
    for root in dependencies:
        if root in index:
            continue
        index[root] = low[root] = len(index)
        stack.append(root)
        on_stack.add(root)
        work = [(root, iter(dependencies[root]))]
        while work:
            node, sources = work[-1]
            descended = False
            for source in sources:
                if source not in dependencies:
                    continue
                if source not in index:
                    index[source] = low[source] = len(index)
                    stack.append(source)
                    on_stack.add(source)
                    work.append((source, iter(dependencies[source])))
                    descended = True
                    break
                if source in on_stack:
                    low[node] = min(low[node], index[source])
            if descended:
                continue
            work.pop()
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[node])
            if low[node] != index[node]:
                continue
            component: List[str] = []
            while True:
                member = stack.pop()
                on_stack.remove(member)
                component.append(member)
                if member == node:
                    break
            components.append(component)
    assert len(index) == len(dependencies) and not stack
    return components


class _TermSets(Protocol):
    def __getitem__(self, note_id: str) -> FrozenSet[str]: ...
    def __setitem__(self, note_id: str, value: FrozenSet[str]) -> None: ...
    def __contains__(self, note_id: object) -> bool: ...


class _PendingTermSets:
    """A propagation's results over a shared map: read here first, then from the map
    (notes outside the propagation, already final), and stored in the map once at the
    end. Writing each note's direct terms to the map and then its result took twice
    the shared-copy bookkeeping, a sixth of building the note store (2026-10-19)."""

    def __init__(self, published: SharedSetMap) -> None:
        self._published = published
        self._pending: Dict[str, FrozenSet[str]] = {}

    def __getitem__(self, note_id: str) -> FrozenSet[str]:
        if note_id in self._pending:  # shockharness: ignore[DEF002] reason="two layers, no default: a pending result is newer than the published one, and a note in neither raises KeyError"
            return self._pending[note_id]
        return self._published[note_id]

    def __setitem__(self, note_id: str, value: FrozenSet[str]) -> None:
        self._pending[note_id] = value

    def __contains__(self, note_id: object) -> bool:
        if note_id in self._pending:
            return True
        return note_id in self._published

    def publish(self) -> None:
        for note_id, value in self._pending.items():
            self._published[note_id] = value
        self._pending.clear()


def _union_term_sets(parts: List[FrozenSet[str]]) -> FrozenSet[str]:
    # Start from the largest set and reuse it when the rest add nothing, so
    # children that inherit nothing new share their parent's set object.
    assert parts
    result = max(parts, key=len)
    for part in parts:
        if part is not result and not part <= result:
            result = result | part
    return result


def _escape_search_phrase(phrase: str) -> str:
    if not isinstance(phrase, str):
        raise TypeError(f"phrase must be a string, got {type(phrase)}")
    if phrase == "":
        raise ValueError("phrase must be non-empty")
    return phrase.replace("\\", "\\\\").replace("\"", "\\\"")


def _build_search_query(*, required_tags: Iterable[str], required_phrases: Iterable[str]) -> str:
    tokens: List[str] = []
    tokens.extend(required_tags)
    for phrase in required_phrases:
        tokens.append(f"\"{_escape_search_phrase(phrase)}\"")
    return " ".join(tokens)


def _collect_matcher_generated_tags(ontology) -> FrozenSet[str]:
    if not ontology.matcher_rules:
        return frozenset()

    generated: Set[str] = set()
    for rule in ontology.matcher_rules:
        generated.add(rule.rhs)
        implied = ontology.implication_closure.get(rule.rhs)
        if implied:
            generated.update(implied)
    return frozenset(generated)


@dataclass(frozen=True)
class NotePosition:
    """Where a note sits in the tree: its parent and siblings (None where it has
    none: a top note has no parent, the first sibling no previous one)."""

    note_id: str
    parent_id: Optional[str]
    prev_id: Optional[str]
    next_id: Optional[str]


@dataclass(frozen=True)
class NoteRecord:
    id: str
    parent_id: Optional[str]
    prev_id: Optional[str]
    next_id: Optional[str]
    is_collapsed: bool
    content: str
    tags: str
    proposed_tags: str
    tag_terms: FrozenSet[str]
    non_meta_tag_terms: FrozenSet[str]
    proposed_tag_terms: FrozenSet[str]
    proposed_non_meta_tag_terms: FrozenSet[str]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


class NoteStore:
    """Thread-safe, read-optimized cache of note metadata."""

    def __init__(self) -> None:
        self._logger = logging.getLogger(__name__)
        self._lock = RLock()
        self._note_map: Dict[str, NoteRecord] = {}
        self._backlink_index = BacklinkIndex()
        self._ordering = NoteOrdering()
        # Inherited tag sets share one copy of each distinct set (shared_sets.py); the
        # copies come first, so the memory breakdown counts them under their own name.
        self._shared_tag_sets = SharedSets()
        self._effective_non_meta_tag_terms = SharedSetMap(self._shared_tag_sets)
        self._effective_proposed_non_meta_tag_terms = SharedSetMap(self._shared_tag_sets)
        self._subtree_non_meta_tag_terms = SharedSetMap(self._shared_tag_sets)
        self._subtree_proposed_non_meta_tag_terms = SharedSetMap(self._shared_tag_sets)
        self._loaded = False
        self._revision = 0
        self._timing_enabled = True

    def _get_children_locked(self, parent_id: Optional[str]) -> List[str]:
        return self._ordering.children(self._note_map, parent_id)

    def _reference_targets_locked(self, note_id: str) -> set[str]:
        return set(self._backlink_index.get_target_ids(note_id)) & self._note_map.keys()

    def _referrers_locked(self, note_id: str) -> set[str]:
        return self._backlink_index.get_counts(note_id).keys() & self._note_map.keys()

    def _inherited_tag_terms_locked(
        self, note_id: str, effective: SharedSetMap, subtree: SharedSetMap,
    ) -> FrozenSet[str]:
        terms = frozenset().union(*(subtree[target] for target in self._reference_targets_locked(note_id)))
        parent_id = self._note_map[note_id].parent_id
        if parent_id is not None:
            terms |= effective[parent_id]
        return terms

    def _raw_tag_terms_locked(self, note_id: str) -> FrozenSet[str]:
        record = self._note_map[note_id]
        return (record.tag_terms | record.proposed_tag_terms
                | self._effective_non_meta_tag_terms[note_id]
                | self._effective_proposed_non_meta_tag_terms[note_id])

    @staticmethod
    def _value_inferred_terms_locked(record: NoteRecord, *, base_terms: FrozenSet[str]) -> FrozenSet[str]:
        """The non-meta tags a note's own super tag values infer (TagOntology.value_rules),
        its tags read as base_terms; none while the rules cannot be read."""
        ontology = get_ontology_if_ready()
        if ontology is None or not ontology.value_rules:
            return frozenset()
        # Most notes have no value and no tag a value rule tests: nothing to read.
        if PROPERTY_ASSIGNMENT not in record.tags and not ontology.missing_rule_tags_casefold.intersection(
            term.casefold() for term in record.non_meta_tag_terms
        ):
            return frozenset()
        own_tag_names, values = tag_bar_values(record.tags)
        plaintext = ""
        if ontology.value_rules_read_text:
            plaintext = strip_html(record.content)
        inferred = ontology.infer_value_tags(
            values=values, own_tag_names=own_tag_names, base_tags=base_terms | record.tag_terms, plaintext=plaintext,
        )
        # Meta tags are never inherited, so a rule giving one adds nothing here.
        return frozenset(term for term in inferred if not term.startswith("@"))

    def _rebuild_effective_tag_terms_locked(self) -> Dict[str, FrozenSet[str]]:
        # Hierarchy cycles remain invalid; reference cycles are valid dependencies.
        visited: set[str] = set()
        pending = self._get_children_locked(None)
        while pending:
            note_id = pending.pop()
            if note_id in visited:
                raise RuntimeError(f"Integrity failure: cycle detected during tag inheritance at note {note_id}")
            assert note_id in self._note_map
            visited.add(note_id)
            pending.extend(self._get_children_locked(note_id))
        if visited != self._note_map.keys():
            raise RuntimeError("Integrity failure: unreachable notes during tag inheritance")
        self._effective_non_meta_tag_terms.clear()
        self._effective_proposed_non_meta_tag_terms.clear()
        self._subtree_non_meta_tag_terms.clear()
        self._subtree_proposed_non_meta_tag_terms.clear()
        self._propagate_subtree_tag_terms_locked(visited)
        return self._propagate_inherited_tag_terms_locked(visited)

    def _recompute_effective_tag_terms_locked(
        self, root_ids: Iterable[str], *, subtree_root_ids: Iterable[str],
    ) -> Dict[str, FrozenSet[str]]:
        roots = set(root_ids)
        # Subtree contributions flow upward and across references, never through
        # inherited parent tags. Include former parents after moves/deletions.
        subtree_affected: set[str] = set()
        pending = list(roots | set(subtree_root_ids))
        effective_roots = set(roots)
        while pending:
            note_id = pending.pop()
            assert note_id in self._note_map
            if note_id in subtree_affected:
                continue
            subtree_affected.add(note_id)
            referrers = self._referrers_locked(note_id)
            effective_roots.update(referrers)
            pending.extend(referrers - subtree_affected)
            parent_id = self._note_map[note_id].parent_id
            if parent_id is not None:
                pending.append(parent_id)
        self._assert_acyclic_parent_paths_locked(subtree_affected)
        self._propagate_subtree_tag_terms_locked(subtree_affected)

        # Ordinary inheritance flows down from changed notes and referrers only;
        # siblings of an edited source descendant need no search-index update.
        affected: set[str] = set()
        pending = list(effective_roots)
        while pending:
            note_id = pending.pop()
            assert note_id in self._note_map
            if note_id in affected:
                continue
            affected.add(note_id)
            pending.extend(set(self._get_children_locked(note_id)) - affected)
        self._assert_acyclic_parent_paths_locked(affected)
        return self._propagate_inherited_tag_terms_locked(affected)

    def _assert_acyclic_parent_paths_locked(self, note_ids: set[str]) -> None:
        visited = set()
        for note_id in note_ids:
            path = set()
            current = note_id
            while current in note_ids and current not in visited:
                if current in path:
                    raise RuntimeError(f"Integrity failure: hierarchy cycle at note {current}")
                path.add(current)
                current = self._note_map[current].parent_id
            visited.update(path)

    def _parents_first_locked(self, affected: set[str]) -> List[str]:
        """The affected notes, each after its parent when the parent is affected too."""
        order: List[str] = []
        pending = [note_id for note_id in affected if self._note_map[note_id].parent_id not in affected]
        while pending:
            note_id = pending.pop()
            order.append(note_id)
            pending.extend(child for child in self._get_children_locked(note_id) if child in affected)
        if len(order) != len(affected):
            raise RuntimeError("Integrity failure: hierarchy cycle during tag inheritance")
        return order

    def _propagate_inherited_tag_terms_locked(self, affected: set[str]) -> Dict[str, FrozenSet[str]]:
        # Inherited terms flow only from a parent, and the hierarchy has no cycles: in
        # parents-first order each note's terms are final when it is reached, with no
        # dependency graph to order.
        accepted = _PendingTermSets(self._effective_non_meta_tag_terms)
        proposed = _PendingTermSets(self._effective_proposed_non_meta_tag_terms)
        for note_id in self._parents_first_locked(affected):
            record = self._note_map[note_id]
            targets = self._reference_targets_locked(note_id)
            own_accepted = record.non_meta_tag_terms | frozenset().union(
                *(self._subtree_non_meta_tag_terms[target] for target in targets))
            own_proposed = record.proposed_non_meta_tag_terms | frozenset().union(
                *(self._subtree_proposed_non_meta_tag_terms[target] for target in targets))
            if record.parent_id is None:
                carried = own_accepted
                proposed[note_id] = own_proposed
            else:
                carried = _union_term_sets([own_accepted, accepted[record.parent_id]])
                proposed[note_id] = _union_term_sets([own_proposed, proposed[record.parent_id]])
            # The tags its super tag values infer are the note's own, so its children
            # inherit them (rules about values: docs/design/tag-properties.md).
            value_terms = self._value_inferred_terms_locked(record, base_terms=carried)
            if value_terms:
                carried = carried | value_terms
            accepted[note_id] = carried
        accepted.publish()
        proposed.publish()
        return {note_id: self._raw_tag_terms_locked(note_id) for note_id in affected}

    def _propagate_subtree_tag_terms_locked(self, affected: set[str]) -> None:
        dependencies = {}
        accepted = _PendingTermSets(self._subtree_non_meta_tag_terms)
        proposed = _PendingTermSets(self._subtree_proposed_non_meta_tag_terms)
        for note_id in affected:
            record = self._note_map[note_id]
            # A source's value-inferred tags reach notes referencing it, read from the
            # source's own tags.
            accepted[note_id] = record.non_meta_tag_terms | self._value_inferred_terms_locked(
                record, base_terms=record.non_meta_tag_terms,
            )
            proposed[note_id] = record.proposed_non_meta_tag_terms
            dependencies[note_id] = (set(self._get_children_locked(note_id))
                                     | self._reference_targets_locked(note_id))
        self._propagate_tag_dependencies_locked(dependencies, accepted, proposed)
        accepted.publish()
        proposed.publish()

    @staticmethod
    def _propagate_tag_dependencies_locked(
        dependencies: Dict[str, set[str]],
        accepted_terms: _TermSets, proposed_terms: _TermSets,
    ) -> None:
        # Callers reset the affected closure to direct contributions first, so
        # cycles converge to the least fixed point even when tags are removed.
        # Every member of a strongly connected component reaches every other,
        # so each component's fixed point is one shared union of its members'
        # direct terms and its (already final) outside sources.
        for component in _components_sources_first(dependencies):
            members = set(component)
            accepted_parts: List[FrozenSet[str]] = []
            proposed_parts: List[FrozenSet[str]] = []
            for note_id in component:
                assert note_id in accepted_terms and note_id in proposed_terms
                accepted_parts.append(accepted_terms[note_id])
                proposed_parts.append(proposed_terms[note_id])
                for source_id in dependencies[note_id]:
                    if source_id in members:
                        continue
                    accepted_parts.append(accepted_terms[source_id])
                    proposed_parts.append(proposed_terms[source_id])
            accepted = _union_term_sets(accepted_parts)
            proposed = _union_term_sets(proposed_parts)
            for note_id in component:
                accepted_terms[note_id] = accepted
                proposed_terms[note_id] = proposed

    def _publish_tag_updates(self, raw_terms_by_id: Dict[str, FrozenSet[str]]) -> None:
        if not raw_terms_by_id:
            return
        ontology = get_ontology()
        inferred = {}
        for note_id, terms in raw_terms_by_id.items():
            plaintext = ""
            if ontology.matcher_rules:
                plaintext = strip_html(self.get_note(note_id).content)
            inferred[note_id] = ontology.infer_effective_tags(base_tags=terms, plaintext=plaintext)
        search_index.bulk_update_raw_tag_terms(raw_terms_by_id)
        search_index.bulk_update_tag_terms(inferred)

    @property
    def loaded(self) -> bool:
        return self._loaded

    def reset(self) -> None:
        with self._lock:
            self._revision += 1
            self._note_map.clear()
            self._backlink_index.clear()
            self._ordering = NoteOrdering()
            self._effective_non_meta_tag_terms.clear()
            self._effective_proposed_non_meta_tag_terms.clear()
            self._subtree_non_meta_tag_terms.clear()
            self._subtree_proposed_non_meta_tag_terms.clear()
            self._loaded = False
            search_index.rebuild(
                [],
                raw_tag_terms_by_id={},
                progress_update=lambda _processed: None,
                progress_interval=1,
            )

    def load_from_db(
        self,
        db: SafeSession | None,
        *,
        prefetched_rows: Optional[Sequence[Mapping[str, object]]],
    ) -> None:
        """Populate the store by reading all notes from the database once.

        When ``db`` is provided, we use its connection so uncommitted writes
        from the active transaction are visible (needed during paste flows).
        """

        with self._lock:
            self._revision += 1
            timing_enabled = self._timing_enabled and db is None

            if prefetched_rows is not None:
                rows = list(prefetched_rows)
                if timing_enabled:
                    print(
                        f"[startup] note_store reused {len(rows)} prefetched rows (no query)"
                    )
            else:
                fetch_start = time.perf_counter()
                if db is not None:
                    rows = list(fetch_all_for_cache(db.connection()))
                else:
                    with connect_reader("note_store:load") as connection:
                        rows = list(fetch_all_for_cache(connection))

                if timing_enabled:
                    fetch_duration = time.perf_counter() - fetch_start
                    print(
                        f"[startup] note_store query returned {len(rows)} rows in {fetch_duration:.2f}s"
                    )

            note_map, content_text_by_id = self._hydrate_records(rows, timing_enabled=timing_enabled)

            known_ids = set(note_map.keys())
            for record in note_map.values():
                if record.prev_id and record.prev_id not in known_ids:
                    raise RuntimeError(
                        f"Integrity failure: note {record.id} references prev_id {record.prev_id} that does not exist"
                    )
                if record.next_id and record.next_id not in known_ids:
                    raise RuntimeError(
                        f"Integrity failure: note {record.id} references next_id {record.next_id} that does not exist"
                    )
                if record.parent_id and record.parent_id not in known_ids:
                    raise RuntimeError(
                        f"Integrity failure: note {record.id} references parent_id {record.parent_id} that does not exist"
                    )

            index_start = time.perf_counter()
            hierarchy_depths({note_id: record.parent_id for note_id, record in note_map.items()})
            ordering = NoteOrdering.from_records(note_map)
            self._note_map = note_map
            self._ordering = ordering
            self._backlink_index.clear()
            for record in note_map.values():
                self._backlink_index.upsert(record.id, record.content, record.tags)
            if timing_enabled:
                print(
                    f"[startup] note_store link index rebuild in {time.perf_counter() - index_start:.2f}s"
                )

            tags_start = time.perf_counter()
            effective_tag_terms_by_id = self._rebuild_effective_tag_terms_locked()
            if timing_enabled:
                print(
                    f"[startup] note_store inherited tag rebuild in {time.perf_counter() - tags_start:.2f}s"
                )
            self._loaded = True

        ontology = get_ontology()
        tag_only_terms_by_id = self._rebuild_hydrated_search_index(
            note_map, content_text_by_id, effective_tag_terms_by_id, ontology,
            timing_enabled=timing_enabled,
        )
        self._apply_hydrated_matchers(
            note_map, content_text_by_id, tag_only_terms_by_id, ontology,
            timing_enabled=timing_enabled,
        )

    def _apply_hydrated_matchers(
        self, note_map: Mapping[str, NoteRecord], content_text_by_id: Mapping[str, str],
        tag_only_terms_by_id: Mapping[str, FrozenSet[str]], ontology: TagOntology,
        *, timing_enabled: bool,
    ) -> None:
        if not ontology.matcher_rules:
            return

        candidate_start = time.perf_counter()
        candidate_note_ids = self._select_matcher_candidates(note_map, content_text_by_id, ontology)
        needs_plaintext = any(
            rule.required_text_patterns or rule.required_regexes for rule in ontology.matcher_rules
        )
        if timing_enabled:
            print(
                f"[startup] matcher candidate selection found {len(candidate_note_ids)} notes in "
                f"{time.perf_counter() - candidate_start:.2f}s"
            )

        if not candidate_note_ids:
            return

        inference_start = time.perf_counter()
        updates: Dict[str, FrozenSet[str]] = {}
        if hydration_state.is_running():
            hydration_state.set_phase(
                phase="matcher_inference",
                message="Applying ontology matcher rules",
                total=len(candidate_note_ids),
            )
        processed_candidates = 0
        for note_id in candidate_note_ids:
            if note_id not in tag_only_terms_by_id:
                raise RuntimeError(
                    f"Integrity failure: missing tag terms for candidate note {note_id}"
                )
            base_terms = tag_only_terms_by_id[note_id]
            inferred_plaintext = ""
            if needs_plaintext:
                if note_id not in content_text_by_id:
                    raise RuntimeError(
                        f"Integrity failure: missing raw text for ontology inference note {note_id}"
                    )
                inferred_plaintext = content_text_by_id[note_id]
            effective_with_ontology = ontology.infer_effective_tags(
                base_tags=base_terms,
                plaintext=inferred_plaintext,
            )
            if effective_with_ontology != base_terms:
                updates[note_id] = effective_with_ontology
            processed_candidates += 1
            # The interval first: is_running takes a lock, once per interval rather than per note.
            if processed_candidates % _HYDRATION_PROGRESS_INTERVAL_NOTES == 0 and hydration_state.is_running():
                hydration_state.update(processed_candidates)

        if timing_enabled:
            print(
                f"[startup] matcher inference for {len(candidate_note_ids)} notes in "
                f"{time.perf_counter() - inference_start:.2f}s (updates={len(updates)})"
            )
        if hydration_state.is_running():
            hydration_state.update(processed_candidates)

        if updates:
            search_index.bulk_update_tag_terms(updates)

    def _hydrate_records(
        self, rows: Sequence[Mapping[str, object]], *, timing_enabled: bool,
    ) -> tuple[Dict[str, NoteRecord], Dict[str, str]]:
        note_map: Dict[str, NoteRecord] = {}
        content_text_by_id: Dict[str, str] = {}

        loop_start = time.perf_counter()
        processed = 0
        last_checkpoint = loop_start
        if hydration_state.is_running():
            hydration_state.set_phase(
                phase="note_store",
                message="Hydrating note store",
                total=len(rows),
            )

        # Tag strings repeat across notes; parse each distinct string once.
        terms_by_tag_string: Dict[str, tuple[FrozenSet[str], FrozenSet[str]]] = {}
        for row in rows:
            note = SimpleNamespace(**row)
            plaintext = get_cached_content(note.id)
            tags = get_cached_tags(note.id)
            proposed_tags = get_cached_proposed_tags(note.id)
            content_text_by_id[note.id] = get_cached_text(note.id)
            for tag_string in (tags, proposed_tags):
                if tag_string not in terms_by_tag_string:
                    terms_by_tag_string[tag_string] = _parse_tag_string_terms(tag_string)
            tag_terms, non_meta_tag_terms = _combine_own_tag_terms(
                explicit_terms=terms_by_tag_string[tags],
                content_html=plaintext,
            )
            proposed_tag_terms, proposed_non_meta_tag_terms = terms_by_tag_string[proposed_tags]

            note_map[note.id] = NoteRecord(
                id=note.id,
                parent_id=note.parent_id,
                prev_id=note.prev_id,
                next_id=note.next_id,
                is_collapsed=bool(note.is_collapsed),
                content=plaintext,
                tags=tags,
                proposed_tags=proposed_tags,
                tag_terms=tag_terms,
                non_meta_tag_terms=non_meta_tag_terms,
                proposed_tag_terms=proposed_tag_terms,
                proposed_non_meta_tag_terms=proposed_non_meta_tag_terms,
                created_at=note.created_at,
                updated_at=note.updated_at,
            )

            processed += 1
            if timing_enabled and processed % _STARTUP_TIMING_LOG_INTERVAL_NOTES == 0:
                now = time.perf_counter()
                batch_elapsed = now - last_checkpoint
                total_elapsed = now - loop_start
                print(
                    f"[startup] note_store hydrated {processed} notes | last {_STARTUP_TIMING_LOG_INTERVAL_NOTES} in {batch_elapsed:.2f}s | total {total_elapsed:.2f}s"
                )
                last_checkpoint = now
            if processed % _HYDRATION_PROGRESS_INTERVAL_NOTES == 0 and hydration_state.is_running():
                hydration_state.update(processed)

        if hydration_state.is_running():
            hydration_state.update(processed)

        if timing_enabled:
            print(f"[startup] note_store hydrated {processed} notes in {time.perf_counter() - loop_start:.2f}s")
        return note_map, content_text_by_id

    def _rebuild_hydrated_search_index(
        self, note_map: Mapping[str, NoteRecord], content_text_by_id: Mapping[str, str],
        effective_tag_terms_by_id: Dict[str, FrozenSet[str]], ontology: TagOntology,
        *, timing_enabled: bool,
    ) -> Dict[str, FrozenSet[str]]:
        search_records: List[SearchRecord] = []
        tag_only_terms_by_id: Dict[str, FrozenSet[str]] = {}
        tag_only_start = time.perf_counter()
        search_text_seconds = 0.0
        if hydration_state.is_running():
            hydration_state.set_phase(
                phase="tag_inference",
                message="Applying ontology implications",
                total=len(note_map),
            )
        for record in note_map.values():
            if record.id not in effective_tag_terms_by_id:
                raise RuntimeError(f"Integrity failure: missing effective tags for note {record.id}")
            effective_terms = effective_tag_terms_by_id[record.id]
            if record.id not in content_text_by_id:
                raise RuntimeError(f"Integrity failure: missing raw text for note {record.id}")
            tag_only_terms = ontology.infer_implication_only(base_tags=effective_terms)
            tag_only_terms_by_id[record.id] = tag_only_terms
            step_started = time.perf_counter()
            content_text = _search_text(record.content, content_text_by_id[record.id])
            search_text_seconds += time.perf_counter() - step_started
            search_records.append(
                SearchRecord(
                    note_id=record.id,
                    content_text=content_text,
                    tags=record.tags,
                    tag_terms=tag_only_terms,
                )
            )
            if len(search_records) % _HYDRATION_PROGRESS_INTERVAL_NOTES == 0 and hydration_state.is_running():
                hydration_state.update(len(search_records))
        if timing_enabled:
            print(
                f"[startup] note_store tag-only inference for {len(search_records)} notes in "
                f"{time.perf_counter() - tag_only_start:.2f}s"
            )
        if hydration_state.is_running():
            hydration_state.update(len(search_records))

        if hydration_state.is_running():
            hydration_state.set_phase(
                phase="search_index",
                message="Building search index",
                total=len(search_records),
            )
        index_start = time.perf_counter()

        def _update_search_index_progress(processed: int) -> None:
            if hydration_state.is_running():
                hydration_state.update(processed)

        index_steps = search_index.rebuild(
            search_records,
            raw_tag_terms_by_id=effective_tag_terms_by_id,
            progress_update=_update_search_index_progress,
            progress_interval=_HYDRATION_PROGRESS_INTERVAL_NOTES,
        )
        if hydration_state.is_running():
            # Where the search index's time goes, for the Memory Usage dialog's Last unlock.
            hydration_state.record_steps({"tag inference: text with link addresses": search_text_seconds, **index_steps})
        if timing_enabled:
            print(
                f"[startup] search index rebuild in {time.perf_counter() - index_start:.2f}s"
            )

        return tag_only_terms_by_id

    def _select_matcher_candidates(
        self, note_map: Mapping[str, NoteRecord], content_text_by_id: Mapping[str, str],
        ontology: TagOntology,
    ) -> Set[str]:
        matcher_generated_tags = _collect_matcher_generated_tags(ontology)
        candidate_note_ids: Set[str] = set()
        all_note_ids: Set[str] | None = None
        for rule in ontology.matcher_rules:
            required_tags = [tag for tag in rule.required_tags if tag not in matcher_generated_tags]
            required_phrases = list(rule.required_text_phrases)

            if not required_tags and not required_phrases:
                if all_note_ids is None:
                    all_note_ids = set(note_map.keys())
                candidate_note_ids = all_note_ids
                break

            query = _build_search_query(
                required_tags=required_tags,
                required_phrases=required_phrases,
            )
            rule_candidates = search_index.query_note_ids(query)

            if rule.required_regexes:
                filtered: Set[str] = set()
                for note_id in rule_candidates:
                    if note_id not in content_text_by_id:
                        raise RuntimeError(
                            f"Integrity failure: missing raw text for candidate note {note_id}"
                        )
                    raw_text = content_text_by_id[note_id]
                    matched = True
                    for regex in rule.required_regexes:
                        if regex.search(raw_text) is None:
                            matched = False
                            break
                    if matched:
                        filtered.add(note_id)
                rule_candidates = filtered

            candidate_note_ids.update(rule_candidates)

        return candidate_note_ids

    @property
    def revision(self) -> int:
        with self._lock:
            return self._revision

    def snapshot(self) -> Dict[str, NoteRecord]:
        """Return a shallow copy of the current note map."""
        with self._lock:
            return dict(self._note_map)

    # Mutation helpers --------------------------------------------------------

    def add_note_from_db(
        self,
        note: SimpleNamespace,
        plaintext: str,
        tags: str,
        proposed_tags: str,
    ) -> None:
        if not self._loaded:
            return
        tag_terms, non_meta_tag_terms = _derive_own_tag_terms(
            tags=tags,
            content_html=plaintext,
        )
        proposed_tag_terms, proposed_non_meta_tag_terms = _parse_tag_string_terms(
            proposed_tags
        )
        content_text = strip_html(plaintext)
        with self._lock:
            self._revision += 1
            record = NoteRecord(
                id=note.id,
                parent_id=note.parent_id,
                prev_id=note.prev_id,
                next_id=note.next_id,
                is_collapsed=bool(note.is_collapsed),
                content=plaintext,
                tags=tags,
                proposed_tags=proposed_tags,
                tag_terms=tag_terms,
                non_meta_tag_terms=non_meta_tag_terms,
                proposed_tag_terms=proposed_tag_terms,
                proposed_non_meta_tag_terms=proposed_non_meta_tag_terms,
                created_at=note.created_at,
                updated_at=note.updated_at,
            )
            self._note_map[note.id] = record
            self._backlink_index.upsert(record.id, record.content, record.tags)
            self._insert_link(record.parent_id, record.id, record.prev_id, record.next_id)

            tag_updates = self._recompute_effective_tag_terms_locked({record.id}, subtree_root_ids=())
            effective_tag_terms = tag_updates.pop(record.id)

        ontology = get_ontology()
        matcher_rules_enabled = bool(ontology.matcher_rules)
        inferred_plaintext = ""
        if matcher_rules_enabled:
            inferred_plaintext = content_text
        effective_with_ontology = ontology.infer_effective_tags(
            base_tags=effective_tag_terms,
            plaintext=inferred_plaintext,
        )
        search_index.upsert(
            note_id=record.id,
            content_text=_search_text(record.content, content_text),
            tags=record.tags,
            raw_tag_terms=effective_tag_terms,
            tag_terms=effective_with_ontology,
        )

        self._publish_tag_updates(tag_updates)

    def add_notes_from_db(
        self, entries: Sequence[tuple[SimpleNamespace, str, str, str]],
    ) -> None:
        """Insert several notes (e.g. an undone subtree deletion) in order.

        Each note is linked exactly as add_note_from_db would; inheritance is
        recomputed once for all of them and the search index updated once,
        instead of re-publishing every affected note after each insertion.
        """
        if not self._loaded or not entries:
            return
        prepared = []
        for note, plaintext, tags, proposed_tags in entries:
            tag_terms, non_meta_tag_terms = _derive_own_tag_terms(tags=tags, content_html=plaintext)
            proposed_tag_terms, proposed_non_meta_tag_terms = _parse_tag_string_terms(proposed_tags)
            prepared.append((note, plaintext, tags, proposed_tags, tag_terms, non_meta_tag_terms,
                             proposed_tag_terms, proposed_non_meta_tag_terms, strip_html(plaintext)))
        with self._lock:
            self._revision += 1
            records = []
            for (note, plaintext, tags, proposed_tags, tag_terms, non_meta_tag_terms,
                 proposed_tag_terms, proposed_non_meta_tag_terms, _content_text) in prepared:
                record = NoteRecord(
                    id=note.id,
                    parent_id=note.parent_id,
                    prev_id=note.prev_id,
                    next_id=note.next_id,
                    is_collapsed=bool(note.is_collapsed),
                    content=plaintext,
                    tags=tags,
                    proposed_tags=proposed_tags,
                    tag_terms=tag_terms,
                    non_meta_tag_terms=non_meta_tag_terms,
                    proposed_tag_terms=proposed_tag_terms,
                    proposed_non_meta_tag_terms=proposed_non_meta_tag_terms,
                    created_at=note.created_at,
                    updated_at=note.updated_at,
                )
                self._note_map[note.id] = record
                self._backlink_index.upsert(record.id, record.content, record.tags)
                self._insert_link(record.parent_id, record.id, record.prev_id, record.next_id)
                records.append(record)
            tag_updates = self._recompute_effective_tag_terms_locked(
                {record.id for record in records}, subtree_root_ids=())

        ontology = get_ontology()
        for record, entry in zip(records, prepared):
            content_text = entry[-1]
            effective_tag_terms = tag_updates.pop(record.id)
            inferred_plaintext = ""
            if ontology.matcher_rules:
                inferred_plaintext = content_text
            search_index.upsert(
                note_id=record.id,
                content_text=_search_text(record.content, content_text),
                tags=record.tags,
                raw_tag_terms=effective_tag_terms,
                tag_terms=ontology.infer_effective_tags(base_tags=effective_tag_terms, plaintext=inferred_plaintext),
            )
        self._publish_tag_updates(tag_updates)

    def update_note_content(
        self,
        *,
        note_id: str,
        plaintext: str,
        tags: str,
        proposed_tags: str,
        updated_at: Optional[datetime],
    ) -> None:
        """A saved note's text and tags, and when it was saved."""
        if not self._loaded:
            return
        updated: NoteRecord | None = None
        tag_sources_changed = False
        effective_tag_terms_by_id: Dict[str, FrozenSet[str]] = {}
        with self._lock:
            self._revision += 1
            if note_id not in self._note_map:
                return
            current = self._note_map[note_id]
            tag_sources_changed = current.tags != tags
            if current.proposed_tags != proposed_tags:
                tag_sources_changed = True
            tag_terms, non_meta_tag_terms = _derive_own_tag_terms(
                tags=tags,
                content_html=plaintext,
            )
            proposed_tag_terms, proposed_non_meta_tag_terms = _parse_tag_string_terms(
                proposed_tags
            )
            updated = replace(
                current,
                content=plaintext,
                tags=tags,
                proposed_tags=proposed_tags,
                tag_terms=tag_terms,
                non_meta_tag_terms=non_meta_tag_terms,
                proposed_tag_terms=proposed_tag_terms,
                proposed_non_meta_tag_terms=proposed_non_meta_tag_terms,
                updated_at=updated_at,
            )
            self._note_map[note_id] = updated

            if current.content != plaintext or current.tags != tags:
                old_targets = self._backlink_index.get_target_ids(updated.id)
                self._backlink_index.upsert(updated.id, updated.content, updated.tags)
                if old_targets != self._backlink_index.get_target_ids(updated.id):
                    tag_sources_changed = True

            if tag_sources_changed:
                effective_tag_terms_by_id = self._recompute_effective_tag_terms_locked(
                    {note_id}, subtree_root_ids=())
            else:
                effective_tag_terms = self._raw_tag_terms_locked(updated.id)

        assert updated is not None

        if tag_sources_changed:
            assert updated.id in effective_tag_terms_by_id
            effective_tag_terms = effective_tag_terms_by_id.pop(updated.id)

        ontology = get_ontology()
        matcher_rules_enabled = bool(ontology.matcher_rules)
        inferred_plaintext = ""
        content_text = strip_html(updated.content)
        if matcher_rules_enabled:
            inferred_plaintext = content_text
        effective_with_ontology = ontology.infer_effective_tags(
            base_tags=effective_tag_terms,
            plaintext=inferred_plaintext,
        )
        search_index.upsert(
            note_id=updated.id,
            content_text=_search_text(updated.content, content_text),
            tags=updated.tags,
            raw_tag_terms=effective_tag_terms,
            tag_terms=effective_with_ontology,
        )

        if tag_sources_changed:
            self._publish_tag_updates(effective_tag_terms_by_id)

    def move_note(self, position: NotePosition) -> None:
        """One note's new place, relinked in place (no full ordering rebuild)."""
        if not self._loaded:
            return
        note_id = position.note_id
        with self._lock:
            self._revision += 1
            record = self._note_map[note_id]
            self._remove_link(record.parent_id, record.id)
            self._note_map[note_id] = replace(record, parent_id=position.parent_id)
            next_id = position.next_id
            if next_id == note_id:
                # Moving after an adjacent predecessor is an unchanged placement.
                next_id = record.next_id
            self._insert_link(position.parent_id, note_id, position.prev_id, next_id)
            tag_updates = {}
            if record.parent_id != position.parent_id:
                former_parents = set()
                if record.parent_id is not None:
                    former_parents.add(record.parent_id)
                tag_updates = self._recompute_effective_tag_terms_locked(
                    {note_id}, subtree_root_ids=former_parents)
        self._publish_tag_updates(tag_updates)

    def move_notes(self, positions: Iterable[NotePosition]) -> None:
        """Several notes' new places at once, with one ordering rebuild."""
        if not self._loaded:
            return
        payload = list(positions)
        if not payload:
            return
        tag_updates: Dict[str, FrozenSet[str]] = {}
        with self._lock:
            self._revision += 1
            replacements = {}
            moved_ids: Set[str] = set()
            former_parents: Set[str] = set()
            for position in payload:
                record = self._note_map[position.note_id]
                replacements[position.note_id] = replace(
                    record, parent_id=position.parent_id, prev_id=position.prev_id, next_id=position.next_id,
                )
                if record.parent_id != position.parent_id:
                    moved_ids.add(position.note_id)
                    if record.parent_id is not None:
                        former_parents.add(record.parent_id)
            next_records = dict(self._note_map)
            next_records.update(replacements)
            if moved_ids:
                hierarchy_depths({note_id: record.parent_id for note_id, record in next_records.items()})
            self._ordering = NoteOrdering.from_records(next_records)
            self._note_map = next_records
            if moved_ids:
                tag_updates = self._recompute_effective_tag_terms_locked(
                    moved_ids, subtree_root_ids=former_parents)
        self._publish_tag_updates(tag_updates)

    def set_updated_ats(self, updated_ats: Mapping[str, Optional[datetime]]) -> None:
        """Notes' updated times (Reset Updated to Created), and nothing else."""
        if not self._loaded:
            return
        with self._lock:
            self._revision += 1
            for note_id, updated_at in updated_ats.items():
                self._note_map[note_id] = replace(self._note_map[note_id], updated_at=updated_at)

    def remove_note(self, note_id: str) -> None:
        if not self._loaded:
            return
        removed_ids: Set[str] = set()

        with self._lock:
            self._revision += 1
            root = self._note_map[note_id]
            to_visit = [note_id]
            removed_ids = set()
            while to_visit:
                current = to_visit.pop()
                assert current not in removed_ids, 'Cycle in deleted hierarchy'
                removed_ids.add(current)
                to_visit.extend(self._get_children_locked(current))
            self._ordering.remove(self._note_map, root)
            for removed_id in removed_ids:
                del self._note_map[removed_id]
                # Only a note with children heads and tails a sibling list.
                if removed_id in self._ordering.heads:
                    del self._ordering.heads[removed_id]
                    del self._ordering.tails[removed_id]

            referrer_ids = set()
            for removed_id in removed_ids:
                referrer_ids.update(self._backlink_index.get_counts(removed_id))
            for removed_id in removed_ids:
                self._backlink_index.remove(removed_id)
                # Every note has its tag terms computed, so every removed note has entries.
                del self._effective_non_meta_tag_terms[removed_id]
                del self._effective_proposed_non_meta_tag_terms[removed_id]
                del self._subtree_non_meta_tag_terms[removed_id]
                del self._subtree_proposed_non_meta_tag_terms[removed_id]

            former_parents = set()
            if root.parent_id is not None:
                former_parents.add(root.parent_id)
            tag_updates = self._recompute_effective_tag_terms_locked(
                referrer_ids & self._note_map.keys(), subtree_root_ids=former_parents)

        if removed_ids:
            search_index.remove_many(removed_ids)
        self._publish_tag_updates(tag_updates)

    def set_collapsed(self, note_id: str, collapsed: bool) -> None:
        if not self._loaded:
            return
        with self._lock:
            record = self._note_map[note_id]
            if record.is_collapsed == collapsed:
                return
            self._revision += 1
            self._note_map[note_id] = NoteRecord(
                id=record.id,
                parent_id=record.parent_id,
                prev_id=record.prev_id,
                next_id=record.next_id,
                is_collapsed=collapsed,
                content=record.content,
                tags=record.tags,
                proposed_tags=record.proposed_tags,
                tag_terms=record.tag_terms,
                non_meta_tag_terms=record.non_meta_tag_terms,
                proposed_tag_terms=record.proposed_tag_terms,
                proposed_non_meta_tag_terms=record.proposed_non_meta_tag_terms,
                created_at=record.created_at,
                updated_at=record.updated_at,
            )
            # Content/collapse changes preserve the authoritative sibling pointers.

    def has_backlinks(self, note_id: str) -> bool:
        with self._lock:
            return note_id in self._note_map and self._backlink_index.has_backlinks(note_id)

    def get_referrer_ids(self, note_id: str) -> FrozenSet[str]:
        """The notes that reference or embed note_id."""
        with self._lock:
            if note_id not in self._note_map:
                raise KeyError(f"Note {note_id} not present in NoteStore")
            return frozenset(self._referrers_locked(note_id))

    def get_backlink_counts(self, note_id: str) -> Dict[str, int]:
        with self._lock:
            if note_id not in self._note_map:
                raise KeyError(f"Note {note_id} not present in NoteStore")
            return self._backlink_index.get_counts(note_id)

    def get_outside_referrer_ids(self, root_id: str) -> FrozenSet[str]:
        """The notes outside root_id's subtree that reference the root or any
        note in it: whose references deleting that subtree would break."""
        with self._lock:
            if root_id not in self._note_map:
                raise KeyError(f"Note {root_id} not present in NoteStore")
            subtree: Set[str] = set()
            pending = [root_id]
            while pending:
                note_id = pending.pop()
                if note_id in subtree:
                    continue
                subtree.add(note_id)
                pending.extend(self._get_children_locked(note_id))
            referrers: Set[str] = set()
            for note_id in subtree:
                referrers |= self._referrers_locked(note_id)
            return frozenset(referrers - subtree)

    def _insert_link(self, parent_id, note_id, prev_id, next_id) -> None:
        note = self._note_map[note_id]
        assert note.parent_id == parent_id
        self._ordering.insert(self._note_map, note, prev_id=prev_id, next_id=next_id)

    def _remove_link(self, parent_id, note_id) -> None:
        note = self._note_map[note_id]
        assert note.parent_id == parent_id
        self._ordering.remove(self._note_map, note)

    # Accessors -----------------------------------------------------------------

    def get_note(self, note_id: str) -> NoteRecord:
        with self._lock:
            if note_id not in self._note_map:
                raise KeyError(f"Note {note_id} not present in NoteStore")
            return self._note_map[note_id]

    def draft_effective_tag_terms(self, *, note_id: str, tags: str, plaintext: str) -> FrozenSet[str]:
        """The note's searchable tags if its own tags and text were the unsaved draft.

        Like the saved note's tags: its own tags, its proposals, what its
        parents and embeds give it, and what the tag rules infer from them and
        the text.
        """
        if not isinstance(tags, str):
            raise TypeError("tags must be a string")
        if not isinstance(plaintext, str):
            raise TypeError("plaintext must be a string")
        record = self.get_note(note_id)
        ontology = get_ontology()
        base_tags = (
            extract_tags_for_search(tags)
            | record.proposed_tag_terms
            | self.get_inherited_non_meta_tag_terms(note_id)
            | self.get_inherited_proposed_non_meta_tag_terms(note_id)
        )
        return ontology.infer_effective_tags(base_tags=base_tags, plaintext=plaintext)

    def draft_accepted_effective_tag_terms(self, *, note_id: str, tags: str, plaintext: str) -> FrozenSet[str]:
        """draft_effective_tag_terms without any proposal: its own `tags`, the accepted
        tags its parents and embeds give it, and what the tag rules infer from those and
        the text. The cloud privacy whitelist counts only these, so a proposed tag can
        never make a note visible to the AI."""
        if not isinstance(tags, str):
            raise TypeError("tags must be a string")
        if not isinstance(plaintext, str):
            raise TypeError("plaintext must be a string")
        base_tags = extract_tags_for_search(tags) | self.get_inherited_non_meta_tag_terms(note_id)
        return get_ontology().infer_effective_tags(base_tags=base_tags, plaintext=plaintext)

    def accepted_effective_tag_terms(self, note_id: str) -> FrozenSet[str]:
        """The saved note's draft_accepted_effective_tag_terms."""
        record = self.get_note(note_id)
        return self.draft_accepted_effective_tag_terms(
            note_id=note_id, tags=record.tags, plaintext=strip_html(record.content))

    def has_note(self, note_id: str) -> bool:
        with self._lock:
            return note_id in self._note_map

    def list_note_ids(self) -> List[str]:
        with self._lock:
            return list(self._note_map.keys())

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> FrozenSet[str]:
        if not isinstance(note_id, str) or not note_id:
            raise TypeError("note_id must be a non-empty string")

        with self._lock:
            if not self._loaded:
                raise RuntimeError("NoteStore is not loaded")

            if note_id not in self._note_map:
                raise KeyError(f"Note {note_id} not present in NoteStore")

            return self._inherited_tag_terms_locked(
                note_id, self._effective_non_meta_tag_terms, self._subtree_non_meta_tag_terms)

    def get_inherited_proposed_non_meta_tag_terms(self, note_id: str) -> FrozenSet[str]:
        if not isinstance(note_id, str) or not note_id:
            raise TypeError("note_id must be a non-empty string")
        with self._lock:
            if not self._loaded:
                raise RuntimeError("NoteStore is not loaded")
            if note_id not in self._note_map:
                raise KeyError(f"Note {note_id} not present in NoteStore")
            return self._inherited_tag_terms_locked(
                note_id, self._effective_proposed_non_meta_tag_terms, self._subtree_proposed_non_meta_tag_terms)

    def apply_bulk_tag_sources(self, changes: Mapping[str, tuple[str, str]]) -> None:
        """Publish many notes' tag sources with one incremental recompute.

        Recomputing from all changed notes at once reaches the same state as
        editing them one by one (or rebuilding everything), without repeating
        the inheritance walk and search publication per note.
        """
        assert self._loaded
        with self._lock:
            self._revision += 1
            replacements = {}
            for note_id, (tags, proposed_tags) in changes.items():
                record = self._note_map[note_id]
                if record.tags != tags:
                    self._backlink_index.upsert(note_id, record.content, tags)
                own, non_meta = _derive_own_tag_terms(tags=tags, content_html=record.content)
                proposed, proposed_non_meta = _parse_tag_string_terms(proposed_tags)
                replacements[note_id] = replace(record, tags=tags, proposed_tags=proposed_tags,
                    tag_terms=own, non_meta_tag_terms=non_meta,
                    proposed_tag_terms=proposed, proposed_non_meta_tag_terms=proposed_non_meta)
            self._note_map.update(replacements)
            tag_updates = self._recompute_effective_tag_terms_locked(set(replacements), subtree_root_ids=())
        self._publish_tag_updates(tag_updates)
        ontology = get_ontology()
        for note_id, record in replacements.items():
            raw = tag_updates[note_id]
            plaintext = get_cached_text(note_id)
            inferred_plaintext = ""
            if ontology.matcher_rules:
                inferred_plaintext = plaintext
            effective = ontology.infer_effective_tags(base_tags=raw, plaintext=inferred_plaintext)
            search_index.upsert(note_id=note_id, content_text=_search_text(record.content, plaintext),
                                tags=record.tags, raw_tag_terms=raw, tag_terms=effective)

    def refresh_tags_for_value_rules(self, *, rule_texts: list[str]) -> int:
        """After a rule testing values changed: the tags of the notes it can concern (with a
        value of a property it tests, or carrying a tag a `?` term tests, on the tag or a tag
        implying it), and through them their children and the notes referencing them; not
        the whole vault. rule_texts: the rule as it was and as it is."""
        if not self._loaded:
            return 0
        conditions = [condition for text in rule_texts for condition in rule_text_conditions(text)]
        assert conditions, "Only a rule testing values is refreshed here"
        candidate_ids = set().union(*(search_index.note_ids_for_property_term(condition) for condition in conditions))
        with self._lock:
            candidate_ids &= self._note_map.keys()
            if not candidate_ids:
                return 0
            tag_updates = self._recompute_effective_tag_terms_locked(candidate_ids, subtree_root_ids=candidate_ids)
        self._publish_tag_updates(tag_updates)
        return len(tag_updates)

    def rebuild_search_index_tag_terms(self) -> None:
        """Recompute search-index tag terms for all notes.

        This applies hierarchical inheritance first, then overlays ontology inference.
        """
        if not self._loaded:
            return

        with self._lock:
            effective_tag_terms_by_id = self._rebuild_effective_tag_terms_locked()
            content_by_id = {
                note_id: record.content for note_id, record in self._note_map.items()
            }

        ontology = get_ontology()
        matcher_rules_enabled = bool(ontology.matcher_rules)
        inferred_updates: Dict[str, FrozenSet[str]] = {}
        for note_id, base_terms in effective_tag_terms_by_id.items():
            if note_id not in content_by_id:
                raise RuntimeError(f"Integrity failure: missing note content for {note_id}")
            inferred_plaintext = ""
            if matcher_rules_enabled:
                inferred_plaintext = strip_html(content_by_id[note_id])
            inferred_updates[note_id] = ontology.infer_effective_tags(
                base_tags=base_terms,
                plaintext=inferred_plaintext,
            )

        search_index.bulk_update_raw_tag_terms(effective_tag_terms_by_id)
        search_index.bulk_update_tag_terms(inferred_updates)

    def rebuild_search_index_tag_terms_for_notes(self, note_ids: Iterable[str]) -> int:
        """Recompute search-index tag terms for a subset of notes."""
        if not self._loaded:
            return 0

        note_id_list = list(dict.fromkeys(note_ids))
        if not note_id_list:
            return 0

        with self._lock:
            base_terms_by_id: Dict[str, FrozenSet[str]] = {}
            content_by_id: Dict[str, str] = {}
            for note_id in note_id_list:
                if note_id not in self._note_map:
                    # Candidates come from rule text matches and may include deleted notes.
                    continue
                record = self._note_map[note_id]
                base_terms_by_id[note_id] = (
                    record.tag_terms
                    | self._effective_non_meta_tag_terms[note_id]
                    | record.proposed_tag_terms
                    | self._effective_proposed_non_meta_tag_terms[note_id]
                )
                content_by_id[note_id] = record.content

        if not base_terms_by_id:
            return 0

        ontology = get_ontology()
        matcher_rules_enabled = bool(ontology.matcher_rules)
        inferred_updates: Dict[str, FrozenSet[str]] = {}
        for note_id, base_terms in base_terms_by_id.items():
            inferred_plaintext = ""
            if matcher_rules_enabled:
                inferred_plaintext = strip_html(content_by_id[note_id])
            inferred_updates[note_id] = ontology.infer_effective_tags(
                base_tags=base_terms,
                plaintext=inferred_plaintext,
            )

        search_index.bulk_update_raw_tag_terms(base_terms_by_id)
        search_index.bulk_update_tag_terms(inferred_updates)
        return len(inferred_updates)

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        with self._lock:
            return self._get_children_locked(parent_id)


store = NoteStore()


__all__ = ["NoteStore", "NoteRecord", "store"]
