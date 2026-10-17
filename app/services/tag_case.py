from __future__ import annotations

from collections.abc import Mapping


def build_preferred_tag_case_map(exact_tag_counts: Mapping[str, int]) -> dict[str, str]:
    preferred: dict[str, str] = {}
    for term, count in exact_tag_counts.items():
        if not isinstance(term, str):
            raise TypeError(f"tag term must be a string, got {type(term)}")
        if not isinstance(count, int):
            raise TypeError(f"tag count must be an int, got {type(count)}")
        if term == "" or term.startswith("@"):
            continue
        term_casefold = term.casefold()
        if term_casefold not in preferred:
            preferred[term_casefold] = term
            continue
        current = preferred[term_casefold]
        current_count = exact_tag_counts[current]
        if count > current_count:
            preferred[term_casefold] = term
            continue
        if count < current_count:
            continue
        if _case_variant_tiebreak(term) < _case_variant_tiebreak(current):
            preferred[term_casefold] = term
    return preferred


def prefer_existing_tag_case(term: str, preferred_by_casefold: Mapping[str, str]) -> str:
    if not isinstance(term, str):
        raise TypeError(f"tag term must be a string, got {type(term)}")
    # A term no existing tag spells keeps its own case.
    if term.casefold() not in preferred_by_casefold:
        return term
    return preferred_by_casefold[term.casefold()]


def dedupe_tag_terms_by_casefold(terms: list[str]) -> list[str]:
    seen_casefold: set[str] = set()
    output: list[str] = []
    for term in terms:
        if not isinstance(term, str):
            raise TypeError(f"tag term must be a string, got {type(term)}")
        term_casefold = term.casefold()
        if term_casefold in seen_casefold:
            continue
        seen_casefold.add(term_casefold)
        output.append(term)
    return output


def _case_variant_tiebreak(term: str) -> tuple[int, str]:
    lower_case_penalty = 0
    if term != term.casefold():
        lower_case_penalty = 1
    return (lower_case_penalty, term)
