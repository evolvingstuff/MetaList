"""Pure contracts and planning for evidence-bounded tag proposal passes."""

from __future__ import annotations

import random
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field

from app.services.agent.token_estimation import estimate_input_tokens
from app.services.tag_ontology import is_valid_proposal_token, is_valid_tag_token
from app.services.tag_properties import tag_part_of_token


TAGGING_POLICY_KEY = "pref.ai.tagging.vocabulary"
TAGGING_FOCUS_KEY = "pref.ai.tagging.focus"
# Divisor for a binary-search midpoint.
_HALF = 2
# A proposal is rejected when more than this share of its entries or tags is invalid.
_MAX_INVALID_PERCENT = 10
_PERCENT_SCALE = 100
# A rejection names at most this many of the invalid entries or tags.
_MAX_REPORTED_INVALID = 5
# The model may propose at most this many tags for one note.
_MAX_TAGS_PER_NOTE = 12


class NoteTagProposal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    note_id: str = Field(..., min_length=1)
    tags: list[str] = Field(..., max_length=_MAX_TAGS_PER_NOTE)


class TagBatchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    proposals: list[NoteTagProposal]


@dataclass(frozen=True)
class TagBatch:
    trees: tuple[dict, ...]
    note_ids: frozenset[str]
    vocabulary: tuple[str, ...]
    tokens: int


def tree_notes(tree: dict) -> list[dict]:
    notes = []
    stack = [tree]
    while stack:
        node = stack.pop()
        notes.append(node)
        # Serialized trees leave out an empty children list.
        if "children" in node:
            stack.extend(reversed(node["children"]))
    return notes


def make_batch(trees: tuple[dict, ...]) -> TagBatch:
    notes = [note for tree in trees for note in tree_notes(tree)]
    vocabulary = {}
    for note in notes:
        for token in note["tags"]:
            # A super tag's tag (jogging for jogging:miles=3) is vocabulary; its values are not.
            tag = tag_part_of_token(token)
            if is_valid_tag_token(tag) and not tag.startswith("@"):
                if tag.casefold() not in vocabulary:
                    vocabulary[tag.casefold()] = tag
    words = tuple(vocabulary.values())
    payload = {"result_trees": trees, "accepted_vocabulary": words}
    return TagBatch(trees, frozenset(note["note_id"] for note in notes), words, estimate_input_tokens(payload))


def leading_tree_count_within_budget(trees: tuple[dict, ...], budget: int) -> int:
    """Return how many leading canonical-order trees fit in one evidence payload."""
    assert budget > 0
    fitting, too_many = 0, len(trees) + 1
    # Serialized size grows with every added root, so binary search the prefix length.
    while too_many - fitting > 1:
        candidate = (fitting + too_many) // _HALF
        if make_batch(trees[:candidate]).tokens <= budget:
            fitting = candidate
        else:
            too_many = candidate
    return fitting


def shuffle_trees_for_batches(trees: tuple[dict, ...]) -> tuple[dict, ...]:
    shuffled = list(trees)
    random.shuffle(shuffled)
    return tuple(shuffled)


def partition_trees(trees: tuple[dict, ...], budget: int) -> tuple[TagBatch, ...]:
    """Token-sized batches share vocabulary computed over the whole disclosed scope."""
    assert budget > 0
    if not trees:
        return ()
    complete = make_batch(trees)
    if complete.tokens <= budget:
        return (complete,)
    vocabulary = complete.vocabulary
    def assemble(roots):
        note_ids = frozenset(note["note_id"] for root in roots for note in tree_notes(root))
        tokens = estimate_input_tokens({"result_trees": roots, "accepted_vocabulary": vocabulary})
        return TagBatch(tuple(roots), note_ids, vocabulary, tokens)
    overhead = assemble(()).tokens
    batches = []
    current = []
    current_tokens = overhead
    for root in trees:
        root_tokens = estimate_input_tokens(root) + 1
        if current and current_tokens + root_tokens > budget:
            batches.append(assemble(current))
            current = []
            current_tokens = overhead
        current.append(root)
        current_tokens += root_tokens
    if current:
        batches.append(assemble(current))
    assert sum(len(batch.trees) for batch in batches) == len(trees)
    return tuple(batches)


def validate_proposals(
    result: TagBatchResult,
    batch: TagBatch,
    scope_note_ids: frozenset[str],
    policy: str,
    visible_vocabulary: dict[str, str],
) -> dict[str, tuple[str, ...]]:
    """The batch's valid proposals. What the model is told about an invalid one
    depends only on what it was shown: `scope_note_ids` are the notes the request
    sends it, and `visible_vocabulary` the tags on notes it may see
    (cloud_privacy.visible_tag_counts), so a private note's ID or a tag found only
    on private notes is answered exactly like an invented one."""
    assert policy in {"existing", "new", "new_only"}
    assert batch.note_ids <= scope_note_ids
    vocabulary = {tag.casefold(): tag for tag in batch.vocabulary}
    proposals = {}
    seen_notes = set()
    invalid_entries = []
    invalid_tags = []
    total_entries = len(result.proposals)
    total_assignments = 0
    for proposal in result.proposals:
        if proposal.note_id not in batch.note_ids:
            if proposal.note_id in scope_note_ids:
                invalid_entries.append(
                    f"Note ID belongs to a different batch within the permitted scope: "
                    f"{proposal.note_id!r}"
                )
            else:
                invalid_entries.append(
                    f"Nonexistent note ID: "
                    f"{proposal.note_id!r}"
                )
            continue
        if proposal.note_id in seen_notes:
            invalid_entries.append(f"Duplicate note ID: {proposal.note_id!r}")
            continue
        seen_notes.add(proposal.note_id)
        tags = {}
        unique_tags = {tag.casefold(): tag for tag in proposal.tags}
        total_assignments += len(unique_tags)
        for key, tag in unique_tags.items():
            if (
                policy == "new_only"
                and key in visible_vocabulary
                and key not in vocabulary
            ):
                # The visible tags outside accepted_vocabulary were not sent. A
                # collision with one is unknowable to the model, so omit it without
                # charging it against the repair threshold.
                continue
            reason = invalid_tag_reason(tag, visible_vocabulary, policy)
            if reason:
                invalid_tags.append(reason)
                continue
            tags[key] = tag
            if key in vocabulary:
                tags[key] = vocabulary[key]
            elif key in visible_vocabulary:
                tags[key] = visible_vocabulary[key]
        if tags:
            proposals[proposal.note_id] = tuple(tags.values())
    errors = []
    if len(invalid_entries) * _PERCENT_SCALE > total_entries * _MAX_INVALID_PERCENT:
        details = "; ".join(invalid_entries[:_MAX_REPORTED_INVALID])
        errors.append(
            f"{len(invalid_entries)} of {total_entries} proposal entries have invalid note IDs, "
            f"exceeding {_MAX_INVALID_PERCENT}%: {details}"
        )
    if len(invalid_tags) * _PERCENT_SCALE > total_assignments * _MAX_INVALID_PERCENT:
        details = "; ".join(invalid_tags[:_MAX_REPORTED_INVALID])
        errors.append(
            f"{len(invalid_tags)} of {total_assignments} tag assignments are invalid, "
            f"exceeding {_MAX_INVALID_PERCENT}%: {details}"
        )
    if errors:
        raise ValueError("; ".join(errors))
    return proposals


def invalid_tag_reason(
    tag: str,
    visible_vocabulary: dict[str, str],
    policy: str,
) -> str:
    if not is_valid_proposal_token(tag):
        return f"Invalid classification tag or super tag: {tag!r}"
    # The pass's policy is about the tag; a super tag's values are not tags.
    key = tag_part_of_token(tag).casefold()
    if policy == "existing" and key not in visible_vocabulary:
        return f"Tag does not exist in the vault: {tag!r}"
    if policy == "new_only" and key in visible_vocabulary:
        return f"Model proposed an existing tag during a new-tags-only pass: {tag!r}"
    return ""
