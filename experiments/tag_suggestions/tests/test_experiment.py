"""Checks for the offline tag-suggestion experiment.

Run in the experiment environment:
    .venv-experiments/bin/python -m pytest -q experiments/tag_suggestions/tests
"""

from __future__ import annotations

import hashlib
from collections import Counter
import sqlite3
from pathlib import Path

import pytest

from app.services.tag_term_matching import tag_term_matches_prefix

from experiments.tag_suggestions.cases import (
    EMPTY_BAR, FIRST_LETTER, THREE_LETTERS, TWO_LETTERS, build_cases, make_split,
)
from experiments.tag_suggestions.features import (
    FEATURE_NAMES,
    build_case_candidates,
    build_source_stats,
    fit_vectorizers,
)
from experiments.tag_suggestions.metrics import score_case
from experiments.tag_suggestions.snapshot import copy_database
from experiments.tag_suggestions.synthetic import build_synthetic_corpus
from experiments.tag_suggestions.world_store import baseline_suggestions, load_world, narrowing_suggestions


def test_the_copy_reads_the_live_database_without_changing_it(tmp_path: Path) -> None:
    live = tmp_path / "live.db"
    connection = sqlite3.connect(live)
    connection.execute("CREATE TABLE notes (id TEXT)")
    connection.execute("INSERT INTO notes VALUES ('a')")
    connection.commit()
    connection.close()
    before = (hashlib.sha256(live.read_bytes()).hexdigest(), live.stat().st_mtime_ns)
    copy = copy_database(source=live, scratch_data_directory=tmp_path / "scratch", namespace="ns")
    assert copy == tmp_path / "scratch" / "namespaces" / "ns" / "ns.metalist.db"
    assert sqlite3.connect(copy).execute("SELECT id FROM notes").fetchall() == [("a",)]
    assert (hashlib.sha256(live.read_bytes()).hexdigest(), live.stat().st_mtime_ns) == before
    with pytest.raises(FileExistsError):
        copy_database(source=live, scratch_data_directory=tmp_path / "scratch", namespace="ns")


def test_the_split_hides_every_tag_written_after_the_cutoff() -> None:
    corpus = build_synthetic_corpus(seed=1, note_count=200)
    split = make_split(corpus=corpus, name="t", window_start_fraction=0.6, window_end_fraction=0.8)
    for note_id in split.train_note_ids:
        assert corpus.notes[note_id].created_at < split.cutoff
    for note_id in split.test_note_ids:
        assert note_id in split.hidden_note_ids
    for note_id, note in corpus.notes.items():
        assert (note_id in split.hidden_note_ids) == (note.created_at >= split.cutoff)
    # The 80-100% notes are neither learned from nor tested, but their tags are hidden too.
    latest = max(corpus.notes.values(), key=lambda note: note.created_at)
    assert latest.note_id in split.hidden_note_ids and latest.note_id not in split.test_note_ids


def test_each_note_gives_moments_in_the_order_its_tags_were_written() -> None:
    corpus = build_synthetic_corpus(seed=1, note_count=200)
    note = next(note for note in corpus.notes.values() if len(note.explicit_tags) == 3)
    cases = build_cases(corpus=corpus, note_ids=(note.note_id,), max_stage=1)
    first, second, third = note.explicit_tags
    assert len(first) > 3 and len(second) > 3, "the synthetic tags are longer than the typed moments"
    assert [(case.moment, case.stage, case.present, case.targets, case.prefix) for case in cases] == [
        (EMPTY_BAR, 0, (), frozenset({first, second, third}), ""),
        (FIRST_LETTER, 0, (), frozenset({first}), first[0]),
        (TWO_LETTERS, 0, (), frozenset({first}), first[:2]),
        (THREE_LETTERS, 0, (), frozenset({first}), first[:3]),
        (EMPTY_BAR, 1, (first,), frozenset({second, third}), ""),
        (FIRST_LETTER, 1, (first,), frozenset({second}), second[0]),
        (TWO_LETTERS, 1, (first,), frozenset({second}), second[:2]),
        (THREE_LETTERS, 1, (first,), frozenset({second}), second[:3]),
    ]


def test_scores() -> None:
    score = score_case(ranked=["a", "b", "c", "d", "e", "f"], targets=frozenset({"c", "f"}))
    assert (score.hit_at_5, score.recall_at_5, score.reciprocal_rank, score.precision_at_1) == (1.0, 0.5, 1 / 3, 0.0)
    miss = score_case(ranked=["a"], targets=frozenset({"z"}))
    assert (miss.hit_at_5, miss.recall_at_5, miss.reciprocal_rank) == (0.0, 0.0, 0.0)
    with pytest.raises(AssertionError):
        score_case(ranked=["a", "a"], targets=frozenset({"a"}))


def test_a_training_fold_never_learns_from_its_own_tags() -> None:
    corpus = build_synthetic_corpus(seed=2, note_count=300)
    split = make_split(corpus=corpus, name="t", window_start_fraction=0.8, window_end_fraction=1.0)
    fold = frozenset(split.train_note_ids[::5])
    world = load_world(corpus=corpus, split=split, hidden_note_ids=split.hidden_note_ids | fold)
    for note_id in fold:
        assert world.explicit[note_id] == frozenset()
    vectorizers = fit_vectorizers(corpus=corpus, world=world)
    source = [note_id for note_id in split.train_note_ids if note_id not in fold]
    stats = build_source_stats(corpus=corpus, world=world, vectorizers=vectorizers, source_ids=source)
    expected: Counter[str] = Counter()
    for note_id in source:
        expected.update({tag.casefold() for tag in corpus.notes[note_id].explicit_tags})
    assert stats.tag_count == expected
    assert not set(stats.source_ids) & fold
    cases = build_cases(corpus=corpus, note_ids=tuple(sorted(fold)), max_stage=1)
    for item in build_case_candidates(corpus=corpus, world=world, vectorizers=vectorizers, stats=stats, cases=cases):
        present = {tag.casefold() for tag in item.case.present}
        assert not present & set(item.candidates), "a tag already in the bar is never a candidate"
        assert len(item.candidates) == len(set(item.candidates))
        assert item.features.shape == (len(item.candidates), len(FEATURE_NAMES))


def test_the_baseline_runs_on_the_world_without_suggesting_tags_in_the_bar() -> None:
    corpus = build_synthetic_corpus(seed=3, note_count=200)
    split = make_split(corpus=corpus, name="t", window_start_fraction=0.8, window_end_fraction=1.0)
    load_world(corpus=corpus, split=split, hidden_note_ids=split.hidden_note_ids)
    for case in build_cases(corpus=corpus, note_ids=split.test_note_ids[:20], max_stage=2):
        suggestions = baseline_suggestions(corpus=corpus, case=case)
        assert not {tag.casefold() for tag in case.present} & set(suggestions[:5])


def test_the_narrowing_rule_is_todays_ranking_after_one_letter_and_only_narrows() -> None:
    corpus = build_synthetic_corpus(seed=3, note_count=200)
    split = make_split(corpus=corpus, name="t", window_start_fraction=0.8, window_end_fraction=1.0)
    load_world(corpus=corpus, split=split, hidden_note_ids=split.hidden_note_ids)
    cases = build_cases(corpus=corpus, note_ids=split.test_note_ids[:20], max_stage=2)
    assert {case.moment for case in cases} == {EMPTY_BAR, FIRST_LETTER, TWO_LETTERS, THREE_LETTERS}
    for case in cases:
        if case.moment == EMPTY_BAR:
            continue
        narrowed = narrowing_suggestions(corpus=corpus, case=case)
        if case.moment == FIRST_LETTER:
            assert narrowed == baseline_suggestions(corpus=corpus, case=case)
        present = {tag.casefold() for tag in case.present}
        assert not present & set(narrowed)
        assert all(tag_term_matches_prefix(term=tag, prefix=case.prefix) for tag in narrowed)
