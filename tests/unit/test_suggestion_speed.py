"""Suggestions after a typed tag stay fast however many tags a namespace has. Two bugs
made typing a broad tag and a space wait most of a second (2026-10-20): each candidate's
tag family was found by scanning every tag (16 million comparisons a keystroke), and each
suggestion's reason walked every shared note in Python. These tests pin both the answers
and the work: a family is a lookup, and reasons come from set intersections."""

from __future__ import annotations

import random
from typing import Dict, Set

import app.services.search_index as search_index_module
from app.services.search_index import SearchIndex, SearchRecord, TagCooccurrence, _most_anchors_cooccurrence

_SEED = 41
_CASES = 400
_PROGRESS_INTERVAL = 1000
_TAG_COUNT = 400
_NOTE_COUNT = 2000


def _note_by_note(shared_by_anchor: Dict[str, Set[int]]) -> TagCooccurrence | None:
    """The reason as it was computed before: each note's anchors, one by one."""
    anchors_by_note: Dict[int, Set[str]] = {}
    for anchor, notes in shared_by_anchor.items():
        for note_id in notes:
            if note_id not in anchors_by_note:
                anchors_by_note[note_id] = set()
            anchors_by_note[note_id].add(anchor)
    if not anchors_by_note:
        return None
    most = max(len(anchors) for anchors in anchors_by_note.values())
    at_most = [frozenset(anchors) for anchors in anchors_by_note.values() if len(anchors) == most]
    return TagCooccurrence(anchor_count=most, note_count=len(at_most), anchor_sets=frozenset(at_most))


def test_reasons_from_anchor_groups_match_note_by_note() -> None:
    generator = random.Random(_SEED)
    for _ in range(_CASES):
        anchors = [f"a{number}" for number in range(generator.randint(1, 8))]
        shared = {anchor: set(generator.sample(range(60), generator.randint(1, 25))) for anchor in anchors}
        assert _most_anchors_cooccurrence(shared) == _note_by_note(shared), shared


def _many_tag_index() -> SearchIndex:
    generator = random.Random(_SEED)
    tags = [f"tag{number}" for number in range(_TAG_COUNT)] + ["@code=python", "@code=sql"]
    records = []
    for number in range(_NOTE_COUNT):
        terms = frozenset(generator.sample(tags, generator.randint(1, 6)) + ["journal"])
        records.append(SearchRecord(note_id=f"n{number}", content_text="text", tags=" ".join(sorted(terms)), tag_terms=terms))
    index = SearchIndex()
    index.rebuild(records, raw_tag_terms_by_id={record.note_id: record.tag_terms for record in records},
                  progress_update=lambda _count: None, progress_interval=_PROGRESS_INTERVAL)
    return index


class _ScanCountingPostings(dict):
    """The postings, counting every walk over all of them."""

    scans = 0

    def items(self):
        type(self).scans += 1
        return super().items()

    def __iter__(self):
        type(self).scans += 1
        return super().__iter__()


def test_suggesting_after_a_tag_never_walks_every_tag(monkeypatch) -> None:
    index = _many_tag_index()
    counting = _ScanCountingPostings(index._tag_notes_casefold)
    _ScanCountingPostings.scans = 0
    monkeypatch.setattr(index, "_tag_notes_casefold", counting)
    suggestions = index.suggest_all_tag_completions(query="journal ")
    index.describe_search_suggestions(query="journal ", terms=suggestions[:12])
    assert len(suggestions) > _TAG_COUNT // 2
    # Hundreds of candidates, and not one walk over every tag's posting.
    assert _ScanCountingPostings.scans == 0


def test_reasons_never_walk_shared_notes_one_by_one(monkeypatch) -> None:
    index = _many_tag_index()
    suggestions = index.suggest_all_tag_completions(query="journal ")
    walked = []
    original = search_index_module.combinations

    def counted_combinations(*args):
        walked.append(args)
        return original(*args)

    monkeypatch.setattr(search_index_module, "combinations", counted_combinations)
    index.describe_search_suggestions(query="journal ", terms=suggestions[:12])
    # One anchor: each suggestion's reason is one intersection, found by groups.
    assert walked, "reasons come from anchor groups"
