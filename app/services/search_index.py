from __future__ import annotations

from dataclasses import dataclass
from threading import RLock
import time
from typing import Callable, Dict, FrozenSet, Iterable, List, Optional, Set, Tuple

from loguru import logger

from app.services.content_formatting import _tokenize_tag_bar, _unwrap_tag_token, list_known_meta_tag_terms
from app.services.search_query import SearchClause, parse_search_query
from app.services.tag_term_matching import tag_term_matches_prefix
from app.services.link_titles import link_title_store
from app.services.search_text import (
    append_link_titles_casefold,
    build_searchable_base_text_casefold,
    list_link_title_urls,
    text_term_matches,
)


_QUOTE_CHARS = {"'", '"'}
# Walking one anchor-note term in Python costs roughly this many times less
# than one C set intersection per suggestion candidate (measured on 107k notes).
SUGGESTION_INTERSECT_COST_RATIO = 8


@dataclass(frozen=True, slots=True)
class _SearchSuggestionContext:
    anchors: Tuple[str, ...]
    partial_prefix: str | None
    completed_clause: str
    is_exclusion: bool


def _add_posting(postings: Dict[str, Set[int]], key: str, note_int_id: int) -> None:
    if key not in postings:
        postings[key] = set()
    postings[key].add(note_int_id)


def _parse_search_suggestion_context(raw_input: str) -> _SearchSuggestionContext:
    if not isinstance(raw_input, str):
        raise TypeError(f"raw_input must be a string, got {type(raw_input)}")

    anchors: List[str] = []
    partial_prefix: Optional[str] = None
    clause_term_count = 0
    clause_start = 0
    has_trailing_whitespace = len(raw_input) > 0 and raw_input[-1].isspace()

    index = 0
    length = len(raw_input)
    while index < length:
        while index < length and raw_input[index].isspace():
            index += 1
        if index >= length:
            break

        term_start = index
        prefix: Optional[str] = None
        if raw_input[index] in ("+", "-"):
            prefix = raw_input[index]
            index += 1
            if index >= length or raw_input[index].isspace():
                return _SearchSuggestionContext(tuple(anchors), None, '', False)

        if raw_input[index] in _QUOTE_CHARS:
            quote_char = raw_input[index]
            index += 1
            closed = False
            while index < length:
                char = raw_input[index]
                if char == quote_char:
                    closed = True
                    index += 1
                    break
                if char == "\\" and index + 1 < length:
                    next_char = raw_input[index + 1]
                    if next_char in (quote_char, "\\"):
                        index += 2
                        continue
                index += 1
            if not closed:
                return _SearchSuggestionContext(tuple(anchors), None, '', False)
            clause_term_count += 1
            continue

        start = index
        while index < length and not raw_input[index].isspace():
            index += 1

        token = raw_input[start:index]
        if token == "":
            continue

        if token == "OR":
            if prefix is not None:
                return _SearchSuggestionContext(tuple(anchors), None, '', False)
            if clause_term_count == 0:
                return _SearchSuggestionContext(tuple(anchors), None, '', False)
            if index >= length and not raw_input[-1].isspace():
                return _SearchSuggestionContext(tuple(anchors), None, '', False)
            anchors = []
            clause_term_count = 0
            clause_start = index
            continue

        is_partial = index >= length and not raw_input[-1].isspace()
        if is_partial:
            return _SearchSuggestionContext(
                tuple(anchors), token, raw_input[clause_start:term_start], prefix == '-',
            )

        if prefix == "-":
            clause_term_count += 1
            continue
        anchors.append(token)
        clause_term_count += 1

    if partial_prefix is None and has_trailing_whitespace:
        partial_prefix = ""
    return _SearchSuggestionContext(tuple(anchors), partial_prefix, raw_input[clause_start:], False)


def _parse_search_query_for_suggestions(raw_input: str) -> tuple[Tuple[str, ...], Optional[str]]:
    context = _parse_search_suggestion_context(raw_input)
    return context.anchors, context.partial_prefix


@dataclass(frozen=True, slots=True)
class TagCooccurrence:
    """A tag's notes that carry the most of some anchor tags, as tag suggestions rank them."""

    anchor_count: int
    note_count: int
    # The anchors (casefolded) those notes carry; one set when they all carry the same ones.
    anchor_sets: FrozenSet[FrozenSet[str]]

    def __post_init__(self) -> None:
        if self.anchor_count <= 0 or self.note_count <= 0:
            raise ValueError("A tag co-occurrence needs at least one anchor and one note")
        if not self.anchor_sets or any(len(anchors) != self.anchor_count for anchors in self.anchor_sets):
            raise ValueError("Every anchor set holds anchor_count anchors")


@dataclass(frozen=True, slots=True)
class SearchSuggestionFacts:
    """What the search-bar ranking used for some shown suggestions, to say why each is there."""

    partial_prefix: str
    # Tags (and words) already typed in the clause; with them the ranking is by co-occurrence.
    anchors: Tuple[str, ...]
    has_completed_clause: bool
    is_exclusion: bool
    # Notes the search so far finds (every note when nothing precedes the typed tag).
    matching_note_count: int
    note_counts: Dict[str, int]
    matching_counts: Dict[str, int]
    cooccurrences: Dict[str, TagCooccurrence]

    @property
    def is_ranked_by_cooccurrence(self) -> bool:
        return any(anchor and not anchor.startswith("@") for anchor in self.anchors)


@dataclass(frozen=True, slots=True)
class SearchRecord:
    note_id: str
    content_text: str
    tags: str
    tag_terms: FrozenSet[str]


def extract_ordered_tags_for_search(tags: str) -> tuple[str, ...]:
    if not isinstance(tags, str):
        raise TypeError(f"tags must be a string, got {type(tags)}")
    if tags == "":
        return ()

    ordered_terms: list[str] = []
    seen_terms: set[str] = set()
    for token in _tokenize_tag_bar(tags):
        base, wrapper = _unwrap_tag_token(token)
        if wrapper is None:
            if base != "OR" and base not in seen_terms:
                seen_terms.add(base)
                ordered_terms.append(base)
            continue
        for inner in base.split():
            if inner and inner != "OR" and inner not in seen_terms:
                seen_terms.add(inner)
                ordered_terms.append(inner)
    return tuple(ordered_terms)


def extract_tags_for_search(tags: str) -> FrozenSet[str]:
    return frozenset(extract_ordered_tags_for_search(tags))


class SearchIndex:
    """In-memory search index (tags + trigrams) built from current note content."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._revision = 0

        self._uuid_to_id: Dict[str, int] = {}
        self._id_to_uuid: List[str] = []
        self._alive: Set[int] = set()

        self._note_text_casefold: List[str] = []
        # Notes are also searchable by the cached titles of URLs written in them.
        # A title can arrive or disappear later, so keep each note's URLs (and,
        # for notes with URLs, its text without titles) to recompose its text.
        self._note_link_title_urls: List[FrozenSet[str]] = []
        self._link_title_url_notes: Dict[str, Set[int]] = {}
        self._note_base_text_casefold: Dict[int, str] = {}
        self._note_explicit_tag_terms: List[FrozenSet[str]] = []
        self._note_raw_tag_terms: List[FrozenSet[str]] = []
        self._note_tag_terms: List[FrozenSet[str]] = []
        self._note_tag_terms_casefold: List[FrozenSet[str]] = []
        self._explicit_tag_notes: Dict[str, Set[int]] = {}
        self._raw_tag_notes_casefold: Dict[str, Set[int]] = {}
        self._tag_notes: Dict[str, Set[int]] = {}
        self._tag_notes_casefold: Dict[str, Set[int]] = {}

        self._result_cache: Dict[str, tuple[int, FrozenSet[str]]] = {}
        self._untagged_result_cache: tuple[int, FrozenSet[str]] | None = None

    def rebuild(
        self,
        records: Iterable[SearchRecord],
        *,
        raw_tag_terms_by_id: Dict[str, FrozenSet[str]],
        progress_update: Callable[[int], None],
        progress_interval: int,
    ) -> None:
        if progress_interval <= 0:
            raise ValueError("progress_interval must be > 0")
        t0 = time.perf_counter()
        materialized = list(records)
        record_ids = {record.note_id for record in materialized}
        if record_ids != set(raw_tag_terms_by_id):
            raise ValueError("raw_tag_terms_by_id must contain exactly one entry per search record")
        with self._lock:
            self._uuid_to_id.clear()
            self._id_to_uuid.clear()
            self._alive.clear()
            self._note_text_casefold.clear()
            self._note_link_title_urls.clear()
            self._link_title_url_notes.clear()
            self._note_base_text_casefold.clear()
            self._note_explicit_tag_terms.clear()
            self._note_raw_tag_terms.clear()
            self._note_tag_terms.clear()
            self._note_tag_terms_casefold.clear()
            self._explicit_tag_notes.clear()
            self._raw_tag_notes_casefold.clear()
            self._tag_notes.clear()
            self._tag_notes_casefold.clear()
            self._result_cache.clear()

            self._revision += 1

            processed = 0
            last_reported = 0
            # Rebuild-local memos: notes repeat tag strings, and inherited tag
            # sets repeat the same terms, so parse and casefold each only once.
            explicit_terms_by_tags: Dict[str, FrozenSet[str]] = {}
            casefold_by_term: Dict[str, str] = {}
            for record in materialized:
                if record.tags not in explicit_terms_by_tags:
                    explicit_terms_by_tags[record.tags] = extract_tags_for_search(record.tags)
                explicit_tag_terms = explicit_terms_by_tags[record.tags]
                self._insert_new_locked(
                    record.note_id,
                    record.content_text,
                    record.tags,
                    explicit_tag_terms,
                    raw_tag_terms_by_id[record.note_id],
                    record.tag_terms,
                    casefold_by_term,
                )
                processed += 1
                if processed - last_reported >= progress_interval:
                    last_reported = processed
                    progress_update(processed)

            if processed != last_reported:
                progress_update(processed)

        elapsed_ms = (time.perf_counter() - t0) * 1000
        logger.bind(
            metrics={
                "elapsed_ms": elapsed_ms,
                "note_count": len(materialized),
                "unique_tag_terms": len(self._tag_notes),
                "revision": self._revision,
            }
        ).info("search.index.rebuild.finish")

    def upsert(
        self,
        *,
        note_id: str,
        content_text: str,
        tags: str,
        raw_tag_terms: FrozenSet[str],
        tag_terms: FrozenSet[str],
    ) -> None:
        t0 = time.perf_counter()
        with self._lock:
            if note_id in self._uuid_to_id:
                note_int_id = self._uuid_to_id[note_id]
                if note_int_id not in self._alive:
                    # Notes can be deleted and later restored (undo/redo) with the same UUID.
                    # Treat this as a revive instead of an error.
                    self._alive.add(note_int_id)
                self._update_existing_locked(
                    note_int_id,
                    content_text,
                    tags,
                    raw_tag_terms,
                    tag_terms,
                )
            else:
                self._insert_new_locked(
                    note_id,
                    content_text,
                    tags,
                    extract_tags_for_search(tags),
                    raw_tag_terms,
                    tag_terms,
                    {},
                )

            self._revision += 1
            self._result_cache.clear()

        elapsed_ms = (time.perf_counter() - t0) * 1000
        logger.bind(
            metrics={"elapsed_ms": elapsed_ms, "note_id": note_id, "revision": self._revision}
        ).info("search.index.upsert.finish")

    def refresh_link_titles(self, urls: FrozenSet[str]) -> None:
        """Recompose the text of notes containing these URLs after their cached titles changed."""
        if not isinstance(urls, frozenset):
            raise TypeError("refresh_link_titles requires a frozenset of normalized URLs")
        with self._lock:
            note_int_ids: Set[int] = set()
            for url in urls:
                if url in self._link_title_url_notes:
                    note_int_ids |= self._link_title_url_notes[url]
            if not note_int_ids:
                return
            for note_int_id in note_int_ids:
                assert note_int_id in self._alive, "deleted notes have no link-title URLs"
                self._note_text_casefold[note_int_id] = append_link_titles_casefold(
                    self._note_base_text_casefold[note_int_id],
                    self._note_link_title_urls[note_int_id],
                )
            self._revision += 1
            self._result_cache.clear()

    def update_tag_terms(self, *, note_id: str, tag_terms: FrozenSet[str]) -> None:
        self.bulk_update_tag_terms({note_id: tag_terms})

    def bulk_update_tag_terms(self, updates: Dict[str, FrozenSet[str]]) -> None:
        if not updates:
            return

        t0 = time.perf_counter()
        touched = 0
        with self._lock:
            for note_id, new_tag_terms in updates.items():
                note_int_id = self._uuid_to_id.get(note_id)
                if note_int_id is None:
                    continue
                if note_int_id not in self._alive:
                    continue

                old_tag_terms = self._note_tag_terms[note_int_id]
                if old_tag_terms == new_tag_terms:
                    continue

                # Touch only the terms that changed: inherited term sets are
                # large and mostly stable, so remove-all/add-all dominated.
                for term in old_tag_terms - new_tag_terms:
                    bucket = self._tag_notes.get(term)
                    if bucket is None:
                        continue
                    bucket.discard(note_int_id)
                new_casefold = frozenset(term.casefold() for term in new_tag_terms)
                old_casefold = self._note_tag_terms_casefold[note_int_id]
                for term_casefold in old_casefold - new_casefold:
                    folded_bucket = self._tag_notes_casefold.get(term_casefold)
                    if folded_bucket is not None:
                        folded_bucket.discard(note_int_id)
                for term in new_tag_terms - old_tag_terms:
                    _add_posting(self._tag_notes, term, note_int_id)
                for term_casefold in new_casefold - old_casefold:
                    _add_posting(self._tag_notes_casefold, term_casefold, note_int_id)

                self._note_tag_terms[note_int_id] = new_tag_terms
                self._note_tag_terms_casefold[note_int_id] = new_casefold
                touched += 1

            if touched:
                self._revision += 1
                self._result_cache.clear()

        elapsed_ms = (time.perf_counter() - t0) * 1000
        logger.bind(
            metrics={
                "elapsed_ms": elapsed_ms,
                "revision": self._revision,
                "touched": touched,
                "update_count": len(updates),
            }
        ).info("search.index.bulk_update_tag_terms.finish")

    def bulk_update_raw_tag_terms(self, updates: Dict[str, FrozenSet[str]]) -> None:
        if not updates:
            return

        touched = 0
        with self._lock:
            for note_id, new_raw_tag_terms in updates.items():
                note_int_id = self._uuid_to_id.get(note_id)
                if note_int_id is None or note_int_id not in self._alive:
                    continue

                old_raw_tag_terms = self._note_raw_tag_terms[note_int_id]
                if old_raw_tag_terms == new_raw_tag_terms:
                    continue

                old_raw_casefold = {term.casefold() for term in old_raw_tag_terms}
                new_raw_casefold = {term.casefold() for term in new_raw_tag_terms}
                for term_casefold in old_raw_casefold - new_raw_casefold:
                    bucket = self._raw_tag_notes_casefold.get(term_casefold)
                    if bucket is not None:
                        bucket.discard(note_int_id)
                for term_casefold in new_raw_casefold - old_raw_casefold:
                    _add_posting(self._raw_tag_notes_casefold, term_casefold, note_int_id)

                self._note_raw_tag_terms[note_int_id] = new_raw_tag_terms
                touched += 1

            if touched:
                self._revision += 1
                self._result_cache.clear()

    def remove_many(self, note_ids: Set[str]) -> None:
        if not note_ids:
            return
        t0 = time.perf_counter()
        with self._lock:
            for note_id in note_ids:
                if note_id not in self._uuid_to_id:
                    continue
                note_int_id = self._uuid_to_id[note_id]
                self._remove_existing_locked(note_int_id)

            self._revision += 1
            self._result_cache.clear()

        elapsed_ms = (time.perf_counter() - t0) * 1000
        logger.bind(
            metrics={"elapsed_ms": elapsed_ms, "count": len(note_ids), "revision": self._revision}
        ).info("search.index.remove_many.finish")

    def list_non_meta_tag_terms(self) -> FrozenSet[str]:
        """Return all tag terms currently indexed (excluding @meta tags)."""
        with self._lock:
            return frozenset(
                term
                for term in self._tag_notes.keys()
                if term and not term.startswith("@")
            )

    def list_non_meta_tag_suggestion_terms(self) -> FrozenSet[str]:
        with self._lock:
            representatives = self._build_suggestion_representatives_locked(
                anchor_casefold_set=frozenset(),
                partial_prefix="",
            )
            return frozenset(representatives.values())

    def list_tag_suggestion_terms(self) -> FrozenSet[str]:
        """Return canonical autocomplete vocabulary, including known meta tags."""
        with self._lock:
            representatives = self._build_suggestion_representatives_locked(
                anchor_casefold_set=frozenset(),
                partial_prefix="",
            )
            return frozenset(
                tuple(representatives.values()) + tuple(list_known_meta_tag_terms())
            )

    def list_tag_frequencies(self) -> Dict[str, int]:
        """Return tag term -> note count (excluding @meta tags)."""
        with self._lock:
            return {
                term: len(note_ids)
                for term, note_ids in self._tag_notes.items()
                if term and not term.startswith("@")
            }

    def list_raw_tag_frequencies_by_casefold(self) -> Dict[str, int]:
        """Return raw tag -> distinct note count after inheritance, before ontology."""
        with self._lock:
            return {
                term_casefold: len(note_ids)
                for term_casefold, note_ids in self._raw_tag_notes_casefold.items()
                if note_ids and term_casefold and not term_casefold.startswith("@")
            }

    def list_raw_tag_terms_for_note(self, note_id: str) -> FrozenSet[str]:
        """Return explicit and inherited tags before ontology inference."""
        if not isinstance(note_id, str) or note_id == "":
            raise TypeError("note_id must be a non-empty string")
        with self._lock:
            if note_id not in self._uuid_to_id:
                raise KeyError(f"Note {note_id} not present in SearchIndex")
            note_int_id = self._uuid_to_id[note_id]
            if note_int_id not in self._alive:
                raise KeyError(f"Note {note_id} is not active in SearchIndex")
            return self._note_raw_tag_terms[note_int_id]

    def list_effective_tag_terms_for_note(self, note_id: str) -> FrozenSet[str]:
        """Return the exact effective tags used by canonical search matching."""
        if not isinstance(note_id, str) or note_id == "":
            raise TypeError("note_id must be a non-empty string")
        with self._lock:
            if note_id not in self._uuid_to_id:
                raise KeyError(f"Note {note_id} not present in SearchIndex")
            note_int_id = self._uuid_to_id[note_id]
            if note_int_id not in self._alive:
                raise KeyError(f"Note {note_id} is not active in SearchIndex")
            return self._note_tag_terms[note_int_id]

    def list_explicit_tag_frequencies(self) -> Dict[str, int]:
        """Return explicitly written tag term -> note count (excluding @meta tags)."""
        with self._lock:
            return {
                term: len(note_ids)
                for term, note_ids in self._explicit_tag_notes.items()
                if term and not term.startswith("@")
            }

    def describe_tag_cooccurrence(self, *, anchors: Iterable[str], terms: Iterable[str]) -> Dict[str, TagCooccurrence]:
        """For each term, the notes carrying it together with the most of the anchors.

        The same measure `suggest_tag_completions` ranks by (the most anchors one
        of the term's notes carries, and how many notes carry that many), with
        the anchors named. Terms on no note with an anchor are left out.
        """
        anchor_casefold_set = frozenset(
            anchor.casefold() for anchor in anchors if anchor and not anchor.startswith("@")
        )
        described: Dict[str, TagCooccurrence] = {}
        with self._lock:
            for term in terms:
                term_casefold = term.casefold()
                if term_casefold not in self._tag_notes_casefold:
                    continue
                term_notes = self._tag_notes_casefold[term_casefold]
                anchors_by_note: Dict[int, Set[str]] = {}
                for anchor_casefold in anchor_casefold_set:
                    if anchor_casefold == term_casefold or anchor_casefold not in self._tag_notes_casefold:
                        continue
                    for note_id in term_notes & self._tag_notes_casefold[anchor_casefold]:
                        anchors_by_note.setdefault(note_id, set()).add(anchor_casefold)
                if not anchors_by_note:
                    continue
                most_anchors = max(len(note_anchors) for note_anchors in anchors_by_note.values())
                at_most = [frozenset(note_anchors) for note_anchors in anchors_by_note.values()
                           if len(note_anchors) == most_anchors]
                described[term] = TagCooccurrence(
                    anchor_count=most_anchors, note_count=len(at_most), anchor_sets=frozenset(at_most),
                )
        return described

    def describe_search_suggestions(self, *, query: str, terms: Iterable[str]) -> SearchSuggestionFacts:
        """The facts `suggest_all_tag_completions` ranked and filtered these terms by."""
        context = _parse_search_suggestion_context(query)
        partial_prefix = ""
        if context.partial_prefix is not None:
            partial_prefix = context.partial_prefix
        shown = list(terms)
        with self._lock:
            has_completed_clause = context.completed_clause.strip() != ""
            if has_completed_clause:
                clause = parse_search_query(context.completed_clause).first_clause
                matching_ids = self._matching_note_int_ids_for_clause_locked(clause)
            else:
                matching_ids = self._alive
            note_counts: Dict[str, int] = {}
            matching_counts: Dict[str, int] = {}
            for term in shown:
                posting: FrozenSet[int] = frozenset()
                if term.casefold() in self._tag_notes_casefold:
                    posting = frozenset(self._tag_notes_casefold[term.casefold()])
                note_counts[term] = len(posting)
                matching_counts[term] = len(posting & matching_ids)
            cooccurrences = self.describe_tag_cooccurrence(anchors=context.anchors, terms=shown)
            return SearchSuggestionFacts(
                partial_prefix=partial_prefix, anchors=tuple(context.anchors),
                has_completed_clause=has_completed_clause, is_exclusion=context.is_exclusion,
                matching_note_count=len(matching_ids), note_counts=note_counts,
                matching_counts=matching_counts, cooccurrences=cooccurrences,
            )

    def count_notes_with_tag(self, term: str) -> int:
        """Notes carrying the tag, as suggestions count usage (case-insensitive)."""
        if not isinstance(term, str) or term == "":
            raise TypeError("term must be a non-empty string")
        with self._lock:
            term_casefold = term.casefold()
            if term_casefold not in self._tag_notes_casefold:
                return 0
            return len(self._tag_notes_casefold[term_casefold])

    def suggest_tag_completions(self, *, query: str, limit: int) -> List[str]:
        if not isinstance(query, str):
            raise TypeError(f"query must be a string, got {type(query)}")
        if not isinstance(limit, int) or limit <= 0:
            raise TypeError("limit must be a positive integer")

        anchors, partial_prefix = _parse_search_query_for_suggestions(query)
        if partial_prefix is None:
            if query.strip() != "":
                return []
            partial_prefix = ""

        if partial_prefix.startswith("@"):
            with self._lock:
                return self._suggest_meta_tag_completions_locked(
                    partial_prefix=partial_prefix,
                    limit=limit,
                )

        anchor_casefold_set = frozenset(
            anchor.casefold()
            for anchor in anchors
            if anchor and not anchor.startswith("@")
        )

        with self._lock:
            representative_by_casefold = self._build_suggestion_representatives_locked(
                anchor_casefold_set=anchor_casefold_set,
                partial_prefix=partial_prefix,
            )
            candidate_casefolds = list(representative_by_casefold.keys())

            if not candidate_casefolds and partial_prefix != "":
                return []

            if not anchor_casefold_set:
                candidate_casefolds.sort(
                    key=lambda term_casefold: (
                        -len(self._tag_notes_casefold[term_casefold]),
                        *self._suggestion_term_tiebreak_locked(representative_by_casefold[term_casefold]),
                    )
                )
                return [
                    representative_by_casefold[term_casefold]
                    for term_casefold in candidate_casefolds[:limit]
                ]

            # Postings hold only live notes (removal discards them). Group the
            # notes carrying anchors by how many they carry; each candidate's
            # co-occurrence is then a set intersection per group.
            anchor_counts: Dict[int, int] = {}
            for anchor_casefold in anchor_casefold_set:
                if anchor_casefold not in self._tag_notes_casefold:
                    continue
                for note_id in self._tag_notes_casefold[anchor_casefold]:
                    if note_id not in anchor_counts:
                        anchor_counts[note_id] = 0
                    anchor_counts[note_id] += 1

            max_anchor_count = len(anchor_casefold_set)
            notes_by_anchor_count: List[Set[int]] = [set() for _ in range(max_anchor_count + 1)]
            for note_id, count in anchor_counts.items():
                assert 0 < count <= max_anchor_count
                notes_by_anchor_count[count].add(note_id)

            support_counts = [0] * (max_anchor_count + 1)
            running = 0
            for k in range(max_anchor_count, 0, -1):
                running += len(notes_by_anchor_count[k])
                support_counts[k] = running

            # term -> (most anchors one of its notes carries, notes carrying that many)
            co_occurrence = self._suggestion_co_occurrence_locked(
                candidate_casefolds=candidate_casefolds,
                anchor_counts=anchor_counts,
                notes_by_anchor_count=notes_by_anchor_count,
            )

            scored: List[Tuple[int, float, int, str]] = []
            for term_casefold in candidate_casefolds:
                if term_casefold not in self._tag_notes_casefold:
                    continue
                candidate_count = len(self._tag_notes_casefold[term_casefold])
                if candidate_count == 0:
                    continue

                max_k, intersection_count = 0, 0
                if term_casefold in co_occurrence:
                    max_k, intersection_count = co_occurrence[term_casefold]
                if max_k == 0 and partial_prefix == "":
                    continue

                jaccard = 0.0
                if max_k > 0:
                    union_count = candidate_count + support_counts[max_k] - intersection_count
                    if union_count > 0:
                        jaccard = intersection_count / union_count

                representative = representative_by_casefold[term_casefold]
                lower_case_penalty, term_tiebreak = self._suggestion_term_tiebreak_locked(representative)
                scored.append((-max_k, -jaccard, lower_case_penalty, term_tiebreak))

            scored.sort()
            return [representative_by_casefold[term.casefold()] for _, __, ___, term in scored[:limit]]

    def _suggestion_co_occurrence_locked(
        self,
        *,
        candidate_casefolds: List[str],
        anchor_counts: Dict[int, int],
        notes_by_anchor_count: List[Set[int]],
    ) -> Dict[str, Tuple[int, int]]:
        """Map each co-occurring candidate to (max anchors on one note, notes with that many).

        Few anchor notes: walk their own terms. Many: intersect each candidate's
        postings with the anchor-count groups, which runs in C.
        """
        co_occurrence: Dict[str, Tuple[int, int]] = {}
        anchor_terms_size = sum(len(self._note_tag_terms_casefold[note_id]) for note_id in anchor_counts)
        if anchor_terms_size <= SUGGESTION_INTERSECT_COST_RATIO * len(candidate_casefolds):
            candidate_set = set(candidate_casefolds)
            for note_id, count in anchor_counts.items():
                for term_casefold in self._note_tag_terms_casefold[note_id] & candidate_set:
                    if term_casefold not in co_occurrence or count > co_occurrence[term_casefold][0]:
                        co_occurrence[term_casefold] = (count, 1)
                    elif count == co_occurrence[term_casefold][0]:
                        co_occurrence[term_casefold] = (count, co_occurrence[term_casefold][1] + 1)
            return co_occurrence
        for term_casefold in candidate_casefolds:
            if term_casefold not in self._tag_notes_casefold:
                continue
            note_ids = self._tag_notes_casefold[term_casefold]
            for k in range(len(notes_by_anchor_count) - 1, 0, -1):
                if notes_by_anchor_count[k]:
                    shared = len(note_ids & notes_by_anchor_count[k])
                    if shared:
                        co_occurrence[term_casefold] = (k, shared)
                        break
        return co_occurrence

    def suggest_all_tag_completions(self, *, query: str) -> List[str]:
        """Return ranked search completions with real matches, before UI truncation.

        Note-tag recommendations retain partial co-occurrence ranking through
        suggest_tag_completions; search completions must satisfy the whole clause.
        """
        with self._lock:
            candidate_capacity = len(self._tag_notes) + len(list_known_meta_tag_terms()) + 1
            suggestions = self.suggest_tag_completions(query=query, limit=candidate_capacity)
            if not suggestions:
                return []
            context = _parse_search_suggestion_context(query)
            if context.completed_clause.strip() == '':
                matching_ids = self._alive
            else:
                clause = parse_search_query(context.completed_clause).first_clause
                matching_ids = self._matching_note_int_ids_for_clause_locked(clause)
            if not matching_ids:
                return []
            completions: List[str] = []
            for term in suggestions:
                posting = self._tag_notes_casefold.get(term.casefold(), frozenset())
                if context.is_exclusion:
                    has_matches = not matching_ids.issubset(posting)
                else:
                    has_matches = not matching_ids.isdisjoint(posting)
                if has_matches:
                    completions.append(term)
            return completions
    def query_note_ids(self, search: str) -> Set[str]:
        t0 = time.perf_counter()
        if not isinstance(search, str):
            raise TypeError(f"search must be a string, got {type(search)}")

        with self._lock:
            cached = self._result_cache.get(search)
            if cached is not None:
                cached_revision, cached_results = cached
                if cached_revision == self._revision:
                    total_ms = (time.perf_counter() - t0) * 1000
                    logger.bind(
                        metrics={
                            "cache_hit": True,
                            "total_ms": total_ms,
                            "revision": self._revision,
                            "matched_count": len(cached_results),
                        },
                    ).info("search.query.finish")
                    return set(cached_results)

        parsed = parse_search_query(search)

        parse_ms = (time.perf_counter() - t0) * 1000

        has_terms = any(
            clause.required_tags
            or clause.forbidden_tags
            or clause.required_text
            or clause.forbidden_text
            for clause in parsed.clauses
        )
        if not has_terms:
            return set()

        required_tag_count = sum(len(clause.required_tags) for clause in parsed.clauses)
        forbidden_tag_count = sum(len(clause.forbidden_tags) for clause in parsed.clauses)
        required_text_count = sum(len(clause.required_text) for clause in parsed.clauses)
        forbidden_text_count = sum(len(clause.forbidden_text) for clause in parsed.clauses)

        t1 = time.perf_counter()
        with self._lock:
            candidate_ids: Set[int] = set()
            for clause in parsed.clauses:
                candidate_ids.update(self._candidate_note_ids_locked(clause))
            candidate_count = len(candidate_ids)
            if not candidate_ids:
                candidate_ms = (time.perf_counter() - t1) * 1000
                total_ms = (time.perf_counter() - t0) * 1000
                logger.bind(
                    metrics={
                        "cache_hit": False,
                        "parse_ms": parse_ms,
                        "candidate_ms": candidate_ms,
                        "verify_ms": 0.0,
                        "total_ms": total_ms,
                        "candidate_count": 0,
                        "verified_count": 0,
                        "matched_count": 0,
                        "required_tag_count": required_tag_count,
                        "forbidden_tag_count": forbidden_tag_count,
                        "required_text_count": required_text_count,
                        "forbidden_text_count": forbidden_text_count,
                        "or_clause_count": len(parsed.clauses),
                        "revision": self._revision,
                    },
                ).info("search.query.finish")
                return set()

            t2 = time.perf_counter()
            matched_note_ids: Set[str] = set()
            verified = 0
            for note_int_id in candidate_ids:
                verified += 1
                if note_int_id not in self._alive:
                    continue
                if not any(
                    self._verify_note_matches_locked(note_int_id, clause)
                    for clause in parsed.clauses
                ):
                    continue
                matched_note_ids.add(self._id_to_uuid[note_int_id])

            candidate_ms = (t2 - t1) * 1000
            verify_ms = (time.perf_counter() - t2) * 1000
            total_ms = (time.perf_counter() - t0) * 1000

            frozen = frozenset(matched_note_ids)
            self._result_cache[search] = (self._revision, frozen)

        logger.bind(
            metrics={
                "cache_hit": False,
                "parse_ms": parse_ms,
                "candidate_ms": candidate_ms,
                "verify_ms": verify_ms,
                "total_ms": total_ms,
                "candidate_count": candidate_count,
                "verified_count": verified,
                "matched_count": len(matched_note_ids),
                "required_tag_count": required_tag_count,
                "forbidden_tag_count": forbidden_tag_count,
                "required_text_count": required_text_count,
                "forbidden_text_count": forbidden_text_count,
                "or_clause_count": len(parsed.clauses),
                "revision": self._revision,
            },
        ).info("search.query.finish")
        return matched_note_ids

    def query_clause_note_ids(self, clause: SearchClause) -> Set[str]:
        if not isinstance(clause, SearchClause):
            raise TypeError(f"clause must be SearchClause, got {type(clause)}")
        with self._lock:
            return {
                self._id_to_uuid[note_int_id]
                for note_int_id in self._matching_note_int_ids_for_clause_locked(clause)
            }

    def query_untagged_note_ids(self) -> Set[str]:
        with self._lock:
            cached = self._untagged_result_cache
            if cached is not None:
                cached_revision, cached_results = cached
                if cached_revision == self._revision:
                    return set(cached_results)

            matched_note_ids = frozenset(
                self._id_to_uuid[note_int_id]
                for note_int_id in self._alive
                if all(
                    term_casefold.startswith("@")
                    for term_casefold in self._note_tag_terms_casefold[note_int_id]
                )
            )
            self._untagged_result_cache = (self._revision, matched_note_ids)
            return set(matched_note_ids)

    # Internal ----------------------------------------------------------------

    def _insert_new_locked(
        self,
        note_id: str,
        content_text: str,
        tags: str,
        explicit_tag_terms: FrozenSet[str],
        raw_tag_terms: FrozenSet[str],
        tag_terms: FrozenSet[str],
        casefold_by_term: Dict[str, str],
    ) -> None:
        assert isinstance(explicit_tag_terms, frozenset)
        note_int_id = len(self._id_to_uuid)
        self._uuid_to_id[note_id] = note_int_id
        self._id_to_uuid.append(note_id)
        self._alive.add(note_int_id)

        self._note_text_casefold.append("")
        self._note_link_title_urls.append(frozenset())
        self._set_note_text_locked(note_int_id, content_text, tags)
        self._note_explicit_tag_terms.append(explicit_tag_terms)
        self._note_raw_tag_terms.append(raw_tag_terms)
        self._note_tag_terms.append(tag_terms)

        for term in explicit_tag_terms:
            _add_posting(self._explicit_tag_notes, term, note_int_id)
        for term in raw_tag_terms:
            if term not in casefold_by_term:
                casefold_by_term[term] = term.casefold()
            _add_posting(self._raw_tag_notes_casefold, casefold_by_term[term], note_int_id)
        tag_terms_casefold = []
        for term in tag_terms:
            if term not in casefold_by_term:
                casefold_by_term[term] = term.casefold()
            term_casefold = casefold_by_term[term]
            tag_terms_casefold.append(term_casefold)
            _add_posting(self._tag_notes, term, note_int_id)
            _add_posting(self._tag_notes_casefold, term_casefold, note_int_id)
        self._note_tag_terms_casefold.append(frozenset(tag_terms_casefold))

    def _update_existing_locked(
        self,
        note_int_id: int,
        content_text: str,
        tags: str,
        new_raw_tag_terms: FrozenSet[str],
        new_tag_terms: FrozenSet[str],
    ) -> None:
        if note_int_id not in self._alive:
            raise RuntimeError("Cannot update deleted note")

        new_explicit_tag_terms = extract_tags_for_search(tags)
        old_explicit_tag_terms = self._note_explicit_tag_terms[note_int_id]
        old_raw_tag_terms = self._note_raw_tag_terms[note_int_id]
        old_tag_terms = self._note_tag_terms[note_int_id]

        if old_explicit_tag_terms != new_explicit_tag_terms:
            for term in old_explicit_tag_terms:
                bucket = self._explicit_tag_notes.get(term)
                if bucket is None:
                    continue
                bucket.discard(note_int_id)
            for term in new_explicit_tag_terms:
                _add_posting(self._explicit_tag_notes, term, note_int_id)
            self._note_explicit_tag_terms[note_int_id] = new_explicit_tag_terms

        if old_raw_tag_terms != new_raw_tag_terms:
            for term in old_raw_tag_terms:
                bucket = self._raw_tag_notes_casefold.get(term.casefold())
                if bucket is not None:
                    bucket.discard(note_int_id)
            for term in new_raw_tag_terms:
                _add_posting(self._raw_tag_notes_casefold, term.casefold(), note_int_id)
            self._note_raw_tag_terms[note_int_id] = new_raw_tag_terms

        if old_tag_terms != new_tag_terms:
            for term in old_tag_terms:
                bucket = self._tag_notes.get(term)
                if bucket is None:
                    continue
                bucket.discard(note_int_id)
                folded_bucket = self._tag_notes_casefold.get(term.casefold())
                if folded_bucket is not None:
                    folded_bucket.discard(note_int_id)
            for term in new_tag_terms:
                _add_posting(self._tag_notes, term, note_int_id)
                _add_posting(self._tag_notes_casefold, term.casefold(), note_int_id)
            self._note_tag_terms[note_int_id] = new_tag_terms
            self._note_tag_terms_casefold[note_int_id] = frozenset(
                term.casefold() for term in new_tag_terms
            )

        self._set_note_text_locked(note_int_id, content_text, tags)

    def _remove_existing_locked(self, note_int_id: int) -> None:
        if note_int_id not in self._alive:
            return
        self._alive.remove(note_int_id)

        for term in self._note_tag_terms[note_int_id]:
            bucket = self._tag_notes.get(term)
            if bucket is None:
                continue
            bucket.discard(note_int_id)
            folded_bucket = self._tag_notes_casefold.get(term.casefold())
            if folded_bucket is not None:
                folded_bucket.discard(note_int_id)
        for term in self._note_explicit_tag_terms[note_int_id]:
            bucket = self._explicit_tag_notes.get(term)
            if bucket is None:
                continue
            bucket.discard(note_int_id)
        for term in self._note_raw_tag_terms[note_int_id]:
            bucket = self._raw_tag_notes_casefold.get(term.casefold())
            if bucket is not None:
                bucket.discard(note_int_id)
        self._note_text_casefold[note_int_id] = ""
        self._set_link_title_urls_locked(note_int_id, frozenset())
        if note_int_id in self._note_base_text_casefold:
            del self._note_base_text_casefold[note_int_id]
        self._note_explicit_tag_terms[note_int_id] = frozenset()
        self._note_raw_tag_terms[note_int_id] = frozenset()
        self._note_tag_terms[note_int_id] = frozenset()
        self._note_tag_terms_casefold[note_int_id] = frozenset()

    def _set_note_text_locked(self, note_int_id: int, content_text: str, tags: str) -> None:
        base_text_casefold = build_searchable_base_text_casefold(content_text, tags)
        link_title_urls = list_link_title_urls(content_text)
        self._set_link_title_urls_locked(note_int_id, link_title_urls)
        if link_title_urls:
            self._note_base_text_casefold[note_int_id] = base_text_casefold
        elif note_int_id in self._note_base_text_casefold:
            del self._note_base_text_casefold[note_int_id]
        self._note_text_casefold[note_int_id] = append_link_titles_casefold(base_text_casefold, link_title_urls)

    def _set_link_title_urls_locked(self, note_int_id: int, urls: FrozenSet[str]) -> None:
        previous_urls = self._note_link_title_urls[note_int_id]
        if previous_urls == urls:
            return
        for url in previous_urls - urls:
            bucket = self._link_title_url_notes[url]
            bucket.discard(note_int_id)
            if not bucket:
                del self._link_title_url_notes[url]
        for url in urls - previous_urls:
            _add_posting(self._link_title_url_notes, url, note_int_id)
        self._note_link_title_urls[note_int_id] = urls

    def _build_suggestion_representatives_locked(
        self,
        *,
        anchor_casefold_set: FrozenSet[str],
        partial_prefix: str,
    ) -> Dict[str, str]:
        partial_prefix_casefold = partial_prefix.casefold()
        representatives: Dict[str, str] = {}
        for term in self._tag_notes.keys():
            if not term or term == "OR" or term.startswith("@"):
                continue
            term_casefold = term.casefold()
            if term_casefold in anchor_casefold_set:
                continue
            if partial_prefix != "" and term_casefold == partial_prefix_casefold:
                continue
            if partial_prefix != "" and not tag_term_matches_prefix(term=term, prefix=partial_prefix):
                continue
            if term_casefold not in representatives:
                representatives[term_casefold] = term
                continue
            current = representatives[term_casefold]
            if self._is_better_suggestion_variant_locked(candidate=term, incumbent=current):
                representatives[term_casefold] = term
        return representatives

    def _is_better_suggestion_variant_locked(self, *, candidate: str, incumbent: str) -> bool:
        candidate_count = len(self._tag_notes[candidate])
        incumbent_count = len(self._tag_notes[incumbent])
        if candidate_count != incumbent_count:
            return candidate_count > incumbent_count
        candidate_penalty, candidate_tiebreak = self._suggestion_term_tiebreak_locked(candidate)
        incumbent_penalty, incumbent_tiebreak = self._suggestion_term_tiebreak_locked(incumbent)
        if candidate_penalty != incumbent_penalty:
            return candidate_penalty < incumbent_penalty
        return candidate_tiebreak < incumbent_tiebreak

    def _suggestion_term_tiebreak_locked(self, term: str) -> Tuple[int, str]:
        lower_case_penalty = 0
        if term != term.casefold():
            lower_case_penalty = 1
        return (lower_case_penalty, term)

    def _suggest_meta_tag_completions_locked(self, *, partial_prefix: str, limit: int) -> List[str]:
        partial_prefix_casefold = partial_prefix.casefold()
        candidates: List[Tuple[int, int, str, str]] = []
        for term in list_known_meta_tag_terms():
            if partial_prefix != "" and term.casefold() == partial_prefix_casefold:
                continue
            if partial_prefix != "" and not term.casefold().startswith(partial_prefix_casefold):
                continue
            usage_count = len(self._tag_notes_casefold.get(term.casefold(), set()))
            lower_case_penalty, term_tiebreak = self._suggestion_term_tiebreak_locked(term)
            candidates.append((-usage_count, lower_case_penalty, term_tiebreak, term))
        candidates.sort()
        return [term for _, __, ___, term in candidates[:limit]]

    def _candidate_note_ids_locked(self, clause: SearchClause) -> Set[int]:
        constraints: List[Set[int]] = []

        for tag in clause.required_tags:
            posting = self._tag_notes_casefold.get(tag.casefold())
            if posting is None:
                return set()
            constraints.append(posting)

        candidate_ids: Optional[Set[int]] = None
        if constraints:
            ordered = sorted(constraints, key=len)
            candidate_ids = set(ordered[0])
            for constraint in ordered[1:]:
                candidate_ids.intersection_update(constraint)
                if not candidate_ids:
                    return set()

        if candidate_ids is None:
            candidate_ids = set(self._alive)

        if clause.forbidden_tags:
            for tag in clause.forbidden_tags:
                posting = self._tag_notes_casefold.get(tag.casefold())
                if posting is None:
                    continue
                candidate_ids.difference_update(posting)

        return candidate_ids

    def _matching_note_int_ids_for_clause_locked(self, clause: SearchClause) -> Set[int]:
        candidate_ids = self._candidate_note_ids_locked(clause)
        return {
            note_int_id
            for note_int_id in candidate_ids
            if note_int_id in self._alive
            and self._verify_note_matches_locked(note_int_id, clause)
        }

    def _verify_note_matches_locked(self, note_int_id: int, clause: SearchClause) -> bool:
        text_casefold = self._note_text_casefold[note_int_id]
        for term in clause.required_text:
            if not text_term_matches(term, text_casefold):
                return False
        for term in clause.forbidden_text:
            if text_term_matches(term, text_casefold):
                return False
        note_tag_terms_casefold = self._note_tag_terms_casefold[note_int_id]
        for tag in clause.forbidden_tags:
            if tag.casefold() in note_tag_terms_casefold:
                return False
        return True


search_index = SearchIndex()
# A fetched, decrypted or cleared URL title changes which notes match a text search.
link_title_store.add_titles_changed_listener(search_index.refresh_link_titles)
