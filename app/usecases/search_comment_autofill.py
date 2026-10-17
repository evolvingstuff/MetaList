from __future__ import annotations

from typing import Optional, Sequence

from app.services.search_query import parse_search_query
from app.services.content_formatting import list_known_meta_tag_terms
from app.services.search_index import extract_tags_for_search, search_index
from app.services.search_text import build_searchable_text_casefold, text_term_matches
from app.services.store import store
from app.services.tag_case import (
    build_preferred_tag_case_map,
    dedupe_tag_terms_by_casefold,
    prefer_existing_tag_case,
)

_FIRST_PRINTABLE_ASCII = ord(" ")
_LAST_PRINTABLE_ASCII = ord("~")


def _is_ascii_printable(text: str) -> bool:
    return all(_FIRST_PRINTABLE_ASCII <= ord(ch) <= _LAST_PRINTABLE_ASCII for ch in text)


def _dedupe_preserve_order(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output


def _build_comment_tokens(required_text_terms: Sequence[str]) -> str:
    tokens: list[str] = []
    for term in _dedupe_preserve_order(required_text_terms):
        if not isinstance(term, str):
            raise TypeError(f"search term must be a string, got {type(term)}")
        if not _is_ascii_printable(term):
            continue
        if "/*" in term or "*/" in term:
            continue
        # The words only: a comment matches the term's word boundaries by itself.
        tokens.append(f"/*{term.strip()}*/")
    return " ".join(tokens)


def _extract_positive_text_terms(search_query: Optional[str]) -> tuple[str, ...]:
    if search_query is None:
        return ()
    if not isinstance(search_query, str):
        raise TypeError(f"search_query must be a string or None, got {type(search_query)}")
    if search_query.strip() == "":
        return ()
    parsed = parse_search_query(search_query)
    return parsed.first_clause.required_text


def _extract_positive_tag_terms(search_query: Optional[str]) -> tuple[str, ...]:
    if search_query is None:
        return ()
    if not isinstance(search_query, str):
        raise TypeError(f"search_query must be a string or None, got {type(search_query)}")
    if search_query.strip() == "":
        return ()
    parsed = parse_search_query(search_query)
    first_clause = parsed.first_clause
    if not first_clause.required_tags:
        return ()
    preferred_by_casefold = build_preferred_tag_case_map(search_index.list_tag_frequencies())
    preferred_terms = [
        prefer_existing_tag_case(term, preferred_by_casefold)
        for term in sorted(first_clause.required_tags)
    ]
    return tuple(dedupe_tag_terms_by_casefold(preferred_terms))


def compute_initial_tags_for_new_note(
    *,
    parent_id: Optional[str],
    search_query: Optional[str],
) -> str:
    required_tag_terms = _extract_positive_tag_terms(search_query)
    required_text_terms = _extract_positive_text_terms(search_query)

    if parent_id is not None and required_tag_terms:
        meta_terms = list_known_meta_tag_terms()
        required_tag_terms = tuple(
            term for term in required_tag_terms if term.casefold() not in meta_terms
        )

    if not required_tag_terms and not required_text_terms:
        return ""

    filtered_tag_terms = required_tag_terms
    if parent_id is not None and required_tag_terms:
        inherited_non_meta_casefold: set[str] = set()
        current_id = parent_id
        while current_id is not None:
            ancestor = store.get(current_id)
            for term in extract_tags_for_search(ancestor.tags):
                if term.startswith("@"):
                    continue
                inherited_non_meta_casefold.add(term.casefold())
            current_id = ancestor.parent_id

        filtered_tag_terms = tuple(
            term
            for term in required_tag_terms
            if term.startswith("@") or term.casefold() not in inherited_non_meta_casefold
        )

    tags_tokens: list[str] = []
    tags_tokens.extend(filtered_tag_terms)

    if required_text_terms and parent_id is None:
        tags_tokens.append(_build_comment_tokens(required_text_terms))
        return " ".join(tags_tokens)

    if not required_text_terms:
        return " ".join(tags_tokens)

    current_id = parent_id
    while current_id is not None:
        ancestor = store.get(current_id)
        ancestor_text = build_searchable_text_casefold(ancestor.content, ancestor.tags)
        if all(text_term_matches(term, ancestor_text) for term in required_text_terms):
            return " ".join(tags_tokens)
        current_id = ancestor.parent_id

    tags_tokens.append(_build_comment_tokens(required_text_terms))
    return " ".join(tags_tokens)
