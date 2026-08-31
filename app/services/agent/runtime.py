"""Explicit application-owned execution loop for read-only PKMS agents."""

from __future__ import annotations

import asyncio
import math
import time
from collections.abc import AsyncIterator
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass

from pydantic import BaseModel

from app.services.agent.actions import AgentRouteAction
from app.services.agent.actions import AgentRouteEnvelope
from app.services.agent.actions import ReadNotesByIdAction
from app.services.agent.actions import RespondAction
from app.services.agent.actions import SearchNotesIntent
from app.services.agent.actions import SearchNotesAction
from app.services.agent.actions import SearchQueryEnvelope
from app.services.agent.actions import ScopedRouteEnvelope
from app.services.agent.actions import ScopedRouteConstraints
from app.services.agent.actions import bind_scoped_route_constraints
from app.services.agent.actions import parse_agent_route_json
from app.services.agent.actions import parse_search_query_json
from app.services.agent.actions import request_explicitly_requires_saved_notes
from app.services.agent.context import AgentContextBuilder
from app.services.agent.context import serialize_investigation_evidence_payload
from app.services.agent.inference import InferenceAdapter
from app.services.agent.inference import InferenceAttempt
from app.services.agent.inference import InferenceContextWindow
from app.services.agent.inference import InferenceProviderError
from app.services.agent.inference import InferenceResponse
from app.services.agent.inference import StructuredInferenceProgress
from app.services.agent.inference import StructuredInferenceError
from app.services.agent.investigation import InvestigationEvidencePayload
from app.services.agent.investigation import InvestigationState
from app.services.agent.model_policy import InferencePurpose
from app.services.agent.model_policy import SingleModelPolicy
from app.services.agent.permissions import AgentPermissionPolicy
from app.services.agent.prompt_settings import AgentPromptSet
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.skill_settings import AgentSkill
from app.services.agent.skill_settings import AgentSkillSet
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.tools import ReadOnlyAgentToolRegistry
from app.services.agent.tools import ToolExecutionResult
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.agent.token_estimation import estimate_message_tokens
from app.services.agent.token_estimation import estimate_text_tokens
from app.services.agent.trace import AgentTraceStore
from app.services.search_query import parse_search_query


_MAX_ACTION_STEPS = 8
_FINAL_RESPONSE_MAX_OUTPUT_TOKENS_BY_PROVIDER = {
    "Ollama": 1_024,
    "OpenAI": 8_192,
}
_SearchClauseKey = tuple[
    frozenset[str],
    frozenset[str],
    frozenset[str],
    frozenset[str],
]
_SearchQueryKey = frozenset[_SearchClauseKey]
_SearchRequestKey = _SearchQueryKey


class AgentExecutionError(Exception):
    """Expected failure caused by provider/model output during an agent run."""


def _final_response_max_output_tokens(*, provider_label: str) -> int:
    if provider_label not in _FINAL_RESPONSE_MAX_OUTPUT_TOKENS_BY_PROVIDER:
        raise ValueError(f"Unsupported inference provider: {provider_label}")
    return _FINAL_RESPONSE_MAX_OUTPUT_TOKENS_BY_PROVIDER[provider_label]


@dataclass(frozen=True, slots=True)
class _RunContext:
    session_key: str
    run_id: str
    base_url: str
    selected_model: str
    thinking_level: str
    current_user_request: str
    prompts: AgentPromptSet
    skills: AgentSkillSet
    retrieval_settings: AgentRetrievalSettings


@dataclass(slots=True)
class _FinalStreamState:
    thinking: str
    content: str
    usage: dict[str, int]
    did_finish: bool


class AgentRuntime:
    def __init__(
        self,
        *,
        context_builder: AgentContextBuilder,
        inference: InferenceAdapter,
        model_policy: SingleModelPolicy,
        permission_policy: AgentPermissionPolicy,
        tool_registry: ReadOnlyAgentToolRegistry,
        trace_store: AgentTraceStore,
        provider_label: str,
    ) -> None:
        if not isinstance(provider_label, str) or provider_label == "":
            raise ValueError("Agent runtime provider label must be non-empty")
        self._context_builder = context_builder
        self._inference = inference
        self._model_policy = model_policy
        self._permission_policy = permission_policy
        self._tool_registry = tool_registry
        self._trace_store = trace_store
        self._provider_label = provider_label

    async def stream_scoped(
        self,
        *,
        session_key: str,
        base_url: str,
        selected_model: str,
        thinking_level: str,
        canonical_messages: list[dict[str, str]],
        prompts: AgentPromptSet,
        skills: AgentSkillSet,
        retrieval_settings: AgentRetrievalSettings,
        frozen_scope: ScopedSearchSnapshot,
    ) -> AsyncIterator[dict[str, object]]:
        run, initial_messages = self._start_run(
            session_key=session_key,
            base_url=base_url,
            selected_model=selected_model,
            thinking_level=thinking_level,
            canonical_messages=canonical_messages,
            prompts=prompts,
            skills=skills,
            retrieval_settings=retrieval_settings,
        )
        # lint: allow-PY001 rationale="record every scoped run failure before immediately re-raising"
        try:
            async for event in self._run_scoped_steps(
                run=run,
                canonical_messages=canonical_messages,
                initial_messages=initial_messages,
                frozen_scope=frozen_scope,
            ):
                yield event
        # lint: allow-PY001 rationale="record interrupted external inference before preserving cancellation"
        except asyncio.CancelledError:
            self._record_failure(
                session_key=session_key,
                run_id=run.run_id,
                error="Agent run interrupted",
            )
            raise
        # lint: allow-PY001 rationale="record internal failure details and immediately re-raise"
        except Exception as exc:
            self._record_failure(
                session_key=session_key,
                run_id=run.run_id,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise

    async def _run_scoped_steps(
        self,
        *,
        run: _RunContext,
        canonical_messages: list[dict[str, str]],
        initial_messages: list[dict[str, str]],
        frozen_scope: ScopedSearchSnapshot,
    ) -> AsyncIterator[dict[str, object]]:
        if not isinstance(frozen_scope, ScopedSearchSnapshot):
            raise TypeError("frozen_scope must be ScopedSearchSnapshot")
        if frozen_scope.session_key != run.session_key:
            raise RuntimeError("Frozen scope belongs to another session")
        initial_tokens = estimate_message_tokens(initial_messages)
        snapshot = frozen_scope
        state = InvestigationState.start(
            snapshot=snapshot,
            settings=run.retrieval_settings,
        )
        scope_label = (
            f"Scope ready · {snapshot.descriptor.label} · {snapshot.note_count} "
            f"notes in {snapshot.result_tree_count} result trees"
        )
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="FROZEN_SCOPE",
            label="Frozen active MetaList scope",
            detail={
                "descriptor": snapshot.descriptor.model_dump(mode="json"),
                "note_count": snapshot.note_count,
                "result_tree_count": snapshot.result_tree_count,
                "ordered_note_ids": list(snapshot.ordered_note_ids),
                "ordered_root_ids": list(snapshot.ordered_root_ids),
            },
            duration_ms=0.0,
        )
        yield self._status_event(
            "scope",
            "completed",
            scope_label,
            approx_input_tokens=initial_tokens,
        )
        async for event in self._ensure_model_context(run=run, messages=initial_messages):
            yield event

        route_messages = self._context_builder.build_scoped_route_messages(
            canonical_messages=canonical_messages,
            prompts=run.prompts,
            snapshot=snapshot,
        )
        route_progress: asyncio.Queue[StructuredInferenceProgress] = asyncio.Queue()
        route_task = asyncio.create_task(
            self._select_scoped_route(
                run=run,
                messages=route_messages,
                user_message=canonical_messages[-1]["content"],
                on_progress=lambda progress: self._publish_inference_progress(
                    run=run,
                    progress_queue=route_progress,
                    progress=progress,
                    purpose=InferencePurpose.ACTION_SELECTION,
                ),
            )
        )
        async for progress in self._stream_progress_until_complete(
            progress_queue=route_progress,
            action_task=route_task,
        ):
            yield self._progress_status_event(
                progress,
                purpose=InferencePurpose.ACTION_SELECTION,
                provider_label=self._provider_label,
            )
        route = await route_task
        route_tokens = estimate_message_tokens(route_messages)
        yield self._status_event(
            route.kind,
            "completed",
            f"Selected action · {route.kind.replace('_', ' ')} · {self._compact_status_reason(route.reason)}",
            approx_input_tokens=route_tokens,
        )
        if route.kind == "respond":
            action = RespondAction(kind="respond", basis=route.reason)
            async for event in self._stream_final_response(
                run=run,
                messages=initial_messages,
                action=action,
                reference_note_ids=(),
            ):
                yield event
            return

        assert route.kind == "investigate_current_scope"
        skill = run.skills.for_action(route.kind)
        self._record_skill_activation(run=run, skill=skill)
        yield self._status_event(
            "skill",
            "completed",
            f"Activated skill · {skill.title}",
            approx_input_tokens=route_tokens,
        )
        retention = await asyncio.to_thread(
            state.retain_root_prefix_within_token_budget
        )
        dropped_root_count = len(retention.dropped_root_ids)
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="EVIDENCE_ROOT_PREFIX_RETAINED",
            label="Retained ordered root trees within the evidence token budget",
            detail={
                "original_note_count": retention.original_note_count,
                "original_result_tree_count": retention.original_result_tree_count,
                "retained_note_count": retention.retained_note_count,
                "retained_result_tree_count": retention.retained_result_tree_count,
                "retained_approximate_token_count": (
                    retention.retained_approximate_token_count
                ),
                "target_approximate_token_count": (
                    run.retrieval_settings.max_page_approximate_tokens
                ),
                "retained_root_ids": list(retention.retained_root_ids),
                "dropped_root_ids": list(retention.dropped_root_ids),
            },
            duration_ms=0.0,
        )
        basis = "the complete frozen evidence scope"
        if dropped_root_count:
            yield self._status_event(
                "evidence_root_prefix",
                "completed",
                (
                    "Only using "
                    f"{retention.retained_result_tree_count} of "
                    f"{retention.original_result_tree_count} root notes for answer"
                ),
                approx_input_tokens=route_tokens,
            )
            basis = (
                "the leading ordered complete-root subset retained within the "
                "single evidence token budget; later frozen-scope roots were "
                "omitted, so do not claim exhaustive scope coverage"
            )
        evidence_payload = state.current_scope_payload()
        yield self._status_event(
            "investigation_evidence",
            "completed",
            self._evidence_payload_status_label(evidence_payload),
            approx_input_tokens=(
                evidence_payload.returned_approximate_token_count
            ),
        )
        self._record_evidence_payload(
            run=run,
            evidence_payload=evidence_payload,
        )
        final_messages, reference_note_ids = (
            self._context_builder.build_scoped_final_messages(
                canonical_messages=canonical_messages,
                prompts=run.prompts,
                state=state,
                evidence_payload=evidence_payload,
                basis=basis,
            )
        )
        final_tokens = estimate_message_tokens(final_messages)
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="FINAL_EVIDENCE",
            label="Single authoritative evidence payload",
            detail={
                "source_ids": list(reference_note_ids),
                "result_tree_ids": list(evidence_payload.result_tree_ids),
            },
            duration_ms=0.0,
        )
        yield self._status_event(
            "investigation_sources",
            "completed",
            (
                "Evidence ready · generating response from "
                f"{len(evidence_payload.evidence_note_ids)} notes in "
                f"{len(evidence_payload.result_tree_ids)} result trees"
            ),
            approx_input_tokens=final_tokens,
        )
        async for event in self._stream_prebuilt_final_response(
            run=run,
            final_messages=final_messages,
            reference_note_ids=reference_note_ids,
        ):
            yield event

    async def _ensure_model_context(
        self,
        *,
        run: _RunContext,
        messages: list[dict[str, str]],
    ) -> AsyncIterator[dict[str, object]]:
        input_tokens = estimate_message_tokens(messages)
        yield self._status_event(
            "model_context",
            "started",
            self._model_context_check_label(),
            approx_input_tokens=input_tokens,
        )
        context_window = await self._inference.inspect_context_window(
            base_url=run.base_url,
            model=run.selected_model,
        )
        self._record_model_context(run=run, context_window=context_window)
        if not context_window.is_sufficient:
            raise AgentExecutionError(
                f"{context_window.model} is loaded with {context_window.loaded_tokens:,} "
                f"context tokens; MetaList requires {context_window.required_tokens:,}."
            )
        yield self._status_event(
            "model_context",
            "completed",
            f"{self._provider_label} context ready · {context_window.loaded_tokens:,} tokens",
            approx_input_tokens=input_tokens,
        )

    async def stream(
        self,
        *,
        session_key: str,
        base_url: str,
        selected_model: str,
        thinking_level: str,
        canonical_messages: list[dict[str, str]],
        prompts: AgentPromptSet,
        skills: AgentSkillSet,
        retrieval_settings: AgentRetrievalSettings,
    ) -> AsyncIterator[dict[str, object]]:
        run, messages = self._start_run(
            session_key=session_key,
            base_url=base_url,
            selected_model=selected_model,
            thinking_level=thinking_level,
            canonical_messages=canonical_messages,
            prompts=prompts,
            skills=skills,
            retrieval_settings=retrieval_settings,
        )
        # lint: allow-PY001 rationale="record every run failure in the session trace before re-raising"
        try:
            async for event in self._run_steps(run=run, messages=messages):
                yield event
        # lint: allow-PY001 rationale="record interrupted external inference before preserving cancellation"
        except asyncio.CancelledError:
            self._record_failure(
                session_key=session_key,
                run_id=run.run_id,
                error="Agent run interrupted",
            )
            raise
        # lint: allow-PY001 rationale="record internal failure details and immediately re-raise"
        except Exception as exc:
            self._record_failure(
                session_key=session_key,
                run_id=run.run_id,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise

    def _start_run(
        self,
        *,
        session_key: str,
        base_url: str,
        selected_model: str,
        thinking_level: str,
        canonical_messages: list[dict[str, str]],
        prompts: AgentPromptSet,
        skills: AgentSkillSet,
        retrieval_settings: AgentRetrievalSettings,
    ) -> tuple[_RunContext, list[dict[str, str]]]:
        messages = self._context_builder.build_initial_messages(
            canonical_messages=canonical_messages,
            prompts=prompts,
        )
        run_id = self._trace_store.start_run(
            session_key=session_key,
            model=selected_model,
            user_message=canonical_messages[-1]["content"],
        )
        run = _RunContext(
            session_key=session_key,
            run_id=run_id,
            base_url=base_url,
            selected_model=selected_model,
            thinking_level=thinking_level,
            current_user_request=canonical_messages[-1]["content"],
            prompts=prompts,
            skills=skills,
            retrieval_settings=retrieval_settings,
        )
        return run, messages

    async def _run_steps(
        self,
        *,
        run: _RunContext,
        messages: list[dict[str, str]],
    ) -> AsyncIterator[dict[str, object]]:
        current_input_tokens = estimate_message_tokens(messages)
        yield self._status_event(
            "model_context",
            "started",
            self._model_context_check_label(),
            approx_input_tokens=current_input_tokens,
        )
        context_window = await self._inference.inspect_context_window(
            base_url=run.base_url,
            model=run.selected_model,
        )
        self._record_model_context(run=run, context_window=context_window)
        if not context_window.is_sufficient:
            yield self._status_event(
                "model_context",
                "completed",
                (
                    f"{self._provider_label} context too small · "
                    f"{context_window.loaded_tokens:,} loaded · "
                    f"{context_window.required_tokens:,} required"
                ),
                approx_input_tokens=current_input_tokens,
            )
            raise AgentExecutionError(
                f"{context_window.model} is loaded with "
                f"{context_window.loaded_tokens:,} context tokens; MetaList requires "
                f"{context_window.required_tokens:,} for this model (declared maximum "
                f"{context_window.maximum_tokens:,}). The MetaList-managed runtime is "
                "not honoring its required context configuration. Restart MetaList and "
                "inspect Agent Debug if the problem continues."
            )
        yield self._status_event(
            "model_context",
            "completed",
            f"{self._provider_label} context ready · {context_window.loaded_tokens:,} tokens",
            approx_input_tokens=current_input_tokens,
        )
        current_messages = messages
        reference_note_ids: list[str] = []
        completed_search_count = 0
        completed_search_requests: set[_SearchRequestKey] = set()
        completed_search_query_texts: set[str] = set()
        for _ in range(_MAX_ACTION_STEPS):
            current_input_tokens = estimate_message_tokens(current_messages)
            yield self._status_event(
                "planning",
                "started",
                "Preparing action selection",
                approx_input_tokens=current_input_tokens,
            )
            progress_queue: asyncio.Queue[StructuredInferenceProgress] = asyncio.Queue()
            route_task = asyncio.create_task(
                self._select_action(
                    run=run,
                    messages=current_messages,
                    on_progress=lambda progress: self._publish_inference_progress(
                        run=run,
                        progress_queue=progress_queue,
                        progress=progress,
                        purpose=InferencePurpose.ACTION_SELECTION,
                    ),
                )
            )
            async for progress in self._stream_progress_until_complete(
                progress_queue=progress_queue,
                action_task=route_task,
            ):
                yield self._progress_status_event(
                    progress,
                    purpose=InferencePurpose.ACTION_SELECTION,
                    provider_label=self._provider_label,
                )
            route_action, current_messages = await route_task
            if (
                isinstance(route_action, SearchNotesIntent)
                and self._search_intent_repeats_completed_query(
                    action=route_action,
                    completed_search_query_texts=completed_search_query_texts,
                )
            ):
                respond_action = RespondAction(
                    kind="respond",
                    basis=(
                        "The proposed repeat search merely restates a completed query. "
                        "Answer using the evidence already retrieved."
                    ),
                )
                self._record_repeat_search_selection_policy(
                    run=run,
                    action=route_action,
                )
                yield self._status_event(
                    "search_notes",
                    "completed",
                    f"Skipped repeat-search selection · {route_action.rationale}",
                    approx_input_tokens=current_input_tokens,
                )
                self._record_action(run=run, action=respond_action)
                yield self._selected_action_status_event(
                    respond_action,
                    completed_search_count=completed_search_count,
                    approx_input_tokens=current_input_tokens,
                )
                async for event in self._stream_final_response(
                    run=run,
                    messages=current_messages,
                    action=respond_action,
                    reference_note_ids=tuple(reference_note_ids),
                ):
                    yield event
                return
            yield self._selected_action_status_event(
                route_action,
                completed_search_count=completed_search_count,
                approx_input_tokens=current_input_tokens,
            )
            if isinstance(route_action, SearchNotesIntent):
                skill = run.skills.for_action(route_action.kind)
                self._record_skill_activation(run=run, skill=skill)
                skill_messages = self._context_builder.activate_skill(
                    messages=current_messages,
                    skill=skill,
                )
                yield self._status_event(
                    "skill",
                    "completed",
                    f"Activated skill · {skill.title}",
                    approx_input_tokens=estimate_message_tokens(skill_messages),
                )
                skill_progress_queue: asyncio.Queue[StructuredInferenceProgress] = (
                    asyncio.Queue()
                )
                search_action_task = asyncio.create_task(
                    self._prepare_search_action(
                        run=run,
                        messages=skill_messages,
                        on_progress=lambda progress: self._publish_inference_progress(
                            run=run,
                            progress_queue=skill_progress_queue,
                            progress=progress,
                            purpose=InferencePurpose.SEARCH_QUERY,
                        ),
                    )
                )
                async for progress in self._stream_progress_until_complete(
                    progress_queue=skill_progress_queue,
                    action_task=search_action_task,
                ):
                    yield self._progress_status_event(
                        progress,
                        purpose=InferencePurpose.SEARCH_QUERY,
                        provider_label=self._provider_label,
                    )
                action = await search_action_task
            else:
                action = route_action
            if isinstance(action, RespondAction):
                async for event in self._stream_final_response(
                    run=run,
                    messages=current_messages,
                    action=action,
                    reference_note_ids=tuple(reference_note_ids),
                ):
                    yield event
                return
            if isinstance(action, SearchNotesAction):
                search_request_key = self._search_request_key(action)
                if search_request_key in completed_search_requests:
                    respond_action = RespondAction(
                        kind="respond",
                        basis=(
                            "The proposed search repeats a completed query, so "
                            "do not execute it again. Answer using the evidence already "
                            "retrieved."
                        ),
                    )
                    self._record_duplicate_search_policy(run=run, action=action)
                    yield self._status_event(
                        "search_notes",
                        "completed",
                        f"Skipped duplicate search · {action.query}",
                        approx_input_tokens=current_input_tokens,
                    )
                    self._record_action(run=run, action=respond_action)
                    yield self._selected_action_status_event(
                        respond_action,
                        completed_search_count=completed_search_count,
                        approx_input_tokens=current_input_tokens,
                    )
                    async for event in self._stream_final_response(
                        run=run,
                        messages=current_messages,
                        action=respond_action,
                        reference_note_ids=tuple(reference_note_ids),
                    ):
                        yield event
                    return
            status_label = self._tool_status_label(action)
            yield self._status_event(
                action.kind,
                "started",
                status_label,
                approx_input_tokens=current_input_tokens,
            )
            current_messages, tool_result = self._execute_tool(
                run=run,
                messages=current_messages,
                action=action,
            )
            reference_note_ids = self._merge_reference_note_ids(
                current_note_ids=reference_note_ids,
                tool_result=tool_result,
            )
            completed_status_label = self._tool_completed_status_label(
                action=action,
                result=tool_result,
            )
            yield self._status_event(
                action.kind,
                "completed",
                completed_status_label,
                approx_input_tokens=estimate_message_tokens(current_messages),
            )
            if isinstance(action, SearchNotesAction):
                completed_search_requests.add(self._search_request_key(action))
                completed_search_query_texts.add(
                    self._search_query_surface_key(action.query)
                )
                completed_search_count += 1
        raise AgentExecutionError(f"Agent exceeded {_MAX_ACTION_STEPS} action steps")

    async def _select_action(
        self,
        *,
        run: _RunContext,
        messages: list[dict[str, str]],
        on_progress: Callable[[StructuredInferenceProgress], None],
    ) -> tuple[AgentRouteAction, list[dict[str, str]]]:
        model = self._model_policy.for_stage(
            purpose=InferencePurpose.ACTION_SELECTION,
            selected_model=run.selected_model,
        )
        response = await self._request_structured_inference(
            run=run,
            model=model,
            messages=messages,
            response_model=AgentRouteEnvelope,
            purpose=InferencePurpose.ACTION_SELECTION,
            on_progress=on_progress,
        )
        action = parse_agent_route_json(response.content)
        self._record_structured_attempts(
            run=run,
            attempts=response.attempts,
            parsed=action.model_dump(),
            purpose=InferencePurpose.ACTION_SELECTION,
        )
        self._record_action(run=run, action=action)
        return action, messages

    async def _select_scoped_route(
        self,
        *,
        run: _RunContext,
        messages: list[dict[str, str]],
        user_message: str,
        on_progress: Callable[[StructuredInferenceProgress], None],
    ) -> ScopedRouteEnvelope:
        model = self._model_policy.for_stage(
            purpose=InferencePurpose.ACTION_SELECTION,
            selected_model=run.selected_model,
        )
        if not isinstance(user_message, str) or user_message.strip() == "":
            raise ValueError("Scoped route user_message must not be blank")
        constraints = ScopedRouteConstraints(
            explicit_saved_notes_request=request_explicitly_requires_saved_notes(
                user_message
            ),
        )
        with bind_scoped_route_constraints(constraints):
            response = await self._request_structured_inference(
                run=run,
                model=model,
                messages=messages,
                response_model=ScopedRouteEnvelope,
                purpose=InferencePurpose.ACTION_SELECTION,
                on_progress=on_progress,
            )
            route = ScopedRouteEnvelope.model_validate_json(response.content)
        self._record_structured_attempts(
            run=run,
            attempts=response.attempts,
            parsed=route.model_dump(),
            purpose=InferencePurpose.ACTION_SELECTION,
        )
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="ACTION",
            label=f"Action: {route.kind}",
            detail={"action": route.model_dump(mode="json")},
            duration_ms=0.0,
        )
        return route

    async def _prepare_search_action(
        self,
        *,
        run: _RunContext,
        messages: list[dict[str, str]],
        on_progress: Callable[[StructuredInferenceProgress], None],
    ) -> SearchNotesAction:
        model = self._model_policy.for_stage(
            purpose=InferencePurpose.SEARCH_QUERY,
            selected_model=run.selected_model,
        )
        response = await self._request_structured_inference(
            run=run,
            model=model,
            messages=messages,
            response_model=SearchQueryEnvelope,
            purpose=InferencePurpose.SEARCH_QUERY,
            on_progress=on_progress,
        )
        action = parse_search_query_json(response.content)
        self._record_structured_attempts(
            run=run,
            attempts=response.attempts,
            parsed=action.model_dump(),
            purpose=InferencePurpose.SEARCH_QUERY,
        )
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="ACTION_ARGUMENTS",
            label="Prepared action: search_notes",
            detail={"action": action.model_dump()},
            duration_ms=0.0,
        )
        return action

    async def _request_structured_inference(
        self,
        *,
        run: _RunContext,
        model: str,
        messages: list[dict[str, str]],
        response_model: type[BaseModel],
        purpose: InferencePurpose,
        on_progress: Callable[[StructuredInferenceProgress], None],
    ) -> InferenceResponse:
        # lint: allow-PY001 rationale="capture Instructor retry attempts before surfacing an external inference failure"
        try:
            return await self._inference.infer_structured(
                base_url=run.base_url,
                model=model,
                thinking_level=run.thinking_level,
                messages=messages,
                response_model=response_model,
                on_progress=on_progress,
            )
        except StructuredInferenceError as exc:
            self._record_structured_attempts(
                run=run,
                attempts=exc.attempts,
                parsed={},
                purpose=purpose,
            )
            response_label = "agent route"
            if purpose == InferencePurpose.SEARCH_QUERY:
                response_label = "search query"
            attempt_count = len(exc.attempts)
            attempt_label = "attempt"
            if attempt_count != 1:
                attempt_label = "attempts"
            raise AgentExecutionError(
                f"The model could not produce a valid {response_label} after "
                f"{attempt_count} {attempt_label}. Open Agent Debug for exact request "
                "and response details."
            ) from exc

    @staticmethod
    async def _stream_progress_until_complete(
        *,
        progress_queue: asyncio.Queue[StructuredInferenceProgress],
        action_task: asyncio.Task[object],
    ) -> AsyncIterator[StructuredInferenceProgress]:
        try:
            while not action_task.done():
                receive_task = asyncio.create_task(progress_queue.get())
                completed, _ = await asyncio.wait(
                    {action_task, receive_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if receive_task in completed:
                    yield receive_task.result()
                    continue
                receive_task.cancel()
                with suppress(asyncio.CancelledError):
                    await receive_task
            while not progress_queue.empty():
                yield progress_queue.get_nowait()
        finally:
            if not action_task.done():
                action_task.cancel()
                with suppress(asyncio.CancelledError):
                    await action_task

    def _record_action(
        self,
        *,
        run: _RunContext,
        action: AgentRouteAction,
    ) -> None:
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="ACTION",
            label=f"Action: {action.kind}",
            detail={"action": action.model_dump()},
            duration_ms=0.0,
        )

    def _record_inference_progress(
        self,
        *,
        run: _RunContext,
        progress: StructuredInferenceProgress,
        purpose: InferencePurpose,
    ) -> None:
        event = self._progress_status_event(
            progress,
            purpose=purpose,
            provider_label=self._provider_label,
        )
        if progress.phase == "output_progress":
            return
        if progress.phase == "attempt_started":
            self._record_wire_request(
                run=run,
                purpose=purpose,
                attempt=progress.attempt,
                max_attempts=progress.max_attempts,
                wire_request=progress.wire_request,
            )
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="MODEL_STATUS",
            label=event["label"],
            detail={
                "phase": progress.phase,
                "attempt": progress.attempt,
                "max_attempts": progress.max_attempts,
                "approx_input_tokens": event["approx_input_tokens"],
                "failure_kind": progress.failure_kind,
                "error_type": progress.error_type,
                "error_message": progress.error_message,
            },
            duration_ms=progress.duration_ms,
        )

    def _record_skill_activation(
        self,
        *,
        run: _RunContext,
        skill: AgentSkill,
    ) -> None:
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="SKILL",
            label=f"Activated skill: {skill.title}",
            detail={
                "skill_id": skill.skill_id,
                "title": skill.title,
                "trigger_action": skill.trigger_action,
                "content": skill.content,
            },
            duration_ms=0.0,
        )

    def _record_model_context(
        self,
        *,
        run: _RunContext,
        context_window: InferenceContextWindow,
    ) -> None:
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="MODEL_CONTEXT",
            label=f"{self._provider_label} model context",
            detail={
                "model": context_window.model,
                "maximum_tokens": context_window.maximum_tokens,
                "loaded_tokens": context_window.loaded_tokens,
                "required_tokens": context_window.required_tokens,
                "is_sufficient": context_window.is_sufficient,
            },
            duration_ms=0.0,
        )

    def _record_duplicate_search_policy(
        self,
        *,
        run: _RunContext,
        action: SearchNotesAction,
    ) -> None:
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="POLICY_DECISION",
            label="Skipped duplicate search",
            detail={
                "tool": action.kind,
                "allowed": False,
                "permission": "read",
                "mutates": False,
                "reason": "The same semantic query already completed.",
                "arguments": action.model_dump(),
            },
            duration_ms=0.0,
        )

    def _record_repeat_search_selection_policy(
        self,
        *,
        run: _RunContext,
        action: SearchNotesIntent,
    ) -> None:
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="POLICY_DECISION",
            label="Skipped repeat-search selection",
            detail={
                "action": action.model_dump(),
                "allowed": False,
                "reason": (
                    "The repeat-search rationale restates a completed query instead "
                    "of identifying missing evidence."
                ),
            },
            duration_ms=0.0,
        )

    def _publish_inference_progress(
        self,
        *,
        run: _RunContext,
        progress_queue: asyncio.Queue[StructuredInferenceProgress],
        progress: StructuredInferenceProgress,
        purpose: InferencePurpose,
    ) -> None:
        self._record_inference_progress(run=run, progress=progress, purpose=purpose)
        progress_queue.put_nowait(progress)

    def _execute_tool(
        self,
        *,
        run: _RunContext,
        messages: list[dict[str, str]],
        action: SearchNotesAction | ReadNotesByIdAction,
    ) -> tuple[list[dict[str, str]], ToolExecutionResult]:
        spec = self._tool_registry.spec_for(action)
        decision = self._permission_policy.authorize(spec=spec)
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="POLICY_DECISION",
            label=f"Allowed: {spec.name}",
            detail={
                "tool": spec.name,
                "allowed": decision.allowed,
                "permission": decision.permission,
                "mutates": spec.mutates,
                "reason": decision.reason,
            },
            duration_ms=0.0,
        )
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="TOOL_CALL",
            label=f"Tool call: {spec.name}",
            detail={"tool": spec.name, "arguments": action.model_dump()},
            duration_ms=0.0,
        )
        started_at = time.perf_counter()
        result = self._tool_registry.execute(
            action,
            settings=run.retrieval_settings,
        )
        duration_ms = (time.perf_counter() - started_at) * 1_000
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="TOOL_RESULT",
            label=f"Tool result: {spec.name}",
            detail={"tool": spec.name, "payload": result.payload},
            duration_ms=duration_ms,
        )
        with_action = self._context_builder.append_action(messages=messages, action=action)
        return (
            self._context_builder.append_tool_result(
                messages=with_action,
                result=result,
                prompts=run.prompts,
            ),
            result,
        )

    async def _stream_final_response(
        self,
        *,
        run: _RunContext,
        messages: list[dict[str, str]],
        action: RespondAction,
        reference_note_ids: tuple[str, ...],
    ) -> AsyncIterator[dict[str, object]]:
        if not isinstance(reference_note_ids, tuple):
            raise TypeError("reference_note_ids must be a tuple")
        final_messages = self._context_builder.append_final_request(
            messages=messages,
            action=action,
            prompts=run.prompts,
            current_user_request=run.current_user_request,
        )
        async for event in self._stream_prebuilt_final_response(
            run=run,
            final_messages=final_messages,
            reference_note_ids=reference_note_ids,
        ):
            yield event

    async def _stream_prebuilt_final_response(
        self,
        *,
        run: _RunContext,
        final_messages: list[dict[str, str]],
        reference_note_ids: tuple[str, ...],
    ) -> AsyncIterator[dict[str, object]]:
        if not isinstance(reference_note_ids, tuple):
            raise TypeError("reference_note_ids must be a tuple")
        model = self._model_policy.for_stage(
            purpose=InferencePurpose.FINAL_RESPONSE,
            selected_model=run.selected_model,
        )
        final_input_tokens = estimate_message_tokens(final_messages)
        yield self._status_event(
            "respond",
            "started",
            "Writing response",
            approx_input_tokens=final_input_tokens,
        )
        started_at = time.perf_counter()
        state = _FinalStreamState(thinking="", content="", usage={}, did_finish=False)
        last_reported_output_tokens = 0
        for attempt in (1, 2):
            state = _FinalStreamState(thinking="", content="", usage={}, did_finish=False)
            # lint: allow-PY001 rationale="retry a failed external model stream only before output"
            try:
                async for event in self._inference.stream_text(
                    base_url=run.base_url,
                    model=model,
                    thinking_level=run.thinking_level,
                    messages=final_messages,
                    max_output_tokens=_final_response_max_output_tokens(
                        provider_label=self._provider_label
                    ),
                    on_request=lambda wire_request, current_attempt=attempt: self._record_wire_request(
                        run=run,
                        purpose=InferencePurpose.FINAL_RESPONSE,
                        attempt=current_attempt,
                        max_attempts=2,
                        wire_request=wire_request,
                    ),
                ):
                    should_yield = self._consume_final_event(event=event, state=state)
                    output_tokens_received = estimate_text_tokens(
                        f"{state.thinking}{state.content}"
                    )
                    if output_tokens_received >= last_reported_output_tokens + 8:
                        last_reported_output_tokens = output_tokens_received
                        yield self._output_status_event(
                            "respond",
                            "started",
                            "Writing response",
                            approx_input_tokens=final_input_tokens,
                            output_tokens_received=output_tokens_received,
                            duration_ms=(time.perf_counter() - started_at) * 1_000,
                        )
                    if should_yield:
                        if event["type"] == "content_delta":
                            yield {
                                **event,
                                "reference_note_ids": list(reference_note_ids),
                            }
                        else:
                            yield event
                break
            # lint: allow-PY001 rationale="retry one external model-provider failure only before output"
            except InferenceProviderError:
                has_partial_output = any(
                    (state.thinking != "", state.content != "")
                )
                if has_partial_output or attempt == 2:
                    raise
                yield self._status_event(
                    "respond",
                    "started",
                    (
                        f"{self._provider_label} rejected the response before output · "
                        "retrying attempt 2 of 2"
                    ),
                    approx_input_tokens=final_input_tokens,
                )
        self._validate_final_stream(state)
        duration_ms = (time.perf_counter() - started_at) * 1_000
        self._record_final_response(run=run, state=state, duration_ms=duration_ms)
        self._trace_store.complete_run(session_key=run.session_key, run_id=run.run_id)
        final_output_tokens = estimate_text_tokens(
            f"{state.thinking}{state.content}"
        )
        if "eval_count" in state.usage:
            final_output_tokens = state.usage["eval_count"]
        yield self._output_status_event(
            "respond",
            "completed",
            "Response complete",
            approx_input_tokens=final_input_tokens,
            output_tokens_received=final_output_tokens,
            duration_ms=duration_ms,
        )
        yield {
            "type": "done",
            "reference_note_ids": list(reference_note_ids),
        }

    def _record_evidence_payload(
        self,
        *,
        run: _RunContext,
        evidence_payload: InvestigationEvidencePayload,
    ) -> None:
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="EVIDENCE_PAYLOAD",
            label=f"Evidence payload sent to {self._provider_label}",
            detail={
                "evidence_payload": serialize_investigation_evidence_payload(
                    evidence_payload
                ),
            },
            duration_ms=0.0,
        )

    @staticmethod
    def _evidence_payload_status_label(
        evidence_payload: InvestigationEvidencePayload,
    ) -> str:
        if not isinstance(evidence_payload, InvestigationEvidencePayload):
            raise TypeError(
                "evidence_payload must be InvestigationEvidencePayload"
            )
        return (
            "Evidence ready · "
            f"{len(evidence_payload.evidence_note_ids)} notes in "
            f"{len(evidence_payload.result_tree_ids)} result trees · "
            "≈ "
            f"{evidence_payload.returned_approximate_token_count:,} "
            "evidence tokens"
        )

    @staticmethod
    def _merge_reference_note_ids(
        *,
        current_note_ids: list[str],
        tool_result: ToolExecutionResult,
    ) -> list[str]:
        if not isinstance(current_note_ids, list):
            raise TypeError("current_note_ids must be a list")
        raw_notes = tool_result.payload["notes"]
        if not isinstance(raw_notes, list):
            raise RuntimeError("Agent tool result notes must be a list")
        merged_note_ids = list(current_note_ids)
        seen_note_ids = set(current_note_ids)
        if len(seen_note_ids) != len(current_note_ids):
            raise RuntimeError("Current reference note ids contain duplicates")
        for raw_note in raw_notes:
            if not isinstance(raw_note, dict):
                raise RuntimeError("Agent tool result note must be an object")
            note_id = raw_note["note_id"]
            if not isinstance(note_id, str) or note_id == "":
                raise RuntimeError("Agent tool result note_id must be non-empty")
            content_is_redacted = raw_note["content_is_redacted"]
            if not isinstance(content_is_redacted, bool):
                raise RuntimeError(
                    "Agent tool result content_is_redacted must be boolean"
                )
            if content_is_redacted or note_id in seen_note_ids:
                continue
            seen_note_ids.add(note_id)
            merged_note_ids.append(note_id)
        return merged_note_ids

    @staticmethod
    def _consume_final_event(
        *,
        event: dict[str, object],
        state: _FinalStreamState,
    ) -> bool:
        event_type = event["type"]
        if event_type in {"thinking_delta", "content_delta"}:
            if "text" not in event:
                raise RuntimeError(f"Inference {event_type} is missing text")
            text = event["text"]
            if not isinstance(text, str) or text == "":
                raise RuntimeError(f"Inference {event_type} must contain text")
            if event_type == "thinking_delta":
                state.thinking += text
            else:
                state.content += text
            return True
        if event_type != "done":
            raise RuntimeError(f"Unknown inference stream event: {event_type}")
        state.did_finish = True
        raw_usage = {}
        if "usage" in event:
            raw_usage = event["usage"]
        if not isinstance(raw_usage, dict):
            raise RuntimeError("Inference done event usage must be an object")
        if not all(
            isinstance(key, str) and isinstance(value, int)
            for key, value in raw_usage.items()
        ):
            raise RuntimeError("Inference done event usage values must be integers")
        state.usage = dict(raw_usage)
        return False

    @staticmethod
    def _validate_final_stream(state: _FinalStreamState) -> None:
        if not state.did_finish:
            raise AgentExecutionError("Final response stream ended before completion")
        if state.content == "":
            raise AgentExecutionError("The model returned an empty final response")

    def _record_final_response(
        self,
        *,
        run: _RunContext,
        state: _FinalStreamState,
        duration_ms: float,
    ) -> None:
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="MODEL_RESPONSE",
            label="Model response: final-response",
            detail={
                "raw_response": state.content,
                "reasoning": state.thinking,
                "usage": state.usage,
                "validation": "not-applicable",
                "parsed": {},
                "errors": [],
            },
            duration_ms=duration_ms,
        )
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="FINAL_RESPONSE",
            label="Final response",
            detail={"content": state.content},
            duration_ms=0.0,
        )

    def _record_wire_request(
        self,
        *,
        run: _RunContext,
        purpose: InferencePurpose,
        attempt: int,
        max_attempts: int,
        wire_request: dict[str, object],
    ) -> None:
        attempt_suffix = self._attempt_label_suffix(
            attempt=attempt,
            max_attempts=max_attempts,
        )
        self._trace_store.append_event(
            session_key=run.session_key,
            run_id=run.run_id,
            event_type="OLLAMA_REQUEST",
            label=(
                f"{self._provider_label} wire request: {purpose.value}"
                f"{attempt_suffix}"
            ),
            detail={
                "purpose": purpose.value,
                "attempt": attempt,
                "max_attempts": max_attempts,
                **wire_request,
            },
            duration_ms=0.0,
        )

    def _record_structured_attempts(
        self,
        *,
        run: _RunContext,
        attempts: list[InferenceAttempt],
        parsed: dict[str, object],
        purpose: InferencePurpose,
    ) -> None:
        for attempt_number, attempt in enumerate(attempts, start=1):
            is_success = attempt.error == "" and attempt_number == len(attempts)
            self._trace_store.append_event(
                session_key=run.session_key,
                run_id=run.run_id,
                event_type="MODEL_RESPONSE",
                label=f"Model response: {purpose.value}",
                detail={
                    "raw_response": attempt.response,
                    "validation": "valid" if is_success else "invalid",
                    "parsed": parsed if is_success else {},
                    "errors": [] if attempt.error == "" else [attempt.error],
                },
                duration_ms=attempt.duration_ms,
            )

    def _record_failure(self, *, session_key: str, run_id: str, error: str) -> None:
        self._trace_store.append_event(
            session_key=session_key,
            run_id=run_id,
            event_type="ERROR",
            label="Agent run failed",
            detail={"error": error},
            duration_ms=0.0,
        )
        self._trace_store.fail_run(session_key=session_key, run_id=run_id, error=error)

    @staticmethod
    def _tool_status_label(action: SearchNotesAction | ReadNotesByIdAction) -> str:
        if isinstance(action, SearchNotesAction):
            return f"Searching notes · {action.query}"
        count = len(action.note_ids)
        noun = "notes"
        if count == 1:
            noun = "note"
        return f"Reading {count} {noun} by ID"

    @staticmethod
    def _tool_completed_status_label(
        *,
        action: SearchNotesAction | ReadNotesByIdAction,
        result: ToolExecutionResult,
    ) -> str:
        assert result.action_name == action.kind
        if isinstance(action, SearchNotesAction):
            matched_count = result.payload["matched_count"]
            matched_note_count = result.payload["matched_note_count"]
            returned_count = result.payload["returned_count"]
            returned_note_count = result.payload["returned_note_count"]
            omitted_count = result.payload["omitted_count"]
            assert isinstance(matched_count, int) and not isinstance(matched_count, bool)
            assert isinstance(matched_note_count, int) and not isinstance(
                matched_note_count,
                bool,
            )
            assert isinstance(returned_note_count, int) and not isinstance(
                returned_note_count,
                bool,
            )
            assert isinstance(returned_count, int) and not isinstance(
                returned_count,
                bool,
            )
            assert isinstance(omitted_count, int) and not isinstance(
                omitted_count,
                bool,
            )
            assert matched_count >= 0
            assert matched_note_count >= 0
            assert returned_count >= 0
            assert returned_note_count >= 0
            assert omitted_count >= 0
            result_tree_noun = "result trees"
            if matched_count == 1:
                result_tree_noun = "result tree"
            matching_note_noun = "matching notes"
            if matched_note_count == 1:
                matching_note_noun = "matching note"
            return (
                f"Search complete · {returned_count} of {matched_count} "
                f"{result_tree_noun} · {returned_note_count} of {matched_note_count} "
                f"{matching_note_noun} · {omitted_count} trailing result trees "
                f"omitted · {action.query}"
            )
        return AgentRuntime._tool_status_label(action)

    @staticmethod
    def _progress_status_event(
        progress: StructuredInferenceProgress,
        *,
        purpose: InferencePurpose,
        provider_label: str,
    ) -> dict[str, object]:
        if not isinstance(provider_label, str) or provider_label == "":
            raise ValueError("Structured inference provider label must be non-empty")
        if not isinstance(purpose, InferencePurpose):
            raise TypeError("Structured inference purpose is invalid")
        if progress.attempt < 1 or progress.attempt > progress.max_attempts:
            raise ValueError("Structured inference progress attempt is invalid")
        attempt_suffix = AgentRuntime._attempt_label_suffix(
            attempt=progress.attempt,
            max_attempts=progress.max_attempts,
        )
        attempt_text = attempt_suffix.removeprefix(" · ")
        approx_input_tokens = AgentRuntime._wire_request_input_tokens(
            progress.wire_request
        )
        if progress.phase == "attempt_started":
            operation_label = f"{provider_label} choosing next action"
            if purpose == InferencePurpose.SEARCH_QUERY:
                operation_label = (
                    f"{provider_label} preparing MetaList search query"
                )
            label = f"{operation_label}{attempt_suffix}"
            if progress.attempt > 1:
                label = f"Instructor retrying · {label}"
            return AgentRuntime._output_status_event(
                "model_request",
                "started",
                label,
                approx_input_tokens=approx_input_tokens,
                output_tokens_received=progress.output_tokens_received,
                duration_ms=progress.duration_ms,
            )
        if progress.phase == "output_progress":
            operation_label = f"{provider_label} choosing next action"
            if purpose == InferencePurpose.SEARCH_QUERY:
                operation_label = (
                    f"{provider_label} preparing MetaList search query"
                )
            return AgentRuntime._output_status_event(
                "model_request",
                "started",
                f"{operation_label}{attempt_suffix}",
                approx_input_tokens=approx_input_tokens,
                output_tokens_received=progress.output_tokens_received,
                duration_ms=progress.duration_ms,
            )
        if progress.phase == "response_received":
            response_label = f"{provider_label} returned next-action choice"
            if purpose == InferencePurpose.SEARCH_QUERY:
                response_label = (
                    f"{provider_label} returned search-query proposal"
                )
            return AgentRuntime._output_status_event(
                "validation",
                "started",
                (
                    f"{response_label} · validating"
                    f"{' ' + attempt_text if attempt_text else ''}"
                ),
                approx_input_tokens=approx_input_tokens,
                output_tokens_received=progress.output_tokens_received,
                duration_ms=progress.duration_ms,
            )
        if progress.phase == "retrying":
            return AgentRuntime._output_status_event(
                "retry",
                "started",
                f"{progress.failure_kind} ({progress.error_type}) · Instructor will retry",
                approx_input_tokens=approx_input_tokens,
                output_tokens_received=progress.output_tokens_received,
                duration_ms=progress.duration_ms,
            )
        if progress.phase == "attempt_failed":
            return AgentRuntime._output_status_event(
                "retry",
                "completed",
                f"{progress.failure_kind} ({progress.error_type}) · no retries remain",
                approx_input_tokens=approx_input_tokens,
                output_tokens_received=progress.output_tokens_received,
                duration_ms=progress.duration_ms,
            )
        if progress.phase == "attempt_succeeded":
            output_label = "Structured action validated"
            if purpose == InferencePurpose.SEARCH_QUERY:
                output_label = "Structured search query validated"
            return AgentRuntime._output_status_event(
                "validation",
                "completed",
                f"{output_label}{attempt_suffix}",
                approx_input_tokens=approx_input_tokens,
                output_tokens_received=progress.output_tokens_received,
                duration_ms=progress.duration_ms,
            )
        raise ValueError(f"Unsupported structured inference phase: {progress.phase}")

    @staticmethod
    def _attempt_label_suffix(*, attempt: int, max_attempts: int) -> str:
        if (
            not isinstance(attempt, int)
            or isinstance(attempt, bool)
            or not isinstance(max_attempts, int)
            or isinstance(max_attempts, bool)
            or attempt < 1
            or max_attempts < 1
            or attempt > max_attempts
        ):
            raise ValueError("Attempt label requires a valid attempt range")
        if attempt == 1:
            return ""
        return f" · attempt {attempt} of {max_attempts}"

    def _model_context_check_label(self) -> str:
        if self._provider_label == "Ollama":
            return "Loading Ollama model and checking context"
        return f"Checking {self._provider_label} model context"

    @staticmethod
    def _wire_request_input_tokens(wire_request: dict[str, object]) -> int:
        if not isinstance(wire_request, dict):
            raise TypeError("Structured inference wire request must be an object")
        body = wire_request["body"]
        if not isinstance(body, dict):
            raise TypeError("Structured inference wire request body must be an object")
        messages = body["messages"]
        if not isinstance(messages, list):
            raise TypeError("Structured inference wire messages must be a list")
        request_without_messages = {
            key: value for key, value in body.items() if key != "messages"
        }
        return estimate_message_tokens(messages) + estimate_input_tokens(
            request_without_messages
        )

    @staticmethod
    def _selected_action_status_event(
        action: AgentRouteAction,
        *,
        completed_search_count: int,
        approx_input_tokens: int,
    ) -> dict[str, object]:
        if (
            not isinstance(completed_search_count, int)
            or isinstance(completed_search_count, bool)
            or completed_search_count < 0
        ):
            raise ValueError("Completed search count must be a non-negative integer")
        if isinstance(action, SearchNotesIntent):
            label = "Selected action · Search notes"
            if completed_search_count > 0:
                label = "Selected action · Search again"
            reason = action.rationale
        elif isinstance(action, ReadNotesByIdAction):
            count = len(action.note_ids)
            noun = "notes"
            if count == 1:
                noun = "note"
            label = f"Selected action · Read {count} {noun} by ID"
            reason = action.rationale
        elif isinstance(action, RespondAction):
            label = "Selected action · Respond to user"
            reason = action.basis
        else:
            raise TypeError(f"Unsupported selected action: {type(action)}")
        label = f"{label} · {AgentRuntime._compact_status_reason(reason)}"
        return AgentRuntime._status_event(
            action.kind,
            "completed",
            label,
            approx_input_tokens=approx_input_tokens,
        )

    @staticmethod
    def _search_request_key(action: SearchNotesAction) -> _SearchRequestKey:
        if not isinstance(action, SearchNotesAction):
            raise TypeError("Search request key requires a SearchNotesAction")
        return AgentRuntime._search_query_semantic_key(action.query)

    @staticmethod
    def _search_query_semantic_key(query: str) -> _SearchQueryKey:
        if not isinstance(query, str) or query.strip() == "":
            raise ValueError("Search query semantic key requires non-empty text")
        parsed_query = parse_search_query(query)
        clause_keys = frozenset(
            (
                frozenset(term.casefold() for term in clause.required_tags),
                frozenset(term.casefold() for term in clause.forbidden_tags),
                frozenset(term.casefold() for term in clause.required_text),
                frozenset(term.casefold() for term in clause.forbidden_text),
            )
            for clause in parsed_query.clauses
        )
        return clause_keys

    @staticmethod
    def _search_query_surface_key(query: str) -> str:
        if not isinstance(query, str) or query.strip() == "":
            raise ValueError("Search query surface key requires non-empty text")
        return " ".join(query.split()).casefold()

    @staticmethod
    def _search_intent_repeats_completed_query(
        *,
        action: SearchNotesIntent,
        completed_search_query_texts: set[str],
    ) -> bool:
        if not isinstance(action, SearchNotesIntent):
            raise TypeError("Repeat-search check requires SearchNotesIntent")
        if not isinstance(completed_search_query_texts, set):
            raise TypeError("Completed search query texts must be a set")
        proposed_query_text = " ".join(action.rationale.split()).casefold()
        return proposed_query_text in completed_search_query_texts

    @staticmethod
    def _compact_status_reason(reason: str) -> str:
        if not isinstance(reason, str) or reason.strip() == "":
            raise ValueError("Activity reason must be a non-empty string")
        normalized_reason = " ".join(reason.split())
        maximum_characters = 240
        if len(normalized_reason) <= maximum_characters:
            return normalized_reason
        return f"{normalized_reason[: maximum_characters - 1].rstrip()}…"

    @staticmethod
    def _status_event(
        action: str,
        status: str,
        label: str,
        *,
        approx_input_tokens: int,
    ) -> dict[str, object]:
        if status not in {"started", "completed"}:
            raise ValueError("Unsupported action status")
        if (
            not isinstance(approx_input_tokens, int)
            or isinstance(approx_input_tokens, bool)
            or approx_input_tokens < 1
        ):
            raise ValueError("Approximate input tokens must be a positive integer")
        return {
            "type": "action_status",
            "action": action,
            "status": status,
            "label": label,
            "approx_input_tokens": approx_input_tokens,
            "output_tokens_received": 0,
            "duration_ms": 0.0,
        }

    @staticmethod
    def _output_status_event(
        action: str,
        status: str,
        label: str,
        *,
        approx_input_tokens: int,
        output_tokens_received: int,
        duration_ms: float,
    ) -> dict[str, object]:
        if (
            not isinstance(output_tokens_received, int)
            or isinstance(output_tokens_received, bool)
            or output_tokens_received < 0
        ):
            raise ValueError("Output tokens received must be a non-negative integer")
        if (
            not isinstance(duration_ms, (int, float))
            or isinstance(duration_ms, bool)
            or not math.isfinite(duration_ms)
            or duration_ms < 0
        ):
            raise ValueError("Activity duration must be a non-negative finite number")
        event = AgentRuntime._status_event(
            action,
            status,
            label,
            approx_input_tokens=approx_input_tokens,
        )
        event["output_tokens_received"] = output_tokens_received
        event["duration_ms"] = float(duration_ms)
        return event
