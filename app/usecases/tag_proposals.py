from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.services.content_formatting import _tokenize_tag_bar
from app.services.note_store import store as note_store
from app.services.ontology_rules_store import get_ontology
from app.services.search_history import current_local_date, record_explicit_tag_additions
from app.services.sync import generate_new_uuid, get_current_sync_uuid
from app.services.tag_ontology import is_valid_tag_token
from app.services.undo_state import record_tag_sources
from app.usecases.base import QueryCommand
from app.usecases.update_content import apply_update_note_sources
from app.utils.text_utils import strip_html


PSEUDO_TAG_PROPOSALS = (
    "robot-suggested",
    "robot-ontology-source",
    "robot-obscure-7f3c",
)


def _proposal_tokens(proposed_tags: str) -> tuple[str, ...]:
    if not isinstance(proposed_tags, str):
        raise TypeError("proposed_tags must be a string")
    tokens = tuple(proposed_tags.split())
    for token in tokens:
        if not is_valid_tag_token(token):
            raise RuntimeError(f"Stored proposal is not a valid plain tag token: {token!r}")
    return tokens


def _join_proposal_tokens(tokens: tuple[str, ...]) -> str:
    if len({token.casefold() for token in tokens}) != len(tokens):
        raise RuntimeError("Proposal tokens must be case-insensitively unique")
    return " ".join(tokens)


def _effective_accepted_tag_keys(note_id: str) -> frozenset[str]:
    record = note_store.get_note(note_id)
    inherited_terms = note_store.get_inherited_non_meta_tag_terms(note_id)
    ontology = get_ontology()
    plaintext = ""
    if ontology.matcher_rules:
        plaintext = strip_html(record.content)
    effective_terms = ontology.infer_effective_tags(
        base_tags=record.tag_terms | inherited_terms,
        plaintext=plaintext,
    )
    return frozenset(term.casefold() for term in effective_terms)


def _find_proposal_token(*, proposed_tags: str, requested_proposal: str) -> str:
    if not isinstance(requested_proposal, str) or requested_proposal == "":
        raise TypeError("proposal must be a non-empty string")
    requested_key = requested_proposal.casefold()
    matches = [
        token
        for token in _proposal_tokens(proposed_tags)
        if token.casefold() == requested_key
    ]
    if len(matches) != 1:
        raise KeyError(f"Proposal not found: {requested_proposal}")
    return matches[0]


@dataclass(frozen=True)
class CmdMakePseudoTagProposals(QueryCommand):
    note_id: str
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdMakePseudoTagProposals(note={self.note_id})"

    def execute(self) -> Dict[str, object]:
        record = note_store.get_note(self.note_id)
        existing_tokens = _proposal_tokens(record.proposed_tags)
        seen_keys = {token.casefold() for token in existing_tokens}
        accepted_keys = _effective_accepted_tag_keys(self.note_id)
        merged = list(existing_tokens)
        for proposal in PSEUDO_TAG_PROPOSALS:
            proposal_tokens = _proposal_tokens(proposal)
            if proposal_tokens != (proposal,):
                raise RuntimeError(f"Invalid pseudo tag proposal: {proposal!r}")
            proposal_key = proposal.casefold()
            if proposal_key in seen_keys or proposal_key in accepted_keys:
                continue
            seen_keys.add(proposal_key)
            merged.append(proposal)

        next_proposed_tags = _join_proposal_tokens(tuple(merged))
        if next_proposed_tags == record.proposed_tags:
            update_uuid = get_current_sync_uuid()
        else:
            apply_update_note_sources(
                note_id=self.note_id,
                content=record.content,
                tags=record.tags,
                proposed_tags=next_proposed_tags,
                token=self.token,
            )
            record_tag_sources(
                self.client_id,
                self.undo_context,
                self.note_id,
                before_tags=record.tags,
                before_proposed_tags=record.proposed_tags,
                after_tags=record.tags,
                after_proposed_tags=next_proposed_tags,
                viewport=self.viewport,
            )
            update_uuid = generate_new_uuid()
        return {
            "status": "success",
            "proposedTags": next_proposed_tags,
            "updateUUID": update_uuid,
        }


@dataclass(frozen=True)
class CmdAcceptTagProposal(QueryCommand):
    note_id: str
    proposal: str
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdAcceptTagProposal(note={self.note_id}, proposal={self.proposal})"

    def execute(self) -> Dict[str, object]:
        record = note_store.get_note(self.note_id)
        proposal = _find_proposal_token(
            proposed_tags=record.proposed_tags,
            requested_proposal=self.proposal,
        )
        remaining = tuple(
            token
            for token in _proposal_tokens(record.proposed_tags)
            if token.casefold() != proposal.casefold()
        )
        accepted_tokens = tuple(_tokenize_tag_bar(record.tags))
        accepted_keys = {token.casefold() for token in accepted_tokens}
        if proposal.casefold() in accepted_keys:
            next_tags = record.tags
        elif record.tags.strip() == "":
            next_tags = proposal
        else:
            next_tags = f"{record.tags.strip()} {proposal}"
        next_proposed_tags = _join_proposal_tokens(remaining)

        apply_update_note_sources(
            note_id=self.note_id,
            content=record.content,
            tags=next_tags,
            proposed_tags=next_proposed_tags,
            token=self.token,
        )
        record_tag_sources(
            self.client_id,
            self.undo_context,
            self.note_id,
            before_tags=record.tags,
            before_proposed_tags=record.proposed_tags,
            after_tags=next_tags,
            after_proposed_tags=next_proposed_tags,
            viewport=self.viewport,
        )
        record_explicit_tag_additions(
            before_tags=record.tags,
            after_tags=next_tags,
            token=self.token,
            interacted_on=current_local_date(),
        )
        return {
            "status": "accepted",
            "tag": proposal,
            "tags": next_tags,
            "proposedTags": next_proposed_tags,
            "updateUUID": generate_new_uuid(),
        }


@dataclass(frozen=True)
class CmdRejectTagProposal(QueryCommand):
    note_id: str
    proposal: str
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdRejectTagProposal(note={self.note_id}, proposal={self.proposal})"

    def execute(self) -> Dict[str, object]:
        record = note_store.get_note(self.note_id)
        proposal = _find_proposal_token(
            proposed_tags=record.proposed_tags,
            requested_proposal=self.proposal,
        )
        remaining = tuple(
            token
            for token in _proposal_tokens(record.proposed_tags)
            if token.casefold() != proposal.casefold()
        )
        next_proposed_tags = _join_proposal_tokens(remaining)
        apply_update_note_sources(
            note_id=self.note_id,
            content=record.content,
            tags=record.tags,
            proposed_tags=next_proposed_tags,
            token=self.token,
        )
        record_tag_sources(
            self.client_id,
            self.undo_context,
            self.note_id,
            before_tags=record.tags,
            before_proposed_tags=record.proposed_tags,
            after_tags=record.tags,
            after_proposed_tags=next_proposed_tags,
            viewport=self.viewport,
        )
        return {
            "status": "rejected",
            "tag": proposal,
            "proposedTags": next_proposed_tags,
            "updateUUID": generate_new_uuid(),
        }
