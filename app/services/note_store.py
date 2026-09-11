"""In-memory snapshot of the note hierarchy.

The store is responsible for eagerly loading the note table at startup and
providing fast, read-only access to decrypted content plus linked-list
metadata that the rest of the application relies on.
"""

from __future__ import annotations

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
        self._links: Dict[Optional[str], Dict[str, Dict[str, Optional[str]]]] = {}
        self._heads: Dict[Optional[str], Optional[str]] = {}
        self._tails: Dict[Optional[str], Optional[str]] = {}
        self._effective_non_meta_tag_terms: Dict[str, FrozenSet[str]] = {}
        self._effective_proposed_non_meta_tag_terms: Dict[str, FrozenSet[str]] = {}
        self._loaded = False
        self._timing_enabled = True

    def _get_children_locked(self, parent_id: Optional[str]) -> List[str]:
        head = self._heads.get(parent_id)
        if head is None:
            return []
        links = self._links.get(parent_id)
        if not links:
            return []
        ordered: List[str] = []
        current = head
        visited: set[str] = set()
        while current and current not in visited:
            ordered.append(current)
            visited.add(current)
            link = links[current]
            if link is None:
                raise RuntimeError(
                    "Integrity failure: child list contains node missing from links: "
                    f"parent_id={parent_id} note_id={current}"
                )
            current = link['next']
        return ordered

    def _rebuild_effective_tag_terms_locked(self) -> Dict[str, FrozenSet[str]]:
        self._effective_non_meta_tag_terms.clear()
        self._effective_proposed_non_meta_tag_terms.clear()

        effective_tag_terms: Dict[str, FrozenSet[str]] = {}
        visited: set[str] = set()
        to_visit: List[tuple[str, FrozenSet[str], FrozenSet[str]]] = [
            (root_id, frozenset(), frozenset()) for root_id in self._get_children_locked(None)
        ]

        while to_visit:
            note_id, inherited_non_meta, inherited_proposed_non_meta = to_visit.pop()
            if note_id in visited:
                raise RuntimeError(f"Integrity failure: cycle detected during tag inheritance at note {note_id}")
            visited.add(note_id)

            record = self._note_map.get(note_id)
            if record is None:
                raise RuntimeError(
                    f"Integrity failure: note {note_id} present in child lists but missing from note_map"
                )

            effective_tag_terms[note_id] = (
                record.tag_terms
                | inherited_non_meta
                | record.proposed_tag_terms
                | inherited_proposed_non_meta
            )
            effective_non_meta = inherited_non_meta | record.non_meta_tag_terms
            self._effective_non_meta_tag_terms[note_id] = effective_non_meta
            effective_proposed_non_meta = (
                inherited_proposed_non_meta | record.proposed_non_meta_tag_terms
            )
            self._effective_proposed_non_meta_tag_terms[note_id] = effective_proposed_non_meta

            children = self._get_children_locked(note_id)
            for child_id in children:
                to_visit.append((child_id, effective_non_meta, effective_proposed_non_meta))

        if len(visited) != len(self._note_map):
            missing = set(self._note_map.keys()) - visited
            raise RuntimeError(
                "Integrity failure: some notes are unreachable during tag inheritance computation: "
                f"{sorted(missing)[:10]}"
            )

        return effective_tag_terms

    def _recompute_effective_tag_terms_subtree_locked(self, root_id: str) -> Dict[str, FrozenSet[str]]:
        root_record = self._note_map.get(root_id)
        if root_record is None:
            raise KeyError(f"Note {root_id} not present in NoteStore")

        if root_record.parent_id is None:
            inherited_non_meta: FrozenSet[str] = frozenset()
            inherited_proposed_non_meta: FrozenSet[str] = frozenset()
        else:
            inherited_non_meta = self._effective_non_meta_tag_terms.get(root_record.parent_id)
            if inherited_non_meta is None:
                raise RuntimeError(
                    "Integrity failure: missing effective tag terms for parent "
                    f"{root_record.parent_id} (child {root_id})"
                )
            inherited_proposed_non_meta = self._effective_proposed_non_meta_tag_terms.get(
                root_record.parent_id
            )
            if inherited_proposed_non_meta is None:
                raise RuntimeError(
                    "Integrity failure: missing effective proposed tag terms for parent "
                    f"{root_record.parent_id} (child {root_id})"
                )

        effective_tag_terms: Dict[str, FrozenSet[str]] = {}
        visited: set[str] = set()
        to_visit: List[tuple[str, FrozenSet[str], FrozenSet[str]]] = [
            (root_id, inherited_non_meta, inherited_proposed_non_meta)
        ]

        while to_visit:
            note_id, current_inherited_non_meta, current_inherited_proposed = to_visit.pop()
            if note_id in visited:
                raise RuntimeError(
                    f"Integrity failure: cycle detected during tag inheritance at note {note_id}"
                )
            visited.add(note_id)

            record = self._note_map.get(note_id)
            if record is None:
                raise RuntimeError(
                    f"Integrity failure: note {note_id} present in child lists but missing from note_map"
                )

            effective_tag_terms[note_id] = (
                record.tag_terms
                | current_inherited_non_meta
                | record.proposed_tag_terms
                | current_inherited_proposed
            )
            effective_non_meta = current_inherited_non_meta | record.non_meta_tag_terms
            self._effective_non_meta_tag_terms[note_id] = effective_non_meta
            effective_proposed_non_meta = (
                current_inherited_proposed | record.proposed_non_meta_tag_terms
            )
            self._effective_proposed_non_meta_tag_terms[note_id] = effective_proposed_non_meta

            children = self._get_children_locked(note_id)
            for child_id in children:
                to_visit.append((child_id, effective_non_meta, effective_proposed_non_meta))

        return effective_tag_terms

    @property
    def loaded(self) -> bool:
        return self._loaded

    def reset(self) -> None:
        with self._lock:
            self._note_map.clear()
            self._backlink_index.clear()
            self._links.clear()
            self._heads.clear()
            self._tails.clear()
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

            self._note_map = note_map
            self._backlink_index.clear()
            for record in note_map.values():
                self._backlink_index.upsert(record.id, record.content, record.tags)
            index_start = time.perf_counter()
            self._rebuild_indexes_locked()
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

            if timing_enabled:
                total_elapsed = time.perf_counter() - loop_start
                print(
                    f"[startup] note_store hydration loop processed {processed} notes in {total_elapsed:.2f}s"
                )
        search_records: List[SearchRecord] = []
        ontology = get_ontology()
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

        if not ontology.matcher_rules:
            return

        candidate_start = time.perf_counter()
        matcher_generated_tags = _collect_matcher_generated_tags(ontology)
        candidate_note_ids: Set[str] = set()
        all_note_ids: Set[str] | None = None
        needs_plaintext = any(
            rule.required_text_patterns or rule.required_regexes for rule in ontology.matcher_rules
        )
        raw_text_cache: Dict[str, str] = dict(content_text_by_id)

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
                    if note_id not in raw_text_cache:
                        raise RuntimeError(
                            f"Integrity failure: missing raw text for candidate note {note_id}"
                        )
                    raw_text = raw_text_cache[note_id]
                    matched = True
                    for regex in rule.required_regexes:
                        if regex.search(raw_text) is None:
                            matched = False
                            break
                    if matched:
                        filtered.add(note_id)
                rule_candidates = filtered

            candidate_note_ids.update(rule_candidates)

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
                if note_id not in raw_text_cache:
                    raise RuntimeError(
                        f"Integrity failure: missing raw text for ontology inference note {note_id}"
                    )
                inferred_plaintext = raw_text_cache[note_id]
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
        effective_tag_terms: FrozenSet[str] | None = None
        content_text = strip_html(plaintext)
        with self._lock:
            if note.parent_id is None:
                inherited_non_meta: FrozenSet[str] = frozenset()
                inherited_proposed_non_meta: FrozenSet[str] = frozenset()
            else:
                inherited_non_meta = self._effective_non_meta_tag_terms.get(note.parent_id)
                if inherited_non_meta is None:
                    raise RuntimeError(
                        "Integrity failure: missing effective tag terms for parent "
                        f"{note.parent_id} (child {note.id})"
                    )
                inherited_proposed_non_meta = self._effective_proposed_non_meta_tag_terms.get(
                    note.parent_id
                )
                if inherited_proposed_non_meta is None:
                    raise RuntimeError(
                        "Integrity failure: missing effective proposed tag terms for parent "
                        f"{note.parent_id} (child {note.id})"
                    )

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

            effective_tag_terms = (
                record.tag_terms
                | inherited_non_meta
                | record.proposed_tag_terms
                | inherited_proposed_non_meta
            )
            self._effective_non_meta_tag_terms[record.id] = inherited_non_meta | record.non_meta_tag_terms
            self._effective_proposed_non_meta_tag_terms[record.id] = (
                inherited_proposed_non_meta | record.proposed_non_meta_tag_terms
            )
        assert effective_tag_terms is not None

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
        inherited_non_meta: FrozenSet[str] | None = None
        inherited_proposed_non_meta: FrozenSet[str] | None = None
        effective_tag_terms_by_id: Dict[str, FrozenSet[str]] | None = None
        with self._lock:
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
                self._backlink_index.upsert(updated.id, updated.content, updated.tags)

            if tag_sources_changed:
                effective_tag_terms_by_id = self._recompute_effective_tag_terms_subtree_locked(note.id)
            else:
                if updated.parent_id is None:
                    inherited_non_meta = frozenset()
                    inherited_proposed_non_meta = frozenset()
                else:
                    inherited_non_meta = self._effective_non_meta_tag_terms.get(updated.parent_id)
                    if inherited_non_meta is None:
                        raise RuntimeError(
                            "Integrity failure: missing effective tag terms for parent "
                            f"{updated.parent_id} (child {updated.id})"
                        )
                    inherited_proposed_non_meta = self._effective_proposed_non_meta_tag_terms.get(
                        updated.parent_id
                    )
                    if inherited_proposed_non_meta is None:
                        raise RuntimeError(
                            "Integrity failure: missing effective proposed tag terms for parent "
                            f"{updated.parent_id} (child {updated.id})"
                        )

        assert updated is not None

        if tag_sources_changed:
            assert effective_tag_terms_by_id is not None

            ontology = get_ontology()
            matcher_rules_enabled = bool(ontology.matcher_rules)
            effective_with_ontology_by_id: Dict[str, FrozenSet[str]] = {}
            for note_id, base_terms in effective_tag_terms_by_id.items():
                record = self.get_note(note_id)
                content_text = strip_html(record.content)
                inferred_plaintext = ""
                if matcher_rules_enabled:
                    inferred_plaintext = content_text
                effective_with_ontology_by_id[note_id] = ontology.infer_effective_tags(
                    base_tags=base_terms,
                    plaintext=inferred_plaintext,
                )

            effective_for_note = effective_with_ontology_by_id[updated.id]
            search_index.upsert(
                note_id=updated.id,
                content_text=strip_html(updated.content),
                tags=updated.tags,
                raw_tag_terms=effective_tag_terms_by_id[updated.id],
                tag_terms=effective_for_note,
            )

            descendant_updates = {
                note_id: terms
                for note_id, terms in effective_with_ontology_by_id.items()
                if note_id != updated.id
            }
            if descendant_updates:
                descendant_raw_updates = {
                    note_id: terms
                    for note_id, terms in effective_tag_terms_by_id.items()
                    if note_id != updated.id
                }
                search_index.bulk_update_raw_tag_terms(descendant_raw_updates)
                search_index.bulk_update_tag_terms(descendant_updates)
            return

        assert inherited_non_meta is not None
        assert inherited_proposed_non_meta is not None
        effective_tag_terms = (
            updated.tag_terms
            | inherited_non_meta
            | updated.proposed_tag_terms
            | inherited_proposed_non_meta
        )

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

    def update_metadata_from_db(self, note: SimpleNamespace, *, rebuild: bool) -> None:
        if not self._loaded:
            return
        tag_updates: Dict[str, FrozenSet[str]] | None = None
        with self._lock:
            record = self._note_map.get(note.id)
            if not record:
                return
            parent_changed = record.parent_id != note.parent_id
            if rebuild:
                updated = NoteRecord(
                    id=note.id,
                    parent_id=note.parent_id,
                    prev_id=note.prev_id,
                    next_id=note.next_id,
                    is_collapsed=record.is_collapsed,
                    content=record.content,
                    tags=record.tags,
                    proposed_tags=record.proposed_tags,
                    tag_terms=record.tag_terms,
                    non_meta_tag_terms=record.non_meta_tag_terms,
                    proposed_tag_terms=record.proposed_tag_terms,
                    proposed_non_meta_tag_terms=record.proposed_non_meta_tag_terms,
                    created_at=getattr(note, "created_at", record.created_at),
                    updated_at=getattr(note, "updated_at", record.updated_at),
                )
                self._note_map[note.id] = updated
                self._rebuild_indexes_locked()
            else:
                self._remove_link(record.parent_id, record.id)
                updated = NoteRecord(
                    id=note.id,
                    parent_id=note.parent_id,
                    prev_id=note.prev_id,
                    next_id=note.next_id,
                    is_collapsed=record.is_collapsed,
                    content=record.content,
                    tags=record.tags,
                    proposed_tags=record.proposed_tags,
                    tag_terms=record.tag_terms,
                    non_meta_tag_terms=record.non_meta_tag_terms,
                    proposed_tag_terms=record.proposed_tag_terms,
                    proposed_non_meta_tag_terms=record.proposed_non_meta_tag_terms,
                    created_at=getattr(note, "created_at", record.created_at),
                    updated_at=getattr(note, "updated_at", record.updated_at),
                )
                self._note_map[note.id] = updated
                self._insert_link(updated.parent_id, updated.id, updated.prev_id, updated.next_id)

            if parent_changed:
                tag_updates = self._recompute_effective_tag_terms_subtree_locked(note.id)

        if tag_updates:
            search_index.bulk_update_raw_tag_terms(tag_updates)
            ontology = get_ontology()
            matcher_rules_enabled = bool(ontology.matcher_rules)
            inferred_updates: Dict[str, FrozenSet[str]] = {}
            for note_id, base_terms in tag_updates.items():
                record = self.get_note(note_id)
                inferred_plaintext = ""
                if matcher_rules_enabled:
                    inferred_plaintext = strip_html(record.content)
                inferred_updates[note_id] = ontology.infer_effective_tags(
                    base_tags=base_terms,
                    plaintext=inferred_plaintext,
                )
            search_index.bulk_update_tag_terms(inferred_updates)

    def bulk_update_metadata(self, notes: Iterable[SimpleNamespace], *, rebuild: bool) -> None:
        """Apply pointer metadata for multiple notes without repeated rebuilds."""
        if not self._loaded:
            return

        payload = list(notes)
        if not payload:
            return

        tag_updates: Dict[str, FrozenSet[str]] = {}
        with self._lock:
            updates: List[tuple[str, Optional[str], Optional[str], Optional[str], Optional[str]]] = []
            moved_ids: Set[str] = set()

            for note in payload:
                record = self._note_map.get(note.id)
                if not record:
                    continue

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

                self._note_map[note.id] = updated
                if record.parent_id != updated.parent_id:
                    moved_ids.add(note.id)
                updates.append((
                    note.id,
                    record.parent_id,
                    updated.parent_id,
                    updated.prev_id,
                    updated.next_id,
                ))

            if rebuild:
                self._rebuild_indexes_locked()
            else:
                for note_id, old_parent, new_parent, new_prev, new_next in updates:
                    self._remove_link(old_parent, note_id)
                    self._insert_link(new_parent, note_id, new_prev, new_next)

            if moved_ids:
                roots = set(moved_ids)
                for note_id in list(roots):
                    current = self._note_map.get(note_id)
                    if current is None:
                        roots.discard(note_id)
                        continue
                    parent_id = current.parent_id
                    while parent_id is not None:
                        if parent_id in moved_ids:
                            roots.discard(note_id)
                            break
                        parent = self._note_map.get(parent_id)
                        if parent is None:
                            raise RuntimeError(
                                "Integrity failure: moved note references missing parent: "
                                f"note_id={note_id} parent_id={parent_id}"
                            )
                        parent_id = parent.parent_id

                for root_id in roots:
                    tag_updates.update(self._recompute_effective_tag_terms_subtree_locked(root_id))

        if tag_updates:
            search_index.bulk_update_raw_tag_terms(tag_updates)
            ontology = get_ontology()
            matcher_rules_enabled = bool(ontology.matcher_rules)
            inferred_updates: Dict[str, FrozenSet[str]] = {}
            for note_id, base_terms in tag_updates.items():
                record = self.get_note(note_id)
                inferred_plaintext = ""
                if matcher_rules_enabled:
                    inferred_plaintext = strip_html(record.content)
                inferred_updates[note_id] = ontology.infer_effective_tags(
                    base_tags=base_terms,
                    plaintext=inferred_plaintext,
                )
            search_index.bulk_update_tag_terms(inferred_updates)

    def remove_note(self, note_id: str) -> None:
        if not self._loaded:
            return
        removed_ids: Set[str] = set()

        with self._lock:
            to_visit: List[str] = [note_id]
            removed: List[tuple[Optional[str], str]] = []

            while to_visit:
                current = to_visit.pop()
                record = self._note_map.pop(current, None)
                if not record:
                    continue

                removed.append((record.parent_id, record.id))

                child_links = self._links.get(current)
                if child_links:
                    to_visit.extend(child_links.keys())
                    self._links.pop(current, None)
                self._heads.pop(current, None)
                self._tails.pop(current, None)

            removed_ids = {node_id for _, node_id in removed}
            removed_ids = set(removed_ids)

            for removed_id in removed_ids:
                self._backlink_index.remove(removed_id)
                self._effective_non_meta_tag_terms.pop(removed_id, None)
                self._effective_proposed_non_meta_tag_terms.pop(removed_id, None)

            for parent_id, node_id in removed:
                if parent_id in removed_ids:
                    continue
                self._remove_link(parent_id, node_id)

        if removed_ids:
            search_index.remove_many(removed_ids)

    def set_collapsed(self, note_id: str, collapsed: bool) -> None:
        if not self._loaded:
            return
        with self._lock:
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
            # Collapsing/expanding a note must not mutate list structure.
            # Rebuilding indexes here can reorder notes if neighbor pointers in
            # `_note_map` are stale (some mutation paths update `_links` without
            # rewriting every affected NoteRecord). That manifests as a newly
            # created "top" note jumping to the bottom after a collapse action.

    def has_backlinks(self, note_id: str) -> bool:
        with self._lock:
            return note_id in self._note_map and self._backlink_index.has_backlinks(note_id)

    def get_backlink_counts(self, note_id: str) -> Dict[str, int]:
        with self._lock:
            if note_id not in self._note_map:
                raise KeyError(f"Note {note_id} not present in NoteStore")
            return self._backlink_index.get_counts(note_id)

    def _rebuild_indexes_locked(self) -> None:
        links: Dict[Optional[str], Dict[str, Dict[str, Optional[str]]]] = {}
        heads: Dict[Optional[str], Optional[str]] = {}
        tails: Dict[Optional[str], Optional[str]] = {}

        children: Dict[Optional[str], List[str]] = {}
        for record in self._note_map.values():
            children.setdefault(record.parent_id, []).append(record.id)

        for parent_id, ids in children.items():
            ordered = self._order_ids(ids)
            if not ordered:
                continue
            parent_links: Dict[str, Dict[str, Optional[str]]] = {}
            for index, note_id in enumerate(ordered):
                if index > 0:
                    prev_id = ordered[index - 1]
                else:
                    prev_id = None
                if index + 1 < len(ordered):
                    next_id = ordered[index + 1]
                else:
                    next_id = None
                parent_links[note_id] = {'prev': prev_id, 'next': next_id}
            links[parent_id] = parent_links
            heads[parent_id] = ordered[0]
            tails[parent_id] = ordered[-1]

        self._links = links
        self._heads = heads
        self._tails = tails

    def _ensure_parent_structures(self, parent_id: Optional[str]) -> Dict[str, Dict[str, Optional[str]]]:
        if parent_id not in self._links:
            self._links[parent_id] = {}
            self._heads[parent_id] = None
            self._tails[parent_id] = None
        return self._links[parent_id]

    def _update_record_links_locked(
        self,
        note_id: str,
        *,
        parent_id: Optional[str],
        prev_id: Optional[str],
        next_id: Optional[str],
    ) -> None:
        record = self._note_map.get(note_id)
        if not record:
            return

        if record.parent_id == parent_id and record.prev_id == prev_id and record.next_id == next_id:
            return

        self._note_map[note_id] = NoteRecord(
            id=record.id,
            parent_id=parent_id,
            prev_id=prev_id,
            next_id=next_id,
            is_collapsed=record.is_collapsed,
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

    def _assert_links_consistent_locked(self, parent_id: Optional[str], note_ids: Iterable[Optional[str]]) -> None:
        links = self._links.get(parent_id)
        if links is None:
            links = {}
        head = self._heads.get(parent_id)
        tail = self._tails.get(parent_id)

        for note_id in note_ids:
            if not note_id:
                continue

            link = links[note_id]
            if link is None:
                continue

            record = self._note_map.get(note_id)
            if record is None:
                raise RuntimeError(f"Integrity failure: {note_id} present in links but missing from note_map")

            expected_prev = link['prev']
            expected_next = link['next']

            if record.parent_id != parent_id:
                raise RuntimeError(
                    "Integrity failure: parent mismatch for "
                    f"{note_id}: record.parent_id={record.parent_id} links.parent_id={parent_id}"
                )
            if record.prev_id != expected_prev or record.next_id != expected_next:
                raise RuntimeError(
                    "Integrity failure: link mismatch for "
                    f"{note_id}: record prev/next={record.prev_id}/{record.next_id} "
                    f"links prev/next={expected_prev}/{expected_next}"
                )

            if expected_prev is None and head != note_id:
                raise RuntimeError(
                    f"Integrity failure: head mismatch for parent {parent_id}: expected head={note_id} actual head={head}"
                )
            if expected_next is None and tail != note_id:
                raise RuntimeError(
                    f"Integrity failure: tail mismatch for parent {parent_id}: expected tail={note_id} actual tail={tail}"
                )

            if expected_prev is not None:
                prev_link = links[expected_prev]
                if prev_link is None or prev_link.get('next') != note_id:
                    raise RuntimeError(
                        "Integrity failure: prev/next mismatch: "
                        f"prev={expected_prev} links.next={None if prev_link is None else prev_link.get('next')} expected {note_id}"
                    )
                prev_record = self._note_map.get(expected_prev)
                if prev_record is None or prev_record.next_id != note_id:
                    raise RuntimeError(
                        "Integrity failure: prev record mismatch: "
                        f"prev={expected_prev} record.next_id={None if prev_record is None else prev_record.next_id} expected {note_id}"
                    )

            if expected_next is not None:
                next_link = links[expected_next]
                if next_link is None or next_link.get('prev') != note_id:
                    raise RuntimeError(
                        "Integrity failure: next/prev mismatch: "
                        f"next={expected_next} links.prev={None if next_link is None else next_link.get('prev')} expected {note_id}"
                    )
                next_record = self._note_map.get(expected_next)
                if next_record is None or next_record.prev_id != note_id:
                    raise RuntimeError(
                        "Integrity failure: next record mismatch: "
                        f"next={expected_next} record.prev_id={None if next_record is None else next_record.prev_id} expected {note_id}"
                    )

    @staticmethod
    def _get_or_create_link(links: Dict[str, Dict[str, Optional[str]]], node_id: str) -> Dict[str, Optional[str]]:
        link = links[node_id]
        if link is None:
            link = {'prev': None, 'next': None}
            links[node_id] = link
        else:
            if 'prev' not in link:
                link['prev'] = None
            if 'next' not in link:
                link['next'] = None
        return link

    def _insert_link(
        self,
        parent_id: Optional[str],
        note_id: str,
        prev_id: Optional[str],
        next_id: Optional[str],
    ) -> None:
        links = self._ensure_parent_structures(parent_id)

        if prev_id not in links:
            prev_id = None
        if next_id not in links:
            next_id = None

        if prev_id is None and next_id is None:
            prev_id = self._tails.get(parent_id)
            next_id = None

        if prev_id is not None:
            prev_link = self._get_or_create_link(links, prev_id)
            if next_id is None:
                next_id = prev_link.get('next')
            else:
                next_id = next_id
        if next_id is not None:
            next_link = self._get_or_create_link(links, next_id)
            if prev_id is None:
                prev_id = next_link.get('prev')
            else:
                prev_id = prev_id

        links[note_id] = {'prev': prev_id, 'next': next_id}

        if prev_id is not None:
            links[prev_id]['next'] = note_id
        else:
            self._heads[parent_id] = note_id

        if next_id is not None:
            links[next_id]['prev'] = note_id
        else:
            self._tails[parent_id] = note_id

        self._update_record_links_locked(note_id, parent_id=parent_id, prev_id=prev_id, next_id=next_id)
        if prev_id is not None:
            prev_link = links[prev_id]
            if not prev_link or prev_link.get('next') != note_id:
                raise RuntimeError(f"Integrity failure: insert did not update prev link for {prev_id}")
            self._update_record_links_locked(prev_id, parent_id=parent_id, prev_id=prev_link.get('prev'), next_id=note_id)
        if next_id is not None:
            next_link = links[next_id]
            if not next_link or next_link.get('prev') != note_id:
                raise RuntimeError(f"Integrity failure: insert did not update next link for {next_id}")
            self._update_record_links_locked(next_id, parent_id=parent_id, prev_id=note_id, next_id=next_link.get('next'))

        self._assert_links_consistent_locked(parent_id, [note_id, prev_id, next_id])

    def _remove_link(self, parent_id: Optional[str], note_id: str) -> None:
        links = self._links.get(parent_id)
        if not links:
            return

        if note_id not in links:
            return
        link = links.pop(note_id)
        if not link:
            return

        prev_id = link['prev']
        next_id = link['next']

        if prev_id is not None and prev_id in links:
            links[prev_id]['next'] = next_id
        else:
            self._heads[parent_id] = next_id

        if next_id is not None and next_id in links:
            links[next_id]['prev'] = prev_id
        else:
            self._tails[parent_id] = prev_id

        if prev_id is not None:
            prev_link = links[prev_id]
            if prev_link is None:
                raise RuntimeError(f"Integrity failure: prev node {prev_id} missing during remove of {note_id}")
            self._update_record_links_locked(prev_id, parent_id=parent_id, prev_id=prev_link.get('prev'), next_id=next_id)
        if next_id is not None:
            next_link = links[next_id]
            if next_link is None:
                raise RuntimeError(f"Integrity failure: next node {next_id} missing during remove of {note_id}")
            self._update_record_links_locked(next_id, parent_id=parent_id, prev_id=prev_id, next_id=next_link.get('next'))

        self._assert_links_consistent_locked(parent_id, [prev_id, next_id, self._heads.get(parent_id), self._tails.get(parent_id)])

        if not links:
            self._links.pop(parent_id, None)
            self._heads.pop(parent_id, None)
            self._tails.pop(parent_id, None)

    def _order_ids(self, ids: List[str]) -> List[str]:
        if not ids:
            return []

        bucket = {note_id: self._note_map[note_id] for note_id in ids if note_id in self._note_map}
        if not bucket:
            return []

        head_candidates = [
            record for record in bucket.values()
            if not record.prev_id or record.prev_id not in bucket
        ]
        if not head_candidates:
            head_candidates = [min(bucket.values(), key=lambda rec: rec.id)]

        head = head_candidates[0]
        ordered: List[str] = []
        seen: set[str] = set()
        current = head

        while current and current.id not in seen:
            ordered.append(current.id)
            seen.add(current.id)
            next_id = current.next_id
            current = bucket.get(next_id)

        for note_id in ids:
            if note_id not in seen:
                ordered.append(note_id)

        return ordered

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

            parent_id = record.parent_id
            if parent_id is None:
                return frozenset()

            inherited = self._effective_non_meta_tag_terms.get(parent_id)
            if inherited is None:
                raise RuntimeError(
                    "Integrity failure: missing effective tag terms for parent "
                    f"{parent_id} (child {note_id})"
                )
            return inherited

    def get_inherited_proposed_non_meta_tag_terms(self, note_id: str) -> FrozenSet[str]:
        if not isinstance(note_id, str) or not note_id:
            raise TypeError("note_id must be a non-empty string")

        with self._lock:
            if not self._loaded:
                raise RuntimeError("NoteStore is not loaded")
            record = self._note_map.get(note_id)
            if record is None:
                raise KeyError(f"Note {note_id} not present in NoteStore")
            if record.parent_id is None:
                return frozenset()
            inherited = self._effective_proposed_non_meta_tag_terms.get(record.parent_id)
            if inherited is None:
                raise RuntimeError(
                    "Integrity failure: missing effective proposed tag terms for parent "
                    f"{record.parent_id} (child {note_id})"
                )
            return inherited

    def apply_bulk_tag_sources(self, changes: Mapping[str, tuple[str, str]]) -> None:
        """Publish sources together and rebuild inheritance once for the whole pass."""
        assert self._loaded
        with self._lock:
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
            head = self._heads.get(parent_id)
            if head is None:
                return []
            links = self._links.get(parent_id)
            if not links:
                return []
            ordered: List[str] = []
            current = head
            visited = set()
            while current and current not in visited:
                ordered.append(current)
                visited.add(current)
                link = links[current]
                if link is None:
                    raise RuntimeError(
                        "Integrity failure: child list contains node missing from links: "
                        f"parent_id={parent_id} note_id={current}"
                    )
                current = link['next']
            return ordered

    # Debug helpers -----------------------------------------------------------

    def debug_validate_links(self, *note_ids: Optional[str]) -> None:
        if not note_ids:
            return

        with self._lock:
            for note_id in note_ids:
                if not note_id:
                    continue
                record = self._note_map.get(note_id)
                if not record:
                    continue

                if record.prev_id:
                    prev = self._note_map.get(record.prev_id)
                    if not prev:
                        raise RuntimeError(
                            f"Integrity failure: note {note_id} prev_id {record.prev_id} missing"
                        )
                    elif prev.next_id != record.id:
                        raise RuntimeError(
                            "Integrity failure: prev/next mismatch: "
                            f"prev {record.prev_id} next={prev.next_id} expected {record.id}"
                        )

                if record.next_id:
                    nxt = self._note_map.get(record.next_id)
                    if not nxt:
                        raise RuntimeError(
                            f"Integrity failure: note {note_id} next_id {record.next_id} missing"
                        )
                    elif nxt.prev_id != record.id:
                        raise RuntimeError(
                            "Integrity failure: next/prev mismatch: "
                            f"next {record.next_id} prev={nxt.prev_id} expected {record.id}"
                        )

                if record.parent_id is not None:
                    children = self.get_children(record.parent_id)
                    if record.id not in children:
                        raise RuntimeError(
                            "Integrity failure: parent/child mismatch: "
                            f"note {note_id} parent {record.parent_id} missing from children list"
                        )

store = NoteStore()


__all__ = ["NoteStore", "NoteRecord", "store"]
