"""Opt-in behavioral evaluations against MetaList's real managed Ollama runtime."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from types import MappingProxyType

import pytest

from app.services.agent.actions import InvestigationStep
from app.services.agent.actions import InvestigationStepConstraints
from app.services.agent.actions import RespondAction
from app.services.agent.actions import EvidenceSelection
from app.services.agent.actions import EvidenceSelectionConstraints
from app.services.agent.actions import EvidenceSelectionWithoutRationale
from app.services.agent.actions import ScopedRouteConstraints
from app.services.agent.actions import ScopedRouteEnvelope
from app.services.agent.actions import WorkingSummary
from app.services.agent.actions import bind_investigation_step_constraints
from app.services.agent.actions import bind_evidence_selection_constraints
from app.services.agent.actions import bind_scoped_route_constraints
from app.services.agent.actions import request_explicitly_requires_saved_notes
from app.services.agent.context import AgentContextBuilder
from app.services.agent.inference import InferenceAttempt
from app.services.agent.investigation import InvestigationState
from app.services.agent.ollama_inference import OllamaInferenceAdapter
from app.services.agent.prompt_settings import DEFAULT_AGENT_PROMPTS
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.scope import AgentScopeDescriptor
from app.services.agent.scope import FrozenScopedNote
from app.services.agent.scope import FrozenScopedTreeNode
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.managed_ollama_runtime import managed_ollama_runtime
from app.services.ollama_provider import OllamaProvider


pytestmark = pytest.mark.live_ollama

_MODEL_ENVIRONMENT_KEY = "METALIST_LIVE_OLLAMA_MODEL"
_ROOT_NOTE_ID = "00000000-0000-4000-8000-000000000000"
_NOTE_ID = "11111111-1111-4111-8111-111111111111"
_SECOND_NOTE_ID = "22222222-2222-4222-8222-222222222222"
_IRRELEVANT_NOTE_ID = "33333333-3333-4333-8333-333333333333"
_UNIQUE_FACT = "2042-03-17"


@pytest.fixture(scope="session")
def live_ollama() -> tuple[str, str, OllamaInferenceAdapter]:
    if _MODEL_ENVIRONMENT_KEY not in os.environ:
        raise RuntimeError(
            f"Set {_MODEL_ENVIRONMENT_KEY} to the exact installed model to evaluate"
        )
    model = os.environ[_MODEL_ENVIRONMENT_KEY].strip()
    if model == "":
        raise ValueError(f"{_MODEL_ENVIRONMENT_KEY} must not be blank")
    runtime = managed_ollama_runtime.ensure_running()
    adapter = OllamaInferenceAdapter(provider=OllamaProvider(transport=None))
    context = asyncio.run(
        adapter.inspect_context_window(base_url=runtime.base_url, model=model)
    )
    if not context.is_sufficient:
        raise RuntimeError(
            f"{model} loaded with {context.loaded_tokens} tokens; "
            f"evaluation requires {context.required_tokens}"
        )
    return runtime.base_url, model, adapter


def _snapshot(*, search_query: str) -> ScopedSearchSnapshot:
    descriptor = AgentScopeDescriptor(
        scope_kind="search",
        active_tab_id="live-eval-tab",
        search_query=search_query,
        sort_mode="normal",
        reference_root_ids=[],
        label=search_query,
    )
    note = FrozenScopedNote(
        note_id=_NOTE_ID,
        parent_id="",
        root_note_id=_NOTE_ID,
        content_text=(
            "SYNTHETIC_EVAL_FACT: The Project Aurora launch date is "
            f"{_UNIQUE_FACT}."
        ),
        explicit_tags_text="project-aurora",
        explicit_tag_terms=("project-aurora",),
        created_at="2026-08-29T00:00:00+00:00",
        updated_at="2026-08-29T00:00:00+00:00",
        order_index=0,
    )
    tree_node = FrozenScopedTreeNode(
        note_id=_NOTE_ID,
        parent_id="",
        root_note_id=_NOTE_ID,
        child_ids=(),
    )
    return ScopedSearchSnapshot(
        run_id="live-eval-run",
        session_key="live-eval-session",
        descriptor=descriptor,
        created_at="2026-08-29T00:00:00+00:00",
        ordered_root_ids=(_NOTE_ID,),
        ordered_note_ids=(_NOTE_ID,),
        notes_by_id=MappingProxyType({_NOTE_ID: note}),
        tree_nodes_by_id=MappingProxyType({_NOTE_ID: tree_node}),
    )


def _multi_page_snapshot() -> ScopedSearchSnapshot:
    first = _snapshot(search_query="project-aurora")
    second_note = FrozenScopedNote(
        note_id=_SECOND_NOTE_ID,
        parent_id="",
        root_note_id=_SECOND_NOTE_ID,
        content_text=(
            "SYNTHETIC_EVAL_FACT: Project Aurora's launch color is ultraviolet."
        ),
        explicit_tags_text="project-aurora",
        explicit_tag_terms=("project-aurora",),
        created_at="2026-08-28T00:00:00+00:00",
        updated_at="2026-08-28T00:00:00+00:00",
        order_index=1,
    )
    second_tree_node = FrozenScopedTreeNode(
        note_id=_SECOND_NOTE_ID,
        parent_id="",
        root_note_id=_SECOND_NOTE_ID,
        child_ids=(),
    )
    return ScopedSearchSnapshot(
        run_id="live-eval-multi-page-run",
        session_key="live-eval-session",
        descriptor=first.descriptor,
        created_at=first.created_at,
        ordered_root_ids=(_NOTE_ID, _SECOND_NOTE_ID),
        ordered_note_ids=(_NOTE_ID, _SECOND_NOTE_ID),
        notes_by_id=MappingProxyType(
            {
                _NOTE_ID: first.notes_by_id[_NOTE_ID],
                _SECOND_NOTE_ID: second_note,
            }
        ),
        tree_nodes_by_id=MappingProxyType(
            {
                _NOTE_ID: first.tree_nodes_by_id[_NOTE_ID],
                _SECOND_NOTE_ID: second_tree_node,
            }
        ),
    )


def _nested_single_page_snapshot() -> ScopedSearchSnapshot:
    flat = _multi_page_snapshot()
    notes = {
        note_id: FrozenScopedNote(
            note_id=note.note_id,
            parent_id=_ROOT_NOTE_ID,
            root_note_id=_ROOT_NOTE_ID,
            content_text=note.content_text,
            explicit_tags_text=note.explicit_tags_text,
            explicit_tag_terms=note.explicit_tag_terms,
            created_at=note.created_at,
            updated_at=note.updated_at,
            order_index=note.order_index,
        )
        for note_id, note in flat.notes_by_id.items()
    }
    notes[_IRRELEVANT_NOTE_ID] = FrozenScopedNote(
        note_id=_IRRELEVANT_NOTE_ID,
        parent_id=_ROOT_NOTE_ID,
        root_note_id=_ROOT_NOTE_ID,
        content_text=(
            "SYNTHETIC_IRRELEVANT_FACT: Project Aurora's catering menu includes "
            "rosemary tea and almond biscuits."
        ),
        explicit_tags_text="project-aurora catering",
        explicit_tag_terms=("project-aurora", "catering"),
        created_at="2026-08-27T00:00:00+00:00",
        updated_at="2026-08-27T00:00:00+00:00",
        order_index=2,
    )
    return ScopedSearchSnapshot(
        run_id="live-eval-nested-page-run",
        session_key=flat.session_key,
        descriptor=flat.descriptor,
        created_at=flat.created_at,
        ordered_root_ids=(_ROOT_NOTE_ID,),
        ordered_note_ids=(_NOTE_ID, _SECOND_NOTE_ID, _IRRELEVANT_NOTE_ID),
        notes_by_id=MappingProxyType(notes),
        tree_nodes_by_id=MappingProxyType(
            {
                _ROOT_NOTE_ID: FrozenScopedTreeNode(
                    note_id=_ROOT_NOTE_ID,
                    parent_id="",
                    root_note_id=_ROOT_NOTE_ID,
                    child_ids=(_NOTE_ID, _SECOND_NOTE_ID, _IRRELEVANT_NOTE_ID),
                ),
                _NOTE_ID: FrozenScopedTreeNode(
                    note_id=_NOTE_ID,
                    parent_id=_ROOT_NOTE_ID,
                    root_note_id=_ROOT_NOTE_ID,
                    child_ids=(),
                ),
                _SECOND_NOTE_ID: FrozenScopedTreeNode(
                    note_id=_SECOND_NOTE_ID,
                    parent_id=_ROOT_NOTE_ID,
                    root_note_id=_ROOT_NOTE_ID,
                    child_ids=(),
                ),
                _IRRELEVANT_NOTE_ID: FrozenScopedTreeNode(
                    note_id=_IRRELEVANT_NOTE_ID,
                    parent_id=_ROOT_NOTE_ID,
                    root_note_id=_ROOT_NOTE_ID,
                    child_ids=(),
                ),
            }
        ),
    )


def _diet_scope_snapshot() -> ScopedSearchSnapshot:
    descriptor = AgentScopeDescriptor(
        scope_kind="search",
        active_tab_id="live-eval-tab",
        search_query="testosterone",
        sort_mode="normal",
        reference_root_ids=[],
        label="testosterone",
    )
    content_by_id = {
        _NOTE_ID: "Testosterone activates nitric oxide signaling in blood vessels.",
        _SECOND_NOTE_ID: "Eating onions may support testosterone levels.",
        _IRRELEVANT_NOTE_ID: "Farmer's walk exercise may support testosterone.",
    }
    notes = {
        note_id: FrozenScopedNote(
            note_id=note_id,
            parent_id="",
            root_note_id=note_id,
            content_text=content,
            explicit_tags_text="testosterone",
            explicit_tag_terms=("testosterone",),
            created_at="2026-08-29T00:00:00+00:00",
            updated_at="2026-08-29T00:00:00+00:00",
            order_index=index,
        )
        for index, (note_id, content) in enumerate(content_by_id.items())
    }
    tree_nodes = {
        note_id: FrozenScopedTreeNode(
            note_id=note_id,
            parent_id="",
            root_note_id=note_id,
            child_ids=(),
        )
        for note_id in content_by_id
    }
    return ScopedSearchSnapshot(
        run_id="live-eval-diet-scope-run",
        session_key="live-eval-session",
        descriptor=descriptor,
        created_at="2026-08-29T00:00:00+00:00",
        ordered_root_ids=tuple(content_by_id),
        ordered_note_ids=tuple(content_by_id),
        notes_by_id=MappingProxyType(notes),
        tree_nodes_by_id=MappingProxyType(tree_nodes),
    )


def _first_model_kind(attempt: InferenceAttempt) -> str:
    response = attempt.response
    choices = response["choices"]
    if not isinstance(choices, list) or len(choices) == 0:
        raise TypeError("Live Ollama response choices must be a non-empty list")
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        raise TypeError("Live Ollama response choice must be an object")
    message = first_choice["message"]
    if not isinstance(message, dict):
        raise TypeError("Live Ollama response message must be an object")
    content = message["content"]
    if not isinstance(content, str) or content == "":
        raise TypeError("Live Ollama response content must be non-empty")
    payload = json.loads(content)
    if not isinstance(payload, dict):
        raise TypeError("Live Ollama structured content must be an object")
    kind = payload["kind"]
    if not isinstance(kind, str) or kind == "":
        raise TypeError("Live Ollama route kind must be non-empty")
    return kind


async def _infer_route(
    *,
    adapter: OllamaInferenceAdapter,
    base_url: str,
    model: str,
    user_message: str,
    search_query: str,
) -> tuple[ScopedRouteEnvelope, list[InferenceAttempt], float]:
    snapshot = _snapshot(search_query=search_query)
    messages = AgentContextBuilder().build_scoped_route_messages(
        canonical_messages=[{"role": "user", "content": user_message}],
        prompts=DEFAULT_AGENT_PROMPTS,
        snapshot=snapshot,
        evidence_page_count=1,
    )
    constraints = ScopedRouteConstraints(
        explicit_saved_notes_request=request_explicitly_requires_saved_notes(
            user_message
        )
    )
    started_at = time.perf_counter()
    with bind_scoped_route_constraints(constraints):
        response = await adapter.infer_structured(
            base_url=base_url,
            model=model,
            thinking_level="off",
            messages=messages,
            response_model=ScopedRouteEnvelope,
            on_progress=lambda _progress: None,
        )
        route = ScopedRouteEnvelope.model_validate_json(response.content)
    return route, response.attempts, time.perf_counter() - started_at


async def _infer_follow_up_route(
    *,
    adapter: OllamaInferenceAdapter,
    base_url: str,
    model: str,
) -> tuple[ScopedRouteEnvelope, list[InferenceAttempt], float]:
    snapshot = _snapshot(search_query="testosterone")
    user_message = "nitric oxide is not food"
    canonical_messages = [
        {
            "role": "user",
            "content": "please summarize the stuff relating to diet",
        },
        {
            "role": "assistant",
            "content": (
                "Nitric oxide is one of the dietary items in your notes."
            ),
        },
        {"role": "user", "content": user_message},
    ]
    messages = AgentContextBuilder().build_scoped_route_messages(
        canonical_messages=canonical_messages,
        prompts=DEFAULT_AGENT_PROMPTS,
        snapshot=snapshot,
        evidence_page_count=1,
    )
    constraints = ScopedRouteConstraints(
        explicit_saved_notes_request=request_explicitly_requires_saved_notes(
            user_message
        )
    )
    started_at = time.perf_counter()
    with bind_scoped_route_constraints(constraints):
        response = await adapter.infer_structured(
            base_url=base_url,
            model=model,
            thinking_level="off",
            messages=messages,
            response_model=ScopedRouteEnvelope,
            on_progress=lambda _progress: None,
        )
        route = ScopedRouteEnvelope.model_validate_json(response.content)
    return route, response.attempts, time.perf_counter() - started_at


async def _infer_follow_up_response(
    *,
    adapter: OllamaInferenceAdapter,
    base_url: str,
    model: str,
) -> tuple[str, float]:
    canonical_messages = [
        {
            "role": "user",
            "content": "please summarize the stuff relating to diet",
        },
        {
            "role": "assistant",
            "content": (
                "1. Nitric Oxide and Testosterone.\n"
                "2. Testosterone Boosters.\n"
                "3. Dietary Influences: onions.\n"
                "4. Fasting."
            ),
        },
        {"role": "user", "content": "nitric oxide is not food"},
    ]
    builder = AgentContextBuilder()
    messages = builder.build_initial_messages(
        canonical_messages=canonical_messages,
        prompts=DEFAULT_AGENT_PROMPTS,
    )
    final_messages = builder.append_final_request(
        messages=messages,
        action=RespondAction(
            kind="respond",
            basis="The latest message corrects the preceding answer.",
        ),
        prompts=DEFAULT_AGENT_PROMPTS,
        current_user_request=canonical_messages[-1]["content"],
    )
    started_at = time.perf_counter()
    final_parts: list[str] = []
    async for event in adapter.stream_text(
        base_url=base_url,
        model=model,
        thinking_level="off",
        messages=final_messages,
        max_output_tokens=256,
        on_request=lambda _request: None,
    ):
        if event["type"] == "content_delta":
            response_text = event["text"]
            if not isinstance(response_text, str):
                raise TypeError("Live follow-up content delta must be text")
            final_parts.append(response_text)
    return "".join(final_parts), time.perf_counter() - started_at


async def _infer_diet_evidence_selection(
    *,
    adapter: OllamaInferenceAdapter,
    base_url: str,
    model: str,
) -> tuple[EvidenceSelectionWithoutRationale, float]:
    snapshot = _diet_scope_snapshot()
    state = InvestigationState.start(
        snapshot=snapshot,
        settings=AgentRetrievalSettings(
            max_note_characters=2_000,
            max_page_characters=20_000,
            max_notes_per_page=50,
            max_ranked_tags_per_page=50,
            max_working_summary_characters=8_000,
        ),
    )
    note_page = state.current_note_page()
    messages = AgentContextBuilder().build_single_page_evidence_selection_messages(
        canonical_messages=[
            {
                "role": "user",
                "content": "please summarize the stuff relating to diet",
            }
        ],
        prompts=DEFAULT_AGENT_PROMPTS,
        skill=DEFAULT_AGENT_SKILLS.for_action("evidence_selection"),
        state=state,
        note_page=note_page,
        include_rationale=False,
    )
    constraints = EvidenceSelectionConstraints(
        allowed_note_ids=frozenset(note_page.evidence_note_ids),
    )
    started_at = time.perf_counter()
    with bind_evidence_selection_constraints(constraints):
        response = await adapter.infer_structured(
            base_url=base_url,
            model=model,
            thinking_level="off",
            messages=messages,
            response_model=EvidenceSelectionWithoutRationale,
            on_progress=lambda _progress: None,
        )
        selection = EvidenceSelectionWithoutRationale.model_validate_json(
            response.content
        )
    return selection, time.perf_counter() - started_at


@pytest.mark.parametrize(
    ("user_message", "search_query", "expected_kind"),
    (
        (
            "please summarize my notes about testosterone",
            "testosterone",
            "investigate_current_scope",
        ),
        ("hey are you there?", "testosterone", "respond"),
        ("please describe Bayes' theorem briefly", "testosterone", "respond"),
    ),
)
def test_live_model_selects_expected_initial_route(
    live_ollama: tuple[str, str, OllamaInferenceAdapter],
    user_message: str,
    search_query: str,
    expected_kind: str,
) -> None:
    base_url, model, adapter = live_ollama
    route, attempts, elapsed_seconds = asyncio.run(
        _infer_route(
            adapter=adapter,
            base_url=base_url,
            model=model,
            user_message=user_message,
            search_query=search_query,
        )
    )
    first_kind = _first_model_kind(attempts[0])
    print(
        json.dumps(
            {
                "eval": "route",
                "model": model,
                "user_message": user_message,
                "search_query": search_query,
                "initial_kind": first_kind,
                "validated_kind": route.kind,
                "attempts": len(attempts),
                "elapsed_seconds": round(elapsed_seconds, 3),
            },
            sort_keys=True,
        )
    )
    assert first_kind == expected_kind
    assert route.kind == expected_kind


def test_live_model_treats_exact_follow_up_correction_as_conversation(
    live_ollama: tuple[str, str, OllamaInferenceAdapter],
) -> None:
    base_url, model, adapter = live_ollama
    route, attempts, elapsed_seconds = asyncio.run(
        _infer_follow_up_route(
            adapter=adapter,
            base_url=base_url,
            model=model,
        )
    )
    first_kind = _first_model_kind(attempts[0])
    print(
        json.dumps(
            {
                "eval": "follow_up_correction_route",
                "model": model,
                "user_message": "nitric oxide is not food",
                "search_query": "testosterone",
                "initial_kind": first_kind,
                "validated_kind": route.kind,
                "attempts": len(attempts),
                "elapsed_seconds": round(elapsed_seconds, 3),
            },
            sort_keys=True,
        )
    )
    assert first_kind == "respond"
    assert route.kind == "respond"

    final_text, final_elapsed_seconds = asyncio.run(
        _infer_follow_up_response(
            adapter=adapter,
            base_url=base_url,
            model=model,
        )
    )
    print(
        json.dumps(
            {
                "eval": "follow_up_correction_response",
                "model": model,
                "user_message": "nitric oxide is not food",
                "final_text": final_text,
                "elapsed_seconds": round(final_elapsed_seconds, 3),
            },
            sort_keys=True,
        )
    )
    folded_final = final_text.casefold()
    assert "nitric oxide" in folded_final
    assert (
        "not food" in folded_final
        or "not a food" in folded_final
        or "isn't food" in folded_final
    )
    assert "testosterone boosters" not in folded_final
    assert "onions" not in folded_final
    assert "fasting" not in folded_final


def test_live_model_excludes_broad_scope_neighbors_from_exact_diet_request(
    live_ollama: tuple[str, str, OllamaInferenceAdapter],
) -> None:
    base_url, model, adapter = live_ollama
    selection, elapsed_seconds = asyncio.run(
        _infer_diet_evidence_selection(
            adapter=adapter,
            base_url=base_url,
            model=model,
        )
    )
    print(
        json.dumps(
            {
                "eval": "narrow_diet_evidence_selection",
                "model": model,
                "user_message": "please summarize the stuff relating to diet",
                "selected_note_ids": selection.relevant_note_ids,
                "elapsed_seconds": round(elapsed_seconds, 3),
            },
            sort_keys=True,
        )
    )
    assert selection.relevant_note_ids == [_SECOND_NOTE_ID]


async def _infer_first_multi_page_investigation_step(
    *,
    adapter: OllamaInferenceAdapter,
    base_url: str,
    model: str,
) -> tuple[InvestigationStep, int, float]:
    snapshot = _multi_page_snapshot()
    state = InvestigationState.start(
        snapshot=snapshot,
        settings=AgentRetrievalSettings(
            max_note_characters=2_000,
            max_page_characters=20_000,
            max_notes_per_page=1,
            max_ranked_tags_per_page=50,
            max_working_summary_characters=8_000,
        ),
    )
    note_page = state.current_note_page()
    facet_page = state.current_facet_page()
    summary = WorkingSummary(
        answer_relevant_facts=[],
        possible_conclusions=[],
        contradictions_or_uncertainties=[],
        unresolved_questions=[],
        useful_search_terms_or_tags=[],
    )
    messages = AgentContextBuilder().build_scoped_investigation_messages(
        canonical_messages=[
            {
                "role": "user",
                "content": "please summarize all of my Project Aurora notes",
            }
        ],
        prompts=DEFAULT_AGENT_PROMPTS,
        skill=DEFAULT_AGENT_SKILLS.for_action("investigate_current_scope"),
        state=state,
        note_page=note_page,
        facet_page=facet_page,
        working_summary=summary,
        reopened_sources=(),
    )
    constraints = InvestigationStepConstraints(
        has_next_note_page=True,
        requires_complete_scope_coverage=True,
        current_facet_page=facet_page.page,
        total_facet_pages=facet_page.total_pages,
        disclosed_tags=state.disclosed_tags,
        disclosed_state_ids=state.disclosed_state_ids,
        observed_source_ids=state.observed_source_ids,
    )
    started_at = time.perf_counter()
    with bind_investigation_step_constraints(constraints):
        response = await adapter.infer_structured(
            base_url=base_url,
            model=model,
            thinking_level="off",
            messages=messages,
            response_model=InvestigationStep,
            on_progress=lambda _progress: None,
        )
        step = InvestigationStep.model_validate_json(response.content)
    return step, len(response.attempts), time.perf_counter() - started_at


async def _infer_single_page_final(
    *,
    adapter: OllamaInferenceAdapter,
    base_url: str,
    model: str,
) -> tuple[str, tuple[str, ...], float]:
    snapshot = _nested_single_page_snapshot()
    state = InvestigationState.start(
        snapshot=snapshot,
        settings=AgentRetrievalSettings(
            max_note_characters=2_000,
            max_page_characters=20_000,
            max_notes_per_page=50,
            max_ranked_tags_per_page=50,
            max_working_summary_characters=8_000,
        ),
    )
    note_page = state.current_note_page()
    canonical_messages = [
        {
            "role": "user",
            "content": (
                "what do my Project Aurora notes say specifically about "
                "the launch date and launch color?"
            ),
        }
    ]
    builder = AgentContextBuilder()
    selection_messages = builder.build_single_page_evidence_selection_messages(
        canonical_messages=canonical_messages,
        prompts=DEFAULT_AGENT_PROMPTS,
        skill=DEFAULT_AGENT_SKILLS.for_action("evidence_selection"),
        state=state,
        note_page=note_page,
        include_rationale=True,
    )
    constraints = EvidenceSelectionConstraints(
        allowed_note_ids=frozenset(note_page.evidence_note_ids),
    )
    started_at = time.perf_counter()
    with bind_evidence_selection_constraints(constraints):
        selection_response = await adapter.infer_structured(
            base_url=base_url,
            model=model,
            thinking_level="off",
            messages=selection_messages,
            response_model=EvidenceSelection,
            on_progress=lambda _progress: None,
        )
        selection = EvidenceSelection.model_validate_json(selection_response.content)
    verified_sources = state.reopen_sources(note_ids=selection.relevant_note_ids)
    reference_note_ids = tuple(
        source["note_id"]
        for source in verified_sources
        if isinstance(source["note_id"], str)
    )
    final_messages = builder.build_scoped_final_messages(
        canonical_messages=canonical_messages,
        prompts=DEFAULT_AGENT_PROMPTS,
        state=state,
        working_summary=WorkingSummary(
            answer_relevant_facts=[],
            possible_conclusions=[],
            contradictions_or_uncertainties=[],
            unresolved_questions=[],
            useful_search_terms_or_tags=[],
        ),
        verified_sources=verified_sources,
        reference_note_ids=reference_note_ids,
        basis="the exact sources selected from the complete one-page evidence scope",
    )
    final_parts: list[str] = []
    async for event in adapter.stream_text(
        base_url=base_url,
        model=model,
        thinking_level="off",
        messages=final_messages,
        max_output_tokens=1_024,
        on_request=lambda _request: None,
    ):
        if event["type"] == "content_delta":
            text = event["text"]
            if not isinstance(text, str):
                raise TypeError("Live final content delta must be text")
            final_parts.append(text)
    return (
        "".join(final_parts),
        reference_note_ids,
        time.perf_counter() - started_at,
    )


def test_live_model_directly_uses_and_cites_single_page_evidence(
    live_ollama: tuple[str, str, OllamaInferenceAdapter],
) -> None:
    base_url, model, adapter = live_ollama
    final_text, selected_note_ids, elapsed_seconds = asyncio.run(
        _infer_single_page_final(
            adapter=adapter,
            base_url=base_url,
            model=model,
        )
    )
    print(
        json.dumps(
            {
                "eval": "single-page-evidence",
                "model": model,
                "final_text": final_text,
                "selected_note_ids": selected_note_ids,
                "elapsed_seconds": round(elapsed_seconds, 3),
            },
            sort_keys=True,
        )
    )
    assert selected_note_ids == (_NOTE_ID, _SECOND_NOTE_ID)
    assert _UNIQUE_FACT in final_text or "March 17, 2042" in final_text
    assert "ultraviolet" in final_text.casefold()
    assert f"[[{_NOTE_ID}]]" in final_text
    assert f"[[{_SECOND_NOTE_ID}]]" in final_text
    assert f"[[{_IRRELEVANT_NOTE_ID}]]" not in final_text
    assert "rosemary" not in final_text.casefold()
    assert "catering" not in final_text.casefold()
    assert "note id" not in final_text.casefold()
    assert re.search(
        rf"(?is)(?:{re.escape(_UNIQUE_FACT)}|March 17, 2042).*?"
        rf"\[\[{re.escape(_NOTE_ID)}\]\]",
        final_text,
    )
    assert re.search(
        rf"(?is)ultraviolet.*?\[\[{re.escape(_SECOND_NOTE_ID)}\]\]",
        final_text,
    )
    assert (
        re.search(
            r"(?im)^[ \t]*\[\[[0-9a-f-]{36}\]\][ \t]+\S",
            final_text,
        )
        is None
    )
    assert "references" not in final_text.casefold()


def test_live_model_rolls_bounded_summary_before_next_evidence_page(
    live_ollama: tuple[str, str, OllamaInferenceAdapter],
) -> None:
    base_url, model, adapter = live_ollama
    step, attempt_count, elapsed_seconds = asyncio.run(
        _infer_first_multi_page_investigation_step(
            adapter=adapter,
            base_url=base_url,
            model=model,
        )
    )
    summary_json = step.working_summary.model_dump_json()
    print(
        json.dumps(
            {
                "eval": "multi-page-working-summary",
                "model": model,
                "action_kind": step.action_kind,
                "attempts": attempt_count,
                "working_summary": step.working_summary.model_dump(mode="json"),
                "elapsed_seconds": round(elapsed_seconds, 3),
            },
            sort_keys=True,
        )
    )
    assert step.action_kind == "page_next"
    assert _UNIQUE_FACT in summary_json
    assert len(step.working_summary.answer_relevant_facts) <= 4
    assert len(step.working_summary.possible_conclusions) <= 2
    assert len(step.working_summary.contradictions_or_uncertainties) <= 2
    assert all(
        len(evidence.source_ids) <= 4
        for evidence in (
            *step.working_summary.answer_relevant_facts,
            *step.working_summary.possible_conclusions,
            *step.working_summary.contradictions_or_uncertainties,
        )
    )
