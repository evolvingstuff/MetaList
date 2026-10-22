"""The time split and the tagging moments every model is scored on.

World: the notes as they were at the cutoff. Every note created at or after the
cutoff keeps its text and place in the tree but loses its explicit non-meta tags,
so no model learns from tags the user had not written yet. (Tag addition dates
are not stored: tags on older notes are their current tags.)

Test notes: tagged notes created inside the test window, ordered by creation.
Each gives one case per moment and stage:
  - stage i: the first i of its tags (in the order written) are in the bar;
  - empty bar: every remaining tag is a target;
  - first letter: the next tag is the target, with its first character typed;
  - two and three letters: the same with its first two or three characters typed,
    for targets longer than that (a tag typed in full is no longer a suggestion).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from experiments.tag_suggestions.corpus import Corpus

EMPTY_BAR = "empty_bar"
FIRST_LETTER = "first_letter"
TWO_LETTERS = "two_letters"
THREE_LETTERS = "three_letters"
# Each typed moment and how many characters of the target it has typed.
TYPED_MOMENTS = {FIRST_LETTER: 1, TWO_LETTERS: 2, THREE_LETTERS: 3}
MOMENTS = (EMPTY_BAR, *TYPED_MOMENTS)


@dataclass(frozen=True)
class Split:
    name: str
    cutoff: datetime
    # Tagged notes created before the cutoff: what models learn from.
    train_note_ids: tuple[str, ...]
    # Tagged notes created in [cutoff, window end): what models are scored on.
    test_note_ids: tuple[str, ...]
    # Every note created at or after the cutoff: their explicit tags are hidden.
    hidden_note_ids: frozenset[str]


@dataclass(frozen=True)
class TagCase:
    note_id: str
    moment: str
    stage: int
    # Tags already in the bar, as written (non-meta).
    present: tuple[str, ...]
    # Casefolded tags that count as correct.
    targets: frozenset[str]
    # Typed so far ("" for the empty bar).
    prefix: str


def make_split(*, corpus: Corpus, name: str, window_start_fraction: float, window_end_fraction: float) -> Split:
    """Test on tagged notes between two quantiles of creation time (e.g. 0.8 to 1.0)."""
    assert 0.0 < window_start_fraction < window_end_fraction <= 1.0
    tagged = sorted(
        (note for note in corpus.notes.values() if note.explicit_tags),
        key=lambda note: (note.created_at, note.note_id),
    )
    if len(tagged) < 20:
        raise ValueError(f"Only {len(tagged)} tagged notes: too few to split")
    start_index = int(len(tagged) * window_start_fraction)
    end_index = int(len(tagged) * window_end_fraction)
    cutoff = tagged[start_index].created_at
    train = tuple(note.note_id for note in tagged if note.created_at < cutoff)
    test = tuple(note.note_id for note in tagged[start_index:end_index] if note.created_at >= cutoff)
    hidden = frozenset(note.note_id for note in corpus.notes.values() if note.created_at >= cutoff)
    assert train and test, "both sides of the split need notes"
    assert not set(train) & hidden
    return Split(name=name, cutoff=cutoff, train_note_ids=train, test_note_ids=test, hidden_note_ids=hidden)


def build_cases(*, corpus: Corpus, note_ids: tuple[str, ...], max_stage: int) -> list[TagCase]:
    """Cases for stages 0..max_stage (bounded by each note's tag count)."""
    assert max_stage >= 0
    cases: list[TagCase] = []
    for note_id in note_ids:
        tags = corpus.notes[note_id].explicit_tags
        assert tags, f"note {note_id} has no tags to predict"
        for stage in range(min(len(tags), max_stage + 1)):
            present = tags[:stage]
            present_casefold = {tag.casefold() for tag in present}
            # A tag written twice in different case is one tag.
            remaining = [tag for tag in tags[stage:] if tag.casefold() not in present_casefold]
            if not remaining:
                continue
            cases.append(TagCase(note_id=note_id, moment=EMPTY_BAR, stage=stage, present=present,
                                 targets=frozenset(tag.casefold() for tag in remaining), prefix=""))
            target = remaining[0]
            for moment, typed in TYPED_MOMENTS.items():
                # The first letter is always a moment (as in the earlier runs); longer prefixes only
                # while the tag is not yet typed in full.
                if moment != FIRST_LETTER and len(target) <= typed:
                    continue
                cases.append(TagCase(note_id=note_id, moment=moment, stage=stage, present=present,
                                     targets=frozenset({target.casefold()}), prefix=target[:typed]))
    return cases
