from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import pytest

import app.usecases.tag_proposals as proposal_module
from app.services.tag_ontology import TagOntology


VIEWPORT = {"scrollY": 0, "scrollAnchor": None}


class _FakeNoteStore:
    def __init__(self, record: SimpleNamespace, inherited_tags: frozenset[str]) -> None:
        self.record = record
        self.inherited_tags = inherited_tags

    def get_note(self, note_id: str) -> SimpleNamespace:
        assert note_id == "note-1"
        return self.record

    def get_inherited_non_meta_tag_terms(self, note_id: str) -> frozenset[str]:
        assert note_id == "note-1"
        return self.inherited_tags


def _record(*, tags: str, proposed_tags: str) -> SimpleNamespace:
    return SimpleNamespace(
        content="<div>robot content</div>",
        tags=tags,
        proposed_tags=proposed_tags,
        tag_terms=frozenset(tags.split()),
    )


def test_pseudo_generation_merges_dedupes_and_suppresses_effective_tags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    record = _record(
        tags="human-tag ROBOT-SUGGESTED",
        proposed_tags="existing-proposal ROBOT-OBSCURE-7F3C",
    )
    monkeypatch.setattr(
        proposal_module,
        "note_store",
        _FakeNoteStore(record, frozenset({"robot-ontology-source"})),
    )
    monkeypatch.setattr(proposal_module, "get_ontology", TagOntology.empty)
    applied: list[dict[str, object]] = []
    monkeypatch.setattr(
        proposal_module,
        "apply_update_note_sources",
        lambda **kwargs: applied.append(kwargs),
    )
    monkeypatch.setattr(proposal_module, "get_current_sync_uuid", lambda: "update-1")
    undo_records: list[dict[str, object]] = []
    monkeypatch.setattr(
        proposal_module,
        "record_tag_sources",
        lambda *args, **kwargs: undo_records.append({"args": args, **kwargs}),
    )

    response = proposal_module.CmdMakePseudoTagProposals(
        note_id="note-1",
        token="token",
        client_id="client-1",
        undo_context="context-1",
        viewport=VIEWPORT,
    ).execute()

    assert response == {
        "status": "success",
        "proposedTags": "existing-proposal ROBOT-OBSCURE-7F3C",
        "updateUUID": "update-1",
    }
    assert applied == []
    assert undo_records == []


def test_pseudo_generation_records_one_undoable_tag_source_transition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    record = _record(tags="human-tag", proposed_tags="")
    monkeypatch.setattr(
        proposal_module,
        "note_store",
        _FakeNoteStore(record, frozenset()),
    )
    monkeypatch.setattr(proposal_module, "get_ontology", TagOntology.empty)
    applied: list[dict[str, object]] = []
    undo_records: list[dict[str, object]] = []
    monkeypatch.setattr(
        proposal_module,
        "apply_update_note_sources",
        lambda **kwargs: applied.append(kwargs),
    )
    monkeypatch.setattr(
        proposal_module,
        "record_tag_sources",
        lambda *args, **kwargs: undo_records.append({"args": args, **kwargs}),
    )
    monkeypatch.setattr(proposal_module, "generate_new_uuid", lambda: "update-1")

    response = proposal_module.CmdMakePseudoTagProposals(
        note_id="note-1",
        token="token",
        client_id="client-1",
        undo_context="context-1",
        viewport=VIEWPORT,
    ).execute()

    expected_proposals = "robot-suggested robot-ontology-source robot-obscure-7f3c"
    assert response["proposedTags"] == expected_proposals
    assert applied[0]["proposed_tags"] == expected_proposals
    assert undo_records == [{
        "args": ("client-1", "context-1", "note-1"),
        "before_tags": "human-tag",
        "before_proposed_tags": "",
        "after_tags": "human-tag",
        "after_proposed_tags": expected_proposals,
        "viewport": VIEWPORT,
    }]


def test_accept_moves_one_proposal_to_accepted_tags_and_records_interaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    record = _record(tags="human-tag", proposed_tags="Proposal-One proposal-two")
    monkeypatch.setattr(
        proposal_module,
        "note_store",
        _FakeNoteStore(record, frozenset()),
    )
    applied: list[dict[str, object]] = []
    credited: list[dict[str, object]] = []
    monkeypatch.setattr(
        proposal_module,
        "apply_update_note_sources",
        lambda **kwargs: applied.append(kwargs),
    )
    monkeypatch.setattr(
        proposal_module,
        "record_explicit_tag_additions",
        lambda **kwargs: credited.append(kwargs) or True,
    )
    monkeypatch.setattr(proposal_module, "current_local_date", lambda: date(2026, 9, 3))
    monkeypatch.setattr(proposal_module, "generate_new_uuid", lambda: "update-2")
    undo_records: list[dict[str, object]] = []
    monkeypatch.setattr(
        proposal_module,
        "record_tag_sources",
        lambda *args, **kwargs: undo_records.append({"args": args, **kwargs}),
    )

    response = proposal_module.CmdAcceptTagProposal(
        note_id="note-1",
        proposal="proposal-one",
        token="token",
        client_id="client-1",
        undo_context="context-1",
        viewport=VIEWPORT,
    ).execute()

    assert response["tags"] == "human-tag Proposal-One"
    assert response["proposedTags"] == "proposal-two"
    assert applied == [{
        "note_id": "note-1",
        "content": "<div>robot content</div>",
        "tags": "human-tag Proposal-One",
        "proposed_tags": "proposal-two",
        "token": "token",
    }]
    assert credited == [{
        "before_tags": "human-tag",
        "after_tags": "human-tag Proposal-One",
        "token": "token",
        "interacted_on": date(2026, 9, 3),
    }]
    assert undo_records == [{
        "args": ("client-1", "context-1", "note-1"),
        "before_tags": "human-tag",
        "before_proposed_tags": "Proposal-One proposal-two",
        "after_tags": "human-tag Proposal-One",
        "after_proposed_tags": "proposal-two",
        "viewport": VIEWPORT,
    }]


def test_reject_removes_only_requested_proposal_and_stale_request_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    record = _record(tags="human-tag", proposed_tags="one Two three")
    monkeypatch.setattr(
        proposal_module,
        "note_store",
        _FakeNoteStore(record, frozenset()),
    )
    applied: list[dict[str, object]] = []
    monkeypatch.setattr(
        proposal_module,
        "apply_update_note_sources",
        lambda **kwargs: applied.append(kwargs),
    )
    monkeypatch.setattr(proposal_module, "generate_new_uuid", lambda: "update-3")
    undo_records: list[dict[str, object]] = []
    monkeypatch.setattr(
        proposal_module,
        "record_tag_sources",
        lambda *args, **kwargs: undo_records.append({"args": args, **kwargs}),
    )

    response = proposal_module.CmdRejectTagProposal(
        note_id="note-1",
        proposal="two",
        token="token",
        client_id="client-1",
        undo_context="context-1",
        viewport=VIEWPORT,
    ).execute()

    assert response["proposedTags"] == "one three"
    assert applied[0]["proposed_tags"] == "one three"
    assert undo_records == [{
        "args": ("client-1", "context-1", "note-1"),
        "before_tags": "human-tag",
        "before_proposed_tags": "one Two three",
        "after_tags": "human-tag",
        "after_proposed_tags": "one three",
        "viewport": VIEWPORT,
    }]
    with pytest.raises(KeyError, match="Proposal not found"):
        proposal_module.CmdRejectTagProposal(
            note_id="note-1",
            proposal="missing",
            token="token",
            client_id="client-1",
            undo_context="context-1",
            viewport=VIEWPORT,
        ).execute()
