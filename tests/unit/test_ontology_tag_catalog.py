from __future__ import annotations

import pytest

import app.api.routes.ontology as ontology_route
from app.services.tag_ontology import compile_rules, parse_rules_text


def test_empty_catalog_query_returns_total_without_materializing_every_tag(monkeypatch) -> None:
    monkeypatch.setattr(ontology_route, "get_ontology", lambda: object())
    monkeypatch.setattr(
        ontology_route.search_index,
        "list_tag_frequencies",
        lambda: {"journal": 8, "project": 3},
    )
    monkeypatch.setattr(
        ontology_route,
        "extract_ontology_tags",
        lambda _ontology: {"journal", "project", "ontology-only"},
    )

    payload = ontology_route.list_tags(q="", limit=0, focus="", relation="none")

    assert payload == {"totalCount": 3, "tags": []}


def test_catalog_query_honors_a_positive_result_limit(monkeypatch) -> None:
    monkeypatch.setattr(ontology_route, "get_ontology", lambda: object())
    monkeypatch.setattr(
        ontology_route.search_index,
        "list_tag_frequencies",
        lambda: {"journal": 8, "project": 3},
    )
    monkeypatch.setattr(
        ontology_route,
        "extract_ontology_tags",
        lambda _ontology: {"journal", "project", "ontology-only"},
    )

    payload = ontology_route.list_tags(q="", limit=2, focus="", relation="none")

    assert payload == {
        "totalCount": 3,
        "tags": [
            {"tag": "journal", "count": 8, "label": "journal"},
            {"tag": "project", "count": 3, "label": "project"},
        ],
    }


# Tag Relationships suggests tags linked to the focus tag first (app/services/agent/skills/help-ontology.md, "Relationship dialogs").
_LIMIT = 20
# On how many notes each tag is, and on how many of copy-paste's 12 notes it is written.
_USES = {"copy-paste": 12, "journal": 100, "science": 80, "ctrl-v": 5, "clipboard": 10, "paste-buffer": 3,
         "keyboard": 20, "shortcuts": 30}
_SHARED = {"journal": 9, "ctrl-v": 5, "clipboard": 6, "keyboard": 8, "shortcuts": 2, "science": 1,
           # A meta tag a rule names: written on notes, never counted in tag use (2026-10-22).
           "@bold": 3}
_WRITTEN = {**_USES, "@bold": 10}


@pytest.fixture
def copy_paste_namespace(monkeypatch):
    rules = "clipboard => copy-paste\n@bold => emphasis\n"
    ontology = compile_rules(rules=parse_rules_text(text=rules, filename="test"), filename="test")
    monkeypatch.setattr(ontology_route, "get_ontology", lambda: ontology)
    monkeypatch.setattr(ontology_route, "extract_ontology_tags", lambda _ontology: {"clipboard", "copy-paste", "@bold", "emphasis"})
    monkeypatch.setattr(ontology_route.search_index, "list_tag_frequencies", lambda: dict(_USES))
    monkeypatch.setattr(ontology_route.search_index, "count_written_tags_on_notes_with",
                        lambda term: (_USES[term], {tag: (count, _WRITTEN[tag]) for tag, count in _SHARED.items()}))
    ontology_route._related_orders.clear()
    yield
    ontology_route._related_orders.clear()


def _suggested(*, relation: str, q: str) -> list[str]:
    payload = ontology_route.list_tags(q=q, limit=_LIMIT, focus="copy-paste", relation=relation)
    return [entry["tag"] for entry in payload["tags"]]


def test_a_condition_suggests_tags_whose_notes_carry_the_focus_tag_first(copy_paste_namespace) -> None:
    # ctrl-v: 5 of its 5 notes are copy-paste; keyboard 8 of 20; journal 9 of 100; shortcuts 2 of 30.
    # clipboard already implies copy-paste; paste-buffer shares a word; science shares one note only.
    # @bold is on 3 copy-paste notes, but a meta tag is no linked topic: it is listed by use, with
    # emphasis, which only a rule names.
    assert _suggested(relation="incoming", q="") == [
        "ctrl-v", "keyboard", "journal", "shortcuts", "paste-buffer", "science", "@bold", "emphasis",
    ]


def test_an_implied_tag_suggests_tags_most_focus_notes_carry_first(copy_paste_namespace) -> None:
    # Of copy-paste's 12 notes: journal 9, keyboard 8, clipboard 6, ctrl-v 5, shortcuts 2.
    assert _suggested(relation="implied", q="") == [
        "journal", "keyboard", "clipboard", "ctrl-v", "shortcuts", "paste-buffer", "science", "@bold", "emphasis",
    ]


def test_a_synonym_suggests_tags_linked_both_ways_first(copy_paste_namespace) -> None:
    # Shared notes among either's: ctrl-v 5/12, clipboard 6/16, keyboard 8/24, journal 9/103, shortcuts 2/40.
    assert _suggested(relation="synonym", q="") == [
        "ctrl-v", "clipboard", "keyboard", "journal", "shortcuts", "paste-buffer", "science", "@bold", "emphasis",
    ]


def test_typing_narrows_the_related_order(copy_paste_namespace) -> None:
    empty = _suggested(relation="incoming", q="")
    typed = _suggested(relation="incoming", q="c")
    assert typed == ["ctrl-v", "shortcuts", "science"]
    assert typed == [tag for tag in empty if tag in typed]


def test_a_focus_tag_goes_with_a_relation() -> None:
    with pytest.raises(ValueError):
        ontology_route.list_tags(q="", limit=_LIMIT, focus="copy-paste", relation="none")
    with pytest.raises(ValueError):
        ontology_route.list_tags(q="", limit=_LIMIT, focus="", relation="incoming")
