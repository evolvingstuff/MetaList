from __future__ import annotations

from collections import Counter
from typing import Dict, FrozenSet, Iterable, List, Tuple

from app.config import TAG_SUGGESTION_CONNECTORS
from app.config import TAG_SUGGESTION_SUPPRESS_REDUNDANT_CONTENT_VARIANTS
from app.services.note_store import store as note_store
from app.services.ontology_rules_store import extract_ontology_tags
from app.services.ontology_rules_store import get_ontology
from app.services.search_index import search_index
from app.services.tag_term_matching import TagContentMatch
from app.services.tag_term_matching import build_normalized_content_match_context
from app.services.tag_term_matching import list_significant_content_match_segments
from app.services.tag_term_matching import match_tag_term_in_content_match_context
from app.services.tag_term_matching import normalize_tag_match_text
from app.services.tag_term_matching import split_tag_term_segments
from app.services.tag_term_matching import split_tag_term_segments_preserving_case
from app.services.tag_term_matching import tag_term_matches_prefix
from app.utils.text_utils import strip_html


def _preferred_display_term_sort_key(
    *,
    term: str,
    exact_tag_counts: Dict[str, int],
) -> Tuple[int, int, str]:
    return (
        -_lookup_count(exact_tag_counts, term),
        *_suggestion_tiebreak(term),
    )


def _choose_preferred_display_term(
    *,
    terms: Iterable[str],
    exact_tag_counts: Dict[str, int],
) -> str:
    preferred_term = ""
    for term in terms:
        if preferred_term == "":
            preferred_term = term
            continue
        if _preferred_display_term_sort_key(
            term=term,
            exact_tag_counts=exact_tag_counts,
        ) < _preferred_display_term_sort_key(
            term=preferred_term,
            exact_tag_counts=exact_tag_counts,
        ):
            preferred_term = term
    if preferred_term == "":
        raise ValueError("terms must contain at least one tag")
    return preferred_term


def _select_preferred_case_variants(*, terms: Iterable[str], exact_tag_counts: Dict[str, int]) -> List[str]:
    by_casefold: Dict[str, List[str]] = {}
    for term in terms:
        term_casefold = term.casefold()
        if term_casefold in by_casefold:
            if term in by_casefold[term_casefold]:
                continue
            by_casefold[term_casefold].append(term)
            continue
        by_casefold[term_casefold] = [term]
    return [
        _choose_preferred_display_term(
            terms=variants,
            exact_tag_counts=exact_tag_counts,
        )
        for variants in by_casefold.values()
    ]


def _equivalent_suggestion_group_key(*, term: str, ontology) -> Tuple[str, ...]:
    if not isinstance(term, str) or not term:
        raise TypeError("term must be a non-empty string")

    scc_members_by_tag = getattr(ontology, "scc_members_by_tag", {})
    if not isinstance(scc_members_by_tag, dict) and not hasattr(scc_members_by_tag, "get"):
        return (term.casefold(),)

    equivalent_terms = scc_members_by_tag.get(term)
    if not equivalent_terms:
        return (term.casefold(),)

    normalized_members = tuple(sorted({member.casefold() for member in equivalent_terms}))
    if not normalized_members:
        return (term.casefold(),)
    return normalized_members


def _build_equivalent_term_representatives(
    *,
    terms: Iterable[str],
    exact_tag_counts: Dict[str, int],
    ontology,
) -> Dict[str, str]:
    grouped_terms: Dict[Tuple[str, ...], List[str]] = {}
    for term in terms:
        group_key = _equivalent_suggestion_group_key(term=term, ontology=ontology)
        group_terms = grouped_terms.setdefault(group_key, [])
        if term in group_terms:
            continue
        group_terms.append(term)

    representatives: Dict[str, str] = {}
    for group_terms in grouped_terms.values():
        representative = _choose_preferred_display_term(
            terms=group_terms,
            exact_tag_counts=exact_tag_counts,
        )
        for term in group_terms:
            representatives[term] = representative
    return representatives


def _collapse_equivalent_suggestions(
    *,
    suggestions: Iterable[str],
    representative_by_term: Dict[str, str],
    preserve_duplicate_terms: FrozenSet[str],
) -> List[str]:
    collapsed: List[str] = []
    seen_casefold: set[str] = set()
    for term in suggestions:
        if term.casefold() in preserve_duplicate_terms:
            term_casefold = term.casefold()
            if term_casefold in seen_casefold:
                continue
            seen_casefold.add(term_casefold)
            collapsed.append(term)
            continue
        representative = representative_by_term.get(term, term)
        representative_casefold = representative.casefold()
        if representative_casefold in seen_casefold:
            continue
        seen_casefold.add(representative_casefold)
        collapsed.append(representative)
    return collapsed


def _sanitize_tag_terms(*, tags: Iterable[str], field_name: str) -> List[str]:
    if tags is None:
        raise TypeError(f"{field_name} must be provided")

    cleaned: List[str] = []
    for tag in tags:
        if not isinstance(tag, str):
            raise TypeError(f"{field_name} must be strings")
        if tag:
            cleaned.append(tag)
    return cleaned


def _build_search_query_for_suggestions(*, anchors: Iterable[str], prefix: str) -> str:
    if not isinstance(prefix, str):
        raise TypeError("prefix must be a string")

    parts: List[str] = []
    for anchor in anchors:
        if not isinstance(anchor, str):
            raise TypeError("anchors must be strings")
        if anchor:
            parts.append(anchor)

    if prefix != "":
        parts.append(prefix)
        return " ".join(parts)

    if parts:
        return " ".join(parts) + " "

    return ""


def _build_cooccurrence_query_anchors(
    *,
    explicit_anchors: Iterable[str],
    inherited_non_meta: Iterable[str],
) -> List[str]:
    merged: List[str] = []
    seen_casefold: set[str] = set()

    for tag in explicit_anchors:
        tag_casefold = tag.casefold()
        if tag_casefold in seen_casefold:
            continue
        seen_casefold.add(tag_casefold)
        merged.append(tag)

    for tag in sorted(inherited_non_meta, key=lambda value: (value.casefold(), value)):
        if tag.startswith("@"):
            continue
        tag_casefold = tag.casefold()
        if tag_casefold in seen_casefold:
            continue
        seen_casefold.add(tag_casefold)
        merged.append(tag)

    return merged


def _collect_cooccurrence_candidates(
    *,
    all_terms: List[str],
    candidate_terms: List[str],
    explicit_anchors: Iterable[str],
    inherited_non_meta: FrozenSet[str],
    prefix: str,
) -> tuple[List[str], Dict[str, int], FrozenSet[str]]:
    if not candidate_terms:
        return [], {}, frozenset()

    query_anchors = _build_cooccurrence_query_anchors(
        explicit_anchors=explicit_anchors,
        inherited_non_meta=inherited_non_meta,
    )
    if not query_anchors and prefix == "":
        return [], {}, frozenset()

    query = _build_search_query_for_suggestions(
        anchors=query_anchors,
        prefix=prefix,
    )
    ranked_terms = search_index.suggest_tag_completions(
        query=query,
        limit=max(1, len(all_terms)),
    )
    candidate_by_casefold = {term.casefold(): term for term in candidate_terms}

    filtered: List[str] = []
    seen_casefold: set[str] = set()
    for term in ranked_terms:
        canonical_term = candidate_by_casefold.get(term.casefold())
        if canonical_term is None:
            continue
        canonical_casefold = canonical_term.casefold()
        if canonical_casefold in seen_casefold:
            continue
        seen_casefold.add(canonical_casefold)
        filtered.append(canonical_term)

    if prefix == "":
        overlap_terms = frozenset(filtered)
    else:
        overlap_query = _build_search_query_for_suggestions(
            anchors=query_anchors,
            prefix="",
        )
        ranked_overlap_terms = search_index.suggest_tag_completions(
            query=overlap_query,
            limit=max(1, len(all_terms)),
        )
        overlap_terms = frozenset(
            canonical_term
            for term in ranked_overlap_terms
            if (canonical_term := candidate_by_casefold.get(term.casefold())) is not None
        )
    return filtered, {term: index for index, term in enumerate(filtered)}, overlap_terms


def _score_content_match(match: TagContentMatch) -> int:
    if not isinstance(match, TagContentMatch):
        raise TypeError("match must be a TagContentMatch")

    unmatched_segment_count = match.segment_count - match.matched_segment_count
    assert unmatched_segment_count >= 0

    score = 0
    if match.phrase_match:
        score += 1000
    if match.raw_partial_phrase_match:
        score += 750
    score += match.matched_segment_count * 100
    score -= unmatched_segment_count * 10
    score += max(0, 100 - min(match.first_position, 100))
    score += match.normalized_length
    return score


def _get_note_record_or_none(note_id: str):
    if not hasattr(note_store, "get_note"):
        return None
    if hasattr(note_store, "has_note") and not note_store.has_note(note_id):
        return None
    return note_store.get_note(note_id)


def _can_iterate_saved_notes() -> bool:
    return hasattr(note_store, "list_note_ids") and hasattr(note_store, "get_note")


def _list_saved_note_ids() -> List[str]:
    if not _can_iterate_saved_notes():
        return []
    note_ids = note_store.list_note_ids()
    if not isinstance(note_ids, list):
        raise TypeError("note_store.list_note_ids() must return a list")
    return note_ids


def _suggestion_tiebreak(term: str) -> Tuple[int, str]:
    lower_case_penalty = 1
    if term == term.casefold():
        lower_case_penalty = 0
    return (lower_case_penalty, term)


def _lookup_count(counts: Dict[str, int], term: str) -> int:
    if term in counts:
        return counts[term]
    return 0


def _lookup_rank_after_ranked_terms(ranks: Dict[str, int], term: str) -> int:
    if term in ranks:
        return ranks[term]
    return len(ranks)


def _list_content_match_terms_for_candidate(*, term: str, ontology) -> Tuple[str, ...]:
    if not isinstance(term, str) or not term:
        raise TypeError("term must be a non-empty string")

    scc_members_by_tag = ontology.scc_members_by_tag
    if not hasattr(scc_members_by_tag, "get"):
        raise TypeError("ontology.scc_members_by_tag must support get()")

    equivalent_terms = scc_members_by_tag.get(term)
    if not equivalent_terms:
        return (term,)

    content_match_terms = [term]
    seen_casefold = {term.casefold()}
    for equivalent_term in sorted(equivalent_terms, key=lambda value: (value.casefold(), value)):
        if not isinstance(equivalent_term, str) or not equivalent_term:
            raise TypeError("ontology equivalent terms must be non-empty strings")
        equivalent_casefold = equivalent_term.casefold()
        if equivalent_casefold in seen_casefold:
            continue
        seen_casefold.add(equivalent_casefold)
        content_match_terms.append(equivalent_term)
    return tuple(content_match_terms)


def _collect_explicit_tag_statistics() -> Tuple[List[str], Dict[str, int]]:
    exact_tag_counts = search_index.list_explicit_tag_frequencies()
    if exact_tag_counts and (not _can_iterate_saved_notes() or getattr(note_store, "loaded", False)):
        preferred_terms = _select_preferred_case_variants(
            terms=exact_tag_counts.keys(),
            exact_tag_counts=exact_tag_counts,
        )
        representative_by_casefold = {term.casefold(): term for term in preferred_terms}
        representative_counts: Counter[str] = Counter()
        for term, count in exact_tag_counts.items():
            representative = representative_by_casefold[term.casefold()]
            representative_counts[representative] += count

        all_terms = list(representative_counts.keys())
        all_terms.sort(
            key=lambda term: (
                -representative_counts[term],
                *_suggestion_tiebreak(term),
            )
        )
        return all_terms, dict(representative_counts)

    if not _can_iterate_saved_notes():
        return [], {}

    exact_tag_counts: Counter[str] = Counter()
    for note_id in _list_saved_note_ids():
        record = note_store.get_note(note_id)
        for tag in record.non_meta_tag_terms:
            if tag:
                exact_tag_counts[tag] += 1

    preferred_terms = _select_preferred_case_variants(
        terms=exact_tag_counts.keys(),
        exact_tag_counts=dict(exact_tag_counts),
    )
    representative_by_casefold = {term.casefold(): term for term in preferred_terms}
    representative_counts: Counter[str] = Counter()
    for term, count in exact_tag_counts.items():
        representative = representative_by_casefold[term.casefold()]
        representative_counts[representative] += count

    all_terms = list(representative_counts.keys())
    all_terms.sort(
        key=lambda term: (
            -representative_counts[term],
            *_suggestion_tiebreak(term),
        )
    )
    return all_terms, dict(representative_counts)


def _merge_ontology_tag_terms(
    *,
    explicit_terms: List[str],
    exact_tag_counts: Dict[str, int],
    ontology,
) -> tuple[List[str], FrozenSet[str]]:
    ontology_terms = {
        term for term in extract_ontology_tags(ontology)
        if not term.startswith("@")
    }
    explicit_casefold = {term.casefold() for term in explicit_terms}
    ontology_only_casefold = frozenset(
        term.casefold()
        for term in ontology_terms
        if term.casefold() not in explicit_casefold
    )

    merged_terms = _select_preferred_case_variants(
        terms=list(explicit_terms) + sorted(ontology_terms),
        exact_tag_counts=exact_tag_counts,
    )
    merged_terms.sort(
        key=lambda term: (
            -_lookup_count(exact_tag_counts, term),
            *_suggestion_tiebreak(term),
        )
    )
    return merged_terms, ontology_only_casefold


def _build_saved_note_context_non_meta_tags(
    *,
    note_id: str,
) -> FrozenSet[str]:
    if not _can_iterate_saved_notes():
        return frozenset()

    record = note_store.get_note(note_id)
    inherited_non_meta = note_store.get_inherited_non_meta_tag_terms(note_id)
    base_tags = frozenset(record.non_meta_tag_terms | inherited_non_meta)
    return frozenset(tag for tag in base_tags if not tag.startswith("@"))


def _list_subtree_note_ids(note_id: str) -> List[str]:
    if not hasattr(note_store, "get_children"):
        return []

    ordered: List[str] = []
    seen: set[str] = set()
    to_visit: List[str] = [note_id]
    while to_visit:
        current_id = to_visit.pop()
        if current_id in seen:
            continue
        seen.add(current_id)
        if _get_note_record_or_none(current_id) is None:
            continue
        ordered.append(current_id)
        child_ids = note_store.get_children(current_id)
        for child_id in reversed(child_ids):
            to_visit.append(child_id)
    return ordered


def _list_ancestor_note_ids(note_id: str) -> List[str]:
    ancestors: List[str] = []
    seen: set[str] = set()
    current_id = note_id
    while True:
        record = _get_note_record_or_none(current_id)
        if record is None or record.parent_id is None:
            return ancestors
        parent_id = record.parent_id
        if parent_id in seen:
            raise RuntimeError(f"Cycle detected while collecting ancestors for {note_id}")
        seen.add(parent_id)
        ancestors.append(parent_id)
        current_id = parent_id


def _summarize_note_group(note_ids: Iterable[str]) -> tuple[Counter[str], str]:
    explicit_counts: Counter[str] = Counter()
    plaintext_parts: List[str] = []
    for note_id in note_ids:
        record = _get_note_record_or_none(note_id)
        if record is None:
            continue
        plaintext = strip_html(record.content)
        if plaintext:
            plaintext_parts.append(plaintext)
        for tag in record.non_meta_tag_terms:
            if tag:
                explicit_counts[tag] += 1
    return explicit_counts, normalize_tag_match_text(" ".join(plaintext_parts))


def _collect_content_match_scores(
    *,
    candidate_terms: Iterable[str],
    normalized_content: str,
    ontology,
) -> Dict[str, TagContentMatch]:
    if normalized_content == "":
        return {}

    context = build_normalized_content_match_context(normalized_content=normalized_content)
    content_token_set = frozenset(context.token_positions.keys())
    matches: Dict[str, TagContentMatch] = {}
    for term in candidate_terms:
        strongest_match = None
        for content_match_term in _list_content_match_terms_for_candidate(
            term=term,
            ontology=ontology,
        ):
            if not _term_has_required_content_overlap(
                term=content_match_term,
                content_token_set=content_token_set,
            ):
                continue
            match = match_tag_term_in_content_match_context(term=content_match_term, context=context)
            if match is None:
                continue
            if strongest_match is None or match.sort_key() > strongest_match.sort_key():
                strongest_match = match
        if strongest_match is not None:
            matches[term] = strongest_match
    return matches


def _collect_direct_standalone_literal_terms(
    *,
    candidate_terms: Iterable[str],
    normalized_content: str,
    ontology,
) -> FrozenSet[str]:
    if normalized_content == "":
        return frozenset()

    context = build_normalized_content_match_context(normalized_content=normalized_content)
    direct_terms: set[str] = set()
    for term in candidate_terms:
        if len(normalize_tag_match_text(term)) < 2:
            continue
        equivalent_terms = ontology.scc_members_by_tag.get(term, frozenset())
        equivalent_casefolds = {equivalent.casefold() for equivalent in equivalent_terms}
        if len(equivalent_casefolds) > 1:
            continue
        raw_segments = split_tag_term_segments(term)
        if not raw_segments or len(context.tokens) < len(raw_segments):
            continue
        for index in range(len(context.tokens) - len(raw_segments) + 1):
            if context.tokens[index : index + len(raw_segments)] != raw_segments:
                continue
            direct_terms.add(term)
            break
    return frozenset(direct_terms)


def _build_prefix_content_remainder(*, term: str, prefix: str) -> str:
    if not isinstance(term, str) or not term:
        raise TypeError("term must be a non-empty string")
    if not isinstance(prefix, str) or not prefix:
        raise TypeError("prefix must be a non-empty string")
    if not tag_term_matches_prefix(term=term, prefix=prefix):
        raise ValueError("prefix must match the tag term")

    raw_segments = split_tag_term_segments_preserving_case(term)
    prefix_segments = split_tag_term_segments(prefix)
    if not raw_segments:
        raise ValueError("term must contain at least one segment")
    if not prefix_segments:
        return "-".join(raw_segments)

    matched_segment_index = -1
    if term.casefold().startswith(prefix.casefold()):
        matched_segment_index = len(prefix_segments) - 1
        assert matched_segment_index < len(raw_segments)
    else:
        prefix_casefold = prefix.casefold()
        for index, raw_segment in enumerate(raw_segments):
            if raw_segment.casefold().startswith(prefix_casefold):
                matched_segment_index = index
                break
        assert matched_segment_index >= 0

    remainder_segments = raw_segments[matched_segment_index + 1 :]
    return "-".join(remainder_segments)


def _collect_prefix_remainder_content_match_scores(
    *,
    candidate_terms: Iterable[str],
    normalized_content: str,
    ontology,
    prefix: str,
) -> Dict[str, TagContentMatch]:
    if normalized_content == "":
        return {}
    if not isinstance(prefix, str) or not prefix:
        raise TypeError("prefix must be a non-empty string")

    context = build_normalized_content_match_context(normalized_content=normalized_content)
    content_token_set = frozenset(context.token_positions.keys())
    matches: Dict[str, TagContentMatch] = {}
    for term in candidate_terms:
        strongest_match = None
        for content_match_term in _list_content_match_terms_for_candidate(
            term=term,
            ontology=ontology,
        ):
            if not tag_term_matches_prefix(term=content_match_term, prefix=prefix):
                continue
            remainder = _build_prefix_content_remainder(
                term=content_match_term,
                prefix=prefix,
            )
            if remainder == "":
                continue
            if not _term_has_required_content_overlap(
                term=remainder,
                content_token_set=content_token_set,
            ):
                continue
            match = match_tag_term_in_content_match_context(term=remainder, context=context)
            if match is None:
                continue
            if strongest_match is None or match.sort_key() > strongest_match.sort_key():
                strongest_match = match
        if strongest_match is not None:
            matches[term] = strongest_match
    return matches


def _collect_exact_synonym_content_hits(
    *,
    candidate_terms: Iterable[str],
    normalized_content: str,
    ontology,
    suppressed_casefold: set[str],
    prefix: str,
) -> Dict[str, List[str]]:
    if normalized_content == "":
        return {}

    context = build_normalized_content_match_context(normalized_content=normalized_content)
    content_token_set = frozenset(context.token_positions.keys())
    aliases_by_representative: Dict[str, List[tuple[str, TagContentMatch]]] = {}
    for term in candidate_terms:
        alias_matches: List[tuple[str, TagContentMatch]] = []
        for content_match_term in _list_content_match_terms_for_candidate(
            term=term,
            ontology=ontology,
        ):
            if content_match_term.casefold() == term.casefold():
                continue
            if content_match_term.casefold() in suppressed_casefold:
                continue
            if prefix != "" and not tag_term_matches_prefix(term=content_match_term, prefix=prefix):
                continue
            if not _term_has_required_content_overlap(
                term=content_match_term,
                content_token_set=content_token_set,
            ):
                continue
            match = match_tag_term_in_content_match_context(term=content_match_term, context=context)
            if match is None:
                continue
            if not match.raw_phrase_match and not match.phrase_match:
                continue
            alias_matches.append((content_match_term, match))
        if not alias_matches:
            continue
        alias_matches.sort(
            key=lambda alias_match: (
                alias_match[1].sort_key(),
                alias_match[0],
            ),
            reverse=True,
        )
        aliases_by_representative[term] = [alias for alias, _match in alias_matches]
    return aliases_by_representative


def _term_has_required_content_overlap(*, term: str, content_token_set: FrozenSet[str]) -> bool:
    segments = tuple(dict.fromkeys(list_significant_content_match_segments(term)))
    if not segments:
        return False
    raw_segments = split_tag_term_segments(term)
    raw_segment_count = len(raw_segments)
    non_numeric_segment_count = sum(1 for segment in raw_segments if not segment.isdecimal())
    required_matched_segment_count = max(1, min(len(segments), non_numeric_segment_count - 1))
    matched_segment_count = sum(1 for segment in segments if segment in content_token_set)
    if matched_segment_count >= required_matched_segment_count:
        return True
    has_numeric_segment = any(segment.isdigit() for segment in raw_segments)
    return raw_segment_count >= 3 and has_numeric_segment and matched_segment_count > 0


def _collect_undercovered_content_overlap_terms(
    *,
    candidate_terms: Iterable[str],
    normalized_content: str,
) -> FrozenSet[str]:
    if normalized_content == "":
        return frozenset()

    content_token_set = frozenset(normalized_content.split())
    if not content_token_set:
        return frozenset()

    undercovered_terms: set[str] = set()
    for term in candidate_terms:
        segments = tuple(dict.fromkeys(list_significant_content_match_segments(term)))
        if not segments:
            continue
        matched_segment_count = sum(1 for segment in segments if segment in content_token_set)
        if matched_segment_count <= 0:
            continue
        required_matched_segment_count = max(1, len(segments) - 1)
        if matched_segment_count < required_matched_segment_count:
            undercovered_terms.add(term)
    return frozenset(undercovered_terms)


def _rank_terms_by_local_context(
    *,
    note_id: str,
    candidate_terms: List[str],
    exact_tag_counts: Dict[str, int],
    cooccurrence_rank: Dict[str, int],
    ontology,
) -> List[str]:
    current_record = _get_note_record_or_none(note_id)
    if current_record is None:
        return []

    candidate_by_casefold = {term.casefold(): term for term in candidate_terms}
    local_scores: Counter[str] = Counter()

    current_note_content_matches = _collect_content_match_scores(
        candidate_terms=candidate_terms,
        normalized_content=normalize_tag_match_text(strip_html(current_record.content)),
        ontology=ontology,
    )
    for term, match in current_note_content_matches.items():
        local_scores[term] += 20000 + _score_content_match(match)

    current_subtree_ids = _list_subtree_note_ids(note_id)
    descendant_ids = [candidate_id for candidate_id in current_subtree_ids if candidate_id != note_id]
    descendant_explicit_counts, descendant_content = _summarize_note_group(descendant_ids)
    for term, count in descendant_explicit_counts.items():
        canonical_term = candidate_by_casefold.get(term.casefold())
        if canonical_term is None:
            continue
        local_scores[canonical_term] += 12000 + (count * 200)
    descendant_content_matches = _collect_content_match_scores(
        candidate_terms=candidate_terms,
        normalized_content=descendant_content,
        ontology=ontology,
    )
    for term, match in descendant_content_matches.items():
        local_scores[term] += 9000 + _score_content_match(match)

    sibling_subtree_ids: List[str] = []
    if current_record.parent_id is not None:
        parent_subtree_ids = _list_subtree_note_ids(current_record.parent_id)
        current_subtree_set = set(current_subtree_ids)
        sibling_subtree_ids = [
            candidate_id for candidate_id in parent_subtree_ids
            if candidate_id not in current_subtree_set
        ]
    sibling_explicit_counts, sibling_content = _summarize_note_group(sibling_subtree_ids)
    for term, count in sibling_explicit_counts.items():
        canonical_term = candidate_by_casefold.get(term.casefold())
        if canonical_term is None:
            continue
        local_scores[canonical_term] += 6000 + (count * 150)
    sibling_content_matches = _collect_content_match_scores(
        candidate_terms=candidate_terms,
        normalized_content=sibling_content,
        ontology=ontology,
    )
    for term, match in sibling_content_matches.items():
        local_scores[term] += 4500 + _score_content_match(match)

    ancestor_ids = _list_ancestor_note_ids(note_id)
    _, ancestor_content = _summarize_note_group(ancestor_ids)
    ancestor_content_matches = _collect_content_match_scores(
        candidate_terms=candidate_terms,
        normalized_content=ancestor_content,
        ontology=ontology,
    )
    for term, match in ancestor_content_matches.items():
        local_scores[term] += 1500 + _score_content_match(match)

    ranked_terms = [term for term in candidate_terms if local_scores[term] > 0]
    ranked_terms.sort(
        key=lambda term: (
            -local_scores[term],
            -_lookup_count(exact_tag_counts, term),
            _lookup_rank_after_ranked_terms(cooccurrence_rank, term),
            term,
        )
    )
    return ranked_terms


def _rank_terms_by_context_overlap(
    *,
    note_id: str,
    candidate_terms: List[str],
    current_context_tags: FrozenSet[str],
    exact_tag_counts: Dict[str, int],
) -> List[str]:
    if not _can_iterate_saved_notes():
        return []
    if not current_context_tags:
        return []

    current_context_casefold = {tag.casefold() for tag in current_context_tags}
    candidate_by_casefold = {term.casefold(): term for term in candidate_terms}
    overlap_max_by_term: Dict[str, int] = {}
    overlap_support_by_term: Counter[str] = Counter()

    for other_note_id in _list_saved_note_ids():
        if other_note_id == note_id:
            continue
        record = note_store.get_note(other_note_id)
        if not record.non_meta_tag_terms:
            continue

        other_context_tags = _build_saved_note_context_non_meta_tags(note_id=other_note_id)
        if not other_context_tags:
            continue
        other_context_casefold = {tag.casefold() for tag in other_context_tags}
        overlap_count = len(current_context_casefold & other_context_casefold)
        if overlap_count <= 0:
            continue

        for explicit_tag in record.non_meta_tag_terms:
            canonical_term = candidate_by_casefold.get(explicit_tag.casefold())
            if canonical_term is None:
                continue
            previous_max = 0
            if canonical_term in overlap_max_by_term:
                previous_max = overlap_max_by_term[canonical_term]
            if overlap_count > previous_max:
                overlap_max_by_term[canonical_term] = overlap_count
                overlap_support_by_term[canonical_term] = 1
                continue
            if overlap_count == previous_max:
                overlap_support_by_term[canonical_term] += 1

    ranked_terms = list(overlap_max_by_term.keys())
    ranked_terms.sort(
        key=lambda term: (
            -overlap_max_by_term[term],
            -overlap_support_by_term[term],
            -_lookup_count(exact_tag_counts, term),
            *_suggestion_tiebreak(term),
        )
    )
    return ranked_terms


def _content_match_sort_key(
    *,
    term: str,
    content_match_scores: Dict[str, TagContentMatch],
    direct_standalone_literal_terms: FrozenSet[str],
    exact_tag_counts: Dict[str, int],
    cooccurrence_rank: Dict[str, int],
) -> tuple[object, ...]:
    match = content_match_scores[term]
    unmatched_segment_count = match.segment_count - match.matched_segment_count
    assert unmatched_segment_count >= 0
    tag_frequency = _lookup_count(exact_tag_counts, term)
    structured_term_penalty = 1
    if term != term.casefold():
        structured_term_penalty = 0
    elif any(char.isdigit() for char in term):
        structured_term_penalty = 0
    elif any(char in TAG_SUGGESTION_CONNECTORS for char in term):
        structured_term_penalty = 0
    return (
        -(1 if match.raw_phrase_match else 0),
        -(1 if match.raw_partial_phrase_match else 0),
        -match.raw_partial_phrase_segment_count,
        -match.raw_segment_count
        if match.raw_phrase_match or match.raw_partial_phrase_match
        else match.raw_segment_count,
        -(1 if match.phrase_match else 0),
        -match.matched_segment_count,
        unmatched_segment_count,
        structured_term_penalty,
        -(1 if term in direct_standalone_literal_terms else 0),
        -tag_frequency,
        match.first_matched_raw_segment_index,
        match.first_position,
        match.raw_phrase_position
        if match.raw_phrase_match
        else match.raw_partial_phrase_position
        if match.raw_partial_phrase_match
        else len(term),
        match.raw_segment_count,
        -match.normalized_length,
        _lookup_rank_after_ranked_terms(cooccurrence_rank, term),
        *_suggestion_tiebreak(term),
    )


def _collect_active_content_match_segments(
    *,
    explicit_tags: Iterable[str],
    inherited_non_meta: FrozenSet[str],
) -> FrozenSet[str]:
    active_segments: set[str] = set()
    for tag in explicit_tags:
        if tag.startswith("@"):
            continue
        active_segments.update(list_significant_content_match_segments(tag))
    for tag in inherited_non_meta:
        if tag.startswith("@"):
            continue
        active_segments.update(list_significant_content_match_segments(tag))
    return frozenset(active_segments)


def _suppress_redundant_content_variant_candidates(
    *,
    candidate_terms: List[str],
    content_match_scores: Dict[str, TagContentMatch],
    active_segments: FrozenSet[str],
) -> List[str]:
    if not active_segments:
        return candidate_terms

    filtered_terms: List[str] = []
    for term in candidate_terms:
        if term not in content_match_scores:
            filtered_terms.append(term)
            continue
        match = content_match_scores[term]
        if len(match.matched_segments) == 0:
            filtered_terms.append(term)
            continue
        if set(match.matched_segments).issubset(active_segments):
            continue
        filtered_terms.append(term)
    return filtered_terms


def _interleave_ranked_terms(
    *,
    primary_terms: List[str],
    secondary_terms: List[str],
) -> List[str]:
    interleaved: List[str] = []
    primary_index = 0
    secondary_index = 0
    while primary_index < len(primary_terms) or secondary_index < len(secondary_terms):
        if primary_index < len(primary_terms):
            interleaved.append(primary_terms[primary_index])
            primary_index += 1
        if secondary_index < len(secondary_terms):
            interleaved.append(secondary_terms[secondary_index])
            secondary_index += 1
    return interleaved


def suggest_tags_for_note(
    *,
    note_id: str,
    anchors: Iterable[str],
    explicit_tags: Iterable[str],
    prefix: str,
    content_html: str,
    limit: int,
) -> List[str]:
    if not isinstance(note_id, str) or not note_id:
        raise TypeError("note_id must be a non-empty string")
    if not isinstance(prefix, str):
        raise TypeError("prefix must be a string")
    if not isinstance(content_html, str):
        raise TypeError("content_html must be a string")
    if not isinstance(limit, int) or limit <= 0:
        raise TypeError("limit must be a positive integer")

    anchor_list = _sanitize_tag_terms(tags=anchors, field_name="anchors")
    explicit_tag_list = _sanitize_tag_terms(tags=explicit_tags, field_name="explicit_tags")
    anchor_set = {tag for tag in anchor_list if not tag.startswith("@")}
    explicit_tag_casefold_set = {tag.casefold() for tag in explicit_tag_list if not tag.startswith("@")}
    has_prefix = prefix != ""
    is_single_character_non_meta_prefix = (
        not prefix.startswith("@") and len(normalize_tag_match_text(prefix)) == 1
    )

    inherited_non_meta = note_store.get_inherited_non_meta_tag_terms(note_id)
    base_tags = frozenset(anchor_set | inherited_non_meta)

    plaintext = strip_html(content_html)
    ontology = get_ontology()
    if ontology.is_empty:
        context_tags = base_tags
    else:
        context_tags = ontology.infer_implication_only(base_tags=base_tags)
    inherited_or_implied_tags = {
        tag for tag in context_tags
        if not tag.startswith("@") and tag.casefold() not in explicit_tag_casefold_set
    }
    suppressed_casefold = set(explicit_tag_casefold_set)
    if not is_single_character_non_meta_prefix:
        suppressed_casefold.update(tag.casefold() for tag in inherited_or_implied_tags)

    explicit_terms, exact_tag_counts = _collect_explicit_tag_statistics()
    all_terms, ontology_only_casefold = _merge_ontology_tag_terms(
        explicit_terms=explicit_terms,
        exact_tag_counts=exact_tag_counts,
        ontology=ontology,
    )
    if has_prefix and prefix.startswith("@"):
        meta_query = _build_search_query_for_suggestions(anchors=anchor_list, prefix=prefix)
        meta_suggestions = search_index.suggest_tag_completions(query=meta_query, limit=limit)
        return meta_suggestions

    normalized_content = normalize_tag_match_text(plaintext)
    candidate_terms: List[str] = []
    for term in all_terms:
        if term.casefold() in suppressed_casefold:
            continue
        if has_prefix and not tag_term_matches_prefix(term=term, prefix=prefix):
            continue
        candidate_terms.append(term)

    content_match_scores = _collect_content_match_scores(
        candidate_terms=candidate_terms,
        normalized_content=normalized_content,
        ontology=ontology,
    )
    direct_standalone_literal_terms = _collect_direct_standalone_literal_terms(
        candidate_terms=candidate_terms,
        normalized_content=normalized_content,
        ontology=ontology,
    )
    if has_prefix:
        prefix_remainder_scores = _collect_prefix_remainder_content_match_scores(
            candidate_terms=candidate_terms,
            normalized_content=normalized_content,
            ontology=ontology,
            prefix=prefix,
        )
        for term, match in prefix_remainder_scores.items():
            if term not in content_match_scores:
                content_match_scores[term] = match
                continue
            current_match = content_match_scores[term]
            if match.sort_key() > current_match.sort_key():
                content_match_scores[term] = match
    exact_synonym_content_hits = _collect_exact_synonym_content_hits(
        candidate_terms=candidate_terms,
        normalized_content=normalized_content,
        ontology=ontology,
        suppressed_casefold=suppressed_casefold,
        prefix=prefix,
    )
    undercovered_content_overlap_terms = frozenset()
    if not has_prefix:
        undercovered_content_overlap_terms = _collect_undercovered_content_overlap_terms(
            candidate_terms=candidate_terms,
            normalized_content=normalized_content,
        )

    if TAG_SUGGESTION_SUPPRESS_REDUNDANT_CONTENT_VARIANTS and not has_prefix:
        active_content_segments = _collect_active_content_match_segments(
            explicit_tags=explicit_tag_list,
            inherited_non_meta=inherited_non_meta,
        )
        candidate_terms = _suppress_redundant_content_variant_candidates(
            candidate_terms=candidate_terms,
            content_match_scores=content_match_scores,
            active_segments=active_content_segments,
        )
        candidate_term_set = set(candidate_terms)
        content_match_scores = {
            term: match
            for term, match in content_match_scores.items()
            if term in candidate_term_set
        }

    cooccurrence, cooccurrence_rank, cooccurrence_hit_terms = _collect_cooccurrence_candidates(
        all_terms=all_terms,
        candidate_terms=candidate_terms,
        explicit_anchors=anchor_list,
        inherited_non_meta=inherited_non_meta,
        prefix=prefix,
    )

    content_first = list(content_match_scores.keys())
    content_first.sort(
        key=lambda term: _content_match_sort_key(
            term=term,
            content_match_scores=content_match_scores,
            direct_standalone_literal_terms=direct_standalone_literal_terms,
            exact_tag_counts=exact_tag_counts,
            cooccurrence_rank=cooccurrence_rank,
        )
    )
    content_first_with_exact_synonyms: List[str] = []
    seen_content_first_casefold: set[str] = set()
    for term in content_first:
        term_casefold = term.casefold()
        if term_casefold not in seen_content_first_casefold:
            content_first_with_exact_synonyms.append(term)
            seen_content_first_casefold.add(term_casefold)
        for synonym in exact_synonym_content_hits.get(term, []):
            synonym_casefold = synonym.casefold()
            if synonym_casefold in seen_content_first_casefold:
                continue
            content_first_with_exact_synonyms.append(synonym)
            seen_content_first_casefold.add(synonym_casefold)
    local_first = _rank_terms_by_local_context(
        note_id=note_id,
        candidate_terms=candidate_terms,
        exact_tag_counts=exact_tag_counts,
        cooccurrence_rank=cooccurrence_rank,
        ontology=ontology,
    )
    overlap_first = _rank_terms_by_context_overlap(
        note_id=note_id,
        candidate_terms=candidate_terms,
        current_context_tags=frozenset(tag for tag in base_tags if not tag.startswith("@")),
        exact_tag_counts=exact_tag_counts,
    )

    has_direct_anchor_context = len(anchor_set) > 0
    cooccurrence_only: List[str] = []
    if has_direct_anchor_context:
        for term in cooccurrence:
            if term in content_first_with_exact_synonyms:
                continue
            cooccurrence_only.append(term)

    hierarchy_only = [
        term for term in local_first
        if term not in content_first_with_exact_synonyms and term not in cooccurrence_only
    ]
    overlap_only = [
        term for term in overlap_first
        if term not in content_first_with_exact_synonyms and term not in cooccurrence_only and term not in hierarchy_only
    ]

    remaining: List[str] = []
    seen_terms = set(content_first_with_exact_synonyms)
    seen_terms.update(cooccurrence_only)
    seen_terms.update(hierarchy_only)
    seen_terms.update(overlap_only)

    for term in cooccurrence:
        if term in seen_terms:
            continue
        remaining.append(term)
        seen_terms.add(term)

    for term in candidate_terms:
        if term in seen_terms:
            continue
        if term in undercovered_content_overlap_terms:
            continue
        if not has_prefix and term.casefold() in ontology_only_casefold:
            continue
        remaining.append(term)
        seen_terms.add(term)

    suggestions = _interleave_ranked_terms(
        primary_terms=content_first_with_exact_synonyms,
        secondary_terms=cooccurrence_only,
    ) + hierarchy_only + overlap_only + remaining

    if has_prefix:
        present_suffix: List[str] = []
        preferred_present_terms = _select_preferred_case_variants(
            terms=inherited_or_implied_tags,
            exact_tag_counts=exact_tag_counts,
        )
        for term in preferred_present_terms:
            if tag_term_matches_prefix(term=term, prefix=prefix):
                present_suffix.append(term)
        present_suffix.sort()
        suggestions.extend(present_suffix)

    if is_single_character_non_meta_prefix:
        raw_tag_counts = search_index.list_raw_tag_frequencies_by_casefold()
        suggestions.sort(
            key=lambda term: (
                0
                if term in cooccurrence_hit_terms
                else 1
                if term in direct_standalone_literal_terms
                else 2,
                cooccurrence_rank[term]
                if term in cooccurrence_hit_terms
                else -_lookup_count(raw_tag_counts, term.casefold()),
            )
        )

    representative_by_term = _build_equivalent_term_representatives(
        terms=list(candidate_terms) + suggestions,
        exact_tag_counts=exact_tag_counts,
        ontology=ontology,
    )
    collapsed_suggestions = _collapse_equivalent_suggestions(
        suggestions=suggestions,
        representative_by_term=representative_by_term,
        preserve_duplicate_terms=frozenset(
            synonym.casefold()
            for synonyms in exact_synonym_content_hits.values()
            for synonym in synonyms
        ),
    )
    return collapsed_suggestions[:limit]


__all__ = ["suggest_tags_for_note"]
