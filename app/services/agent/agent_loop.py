"""The tool-using agent loop (replaces up-front route selection).

Each model turn may call tools; their results are appended and the model is
asked again, until it answers without calling a tool. Interactive tools talk to
the browser: menus open and report back; whole-view summaries and tag changes
hand the rest of the turn to their existing operations, which ask the user to
confirm. In full web mode, addresses carrying text the user did not type are
shown in a Yes/No box first.

``AgentLoopMixin`` is mixed into ``AgentRuntime`` and uses its recording and
status helpers; it adds no state of its own.
"""

from __future__ import annotations

import dataclasses
import json
import time
from collections.abc import AsyncIterator
from contextlib import aclosing

from pydantic import BaseModel

from app.services.agent.agent_tools import OPERATION_TOOL_NAMES
from app.services.agent.agent_tools import OpenMenuArguments
from app.services.agent.agent_tools import OpenWebPagesArguments
from app.services.agent.agent_tools import ProposeTagGenerationArguments
from app.services.agent.agent_tools import ProposeTagReviewArguments
from app.services.agent.agent_tools import SummarizeViewArguments
from app.services.agent.agent_tools import ToolContext
from app.services.agent.agent_tools import ToolResult
from app.services.agent.agent_tools import agent_loop_tools
from app.services.agent.agent_tools import parse_tool_call
from app.services.agent.agent_tools import run_agent_tool
from app.services.agent.agent_tools import tool_error_result
from app.services.agent.agent_tools import tool_message_result
from app.services.agent.help_catalog import MENU_BY_ID
from app.services.agent.investigation import InvestigationState
from app.services.agent.menu_actions import menu_action_store
from app.services.agent.model_policy import InferencePurpose
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.scope import describe_text_extraction
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.agent.token_estimation import estimate_text_tokens
from app.services.agent.tool_calling import estimate_tool_conversation_tokens
from app.services.agent.web_actions import NoteTextGuard
from app.services.agent.web_capabilities import build_web_url_capabilities
from app.services.agent.web_capabilities import note_evidence_url_capabilities
from app.services.agent.web_evidence import WebPageEvidence
from app.services.agent.web_evidence import citation_references_for_pages
from app.services.agent.web_evidence import web_evidence_store
from app.services.bulk_operation import bulk_operation_guard
from app.services.agent.citation_tokens import ShortCitationTranslator
from app.services.agent.note_aliases import NoteAliases
from app.services.agent.execution_errors import AgentExecutionError
from app.services.agent.action_log import describe_action


MAX_AGENT_TURNS = 8
# A turn whose tool calls all fail is explained back once; a second such turn
# in a row makes the next turn the last.
MAX_FAILED_TOOL_TURNS = 2
AGENT_TURN_MAX_OUTPUT_TOKENS = 16_384
_ANSWER_NOW = (
    "AGENT_STEP_LIMIT: Do not call more tools. Answer now from the results you have, "
    "and say plainly what you could not find out or do."
)

_ANSWER_REQUIRED = (
    "AGENT_ANSWER_REQUIRED: You ended without writing anything. Write your answer to the "
    "user now, based on the tool results above."
)


class AgentLoopState:
    """What one run has shown the user and the model so far."""

    def __init__(self, *, capabilities, selected_note_text: str, session_key: str, note_aliases: NoteAliases) -> None:
        self.reference_note_ids: list[str] = []
        self.note_aliases = note_aliases
        self.web_tokens = ShortCitationTranslator(
            evidence_ids_by_number=lambda: web_evidence_store.evidence_ids_by_short_number(session_key=session_key),
            note_ids_by_alias=note_aliases.id_by_alias())
        self.web_evidence: list[WebPageEvidence] = []
        self.capabilities = capabilities
        self.content = ""
        # What this answer did, for later turns (action_log.py).
        self.actions: list[dict[str, object]] = []
        # Note text shown to the model, and full-mode addresses the user approved.
        self.note_text_parts: list[str] = [selected_note_text]
        self.approved_urls: set[str] = set()

    def add_tool_result(self, result: ToolResult) -> None:
        for note_id in result.note_ids:
            if note_id not in self.reference_note_ids:
                self.reference_note_ids.append(note_id)
        known_ids = {evidence.evidence_id for evidence in self.web_evidence}
        for evidence in result.web_evidence:
            if evidence.evidence_id not in known_ids:
                self.web_evidence.append(evidence)
                known_ids.add(evidence.evidence_id)
        for payload in result.note_evidence:
            self.capabilities = self.capabilities.including(note_evidence_url_capabilities(payload))
        if result.disclosed_note_text:
            self.note_text_parts.append(result.disclosed_note_text)

    def add_operation_references(self, *, note_ids: list[str], web_ids: list[str]) -> None:
        for note_id in note_ids:
            if note_id not in self.reference_note_ids:
                self.reference_note_ids.append(note_id)
        assert set(web_ids) <= set(self.reference_web_ids()), "Operations cite no new web pages"

    def reference_web_ids(self) -> list[str]:
        return [reference.evidence_id for reference in citation_references_for_pages(tuple(self.web_evidence))]

    def model_text_events(self, text: str) -> list[dict[str, object]]:
        """The model's streamed text with its short web tokens translated (held back while partial)."""
        translated = self.web_tokens.feed(text)
        if translated == "":
            return []
        return [self.content_event(translated)]

    def model_turn_end_events(self) -> list[dict[str, object]]:
        remaining = self.web_tokens.flush()
        if remaining == "":
            return []
        return [self.content_event(remaining)]

    def content_event(self, text: str) -> dict[str, object]:
        assert text != ""
        self.content += text
        return {"type": "content_delta", "text": text,
                "reference_note_ids": list(self.reference_note_ids),
                "reference_web_ids": self.reference_web_ids()}

    def record_action(self, *, call: dict[str, str], result_content: str, is_error: bool) -> None:
        self.actions.append(describe_action(name=call["name"], arguments=call["arguments"],
                                            result_content=result_content, is_error=is_error))

    def done_event(self) -> dict[str, object]:
        return {"type": "done", "reference_note_ids": list(self.reference_note_ids),
                "reference_web_ids": self.reference_web_ids(), "actions": list(self.actions)}


class AgentLoopMixin:
    async def _run_agent_loop(
        self, *, run, canonical_messages: list[dict[str, str]], frozen_scope: ScopedSearchSnapshot, tagging_run,
        earlier_actions: list[dict[str, object]],
    ) -> AsyncIterator[dict[str, object]]:
        if not isinstance(frozen_scope, ScopedSearchSnapshot):
            raise TypeError("frozen_scope must be ScopedSearchSnapshot")
        if frozen_scope.session_key != run.session_key:
            raise RuntimeError("Frozen scope belongs to another session")
        snapshot = frozen_scope
        if snapshot.selected_note.status == "available" and (
            estimate_input_tokens(snapshot.selected_note.as_payload())
            > run.retrieval_settings.max_page_approximate_tokens
        ):
            raise AgentExecutionError(
                "The note you are editing, with its whole tree, is larger than the evidence limit "
                "in AI Agent Settings, so it was not sent. Raise the limit or select a smaller note."
            )
        capabilities = build_web_url_capabilities(
            canonical_messages=canonical_messages, selected_note=snapshot.selected_note,
            investigation_evidence=None,
            retained_web_urls=web_evidence_store.retained_urls(session_key=run.session_key),
        )
        selected_note_text = "\n".join(
            f"{note.content_text} {note.tags}" for note in snapshot.selected_note.tree_notes
        )
        note_aliases = NoteAliases.from_snapshot(snapshot)
        state = AgentLoopState(capabilities=capabilities, selected_note_text=selected_note_text,
                               session_key=run.session_key, note_aliases=note_aliases)
        for note_id in snapshot.selected_note.reference_note_ids:
            state.reference_note_ids.append(note_id)
        messages = self._context_builder.build_agent_messages(
            canonical_messages=canonical_messages, skills=run.skills, web_settings=run.web_settings,
            snapshot=snapshot, available_urls=capabilities.normalized_urls, note_aliases=note_aliases,
            earlier_actions=earlier_actions,
        )
        self._trace_store.append_event(
            session_key=run.session_key, run_id=run.run_id, event_type="FROZEN_SCOPE",
            label="Frozen active MetaList scope",
            detail={"descriptor": snapshot.descriptor.model_dump(mode="json"),
                    "note_count": snapshot.note_count, "result_tree_count": snapshot.result_tree_count,
                    "ordered_note_ids": list(snapshot.ordered_note_ids),
                    "ordered_root_ids": list(snapshot.ordered_root_ids),
                    "selected_note": snapshot.selected_note.as_payload()},
            duration_ms=0.0,
        )
        yield self._status_event(
            "scope", "completed",
            f"Scope ready · {snapshot.descriptor.label} · {snapshot.note_count} notes in "
            f"{snapshot.result_tree_count} result trees · prepared in {snapshot.preparation_ms / 1_000:.1f} s",
            approx_input_tokens=estimate_tool_conversation_tokens(messages),
        )
        async for event in self._ensure_model_context(run=run, messages=messages):
            yield event
        tools = agent_loop_tools(web_settings=run.web_settings)
        typed_text = "\n".join(message["content"] for message in canonical_messages if message["role"] == "user")
        failed_turns = 0
        was_asked_to_answer = False
        for turn_index in range(MAX_AGENT_TURNS):
            is_last_turn = turn_index == MAX_AGENT_TURNS - 1
            if failed_turns >= MAX_FAILED_TOOL_TURNS:
                is_last_turn = True
            if is_last_turn:
                messages.append({"role": "system", "content": _ANSWER_NOW})
            turn = {"content": "", "calls": [], "done": {}}
            async with aclosing(self._stream_agent_turn(run=run, messages=messages, tools=tools,
                                                        state=state, turn=turn)) as turn_events:
                async for event in turn_events:
                    yield event
            assistant_message: dict[str, object] = {"role": "assistant", "content": turn["content"]}
            if turn["calls"]:
                assistant_message["tool_calls"] = turn["calls"]
            if "provider_state" in turn["done"]:
                assistant_message["provider_state"] = turn["done"]["provider_state"]
            messages.append(assistant_message)
            if not turn["calls"]:
                if state.content == "" and not was_asked_to_answer and not is_last_turn:
                    # A model sometimes ends silently after a tool (e.g. a menu opened);
                    # ask once for the answer before reporting a failure.
                    was_asked_to_answer = True
                    messages.append({"role": "system", "content": _ANSWER_REQUIRED})
                    continue
                if state.content == "":
                    raise AgentExecutionError(
                        "The AI model finished without writing an answer. Try sending the message "
                        "again; if it keeps happening, choose a different model or thinking level."
                    )
                self._trace_store.complete_run(session_key=run.session_key, run_id=run.run_id)
                yield state.done_event()
                return
            if is_last_turn:
                yield state.content_event(
                    self._separator(state) + "I stopped before finishing: the request needed more tool steps "
                    "than one answer allows. Try asking for one part at a time."
                )
                self._trace_store.complete_run(session_key=run.session_key, run_id=run.run_id)
                yield state.done_event()
                return
            answered_without_operation = False
            for operation in self._lone_operation_calls(turn["calls"]):
                parsed = parse_tool_call(name=operation["name"], arguments=operation["arguments"], tools=tools)
                if isinstance(parsed, SummarizeViewArguments) and snapshot.note_count == 0:
                    # Nothing to summarize: tell the model instead of asking the user to confirm.
                    result = tool_message_result({"summary": "not started",
                                                  "reason": "The current view has no notes to summarize."})
                    self._record_tool_call(run=run, call=operation, result_text=result.content)
                    state.record_action(call=operation, result_content=result.content, is_error=False)
                    messages.append({"role": "tool", "tool_call_id": operation["id"], "name": operation["name"],
                                     "content": result.content})
                    answered_without_operation = True
                elif not isinstance(parsed, ToolResult):
                    self._record_tool_call(run=run, call=operation, result_text="(operation started)")
                    state.record_action(call=operation, result_content="{}", is_error=False)
                    async with aclosing(self._stream_agent_operation(
                        run=run, canonical_messages=canonical_messages, snapshot=snapshot,
                        tagging_run=tagging_run, arguments=parsed, state=state,
                    )) as operation_events:
                        async for event in operation_events:
                            # The operation ends the answer: its completion carries the log.
                            if event["type"] == "done":
                                event = {**event, "actions": list(state.actions)}
                            yield event
                    return
            if answered_without_operation:
                continue
            results: list[ToolResult] = []
            for call in turn["calls"]:
                result_holder: list[ToolResult] = []
                async with aclosing(self._run_agent_tool_call(
                    run=run, call=call, tools=tools, snapshot=snapshot, state=state,
                    typed_text=typed_text, has_other_calls=len(turn["calls"]) > 1, result_holder=result_holder,
                    messages=messages,
                )) as call_events:
                    async for event in call_events:
                        yield event
                assert len(result_holder) == 1
                result = result_holder[0]
                results.append(result)
                state.add_tool_result(result)
                state.record_action(call=call, result_content=result.content, is_error=result.is_error)
                self._record_tool_call(run=run, call=call, result_text=result.content)
                messages.append({"role": "tool", "tool_call_id": call["id"], "name": call["name"],
                                 "content": result.content})
            if all(result.is_error for result in results):
                failed_turns += 1
            else:
                failed_turns = 0
        raise AssertionError("The agent loop always ends on its last turn")

    @staticmethod
    def _separator(state: AgentLoopState) -> str:
        if state.content == "":
            return ""
        return "\n\n"

    @staticmethod
    def _lone_operation_calls(calls: list[dict[str, str]]) -> tuple[dict[str, str], ...]:
        """The turn's operation call when it is the only call; mixed calls get errors instead."""
        if len(calls) == 1 and calls[0]["name"] in OPERATION_TOOL_NAMES:
            return (calls[0],)
        return ()

    async def _stream_agent_turn(self, *, run, messages, tools, state: AgentLoopState, turn: dict[str, object]):
        input_tokens = estimate_tool_conversation_tokens(messages)
        yield self._status_event("agent_turn", "started", "Thinking", approx_input_tokens=input_tokens)
        # Shown as "Waiting for OpenAI" until the provider's first signal.
        yield self._status_event("provider_wait", "started", f"Waiting for {self._provider_label}",
                                 approx_input_tokens=input_tokens)
        is_waiting_for_provider = True
        started_at = time.perf_counter()
        is_first_delta = True
        async for event in self._inference.stream_tool_turn(
            base_url=run.base_url, model=run.selected_model, thinking_level=run.thinking_level,
            messages=messages, tools=tools, max_output_tokens=AGENT_TURN_MAX_OUTPUT_TOKENS,
            on_request=lambda wire_request: self._record_wire_request(
                run=run, purpose=InferencePurpose.AGENT_TURN, attempt=1, max_attempts=1,
                wire_request=wire_request),
        ):
            if is_waiting_for_provider:
                is_waiting_for_provider = False
                yield self._status_event("provider_wait", "completed", f"{self._provider_label} responded",
                                         approx_input_tokens=input_tokens)
            if event["type"] == "provider_started":
                continue
            if event["type"] == "content_delta":
                text = event["text"]
                if is_first_delta:
                    text = self._separator(state) + text
                    is_first_delta = False
                turn["content"] += event["text"]
                for content_event in state.model_text_events(text):
                    yield content_event
            elif event["type"] == "tool_call":
                turn["calls"].append({"id": event["id"], "name": event["name"], "arguments": event["arguments"]})
            elif event["type"] == "done":
                turn["done"] = event
            else:
                raise RuntimeError(f"Unknown tool turn event: {event['type']}")
        if turn["done"] == {}:
            raise RuntimeError("Tool turn ended without a done event")
        for content_event in state.model_turn_end_events():
            yield content_event
        self._trace_store.append_event(
            session_key=run.session_key, run_id=run.run_id, event_type="MODEL_RESPONSE",
            label="Model response: agent-turn",
            detail={"raw_response": turn["content"], "tool_calls": list(turn["calls"]),
                    "usage": turn["done"]["usage"], "finish_reason": turn["done"]["finish_reason"]},
            duration_ms=(time.perf_counter() - started_at) * 1_000,
        )
        yield self._output_status_event(
            "agent_turn", "completed", self._turn_completed_label(turn["calls"]),
            approx_input_tokens=input_tokens,
            output_tokens_received=estimate_text_tokens(turn["content"] + "".join(
                call["arguments"] for call in turn["calls"])),
            duration_ms=(time.perf_counter() - started_at) * 1_000,
        )

    @staticmethod
    def _turn_completed_label(calls: list[dict[str, str]]) -> str:
        if not calls:
            return "Answer written"
        return "Using " + ", ".join(call["name"].replace("_", " ") for call in calls)

    async def _run_agent_tool_call(
        self, *, run, call, tools, snapshot, state: AgentLoopState, typed_text: str,
        has_other_calls: bool, result_holder: list[ToolResult], messages,
    ):
        input_tokens = estimate_tool_conversation_tokens(messages)
        if call["name"] in OPERATION_TOOL_NAMES and has_other_calls:
            result_holder.append(tool_error_result(
                f"{call['name']} must be called alone, after the results it needs; it was not run."))
            return
        parsed = parse_tool_call(name=call["name"], arguments=call["arguments"], tools=tools)
        if isinstance(parsed, ToolResult):
            # The name may be one the model made up, so it is not used as the activity name.
            yield self._status_event("tool_call_rejected", "completed", "Asked the AI to correct a tool call",
                                     approx_input_tokens=input_tokens)
            result_holder.append(parsed)
            return
        if isinstance(parsed, OpenMenuArguments):
            async for event in self._open_agent_menu(run=run, menu_id=parsed.menu_id, snapshot=snapshot,
                                                     result_holder=result_holder, input_tokens=input_tokens):
                yield event
            return
        urls_to_confirm: tuple[str, ...] = ()
        if isinstance(parsed, OpenWebPagesArguments) and run.web_settings.mode == "full":
            urls_to_confirm = self._note_text_guard(run=run, state=state, typed_text=typed_text
                                                    ).addresses_needing_confirmation(parsed.urls)
        if urls_to_confirm:
            approved: list[bool] = []
            async for event in self._confirm_web_addresses(session_key=run.session_key, urls=urls_to_confirm,
                                                           approved=approved, input_tokens=input_tokens):
                yield event
            if not approved[0]:
                result_holder.append(tool_message_result({
                    "pages": [], "declined_urls": list(urls_to_confirm),
                    "note": "The user declined opening these addresses. Do not retry them.",
                }))
                return
            state.approved_urls.update(urls_to_confirm)
        context = ToolContext(
            session_key=run.session_key,
            investigation=InvestigationState.start(snapshot=snapshot, settings=run.retrieval_settings),
            skills=run.skills, web_settings=run.web_settings, web_capabilities=state.capabilities,
            note_text_guard=self._note_text_guard(run=run, state=state, typed_text=typed_text),
        )
        yield self._status_event(call["name"], "started", self._tool_started_label(parsed),
                                 approx_input_tokens=input_tokens)
        extraction_before = snapshot.text_extraction.reading()
        result = await run_agent_tool(name=call["name"], arguments=self._with_note_ids(call, state.note_aliases),
                                      context=context)
        # Note text is extracted on first read; the step that paid for it says so.
        extraction_note = describe_text_extraction(before=extraction_before, after=snapshot.text_extraction.reading())
        if run.web_settings.mode == "contextual":
            result = self._with_newly_openable_addresses(result=result, state=state)
        # The model sees short note aliases, never full note ids.
        result = dataclasses.replace(result, content=json.dumps(
            state.note_aliases.aliased(json.loads(result.content)), ensure_ascii=False, separators=(",", ":")))
        for skill in result.activated_skills:
            self._record_skill_activation(run=run, skill=skill)
        yield self._status_event(call["name"], "completed", self._tool_completed_label(parsed, result) + extraction_note,
                                 approx_input_tokens=max(1, estimate_text_tokens(result.content)))
        result_holder.append(result)

    @staticmethod
    def _with_note_ids(call: dict[str, str], note_aliases: NoteAliases) -> str:
        """Tool arguments with the model's note aliases replaced by note ids."""
        if call["name"] != "read_view_notes":
            return call["arguments"]
        arguments = json.loads(call["arguments"])
        arguments["note_ids"] = [note_aliases.note_id(value) for value in arguments["note_ids"]]
        return json.dumps(arguments)

    @staticmethod
    def _with_newly_openable_addresses(*, result: ToolResult, state: AgentLoopState) -> ToolResult:
        """Contextual mode: tell the model which addresses in the notes it just read it may now open."""
        known = set(state.capabilities.normalized_urls)
        new_urls: list[str] = []
        for payload in result.note_evidence:
            for url in note_evidence_url_capabilities(payload).normalized_urls:
                if url not in known and url not in new_urls:
                    new_urls.append(url)
        if not new_urls:
            return result
        content = json.loads(result.content)
        content["web_addresses_now_openable"] = new_urls
        return dataclasses.replace(result, content=json.dumps(content, ensure_ascii=False, separators=(",", ":")))

    def _note_text_guard(self, *, run, state: AgentLoopState, typed_text: str) -> NoteTextGuard:
        return NoteTextGuard.build(
            note_text="\n".join(state.note_text_parts), typed_text=typed_text,
            known_urls=self._known_web_urls(run=run, state=state), approved_urls=frozenset(state.approved_urls),
        )

    def _known_web_urls(self, *, run, state: AgentLoopState) -> frozenset[str]:
        known = set(state.capabilities.normalized_urls)
        for evidence in web_evidence_store.evidence(session_key=run.session_key):
            known.add(evidence.final_url)
            known.add(evidence.requested_url)
            for reference in evidence.outgoing_references:
                known.add(reference.final_url)
        return frozenset(known)

    async def _confirm_web_addresses(
        self, *, session_key: str, urls: tuple[str, ...], approved: list[bool], input_tokens: int,
    ):
        assert urls
        # Opening web pages changes no notes: the question blocks nothing else.
        with bulk_operation_guard.ask(session_key, ("yes", "no")) as (question_id, answer):
            yield self._status_event("confirmation", "started", "Waiting for your confirmation",
                                     approx_input_tokens=input_tokens)
            yield {"type": "bulk_question", "question_id": question_id, "kind": "change_confirmation",
                   "label": ("Open these web addresses? They include words from your notes that you "
                             "did not type, so a web page may be trying to send your notes elsewhere."),
                   "items": list(urls)}
            choice = await answer
        approved.append(choice == "yes")
        yield self._status_event("confirmation", "completed",
                                 {True: "Confirmed opening web pages", False: "Declined opening web pages"}[approved[0]],
                                 approx_input_tokens=input_tokens)

    async def _open_agent_menu(self, *, run, menu_id: str, snapshot, result_holder, input_tokens: int):
        label = MENU_BY_ID[menu_id]["label"]
        yield self._status_event("open_menu", "started", f"Opening {label}", approx_input_tokens=input_tokens)
        pending = menu_action_store.create(session_key=run.session_key, menu_id=menu_id)
        request = {"type": "menu_open", "request_id": pending.request_id, "menu_id": menu_id,
                   "scope": snapshot.descriptor.model_dump(mode="json")}
        self._trace_store.append_event(session_key=run.session_key, run_id=run.run_id,
            event_type="MENU_REQUESTED", label="Requested menu opening", detail=request, duration_ms=0.0)
        try:
            yield request
            result = await menu_action_store.wait(pending)
        finally:
            menu_action_store.discard(pending)
        self._trace_store.append_event(session_key=run.session_key, run_id=run.run_id,
            event_type="MENU_RESULT", label=f"Menu {result.status}",
            detail={**result.model_dump(), "menu_id": menu_id}, duration_ms=0.0)
        payload: dict[str, object] = {"menu_id": menu_id, "label": label, "status": result.status}
        if MENU_BY_ID[menu_id]["presentation"] == "palette":
            payload["note"] = "The command palette entry is highlighted; the command was not run."
        result_holder.append(tool_message_result(payload))
        yield self._status_event("open_menu", "completed", f"{label} · {result.status}",
                                 approx_input_tokens=input_tokens)

    async def _stream_agent_operation(
        self, *, run, canonical_messages, snapshot, tagging_run, arguments: BaseModel, state: AgentLoopState,
    ):
        """Hand the rest of the turn to an operation; it confirms with the user and reports."""
        if isinstance(arguments, SummarizeViewArguments):
            selected_note_tokens = 0
            if snapshot.selected_note.status == "available":
                selected_note_tokens = estimate_input_tokens(snapshot.selected_note.as_payload())
            events = self._stream_view_summary(
                run=run, canonical_messages=canonical_messages, snapshot=snapshot,
                state=InvestigationState.start(snapshot=snapshot, settings=run.retrieval_settings),
                selected_note_tokens=selected_note_tokens,
                route_tokens=max(1, estimate_input_tokens(canonical_messages)),
                continues_failed_summary=arguments.continues_failed_summary,
            )
        elif isinstance(arguments, ProposeTagGenerationArguments):
            skill = run.skills.for_action("tag_proposals")
            self._record_skill_activation(run=run, skill=skill)
            events = tagging_run.stream_generation(inference=self._inference, run=run)
        elif isinstance(arguments, ProposeTagReviewArguments):
            events = tagging_run.stream_review(action=arguments.action, scope=arguments.scope,
                                               tag_filter=arguments.tag_filter)
        else:
            raise AssertionError(f"Unknown operation arguments: {type(arguments).__name__}")
        is_first_delta = True
        async with aclosing(events) as operation_events:
            async for event in operation_events:
                if event["type"] == "content_delta":
                    state.add_operation_references(note_ids=event["reference_note_ids"],
                                                   web_ids=event["reference_web_ids"])
                    text = event["text"]
                    if is_first_delta:
                        text = self._separator(state) + text
                        is_first_delta = False
                    yield state.content_event(text)
                elif event["type"] == "done":
                    state.add_operation_references(note_ids=event["reference_note_ids"],
                                                   web_ids=event["reference_web_ids"])
                    yield state.done_event()
                else:
                    yield event

    def _record_tool_call(self, *, run, call: dict[str, str], result_text: str) -> None:
        self._trace_store.append_event(
            session_key=run.session_key, run_id=run.run_id, event_type="TOOL_CALL",
            label=f"Tool call: {call['name']}",
            detail={"id": call["id"], "name": call["name"], "arguments": call["arguments"], "result": result_text},
            duration_ms=0.0,
        )

    @staticmethod
    def _tool_started_label(arguments: BaseModel) -> str:
        name = type(arguments).__name__
        labels = {
            "LookupMetaListHelpArguments": "Looking up MetaList help",
            "ViewOverviewArguments": "Looking at your view",
            "SearchViewNotesArguments": "Searching your view",
            "ReadViewNotesArguments": "Reading notes",
            "OpenWebPagesArguments": "Opening web pages",
        }
        return labels[name]

    @staticmethod
    def _tool_completed_label(arguments: BaseModel, result: ToolResult) -> str:
        name = type(arguments).__name__
        if result.is_error:
            return "Tool call not accepted"
        if name == "LookupMetaListHelpArguments":
            return "MetaList help · " + ", ".join(skill.title for skill in result.activated_skills)
        if name == "ViewOverviewArguments":
            return "Looked at your view"
        if name == "SearchViewNotesArguments":
            return f"Searched “{arguments.query}” · read {len(result.note_ids)} notes"
        if name == "ReadViewNotesArguments":
            return f"Read {len(result.note_ids)} notes"
        if name == "OpenWebPagesArguments":
            return f"Opened {len(result.web_evidence)} of {len(arguments.urls)} web pages"
        raise AssertionError(f"No completed label for {name}")
