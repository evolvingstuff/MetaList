from __future__ import annotations

from dataclasses import dataclass
from typing import Dict

from app.services.content_formatting import _tokenize_tag_bar
from app.services.note_store import store as note_store
from app.services.ontology_rules_store import get_ontology
from app.services.search_history import current_local_date, record_explicit_tag_additions
from app.services.sync import generate_new_uuid
import re

from app.services.content_formatting import _unwrap_tag_token
from app.services.search_index import tag_bar_values
from app.services.tag_ontology import is_valid_proposal_token
from app.services.tag_properties import (
    PROPERTY_ASSIGNMENT,
    PROPERTY_SEPARATOR,
    has_property_syntax,
    split_property_segments,
    tag_part_of_token,
)
from app.services.tag_plural_variants import PluralSpellings
from app.services.undo_state import record_collapse_batch
from app.services.undo_state import record_tag_sources
from app.services.undo_state import record_tag_sources_batch
from app.usecases.collapse import apply_set_collapse_bulk
from app.usecases.base import QueryCommand
from app.usecases.update_content import apply_update_note_sources
from app.utils.text_utils import strip_html


def _proposal_tokens(proposed_tags: str) -> tuple[str, ...]:
    if not isinstance(proposed_tags, str):
        raise TypeError("proposed_tags must be a string")
    tokens = tuple(proposed_tags.split())
    for token in tokens:
        if not is_valid_proposal_token(token):
            raise RuntimeError(f"Stored proposal is not a valid tag or super tag: {token!r}")
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


def is_new_proposal(*, tag: str, seen: set[str]) -> bool:
    """A proposal says something new unless the note has it or proposes it already,
    in any case or as its singular or plural (`eggs` beside `egg`)."""
    assert all(key == key.casefold() for key in seen)
    return tag.casefold() not in seen and not PluralSpellings(seen).covers(tag)


def _tag_name(token: str) -> str:
    """The tag a token names, without values, casefolded: jogging for jogging=3:miles=3."""
    return tag_part_of_token(token).split(PROPERTY_ASSIGNMENT, 1)[0].casefold()


def proposal_says_something_new(*, proposal: str, seen: set[str], pending: list[str], tags: str) -> bool:
    """Whether a proposal adds to a note (docs/design/tag-properties.md). A plain tag as
    is_new_proposal says. A super tag (jogging:miles=3) when it gives a value the note's
    own token for that tag lacks, and no proposal for that tag is pending."""
    if not has_property_syntax(proposal):
        return is_new_proposal(tag=proposal, seen=seen)
    name = _tag_name(proposal)
    if any(_tag_name(token) == name for token in pending):
        return False
    _own_names, own_values = tag_bar_values(tags)
    _proposal_names, proposal_values = tag_bar_values(proposal)
    return any(key not in own_values for key in proposal_values)


def merge_accepted_proposals(tags: str, proposals: tuple[str, ...]) -> str:
    """The tag bar with accepted proposals in it. A tag the note carries is not added
    again: a super tag's new values join the note's token for its tag (jogging becomes
    jogging:miles=3), values it has stay as they are; anything else is appended."""
    next_tags = tags
    for proposal in proposals:
        own = _own_token_for_tag(next_tags, _tag_name(proposal))
        if own is None:
            next_tags = " ".join(part for part in (next_tags.strip(), proposal) if part)
            continue
        if not has_property_syntax(proposal):
            continue
        _own_names, own_values = tag_bar_values(own)
        additions = [
            segment for segment in split_property_segments(proposal[len(tag_part_of_token(proposal)) + 1:])
            if (_tag_name(own), segment.partition(PROPERTY_ASSIGNMENT)[0].casefold()) not in own_values
        ]
        if additions:
            next_tags = _replace_own_token(next_tags, own, PROPERTY_SEPARATOR.join([own, *additions]))
    return next_tags


_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def _replace_own_token(tags: str, own: str, merged: str) -> str:
    """The tag bar with its token `own` (outside /* comments */) written as `merged`."""
    comments = [match.span() for match in _COMMENT_RE.finditer(tags)]
    for match in re.finditer(rf"(?<!\S){re.escape(own)}(?!\S)", tags):
        if not any(start <= match.start() < end for start, end in comments):
            return tags[: match.start()] + merged + tags[match.end():]
    raise RuntimeError(f"The tag bar's token {own!r} was not found to merge into")


def _own_token_for_tag(tags: str, name: str) -> str | None:
    """The tag bar's own token for a tag (plain, valued or super), or None."""
    for token in _tokenize_tag_bar(tags):
        base, wrapper = _unwrap_tag_token(token)
        if wrapper is None and not base.startswith("@") and _tag_name(base) == name:
            return base
    return None


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
        next_tags = merge_accepted_proposals(record.tags, (proposal,))
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
    """Add the AI's proposals to a note and maybe notes below it (Suggest Tags with
    AI), one undo step.

    Tags a note already has, through its tag bar, a parent or a rule, and tags
    already proposed are left out, also as their singular or plural.
    """
    note_id: str
    # note id -> the AI's tags for it, in its order.
    proposals: Dict[str, tuple[str, ...]]
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, object]:
        assert isinstance(self.proposals, dict) and len(self.proposals) > 0
        for target_id, tags in self.proposals.items():
            assert isinstance(tags, tuple) and len(tags) > 0
            if not note_store.has_note(target_id):
                raise KeyError(f"Proposal target note not found: {target_id}")
            for tag in tags:
                if not is_valid_proposal_token(tag):
                    raise ValueError(f"AI tag proposals must be tags or super tags: {tag!r}")
        changes = []
        added: Dict[str, list[str]] = {}
        for target_id, tags in self.proposals.items():
            record = note_store.get_note(target_id)
            pending = list(_proposal_tokens(record.proposed_tags))
            seen = {token.casefold() for token in pending} | _effective_accepted_tag_keys(target_id)
            new_tags: list[str] = []
            for tag in tags:
                if proposal_says_something_new(proposal=tag, seen=seen, pending=[*pending, *new_tags], tags=record.tags):
                    new_tags.append(tag)
                    seen.add(tag.casefold())
            if not new_tags:
                continue
            added[target_id] = new_tags
            changes.append({
                "note_id": target_id,
                "before_tags": record.tags, "before_proposed_tags": record.proposed_tags,
                "after_tags": record.tags, "after_proposed_tags": _join_proposal_tokens((*pending, *new_tags)),
            })
        if not changes:
            return {"status": "unchanged", "added": {}, "addedCount": 0}
        for change in changes:
            apply_update_note_sources(
                note_id=change["note_id"],
                content=note_store.get_note(change["note_id"]).content,
                tags=change["after_tags"],
                proposed_tags=change["after_proposed_tags"],
                token=self.token,
            )
        record_tag_sources_batch(
            self.client_id, self.undo_context, self.note_id, changes=changes, viewport=self.viewport,
        )
        return {
            "status": "added",
            "added": added,
            "addedCount": sum(len(tags) for tags in added.values()),
            "updateUUID": generate_new_uuid(),
        }


# The robot count on a note (🤖 N): its own proposals, and while it is collapsed
# those of its descendants the view shows, as the snapshot counts them
# (snapshot.count_proposals_in_subtree). Clicking it opens the way to them;
# its menu accepts or rejects all of them (docs/ui/tag-bar.md).

def _view_subtree_note_ids(note_id: str, scope_note_ids: frozenset[str]) -> list[str]:
    """The note and, through children the view shows, its descendants, in outline order."""
    ordered = []
    pending = [note_id]
    while pending:
        current = pending.pop()
        ordered.append(current)
        pending.extend(reversed([child for child in note_store.get_children(current) if child in scope_note_ids]))
    return ordered


def robot_counted_note_ids(*, note_id: str, includes_hidden_children: bool, scope_note_ids: frozenset[str]) -> list[str]:
    """The notes whose proposals a robot count covers."""
    if not includes_hidden_children:
        return [note_id]
    if not note_store.get_note(note_id).is_collapsed:
        raise RuntimeError(f"A robot count includes hidden children only on a collapsed note: {note_id}")
    return _view_subtree_note_ids(note_id, scope_note_ids)


def notes_to_open_for_proposals(*, note_id: str, scope_note_ids: frozenset[str]) -> list[str]:
    """Collapsed notes from note_id down to every descendant with proposals, so each
    shows its own robot; empty when no descendant the view shows has any."""
    has_proposals_below: dict[str, bool] = {}
    for current in reversed(_view_subtree_note_ids(note_id, scope_note_ids)):
        children = [child for child in note_store.get_children(current) if child in scope_note_ids]
        has_proposals_below[current] = any(
            len(note_store.get_note(child).proposed_tag_terms) > 0 or has_proposals_below[child] for child in children
        )
    return [
        current for current in _view_subtree_note_ids(note_id, scope_note_ids)
        if has_proposals_below[current] and note_store.get_note(current).is_collapsed
    ]


@dataclass(frozen=True)
class CmdOpenToTagProposals(QueryCommand):
    """Press on a collapsed note's robot: open the way to every proposal it counts (one
    undo step) and name the note to edit, the highest one with proposals of its own."""
    note_id: str
    scope_note_ids: frozenset[str]
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, object]:
        assert self.note_id in self.scope_note_ids
        # The note to edit: the highest one with proposals of its own, in outline order.
        with_proposals = [
            note_id for note_id in _view_subtree_note_ids(self.note_id, self.scope_note_ids)
            if len(note_store.get_note(note_id).proposed_tag_terms) > 0
        ]
        if not with_proposals:
            # The robot was out of date (its proposals were resolved elsewhere): edit the note itself.
            with_proposals = [self.note_id]
        note_ids = notes_to_open_for_proposals(note_id=self.note_id, scope_note_ids=self.scope_note_ids)
        if not note_ids:
            return {"status": "unchanged", "openedNoteIds": [], "editNoteId": with_proposals[0]}
        apply_set_collapse_bulk(note_ids, False)
        record_collapse_batch(
            self.client_id, self.undo_context, self.note_id,
            note_ids=note_ids, collapsed=False, viewport=self.viewport,
        )
        return {
            "status": "opened", "openedNoteIds": note_ids, "editNoteId": with_proposals[0],
            "updateUUID": generate_new_uuid(),
        }


@dataclass(frozen=True)
class CmdResolveRobotProposals(QueryCommand):
    """Accept or reject all the proposals a robot counts, one undo step."""
    note_id: str
    action: str
    includes_hidden_children: bool
    scope_note_ids: frozenset[str]
    token: str
    client_id: str
    undo_context: str
    viewport: Dict[str, object]

    def execute(self) -> Dict[str, object]:
        assert self.action in {"accept", "reject"}
        assert self.note_id in self.scope_note_ids
        note_ids = robot_counted_note_ids(
            note_id=self.note_id, includes_hidden_children=self.includes_hidden_children,
            scope_note_ids=self.scope_note_ids,
        )
        changes = []
        resolved_count = 0
        for note_id in note_ids:
            record = note_store.get_note(note_id)
            pending = _proposal_tokens(record.proposed_tags)
            if not pending:
                continue
            next_tags = record.tags
            if self.action == "accept":
                next_tags = merge_accepted_proposals(record.tags, pending)
            changes.append({
                "note_id": note_id,
                "before_tags": record.tags, "before_proposed_tags": record.proposed_tags,
                "after_tags": next_tags, "after_proposed_tags": "",
            })
            resolved_count += len(pending)
        if not changes:
            return {"status": "unchanged", "resolvedCount": 0, "noteIds": []}
        for change in changes:
            apply_update_note_sources(
                note_id=change["note_id"],
                content=note_store.get_note(change["note_id"]).content,
                tags=change["after_tags"],
                proposed_tags="",
                token=self.token,
            )
            if self.action == "accept":
                record_explicit_tag_additions(
                    before_tags=change["before_tags"],
                    after_tags=change["after_tags"],
                    token=self.token,
                    interacted_on=current_local_date(),
                )
        record_tag_sources_batch(
            self.client_id, self.undo_context, self.note_id, changes=changes, viewport=self.viewport,
        )
        return {
            "status": "accepted" if self.action == "accept" else "rejected",
            "resolvedCount": resolved_count,
            "noteIds": [change["note_id"] for change in changes],
            "updateUUID": generate_new_uuid(),
        }
