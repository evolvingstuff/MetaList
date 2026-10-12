"""Why a tag-bar suggestion is suggested (shown when it is right-clicked).

The reasons come from the ranking's own findings, so each case checks the
exact words for one kind of evidence, and that the suggestions keep the order
the ranking gives without reasons.
"""

from __future__ import annotations

import pytest

import app.services.tag_suggestions as tag_suggestions_module
from app.services.tag_suggestion_reasons import TagSuggestion
from tests.unit.test_segment_aware_tag_suggestions import _EmptyOntology
from tests.unit.test_segment_aware_tag_suggestions import _FakeHierarchyNoteStore
from tests.unit.test_segment_aware_tag_suggestions import _IndexOnlyNoteStore
from tests.unit.test_segment_aware_tag_suggestions import _build_index
from tests.unit.test_segment_aware_tag_suggestions import _build_note_record
from tests.unit.test_segment_aware_tag_suggestions import _build_ontology
from tests.unit.test_segment_aware_tag_suggestions import _use_parent_tagged_maple


def _use(monkeypatch: pytest.MonkeyPatch, *, rows, ontology) -> None:
    monkeypatch.setattr(
        tag_suggestions_module, "note_store",
        _IndexOnlyNoteStore(get_inherited_non_meta_tag_terms=lambda _note_id: frozenset()),
    )
    monkeypatch.setattr(tag_suggestions_module, "search_index", _build_index(rows))
    monkeypatch.setattr(tag_suggestions_module, "get_ontology", lambda: ontology)


def _reasons(*, anchors, prefix, content):
    explicit_tags = list(anchors)
    if prefix != "":
        explicit_tags.append(prefix)
    arguments = dict(
        note_id="current", anchors=list(anchors), explicit_tags=explicit_tags, prefix=prefix,
        content_html=f"<p>{content}</p>", limit=20, include_already_applying=False,
    )
    with_reasons = tag_suggestions_module.suggest_tags_with_reasons_for_note(**arguments)
    # Explaining never changes what is suggested or its order.
    assert [suggestion.tag for suggestion in with_reasons] == tag_suggestions_module.suggest_tags_for_note(**arguments)
    return {suggestion.tag: suggestion.reasons for suggestion in with_reasons}


def test_a_tag_named_in_the_note(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, rows=[(f"ml-{index}", "machine-learning") for index in range(3)] + [("other", "cooking")], ontology=_EmptyOntology())
    reasons = _reasons(anchors=[], prefix="", content="Notes on machine learning today")
    assert reasons["machine-learning"] == ('Named in this note: "machine learning"', "You've tagged 3 notes with it")


def test_a_tag_partly_named_in_the_note(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, rows=[("dw", "databricks-workspaces")], ontology=_EmptyOntology())
    reasons = _reasons(anchors=[], prefix="", content="Cleaning up old workspaces")
    assert reasons["databricks-workspaces"] == ('Partly named in this note: "workspaces"', "You've tagged 1 note with it")


def test_a_tag_whose_number_is_not_in_the_note_is_only_partly_named(monkeypatch: pytest.MonkeyPatch) -> None:
    # Numbers alone do not count toward a match, so "topic" surfaces topic-41.
    _use(monkeypatch, rows=[("t", "topic-41")], ontology=_EmptyOntology())
    reasons = _reasons(anchors=[], prefix="", content="Another topic for later")
    assert reasons["topic-41"] == ('Partly named in this note: "topic"', "You've tagged 1 note with it")


def test_the_rest_of_a_tag_after_what_was_typed(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, rows=[("g4", "GPT-4"), ("g56", "GPT-5.6-sol")], ontology=_EmptyOntology())
    reasons = _reasons(anchors=[], prefix="GPT", content="Trying 5.6 sol on the benchmark")
    assert reasons["GPT-5.6-sol"] == (
        'The rest of it after "GPT" is in this note: "5.6 sol"', "You've tagged 1 note with it",
    )
    assert reasons["GPT-4"] == ("Nothing in this note points to it", "You've tagged 1 note with it")


def test_a_tag_that_goes_with_the_notes_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [(f"py-{index}", "python pandas") for index in range(4)] + [("solo", "pandas")]
    _use(monkeypatch, rows=rows, ontology=_EmptyOntology())
    reasons = _reasons(prefix="", anchors=["python"], content="Loading a table")
    assert reasons["pandas"] == ('On 4 notes together with "python"', "You've tagged 5 notes with it")


def test_a_tag_that_goes_with_several_of_the_notes_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    rows = [("a", "travel japan kyoto"), ("b", "travel japan kyoto"), ("c", "travel kyoto")]
    _use(monkeypatch, rows=rows, ontology=_EmptyOntology())
    reasons = _reasons(prefix="", anchors=["travel", "japan"], content="Day three")
    assert reasons["kyoto"] == ('On 2 notes together with "japan" and "travel"', "You've tagged 3 notes with it")


def test_a_tag_that_goes_with_different_tags_on_different_notes(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, rows=[("a", "travel kyoto"), ("b", "japan kyoto")], ontology=_EmptyOntology())
    reasons = _reasons(prefix="", anchors=["travel", "japan"], content="Day three")
    assert reasons["kyoto"] == ("On 2 notes together with 1 of this note's tags", "You've tagged 2 notes with it")


def test_a_tag_on_notes_that_share_this_notes_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _FakeHierarchyNoteStore(
        records=[
            _build_note_record(note_id="current", parent_id=None, content="4", tags=""),
            _build_note_record(note_id="other", parent_id=None, content="entry", tags="hangover"),
        ],
        inherited_non_meta_by_note={"current": frozenset({"journal"}), "other": frozenset({"journal"})},
    )
    monkeypatch.setattr(tag_suggestions_module, "note_store", store)
    monkeypatch.setattr(tag_suggestions_module, "get_ontology", lambda: _EmptyOntology())
    monkeypatch.setattr(tag_suggestions_module, "search_index", _build_index([("other", "hangover")]))
    reasons = _reasons(anchors=[], prefix="", content="4")
    assert reasons["hangover"] == ('On 1 note that shares "journal" with this one', "You've tagged 1 note with it")


def test_a_synonym_named_in_the_note(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(
        monkeypatch, rows=[("m1", "mood"), ("m2", "mood"), ("e", "emotion")],
        ontology=_build_ontology(text="mood = emotion\n"),
    )
    reasons = _reasons(anchors=[], prefix="", content="A strong emotion today")
    assert reasons["mood"] == ('This note names its synonym "emotion"', "You've tagged 2 notes with it")
    assert reasons["emotion"] == ('Named in this note: "emotion"', 'A synonym of "mood"', "You've tagged 1 note with it")


def test_a_tag_with_no_evidence_is_listed_for_its_use(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, rows=[(f"c-{index}", "cooking") for index in range(12)], ontology=_EmptyOntology())
    reasons = _reasons(anchors=[], prefix="", content="Nothing related")
    assert reasons["cooking"] == ("Nothing in this note points to it", "You've tagged 12 notes with it")


def test_tags_that_already_apply_say_how(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_parent_tagged_maple(monkeypatch)
    explicit = dict(note_id="current", anchors=[], content_html="<p>a walk</p>", limit=20, include_already_applying=False)
    # Typed: listed after the rest, saying why they are there at all.
    by_tag = {
        suggestion.tag: suggestion.reasons
        for prefix in ("ma", "tr", "m")
        for suggestion in tag_suggestions_module.suggest_tags_with_reasons_for_note(
            explicit_tags=[prefix], prefix=prefix, **explicit,
        )
    }
    assert by_tag["maple"] == ("Already applies: inherited from a parent note", "You've tagged 1 note with it")
    assert by_tag["tree"] == ('Already applies: implied by "maple"', "You've tagged 2 notes with it")
    assert by_tag["marsh"] == ("Nothing in this note points to it", "You've tagged 30 notes with it")


def test_a_meta_tag_is_listed_by_use(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, rows=[("b1", "@bold"), ("b2", "@bold")], ontology=_EmptyOntology())
    reasons = _reasons(anchors=[], prefix="@bo", content="")
    assert reasons["@bold"] == ('A built-in tag starting with "@bo"', "You've tagged 2 notes with it")


def test_a_tag_only_in_the_tag_relationships(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, rows=[("x", "other")], ontology=_build_ontology(text="Foley-catheter => medical-device\n"))
    reasons = _reasons(anchors=[], prefix="", content="Placed a Foley catheter")
    assert reasons["Foley-catheter"] == (
        'Named in this note: "Foley catheter"', "Not on any note yet; it is in your tag relationships",
    )


def test_a_suggestion_needs_a_reason() -> None:
    with pytest.raises(ValueError, match="at least one reason"):
        TagSuggestion(tag="kyoto", reasons=())
