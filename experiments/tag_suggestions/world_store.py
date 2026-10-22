"""MetaList's own note store, loaded with the World of one split.

The app's tag suggestions (the baseline) and its tag inheritance read the
note store and search index singletons. Loading them with the World (tags of
notes at or after the cutoff hidden) gives the baseline exactly what the other
models see. Only this experiment process is affected; nothing is written.
"""

from __future__ import annotations

from dataclasses import dataclass

import app.services.note_store as note_store_module
import app.services.tag_suggestions as tag_suggestions_module
from app.config import MAX_TAG_SUGGESTIONS
from app.services.note_store import store
from app.services.tag_ontology import TagOntology, compile_rules, parse_rules_text
from app.services.tag_term_matching import tag_term_matches_prefix

from experiments.tag_suggestions.cases import FIRST_LETTER, Split, TagCase
from experiments.tag_suggestions.corpus import Corpus


@dataclass(frozen=True)
class World:
    split: Split
    # Notes whose explicit tags this World hides (the split's, plus a training fold's).
    hidden_note_ids: frozenset[str]
    ontology: TagOntology
    # Casefolded non-meta explicit tags each note shows in the World.
    explicit: dict[str, frozenset[str]]
    # Non-meta tags each note inherits from its ancestors (and references), as written.
    inherited: dict[str, frozenset[str]]


def compile_ontology(rules_text: str) -> TagOntology:
    return compile_rules(rules=parse_rules_text(text=rules_text, filename="experiment_rules"),
                         filename="experiment_rules")


def load_world(*, corpus: Corpus, split: Split, hidden_note_ids: frozenset[str]) -> World:
    """Load the note store with `hidden_note_ids` showing only their meta tags."""
    assert split.hidden_note_ids <= hidden_note_ids
    ontology, explicit = load_store(corpus=corpus, hidden_note_ids=hidden_note_ids)
    return World(
        split=split,
        hidden_note_ids=hidden_note_ids,
        ontology=ontology,
        explicit=explicit,
        inherited={note_id: frozenset(store.get_inherited_non_meta_tag_terms(note_id)) for note_id in corpus.notes},
    )


def load_store(*, corpus: Corpus, hidden_note_ids: frozenset[str]) -> tuple[TagOntology, dict[str, frozenset[str]]]:
    """Load MetaList's note store and search index from the corpus; returns the ontology and visible tags."""
    ontology = compile_ontology(corpus.rules_text)
    tags_by_id: dict[str, str] = {}
    explicit: dict[str, frozenset[str]] = {}
    for note_id, note in corpus.notes.items():
        if note_id in hidden_note_ids:
            tags_by_id[note_id] = " ".join(note.meta_tags)
            explicit[note_id] = frozenset()
        else:
            tags_by_id[note_id] = note.tags
            explicit[note_id] = frozenset(tag.casefold() for tag in note.explicit_tags)
    note_store_module.get_cached_content = lambda note_id: corpus.notes[note_id].content_html
    note_store_module.get_cached_tags = lambda note_id: tags_by_id[note_id]
    note_store_module.get_cached_proposed_tags = lambda note_id: ""
    note_store_module.get_cached_text = lambda note_id: corpus.notes[note_id].plain_text
    note_store_module.get_ontology = lambda: ontology
    tag_suggestions_module.get_ontology = lambda: ontology
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=_rows(corpus))
    return ontology, explicit


def baseline_suggestions(*, corpus: Corpus, case: TagCase) -> list[str]:
    """Today's tag-bar ranking for this moment, casefolded, as the browser would ask for it."""
    note = corpus.notes[case.note_id]
    bar, explicit = _bar_as_sent(corpus=corpus, case=case)
    suggestions = tag_suggestions_module.suggest_tags_for_note(
        note_id=case.note_id,
        anchors=bar,
        explicit_tags=explicit,
        prefix=case.prefix,
        content_html=note.content_html,
        limit=MAX_TAG_SUGGESTIONS,
    )
    return [suggestion.casefold() for suggestion in suggestions]


def _bar_as_sent(*, corpus: Corpus, case: TagCase) -> tuple[list[str], list[str]]:
    """The tag bar's tags (anchors) and, with what is typed as its last token, its explicit tags."""
    bar = list(corpus.notes[case.note_id].meta_tags) + list(case.present)
    explicit = list(bar)
    if case.prefix != "":
        explicit.append(case.prefix)
    return bar, explicit


def narrowing_suggestions(*, corpus: Corpus, case: TagCase) -> list[str]:
    """The single rule: at any length, what is typed narrows the empty-bar list. MetaList's
    ranking since October 21, 2026 (before, only after one letter)."""
    assert case.prefix != "" and not case.prefix.startswith("@")
    bar, explicit = _bar_as_sent(corpus=corpus, case=case)
    ranked = tag_suggestions_module._suggest_while_typing(
        note_id=case.note_id,
        anchors=bar,
        explicit_tags=explicit,
        prefix=case.prefix,
        content_html=corpus.notes[case.note_id].content_html,
        limit=MAX_TAG_SUGGESTIONS,
    )
    return [suggestion.casefold() for suggestion in ranked.tags]


# How deep the empty-bar list goes before the prefix filter (kept-order variant).
KEPT_ORDER_DEPTH = 300


def baseline_kept_order(*, corpus: Corpus, case: TagCase) -> list[str]:
    """Variant of today's ranking: after a letter is typed, keep the empty-bar order and filter it by the prefix."""
    assert case.moment == FIRST_LETTER
    note = corpus.notes[case.note_id]
    bar = list(note.meta_tags) + list(case.present)
    suggestions = tag_suggestions_module.suggest_tags_for_note(
        note_id=case.note_id,
        anchors=bar,
        explicit_tags=list(bar),
        prefix="",
        content_html=note.content_html,
        limit=KEPT_ORDER_DEPTH,
    )
    return [suggestion.casefold() for suggestion in suggestions
            if tag_term_matches_prefix(term=suggestion, prefix=case.prefix)][:MAX_TAG_SUGGESTIONS]


def _rows(corpus: Corpus) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for child_ids in corpus.children.values():
        for index, note_id in enumerate(child_ids):
            prev_id = None
            next_id = None
            if index > 0:
                prev_id = child_ids[index - 1]
            if index + 1 < len(child_ids):
                next_id = child_ids[index + 1]
            note = corpus.notes[note_id]
            rows.append({"id": note_id, "parent_id": note.parent_id, "prev_id": prev_id, "next_id": next_id,
                         "is_collapsed": 0, "created_at": note.created_at, "updated_at": note.created_at})
    return rows
