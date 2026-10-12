"""About a tag already in a note's tag bar or in the search box (shown on right-click).

Facts about the tag, not reasons it was suggested: it may have been typed, never
suggested. They use the same matching and words as suggestion reasons
(`tag_suggestion_reasons`), looked up when the tag is right-clicked
(docs/ui/tag-bar.md, docs/ui/controls.md).
"""

from __future__ import annotations

from datetime import date
from typing import FrozenSet, Iterable, List, Tuple

from app.services.note_store import store as note_store
from app.services.ontology_rules_store import get_ontology
from app.services.search_history import count_recent_tag_activity
from app.services.search_index import extract_ordered_tags_for_search
from app.services.search_index import search_index
from app.services.search_query import parse_search_query
from app.services.tag_ontology import TagOntology
from app.services.tag_suggestion_reasons import AppliesThrough
from app.services.tag_suggestion_reasons import cooccurrence_phrase
from app.services.tag_suggestion_reasons import count_notes
from app.services.tag_suggestion_reasons import count_times
from app.services.tag_suggestion_reasons import named_line
from app.services.tag_suggestion_reasons import quoted
from app.services.tag_suggestion_reasons import usage_line
from app.services.tag_suggestions import match_tag_in_note_text

# Relationship lines name at most this many tags, then say how many more.
_NAMED_TAG_LIMIT = 3


def describe_tag_bar_tag(*, note_id: str, tag: str, tags_text: str, content_html: str) -> Tuple[str, ...]:
    """About a tag in a note's tag bar: what the note says, what it goes with, how it applies, its use."""
    if not isinstance(note_id, str) or note_id == "":
        raise ValueError("note_id must be a non-empty string")
    _require_tag(tag)
    if tag.startswith("@"):
        return ("A built-in tag", _meta_usage(tag))
    ontology = get_ontology()
    spelling = _ontology_spelling(ontology, tag)
    other_tags = [
        written for written in extract_ordered_tags_for_search(tags_text)
        if not written.startswith("@") and written.casefold() != tag.casefold()
    ]
    inherited = note_store.get_inherited_non_meta_tag_terms(note_id)
    lines: List[str] = []
    match = match_tag_in_note_text(term=spelling, content_html=content_html, ontology=ontology)
    if match is not None:
        lines.append(named_line(match=match, shown=tag, where="this note"))
    anchors = tuple(dict.fromkeys(
        anchor for anchor in [*other_tags, *sorted(inherited, key=str.casefold)]
        if anchor.casefold() != tag.casefold()
    ))
    # Other notes only: this note having its own tags says nothing.
    cooccurrences = search_index.describe_tag_cooccurrence(
        anchors=anchors, terms=[tag], excluded_note_ids=frozenset({note_id}),
    )
    if tag in cooccurrences:
        lines.append(_sentence(cooccurrence_phrase(
            cooccurrences[tag], anchors, "this note's tags", is_other_notes=True,
        )))
    applies = AppliesThrough.build(
        inherited_non_meta=inherited, base_tags=frozenset(other_tags) | inherited, ontology=ontology,
    )
    lines.extend(applies.lines(tag, lead="Also "))
    lines.extend(_relationship_lines(ontology=ontology, spelling=spelling))
    lines.append(_tag_bar_usage(note_id=note_id, tag=tag))
    return tuple(dict.fromkeys(lines))


def describe_search_tag(
    *, query: str, tag: str, start: int, end: int, is_excluded: bool,
    window_days: Tuple[int, ...], token: str, today: date,
) -> Tuple[str, ...]:
    """About a tag in the search box: what it finds, what it goes with or removes, what it also finds, your use."""
    _require_tag(tag)
    if not 0 <= start < end <= len(query):
        raise ValueError("The tag's position must lie within the search")
    rest = (query[:start] + " " + query[end:]).strip()
    lines: List[str] = []
    if tag.startswith("@"):
        lines.append("A built-in tag")
    note_count = search_index.count_notes_with_tag(tag)
    if is_excluded:
        found, removed = search_index.count_tag_within_search(term=tag, search=rest)
        lines.append(_exclusion_line(found=found, removed=removed, has_rest=rest != ""))
    elif note_count == 0:
        lines.append("No note has this tag")
    else:
        lines.append(f"Searching for it finds {count_notes(note_count)}")
        anchors = _other_required_tags(rest=rest, tag=tag)
        cooccurrences = search_index.describe_tag_cooccurrence(
            anchors=anchors, terms=[tag], excluded_note_ids=frozenset(),
        )
        if tag in cooccurrences:
            lines.append(_sentence(cooccurrence_phrase(
                cooccurrences[tag], anchors, "the tags in your search", is_other_notes=False,
            )))
    if not tag.startswith("@"):
        lines.extend(_also_finds_lines(ontology=get_ontology(), tag=tag))
    windows = count_recent_tag_activity(tag=tag, window_days=window_days, token=token, today=today)
    if windows:
        when = "today"
        if windows[0].window_days > 1:
            when = f"in the last {windows[0].window_days} days"
        lines.append(f"You've worked with it {count_times(windows[0].activity_count)} {when}")
    return tuple(dict.fromkeys(lines))


def _require_tag(tag: str) -> None:
    if not isinstance(tag, str) or tag.strip() == "":
        raise ValueError("tag must be a non-empty string")


def _sentence(phrase: str) -> str:
    return phrase[0].upper() + phrase[1:]


def _ontology_spelling(ontology: TagOntology, tag: str) -> str:
    """The tag as the tag relationships spell it (they are case-sensitive), else as written."""
    for mapping in (ontology.scc_members_by_tag, ontology.implication_closure, ontology.implied_by_closure):
        if tag in mapping:
            return tag
    for mapping in (ontology.scc_members_by_tag, ontology.implication_closure, ontology.implied_by_closure):
        for known in sorted(mapping, key=lambda name: (name.casefold(), name)):
            if known.casefold() == tag.casefold():
                return known
    return tag


def _synonyms(ontology: TagOntology, spelling: str) -> List[str]:
    if spelling not in ontology.scc_members_by_tag:
        return []
    return [member for member in ontology.scc_members_by_tag[spelling] if member.casefold() != spelling.casefold()]


def _names_limited(names: Iterable[str], *, conjunction: str) -> str:
    ordered = [quoted(name) for name in sorted(set(names), key=lambda name: (name.casefold(), name))]
    assert ordered
    if len(ordered) > _NAMED_TAG_LIMIT:
        shown = ordered[:_NAMED_TAG_LIMIT]
        return f"{', '.join(shown)} {conjunction} {len(ordered) - _NAMED_TAG_LIMIT} more"
    if len(ordered) == 1:
        return ordered[0]
    return f"{', '.join(ordered[:-1])} {conjunction} {ordered[-1]}"


def _relationship_lines(*, ontology: TagOntology, spelling: str) -> List[str]:
    """Synonyms and the tags it implies, from the tag relationships."""
    lines: List[str] = []
    synonyms = _synonyms(ontology, spelling)
    if synonyms:
        lines.append(f"A synonym of {_names_limited(synonyms, conjunction='and')}")
    if spelling in ontology.implication_closure:
        equal = {spelling.casefold(), *(synonym.casefold() for synonym in synonyms)}
        implied = [name for name in ontology.implication_closure[spelling] if name.casefold() not in equal]
        if implied:
            lines.append(f"Implies {_names_limited(implied, conjunction='and')}")
    return lines


def _also_finds_lines(*, ontology: TagOntology, tag: str) -> List[str]:
    """Search matches effective tags: synonyms, and tags that imply it, find notes too."""
    spelling = _ontology_spelling(ontology, tag)
    synonyms = _synonyms(ontology, spelling)
    lines: List[str] = []
    if synonyms:
        lines.append(f"Also finds notes tagged {_names_limited(synonyms, conjunction='or')}")
    if spelling in ontology.implied_by_closure:
        equal = {spelling.casefold(), *(synonym.casefold() for synonym in synonyms)}
        implying = [name for name in ontology.implied_by_closure[spelling] if name.casefold() not in equal]
        if implying:
            verb = "implies"
            if len(implying) > 1:
                verb = "imply"
            lines.append(f"Also finds notes tagged {_names_limited(implying, conjunction='or')}, which {verb} it")
    return lines


def _other_required_tags(*, rest: str, tag: str) -> Tuple[str, ...]:
    """The other tags the search requires with it (none when it has `OR` clauses)."""
    if rest == "":
        return ()
    parsed = parse_search_query(rest)
    if len(parsed.clauses) != 1:
        return ()
    return tuple(
        required for required in parsed.clauses[0].required_tags
        if not required.startswith("@") and required.casefold() != tag.casefold()
    )


def _exclusion_line(*, found: int, removed: int, has_rest: bool) -> str:
    of_notes = f"of your {found:,} notes"
    if has_rest:
        of_notes = f"of the {found:,} notes the rest of your search finds"
    if removed == 0:
        return f"Leaving it out removes none {of_notes}"
    return f"Leaving it out removes {removed:,} {of_notes}"


def _meta_usage(tag: str) -> str:
    count = search_index.count_notes_with_tag(tag)
    if count == 0:
        return "Not on any note yet"
    return usage_line(count)


def _tag_bar_usage(*, note_id: str, tag: str) -> str:
    """How many saved notes have it written; a tag only this note has may be a typo or a one-off."""
    count = sum(
        notes for written, notes in search_index.list_explicit_tag_frequencies().items()
        if written.casefold() == tag.casefold()
    )
    saved_here: FrozenSet[str] = frozenset()
    if note_store.has_note(note_id):
        saved_here = frozenset(written.casefold() for written in note_store.get_note(note_id).non_meta_tag_terms)
    if count == 0:
        return "Not on any saved note yet"
    if count == 1 and tag.casefold() in saved_here:
        return "Only on this note"
    return usage_line(count)
