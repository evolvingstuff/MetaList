"""In-memory snapshot of the note hierarchy.

The store is responsible for eagerly loading the note table at startup and
providing fast, read-only access to decrypted content plus linked-list
metadata that the rest of the application relies on.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace
from datetime import datetime
from threading import RLock
from typing import Dict, FrozenSet, Iterable, List, Optional, Sequence, Mapping, Set
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
from app.services.hydration_state import hydration_state
from app.services.hierarchy import hierarchy_depths
from app.services.note_ordering import NoteOrdering
from app.services.tag_ontology import TagOntology
from app.services.note_image_tags import infer_image_tag_terms
from app.services.ontology_rules_store import get_ontology
from app.services.search_index import SearchRecord, extract_tags_for_search, search_index
from app.utils.text_utils import strip_html


def _derive_own_tag_terms(*, tags: str, content_html: str) -> tuple[FrozenSet[str], FrozenSet[str]]:
    tag_terms = extract_tags_for_search(tags) | infer_image_tag_terms(
        content_html=content_html,
        is_image_file=file_registry.has_image_file,
    )
    non_meta_tag_terms = frozenset(term for term in tag_terms if not term.startswith("@"))
    return tag_terms, non_meta_tag_terms


def _derive_proposed_tag_terms(proposed_tags: str) -> tuple[FrozenSet[str], FrozenSet[str]]:
    if not isinstance(proposed_tags, str):
        raise TypeError("proposed_tags must be a string")
    tag_terms = extract_tags_for_search(proposed_tags)
    non_meta_tag_terms = frozenset(term for term in tag_terms if not term.startswith("@"))
    return tag_terms, non_meta_tag_terms


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
        self._effective_non_meta_tag_terms: Dict[str, FrozenSet[str]] = {}
        self._effective_proposed_non_meta_tag_terms: Dict[str, FrozenSet[str]] = {}
        self._loaded = False
        self._revision = 0
        self._timing_enabled = True

    def _get_children_locked(self, parent_id: Optional[str]) -> List[str]:
        return self._ordering.children(self._note_map, parent_id)

    def _tag_dependencies_locked(self, note_id: str) -> set[str]:
        record = self._note_map[note_id]
        dependencies = set(self._backlink_index.get_target_ids(note_id)) & self._note_map.keys()
        if record.parent_id is not None:
            assert record.parent_id in self._note_map
            dependencies.add(record.parent_id)
        return dependencies

    def _tag_dependents_locked(self, note_id: str) -> set[str]:
        return (set(self._get_children_locked(note_id))
                | (self._backlink_index.get_counts(note_id).keys() & self._note_map.keys()))

    def _raw_tag_terms_locked(self, note_id: str) -> FrozenSet[str]:
        record = self._note_map[note_id]
        return (record.tag_terms | record.proposed_tag_terms
                | self._effective_non_meta_tag_terms[note_id]
                | self._effective_proposed_non_meta_tag_terms[note_id])

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
        return self._propagate_inherited_tag_terms_locked(visited)

    def _recompute_effective_tag_terms_locked(self, root_ids: Iterable[str]) -> Dict[str, FrozenSet[str]]:
        # Include both hierarchy descendants and referrers, transitively. Rebuilding
        # this closure from direct tags also removes stale tags from reference cycles.
        affected: set[str] = set()
        pending = list(root_ids)
        while pending:
            note_id = pending.pop()
            assert note_id in self._note_map
            if note_id in affected:
                continue
            affected.add(note_id)
            pending.extend(self._tag_dependents_locked(note_id) - affected)
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

    def _propagate_inherited_tag_terms_locked(self, affected: set[str]) -> Dict[str, FrozenSet[str]]:
        dependents = {note_id: set() for note_id in affected}
        for note_id in affected:
            record = self._note_map[note_id]
            accepted = record.non_meta_tag_terms
            proposed = record.proposed_non_meta_tag_terms
            for source_id in self._tag_dependencies_locked(note_id):
                if source_id in affected:
                    dependents[source_id].add(note_id)
                else:
                    accepted |= self._effective_non_meta_tag_terms[source_id]
                    proposed |= self._effective_proposed_non_meta_tag_terms[source_id]
            self._effective_non_meta_tag_terms[note_id] = accepted
            self._effective_proposed_non_meta_tag_terms[note_id] = proposed

        pending = deque(affected)
        queued = set(affected)
        while pending:
            source_id = pending.popleft()
            queued.remove(source_id)
            for note_id in dependents[source_id]:
                accepted = (self._effective_non_meta_tag_terms[note_id]
                            | self._effective_non_meta_tag_terms[source_id])
                proposed = (self._effective_proposed_non_meta_tag_terms[note_id]
                            | self._effective_proposed_non_meta_tag_terms[source_id])
                if (accepted == self._effective_non_meta_tag_terms[note_id]
                        and proposed == self._effective_proposed_non_meta_tag_terms[note_id]):
                    continue
                self._effective_non_meta_tag_terms[note_id] = accepted
                self._effective_proposed_non_meta_tag_terms[note_id] = proposed
                if note_id not in queued:
                    pending.append(note_id)
                    queued.add(note_id)
        return {note_id: self._raw_tag_terms_locked(note_id) for note_id in affected}

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
            if hydration_state.is_running() and processed_candidates % 1000 == 0:
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

        for row in rows:
            note = SimpleNamespace(**row)
            plaintext = get_cached_content(note.id)
            tags = get_cached_tags(note.id)
            proposed_tags = get_cached_proposed_tags(note.id)
            content_text_by_id[note.id] = get_cached_text(note.id)
            tag_terms, non_meta_tag_terms = _derive_own_tag_terms(
                tags=tags,
                content_html=plaintext,
            )
            proposed_tag_terms, proposed_non_meta_tag_terms = _derive_proposed_tag_terms(
                proposed_tags
            )

            note_map[note.id] = NoteRecord(
                id=note.id,
                parent_id=note.parent_id,
                prev_id=note.prev_id,
                next_id=note.next_id,
                is_collapsed=bool(getattr(note, "is_collapsed", False)),
                content=plaintext,
                tags=tags,
                proposed_tags=proposed_tags,
                tag_terms=tag_terms,
                non_meta_tag_terms=non_meta_tag_terms,
                proposed_tag_terms=proposed_tag_terms,
                proposed_non_meta_tag_terms=proposed_non_meta_tag_terms,
                created_at=getattr(note, "created_at", None),
                updated_at=getattr(note, "updated_at", None),
            )

            processed += 1
            if timing_enabled and processed % 1000 == 0:
                now = time.perf_counter()
                batch_elapsed = now - last_checkpoint
                total_elapsed = now - loop_start
                print(
                    f"[startup] note_store hydrated {processed} notes | last 1000 in {batch_elapsed:.2f}s | total {total_elapsed:.2f}s"
                )
                last_checkpoint = now
            if hydration_state.is_running() and processed % 1000 == 0:
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
            search_records.append(
                SearchRecord(
                    note_id=record.id,
                    content_text=content_text_by_id[record.id],
                    tags=record.tags,
                    tag_terms=tag_only_terms,
                )
            )
            if hydration_state.is_running() and len(search_records) % 1000 == 0:
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

        search_index.rebuild(
            search_records,
            raw_tag_terms_by_id=effective_tag_terms_by_id,
            progress_update=_update_search_index_progress,
            progress_interval=1000,
        )
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
        proposed_tag_terms, proposed_non_meta_tag_terms = _derive_proposed_tag_terms(
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
                is_collapsed=bool(getattr(note, "is_collapsed", False)),
                content=plaintext,
                tags=tags,
                proposed_tags=proposed_tags,
                tag_terms=tag_terms,
                non_meta_tag_terms=non_meta_tag_terms,
                proposed_tag_terms=proposed_tag_terms,
                proposed_non_meta_tag_terms=proposed_non_meta_tag_terms,
                created_at=getattr(note, "created_at", None),
                updated_at=getattr(note, "updated_at", None),
            )
            self._note_map[note.id] = record
            self._backlink_index.upsert(record.id, record.content, record.tags)
            self._insert_link(record.parent_id, record.id, record.prev_id, record.next_id)

            tag_updates = self._recompute_effective_tag_terms_locked({record.id})
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
            content_text=content_text,
            tags=record.tags,
            raw_tag_terms=effective_tag_terms,
            tag_terms=effective_with_ontology,
        )

        self._publish_tag_updates(tag_updates)

    def update_note_from_db(
        self,
        note: SimpleNamespace,
        plaintext: str,
        tags: str,
        proposed_tags: str,
    ) -> None:
        if not self._loaded:
            return
        updated: NoteRecord | None = None
        tag_sources_changed = False
        effective_tag_terms_by_id: Dict[str, FrozenSet[str]] = {}
        with self._lock:
            self._revision += 1
            current = self._note_map.get(note.id)
            if not current:
                return
            tag_sources_changed = current.tags != tags
            if current.proposed_tags != proposed_tags:
                tag_sources_changed = True
            tag_terms, non_meta_tag_terms = _derive_own_tag_terms(
                tags=tags,
                content_html=plaintext,
            )
            proposed_tag_terms, proposed_non_meta_tag_terms = _derive_proposed_tag_terms(
                proposed_tags
            )
            updated = NoteRecord(
                id=note.id,
                parent_id=current.parent_id,
                prev_id=current.prev_id,
                next_id=current.next_id,
                is_collapsed=current.is_collapsed,
                content=plaintext,
                tags=tags,
                proposed_tags=proposed_tags,
                tag_terms=tag_terms,
                non_meta_tag_terms=non_meta_tag_terms,
                proposed_tag_terms=proposed_tag_terms,
                proposed_non_meta_tag_terms=proposed_non_meta_tag_terms,
                created_at=getattr(note, "created_at", current.created_at),
                updated_at=getattr(note, "updated_at", current.updated_at),
            )
            self._note_map[note.id] = updated

            if current.content != plaintext or current.tags != tags:
                old_targets = self._backlink_index.get_target_ids(updated.id)
                self._backlink_index.upsert(updated.id, updated.content, updated.tags)
                if old_targets != self._backlink_index.get_target_ids(updated.id):
                    tag_sources_changed = True

            if tag_sources_changed:
                effective_tag_terms_by_id = self._recompute_effective_tag_terms_locked({note.id})
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
            content_text=content_text,
            tags=updated.tags,
            raw_tag_terms=effective_tag_terms,
            tag_terms=effective_with_ontology,
        )

        if tag_sources_changed:
            self._publish_tag_updates(effective_tag_terms_by_id)

    def update_metadata_from_db(self, note: SimpleNamespace, *, rebuild: bool) -> None:
        if not self._loaded:
            return
        if rebuild:
            self.bulk_update_metadata([note], rebuild=True)
            return
        with self._lock:
            self._revision += 1
            record = self._note_map[note.id]
            self._remove_link(record.parent_id, record.id)
            updated = replace(record, parent_id=note.parent_id,
                              created_at=getattr(note, 'created_at', record.created_at),
                              updated_at=getattr(note, 'updated_at', record.updated_at))
            self._note_map[note.id] = updated
            next_id = note.next_id
            if next_id == note.id:
                # Moving after an adjacent predecessor is an unchanged placement.
                next_id = record.next_id
            self._insert_link(note.parent_id, note.id, note.prev_id, next_id)
            tag_updates = {}
            if record.parent_id != note.parent_id:
                tag_updates = self._recompute_effective_tag_terms_locked({note.id})
        self._publish_tag_updates(tag_updates)

    def bulk_update_metadata(self, notes: Iterable[SimpleNamespace], *, rebuild: bool) -> None:
        """Apply pointer metadata for multiple notes without repeated rebuilds."""
        if not self._loaded:
            return

        payload = list(notes)
        if not payload:
            return

        tag_updates: Dict[str, FrozenSet[str]] = {}
        with self._lock:
            self._revision += 1
            replacements = {}
            moved_ids: Set[str] = set()

            for note in payload:
                record = self._note_map[note.id]

                updated = NoteRecord(
                    id=record.id,
                    parent_id=getattr(note, "parent_id", record.parent_id),
                    prev_id=getattr(note, "prev_id", record.prev_id),
                    next_id=getattr(note, "next_id", record.next_id),
                    is_collapsed=record.is_collapsed,
                    content=record.content,
                    tags=record.tags,
                    proposed_tags=record.proposed_tags,
                    tag_terms=record.tag_terms,
                    non_meta_tag_terms=record.non_meta_tag_terms,
                    proposed_tag_terms=record.proposed_tag_terms,
                    proposed_non_meta_tag_terms=record.proposed_non_meta_tag_terms,
                    created_at=record.created_at,
                    updated_at=getattr(note, "updated_at", record.updated_at),
                )

                replacements[note.id] = updated
                if record.parent_id != updated.parent_id:
                    moved_ids.add(note.id)
            next_records = dict(self._note_map)
            next_records.update(replacements)
            if moved_ids:
                hierarchy_depths({note_id: record.parent_id for note_id, record in next_records.items()})
            next_ordering = NoteOrdering.from_records(next_records)
            self._note_map = next_records
            self._ordering = next_ordering

            if moved_ids:
                tag_updates = self._recompute_effective_tag_terms_locked(moved_ids)

        self._publish_tag_updates(tag_updates)

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
                self._ordering.heads.pop(removed_id, None)
                self._ordering.tails.pop(removed_id, None)

            referrer_ids = set()
            for removed_id in removed_ids:
                referrer_ids.update(self._backlink_index.get_counts(removed_id))
            for removed_id in removed_ids:
                self._backlink_index.remove(removed_id)
                self._effective_non_meta_tag_terms.pop(removed_id, None)
                self._effective_proposed_non_meta_tag_terms.pop(removed_id, None)

            tag_updates = self._recompute_effective_tag_terms_locked(
                referrer_ids & self._note_map.keys())

        if removed_ids:
            search_index.remove_many(removed_ids)
        self._publish_tag_updates(tag_updates)

    def set_collapsed(self, note_id: str, collapsed: bool) -> None:
        if not self._loaded:
            return
        with self._lock:
            self._revision += 1
            record = self._note_map.get(note_id)
            if not record or record.is_collapsed == collapsed:
                return
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

    def get_backlink_counts(self, note_id: str) -> Dict[str, int]:
        with self._lock:
            if note_id not in self._note_map:
                raise KeyError(f"Note {note_id} not present in NoteStore")
            return self._backlink_index.get_counts(note_id)

    def _rebuild_indexes_locked(self) -> None:
        self._ordering = NoteOrdering.from_records(self._note_map)

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
            record = self._note_map.get(note_id)

        if record is None:
            raise KeyError(f"Note {note_id} not present in NoteStore")

        return record

    def list_local_effective_tag_terms(
        self,
        *,
        note_id: str,
        plaintext: str,
    ) -> FrozenSet[str]:
        """Infer searchable tags from this note alone, excluding ancestors."""
        if not isinstance(note_id, str) or note_id == "":
            raise TypeError("note_id must be a non-empty string")
        if not isinstance(plaintext, str):
            raise TypeError("plaintext must be a string")
        record = self.get_note(note_id)
        ontology = get_ontology()
        return ontology.infer_effective_tags(
            base_tags=record.tag_terms | record.proposed_tag_terms,
            plaintext=plaintext,
        )

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

            record = self._note_map.get(note_id)
            if record is None:
                raise KeyError(f"Note {note_id} not present in NoteStore")

            return frozenset().union(*(self._effective_non_meta_tag_terms[source_id]
                                       for source_id in self._tag_dependencies_locked(note_id)))

    def get_inherited_proposed_non_meta_tag_terms(self, note_id: str) -> FrozenSet[str]:
        if not isinstance(note_id, str) or not note_id:
            raise TypeError("note_id must be a non-empty string")
        with self._lock:
            if not self._loaded:
                raise RuntimeError("NoteStore is not loaded")
            if note_id not in self._note_map:
                raise KeyError(f"Note {note_id} not present in NoteStore")
            return frozenset().union(*(self._effective_proposed_non_meta_tag_terms[source_id]
                                       for source_id in self._tag_dependencies_locked(note_id)))

    def apply_bulk_tag_sources(self, changes: Mapping[str, tuple[str, str]]) -> None:
        """Publish sources together and rebuild inheritance once for the whole pass."""
        assert self._loaded
        with self._lock:
            self._revision += 1
            replacements = {}
            for note_id, (tags, proposed_tags) in changes.items():
                record = self._note_map[note_id]
                if record.tags != tags:
                    self._backlink_index.upsert(note_id, record.content, tags)
                own, non_meta = _derive_own_tag_terms(tags=tags, content_html=record.content)
                proposed, proposed_non_meta = _derive_proposed_tag_terms(proposed_tags)
                replacements[note_id] = replace(record, tags=tags, proposed_tags=proposed_tags,
                    tag_terms=own, non_meta_tag_terms=non_meta,
                    proposed_tag_terms=proposed, proposed_non_meta_tag_terms=proposed_non_meta)
            self._note_map.update(replacements)
            self.rebuild_search_index_tag_terms()
            for note_id, record in replacements.items():
                raw = (self._effective_non_meta_tag_terms[note_id]
                       | self._effective_proposed_non_meta_tag_terms[note_id]
                       | record.tag_terms | record.proposed_tag_terms)
                plaintext = strip_html(record.content)
                effective = get_ontology().infer_effective_tags(base_tags=raw, plaintext=plaintext)
                search_index.upsert(note_id=note_id, content_text=plaintext,
                                    tags=record.tags, raw_tag_terms=raw, tag_terms=effective)

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
                record = self._note_map.get(note_id)
                if record is None:
                    continue
                inherited = self._effective_non_meta_tag_terms.get(note_id)
                if inherited is None:
                    raise RuntimeError(
                        "Integrity failure: missing inherited tag terms for "
                        f"note {note_id}"
                    )
                proposed = self._effective_proposed_non_meta_tag_terms.get(note_id)
                if proposed is None:
                    raise RuntimeError(
                        "Integrity failure: missing effective proposed tag terms for "
                        f"note {note_id}"
                    )
                base_terms_by_id[note_id] = (
                    record.tag_terms
                    | inherited
                    | record.proposed_tag_terms
                    | proposed
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

    def debug_validate_links(self, *note_ids: Optional[str]) -> None:
        with self._lock:
            for note_id in note_ids:
                if note_id is not None and note_id in self._note_map:
                    self._ordering.validate_neighbors(self._note_map, note_id)


store = NoteStore()


__all__ = ["NoteStore", "NoteRecord", "store"]
