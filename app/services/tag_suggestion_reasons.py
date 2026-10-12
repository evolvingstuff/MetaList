"""Why a tag is suggested, in the tag bar or the search bar: short reasons shown on right-click.

The facts come from the rankings (`tag_suggestions` for the tag bar: what the
note's text names, which of its tags the tag goes with, which notes share its
tags; the search index and search history for the search bar): the reasons say
what the ranking used, never a second guess at it. Only the shown suggestions
are explained (docs/ui/tag-bar.md, docs/ui/controls.md).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, FrozenSet, Iterable, List, Mapping, Tuple

from app.services.search_index import SearchIndex
from app.services.search_index import SearchSuggestionFacts
from app.services.search_index import TagCooccurrence
from app.services.tag_ontology import TagOntology
from app.services.tag_term_matching import TagContentMatch
from app.services.tag_term_matching import quote_content_match

NOTHING_POINTS_TO_IT = "Nothing in this note points to it"


@dataclass(frozen=True, slots=True)
class TagSuggestion:
    tag: str
    reasons: Tuple[str, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.tag, str) or self.tag == "":
            raise ValueError("A tag suggestion needs a tag")
        if not isinstance(self.reasons, tuple) or not self.reasons:
            raise ValueError(f"Tag suggestion {self.tag!r} needs at least one reason")
        for reason in self.reasons:
            if not isinstance(reason, str) or reason.strip() == "":
                raise ValueError(f"Tag suggestion {self.tag!r} has an empty reason")


@dataclass(frozen=True)
class ContextOverlap:
    """Other notes that share the most of this note's tags and have the term written on them."""

    shared_count: int
    note_count: int
    # The shared tags (casefolded) of those notes; a second set means they differ.
    shared_casefold_sets: Tuple[FrozenSet[str], ...]

    def __post_init__(self) -> None:
        assert self.shared_count > 0 and self.note_count > 0
        assert 1 <= len(self.shared_casefold_sets) <= 2
        assert all(len(shared) == self.shared_count for shared in self.shared_casefold_sets)


def _quoted(text: str) -> str:
    return f'"{text}"'


def _join_names(names: Iterable[str]) -> str:
    quoted = [_quoted(name) for name in sorted(names, key=lambda name: (name.casefold(), name))]
    assert quoted
    if len(quoted) == 1:
        return quoted[0]
    return ", ".join(quoted[:-1]) + " and " + quoted[-1]


def _count_notes(count: int) -> str:
    assert count > 0
    if count == 1:
        return "1 note"
    return f"{count:,} notes"


def _usage_line(count: int) -> str:
    assert count > 0
    return f"You've tagged {_count_notes(count)} with it"


def _names_for(casefold_names: FrozenSet[str], display_by_casefold: Mapping[str, str]) -> List[str]:
    for name in casefold_names:
        assert name in display_by_casefold, name
    return [display_by_casefold[name] for name in casefold_names]


def _cooccurrence_phrase(cooccurrence: TagCooccurrence, anchors: Iterable[str], anchors_name: str) -> str:
    """`on 4 notes together with "python"`, naming the anchors those notes carry
    (or how many of them, `anchors_name` saying whose they are)."""
    notes = _count_notes(cooccurrence.note_count)
    if len(cooccurrence.anchor_sets) > 1:
        return f"on {notes} together with {cooccurrence.anchor_count} of {anchors_name}"
    display_by_casefold = {anchor.casefold(): anchor for anchor in anchors}
    (anchor_set,) = cooccurrence.anchor_sets
    return f"on {notes} together with {_join_names(_names_for(anchor_set, display_by_casefold))}"


def _count_times(count: int) -> str:
    assert count > 0
    if count == 1:
        return "once"
    if count == 2:
        return "twice"
    return f"{count:,} times"


@dataclass(frozen=True)
class ReasonWriter:
    """Reasons any suggestion can have: whether it already applies, and its use."""

    count_by_casefold: Mapping[str, int]
    ontology_only_casefold: FrozenSet[str]
    inherited_casefold: FrozenSet[str]
    implied_casefold: FrozenSet[str]
    base_tags: FrozenSet[str]
    ontology: TagOntology

    @classmethod
    def build(
        cls, *, exact_tag_counts: Mapping[str, int], ontology_only_casefold: FrozenSet[str],
        inherited_non_meta: FrozenSet[str], base_tags: FrozenSet[str], ontology: TagOntology,
    ) -> ReasonWriter:
        count_by_casefold: Dict[str, int] = {}
        for term, count in exact_tag_counts.items():
            assert term.casefold() not in count_by_casefold, f"case variants are merged before counting: {term}"
            count_by_casefold[term.casefold()] = count
        base_casefold = frozenset(tag.casefold() for tag in base_tags)
        implied_casefold: FrozenSet[str] = frozenset()
        if not ontology.is_empty:
            implied_casefold = frozenset(
                tag.casefold() for tag in ontology.infer_implication_only(base_tags=base_tags)
            ) - base_casefold
        return cls(
            count_by_casefold=count_by_casefold, ontology_only_casefold=ontology_only_casefold,
            inherited_casefold=frozenset(tag.casefold() for tag in inherited_non_meta),
            implied_casefold=implied_casefold, base_tags=base_tags, ontology=ontology,
        )

    def already_applies(self, term: str) -> Tuple[str, ...]:
        term_casefold = term.casefold()
        if term_casefold in self.inherited_casefold:
            return ("Already applies: inherited from a parent note",)
        if term_casefold not in self.implied_casefold:
            return ()
        for base in sorted(self.base_tags, key=lambda tag: (tag.casefold(), tag)):
            implied = self.ontology.infer_implication_only(base_tags=frozenset({base}))
            if term_casefold in {tag.casefold() for tag in implied}:
                return (f"Already applies: implied by {_quoted(base)}",)
        # Implied only by several of the note's tags together.
        return ("Already applies: implied by this note's tags",)

    def usage(self, term: str) -> str:
        term_casefold = term.casefold()
        if term_casefold in self.count_by_casefold and self.count_by_casefold[term_casefold] > 0:
            return _usage_line(self.count_by_casefold[term_casefold])
        assert term_casefold in self.ontology_only_casefold, f"suggested tag {term!r} is on no note"
        return "Not on any note yet; it is in your tag relationships"

    def without_evidence(self, term: str) -> Tuple[str, ...]:
        """A tag listed for its use (or because it already applies), not for this note."""
        already = self.already_applies(term)
        if already:
            return (*already, self.usage(term))
        return (NOTHING_POINTS_TO_IT, self.usage(term))


def meta_tag_reasons(*, index: SearchIndex, term: str, prefix: str) -> Tuple[str, ...]:
    """Meta tags are listed by use once `@` is typed."""
    assert term.startswith("@") and prefix.startswith("@"), (term, prefix)
    count = index.count_notes_with_tag(term)
    usage = "Not on any note yet"
    if count > 0:
        usage = _usage_line(count)
    return (f"A built-in tag starting with {_quoted(prefix)}", usage)


@dataclass(frozen=True)
class SuggestionEvidence:
    """What one ranking found for its terms, to say why a shown tag is suggested."""

    # The index the ranking used, for the co-occurring notes behind a reason.
    index: SearchIndex
    writer: ReasonWriter
    prefix: str
    content_matches: Mapping[str, TagContentMatch]
    # Terms whose content match is the rest of the tag after the typed prefix.
    prefix_remainder_terms: FrozenSet[str]
    # Synonym named exactly in the content -> (the tag it is a synonym of, its match).
    synonym_matches: Mapping[str, Tuple[str, TagContentMatch]]
    cooccurrence_terms: FrozenSet[str]
    cooccurrence_anchors: Tuple[str, ...]
    saved_text_matches: Mapping[str, TagContentMatch]
    overlaps: Mapping[str, ContextOverlap]
    context_tags: FrozenSet[str]
    # Shown tag -> the ranked terms it stands for (equivalent tags are shown once).
    sources: Mapping[str, Tuple[str, ...]]

    def reasons_for(self, tag: str) -> Tuple[str, ...]:
        assert tag in self.sources, f"{tag!r} was not ranked"
        subjects = [tag] + [term for term in self.sources[tag] if term != tag]
        cooccurrences = self.index.describe_tag_cooccurrence(
            anchors=self.cooccurrence_anchors,
            terms=[subject for subject in subjects if subject in self.cooccurrence_terms],
        )
        lines: List[str] = []
        for subject in subjects:
            lines.extend(self._evidence(subject=subject, shown=tag, cooccurrences=cooccurrences))
        lines.extend(self.writer.already_applies(tag))
        if not lines:
            lines.append(NOTHING_POINTS_TO_IT)
        lines.append(self.writer.usage(tag))
        return tuple(dict.fromkeys(lines))

    def _evidence(self, *, subject: str, shown: str, cooccurrences: Mapping[str, TagCooccurrence]) -> List[str]:
        lines: List[str] = []
        if subject in self.synonym_matches:
            representative, match = self.synonym_matches[subject]
            lines.append(self._named(match=match, shown=shown, where="this note", is_remainder=False))
            lines.append(f"A synonym of {_quoted(representative)}")
        elif subject in self.content_matches:
            lines.append(self._named(
                match=self.content_matches[subject], shown=shown, where="this note",
                is_remainder=subject in self.prefix_remainder_terms,
            ))
        if subject in self.cooccurrence_terms:
            assert subject in cooccurrences, f"{subject!r} was ranked as co-occurring"
            lines.append(self._about(subject, shown, self._cooccurrence(cooccurrences[subject])))
        if subject in self.saved_text_matches and subject not in self.content_matches:
            lines.append(self._named(
                match=self.saved_text_matches[subject], shown=shown, where="this note as last saved",
                is_remainder=False,
            ))
        if subject in self.overlaps and subject not in self.cooccurrence_terms:
            overlap = self._overlap(subject=subject, overlap=self.overlaps[subject])
            if overlap != "":
                lines.append(self._about(subject, shown, overlap))
        return lines

    def _named(self, *, match: TagContentMatch, shown: str, where: str, is_remainder: bool) -> str:
        quoted = ", ".join(_quoted(words) for words in quote_content_match(match))
        # Whole only when every part of the tag was found (`topic-41` is partly named by "topic").
        is_whole = len(match.evidence_raw_indexes) == match.raw_segment_count
        if is_remainder:
            return f"The rest of it after {_quoted(self.prefix)} is in {where}: {quoted}"
        if match.term.casefold() == shown.casefold():
            if is_whole:
                return f"Named in {where}: {quoted}"
            return f"Partly named in {where}: {quoted}"
        where_capitalized = where[0].upper() + where[1:]
        if is_whole:
            return f"{where_capitalized} names its synonym {_quoted(match.term)}"
        return f"{where_capitalized} partly names its synonym {_quoted(match.term)}: {quoted}"

    def _cooccurrence(self, cooccurrence: TagCooccurrence) -> str:
        return _cooccurrence_phrase(cooccurrence, self.cooccurrence_anchors, "this note's tags")

    def _overlap(self, *, subject: str, overlap: ContextOverlap) -> str:
        """Empty when the only tag shared is the term itself (a tag that already
        applies, ranked when that setting is on): notes with it have it."""
        notes = _count_notes(overlap.note_count)
        # The term itself is no evidence for itself.
        shared_sets = [shared - {subject.casefold()} for shared in overlap.shared_casefold_sets]
        if any(not shared for shared in shared_sets):
            return ""
        if len(shared_sets) > 1:
            shared_count = min(len(shared) for shared in shared_sets)
            return f"on {notes} sharing {shared_count} of this note's tags"
        display_by_casefold = {tag.casefold(): tag for tag in self.context_tags}
        names = _join_names(_names_for(shared_sets[0], display_by_casefold))
        verb = "share"
        if overlap.note_count == 1:
            verb = "shares"
        return f"on {notes} that {verb} {names} with this one"

    @staticmethod
    def _about(subject: str, shown: str, finding: str) -> str:
        """A finding about the shown tag, or about a synonym it is shown in place of."""
        if subject == shown:
            return finding[0].upper() + finding[1:]
        return f"Its synonym {_quoted(subject)} is {finding}"


def search_suggestion_reasons(
    *, facts: SearchSuggestionFacts, term: str, recent_activity: Mapping[str, Tuple[int, int]],
) -> Tuple[str, ...]:
    """Why the search bar suggests a tag.

    recent_activity: casefolded tag -> (window days, activity credits) for the
    tags a personalization window put first.
    """
    assert term in facts.note_counts, f"{term!r} was not described"
    lines: List[str] = []
    if term.casefold() in recent_activity:
        window_days, activity_count = recent_activity[term.casefold()]
        when = "today"
        if window_days > 1:
            when = f"in the last {window_days} days"
        lines.append(f"You've worked with it {_count_times(activity_count)} {when}")
    note_count = facts.note_counts[term]
    if facts.partial_prefix.startswith("@"):
        lines.append(f"A built-in tag starting with {_quoted(facts.partial_prefix)}")
        if note_count == 0:
            lines.append("Not on any note yet")
            return tuple(lines)
        lines.append(f"Searching for it finds {_count_notes(note_count)}")
        return tuple(lines)
    if facts.is_exclusion:
        lines.append(_exclusion_line(facts=facts, term=term))
    elif term in facts.cooccurrences:
        finding = _cooccurrence_phrase(facts.cooccurrences[term], facts.anchors, "the tags in your search")
        lines.append(finding[0].upper() + finding[1:])
    elif facts.has_completed_clause:
        lines.append(f"Your search so far finds it on {_count_notes(facts.matching_counts[term])}")
    else:
        lines.append("Tags are listed by how many notes have them")
    assert note_count > 0, f"suggested search tag {term!r} is on no note"
    lines.append(f"Searching for it finds {_count_notes(note_count)}")
    return tuple(lines)


def _exclusion_line(*, facts: SearchSuggestionFacts, term: str) -> str:
    removed = facts.matching_counts[term]
    of_notes = f"of your {facts.matching_note_count:,} notes"
    if facts.has_completed_clause:
        of_notes = f"of the {facts.matching_note_count:,} notes your search finds"
    if removed == 0:
        return f"Leaving it out removes none {of_notes}"
    return f"Leaving it out removes {removed:,} {of_notes}"
