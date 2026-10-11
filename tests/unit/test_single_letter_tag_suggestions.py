"""Typing one letter narrows the empty-bar suggestions instead of reordering them.

docs/ui/tag-bar.md, "Tag Suggestions". The offline experiment
(experiments/tag_suggestions) found the old one-letter reordering kept the
wanted tag out of the top 5 three times in four.
"""

from __future__ import annotations

import pytest

import app.services.tag_suggestions as tag_suggestions_module
from app.services.search_index import SearchIndex
from app.services.search_index import SearchRecord
from app.services.search_index import extract_tags_for_search


class _EmptyOntology:
    is_empty = True
    implication_out_edges = {}
    implication_closure = {}
    implied_by_closure = {}
    scc_members_by_tag = {}


class _IndexOnlyNoteStore:
    loaded = True

    def __init__(self, *, inherited: frozenset[str]) -> None:
        self._inherited = inherited

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> frozenset[str]:
        return self._inherited

    def has_note(self, note_id: str) -> bool:
        return False

    def get_note(self, note_id: str):
        raise KeyError(note_id)

    def list_note_ids(self) -> list[str]:
        return []

    def get_children(self, parent_id: str | None) -> list[str]:
        return []


# maple: frequent but unrelated; melon: goes with "fruit"; mango and kiwi: named in the note;
# mint: inherited from an ancestor in some tests; moss: rare and unrelated.
_TAG_ROWS = (
    [(f"maple-{index}", "maple") for index in range(50)]
    + [(f"melon-{index}", "fruit melon") for index in range(3)]
    + [(f"mango-{index}", "mango") for index in range(2)]
    + [(f"kiwi-{index}", "fruit kiwi") for index in range(2)]
    + [(f"mint-{index}", "mint") for index in range(20)]
    + [("moss-0", "moss")]
)
_CONTENT = "<p>mango smoothie</p>"


def _use_index(monkeypatch: pytest.MonkeyPatch, *, inherited: frozenset[str]) -> None:
    index = SearchIndex()
    records = [SearchRecord(note_id=note_id, content_text="", tags=tags, tag_terms=extract_tags_for_search(tags))
               for note_id, tags in _TAG_ROWS]
    index.rebuild(records, raw_tag_terms_by_id={record.note_id: record.tag_terms for record in records},
                  progress_update=lambda _processed: None, progress_interval=1000)
    monkeypatch.setattr(tag_suggestions_module, "search_index", index)
    monkeypatch.setattr(tag_suggestions_module, "note_store", _IndexOnlyNoteStore(inherited=inherited))
    monkeypatch.setattr(tag_suggestions_module, "get_ontology", lambda: _EmptyOntology())


def _suggest(*, bar: list[str], prefix: str) -> list[str]:
    explicit = list(bar)
    if prefix != "":
        explicit.append(prefix)
    return tag_suggestions_module.suggest_tags_for_note(include_already_applying=False, 
        note_id="note", anchors=bar, explicit_tags=explicit, prefix=prefix, content_html=_CONTENT, limit=20)


def _matching(tags: list[str], letter: str) -> list[str]:
    return [tag for tag in tags if tag.casefold().startswith(letter)]


def test_one_letter_keeps_the_empty_bar_order(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_index(monkeypatch, inherited=frozenset())
    empty_bar = _suggest(bar=["fruit"], prefix="")
    # Named in the note first, then what goes with "fruit".
    assert empty_bar[:3] == ["mango", "melon", "kiwi"]
    typed = _suggest(bar=["fruit"], prefix="m")
    # What was on screen keeps its order; tags without the letter drop out.
    assert typed[:2] == ["mango", "melon"]
    assert typed[:2] == _matching(empty_bar, "m")[:2]


def test_one_letter_fills_the_rest_with_the_one_letter_order(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_index(monkeypatch, inherited=frozenset())
    typed = _suggest(bar=["fruit"], prefix="m")
    # After the empty-bar matches: the remaining m-tags by raw usage.
    assert typed == ["mango", "melon", "maple", "mint", "moss"]


def test_one_letter_puts_matching_inherited_tags_after_the_empty_bar_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_index(monkeypatch, inherited=frozenset({"mint"}))
    typed = _suggest(bar=["fruit"], prefix="m")
    # An inherited tag already applies, so the empty bar hides it; once its letter is typed it comes
    # right after the empty-bar matches, ahead of the filler.
    assert typed == ["mango", "melon", "mint", "maple", "moss"]


def test_one_letter_never_suggests_a_tag_already_in_the_bar(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_index(monkeypatch, inherited=frozenset())
    typed = _suggest(bar=["fruit", "melon"], prefix="m")
    assert "melon" not in typed
    assert typed[0] == "mango"


def test_two_letters_are_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_index(monkeypatch, inherited=frozenset())
    assert _suggest(bar=["fruit"], prefix="ma") == ["mango", "maple"]
