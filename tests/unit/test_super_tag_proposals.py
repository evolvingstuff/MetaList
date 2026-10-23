"""The AI proposing super tags with values (docs/design/tag-properties.md): what it is
shown, which of its proposals are valid and new, and how an accepted one merges into
the note's own token for that tag."""

from __future__ import annotations

import pytest

from app.services.agent.tagging import NoteTagProposal, TagBatchResult, invalid_tag_reason, make_batch, validate_proposals
from app.services.search_index import extract_ordered_tags_for_agent
from app.services.tag_ontology import is_valid_proposal_token
from app.usecases.tag_proposals import merge_accepted_proposals, proposal_says_something_new


@pytest.mark.parametrize(("token", "valid"), [
    ("jogging", True),
    ("jogging:miles=3", True),
    ("jogging:miles=3:duration=30", True),
    ("run:start=10:30pm", True),
    ("drug:dosage=10mg", True),
    ("jogging=3:miles=1", True),
    ("jogging:miles=", False),
    ("jogging:miles=3:miles=4", False),
    ("jogging:3=1", False),
    ("x:note=two words", False),
    ("@red", False),
])
def test_a_proposal_is_a_tag_or_a_complete_super_tag(token: str, valid: bool) -> None:
    assert is_valid_proposal_token(token) is valid


def test_the_ai_sees_super_tags_whole_and_their_tag_as_vocabulary() -> None:
    assert extract_ordered_tags_for_agent("fruit jogging:miles=3 {{@red}} /* a run */") == (
        "fruit", "jogging:miles=3", "@red",
    )
    batch = make_batch(({
        "note_id": "a", "content_text": "Ran 3 miles", "tags": ["fruit", "jogging:miles=3"], "proposed_tags": [],
    },))
    assert batch.vocabulary == ("fruit", "jogging")


@pytest.mark.parametrize(("policy", "proposal", "reason"), [
    ("new", "jogging:miles=4", ""),
    # The pass's policy is about the tag: jogging exists, its values are not tags.
    ("existing", "jogging:miles=4", ""),
    ("existing", "running:miles=4", "Tag does not exist in the vault: 'running:miles=4'"),
    ("new_only", "jogging:miles=4", "Model proposed an existing tag during a new-tags-only pass: 'jogging:miles=4'"),
    ("new", "jogging:miles=", "Invalid classification tag or super tag: 'jogging:miles='"),
])
def test_validation_applies_the_pass_policy_to_a_super_tags_tag(policy: str, proposal: str, reason: str) -> None:
    assert invalid_tag_reason(proposal, {"jogging": "jogging"}, policy) == reason


def test_valid_super_tag_proposals_pass_validation() -> None:
    batch = make_batch(({"note_id": "a", "content_text": "", "tags": ["jogging"], "proposed_tags": []},))
    result = TagBatchResult(proposals=[NoteTagProposal(note_id="a", tags=["jogging:miles=4", "running"])])
    assert validate_proposals(result, batch, batch.note_ids, "new", {"jogging": "jogging"}) == {
        "a": ("jogging:miles=4", "running"),
    }


@pytest.mark.parametrize(("tags", "pending", "proposal", "is_new"), [
    # A super tag adds what the note's own token for its tag lacks.
    ("jogging", [], "jogging:miles=3", True),
    ("jogging:miles=3", [], "jogging:miles=3", False),
    ("jogging:miles=5", [], "jogging:miles=3", False),
    ("jogging:miles=3", [], "jogging:miles=3:duration=30", True),
    ("", [], "jogging:miles=3", True),
    # One proposal per tag at a time.
    ("", ["jogging"], "jogging:miles=3", False),
    # A plain tag the note's super tag already carries is nothing new.
    ("jogging:miles=3", [], "jogging", False),
])
def test_a_proposal_is_new_only_when_it_adds_to_the_note(
    tags: str, pending: list[str], proposal: str, is_new: bool,
) -> None:
    seen = {tag.casefold() for tag in pending} | {term.casefold() for term in extract_ordered_tags_for_agent(tags)}
    seen |= {term.split(":", 1)[0].casefold() for term in seen}
    assert proposal_says_something_new(proposal=proposal, seen=seen, pending=pending, tags=tags) is is_new


@pytest.mark.parametrize(("tags", "proposals", "merged"), [
    ("", ("jogging:miles=3",), "jogging:miles=3"),
    ("fruit jogging", ("jogging:miles=3",), "fruit jogging:miles=3"),
    # The note's own values stay; only missing ones are added.
    ("jogging:miles=5", ("jogging:miles=3:duration=30",), "jogging:miles=5:duration=30"),
    ("jogging:miles=5", ("jogging",), "jogging:miles=5"),
    ("jogging=3", ("jogging:miles=2",), "jogging=3:miles=2"),
    ("Jogging", ("jogging:miles=3",), "Jogging:miles=3"),
    # A comment naming the tag is left alone.
    ("/* about jogging */ jogging", ("jogging:miles=3",), "/* about jogging */ jogging:miles=3"),
    ("x", ("y", "jogging:miles=1"), "x y jogging:miles=1"),
])
def test_an_accepted_proposal_merges_into_the_notes_token(tags: str, proposals: tuple[str, ...], merged: str) -> None:
    assert merge_accepted_proposals(tags, proposals) == merged
