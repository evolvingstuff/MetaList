"""Suggest Tags with AI for the note being edited, alone or with its children.

The request is a bulk tagging run for one note, or for it and the notes below
it: the same tag skill, instructions (tagging_run.tag_batch_messages), answer
format (TagBatchResult) and checks (validate_proposals). What differs is the
vocabulary: instead of every tag in a search, a ranked list of the tags this
request may see, the ones the tag bar would suggest for the note first, then
the most used, each with how many notes carry it. Only notes the AI may see
count or are sent, so a tag that is only on hidden notes (a blacklisted one,
say) is never sent, and a child hidden from the AI is skipped with its
children. The AI may propose new tags too; the proposal row marks them "new"
and pressing + is the user's yes.

With children, the subtree goes as one tree when it fits the tagging batch
window; otherwise the note alone and each child's subtree are trees, grouped
into batches, each given the note's text as context. Batch 1 runs first and
its new tags are offered to the others, which run four at a time, as bulk
tagging does.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass

from app.services.agent.cloud_privacy import CloudPrivacyBoundary
from app.services.agent.cloud_privacy import cloud_privacy_evaluator
from app.services.agent.cloud_privacy import visible_tag_counts
from app.services.agent.inference import InferenceAdapter
from app.services.agent.skill_settings import AgentSkill
from app.services.agent.tagging import TagBatch
from app.services.agent.tagging import partition_trees
from app.services.agent.tagging_run import infer_validated_batch
from app.services.agent.tagging_run import tag_batch_messages
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.agent.web_settings import AgentWebSettings
from app.services.content_formatting import extract_note_text_for_agent
from app.services.note_store import store as note_store
from app.services.search_index import extract_ordered_tags_for_search
from app.services.search_index import search_index
from app.services.tag_suggestions import suggest_tags_for_note


# How many of the tag bar's suggestions for the note, then of the most used tags, the AI sees.
RANKED_FOR_NOTE_LIMIT = 60
MOST_USED_LIMIT = 150
# New tags kept per note from one answer, in the AI's order; pressing + on each is still the user's choice.
MAX_NEW_TAGS = 2
# Batches after the first run this many at a time (as bulk tagging).
_PARALLEL_BATCHES = 4
# The ontology rules go after the skill and instruction system messages, before the user payload.
_RULES_MESSAGE_INDEX = 2

_REQUEST = "Suggest tags for these notes."
_VOCABULARY_SCOPE = "The accepted_vocabulary lists the user's existing tags that this request may see."
_VOCABULARY_RULES = (
    "accepted_vocabulary is ordered by relevance to the edited note first, then by use; "
    "accepted_vocabulary_note_counts gives how many notes carry each tag, in the same order. "
    "Strongly prefer existing tags. Propose a new tag only when no existing tag fits, "
    f"and at most {MAX_NEW_TAGS} new tags per note."
)
_ONE_NOTE_RULES = (
    "This request tags the one note in result_trees, which the user is editing. ancestors are "
    "the notes above it, top first, for context only: never return their note IDs, and do not "
    "repeat their tags. " + _VOCABULARY_RULES
)
_SUBTREE_RULES = (
    "This request tags the notes in result_trees: the note the user is editing and notes below "
    "it (children nested under their parent; a batch may hold only some of them). ancestors are "
    "the notes above them, top first, for context only: never return their note IDs, and do not "
    "repeat their tags. Tags inherit from parents to children, so put a tag on the parent when it "
    "fits the whole group. " + _VOCABULARY_RULES
)


@dataclass(frozen=True, slots=True)
class NoteTagRequest:
    note_id: str
    # Every note the AI may tag in this request.
    note_ids: frozenset[str]
    batches: tuple[TagBatch, ...]
    # Context above each batch's trees, top first.
    ancestors_by_batch: tuple[tuple[dict[str, object], ...], ...]
    vocabulary: tuple[tuple[str, int], ...]
    rules: str
    tag_skill: AgentSkill
    # The tags on notes the AI may see (cloud_privacy.visible_tag_counts).
    visible_vocabulary: dict[str, str]


@dataclass(frozen=True, slots=True)
class _OneNoteRun:
    """The fields of a chat run that the tagging inference helpers read."""
    base_url: str
    selected_model: str
    thinking_level: str
    web_settings: AgentWebSettings
    session_key: str
    run_id: str


def ranked_vocabulary(*, note_id: str, boundary: CloudPrivacyBoundary) -> tuple[tuple[str, int], ...]:
    """(tag, notes carrying it) the AI may see: the tag bar's ranking for the note, then by use."""
    display, counts = visible_tag_counts(boundary)
    record = note_store.get_note(note_id)
    own_tags = [term for term in extract_ordered_tags_for_search(record.tags) if not term.startswith("@")]
    own_keys = {term.casefold() for term in own_tags}
    ranked_for_note = suggest_tags_for_note(
        note_id=note_id, anchors=own_tags, explicit_tags=own_tags, prefix="",
        content_html=record.content, limit=RANKED_FOR_NOTE_LIMIT, include_already_applying=False,
    )
    most_used = sorted(counts, key=lambda key: (-counts[key], key))[:MOST_USED_LIMIT]
    vocabulary: dict[str, tuple[str, int]] = {}
    for key in [tag.casefold() for tag in ranked_for_note] + most_used:
        if key in counts and key not in own_keys and key not in vocabulary:
            vocabulary[key] = (display[key], counts[key])
    return tuple(vocabulary.values())


def _note_text(note_id: str) -> dict[str, object]:
    record = note_store.get_note(note_id)
    content, redacted = extract_note_text_for_agent(content_html=record.content, tags=record.tags)
    assert not redacted, "A note the AI may see is never password protected"
    return {"content_text": content, "tags": list(extract_ordered_tags_for_search(record.tags))}


def _note_node(note_id: str) -> dict[str, object]:
    return {"note_id": note_id, **_note_text(note_id),
            "proposed_tags": list(note_store.get_note(note_id).proposed_tags.split())}


def _subtree_node(note_id: str, scope_note_ids: frozenset[str], hidden: frozenset[str]) -> dict[str, object]:
    """The note with its children the view shows and the AI may see, nested."""
    node = _note_node(note_id)
    children = [
        _subtree_node(child, scope_note_ids, hidden)
        for child in note_store.get_children(note_id) if child in scope_note_ids and child not in hidden
    ]
    if children:
        node["children"] = children
    return node


def _node_note_ids(node: dict[str, object]) -> list[str]:
    ids = [node["note_id"]]
    if "children" in node:
        for child in node["children"]:
            ids.extend(_node_note_ids(child))
    return ids


def _batch_payload_tokens(trees: tuple[dict, ...], ancestors: tuple, vocabulary: tuple[tuple[str, int], ...]) -> int:
    return estimate_input_tokens({
        "result_trees": list(trees), "ancestors": list(ancestors),
        "accepted_vocabulary": [tag for tag, _count in vocabulary],
        "accepted_vocabulary_note_counts": [count for _tag, count in vocabulary],
    })


def build_note_tag_request(
    *, note_id: str, include_children: bool, boundary: CloudPrivacyBoundary, tag_skill: AgentSkill,
    scope_note_ids: frozenset[str], batch_tokens: int,
) -> NoteTagRequest:
    """The request for a note (and its children); the caller has checked the AI may see the note."""
    assert cloud_privacy_evaluator.exclusion_reason(note_id=note_id, boundary=boundary) == ""
    assert batch_tokens > 0
    record = note_store.get_note(note_id)
    ancestors: list[dict[str, object]] = []
    parent_id = record.parent_id
    while parent_id is not None:
        ancestors.append(_note_text(parent_id))
        parent_id = note_store.get_note(parent_id).parent_id
    ancestors.reverse()
    vocabulary = ranked_vocabulary(note_id=note_id, boundary=boundary)
    words = tuple(tag for tag, _count in vocabulary)

    if include_children:
        hidden = cloud_privacy_evaluator.hidden_note_ids(
            note_ids=tuple(note_store.list_note_ids()), boundary=boundary,
        )
        whole = _subtree_node(note_id, scope_note_ids, hidden)
        note_ids = frozenset(_node_note_ids(whole))
        if _batch_payload_tokens((whole,), tuple(ancestors), vocabulary) <= batch_tokens:
            groups = (((whole,), tuple(ancestors)),)
        else:
            # Too big for one batch: the note alone, then each child's subtree.
            alone = {key: value for key, value in whole.items() if key != "children"}
            trees = (alone, *whole["children"])
            with_note = (*ancestors, _note_text(note_id))
            groups = tuple(
                (batch.trees, tuple(ancestors) if alone in batch.trees else with_note)
                for batch in partition_trees(trees, batch_tokens)
            )
        rules = _SUBTREE_RULES
    else:
        note_ids = frozenset({note_id})
        groups = (((_note_node(note_id),), tuple(ancestors)),)
        rules = _ONE_NOTE_RULES

    batches = tuple(
        TagBatch(trees=trees, note_ids=frozenset(id for tree in trees for id in _node_note_ids(tree)),
                 vocabulary=words, tokens=_batch_payload_tokens(trees, context, vocabulary))
        for trees, context in groups
    )
    assert frozenset().union(*(batch.note_ids for batch in batches)) == note_ids
    return NoteTagRequest(
        note_id=note_id, note_ids=note_ids, batches=batches,
        ancestors_by_batch=tuple(context for _trees, context in groups),
        vocabulary=vocabulary, rules=rules, tag_skill=tag_skill,
        visible_vocabulary=visible_tag_counts(boundary)[0],
    )


def request_messages(request: NoteTagRequest, index: int, prior_batch_new_tags: tuple[str, ...]) -> list[dict[str, str]]:
    """Batch `index`'s messages, built with the production tagging instructions."""
    user_payload = {
        "request": _REQUEST,
        "tagging_mode": "new",
        "result_trees": list(request.batches[index].trees),
        "ancestors": list(request.ancestors_by_batch[index]),
        "accepted_vocabulary": [tag for tag, _count in request.vocabulary],
        "accepted_vocabulary_note_counts": [count for _tag, count in request.vocabulary],
        "prior_batch_new_tags": list(prior_batch_new_tags),
    }
    messages = tag_batch_messages(
        tag_skill=request.tag_skill, vocabulary_scope=_VOCABULARY_SCOPE, focus="both", user_payload=user_payload,
    )
    messages.insert(_RULES_MESSAGE_INDEX, {"role": "system", "content": request.rules})
    return messages


def keep_new_tags_up_to_limit(*, tags: tuple[str, ...], visible_vocabulary: dict[str, str]) -> tuple[str, ...]:
    """The AI's tags for one note in its order, with at most MAX_NEW_TAGS tags no note the AI may see has yet."""
    kept = []
    new_count = 0
    for tag in tags:
        if tag.casefold() not in visible_vocabulary:
            if new_count == MAX_NEW_TAGS:
                continue
            new_count += 1
        kept.append(tag)
    return tuple(kept)


async def suggest_note_tags(
    *, request: NoteTagRequest, inference: InferenceAdapter, base_url: str, model: str,
    thinking_level: str, web_settings: AgentWebSettings, session_key: str, run_id: str,
) -> AsyncIterator[dict[str, object]]:
    """Ask the AI, batch by batch, recording each attempt under the trace run `run_id`
    (agent_trace_store.start_run). Yields {"type": "progress", "completed", "total"} as
    batches finish, then {"type": "proposals", "proposals": {note_id: [tags]}}.
    InferenceProviderError when it cannot answer usefully."""
    run = _OneNoteRun(
        base_url=base_url, selected_model=model, thinking_level=thinking_level,
        web_settings=web_settings, session_key=session_key, run_id=run_id,
    )
    context = await inference.inspect_context_window(base_url=base_url, model=model)
    total = len(request.batches)

    async def infer_batch(index: int, prior_batch_new_tags: tuple[str, ...]) -> dict[str, tuple[str, ...]]:
        return await infer_validated_batch(
            inference, run, request_messages(request, index, prior_batch_new_tags), request.batches[index],
            request.note_ids, "new", context.loaded_tokens, request.visible_vocabulary,
        )

    yield {"type": "progress", "completed": 0, "total": total}
    results = [await infer_batch(0, ())]
    yield {"type": "progress", "completed": 1, "total": total}
    first_new_tags = tuple(dict.fromkeys(
        tag for tags in results[0].values() for tag in tags if tag.casefold() not in request.visible_vocabulary
    ))
    semaphore = asyncio.Semaphore(_PARALLEL_BATCHES)

    async def infer_later(index: int) -> dict[str, tuple[str, ...]]:
        async with semaphore:
            return await infer_batch(index, first_new_tags)

    tasks = [asyncio.create_task(infer_later(index)) for index in range(1, total)]
    try:
        for completed in asyncio.as_completed(tasks):
            results.append(await completed)
            yield {"type": "progress", "completed": len(results), "total": total}
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    proposals: dict[str, list[str]] = {}
    for validated in results:
        for proposed_note_id, tags in validated.items():
            assert proposed_note_id in request.note_ids and proposed_note_id not in proposals
            kept = keep_new_tags_up_to_limit(tags=tags, visible_vocabulary=request.visible_vocabulary)
            if kept:
                proposals[proposed_note_id] = list(kept)
    yield {"type": "proposals", "proposals": proposals}
