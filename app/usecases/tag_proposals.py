from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.services.content_formatting import _tokenize_tag_bar
from app.services.note_store import store as note_store
from app.services.ontology_rules_store import get_ontology
from app.services.search_history import current_local_date, record_explicit_tag_additions
from app.services.sync import generate_new_uuid
from app.services.tag_ontology import is_valid_tag_token
from app.services.undo_state import record_tag_sources
from app.usecases.base import QueryCommand
from app.usecases.update_content import apply_update_note_sources
from app.utils.text_utils import strip_html


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


@dataclass(frozen=True)
class CmdAddTagProposals(QueryCommand):
    """Add the AI's proposals to one note (Suggest Tags with AI), undoable like accepting one.

    Tags the note already has, through its tag bar, a parent or a rule, and
    tags already proposed are left out.
    """
    note_id: str
    tags: tuple[str, ...]
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def describe(self) -> str:
        return f"CmdAddTagProposals(note={self.note_id}, tags={len(self.tags)})"

    def execute(self) -> Dict[str, object]:
        assert isinstance(self.tags, tuple) and len(self.tags) > 0
        for tag in self.tags:
            if not is_valid_tag_token(tag) or tag.startswith("@"):
                raise ValueError(f"AI tag proposals must be plain tags: {tag!r}")
        record = note_store.get_note(self.note_id)
        pending = list(_proposal_tokens(record.proposed_tags))
        seen = {token.casefold() for token in pending} | _effective_accepted_tag_keys(self.note_id)
        added = []
        for tag in self.tags:
            if tag.casefold() not in seen:
                added.append(tag)
                seen.add(tag.casefold())
        if not added:
            return {"status": "unchanged", "added": [], "proposedTags": record.proposed_tags}
        next_proposed_tags = _join_proposal_tokens((*pending, *added))
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
            "status": "added",
            "added": added,
            "proposedTags": next_proposed_tags,
            "updateUUID": generate_new_uuid(),
        }
