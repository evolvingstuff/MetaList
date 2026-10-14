"""Suggest Tags with AI for the one note being edited.

The request is a bulk tagging batch for a single note: the same tag skill,
instructions (tagging_run.tag_batch_messages), answer format (TagBatchResult)
and checks (validate_proposals). What differs is the vocabulary: instead of
every tag in a search, a ranked list of the tags this request may see, the ones
the tag bar would suggest for this note first, then the most used, each with how
many notes carry it. Only notes the AI may see count, so a tag that is only on
hidden notes (a blacklisted one, say) is never sent. The AI may propose new tags
too; the proposal row marks them "new" and pressing + is the user's yes.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from uuid import uuid4

from app.services.agent.cloud_privacy import CloudPrivacyBoundary
from app.services.agent.cloud_privacy import cloud_privacy_evaluator
from app.services.agent.inference import InferenceAdapter
from app.services.agent.skill_settings import AgentSkill
from app.services.agent.tagging import TagBatch
from app.services.agent.tagging_run import infer_validated_batch
from app.services.agent.tagging_run import tag_batch_messages
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.agent.web_settings import AgentWebSettings
from app.services.content_formatting import extract_note_text_for_agent
from app.services.note_store import store as note_store
from app.services.search_index import extract_ordered_tags_for_search
from app.services.search_index import search_index
from app.services.tag_case import build_preferred_tag_case_map
from app.services.tag_ontology import is_valid_tag_token
from app.services.tag_suggestions import suggest_tags_for_note


# How many of the tag bar's suggestions for the note, then of the most used tags, the AI sees.
RANKED_FOR_NOTE_LIMIT = 60
MOST_USED_LIMIT = 150
# New tags kept from one answer, in the AI's order; pressing + on each is still the user's choice.
MAX_NEW_TAGS = 2

_REQUEST = "Suggest tags for this note."
_VOCABULARY_SCOPE = "The accepted_vocabulary lists the user's existing tags that this request may see."
_ONE_NOTE_RULES = (
    "This request tags the one note in result_trees, which the user is editing. ancestors are "
    "the notes above it, top first, for context only: never return their note IDs, and do not "
    "repeat their tags. accepted_vocabulary is ordered by relevance to this note first, then by "
    "use; accepted_vocabulary_note_counts gives how many notes carry each tag, in the same "
    "order. Strongly prefer existing tags. Propose a new tag only when no existing tag fits, "
    f"and at most {MAX_NEW_TAGS} new tags."
)


@dataclass(frozen=True, slots=True)
class NoteTagRequest:
    note_id: str
    messages: list[dict[str, str]]
    batch: TagBatch
    namespace_vocabulary: dict[str, str]


@dataclass(frozen=True, slots=True)
class _OneNoteRun:
    """The fields of a chat run that the tagging inference helpers read."""
    base_url: str
    selected_model: str
    thinking_level: str
    web_settings: AgentWebSettings
    session_key: str
    run_id: str


def _visible_tag_counts(boundary: CloudPrivacyBoundary) -> tuple[dict[str, str], Counter[str]]:
    """Display case and note count of each tag on notes the AI may see, by casefold."""
    note_ids = tuple(note_store.list_note_ids())
    hidden = cloud_privacy_evaluator.hidden_note_ids(note_ids=note_ids, boundary=boundary)
    exact_counts: Counter[str] = Counter()
    for note_id in note_ids:
        if note_id in hidden:
            continue
        for term in note_store.get_note(note_id).tag_terms:
            if is_valid_tag_token(term) and not term.startswith("@"):
                exact_counts[term] += 1
    display = build_preferred_tag_case_map(dict(exact_counts))
    counts: Counter[str] = Counter()
    for term, count in exact_counts.items():
        counts[term.casefold()] += count
    blacklisted = {tag.casefold() for tag in boundary.policy.blacklist_tags}
    assert not (counts.keys() & blacklisted) or not boundary.apply_cloud_policy, \
        "A note carrying a blacklisted tag is hidden, so its tags are never counted"
    return display, counts


def ranked_vocabulary(*, note_id: str, boundary: CloudPrivacyBoundary) -> tuple[tuple[str, int], ...]:
    """(tag, notes carrying it) the AI may see: the tag bar's ranking for the note, then by use."""
    display, counts = _visible_tag_counts(boundary)
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


def build_note_tag_request(*, note_id: str, boundary: CloudPrivacyBoundary, tag_skill: AgentSkill) -> NoteTagRequest:
    """The request for one note; the caller has checked the AI may see it."""
    assert cloud_privacy_evaluator.exclusion_reason(note_id=note_id, boundary=boundary) == ""
    record = note_store.get_note(note_id)
    ancestors = []
    parent_id = record.parent_id
    while parent_id is not None:
        ancestors.append(_note_text(parent_id))
        parent_id = note_store.get_note(parent_id).parent_id
    ancestors.reverse()
    note_node = {"note_id": note_id, **_note_text(note_id), "proposed_tags": list(record.proposed_tags.split())}
    vocabulary = ranked_vocabulary(note_id=note_id, boundary=boundary)
    user_payload = {
        "request": _REQUEST,
        "tagging_mode": "new",
        "result_trees": [note_node],
        "ancestors": ancestors,
        "accepted_vocabulary": [tag for tag, _count in vocabulary],
        "accepted_vocabulary_note_counts": [count for _tag, count in vocabulary],
        "prior_batch_new_tags": [],
    }
    messages = tag_batch_messages(
        tag_skill=tag_skill, vocabulary_scope=_VOCABULARY_SCOPE, focus="both", user_payload=user_payload,
    )
    messages.insert(2, {"role": "system", "content": _ONE_NOTE_RULES})
    batch = TagBatch(
        trees=(note_node,), note_ids=frozenset({note_id}),
        vocabulary=tuple(tag for tag, _count in vocabulary), tokens=estimate_input_tokens(user_payload),
    )
    return NoteTagRequest(
        note_id=note_id, messages=messages, batch=batch,
        namespace_vocabulary=build_preferred_tag_case_map(search_index.list_explicit_tag_frequencies()),
    )


def keep_new_tags_up_to_limit(*, tags: tuple[str, ...], namespace_vocabulary: dict[str, str]) -> tuple[str, ...]:
    """The AI's tags in its order, with at most MAX_NEW_TAGS tags no note has yet."""
    kept = []
    new_count = 0
    for tag in tags:
        if tag.casefold() not in namespace_vocabulary:
            if new_count == MAX_NEW_TAGS:
                continue
            new_count += 1
        kept.append(tag)
    return tuple(kept)


async def suggest_note_tags(
    *, request: NoteTagRequest, inference: InferenceAdapter, base_url: str, model: str,
    thinking_level: str, web_settings: AgentWebSettings, session_key: str,
) -> tuple[str, ...]:
    """Ask the AI for the note's tags; InferenceProviderError when it cannot answer usefully."""
    run = _OneNoteRun(
        base_url=base_url, selected_model=model, thinking_level=thinking_level,
        web_settings=web_settings, session_key=session_key, run_id=str(uuid4()),
    )
    context = await inference.inspect_context_window(base_url=base_url, model=model)
    validated = await infer_validated_batch(
        inference, run, request.messages, request.batch, request.batch.note_ids,
        frozenset(note_store.list_note_ids()), "new", context.loaded_tokens, request.namespace_vocabulary,
    )
    assert set(validated) <= {request.note_id}
    if request.note_id not in validated:
        return ()
    return keep_new_tags_up_to_limit(tags=validated[request.note_id], namespace_vocabulary=request.namespace_vocabulary)
