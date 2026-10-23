"""Rules over super tag values (docs/design/tag-properties.md, Ontology rules):
jogging:miles>10 => long-run. A rule decides from one note's own values, and the tags it
infers are the note's own, so children and referencing notes inherit them."""

from __future__ import annotations

import pytest

import app.api.routes.ontology as ontology_route
import app.services.note_store as note_store_module
from app.services.note_store import NoteStore
from app.services.ontology_rules_store import _replace_tag_tokens_in_line
from app.services.search_index import SearchIndex, tag_bar_values
from app.services.tag_ontology import (
    OntologyParseError,
    PropertyAtom,
    compile_rules,
    parse_rules_text,
    rule_text_tests_values,
)

RULES = """jogging => exercise
jogging:miles>10 => long-run
(jogging:miles>=26.2 race) => marathon
task:due? => needs-date
drug:dosage>500mg => high-dose
exercise:duration>60 => long-workout
swimming => exercise
long-run => proud
"""
ONTOLOGY = compile_rules(rules=parse_rules_text(text=RULES, filename="test"), filename="test")


def test_a_super_tag_term_is_a_rule_atom_and_its_rule_a_value_rule() -> None:
    [rule] = parse_rules_text(text="(jogging:miles>=26.2 race) => marathon\n", filename="test")
    assert isinstance(rule.lhs[0], PropertyAtom)
    assert rule.lhs[0].condition.format() == "jogging:miles>=26.2"
    assert len(ONTOLOGY.value_rules) == 5
    assert ONTOLOGY.matcher_rules == ()
    assert rule_text_tests_values("task:due? => needs-date")
    assert not rule_text_tests_values('"run" => jogging')


@pytest.mark.parametrize(("line", "message"), [
    ("jogging:miles=MAX => longest", "MAX is for searches"),
    ("jogging:miles> => long-run", "Write a value after >"),
    ("jogging:3>2 => x", "A property name starts with a letter"),
])
def test_a_malformed_super_tag_term_in_a_rule_says_how_to_fix_it(line: str, message: str) -> None:
    with pytest.raises(OntologyParseError, match=message):
        parse_rules_text(text=f"{line}\n", filename="test")


@pytest.mark.parametrize(("tags", "carried", "inferred"), [
    ("jogging:miles=12", {"jogging"}, {"long-run", "proud"}),
    ("jogging:miles=5", {"jogging"}, set()),
    # A tag atom reads the tags the note carries, inherited ones too.
    ("jogging:miles=27", {"jogging", "race"}, {"long-run", "marathon", "proud"}),
    ("jogging:miles=27", {"jogging"}, {"long-run", "proud"}),
    # Missing: only on the note's own tag.
    ("task", {"task"}, {"needs-date"}),
    ("task:due=2026-11-01", {"task"}, set()),
    ("", {"task"}, set()),
    ("drug:dosage=600mg", {"drug"}, {"high-dose"}),
    ("drug:dosage=600g", {"drug"}, set()),
    # Through implications, as in search.
    ("swimming:duration=75", {"swimming"}, {"long-workout"}),
])
def test_a_notes_values_infer_tags(tags: str, carried: set[str], inferred: set[str]) -> None:
    own_tag_names, values = tag_bar_values(tags)
    assert ONTOLOGY.infer_value_tags(
        values=values, own_tag_names=own_tag_names, base_tags=frozenset(carried), plaintext="",
    ) == inferred


PARENT = "11111111-1111-4111-8111-111111111111"
RUN = "22222222-2222-4222-8222-222222222222"
CHILD = "33333333-3333-4333-8333-333333333333"
HOST = "44444444-4444-4444-8444-444444444444"


def _load(monkeypatch: pytest.MonkeyPatch, specs: dict[str, tuple[str | None, str, str]]) -> SearchIndex:
    """Specs map IDs to (parent, content, tags)."""
    children: dict[str | None, list[str]] = {}
    for note_id, (parent, _, _) in specs.items():
        if parent not in children:
            children[parent] = []
        children[parent].append(note_id)
    rows = []
    for note_id, (parent, _, _) in specs.items():
        siblings = children[parent]
        position = siblings.index(note_id)
        # The first sibling has no previous one, the last no next one.
        prev_id = None
        if position > 0:
            prev_id = siblings[position - 1]
        next_id = None
        if position + 1 < len(siblings):
            next_id = siblings[position + 1]
        rows.append(dict(
            id=note_id, parent_id=parent, is_collapsed=False, created_at=None, updated_at=None,
            prev_id=prev_id, next_id=next_id,
        ))
    index = SearchIndex()
    monkeypatch.setattr(note_store_module, "search_index", index)
    monkeypatch.setattr(note_store_module, "get_ontology", lambda: ONTOLOGY)
    monkeypatch.setattr(note_store_module, "get_ontology_if_ready", lambda: ONTOLOGY)
    monkeypatch.setattr(note_store_module, "get_cached_content", lambda note_id: specs[note_id][1])
    monkeypatch.setattr(note_store_module, "get_cached_text", lambda note_id: specs[note_id][1])
    monkeypatch.setattr(note_store_module, "get_cached_tags", lambda note_id: specs[note_id][2])
    monkeypatch.setattr(note_store_module, "get_cached_proposed_tags", lambda note_id: "")
    store = NoteStore()
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=rows)
    return index


def test_an_inferred_tag_is_the_notes_own_and_passes_to_children_and_referencing_notes(monkeypatch) -> None:
    index = _load(monkeypatch, {
        PARENT: (None, "Races", "race"),
        RUN: (PARENT, "Marathon day", "jogging:miles=26.2"),
        CHILD: (RUN, "Splits", ""),
        HOST: (None, f"[[{RUN}]]", ""),
    })
    # The run carries race from its parent, so it is a marathon; its child inherits both,
    # never miles=26.2.
    assert index.query_note_ids("long-run") == {RUN, CHILD, HOST}
    # A referencing note gets the run's own tags, not those it inherits (race), as
    # references always have: so long-run, not marathon.
    assert index.query_note_ids("marathon") == {RUN, CHILD}
    assert index.query_note_ids("jogging:miles>10") == {RUN}


def test_renaming_a_tag_rewrites_its_super_tag_terms_in_rules() -> None:
    rename = lambda line: _replace_tag_tokens_in_line(line=line, old="jogging", new="running")  # noqa: E731
    assert rename("(jogging:miles>=26.2 race) => marathon") == "(running:miles>=26.2 race) => marathon"
    assert rename("joggingx:miles>1 => y") == "joggingx:miles>1 => y"
    assert rename('"jogging:miles>1" => z') == '"jogging:miles>1" => z'


def test_saving_a_rule_warns_about_a_term_no_note_can_match(monkeypatch) -> None:
    monkeypatch.setattr(
        ontology_route.search_index, "uses_property",
        lambda *, tag, property_name: (tag, property_name) == ("jogging", "miles"),
    )
    assert ontology_route._rule_warnings("jogging:miles>10 => long-run") == []
    assert ontology_route._rule_warnings("(jogging:mile>10 race) => long-run") == [
        "No note has jogging:mile yet; check the spelling.",
    ]
