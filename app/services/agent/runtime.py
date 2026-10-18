"""Explicit application-owned execution loop for read-only PKMS agents."""

from __future__ import annotations

import asyncio
from contextlib import aclosing
import json
import math
import time
from collections import deque
from collections.abc import AsyncIterator
from collections.abc import Callable
from dataclasses import dataclass

from pydantic import BaseModel

from app.services.agent.failure_explanations import FailureSetup, explain_structured_failure
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
from app.services.agent.agent_loop import AgentLoopMixin
from app.services.agent.execution_errors import AgentExecutionError
from app.services.agent.investigation import InvestigationState
from app.services.agent.investigation import CompleteRootBatchPlan
from app.services.agent.model_policy import InferencePurpose
from app.services.agent.model_policy import SingleModelPolicy
from app.services.agent.staged_summary import SummaryBatchResult
from app.services.agent.staged_summary import SummaryFindingsResult
from app.services.agent.summary_batch_store import summary_batch_key
from app.services.agent.summary_batch_store import summary_batch_store
from app.services.agent.staged_summary import attach_summary_coverage
from app.services.agent.staged_summary import classify_uncitable_note_ids
from app.services.agent.staged_summary import estimate_summary_results_tokens
from app.services.agent.staged_summary import partition_summary_results
from app.services.agent.staged_summary import structural_placeholder_note_ids
from app.services.agent.staged_summary import summary_reference_note_ids
from app.services.agent.staged_summary import summarize_partial_findings
from app.services.agent.prompt_settings import AgentPromptSet
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.skill_settings import AgentSkill
from app.services.agent.skill_settings import AgentSkillSet
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.scope import describe_text_extraction
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.agent.token_estimation import estimate_message_tokens
from app.services.agent.token_estimation import estimate_text_tokens
from app.services.agent.trace import AgentTraceStore
from app.services.agent.web_settings import AgentWebSettings
from app.services.agent.web_capabilities import build_web_url_capabilities
from app.services.agent.web_evidence import WebPageEvidence
from app.services.agent.web_evidence import citation_references_for_pages
from app.services.agent.web_evidence import web_evidence_store
from app.services.bulk_operation import bulk_operation_guard
from app.services.agent.history import record_history
from app.services.agent.ai_send import send_structured
from app.services.agent.ai_send import send_text_stream
from app.utils.time_units import MS_PER_SECOND


_STAGED_SUMMARY_CONCURRENCY = 4
_MAX_STAGED_SUMMARY_REDUCTION_LEVELS = 8
# One batch is a plain summary; staging starts at two.
_MIN_STAGED_SUMMARY_BATCHES = 2
# The final response is retried once after a provider failure that produced no output.
_FINAL_RESPONSE_MAX_ATTEMPTS = 2
# One corrective request when a summary cites IDs that were not disclosed as evidence.
_SUMMARY_CITATION_CORRECTIONS = 1
# Streamed batch previews are throttled per batch and trimmed to a compact tail.
_SUMMARY_STREAM_INTERVAL_SECONDS = 0.3
_SUMMARY_PREVIEW_TAIL_CHARACTERS = 240
_OPENAI_FINAL_RESPONSE_MAX_OUTPUT_TOKENS = 8_192
_FINAL_RESPONSE_MAX_OUTPUT_TOKENS_BY_PROVIDER = {
    "OpenAI": _OPENAI_FINAL_RESPONSE_MAX_OUTPUT_TOKENS,
}
# While the final response streams, its output-token count is reported again
# after at least this many more tokens.
_OUTPUT_PROGRESS_REPORT_TOKENS = 8



@dataclass(frozen=True, slots=True)
class _SummaryBatchStarted:
    batch_index: int


@dataclass(frozen=True, slots=True)
class _SummaryBatchStreaming:
    batch_index: int
    finding_count: int
    latest_text: str
    output_tokens: int

    def __post_init__(self) -> None:
        assert self.finding_count >= 0
        assert self.output_tokens >= 0
        assert len(self.latest_text) <= _SUMMARY_PREVIEW_TAIL_CHARACTERS


@dataclass(frozen=True, slots=True)
class _SummaryBatchCompleted:
    batch_index: int
    summary: SummaryBatchResult


_SummaryBatchTransition = (
    _SummaryBatchStarted | _SummaryBatchStreaming | _SummaryBatchCompleted
)


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
    web_settings: AgentWebSettings


@dataclass(slots=True)
class _FinalStreamState:
    thinking: str
    content: str
    usage: dict[str, int]
    did_finish: bool


class AgentRuntime(AgentLoopMixin):
    def __init__(
        self,
        *,
        context_builder: AgentContextBuilder,
        inference: InferenceAdapter,
        model_policy: SingleModelPolicy,
        trace_store: AgentTraceStore,
        provider_label: str,
    ) -> None:
        if not isinstance(provider_label, str) or provider_label == "":
            raise ValueError("Agent runtime provider label must be non-empty")
        self._context_builder = context_builder
        self._inference = inference
        self._model_policy = model_policy
        self._trace_store = trace_store
        self._provider_label = provider_label

    async def stream_agent(
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
        web_settings: AgentWebSettings,
        frozen_scope: ScopedSearchSnapshot,
        tagging_run,
        earlier_actions: list[dict[str, object]],
    ) -> AsyncIterator[dict[str, object]]:
        """Answer with the tool-using agent loop (see agent_loop.py).

        `earlier_actions` is the agent's own record of what each earlier answer in
        the history did (AiChatSessionStore.earlier_actions, action_log.py)."""
        run, _initial_messages = self._start_run(
            session_key=session_key, base_url=base_url, selected_model=selected_model,
            thinking_level=thinking_level, canonical_messages=canonical_messages, prompts=prompts,
            skills=skills, retrieval_settings=retrieval_settings, web_settings=web_settings,
        )
        with record_history(self._trace_store, session_key=session_key, run_id=run.run_id):
            # lint: allow-PY001 rationale="record every agent run failure before immediately re-raising"
            try:
                async with aclosing(self._run_agent_loop(  # shockharness: ignore[EXC003] reason="the agent loop's events are pulled and recorded one by one; the handler records the run's failure"
                    run=run, canonical_messages=canonical_messages, frozen_scope=frozen_scope,
                    tagging_run=tagging_run, earlier_actions=earlier_actions,
                )) as steps:
                    async for event in steps:
                        self._trace_store.append_event(
                            session_key=run.session_key, run_id=run.run_id,
                            event_type="APPLICATION_EVENT", label="Application outcome",
                            detail=event, duration_ms=0.0,
                        )
                        yield event
            # lint: allow-PY001 rationale="record interrupted external inference before preserving cancellation"
            except asyncio.CancelledError:
                self._record_failure(session_key=session_key, run_id=run.run_id, error="Agent run interrupted")
                raise
            # lint: allow-PY001 rationale="record internal failure details and immediately re-raise"
            except Exception as exc:
                self._record_failure(session_key=session_key, run_id=run.run_id,
                                     error=f"{type(exc).__name__}: {exc}")
                raise

    async def _stream_view_summary(
        self,
        *,
        run: _RunContext,
        canonical_messages: list[dict[str, str]],
        snapshot: ScopedSearchSnapshot,
        state: InvestigationState,
        selected_note_tokens: int,
        route_tokens: int,
        continues_failed_summary: bool,
    ) -> AsyncIterator[dict[str, object]]:
        """Summarize the whole frozen view after the user confirms (the agent's summarize_view).

        When the agent says this continues a failed summary, batches kept from it
        (summary_batch_store.py) that match exactly are reused, the rest run with the
        original question, and the scope question is not asked again: the user chose
        to summarize everything when the kept batches ran."""
        if not isinstance(continues_failed_summary, bool):
            raise TypeError("continues_failed_summary must be a bool")
        skill = run.skills.for_action("summarize_current_scope")
        self._record_skill_activation(run=run, skill=skill)
        yield self._status_event(
            "skill",
            "completed",
            f"Activated skill · {skill.title}",
            approx_input_tokens=route_tokens,
        )
        extraction_before = snapshot.text_extraction.reading()
        # lint: allow-PY001 rationale="translate a user-configured evidence budget overflow into a concise operation failure"
        try:
            batch_plan = await asyncio.to_thread(
                state.plan_complete_root_batches,
                reserved_approximate_tokens=selected_note_tokens,
            )
        # lint: allow-PY001 rationale="an atomic root can legitimately exceed the user-configured summary batch limit"
        except ValueError as exc:
            raise AgentExecutionError(str(exc)) from exc
        # Planning measures every note, so it is where their text is extracted.
        yield self._status_event(
            "investigation_evidence",
            "completed",
            f"Planned {len(batch_plan.batches)} evidence batches for {batch_plan.result_tree_count} root notes"
            + describe_text_extraction(before=extraction_before, after=snapshot.text_extraction.reading()),
            approx_input_tokens=route_tokens,
        )
        # One evidence payload means one ordinary model call: no batches to pay
        # for or choose between, so the summary starts without a question.
        if len(batch_plan.batches) > 1:
            batch_keys = self._summary_batch_keys(run=run, skill=skill, snapshot=snapshot, plan=batch_plan)
            kept = None
            if continues_failed_summary:
                kept = summary_batch_store.kept(session_key=run.session_key)
            if kept is not None:
                reused = {
                    index: kept.results[key] for index, key in enumerate(batch_keys) if key in kept.results
                }
                if reused:
                    async with aclosing(self._stream_staged_scope_summary(
                        run=run,
                        canonical_messages=canonical_messages,
                        summary_request=kept.request,
                        state=state,
                        skill=skill,
                        plan=batch_plan,
                        batch_keys=batch_keys,
                        reused=reused,
                    )) as staged_events:
                        async for event in staged_events:
                            yield event
                    return
            prefix_root_count = InvestigationState.start(
                snapshot=snapshot,
                settings=run.retrieval_settings,
            ).retain_root_prefix_within_token_budget(
                reserved_approximate_tokens=selected_note_tokens,
            ).retained_result_tree_count
            # A summary only reads notes: its question blocks no other change.
            with bulk_operation_guard.ask(
                run.session_key, ("summarize_all", "use_prefix", "cancel"),
            ) as (question_id, answer):
                # Report scope size against the evidence budget, as tag proposals do.
                budget_ratio = (
                    (batch_plan.approximate_token_count + selected_note_tokens)
                    / run.retrieval_settings.max_page_approximate_tokens
                )
                minimum_model_calls = len(batch_plan.batches) + 1
                yield {
                    "type": "bulk_question",
                    "question_id": question_id,
                    "kind": "summary_confirmation",
                    "label": (
                        f"This scope uses approximately {budget_ratio:.2f}× the "
                        f"evidence budget: its {batch_plan.result_tree_count} root "
                        f"notes need {len(batch_plan.batches)} evidence batches "
                        "plus a final synthesis "
                        f"(at least {minimum_model_calls} model calls). "
                        f"MetaList runs at most {_STAGED_SUMMARY_CONCURRENCY} "
                        "batch requests at once."
                    ),
                    "root_count": batch_plan.result_tree_count,
                    "batch_count": len(batch_plan.batches),
                    "prefix_root_count": prefix_root_count,
                }
                choice = await answer
                if choice == "cancel":
                    self._trace_store.complete_run(
                        session_key=run.session_key,
                        run_id=run.run_id,
                    )
                    yield {"type": "bulk_complete", "changed": False}
                    yield {
                        "type": "content_delta",
                        "text": "Summary cancelled.",
                        "reference_note_ids": [],
                        "reference_web_ids": [],
                    }
                    yield {
                        "type": "done",
                        "reference_note_ids": [],
                        "reference_web_ids": [],
                    }
                    return
                if choice == "summarize_all":
                    async with aclosing(self._stream_staged_scope_summary(
                        run=run,
                        canonical_messages=canonical_messages,
                        summary_request=canonical_messages[-1]["content"],
                        state=state,
                        skill=skill,
                        plan=batch_plan,
                        batch_keys=batch_keys,
                        reused={},
                    )) as staged_events:
                        async for event in staged_events:
                            yield event
                    return
                assert choice == "use_prefix"
                yield {"type": "bulk_complete", "changed": False}
        retention = await asyncio.to_thread(
            state.retain_root_prefix_within_token_budget,
            reserved_approximate_tokens=selected_note_tokens,
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
                skill=skill,
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
        final_request = final_messages[-1]
        capabilities = build_web_url_capabilities(
            canonical_messages=canonical_messages,
            selected_note=snapshot.selected_note,
            investigation_evidence=evidence_payload,
            retained_web_urls=web_evidence_store.retained_urls(
                session_key=run.session_key
            ),
        )
        final_messages = self._context_builder.append_web_access_context(
            messages=final_messages[:-1],
            settings=run.web_settings,
            available_urls=capabilities.normalized_urls,
        )
        final_messages.append(final_request)
        async for event in self._stream_prebuilt_final_response(
            run=run,
            final_messages=final_messages,
            reference_note_ids=reference_note_ids,
            reference_web_evidence=(),
        ):
            yield event

    def _summary_batch_keys(
        self, *, run: _RunContext, skill: AgentSkill, snapshot: ScopedSearchSnapshot, plan: CompleteRootBatchPlan,
    ) -> tuple[str, ...]:
        """What identifies each batch's findings, for reuse when continuing a failed summary."""
        model = self._model_policy.for_stage(purpose=InferencePurpose.SUMMARY_BATCH, selected_model=run.selected_model)
        selected_note_payload = snapshot.selected_note.as_payload()
        return tuple(
            summary_batch_key(
                model=model, thinking_level=run.thinking_level, prompts=run.prompts, skill=skill,
                selected_note_payload=selected_note_payload, evidence_payload=batch,
            )
            for batch in plan.batches
        )

    async def _stream_staged_scope_summary(
        self,
        *,
        run: _RunContext,
        canonical_messages: list[dict[str, str]],
        summary_request: str,
        state: InvestigationState,
        skill: AgentSkill,
        plan: CompleteRootBatchPlan,
        batch_keys: tuple[str, ...],
        reused: dict[int, SummaryBatchResult],
    ) -> AsyncIterator[dict[str, object]]:
        """Batches, condensing and the final answer. If anything fails or the run
        stops, the finished batches are kept (summary_batch_store.py) so the summary
        can be continued; a successful summary drops them."""
        assert len(batch_keys) == len(plan.batches)
        summaries: list[SummaryBatchResult | None] = [None] * len(plan.batches)
        for index, summary in reused.items():
            summaries[index] = summary
        has_succeeded = False
        # lint: allow-PY001 rationale="keep a failed summary's finished batches, then re-raise with how many were kept"
        try:
            if len(plan.batches) < _MIN_STAGED_SUMMARY_BATCHES:
                raise ValueError("Staged scope summary requires at least two batches")
            # aclosing guarantees worker cancellation when the client abandons the stream.
            async with aclosing(self._stream_staged_summary_batches(  # shockharness: ignore[EXC003] reason="the staged summary (batches, reduction, final answer) is the operation whose failure says how many batches were kept"
                run=run,
                canonical_messages=canonical_messages,
                summary_request=summary_request,
                state=state,
                skill=skill,
                plan=plan,
                summaries=summaries,
            )) as batch_events:
                async for event in batch_events:
                    yield event
            if any(summary is None for summary in summaries):
                raise RuntimeError("Staged summary completed with missing batch results")
            ordered_summaries = tuple(
                summary for summary in summaries if summary is not None
            )
            summary_token_limit = run.retrieval_settings.max_page_approximate_tokens
            if state.snapshot.selected_note.status == "available":
                summary_token_limit -= estimate_input_tokens(
                    state.snapshot.selected_note.as_payload()
                )
            if summary_token_limit < 1:
                raise AgentExecutionError(
                    "Selected-note context leaves no room for staged summary evidence"
                )
            if estimate_summary_results_tokens(ordered_summaries) > (
                summary_token_limit
            ):
                yield {
                    "type": "bulk_progress",
                    "operation": "summary",
                    "committing": False,
                    "label": "Condensing batch summaries for final synthesis",
                    "completed_tokens": plan.approximate_token_count,
                    "total_tokens": plan.approximate_token_count,
                }
                ordered_summaries = await self._reduce_staged_summaries(
                    run=run,
                    canonical_messages=canonical_messages,
                    summary_request=summary_request,
                    state=state,
                    skill=skill,
                    summaries=ordered_summaries,
                )
            yield {
                "type": "bulk_progress",
                "operation": "summary",
                "committing": False,
                "label": (
                    f"Writing final answer from {len(plan.batches)} batch summaries"
                ),
                "completed_tokens": plan.approximate_token_count,
                "total_tokens": plan.approximate_token_count,
            }
            final_messages, reference_note_ids = (
                self._context_builder.build_staged_summary_final_messages(
                    canonical_messages=canonical_messages,
                    summary_request=summary_request,
                    prompts=run.prompts,
                    skill=skill,
                    snapshot=state.snapshot,
                    summaries=ordered_summaries,
                )
            )
            yield {"type": "bulk_complete", "changed": False}
            async for event in self._stream_prebuilt_final_response(
                run=run,
                final_messages=final_messages,
                reference_note_ids=reference_note_ids,
                reference_web_evidence=(),
            ):
                yield event
            has_succeeded = True
        # lint: allow-PY001 rationale="an explained summary failure says how many finished batches were kept, then re-raises"
        except AgentExecutionError as exc:
            finished_count = sum(1 for summary in summaries if summary is not None)
            if finished_count == 0:
                raise
            raise AgentExecutionError(
                f"{exc}\n{finished_count} of {len(summaries)} batches finished and were kept; "
                "ask again (for example \"try that again\") to finish the rest."
            ) from exc
        finally:
            finished = {
                batch_keys[index]: summary
                for index, summary in enumerate(summaries) if summary is not None
            }
            if has_succeeded or not finished:
                summary_batch_store.clear_session(session_key=run.session_key)
            else:
                summary_batch_store.keep(session_key=run.session_key, request=summary_request, results=finished)

    async def _stream_staged_summary_batches(
        self,
        *,
        run: _RunContext,
        canonical_messages: list[dict[str, str]],
        summary_request: str,
        state: InvestigationState,
        skill: AgentSkill,
        plan: CompleteRootBatchPlan,
        summaries: list[SummaryBatchResult | None],
    ) -> AsyncIterator[dict[str, object]]:
        """Seed the prompt cache with the first batch to run, then drain the rest through a bounded worker pool.

        ``summaries`` arrives with any batches reused from a failed attempt already
        filled in; the others are filled in canonical batch order, with one progress
        event for every batch transition, including throttled previews of streamed
        findings. When a batch fails, batches not started yet do not start, the ones
        running finish (their results stay in ``summaries`` to be kept), and the first
        failure then propagates, so no final synthesis runs on partial results.
        """
        batch_count = len(plan.batches)
        assert batch_count >= _MIN_STAGED_SUMMARY_BATCHES
        assert len(summaries) == batch_count
        batch_states = ["queued"] * batch_count
        batch_output_tokens = [0] * batch_count
        completed_tokens = 0
        for index, summary in enumerate(summaries):
            if summary is not None:
                batch_states[index] = "complete"
                completed_tokens += plan.batches[index].returned_approximate_token_count
        reused_count = batch_states.count("complete")
        if reused_count:
            yield {
                "type": "bulk_progress",
                "operation": "summary",
                "committing": False,
                "label": f"Reused {reused_count} of {batch_count} batches from your earlier attempt",
                "completed_tokens": completed_tokens,
                "total_tokens": plan.approximate_token_count,
            }
        transitions: asyncio.Queue[_SummaryBatchTransition] = asyncio.Queue()

        def apply_transition(transition: _SummaryBatchTransition) -> dict[str, object]:
            nonlocal completed_tokens
            index = transition.batch_index
            if not 0 <= index < batch_count:
                raise RuntimeError(f"Summary batch index {index} is outside the plan")
            batch_state = batch_states[index]
            if isinstance(transition, _SummaryBatchStarted):
                if batch_state != "queued":
                    raise RuntimeError(f"Summary batch {index + 1} started more than once")
                batch_states[index] = "writing"
                status, finding_count, latest_text = "writing", 0, ""
            elif isinstance(transition, _SummaryBatchStreaming):
                if batch_state != "writing":
                    raise RuntimeError(
                        f"Summary batch {index + 1} streamed outside its request"
                    )
                batch_output_tokens[index] = transition.output_tokens
                status = "streaming"
                finding_count = transition.finding_count
                latest_text = transition.latest_text
            else:
                assert isinstance(transition, _SummaryBatchCompleted)
                if batch_state == "complete":
                    raise RuntimeError(
                        f"Summary batch {index + 1} completed more than once"
                    )
                if batch_state != "writing":
                    raise RuntimeError(
                        f"Summary batch {index + 1} completed before it started"
                    )
                batch_states[index] = "complete"
                summaries[index] = transition.summary
                completed_tokens += plan.batches[index].returned_approximate_token_count
                findings = transition.summary.findings
                status, finding_count = "complete", len(findings)
                latest_text = ""
                if findings:
                    latest_text = findings[0].text[:_SUMMARY_PREVIEW_TAIL_CHARACTERS]
            complete_count = batch_states.count("complete")
            writing_count = batch_states.count("writing")
            queued_count = batch_states.count("queued")
            assert complete_count + writing_count + queued_count == batch_count
            return {
                "type": "bulk_progress",
                "operation": "summary",
                "committing": False,
                "label": (
                    f"Summarizing {batch_count} batches · {complete_count} complete · "
                    f"{writing_count} writing · {queued_count} queued"
                ),
                "completed_tokens": completed_tokens,
                "total_tokens": plan.approximate_token_count,
                "summary_batch_preview": {
                    "batch_number": index + 1,
                    "batch_count": batch_count,
                    "status": status,
                    "finding_count": finding_count,
                    "latest_text": latest_text,
                    "output_tokens": batch_output_tokens[index],
                },
            }

        def stream_reporter(index: int) -> Callable[[StructuredInferenceProgress], None]:
            last_reported_at = -math.inf

            def report(progress: StructuredInferenceProgress) -> None:
                nonlocal last_reported_at
                if progress.phase != "output_progress":
                    return
                reported_at = time.monotonic()
                if reported_at - last_reported_at < _SUMMARY_STREAM_INTERVAL_SECONDS:
                    return
                last_reported_at = reported_at
                finding_count, latest_text = summarize_partial_findings(
                    partial_output=progress.partial_output,
                    tail_characters=_SUMMARY_PREVIEW_TAIL_CHARACTERS,
                )
                transitions.put_nowait(_SummaryBatchStreaming(
                    batch_index=index,
                    finding_count=finding_count,
                    latest_text=latest_text,
                    output_tokens=progress.output_tokens_received,
                ))

            return report

        async def summarize_batch(index: int) -> None:
            transitions.put_nowait(_SummaryBatchStarted(batch_index=index))
            summary = await self._infer_staged_summary_batch(
                run=run,
                canonical_messages=canonical_messages,
                summary_request=summary_request,
                state=state,
                skill=skill,
                evidence_payload=plan.batches[index],
                batch_index=index,
                batch_count=batch_count,
                on_stream=stream_reporter(index),
            )
            transitions.put_nowait(
                _SummaryBatchCompleted(batch_index=index, summary=summary)
            )

        async def drain(
            indexes: tuple[int, ...],
            worker_count: int,
        ) -> AsyncIterator[dict[str, object]]:
            assert indexes and 1 <= worker_count <= _STAGED_SUMMARY_CONCURRENCY
            pending_indexes = deque(indexes)

            async def summarize_pending_batches() -> None:
                while pending_indexes:
                    await summarize_batch(pending_indexes.popleft())

            workers = [
                asyncio.create_task(summarize_pending_batches())
                for _ in range(min(worker_count, len(indexes)))
            ]
            running_workers = set(workers)
            first_failure: BaseException | None = None
            try:
                while running_workers or not transitions.empty():
                    next_transition = asyncio.create_task(transitions.get())
                    try:
                        done, _pending = await asyncio.wait(
                            {next_transition, *running_workers},
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                    finally:
                        if not next_transition.done():
                            next_transition.cancel()
                    for worker in done - {next_transition}:
                        running_workers.remove(worker)
                        failure = worker.exception()
                        if failure is not None and first_failure is None:
                            # Batches not started yet do not start; running ones finish and are kept.
                            first_failure = failure
                            pending_indexes.clear()
                    if next_transition in done:
                        yield apply_transition(next_transition.result())
                if first_failure is not None:
                    raise first_failure
            finally:
                for worker in workers:
                    if not worker.done():
                        worker.cancel()
                await asyncio.gather(*workers, return_exceptions=True)

        to_run = tuple(index for index in range(batch_count) if batch_states[index] == "queued")
        if to_run:
            # The first batch runs alone so later requests can reuse the provider-side prompt cache.
            async with aclosing(drain(to_run[:1], 1)) as first_batch_events:
                async for event in first_batch_events:
                    yield event
        if len(to_run) > 1:
            async with aclosing(drain(
                to_run[1:],
                _STAGED_SUMMARY_CONCURRENCY,
            )) as later_batch_events:
                async for event in later_batch_events:
                    yield event
        if batch_states != ["complete"] * batch_count:
            raise RuntimeError("Staged summary workers stopped before every batch completed")

    async def _infer_staged_summary_batch(
        self,
        *,
        run: _RunContext,
        canonical_messages: list[dict[str, str]],
        summary_request: str,
        state: InvestigationState,
        skill: AgentSkill,
        evidence_payload: InvestigationEvidencePayload,
        batch_index: int,
        batch_count: int,
        on_stream: Callable[[StructuredInferenceProgress], None],
    ) -> SummaryBatchResult:
        messages = self._context_builder.build_staged_summary_batch_messages(
            canonical_messages=canonical_messages,
            summary_request=summary_request,
            prompts=run.prompts,
            skill=skill,
            snapshot=state.snapshot,
            evidence_payload=evidence_payload,
            batch_index=batch_index,
            batch_count=batch_count,
        )
        return await self._infer_cited_summary_findings(
            run=run,
            messages=messages,
            expected_root_ids=evidence_payload.result_tree_ids,
            allowed_note_ids=frozenset((
                *evidence_payload.evidence_note_ids,
                *state.snapshot.selected_note.reference_note_ids,
            )),
            structural_note_ids=structural_placeholder_note_ids(
                evidence_payload.result_trees
            ),
            stage_label=f"Summary batch {batch_index + 1}",
            on_stream=on_stream,
        )

    async def _infer_cited_summary_findings(
        self,
        *,
        run: _RunContext,
        messages: list[dict[str, str]],
        expected_root_ids: tuple[str, ...],
        allowed_note_ids: frozenset[str],
        structural_note_ids: frozenset[str],
        stage_label: str,
        on_stream: Callable[[StructuredInferenceProgress], None],
    ) -> SummaryBatchResult:
        """Request summary findings, asking once for a correction of uncitable IDs."""

        def on_progress(progress: StructuredInferenceProgress) -> None:
            self._record_inference_progress(
                run=run,
                progress=progress,
                purpose=InferencePurpose.SUMMARY_BATCH,
            )
            on_stream(progress)

        attempt_messages = messages
        for correction_round in range(_SUMMARY_CITATION_CORRECTIONS + 1):
            response = await self._request_structured_inference(
                run=run,
                model=self._model_policy.for_stage(
                    purpose=InferencePurpose.SUMMARY_BATCH,
                    selected_model=run.selected_model,
                ),
                messages=attempt_messages,
                response_model=SummaryFindingsResult,
                purpose=InferencePurpose.SUMMARY_BATCH,
                on_progress=on_progress,
            )
            findings = SummaryFindingsResult.model_validate_json(response.content)
            rejected_note_ids = classify_uncitable_note_ids(
                result=findings,
                allowed_note_ids=allowed_note_ids,
                structural_note_ids=structural_note_ids,
                request_text=json.dumps(attempt_messages),
            )
            if not rejected_note_ids:
                result = attach_summary_coverage(
                    result=findings,
                    expected_root_ids=expected_root_ids,
                    allowed_note_ids=allowed_note_ids,
                )
                self._record_structured_attempts(
                    run=run,
                    attempts=response.attempts,
                    parsed=result.model_dump(mode="json"),
                    purpose=InferencePurpose.SUMMARY_BATCH,
                )
                return result
            self._record_structured_attempts(
                run=run,
                attempts=response.attempts,
                parsed=findings.model_dump(mode="json"),
                purpose=InferencePurpose.SUMMARY_BATCH,
            )
            rejected_detail = "; ".join(
                f"{note_id} ({reason})" for note_id, reason in rejected_note_ids
            )
            self._trace_store.append_event(
                session_key=run.session_key,
                run_id=run.run_id,
                event_type="SUMMARY_CITATION_REJECTED",
                label=f"{stage_label} cited uncitable note IDs",
                detail={
                    "correction_round": correction_round,
                    "rejected_note_ids": [
                        {"note_id": note_id, "reason": reason}
                        for note_id, reason in rejected_note_ids
                    ],
                },
                duration_ms=0.0,
            )
            if correction_round == _SUMMARY_CITATION_CORRECTIONS:
                raise AgentExecutionError(
                    f"{stage_label} returned invalid findings: cited note IDs that "
                    "were not disclosed as evidence, even after a correction "
                    f"request: {rejected_detail}"
                )
            attempt_messages = (
                self._context_builder.build_staged_summary_citation_correction_messages(
                    messages=messages,
                    rejected_response=response.content,
                    rejected_note_ids=rejected_note_ids,
                )
            )
        raise RuntimeError("Summary citation correction loop exited without a result")

    async def _reduce_staged_summaries(
        self,
        *,
        run: _RunContext,
        canonical_messages: list[dict[str, str]],
        summary_request: str,
        state: InvestigationState,
        skill: AgentSkill,
        summaries: tuple[SummaryBatchResult, ...],
    ) -> tuple[SummaryBatchResult, ...]:
        token_limit = run.retrieval_settings.max_page_approximate_tokens
        if state.snapshot.selected_note.status == "available":
            token_limit -= estimate_input_tokens(
                state.snapshot.selected_note.as_payload()
            )
        if token_limit < 1:
            raise AgentExecutionError(
                "Selected-note context leaves no room for summary reduction"
            )
        current = summaries
        for stage_index in range(1, _MAX_STAGED_SUMMARY_REDUCTION_LEVELS + 1):
            current_tokens = estimate_summary_results_tokens(current)
            if current_tokens <= token_limit:
                return current
            # lint: allow-PY001 rationale="translate a user-configured reduction budget overflow into a concise operation failure"
            try:
                groups = partition_summary_results(
                    results=current,
                    token_limit=token_limit,
                )
            # lint: allow-PY001 rationale="an external intermediate summary can legitimately exceed the configured reduction limit"
            except ValueError as exc:
                raise AgentExecutionError(
                    "The intermediate summaries cannot fit within the configured "
                    f"evidence limit: {exc}"
                ) from exc

            reduced: list[SummaryBatchResult | None] = [None] * len(groups)
            reduced[0] = await self._infer_summary_reduction_group(
                run=run,
                canonical_messages=canonical_messages,
                summary_request=summary_request,
                state=state,
                skill=skill,
                summaries=groups[0],
                stage_index=stage_index,
                group_index=0,
                group_count=len(groups),
            )
            semaphore = asyncio.Semaphore(_STAGED_SUMMARY_CONCURRENCY)

            async def reduce_group(index: int) -> tuple[int, SummaryBatchResult]:
                async with semaphore:
                    result = await self._infer_summary_reduction_group(
                        run=run,
                        canonical_messages=canonical_messages,
                        summary_request=summary_request,
                        state=state,
                        skill=skill,
                        summaries=groups[index],
                        stage_index=stage_index,
                        group_index=index,
                        group_count=len(groups),
                    )
                return index, result

            tasks = [
                asyncio.create_task(reduce_group(index))
                for index in range(1, len(groups))
            ]
            try:
                for completed_task in asyncio.as_completed(tasks):
                    index, result = await completed_task
                    if reduced[index] is not None:
                        raise RuntimeError(
                            "Summary reduction group completed more than once"
                        )
                    reduced[index] = result
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            if any(result is None for result in reduced):
                raise RuntimeError("Summary reduction completed with missing groups")
            next_level = tuple(result for result in reduced if result is not None)
            if estimate_summary_results_tokens(next_level) >= current_tokens:
                raise AgentExecutionError(
                    "The model did not reduce the intermediate summary size; "
                    "the complete-scope summary was not generated"
                )
            current = next_level
        raise AgentExecutionError(
            "The complete-scope summary exceeded the maximum reduction depth"
        )

    async def _infer_summary_reduction_group(
        self,
        *,
        run: _RunContext,
        canonical_messages: list[dict[str, str]],
        summary_request: str,
        state: InvestigationState,
        skill: AgentSkill,
        summaries: tuple[SummaryBatchResult, ...],
        stage_index: int,
        group_index: int,
        group_count: int,
    ) -> SummaryBatchResult:
        expected_root_ids = tuple(
            root_id
            for summary in summaries
            for root_id in summary.covered_root_ids
        )
        allowed_note_ids = frozenset((
            *summary_reference_note_ids(summaries),
            *state.snapshot.selected_note.reference_note_ids,
        ))
        messages = self._context_builder.build_staged_summary_reduction_messages(
            canonical_messages=canonical_messages,
            summary_request=summary_request,
            prompts=run.prompts,
            skill=skill,
            snapshot=state.snapshot,
            summaries=summaries,
            stage_index=stage_index,
            group_index=group_index,
            group_count=group_count,
        )
        return await self._infer_cited_summary_findings(
            run=run,
            messages=messages,
            expected_root_ids=expected_root_ids,
            allowed_note_ids=allowed_note_ids,
            structural_note_ids=frozenset(),
            stage_label=f"Summary reduction stage {stage_index}",
            on_stream=lambda progress: None,
        )

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
        web_settings: AgentWebSettings,
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
            web_settings=web_settings,
        )
        return run, messages

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
            return await send_structured(
                self._inference,
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
            # Explain the failure in the chat itself (and the saved turn), so
            # it can be understood later without the Agent Debug trace.
            raise AgentExecutionError(explain_structured_failure(
                response_model=response_model,
                attempts=exc.attempts,
                setup=FailureSetup(model=model, thinking_level=run.thinking_level, web_mode=run.web_settings.mode),
            )) from exc

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

    async def _stream_prebuilt_final_response(
        self,
        *,
        run: _RunContext,
        final_messages: list[dict[str, str]],
        reference_note_ids: tuple[str, ...],
        reference_web_evidence: tuple[WebPageEvidence, ...],
    ) -> AsyncIterator[dict[str, object]]:
        if not isinstance(reference_note_ids, tuple):
            raise TypeError("reference_note_ids must be a tuple")
        if not isinstance(reference_web_evidence, tuple):
            raise TypeError("reference_web_evidence must be a tuple")
        reference_web_ids = tuple(
            reference.evidence_id
            for reference in citation_references_for_pages(reference_web_evidence)
        )
        if len(set(reference_web_ids)) != len(reference_web_ids):
            raise ValueError("reference_web_evidence must be unique")
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
        for attempt in range(1, _FINAL_RESPONSE_MAX_ATTEMPTS + 1):
            state = _FinalStreamState(thinking="", content="", usage={}, did_finish=False)
            # Shown as "Waiting for OpenAI" until the provider's first signal.
            yield self._status_event("provider_wait", "started", f"Waiting for {self._provider_label}",
                                     approx_input_tokens=final_input_tokens)
            is_waiting_for_provider = True
            # lint: allow-PY001 rationale="retry a failed external model stream only before output"
            try:
                async for event in send_text_stream(  # shockharness: ignore[EXC003] reason="each pull from the provider's stream is the external operation; the body forwards the event"
                    self._inference,
                    base_url=run.base_url,
                    model=model,
                    thinking_level=run.thinking_level,
                    messages=final_messages,
                    max_output_tokens=_final_response_max_output_tokens(
                        provider_label=self._provider_label
                    ),
                    on_request=self._final_response_request_recorder(run=run, attempt=attempt),
                ):
                    if is_waiting_for_provider:
                        is_waiting_for_provider = False
                        yield self._status_event("provider_wait", "completed", f"{self._provider_label} responded",
                                                 approx_input_tokens=final_input_tokens)
                    if event["type"] == "provider_started":
                        continue
                    should_yield = self._consume_final_event(event=event, state=state)
                    output_tokens_received = estimate_text_tokens(
                        f"{state.thinking}{state.content}"
                    )
                    if output_tokens_received >= last_reported_output_tokens + _OUTPUT_PROGRESS_REPORT_TOKENS:
                        last_reported_output_tokens = output_tokens_received
                        yield self._output_status_event(
                            "respond",
                            "started",
                            "Writing response",
                            approx_input_tokens=final_input_tokens,
                            output_tokens_received=output_tokens_received,
                            duration_ms=(time.perf_counter() - started_at) * MS_PER_SECOND,
                        )
                    if should_yield:
                        if event["type"] == "content_delta":
                            yield {
                                **event,
                                "reference_note_ids": list(reference_note_ids),
                                "reference_web_ids": list(reference_web_ids),
                            }
                        else:
                            yield event
            # lint: allow-PY001 rationale="retry one external model-provider failure only before output"
            except InferenceProviderError:
                has_partial_output = any(
                    (state.thinking != "", state.content != "")
                )
                if has_partial_output or attempt == _FINAL_RESPONSE_MAX_ATTEMPTS:
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
                continue
            break
        self._validate_final_stream(state)
        duration_ms = (time.perf_counter() - started_at) * MS_PER_SECOND
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
            "reference_web_ids": list(reference_web_ids),
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

    def _final_response_request_recorder(self, *, run: _RunContext, attempt: int) -> Callable[[dict[str, object]], None]:
        def record(wire_request: dict[str, object]) -> None:
            self._record_wire_request(
                run=run,
                purpose=InferencePurpose.FINAL_RESPONSE,
                attempt=attempt,
                max_attempts=_FINAL_RESPONSE_MAX_ATTEMPTS,
                wire_request=wire_request,
            )
        return record

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
            event_type="PROVIDER_REQUEST",
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
            operation_label = f"{provider_label} writing a structured reply"
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
            operation_label = f"{provider_label} writing a structured reply"
            return AgentRuntime._output_status_event(
                "model_request",
                "started",
                f"{operation_label}{attempt_suffix}",
                approx_input_tokens=approx_input_tokens,
                output_tokens_received=progress.output_tokens_received,
                duration_ms=progress.duration_ms,
            )
        if progress.phase == "response_received":
            response_label = f"{provider_label} returned a structured reply"
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
            output_label = "Structured reply validated"
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
