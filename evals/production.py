"""Assemble regression requests with the same builders used by MetaList."""

from dataclasses import replace
from types import MappingProxyType

from app.services.agent.context import AgentContextBuilder
from app.services.agent.investigation import InvestigationEvidencePayload
from app.services.agent.prompt_settings import AgentPromptSet
from app.services.agent.prompts import load_prompt
from app.services.agent.scope import AgentScopeDescriptor, ScopedSearchSnapshot, SelectedNoteContext, SelectedTreeNote
from app.services.agent.scope import TextExtractionMeter
from app.services.agent.skill_settings import AgentSkillSet, DEFAULT_AGENT_SKILLS
from app.services.agent.staged_summary import SummaryBatchResult
from app.services.agent.staged_summary import SummaryFindingsResult
from app.services.agent.skills import load_skill
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.content_formatting import extract_agent_note_text
from evals.models import Message, PreparedStep, PreviousOutput, SelectedTreeFixture, SelectedHtmlTreeNoteFixture, UnavailableSelectionFixture


RESPONSE_MODELS = {
    schema.__name__: schema
    for schema in (
        SummaryBatchResult,
        SummaryFindingsResult,
    )
}
_OUTPUT_MARKER = "__METALIST_REGRESSION_PREVIOUS_OUTPUT_"


def current_prompts() -> AgentPromptSet:
    return AgentPromptSet(system_prompt=load_prompt("system.md"),
        final_response_prompt=load_prompt("final-response.md"))


def current_skills() -> AgentSkillSet:
    skills = []
    for skill in DEFAULT_AGENT_SKILLS.skills:
        if skill.trigger_action == "summarize_current_scope":
            filename = "staged-summary.md"
        elif skill.trigger_action == "web_browsing":
            filename = "web-browsing.md"
        elif skill.trigger_action == "tag_proposals":
            filename = "tag-proposals.md"
        else:
            assert skill.trigger_action.startswith("help_")
            filename = skill.trigger_action.replace("_", "-", 1) + ".md"
        skills.append(replace(skill, content=load_skill(filename)))
    return AgentSkillSet(skills=tuple(skills))


def fixture_snapshot(context) -> ScopedSearchSnapshot:
    """Only metadata counts are needed by the request builders; no live store."""
    scope = context.scope
    root_ids = tuple(f"fixture-root-{index}" for index in range(scope.matching_result_tree_count))
    reference_ids = []
    if scope.scope_kind == "reference":
        reference_ids = ["fixture-reference"]
    descriptor = AgentScopeDescriptor(scope_kind=scope.scope_kind, active_tab_id="fixture-tab",
        scope_tab_id="fixture-tab", search_query=scope.search_query, sort_mode=scope.sort_mode,
        reference_root_ids=reference_ids, label=scope.label)
    return ScopedSearchSnapshot(run_id="fixture-run", session_key="fixture-session", descriptor=descriptor,
        created_at="2026-01-01T00:00:00+00:00", ordered_root_ids=root_ids,
        ordered_note_ids=tuple(f"fixture-note-{index}" for index in range(scope.matching_note_count)),
        notes_by_id=MappingProxyType({}), tree_nodes_by_id=MappingProxyType({}),
        note_records_at_send=MappingProxyType({}),
        selected_note=selected_note_context(context.selected_note),
        preparation_ms=0.0, text_extraction=TextExtractionMeter.start(),)


def selected_note_context(fixture) -> SelectedNoteContext:
    if isinstance(fixture, UnavailableSelectionFixture):
        return SelectedNoteContext("unavailable", "", (), fixture.reason)
    if fixture.status == "unavailable":
        return SelectedNoteContext("unavailable", "", (), "unspecified")
    if fixture.status == "none":
        return SelectedNoteContext("none", "", (), unavailable_reason="")
    if isinstance(fixture, SelectedTreeFixture):
        notes = tuple(selected_tree_note(note) for note in fixture.tree_notes)
    else:
        # Existing scenarios describe a standalone leaf; production still builds its tree payload.
        notes = (SelectedTreeNote(fixture.note_id, "", fixture.content_text, fixture.tags),)
    return SelectedNoteContext("available", fixture.note_id, notes, unavailable_reason="")


def selected_tree_note(note) -> SelectedTreeNote:
    if isinstance(note, SelectedHtmlTreeNoteFixture):
        def title_lookup(url):
            if url in note.cached_url_titles:
                return note.cached_url_titles[url]
            return None
        content, redacted = extract_agent_note_text(content_html=note.content_html, tags=note.tags,
            title_lookup=title_lookup)
        assert not redacted, "Selected tree fixture must contain permitted notes only"
        return SelectedTreeNote(note.note_id, note.parent_id, content, note.tags)
    return SelectedTreeNote(**note.model_dump())


def build_messages(*, step, canonical_messages, prompts, skills):
    builder = AgentContextBuilder()
    context = step.context
    snapshot = fixture_snapshot(context)
    if context.stage == "summary_batch":
        evidence = InvestigationEvidencePayload(
            evidence_note_ids=tuple(
                node["note_id"]
                for tree in context.result_trees
                for node in _flatten_result_tree(tree)
            ),
            result_tree_ids=tuple(context.result_tree_ids),
            result_trees=tuple(context.result_trees),
            returned_approximate_token_count=estimate_input_tokens(
                context.result_trees
            ),
        )
        return builder.build_staged_summary_batch_messages(
            canonical_messages=canonical_messages,
            summary_request=canonical_messages[-1]["content"],
            prompts=prompts,
            skill=skills.for_action("summarize_current_scope"),
            snapshot=snapshot,
            evidence_payload=evidence,
            batch_index=context.batch_index,
            batch_count=context.batch_count,
        ), "SummaryFindingsResult"
    assert context.stage == "summary_final"
    summaries = tuple(
        SummaryBatchResult.model_validate(summary)
        for summary in context.summaries
    )
    messages, _references = builder.build_staged_summary_final_messages(
        canonical_messages=canonical_messages,
        summary_request=canonical_messages[-1]["content"],
        prompts=prompts,
        skill=skills.for_action("summarize_current_scope"),
        snapshot=snapshot,
        summaries=summaries,
    )
    return messages, ""


def _flatten_result_tree(tree: dict) -> tuple[dict, ...]:
    nodes = []
    stack = [tree]
    while stack:
        node = stack.pop()
        nodes.append(node)
        children = []
        if "children" in node:
            children = node["children"]
        if not isinstance(children, list):
            raise TypeError("Regression result-tree children must be a list")
        stack.extend(reversed(children))
    return tuple(nodes)


def prepare_step(step, *, prompts, skills) -> PreparedStep:
    canonical = []
    substitutions = {}
    for message in step.conversation:
        if isinstance(message, PreviousOutput):
            marker = f"{_OUTPUT_MARKER}{message.from_step}__"
            substitutions[marker] = message
            canonical.append({"role": "assistant", "content": marker})
        else:
            if _OUTPUT_MARKER in message.content:
                raise ValueError("Conversation contains a reserved previous-output marker")
            canonical.append(message.model_dump())
    messages, response_model = build_messages(step=step, canonical_messages=canonical, prompts=prompts, skills=skills)
    prepared_messages = []
    for message in messages:
        if message["role"] == "assistant" and message["content"] in substitutions:
            prepared_messages.append(substitutions[message["content"]])
        else:
            prepared_messages.append(Message.model_validate(message))
    schema = {}
    kind = "text"
    if response_model:
        kind = "structured"
        schema = RESPONSE_MODELS[response_model].model_json_schema()
    return PreparedStep(kind=kind, messages=prepared_messages, response_model=response_model,
        response_schema=schema, max_output_tokens=step.max_output_tokens, expectation=step.expectation)
