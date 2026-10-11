"""Run agent-stage cases through the real production agent loop.

Each trial runs `AgentRuntime.stream_agent` with the real OpenAI adapter and the
current production instructions, skills and tool schemas, against the case's
fixtures: a frozen view built from fixture notes, a fixture web that serves only
recorded pages, a tagging stand-in that records operations and never writes, and
automatic menu acknowledgments. The simulated user answers questions as the case
says. A trial is correct when the required calls happened, no forbidden tool was
called, tools followed the default order, the confirmation expectation held, and
the judge passed every answer criterion.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from types import MappingProxyType

from app.services.agent import agent_loop as agent_loop_module
from app.services.agent import runtime as runtime_module
from app.services.agent import web_actions as web_actions_module
from app.services.agent.agent_tools import agent_loop_tools
from app.services.agent.context import AgentContextBuilder
from app.services.agent.execution_errors import AgentExecutionError
from app.services.agent.history import record_history
from app.services.agent.inference import InferenceProviderError
from app.services.agent.menu_actions import MenuResult, menu_action_store
from app.services.agent.model_policy import SingleModelPolicy
from app.services.agent.note_aliases import NoteAliases
from app.services.agent.openai_inference import OPENAI_API_BASE_URL
from app.services.agent.prompt_settings import DEFAULT_AGENT_PROMPTS
from app.services.agent.prompts import AGENT_LOOP_INSTRUCTIONS
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.retrieval_settings import DEFAULT_OPENAI_MAX_PAGE_APPROXIMATE_TOKENS
from app.services.agent.runtime import AgentRuntime
from app.services.agent.scope import AgentScopeDescriptor, FrozenScopedNote, FrozenScopedTreeNode
from app.services.agent.scope import NoteText
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.scope import TextExtractionMeter
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.agent.trace import AgentTraceStore
from app.services.agent.web_evidence import web_evidence_store
from app.services.agent.web_fetch import WebPageFetchResult
from app.services.agent.web_settings import AgentWebSettings
from app.services.bulk_operation import BulkOperationGuard
from app.services.public_http import normalize_public_http_url
from app.services.search_index import extract_ordered_tags_for_search
from evals.agent_models import TOOL_ORDER_RANK, AgentCase, RequiredCall
from evals.models import OutputExpectation
from evals.production import selected_note_context
from evals.runner import evaluate_output, fingerprint


_FIXTURE_TIME = "2026-01-01T00:00:00+00:00"
_TRIAL_PAGES: contextvars.ContextVar[dict[str, object]] = contextvars.ContextVar("eval_trial_pages")
_TRIAL_GUARD: contextvars.ContextVar[BulkOperationGuard] = contextvars.ContextVar("eval_trial_guard")
_TRIAL_SESSION: contextvars.ContextVar[str] = contextvars.ContextVar("eval_trial_session")
# The positive and negative answer for each kind of question the app can ask.
_ANSWERS = {
    "change_confirmation": {"yes": "yes", "no": "no"},
    "summary_confirmation": {"yes": "summarize_all", "no": "cancel"},
    "tag_scope_confirmation": {"yes": "focus_existing", "no": "cancel"},
}


def production_fingerprint() -> str:
    """Everything production feeds the agent; a change here reruns every agent case."""
    tools = agent_loop_tools(web_settings=AgentWebSettings(mode="full"))
    return fingerprint({
        "instructions": AGENT_LOOP_INSTRUCTIONS,
        "system_prompt": DEFAULT_AGENT_PROMPTS.system_prompt,
        "final_response_prompt": DEFAULT_AGENT_PROMPTS.final_response_prompt,
        "skills": [[skill.skill_id, skill.content] for skill in DEFAULT_AGENT_SKILLS.skills],
        "tools": [[tool.name, tool.description, tool.arguments_schema()] for tool in tools],
    })


def build_snapshot(case: AgentCase, *, session_key: str) -> ScopedSearchSnapshot:
    view = case.view
    children: dict[str, list[str]] = {note.note_id: [] for note in view.notes}
    roots = []
    for note in view.notes:
        if note.parent_id:
            children[note.parent_id].append(note.note_id)
        else:
            roots.append(note.note_id)
    by_id = {note.note_id: note for note in view.notes}
    root_of: dict[str, str] = {}
    ordered: list[str] = []

    def visit(note_id: str, root_id: str) -> None:
        root_of[note_id] = root_id
        ordered.append(note_id)
        for child_id in children[note_id]:
            visit(child_id, root_id)

    for root_id in roots:
        visit(root_id, root_id)
    notes = {
        note_id: FrozenScopedNote(
            note_id=note_id, parent_id=by_id[note_id].parent_id, root_note_id=root_of[note_id],
            note_text=NoteText.from_text(by_id[note_id].content_text), explicit_tags_text=by_id[note_id].tags,
            explicit_tag_terms=extract_ordered_tags_for_search(by_id[note_id].tags),
            proposed_tags_text=by_id[note_id].proposed_tags,
            proposed_tag_terms=extract_ordered_tags_for_search(by_id[note_id].proposed_tags),
            created_at=_FIXTURE_TIME, updated_at=_FIXTURE_TIME,
            order_index=index,
        )
        for index, note_id in enumerate(ordered)
    }
    nodes = {
        note_id: FrozenScopedTreeNode(note_id=note_id, parent_id=by_id[note_id].parent_id,
                                      root_note_id=root_of[note_id], child_ids=tuple(children[note_id]))
        for note_id in ordered
    }
    descriptor = AgentScopeDescriptor(scope_kind=view.scope_kind, active_tab_id="eval-tab", scope_tab_id="eval-tab",
        search_query=view.search_query, sort_mode=view.sort_mode, reference_root_ids=[], label=view.label)
    return ScopedSearchSnapshot(run_id=f"eval-{session_key}", session_key=session_key, descriptor=descriptor,
        created_at=_FIXTURE_TIME, ordered_root_ids=tuple(roots), ordered_note_ids=tuple(ordered),
        notes_by_id=MappingProxyType(notes), tree_nodes_by_id=MappingProxyType(nodes),
        selected_note=selected_note_context(case.selected_note),
        preparation_ms=0.0, text_extraction=TextExtractionMeter.start(),)


def _page_result(url: str) -> WebPageFetchResult:
    pages = _TRIAL_PAGES.get()
    if url not in pages:
        return WebPageFetchResult(requested_url=url, final_url=url, status="failed", title="", content_text="",
            outgoing_links=(), fetched_at=_FIXTURE_TIME, truncated=False, error_kind="not_recorded")
    page = pages[url]
    return WebPageFetchResult(requested_url=url, final_url=url, status="ok", title=page.title,
        content_text=page.content_text,
        outgoing_links=tuple((link.title, normalize_public_http_url(link.url)) for link in page.links),
        fetched_at=_FIXTURE_TIME, truncated=False, error_kind="")


async def _fixture_fetch_web_pages(urls, *, allows_target):
    """The fixture web: recorded pages only, and the same per-address permission check."""
    results = []
    for url in urls:
        if not allows_target(url):
            results.append(WebPageFetchResult(requested_url=url, final_url=url, status="blocked", title="",
                content_text="", outgoing_links=(), fetched_at=_FIXTURE_TIME, truncated=False,
                error_kind="not_available_in_permitted_context"))
        else:
            results.append(_page_result(url))
    return tuple(results)


class _TrialGuard:
    """Gives each trial its own question guard, so concurrent trials never collide."""

    def acquire(self, session_key):
        return _TRIAL_GUARD.get().acquire(session_key)

    def question(self, choices):
        return _TRIAL_GUARD.get().question(choices)

    def ask(self, session_key, choices):
        return _TRIAL_GUARD.get().ask(session_key, choices)

    def answer(self, session_key, question_id, value):
        return _TRIAL_GUARD.get().answer(session_key, question_id, value)


class _RecordingTagging:
    """Stands in for tag operations: asks like the real one, records, never writes."""

    def __init__(self) -> None:
        self.operations: list[dict[str, object]] = []

    async def stream_generation(self, *, inference, run):
        del inference, run
        async for event in self._operation({"operation": "generate"}, "tag_scope_confirmation"):
            yield event

    async def stream_review(self, *, action, scope, tag_filter):
        details = {"operation": "review", "action": action, "scope": scope, "tag_filter": tag_filter}
        async for event in self._operation(details, "change_confirmation"):
            yield event

    async def _operation(self, details, kind):
        self.operations.append(details)
        guard = _TRIAL_GUARD.get()
        with guard.acquire(_TRIAL_SESSION.get()):
            choices = tuple(_ANSWERS[kind].values())
            question_id, answer = guard.question(choices)
            question = {"type": "bulk_question", "question_id": question_id, "kind": kind,
                        "label": "Fixture tag operation", "items": []}
            if kind == "tag_scope_confirmation":
                question |= {"root_count": 1, "batch_count": 1, "prefix_root_count": 0,
                             "chooses_focus": True, "focus": "existing"}
            yield question
            choice = await answer
        details["answer"] = choice
        message = "Fixture tag operation cancelled; nothing changed."
        if choice != "cancel" and choice != "no":
            message = "Fixture tag operation applied."
        yield {"type": "bulk_complete", "changed": False}
        yield {"type": "content_delta", "text": message, "reference_note_ids": [], "reference_web_ids": []}
        yield {"type": "done", "reference_note_ids": [], "reference_web_ids": []}



@contextmanager
def fixture_environment():
    """Install the fixture web and per-trial guards for the duration of a run."""
    saved = (web_actions_module.fetch_web_pages, agent_loop_module.bulk_operation_guard,
             runtime_module.bulk_operation_guard)
    web_actions_module.fetch_web_pages = _fixture_fetch_web_pages
    agent_loop_module.bulk_operation_guard = _TrialGuard()
    runtime_module.bulk_operation_guard = _TrialGuard()
    try:
        yield
    finally:
        (web_actions_module.fetch_web_pages, agent_loop_module.bulk_operation_guard,
         runtime_module.bulk_operation_guard) = saved


def tool_calls_from_trace(traces: AgentTraceStore, session_key: str,
                          note_aliases: NoteAliases) -> list[dict[str, object]]:
    """Tool calls with the model's short note aliases translated back to the fixture's note ids."""
    run = traces.snapshot(session_key=session_key)["run"]
    calls = []
    for event in run["events"]:
        if event["type"] != "TOOL_CALL":
            continue
        result = event["detail"]["result"]
        # Operations record a plain marker; every other result is JSON.
        if result.startswith("{"):
            result = json.dumps(note_aliases.unaliased(json.loads(result)))
        arguments = json.loads(event["detail"]["arguments"])
        if event["detail"]["name"] == "read_view_notes":
            arguments = {**arguments, "note_ids": [note_aliases.note_id(value) for value in arguments["note_ids"]]}
        calls.append({"name": event["detail"]["name"], "arguments": arguments, "result": result})
    return calls


def _contains(expected, actual) -> bool:
    """Expected values must appear in the actual arguments; lists by subset."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(key in actual and _contains(value, actual[key])
                                                for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and all(
            any(_contains(item, candidate) for candidate in actual) for item in expected)
    if isinstance(expected, str) and isinstance(actual, str) and expected.startswith("http"):
        return normalize_public_http_url(expected) == normalize_public_http_url(actual)
    return type(expected) is type(actual) and expected == actual


def _satisfied(required: RequiredCall, calls: list[dict[str, object]]) -> bool:
    for call in calls:
        if call["name"] not in required.tools:
            continue
        if not required.arguments_any_of:
            return True
        if any(_contains(expected, call["arguments"]) for expected in required.arguments_any_of):
            return True
    return False


def order_violations(calls: list[dict[str, object]]) -> list[str]:
    """Calls that went back to an earlier group of the default order."""
    violations = []
    highest = 0
    for call in calls:
        if call["name"] not in TOOL_ORDER_RANK:
            continue
        rank = TOOL_ORDER_RANK[call["name"]]
        if rank < highest:
            violations.append(f"{call['name']} after a later tool group")
        highest = max(highest, rank)
    return violations


def fixture_evidence_ids(case: AgentCase, session_key: str) -> dict[str, str]:
    """Live evidence ids of this trial mapped to the case's fixed ids, by address."""
    pages = {normalize_public_http_url(page.url): page for page in case.web.pages}
    mapping = {}
    for evidence in web_evidence_store.evidence(session_key=session_key):
        page = pages[evidence.final_url]
        mapping[evidence.evidence_id] = page.evidence_id
        links = {normalize_public_http_url(link.url): link.evidence_id for link in page.links}
        for reference in evidence.outgoing_references:
            mapping[reference.evidence_id] = links[reference.final_url]
    return mapping


def check_trial(case: AgentCase, *, calls, questions) -> list[str]:
    """Deterministic expectation failures (empty when all hold)."""
    expectation = case.expectation
    failures = []
    for required in expectation.required_calls:
        if not _satisfied(required, calls):
            failures.append(f"missing required call: {required.model_dump()}")
    for call in calls:
        if call["name"] in expectation.forbidden_tools:
            failures.append(f"forbidden tool called: {call['name']} {call['arguments']}")
    for forbidden in expectation.forbidden_calls:
        if _satisfied(forbidden, calls):
            failures.append(f"forbidden call made: {forbidden.model_dump()}")
    failures.extend(order_violations(calls))
    if expectation.confirmation == "asked" and not questions:
        failures.append("expected a confirmation question")
    if expectation.confirmation == "not_asked" and questions:
        failures.append(f"unexpected confirmation question: {questions}")
    return failures


async def run_trial(case: AgentCase, *, adapter, judge, model: str, thinking_level: str) -> dict[str, object]:
    session_key = f"eval-{uuid.uuid4()}"
    session_token = _TRIAL_SESSION.set(session_key)
    guard_token = _TRIAL_GUARD.set(BulkOperationGuard())
    pages = {normalize_public_http_url(page.url): page for page in case.web.pages}
    pages_token = _TRIAL_PAGES.set(pages)
    traces = AgentTraceStore()
    tagging = _RecordingTagging()
    started = time.perf_counter()
    answer, questions, status, error, failures, judgment = "", [], "correct", "", [], {}
    answer_as_judged = ""
    try:
        for url in case.web.retained_urls:
            web_evidence_store.retain_success(session_key=session_key,
                                              result=_page_result(normalize_public_http_url(url)))
        snapshot = build_snapshot(case, session_key=session_key)
        runtime = AgentRuntime(context_builder=AgentContextBuilder(), inference=adapter,
            model_policy=SingleModelPolicy(), trace_store=traces, provider_label="OpenAI")
        run_id = "eval"
        with record_history(traces, session_key=session_key, run_id=run_id):
            # lint: allow-PY001 rationale="count provider and model-output failures as errors; internal errors propagate"
            try:
                async for event in runtime.stream_agent(earlier_actions=case.earlier_actions, 
                    session_key=session_key, base_url=OPENAI_API_BASE_URL, selected_model=model,
                    thinking_level=thinking_level,
                    canonical_messages=[message.model_dump() for message in case.conversation],
                    prompts=DEFAULT_AGENT_PROMPTS, skills=DEFAULT_AGENT_SKILLS,
                    retrieval_settings=AgentRetrievalSettings(
                        max_page_approximate_tokens=DEFAULT_OPENAI_MAX_PAGE_APPROXIMATE_TOKENS),
                    web_settings=AgentWebSettings(mode=case.web.mode),
                    frozen_scope=snapshot, tagging_run=tagging,
                ):
                    if event["type"] == "content_delta":
                        answer += event["text"]
                    elif event["type"] == "bulk_question":
                        questions.append({"kind": event["kind"], "label": event["label"]})
                        _TRIAL_GUARD.get().answer(session_key, event["question_id"],
                                                  _ANSWERS[event["kind"]][case.answer_questions])
                    elif event["type"] == "menu_open":
                        menu_action_store.acknowledge(session_key=session_key, result=MenuResult(
                            request_id=event["request_id"], status="opened", detail="Fixture browser"))
            # lint: allow-PY001 rationale="persist external provider and model-output errors as failed trials"
            except (InferenceProviderError, AgentExecutionError) as exc:
                status, error = "error", f"{type(exc).__name__}: {exc}"
        calls = tool_calls_from_trace(traces, session_key, NoteAliases.from_snapshot(snapshot))
        # The judge's criteria cite the fixture's fixed evidence ids: map the answer's full
        # tokens and the short tokens the model saw in tool results onto them.
        fixed_ids = fixture_evidence_ids(case, session_key)
        answer_as_judged = answer
        for live_id, fixed_id in fixed_ids.items():
            answer_as_judged = answer_as_judged.replace(f"[[web:{live_id}]]", f"[[web:{fixed_id}]]")
        short_numbers = web_evidence_store.evidence_ids_by_short_number(session_key=session_key)
        calls_as_judged = json.dumps(calls)
        for number in sorted(short_numbers, reverse=True):
            calls_as_judged = calls_as_judged.replace(f"[[web:{number}]]", f"[[web:{fixed_ids[short_numbers[number]]}]]")
        if status == "correct":
            failures = check_trial(case, calls=calls, questions=questions)
            if failures:
                status = "incorrect"
        # What earlier answers did, as the agent's own record shows it.
        judged_earlier_actions: list[dict[str, str]] = []
        if case.earlier_actions:
            judged_earlier_actions.append({"role": "earlier_actions", "content": json.dumps(case.earlier_actions)})
        if status == "correct" and case.expectation.answer_criteria:
            # lint: allow-PY001 rationale="judge provider errors count as trial errors, never as passes"
            try:
                verdict = await evaluate_output(adapter, expectation=OutputExpectation(
                    kind="output", criteria=case.expectation.answer_criteria,
                    reference_facts=case.expectation.reference_facts),
                    messages=[*[message.model_dump() for message in case.conversation],
                              *judged_earlier_actions,
                              {"role": "tool_calls", "content": calls_as_judged}],
                    output=answer_as_judged, judge=judge)
            # lint: allow-PY001 rationale="a failed judge call is an external error for this trial"
            except InferenceProviderError as exc:
                status, error = "error", f"Judge {type(exc).__name__}: {exc}"
            else:
                judgment = verdict["judgment"]
                if not verdict["correct"]:
                    status = "incorrect"
                    failures.append("judge: answer criteria not met")
    finally:
        web_evidence_store.clear_session(session_key=session_key)
        _TRIAL_PAGES.reset(pages_token)
        _TRIAL_GUARD.reset(guard_token)
        _TRIAL_SESSION.reset(session_token)
    return {"status": status, "error": error, "failures": failures, "tool_calls": calls,
            "questions": questions, "operations": tagging.operations, "answer": answer,
            "answer_as_judged": answer_as_judged, "judgment": judgment,
            "duration_ms": round((time.perf_counter() - started) * 1000, 3),
            "pairs": traces.export_history(session_key=session_key)}


async def run_agent_cases(cases, *, adapter, judge, repetitions: int, concurrency: int,
                          on_trial) -> list[dict[str, object]]:
    if type(repetitions) is not int or repetitions < 1:
        raise ValueError("Repetitions must be a positive integer")
    if type(concurrency) is not int or concurrency < 1:
        raise ValueError("Concurrency must be a positive integer")
    if judge is None and any(case.expectation.answer_criteria for case in cases):
        raise ValueError("Cases with answer criteria require --judge")
    slots = asyncio.Semaphore(concurrency)
    runs = [(case, case.model, case.thinking_level) for case in cases]
    effective = production_fingerprint()

    async def one(case, model, level, repetition):
        async with slots:
            outcome = await run_trial(case, adapter=adapter, judge=judge, model=model, thinking_level=level)
        outcome["repetition"] = repetition
        on_trial(case, model, level, outcome)
        return outcome

    with fixture_environment():
        results = await asyncio.gather(*[
            asyncio.gather(*[one(case, model, level, repetition) for repetition in range(1, repetitions + 1)])
            for case, model, level in runs
        ])
    reports = []
    for (case, model, level), outcomes in zip(runs, results):
        counts = {status: sum(item["status"] == status for item in outcomes)
                  for status in ("correct", "incorrect", "error")}
        assert sum(counts.values()) == repetitions
        reports.append({
            "schema_version": 3, "case_id": f"{case.id}@{model}/{level}", "base_case_id": case.id,
            "model": model, "thinking_level": level, "prompt_source": "current-production",
            "case_fingerprint": fingerprint({"case": case.model_dump(), "model": model, "thinking_level": level}),
            "effective_fingerprint": fingerprint({"case": case.model_dump(), "model": model,
                                                  "thinking_level": level, "production": effective}),
            "judge": judge.model_dump() if judge is not None else {},
            "repetitions": repetitions, "counts": counts,
            "percent_correct": 100 * counts["correct"] / repetitions, "outcomes": list(outcomes),
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        })
    return reports
