"""Why a tag-bar or search-bar suggestion is suggested (shown when it is right-clicked).

The reasons come from the ranking's own findings, so each case checks the
exact words for one kind of evidence, and that the suggestions keep the order
the ranking gives without reasons.
"""

from __future__ import annotations

import pytest

import app.services.tag_suggestions as tag_suggestions_module
from app.services.search_index import SearchIndex
from app.services.search_index import SearchRecord
from app.services.search_index import extract_tags_for_search
from app.services.tag_suggestion_reasons import TagSuggestion
from app.services.tag_suggestion_reasons import search_suggestion_reasons
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
    assert reasons["GPT-4"] == ('Matches what you typed: "GPT"', "Listed by use: you've tagged 1 note with it")


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
    # Only what is true: nothing about what the note lacks.
    assert reasons["cooking"] == ("Listed by use: you've tagged 12 notes with it",)


def test_a_tag_whose_words_appear_too_sparsely_to_count(monkeypatch: pytest.MonkeyPatch) -> None:
    # One of three words is too little to name the tag; the part that is there is still said.
    rows = [(f"e{index}", "exercises") for index in range(5)] + [("l1", "low-intensity-exercise"), ("l2", "low-intensity-exercise")]
    _use(monkeypatch, rows=rows, ontology=_EmptyOntology())
    reasons = _reasons(anchors=[], prefix="exer", content="Gentle exercise today")
    assert reasons["low-intensity-exercise"] == (
        'Matches what you typed: "exer"',
        'Part of its name is in this note\'s text: "exercise"',
        "Listed by use: you've tagged 2 notes with it",
    )


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
    assert by_tag["maple"] == (
        'Matches what you typed: "m"', "Already applies: inherited from a parent note",
        "Listed by use: you've tagged 1 note with it",
    )
    assert by_tag["tree"] == (
        'Matches what you typed: "tr"', 'Already applies: implied by "maple"',
        "Listed by use: you've tagged 2 notes with it",
    )
    assert by_tag["marsh"] == ('Matches what you typed: "m"', "Listed by use: you've tagged 30 notes with it")


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


def _search_index(rows: list[tuple[str, str, str]]) -> SearchIndex:
    """Notes as (id, text, tags)."""
    index = SearchIndex()
    records = [
        SearchRecord(note_id=note_id, content_text=text, tags=tags, tag_terms=extract_tags_for_search(tags))
        for note_id, text, tags in rows
    ]
    index.rebuild(
        records, raw_tag_terms_by_id={record.note_id: record.tag_terms for record in records},
        progress_update=lambda _processed: None, progress_interval=1000,
    )
    return index


def _search_reasons(index: SearchIndex, query: str) -> dict[str, tuple[str, ...]]:
    """As the search-suggestions route explains them (no recent activity)."""
    suggestions = index.suggest_all_tag_completions(query=query)
    facts = index.describe_search_suggestions(query=query, terms=suggestions)
    return {tag: search_suggestion_reasons(facts=facts, term=tag, recent_activity={}) for tag in suggestions}


def test_a_search_suggestion_that_goes_with_the_tags_already_searched() -> None:
    index = _search_index(
        [(f"p{number}", "", "python pandas") for number in range(4)] + [("solo", "", "pandas"), ("py", "", "python")]
    )
    assert _search_reasons(index, "python pa")["pandas"] == (
        'On 4 notes together with "python"', "Searching for it finds 5 notes",
    )


def test_a_search_suggestion_after_text_in_the_search() -> None:
    index = _search_index([("a", "kyoto temples", "travel"), ("b", "osaka", "travel"), ("c", "kyoto", "trains")])
    assert _search_reasons(index, '"kyoto" tr') == {
        "trains": ("Your search so far finds it on 1 note", "Searching for it finds 1 note"),
        "travel": ("Your search so far finds it on 1 note", "Searching for it finds 2 notes"),
    }


def test_a_search_suggestion_to_leave_out() -> None:
    index = _search_index(
        [(f"p{number}", "", "python pandas") for number in range(4)] + [("py", "", "python")]
    )
    assert _search_reasons(index, "python -pa")["pandas"] == (
        "Leaving it out removes 4 of the 5 notes your search finds", "Searching for it finds 4 notes",
    )
    assert _search_reasons(index, "-pa")["pandas"] == (
        "Leaving it out removes 4 of your 5 notes", "Searching for it finds 4 notes",
    )


def test_a_meta_tag_search_suggestion() -> None:
    index = _search_index([("b", "", "@bold"), ("c", "", "plain")])
    reasons = _search_reasons(index, "@bo")
    assert reasons["@bold"] == ('A built-in tag starting with "@bo"', "Searching for it finds 1 note")


_LINK_TAGS = (
    [(f"h{index}", "HTTPS") for index in range(5)]
    + [("n1", "V-neuron"), ("n2", "V-neuron"), ("s", "V-Shred"), ("i", "indeed.com")]
    + [(f"y{index}", "YouTube") for index in range(3)]
)


def test_a_link_in_the_note_counts_only_by_its_site_name(monkeypatch: pytest.MonkeyPatch) -> None:
    # A note that is just a YouTube link: https, www, .com and ?v=… say nothing about it.
    _use(monkeypatch, rows=_LINK_TAGS, ontology=_EmptyOntology())
    reasons = _reasons(anchors=[], prefix="", content="https://www.youtube.com/watch?v=GYx4OBbswTw")
    assert list(reasons)[0] == "YouTube"
    assert reasons["YouTube"] == ('Named in this note: "YouTube"', "You've tagged 3 notes with it")
    assert reasons["HTTPS"] == ("Listed by use: you've tagged 5 notes with it",)
    assert reasons["V-neuron"] == ("Listed by use: you've tagged 2 notes with it",)
    assert reasons["V-Shred"] == ("Listed by use: you've tagged 1 note with it",)
    assert reasons["indeed.com"] == ("Listed by use: you've tagged 1 note with it",)


def test_one_letter_alone_does_not_name_a_tag_with_real_words(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, rows=_LINK_TAGS, ontology=_EmptyOntology())
    reasons = _reasons(anchors=[], prefix="", content="Plan v two of the shred")
    # With "shred" there too, every part of V-Shred is in the text; "v" alone names nothing.
    assert reasons["V-Shred"] == ('Named in this note: "V", "Shred"', "You've tagged 1 note with it")
    assert reasons["V-neuron"] == (
        'Part of its name is in this note\'s text: "V"', "Listed by use: you've tagged 2 notes with it",
    )
