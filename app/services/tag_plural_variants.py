"""Singular and plural spellings of a tag (egg and eggs), so suggestions leave out
another spelling of a tag the note already has (docs/ui/tag-bar.md, "Tag Suggestions").

Two tags are spellings of each other when they are the same apart from one word that
one has singular and the other plural: `egg`/`eggs`, `easter-egg`/`easter-eggs`,
`berry`/`Berries`. Plurals are generated from each word (never guessed back to a
singular, which cannot tell `ties` from `berries`), so a match is always a real
pluralisation of one of the two. Words with digits or other characters (`1990s`,
`abc=xyz`) and words shorter than three letters have no plural spellings."""

from __future__ import annotations

import re
from typing import Iterable

from app.config import TAG_SUGGESTION_CONNECTORS
from app.security.sensitive_cache import sensitive_lru_cache
from app.services.resource_limits import SENSITIVE_MEMO_BYTES

_CONNECTOR_RUN = re.compile(f"([{re.escape(TAG_SUGGESTION_CONNECTORS)}]+)")
_WORD = re.compile(r"[a-z]+")
# Shorter words (`ai`, `os`, `ui`) are usually abbreviations, not nouns with plurals.
_MIN_REGULAR_WORD_LENGTH = 3
# `-us` → `-i` (cactus, cacti) only for words this long, so `bus` and `plus` keep theirs.
_MIN_LATIN_US_WORD_LENGTH = 5
_VOWELS = frozenset("aeiou")
# Tag names are private in an encrypted namespace: the memos are capped and cleared on lock.
_SPELLINGS_MEMO_ENTRIES = 32768
_ES_ENDINGS = ("s", "x", "z", "ch", "sh", "o")
_IRREGULAR_PLURALS = {
    "child": "children",
    "person": "people",
    "mouse": "mice",
    "louse": "lice",
    "goose": "geese",
    "foot": "feet",
    "tooth": "teeth",
    "ox": "oxen",
    "index": "indices",
    "matrix": "matrices",
    "vertex": "vertices",
    "appendix": "appendices",
    "criterion": "criteria",
    "phenomenon": "phenomena",
}


@sensitive_lru_cache(maxsize=_SPELLINGS_MEMO_ENTRIES, max_bytes=SENSITIVE_MEMO_BYTES)
def _plurals_of_word(word: str) -> frozenset[str]:
    assert word == word.casefold(), word
    plurals = set()
    if word in _IRREGULAR_PLURALS:
        plurals.add(_IRREGULAR_PLURALS[word])
    if len(word) < _MIN_REGULAR_WORD_LENGTH or not _WORD.fullmatch(word):
        return frozenset(plurals)
    plurals.add(word + "s")
    if word.endswith(_ES_ENDINGS):
        plurals.add(word + "es")
    if word.endswith("y") and word[-2] not in _VOWELS:
        plurals.add(word[:-1] + "ies")
    if word.endswith("f"):
        plurals.add(word[:-1] + "ves")
    if word.endswith("fe"):
        plurals.add(word[:-2] + "ves")
    if word.endswith("sis"):
        plurals.add(word[:-3] + "ses")
    if word.endswith("man"):
        plurals.add(word[:-3] + "men")
    if word.endswith("us") and len(word) >= _MIN_LATIN_US_WORD_LENGTH:
        plurals.add(word[:-2] + "i")
    plurals.discard(word)
    return frozenset(plurals)


@sensitive_lru_cache(maxsize=_SPELLINGS_MEMO_ENTRIES, max_bytes=SENSITIVE_MEMO_BYTES)
def plural_spellings(term: str) -> frozenset[str]:
    """The term (casefolded) with one of its words made plural, connectors kept."""
    if not isinstance(term, str) or term == "":
        raise TypeError("term must be a non-empty string")
    # Words sit at even positions, the connector runs between them at odd ones.
    parts = _CONNECTOR_RUN.split(term.casefold())
    spellings = set()
    for index in range(0, len(parts), 2):
        for plural in _plurals_of_word(parts[index]):
            spellings.add("".join((*parts[:index], plural, *parts[index + 1:])))
    return frozenset(spellings)


class PluralSpellings:
    """The tags a note has; tells whether another tag is one of their singular or
    plural spellings."""

    def __init__(self, terms: Iterable[str]) -> None:
        self._keys = frozenset(term.casefold() for term in terms if not term.startswith("@"))
        self._plural_keys = frozenset(
            spelling for key in self._keys for spelling in plural_spellings(key)
        )

    def covers(self, term: str) -> bool:
        """True when `term` is another spelling of one of the other tags (`eggs` for `egg`,
        `egg` for `eggs`), also when it is among the tags itself (`avocados` beside its
        synonym `avocado`); never for the same spelling alone or a meta tag."""
        key = term.casefold()
        if key.startswith("@"):
            return False
        if key in self._plural_keys:
            return True
        return not self._keys.isdisjoint(plural_spellings(key))
