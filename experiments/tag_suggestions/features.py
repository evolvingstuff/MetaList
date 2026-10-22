"""Candidate tags and the ranker inputs for each tagging moment.

Statistics come from "source" notes, whose tags a model may learn from. Test
cases use every training note as source. Training cases use out-of-fold
sources (the training notes outside their fold), so a note's own tags never
feed the statistics it is scored with.
"""

from __future__ import annotations

import bisect
import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Callable, Iterable

import numpy as np
from scipy import sparse
from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer
from sklearn.preprocessing import normalize

from app.services.ontology_rules_store import extract_ontology_tags
from app.services.tag_term_matching import tag_term_matches_prefix

from experiments.tag_suggestions.cases import TagCase
from experiments.tag_suggestions.corpus import Corpus
from experiments.tag_suggestions.world_store import World

NEIGHBOR_COUNT = 30
GENERATOR_DEPTH = 30
MAX_CANDIDATES = 80
CONTEXT_BLOCK_WEIGHT = 1.0
NAIVE_BAYES_ALPHA = 0.1
ABSENT_RANK = 100.0
NEVER_USED_DAYS = 10000.0
_SEGMENT_SPLIT = re.compile(r"[-_./\s]+")
_WORD = re.compile(r"[^\W_]+", re.UNICODE)

FEATURE_NAMES = (
    "knn_score", "knn_rank", "nb_gap", "nb_rank",
    "present_cooc_max", "present_cooc_mean", "inherited_cooc_max", "inherited_cooc_mean",
    "parent_has", "nearest_ancestor_distance", "sibling_fraction", "sibling_count", "descendant_fraction",
    "depth", "log_tag_count", "uses_30d", "uses_365d", "days_since_last_use",
    "name_in_text", "stage", "letters_typed", "log_text_words",
    "joint_fraction", "joint_support", "in_rules",
)


def _identity(tokens: list[str]) -> list[str]:
    return tokens


@dataclass(frozen=True)
class Vectorizers:
    text: TfidfVectorizer
    words: CountVectorizer
    context: TfidfVectorizer
    text_matrix: sparse.csr_matrix
    word_matrix: sparse.csr_matrix
    row_by_note: dict[str, int]


def fit_vectorizers(*, corpus: Corpus, world: World) -> Vectorizers:
    """Text vocabularies over every note (text is not a label, so this does not leak tags)."""
    note_ids = sorted(corpus.notes)
    texts = [corpus.notes[note_id].plain_text for note_id in note_ids]
    text = TfidfVectorizer(lowercase=True, ngram_range=(1, 2), min_df=2, max_features=60000, sublinear_tf=True)
    words = CountVectorizer(lowercase=True, min_df=2, max_features=60000)
    context = TfidfVectorizer(analyzer=_identity)
    context.fit([sorted(world.explicit[note_id] | _casefold(world.inherited[note_id])) for note_id in note_ids]
                + [["__no_context_tags__"]])
    return Vectorizers(
        text=text, words=words, context=context,
        text_matrix=text.fit_transform(texts).tocsr(),
        word_matrix=words.fit_transform(texts).tocsr(),
        row_by_note={note_id: row for row, note_id in enumerate(note_ids)},
    )


def _casefold(tags: frozenset[str]) -> frozenset[str]:
    return frozenset(tag.casefold() for tag in tags)


@dataclass
class SourceStats:
    """Everything learned from one set of source notes."""

    source_ids: list[str]
    tag_count: Counter[str]
    # pair_count[a][b]: source notes with both a and b.
    pair_count: dict[str, Counter[str]]
    # inherited_pair_count[c][t]: source notes that inherit c and have t.
    inherited_pair_count: dict[str, Counter[str]]
    inherited_count: Counter[str]
    tag_days: dict[str, list[float]]
    tags: list[str]
    tag_index: dict[str, int]
    # Tags by number of source notes, most used first.
    tags_by_use: list[str]
    neighbor_matrix: sparse.csr_matrix
    neighbor_tags: list[frozenset[str]]
    nb_log_word: sparse.csr_matrix
    nb_tag_constant: np.ndarray
    # tag_notes[t]: positions in source_ids of the notes with t.
    tag_notes: dict[str, frozenset[int]]
    # Tags a moment may offer by name: used ones, ones the rules mention, inherited ones.
    rule_tags: frozenset[str]
    # name_index[word]: known tags with that word as one of their name segments.
    name_index: dict[str, list[str]]
    name_segments: dict[str, frozenset[str]]


def _days(corpus: Corpus, note_id: str) -> float:
    return corpus.notes[note_id].created_at.timestamp() / 86400.0


def build_source_stats(*, corpus: Corpus, world: World, vectorizers: Vectorizers,
                       source_ids: list[str]) -> SourceStats:
    assert source_ids
    tag_count: Counter[str] = Counter()
    pair_count: dict[str, Counter[str]] = {}
    inherited_pair_count: dict[str, Counter[str]] = {}
    inherited_count: Counter[str] = Counter()
    days_by_tag: dict[str, list[float]] = {}
    for note_id in source_ids:
        own = world.explicit[note_id]
        assert own, f"source note {note_id} has no visible tags"
        inherited = _casefold(world.inherited[note_id])
        for tag in own:
            tag_count[tag] += 1
            if tag not in days_by_tag:
                days_by_tag[tag] = []
            days_by_tag[tag].append(_days(corpus, note_id))
            for other in own:
                if other != tag:
                    _count_pair(pair_count, other, tag)
            for context_tag in inherited:
                _count_pair(inherited_pair_count, context_tag, tag)
        for context_tag in inherited:
            inherited_count[context_tag] += 1
    tags = sorted(tag_count)
    tag_index = {tag: index for index, tag in enumerate(tags)}
    tag_note_lists: dict[str, list[int]] = {}
    for position, note_id in enumerate(source_ids):
        for tag in world.explicit[note_id]:
            if tag not in tag_note_lists:
                tag_note_lists[tag] = []
            tag_note_lists[tag].append(position)
    rule_tags = frozenset(tag.casefold() for tag in extract_ontology_tags(world.ontology)
                          if not tag.startswith("@"))
    inherited_anywhere = {tag.casefold() for tags_ in world.inherited.values() for tag in tags_}
    name_segments: dict[str, frozenset[str]] = {}
    name_index: dict[str, list[str]] = {}
    for tag in sorted(set(tag_count) | rule_tags | inherited_anywhere):
        segments = frozenset(segment for segment in _SEGMENT_SPLIT.split(tag) if segment)
        if not segments:
            continue
        name_segments[tag] = segments
        for segment in segments:
            if segment not in name_index:
                name_index[segment] = []
            name_index[segment].append(tag)

    rows = [vectorizers.row_by_note[note_id] for note_id in source_ids]
    neighbor_context = [sorted(world.explicit[note_id] | _casefold(world.inherited[note_id])) for note_id in source_ids]
    neighbor_matrix = _combine_blocks(vectorizers.text_matrix[rows], vectorizers.context.transform(neighbor_context))

    # Naive Bayes against the background: log P(w|t) - log P(w), from word counts.
    label_rows, label_cols = [], []
    for row, note_id in enumerate(source_ids):
        for tag in world.explicit[note_id]:
            label_rows.append(row)
            label_cols.append(tag_index[tag])
    labels = sparse.csr_matrix((np.ones(len(label_rows)), (label_rows, label_cols)), shape=(len(source_ids), len(tags)))
    word_counts = vectorizers.word_matrix[rows]
    tag_word = (labels.T @ word_counts).tocsr()
    vocabulary_size = word_counts.shape[1]
    tag_totals = np.asarray(tag_word.sum(axis=1)).ravel()
    nb_log_word = tag_word.copy().astype(np.float64)
    nb_log_word.data = np.log1p(nb_log_word.data / NAIVE_BAYES_ALPHA)
    log_prior = np.log(np.array([tag_count[tag] for tag in tags], dtype=np.float64) / len(source_ids))
    nb_tag_constant = log_prior - np.log(tag_totals + NAIVE_BAYES_ALPHA * vocabulary_size)
    return SourceStats(
        source_ids=list(source_ids), tag_count=tag_count, pair_count=pair_count,
        inherited_pair_count=inherited_pair_count, inherited_count=inherited_count,
        tag_days={tag: sorted(days) for tag, days in days_by_tag.items()}, tags=tags, tag_index=tag_index,
        tags_by_use=[tag for tag, _count in tag_count.most_common()],
        neighbor_matrix=neighbor_matrix, neighbor_tags=[world.explicit[note_id] for note_id in source_ids],
        nb_log_word=nb_log_word, nb_tag_constant=nb_tag_constant,
        tag_notes={tag: frozenset(positions) for tag, positions in tag_note_lists.items()},
        rule_tags=rule_tags, name_index=name_index, name_segments=name_segments,
    )


def _count_pair(pairs: dict[str, Counter[str]], first: str, second: str) -> None:
    if first not in pairs:
        pairs[first] = Counter()
    pairs[first][second] += 1


def _pair_fraction(pairs: dict[str, Counter[str]], counts: Counter[str], first: str, second: str) -> float:
    assert counts[first] > 0
    if first not in pairs:
        return 0.0
    return pairs[first][second] / counts[first]


def _combine_blocks(text_block: sparse.spmatrix, context_block: sparse.spmatrix) -> sparse.csr_matrix:
    combined = sparse.hstack([normalize(text_block), CONTEXT_BLOCK_WEIGHT * normalize(context_block)]).tocsr()
    return normalize(combined)


@dataclass(frozen=True)
class CaseCandidates:
    case: TagCase
    candidates: list[str]
    features: np.ndarray
    labels: np.ndarray
    # Targets the model could have found (not already implied by the context).
    reachable_targets: frozenset[str]
    # Tags that already apply (bar, inherited, implied by the rules).
    context_tags: frozenset[str]


def case_context(*, corpus: Corpus, world: World, case: TagCase) -> frozenset[str]:
    """Casefolded tags that already apply: bar, inherited, and what the rules imply from them."""
    note = corpus.notes[case.note_id]
    base = frozenset(case.present) | frozenset(note.meta_tags) | world.inherited[case.note_id]
    effective = world.ontology.infer_effective_tags(base_tags=base, plaintext=note.plain_text)
    return _casefold(effective)


# Similarity rows are computed this many moments at a time, keeping only the nearest neighbors.
SIMILARITY_BATCH = 256
# Generator rankings look this deep for tags the moment allows.
RANK_DEPTH = 200


def build_case_candidates(*, corpus: Corpus, world: World, vectorizers: Vectorizers, stats: SourceStats,
                          cases: list[TagCase]) -> list[CaseCandidates]:
    """Candidates and features for cases that all use the same source statistics."""
    if not cases:
        return []
    rows = [vectorizers.row_by_note[case.note_id] for case in cases]
    query_context = [sorted(_casefold(frozenset(case.present)) | _casefold(world.inherited[case.note_id]))
                     for case in cases]
    queries = _combine_blocks(vectorizers.text_matrix[rows], vectorizers.context.transform(query_context))
    word_rows = vectorizers.word_matrix[rows]
    trees: dict[str, _TreeContext] = {}
    built: list[CaseCandidates] = []
    for batch_start in range(0, len(cases), SIMILARITY_BATCH):
        batch = slice(batch_start, batch_start + SIMILARITY_BATCH)
        similarities = (queries[batch] @ stats.neighbor_matrix.T).toarray()
        nearest = np.argpartition(-similarities, min(NEIGHBOR_COUNT, similarities.shape[1] - 1), axis=1)
        nearest = nearest[:, :NEIGHBOR_COUNT]
        batch_words = word_rows[batch]
        nb_scores = np.asarray((batch_words @ stats.nb_log_word.T).todense())
        nb_scores += np.asarray(batch_words.sum(axis=1)) * math.log(NAIVE_BAYES_ALPHA) + stats.nb_tag_constant
        for offset, case in enumerate(cases[batch]):
            if case.note_id not in trees:
                trees[case.note_id] = _tree_context(corpus=corpus, world=world, note_id=case.note_id)
            neighbors = [(int(neighbor), float(similarities[offset, neighbor])) for neighbor in nearest[offset]
                         if similarities[offset, neighbor] > 0]
            built.append(_one_case(corpus=corpus, world=world, stats=stats, case=case, neighbors=neighbors,
                                   nb_row=nb_scores[offset], word_count=int(batch_words[offset].sum()),
                                   tree=trees[case.note_id]))
    return built


def _first_allowed(ordered: Iterable[str], allowed: Callable[[str], bool], limit: int) -> list[str]:
    found: list[str] = []
    for tag in ordered:
        if allowed(tag):
            found.append(tag)
            if len(found) == limit:
                break
    return found


def _one_case(*, corpus: Corpus, world: World, stats: SourceStats, case: TagCase, neighbors: list[tuple[int, float]],
              nb_row: np.ndarray, word_count: int, tree: "_TreeContext") -> CaseCandidates:
    context = case_context(corpus=corpus, world=world, case=case)
    present = _casefold(frozenset(case.present))
    inherited = _casefold(world.inherited[case.note_id])
    case_days = _days(corpus, case.note_id)

    # Nearest neighbors' tags, weighted by similarity.
    neighbor_scores: Counter[str] = Counter()
    total_similarity = sum(similarity for _neighbor, similarity in neighbors)
    for neighbor, similarity in neighbors:
        for tag in stats.neighbor_tags[neighbor]:
            neighbor_scores[tag] += similarity / total_similarity

    def allowed(tag: str) -> bool:
        if tag in context or tag in present or tag.startswith("@"):
            return False
        return tag_term_matches_prefix(term=tag, prefix=case.prefix)

    nb_top = np.argpartition(-nb_row, min(4 * RANK_DEPTH, len(nb_row) - 1))[:4 * RANK_DEPTH]
    nb_ordered = (stats.tags[position] for position in nb_top[np.argsort(-nb_row[nb_top])])
    nb_allowed = _first_allowed(nb_ordered, allowed, RANK_DEPTH)
    knn_allowed = _first_allowed((tag for tag, _score in neighbor_scores.most_common()), allowed, RANK_DEPTH)
    cooc: Counter[str] = Counter()
    for context_tag in present:
        if context_tag in stats.pair_count:
            cooc.update(stats.pair_count[context_tag])
    inherited_cooc: Counter[str] = Counter()
    for context_tag in inherited:
        if context_tag in stats.inherited_pair_count:
            inherited_cooc.update(stats.inherited_pair_count[context_tag])
    joint, joint_support = _joint_tags(stats=stats, present=present)
    words = {word.casefold() for word in _WORD.findall(corpus.notes[case.note_id].plain_text)}
    named = _named_tags(stats=stats, words=words)
    candidates: list[str] = []
    seen: set[str] = set()
    sources = (knn_allowed[:GENERATOR_DEPTH], nb_allowed[:GENERATOR_DEPTH],
               _first_allowed((tag for tag, _count in joint.most_common()), allowed, GENERATOR_DEPTH),
               _first_allowed(named, allowed, GENERATOR_DEPTH),
               _first_allowed((tag for tag, _count in cooc.most_common()), allowed, GENERATOR_DEPTH),
               _first_allowed((tag for tag, _count in inherited_cooc.most_common()), allowed, GENERATOR_DEPTH),
               _first_allowed(tree.hierarchy_tags, allowed, GENERATOR_DEPTH))
    for source in sources:
        for tag in source:
            if tag not in seen:
                seen.add(tag)
                candidates.append(tag)
    if case.prefix != "":
        for tag in _first_allowed(stats.tags_by_use, allowed, GENERATOR_DEPTH):
            if tag not in seen:
                seen.add(tag)
                candidates.append(tag)
    candidates = candidates[:MAX_CANDIDATES]
    joint_fraction: dict[str, float] = {}
    if joint_support > 0:
        joint_fraction = {tag: count / joint_support for tag, count in joint.items()}

    knn_rank = {tag: position for position, tag in enumerate(knn_allowed)}
    nb_rank = {tag: position for position, tag in enumerate(nb_allowed)}
    nb_best = float(nb_row.max())
    rows: list[list[float]] = []
    for tag in candidates:
        joint_value = 0.0
        if tag in joint_fraction:
            joint_value = joint_fraction[tag]
        rows.append(_candidate_features(
            tree=tree, stats=stats, case=case, tag=tag, present=present, inherited=inherited,
            case_days=case_days, neighbor_score=neighbor_scores[tag], knn_rank=knn_rank, nb_rank=nb_rank,
            nb_gap=_nb_gap(stats=stats, nb_row=nb_row, nb_best=nb_best, tag=tag),
            words=words, word_count=word_count,
        ) + [joint_value, math.log1p(joint_support), float(tag in stats.rule_tags)])
    reachable = frozenset(target for target in case.targets if target not in context)
    labels = np.array([tag in reachable for tag in candidates], dtype=np.float64)
    features = np.array(rows, dtype=np.float64).reshape(len(candidates), len(FEATURE_NAMES))
    return CaseCandidates(case=case, candidates=candidates, features=features, labels=labels,
                          reachable_targets=reachable, context_tags=context)


def _joint_tags(*, stats: SourceStats, present: frozenset[str]) -> tuple[Counter[str], int]:
    """Tags on the source notes that carry every tag already in the bar, and how many such notes."""
    if not present:
        return Counter(), 0
    if any(tag not in stats.tag_notes for tag in present):
        return Counter(), 0
    note_sets = sorted((stats.tag_notes[tag] for tag in present), key=len)
    notes = note_sets[0].intersection(*note_sets[1:])
    joint: Counter[str] = Counter()
    for position in notes:
        joint.update(stats.neighbor_tags[position] - present)
    return joint, len(notes)


def _named_tags(*, stats: SourceStats, words: set[str]) -> list[str]:
    """Known tags whose every name segment is a word of the note, most specific and most used first."""
    found: set[str] = set()
    for word in words:
        if word in stats.name_index:
            for tag in stats.name_index[word]:
                if stats.name_segments[tag] <= words:
                    found.add(tag)
    return sorted(found, key=lambda tag: (-len(stats.name_segments[tag]), -stats.tag_count[tag], tag))


def _nb_gap(*, stats: SourceStats, nb_row: np.ndarray, nb_best: float, tag: str) -> float:
    if tag not in stats.tag_index:
        return -1000.0
    return float(nb_row[stats.tag_index[tag]]) - nb_best


def _rank_or_absent(ranks: dict[str, int], tag: str) -> float:
    if tag in ranks:
        return float(ranks[tag])
    return ABSENT_RANK


@dataclass(frozen=True)
class _TreeContext:
    """The note's place in the tree, counted once per moment."""

    ancestor_tags: list[frozenset[str]]
    sibling_count: int
    sibling_tags: Counter[str]
    descendant_count: int
    descendant_tags: Counter[str]
    # Candidate tags from the tree, nearest first: parent, siblings, children, other ancestors.
    hierarchy_tags: list[str]


def _tree_context(*, corpus: Corpus, world: World, note_id: str) -> _TreeContext:
    siblings = corpus.siblings(note_id)
    descendants = corpus.descendants(note_id)
    sibling_tags: Counter[str] = Counter()
    for sibling in siblings:
        sibling_tags.update(world.explicit[sibling])
    descendant_tags: Counter[str] = Counter()
    for descendant in descendants:
        descendant_tags.update(world.explicit[descendant])
    ancestor_tags = [world.explicit[ancestor] for ancestor in corpus.ancestors(note_id)]
    child_tags: Counter[str] = Counter()
    for child in corpus.child_ids(note_id):
        child_tags.update(world.explicit[child])
    parent_tags: list[str] = []
    if ancestor_tags:
        parent_tags = sorted(ancestor_tags[0])
    hierarchy_tags: list[str] = []
    groups = [parent_tags,
              [tag for tag, _count in sibling_tags.most_common()],
              [tag for tag, _count in child_tags.most_common()],
              sorted(set().union(*ancestor_tags[1:]))]
    for group in groups:
        for tag in group:
            if tag not in hierarchy_tags:
                hierarchy_tags.append(tag)
    return _TreeContext(
        ancestor_tags=ancestor_tags, sibling_count=len(siblings), sibling_tags=sibling_tags,
        descendant_count=len(descendants), descendant_tags=descendant_tags, hierarchy_tags=hierarchy_tags,
    )


def _candidate_features(*, tree: _TreeContext, stats: SourceStats, case: TagCase, tag: str,
                        present: frozenset[str], inherited: frozenset[str], case_days: float, neighbor_score: float,
                        knn_rank: dict[str, int], nb_rank: dict[str, int], nb_gap: float,
                        words: set[str], word_count: int) -> list[float]:
    present_cooc = [_pair_fraction(stats.pair_count, stats.tag_count, context_tag, tag)
                    for context_tag in present if stats.tag_count[context_tag] > 0]
    inherited_cooc = [_pair_fraction(stats.inherited_pair_count, stats.inherited_count, context_tag, tag)
                      for context_tag in inherited if stats.inherited_count[context_tag] > 0]
    parent_has = 0.0
    if tree.ancestor_tags and tag in tree.ancestor_tags[0]:
        parent_has = 1.0
    nearest = 0.0
    for distance, ancestor_tags in enumerate(tree.ancestor_tags, start=1):
        if tag in ancestor_tags:
            nearest = float(distance)
            break
    uses_30, uses_365, since_last = _usage(stats=stats, tag=tag, case_days=case_days)
    segments = [segment for segment in _SEGMENT_SPLIT.split(tag) if segment]
    name_in_text = sum(1 for segment in segments if segment in words) / max(len(segments), 1)
    return [
        neighbor_score, _rank_or_absent(knn_rank, tag), nb_gap, _rank_or_absent(nb_rank, tag),
        _max_or_zero(present_cooc), _mean_or_zero(present_cooc),
        _max_or_zero(inherited_cooc), _mean_or_zero(inherited_cooc),
        parent_has, nearest,
        tree.sibling_tags[tag] / max(tree.sibling_count, 1), float(tree.sibling_count),
        tree.descendant_tags[tag] / max(tree.descendant_count, 1),
        float(len(tree.ancestor_tags)), math.log1p(stats.tag_count[tag]), uses_30, uses_365, since_last,
        name_in_text, float(case.stage),
        float(len(case.prefix)), math.log1p(word_count),
    ]


def _max_or_zero(values: list[float]) -> float:
    if not values:
        return 0.0
    return max(values)


def _mean_or_zero(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)


def _usage(*, stats: SourceStats, tag: str, case_days: float) -> tuple[float, float, float]:
    """Uses in the 30 and 365 days before the case, and days since the last use."""
    if tag not in stats.tag_days:
        return 0.0, 0.0, NEVER_USED_DAYS
    days = stats.tag_days[tag]
    before = bisect.bisect_left(days, case_days)
    if before == 0:
        return 0.0, 0.0, NEVER_USED_DAYS
    uses_30 = before - bisect.bisect_left(days, case_days - 30.0)
    uses_365 = before - bisect.bisect_left(days, case_days - 365.0)
    return float(uses_30), float(uses_365), case_days - days[before - 1]
