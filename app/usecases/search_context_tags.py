from __future__ import annotations

from app.services.search_index import extract_tags_for_search, search_index
from app.services.search_query import parse_search_query
from app.services.tag_properties import PROPERTY_SEPARATOR, PropertyCondition
from app.services.search_text import build_searchable_text_casefold, text_term_matches
from app.services.store import store
from app.services.tag_case import (
    build_preferred_tag_case_map,
    dedupe_tag_terms_by_casefold,
    prefer_existing_tag_case,
)


def compute_inherited_non_meta_tag_terms(parent_id: str | None) -> set[str]:
    inherited: set[str] = set()
    current_id = parent_id
    while current_id is not None:
        ancestor = store.get(current_id)
        for term in extract_tags_for_search(ancestor.tags):
            if term.startswith("@"):  # meta tags do not inherit
                continue
            inherited.add(term)
        current_id = ancestor.parent_id
    return inherited


def ensure_tags_match_search_query(
    *,
    parent_id: str | None,
    content: str,
    tags: str,
    search_query: str,
) -> str:
    if not isinstance(content, str):
        raise TypeError(f"content must be a string, got {type(content)}")
    if not isinstance(tags, str):
        raise TypeError(f"tags must be a string, got {type(tags)}")
    if not isinstance(search_query, str):
        raise TypeError(f"search_query must be a string, got {type(search_query)}")

    parsed = parse_search_query(search_query)
    first_clause = parsed.first_clause
    if not first_clause.required_tags and not first_clause.required_text and not first_clause.required_properties:
        return tags

    inherited_non_meta = compute_inherited_non_meta_tag_terms(parent_id)
    explicit_terms = extract_tags_for_search(tags)
    inherited_non_meta_casefold = {term.casefold() for term in inherited_non_meta}
    explicit_terms_casefold = {term.casefold() for term in explicit_terms}
    preferred_by_casefold = build_preferred_tag_case_map(search_index.list_tag_frequencies())

    additions: list[str] = []
    required_tag_terms = dedupe_tag_terms_by_casefold(
        [
            prefer_existing_tag_case(term, preferred_by_casefold)
            for term in sorted(first_clause.required_tags)
        ]
    )
    for term in required_tag_terms:
        if term.startswith("@"):
            if term.casefold() in explicit_terms_casefold:
                continue
            additions.append(term)
            continue
        if term.casefold() in inherited_non_meta_casefold or term.casefold() in explicit_terms_casefold:
            continue
        if any(term.casefold() == condition.tag.casefold() for condition in first_clause.required_properties):
            continue  # added below, with its values
        additions.append(term)
    additions += _property_tag_tokens(
        first_clause.required_properties,
        present_casefold=explicit_terms_casefold | inherited_non_meta_casefold,
        preferred_by_casefold=preferred_by_casefold,
    )

    next_tags = tags.strip()
    if additions:
        if next_tags == "":
            next_tags = " ".join(additions)
        else:
            next_tags = f"{next_tags} {' '.join(additions)}"

    if not first_clause.required_text:
        return next_tags

    searchable = build_searchable_text_casefold(content, next_tags)
    missing_phrases: list[str] = []
    for phrase in first_clause.required_text:
        if text_term_matches(phrase, searchable):
            continue
        missing_phrases.append(phrase)

    if not missing_phrases:
        return next_tags

    comment_tokens: list[str] = []
    for phrase in missing_phrases:
        if not isinstance(phrase, str):
            raise TypeError(f"search phrase must be a string, got {type(phrase)}")
        if "/*" in phrase or "*/" in phrase:
            continue
        # The words only: a comment matches the term's word boundaries by itself.
        comment_tokens.append(f"/*{phrase.strip()}*/")

    if not comment_tokens:
        return next_tags

    suffix = " ".join(comment_tokens)
    if next_tags == "":
        return suffix
    return f"{next_tags} {suffix}"


def _property_tag_tokens(
    conditions: tuple[PropertyCondition, ...], *, present_casefold: set[str],
    preferred_by_casefold: dict[str, str],
) -> list[str]:
    """What a note added in a property search carries (docs/design/tag-properties.md): the
    tag of each property term, with the values its = terms name (jogging:miles=3 adds
    jogging:miles=3). Other comparisons name no value, so they add the tag alone."""
    values_by_tag: dict[str, list[str]] = {}
    spelling_by_tag: dict[str, str] = {}
    for condition in conditions:
        key = condition.tag.casefold()
        if key not in values_by_tag:
            values_by_tag[key] = []
            spelling_by_tag[key] = prefer_existing_tag_case(condition.tag, preferred_by_casefold)
        # MAX and MIN pick among notes; they are no value to give one.
        if condition.operator == "=" and not condition.is_extreme:
            values_by_tag[key].append(f"{condition.name}={condition.value_text}")
    tokens: list[str] = []
    for key, values in values_by_tag.items():
        if values:
            tokens.append(PROPERTY_SEPARATOR.join([spelling_by_tag[key], *values]))
        elif key not in present_casefold:
            tokens.append(spelling_by_tag[key])
    return tokens


__all__ = ["compute_inherited_non_meta_tag_terms", "ensure_tags_match_search_query"]
