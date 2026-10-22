"""Run the offline comparison and print aggregate results only.

Nothing here prints note text, tag names or note ids: only counts, scores,
timings and the names of model inputs.
"""

from __future__ import annotations

import html
import random
import re
import time
from collections import Counter
from dataclasses import dataclass, replace

from app.services.tag_term_matching import tag_term_matches_prefix

from experiments.tag_suggestions.cases import (
    EMPTY_BAR, FIRST_LETTER, MOMENTS, TYPED_MOMENTS, Split, TagCase, build_cases, make_split,
)
from experiments.tag_suggestions.corpus import Corpus
from experiments.tag_suggestions.features import (
    CaseCandidates,
    build_case_candidates,
    build_source_stats,
    fit_vectorizers,
)
from experiments.tag_suggestions.metrics import per_target_hits, score_case, summarize
from experiments.tag_suggestions.models import BoostedRanker, FormulaRanker, LogisticRanker, fuse_ranks, rank_by_column
from experiments.tag_suggestions.world_store import (
    baseline_kept_order, baseline_suggestions, load_world, narrowing_suggestions,
)

# narrowing: the one-letter rule (typing narrows the empty-bar list) at every length; it is today's
# ranking after one letter, so it differs from today only at two and three letters.
MODEL_NAMES = ("today", "today_kept_order", "narrowing", "today+neighbors", "formula", "neighbors", "naive_bayes", "logistic",
               "trees_yes_no", "trees_ranking", "trees+today_slots", "trees+today_alternate")
# Fixed-slot merge: the trees' top 3, then today's best 2 not already shown.
MERGE_TREE_SLOTS = 3
MERGE_TODAY_SLOTS = 2
VALIDATION_FRACTION = 0.15
_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_SEGMENT_SPLIT = re.compile(r"[-_./\s]+")


@dataclass(frozen=True)
class Options:
    max_train_notes: int
    max_test_notes: int
    max_stage: int
    folds: int
    hide_tag_names: bool
    latest_only: bool


@dataclass(frozen=True)
class SplitWindow:
    name: str
    start: float
    end: float


SPLITS = (SplitWindow(name="latest 20%", start=0.8, end=1.0), SplitWindow(name="60-80%", start=0.6, end=0.8))


def run(*, corpus: Corpus, options: Options) -> None:
    assert options.folds >= 2 and options.max_stage >= 0
    if options.hide_tag_names:
        corpus = hide_own_tag_names(corpus)
    _print_corpus(corpus, options)
    windows = SPLITS
    if options.latest_only:
        windows = SPLITS[:1]
    for window in windows:
        split = make_split(corpus=corpus, name=window.name, window_start_fraction=window.start,
                           window_end_fraction=window.end)
        _run_split(corpus=corpus, split=split, options=options)


def hide_own_tag_names(corpus: Corpus) -> Corpus:
    """Ablation: remove each note's own tag names from its text, to see whether models learn concepts."""
    notes = {}
    for note_id, note in corpus.notes.items():
        hidden = set()
        for tag in note.explicit_tags:
            hidden.update(segment for segment in _SEGMENT_SPLIT.split(tag.casefold()) if segment)
        kept = [word for word in _WORD.findall(note.plain_text) if word.casefold() not in hidden]
        text = " ".join(kept)
        notes[note_id] = replace(note, plain_text=text, content_html=f"<div>{html.escape(text)}</div>")
    return Corpus(notes=notes, children=corpus.children, rules_text=corpus.rules_text)


def _print_corpus(corpus: Corpus, options: Options) -> None:
    tagged = [note for note in corpus.notes.values() if note.explicit_tags]
    distinct = {tag.casefold() for note in tagged for tag in note.explicit_tags}
    print(f"Notes: {len(corpus.notes)}, tagged: {len(tagged)}, distinct tags: {len(distinct)}, "
          f"rules: {len([line for line in corpus.rules_text.splitlines() if line.strip()])}")
    print(f"Options: {options}")


PROGRESS_EVERY = 250


def _baseline_for(corpus: Corpus, cases: list[TagCase]) -> tuple[dict[TagCase, list[str]], float]:
    started = time.perf_counter()
    lists: dict[TagCase, list[str]] = {}
    seconds_by_moment: dict[str, list[float]] = {moment: [] for moment in MOMENTS}
    for done, case in enumerate(cases, start=1):
        call_started = time.perf_counter()
        lists[case] = baseline_suggestions(corpus=corpus, case=case)
        seconds_by_moment[case.moment].append(time.perf_counter() - call_started)
        if done % PROGRESS_EVERY == 0 or done == len(cases):
            elapsed = time.perf_counter() - started
            remaining = elapsed / done * (len(cases) - done)
            print(f"    {done}/{len(cases)} moments, {1000 * elapsed / done:.0f} ms each, "
                  f"about {remaining / 60:.1f} min left", flush=True)
    _print_timings(label="today's ranking", seconds_by_moment=seconds_by_moment)
    return lists, time.perf_counter() - started


def _print_timings(*, label: str, seconds_by_moment: dict[str, list[float]]) -> None:
    for moment, seconds in seconds_by_moment.items():
        if seconds:
            ordered = sorted(seconds)
            print(f"    {label}, {moment.replace('_', ' ')}: median {1000 * ordered[len(ordered) // 2]:.0f} ms, "
                  f"slowest 5% {1000 * ordered[int(len(ordered) * 0.95)]:.0f} ms", flush=True)


def _narrowing_for(corpus: Corpus, cases: list[TagCase]) -> dict[TagCase, list[str]]:
    """The single rule at two and three letters (after one letter it is today's ranking)."""
    lists: dict[TagCase, list[str]] = {}
    seconds_by_moment: dict[str, list[float]] = {moment: [] for moment in TYPED_MOMENTS if moment != FIRST_LETTER}
    for case in cases:
        if case.moment not in seconds_by_moment:
            continue
        call_started = time.perf_counter()
        lists[case] = narrowing_suggestions(corpus=corpus, case=case)
        seconds_by_moment[case.moment].append(time.perf_counter() - call_started)
    _print_timings(label="narrowing", seconds_by_moment=seconds_by_moment)
    return lists


def _run_split(*, corpus: Corpus, split: Split, options: Options) -> None:
    started = time.perf_counter()
    train_ids = sorted(split.train_note_ids, key=lambda note_id: corpus.notes[note_id].created_at)
    case_train_ids = train_ids[-options.max_train_notes:]
    test_ids = split.test_note_ids[:options.max_test_notes]
    print(f"\n=== Split: test on tagged notes created in the {split.name} window ===")
    print(f"Learn from {len(train_ids)} tagged notes (cases from the latest {len(case_train_ids)}); "
          f"test on {len(test_ids)} of {len(split.test_note_ids)}; "
          f"{len(split.hidden_note_ids)} notes have their tags hidden")

    test_world = load_world(corpus=corpus, split=split, hidden_note_ids=split.hidden_note_ids)
    vectorizers = fit_vectorizers(corpus=corpus, world=test_world)

    shuffled = list(case_train_ids)
    random.Random(11).shuffle(shuffled)
    folds = [frozenset(shuffled[index::options.folds]) for index in range(options.folds)]
    training_items: list[CaseCandidates] = []
    for fold_number, fold in enumerate(folds, start=1):
        print(f"  preparing training fold {fold_number}/{len(folds)}...", flush=True)
        world = load_world(corpus=corpus, split=split, hidden_note_ids=split.hidden_note_ids | fold)
        cases = build_cases(corpus=corpus, note_ids=tuple(note_id for note_id in case_train_ids if note_id in fold),
                            max_stage=options.max_stage)
        stats = build_source_stats(corpus=corpus, world=world, vectorizers=vectorizers,
                                   source_ids=[note_id for note_id in train_ids if note_id not in fold])
        training_items.extend(build_case_candidates(corpus=corpus, world=world, vectorizers=vectorizers, stats=stats,
                                                    cases=cases))

    test_world = load_world(corpus=corpus, split=split, hidden_note_ids=split.hidden_note_ids)
    test_cases = build_cases(corpus=corpus, note_ids=tuple(test_ids), max_stage=options.max_stage)
    print(f"  running today's ranking on {len(test_cases)} test moments...", flush=True)
    test_baseline, baseline_seconds = _baseline_for(corpus, test_cases)
    print("  running today's ranking with the empty-bar order kept after a letter...", flush=True)
    kept_order = {case: baseline_kept_order(corpus=corpus, case=case)
                  for case in test_cases if case.moment == FIRST_LETTER}
    print("  running the narrowing rule at two and three letters...", flush=True)
    narrowing = _narrowing_for(corpus, test_cases)
    test_stats = build_source_stats(corpus=corpus, world=test_world, vectorizers=vectorizers, source_ids=train_ids)
    feature_started = time.perf_counter()
    test_items = build_case_candidates(corpus=corpus, world=test_world, vectorizers=vectorizers, stats=test_stats,
                                       cases=test_cases)
    feature_seconds_per_case = (time.perf_counter() - feature_started) / max(len(test_items), 1)
    prepared_seconds = time.perf_counter() - started

    by_time = sorted(training_items, key=lambda item: corpus.notes[item.case.note_id].created_at)
    validation_start = int(len(by_time) * (1.0 - VALIDATION_FRACTION))
    fit_items, validation_items = by_time[:validation_start], by_time[validation_start:]
    fit_started = time.perf_counter()
    logistic = LogisticRanker(fit_items)
    formula = FormulaRanker(fit_items)
    trees_yes_no = BoostedRanker(training=fit_items, validation=validation_items, objective="binary")
    trees_ranking = BoostedRanker(training=fit_items, validation=validation_items, objective="lambdarank")
    fit_seconds = time.perf_counter() - fit_started

    rankers = {
        "today": lambda item: test_baseline[item.case],
        "today_kept_order": lambda item: _variant_or_today(item, kept_order, test_baseline),
        "narrowing": lambda item: _variant_or_today(item, narrowing, test_baseline),
        "today+neighbors": lambda item: fuse_ranks([test_baseline[item.case], rank_by_column(item, "knn_score")]),
        "formula": formula.rank,
        "neighbors": lambda item: rank_by_column(item, "knn_score"),
        "naive_bayes": lambda item: rank_by_column(item, "nb_gap"),
        "logistic": logistic.rank,
        "trees_yes_no": trees_yes_no.rank,
        "trees_ranking": trees_ranking.rank,
        "trees+today_slots": lambda item: merge_slots(trees_yes_no.rank(item), test_baseline[item.case]),
        "trees+today_alternate": lambda item: merge_alternate(trees_yes_no.rank(item), test_baseline[item.case]),
    }
    _report(items=test_items, rankers=rankers, training_uses=test_stats.tag_count)
    _report_today_first_letter(items=test_items, today=test_baseline)
    print(f"\nFormula chosen on the training moments: {formula.describe()}")
    print("\nWhat the ranking trees rely on (share of total gain):")
    for name, share in trees_ranking.importance()[:12]:
        print(f"  {name:28s} {share:6.1%}")
    print(f"\nTraining cases: {len(fit_items)} (+{len(validation_items)} for early stopping); "
          f"trees used: yes/no {trees_yes_no.trees}, ranking {trees_ranking.trees}")
    print(f"Timing: preparation {prepared_seconds:.1f}s, model fitting {fit_seconds:.1f}s, "
          f"features {1000 * feature_seconds_per_case:.1f} ms per moment, "
          f"today's ranking {1000 * baseline_seconds / max(len(test_cases), 1):.1f} ms per moment")


def _variant_or_today(item: CaseCandidates, variant: dict[TagCase, list[str]],
                      today: dict[TagCase, list[str]]) -> list[str]:
    """A variant ranks only the moments it differs from today on; the rest are today's."""
    if item.case in variant:
        return variant[item.case]
    return today[item.case]


def merge_slots(trees: list[str], today: list[str]) -> list[str]:
    merged = list(trees[:MERGE_TREE_SLOTS])
    for tag in today:
        if len(merged) == MERGE_TREE_SLOTS + MERGE_TODAY_SLOTS:
            break
        if tag not in merged:
            merged.append(tag)
    for tag in trees[MERGE_TREE_SLOTS:] + today:
        if tag not in merged:
            merged.append(tag)
    return merged


def merge_alternate(trees: list[str], today: list[str]) -> list[str]:
    merged: list[str] = []
    for index in range(max(len(trees), len(today))):
        for source in (trees, today):
            if index < len(source) and source[index] not in merged:
                merged.append(source[index])
    return merged


def _report_today_first_letter(*, items: list[CaseCandidates], today: dict[TagCase, list[str]]) -> None:
    """What today's lists hold when the first letter is typed (checks the low first-letter score)."""
    moments = [item for item in items if item.case.moment == FIRST_LETTER and item.reachable_targets]
    shown = 0
    already_apply = 0
    not_matching = 0
    target_anywhere = 0
    short_lists = 0
    for item in moments:
        top = today[item.case][:5]
        shown += len(top)
        already_apply += sum(1 for tag in top if tag in item.context_tags)
        not_matching += sum(1 for tag in top if not tag_term_matches_prefix(term=tag, prefix=item.case.prefix))
        target_anywhere += int(bool(set(today[item.case]) & item.reachable_targets))
        short_lists += int(len(top) < 5)
    print(f"\nToday's first-letter lists ({len(moments)} moments): {shown / len(moments):.1f} tags in the top 5 on "
          f"average; of those, {already_apply / max(shown, 1):.1%} already apply to the note (bar, inherited or "
          f"implied) and {not_matching / max(shown, 1):.1%} do not match the typed letter; "
          f"{short_lists / len(moments):.1%} of lists have fewer than 5 tags; "
          f"the correct tag is anywhere in today's 20 in {target_anywhere / len(moments):.1%}")


def _stage_label(stage: int) -> str:
    if stage >= 2:
        return "2+"
    return str(stage)


def _report(*, items: list[CaseCandidates], rankers: dict, training_uses: Counter[str]) -> None:
    scored = [item for item in items if item.reachable_targets]
    skipped = len(items) - len(scored)
    reachable = sum(1 for item in scored if set(item.candidates) & item.reachable_targets)
    print(f"Moments scored: {len(scored)} ({skipped} skipped: every target already implied by the context); "
          f"a correct tag is among the candidates in {reachable / len(scored):.1%}")
    groups: dict[tuple[str, str], list[CaseCandidates]] = {}
    for item in scored:
        for key in ((item.case.moment, "all"), (item.case.moment, _stage_label(item.case.stage))):
            if key not in groups:
                groups[key] = []
            groups[key].append(item)
    rankings = {name: {item.case: ranker(item) for item in scored} for name, ranker in rankers.items()}
    for moment in MOMENTS:
        if (moment, "all") not in groups:
            continue
        print(f"\n{moment.replace('_', ' ')}")
        print(f"  {'tags in bar':12s} {'model':22s} {'hit@5':>7s} {'recall@5':>9s} {'MRR':>6s} {'prec@1':>7s} {'n':>6s}")
        for label in ("all", "0", "1", "2+"):
            if (moment, label) not in groups:
                continue
            for name in MODEL_NAMES:
                summary = summarize([score_case(ranked=rankings[name][item.case], targets=item.reachable_targets)
                                     for item in groups[(moment, label)]])
                print(f"  {label:12s} {name:22s} {summary.hit_at_5:7.1%} {summary.recall_at_5:9.1%} "
                      f"{summary.mrr:6.3f} {summary.precision_at_1:7.1%} {summary.cases:6d}")
    print("\nEmpty bar, each correct tag found in the top 5, by how often it was used before:")
    buckets = sorted({bucket for item in groups[(EMPTY_BAR, "all")]
                      for bucket, _hit in per_target_hits(ranked=[], targets=item.reachable_targets,
                                                         training_uses=training_uses)})
    print(f"  {'model':22s}" + "".join(f"{bucket:>18s}" for bucket in buckets))
    for name in MODEL_NAMES:
        hits: dict[str, list[float]] = {bucket: [] for bucket in buckets}
        for item in groups[(EMPTY_BAR, "all")]:
            for bucket, hit in per_target_hits(ranked=rankings[name][item.case], targets=item.reachable_targets,
                                               training_uses=training_uses):
                hits[bucket].append(hit)
        print(f"  {name:22s}" + "".join(
            f"{sum(hits[bucket]) / len(hits[bucket]):>11.1%} n={len(hits[bucket]):<4d}" for bucket in buckets))
