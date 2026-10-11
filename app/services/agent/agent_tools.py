"""Read-only tools of the tool-using agent.

Every read-only tool reads through the run's frozen view snapshot (already
filtered by the AI privacy boundary) or the packaged help, or opens web pages
within the web-access mode. None of them changes notes. The interactive tools
(menus, whole-view summary, tag proposals) are defined here but run by the agent
loop, because they talk to the browser and ask the user to confirm.

Each tool returns JSON text for the model plus the note ids and web evidence it
showed, so the final answer can cite exactly what the tools returned.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from typing import Literal

from app.services.agent.help_catalog import HELP_TOPICS, MENU_ACTIONS, MENU_BY_ID, HelpTopic
from app.services.agent.investigation import InvestigationEvidencePayload, InvestigationState, RootTreeRead
from app.services.agent.skill_settings import AgentSkill, AgentSkillSet
from app.services.agent.tool_calling import AgentTool
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.agent.web_actions import NoteTextGuard
from app.services.agent.web_actions import open_web_pages
from app.services.agent.web_capabilities import WebUrlCapabilitySet
from app.services.agent.web_evidence import WebPageEvidence
from app.services.agent.web_settings import AgentWebSettings
from app.services.exception_capture import CapturedExceptionContext
from app.version import __version__


MAX_WEB_PAGES_PER_CALL = 8
MAX_OVERVIEW_PREVIEW_CHARACTERS = 120
MAX_SEARCH_MATCH_IDS = 200
# The overview lists root trees until this share of the evidence budget is used.
OVERVIEW_BUDGET_DIVISOR = 4


class LookupMetaListHelpArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topics: list[HelpTopic] = Field(
        ..., min_length=1, max_length=len(HELP_TOPICS),
        description="The smallest set of help topics that answers the question, each at most once.",
    )

    @field_validator("topics")
    @classmethod
    def reject_repeated_topics(cls, topics: list[str]) -> list[str]:
        if len(set(topics)) != len(topics):
            raise ValueError("Each help topic may be requested once")
        return topics


class ViewOverviewArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReadViewNotesArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note_ids: list[str] = Field(
        ..., max_length=200,
        description=(
            "Ids of notes whose whole trees to read; any note in a tree selects that tree. "
            "An empty list reads the view from its first tree."
        ),
    )


class SearchViewNotesArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(
        ..., min_length=1, max_length=500,
        description="Words that must all appear in a note's text or tags (case-insensitive).",
    )

    @field_validator("query")
    @classmethod
    def reject_blank_query(cls, query: str) -> str:
        if query.strip() == "":
            raise ValueError("The search query must contain a word")
        return query


class OpenWebPagesArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    urls: list[str] = Field(
        ..., min_length=1, max_length=MAX_WEB_PAGES_PER_CALL,
        description="Public http(s) addresses to open.",
    )


class OpenMenuArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    menu_id: Literal[tuple(MENU_BY_ID)] = Field(..., description="The menu destination to open.")


class SummarizeViewArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    continues_failed_summary: bool = Field(
        ...,
        description=(
            "true only when the user asks to retry or continue a summary of this view that failed or "
            "was stopped earlier in this chat (for example 'try that again' or 'continue'): its finished "
            "batches are reused and the rest run with the original question. false for any new or "
            "different summary request."
        ),
    )


class ProposeTagGenerationArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProposeTagReviewArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["accept", "remove"] = Field(
        ..., description="accept turns proposals into tags; remove discards proposals.",
    )
    scope: Literal["current_view", "namespace"] = Field(
        ..., description="current_view unless the user explicitly asked for the whole namespace.",
    )
    tag_filter: str = Field(
        ..., max_length=256,
        description=("The tag the user named (e.g. 'seedling' for 'accept the seedling proposals'). "
                     "Empty only when the user means every pending proposal, whatever its tag."),
    )


LOOKUP_METALIST_HELP_TOOL = AgentTool(
    name="lookup_metalist_help",
    description=(
        "Look up MetaList's own product help: how features, menus and settings work, and the "
        "release notes (what changed in each version, plus the installed version). Topics: "
        + "; ".join(f"{topic}: {description}" for topic, (_title, description) in HELP_TOPICS.items())
    ),
    arguments_model=LookupMetaListHelpArguments,
)
VIEW_OVERVIEW_TOOL = AgentTool(
    name="view_overview",
    description=(
        "Describe the user's current view: its label, how many notes and trees it holds, the "
        "note being edited with its tree, and a list of the view's root trees with a preview."
    ),
    arguments_model=ViewOverviewArguments,
)
READ_VIEW_NOTES_TOOL = AgentTool(
    name="read_view_notes",
    description=(
        "Read whole note trees from the user's current view, in view order, as many as fit. "
        "Reports trees left unread so they can be read in a later call. Cite notes as [[note_id]]."
    ),
    arguments_model=ReadViewNotesArguments,
)
SEARCH_VIEW_NOTES_TOOL = AgentTool(
    name="search_view_notes",
    description=(
        "Find notes in the user's current view whose text or tags contain every query word, "
        "and read the trees they belong to. Words only: it cannot find notes by a category or meaning "
        "they do not spell out. Searches only the current view. Cite notes as [[note_id]]."
    ),
    arguments_model=SearchViewNotesArguments,
)
OPEN_WEB_PAGES_TOOL = AgentTool(
    name="open_web_pages",
    description=(
        "Open public web pages and read their text. Cite a page with its citation_token."
    ),
    arguments_model=OpenWebPagesArguments,
)

OPEN_MENU_TOOL = AgentTool(
    name="open_menu",
    description=(
        "Open a MetaList dialog in the browser, or highlight a command palette entry without running "
        "it. Opening changes nothing. Destinations: "
        + "; ".join(f"{entry['id']}: {entry['label']}" for entry in MENU_ACTIONS)
    ),
    arguments_model=OpenMenuArguments,
)
SUMMARIZE_VIEW_TOOL = AgentTool(
    name="summarize_view",
    description=(
        "Summarize every note in the current view, or every note in it that fits the user's description "
        "(the summary follows the user's request), in batches when it is large. MetaList asks the user "
        "to confirm large summaries, then writes the summary. Ends your turn."
    ),
    arguments_model=SummarizeViewArguments,
)
PROPOSE_TAG_GENERATION_TOOL = AgentTool(
    name="propose_tag_generation",
    description=(
        "Generate new tag proposals for the notes in the current view. MetaList asks the user to "
        "choose the tag focus and confirm, then adds proposals (never accepted tags). Ends your turn."
    ),
    arguments_model=ProposeTagGenerationArguments,
)
PROPOSE_TAG_REVIEW_TOOL = AgentTool(
    name="propose_tag_review",
    description=(
        "Accept or remove pending tag proposals in the current view or the whole namespace, all of them "
        "or only those of one named tag. MetaList shows the user exactly what will change and applies it "
        "only after Yes. Ends your turn."
    ),
    arguments_model=ProposeTagReviewArguments,
)
# Tools that end the agent's turn: the operation reports its own outcome.
OPERATION_TOOL_NAMES = frozenset({
    SUMMARIZE_VIEW_TOOL.name, PROPOSE_TAG_GENERATION_TOOL.name, PROPOSE_TAG_REVIEW_TOOL.name,
})


@dataclass(frozen=True, slots=True)
class ToolContext:
    """Everything a tool may read during one agent run."""

    session_key: str
    investigation: InvestigationState
    skills: AgentSkillSet
    web_settings: AgentWebSettings
    web_capabilities: WebUrlCapabilitySet
    note_text_guard: NoteTextGuard

    def __post_init__(self) -> None:
        assert isinstance(self.session_key, str) and self.session_key != ""
        assert isinstance(self.investigation, InvestigationState)
        assert isinstance(self.skills, AgentSkillSet)
        assert isinstance(self.web_settings, AgentWebSettings)
        assert isinstance(self.web_capabilities, WebUrlCapabilitySet)
        assert isinstance(self.note_text_guard, NoteTextGuard)
        if self.investigation.snapshot.session_key != self.session_key:
            raise RuntimeError("The frozen view belongs to another session")


@dataclass(frozen=True, slots=True)
class ToolResult:
    """One tool call's answer to the model, plus what it showed for citations.

    disclosed_note_text is the note text the result showed the model, which full
    web mode keeps out of web addresses unless the user confirms.
    """

    content: str
    is_error: bool
    disclosed_note_text: str
    note_ids: tuple[str, ...]
    note_evidence: tuple[InvestigationEvidencePayload, ...]
    web_evidence: tuple[WebPageEvidence, ...]
    activated_skills: tuple[AgentSkill, ...]

    def __post_init__(self) -> None:
        assert isinstance(self.content, str) and self.content != ""
        assert isinstance(self.disclosed_note_text, str)
        assert len(self.note_evidence) <= 1
        if self.is_error:
            assert self.disclosed_note_text == "" and self.note_ids == () and self.note_evidence == ()
            assert self.web_evidence == () and self.activated_skills == ()


def available_agent_tools(*, web_settings: AgentWebSettings) -> tuple[AgentTool, ...]:
    """The read-only tools in the default order: help, notes, web."""
    tools = [LOOKUP_METALIST_HELP_TOOL, VIEW_OVERVIEW_TOOL, SEARCH_VIEW_NOTES_TOOL, READ_VIEW_NOTES_TOOL]
    if web_settings.can_open_pages:
        tools.append(OPEN_WEB_PAGES_TOOL)
    return tuple(tools)


def agent_loop_tools(*, web_settings: AgentWebSettings) -> tuple[AgentTool, ...]:
    """Every tool the agent loop offers, in the default order."""
    return (
        *available_agent_tools(web_settings=web_settings),
        OPEN_MENU_TOOL,
        PROPOSE_TAG_GENERATION_TOOL,
        PROPOSE_TAG_REVIEW_TOOL,
        SUMMARIZE_VIEW_TOOL,
    )


def parse_tool_call(
    *, name: str, arguments: str, tools: tuple[AgentTool, ...],
) -> BaseModel | ToolResult:
    """Parsed arguments, or an error result explaining the rejected call to the model."""
    assert isinstance(name, str) and isinstance(arguments, str)
    tools_by_name = {tool.name: tool for tool in tools}
    if name not in tools_by_name:
        return _error_result(f"There is no tool named {name!r}. Available tools: {', '.join(tools_by_name)}.")
    arguments_capture = CapturedExceptionContext(
        ValidationError, boundary="app/services/agent/agent_tools.py:parse_tool_call:arguments_capture",
    )
    parsed = None
    with arguments_capture:
        parsed = tools_by_name[name].arguments_model.model_validate_json(arguments)
    if arguments_capture.captured_exception is not None:
        problems = "; ".join(
            f"{_error_location(error['loc'])}: {error['msg']}"
            for error in arguments_capture.captured_exception.errors()
        )
        return _error_result(f"The arguments for {name} were not accepted ({problems}). Fix them and call again.")
    assert parsed is not None
    return parsed


async def run_agent_tool(*, name: str, arguments: str, context: ToolContext) -> ToolResult:
    """Run one read-only tool call. A call the tool cannot accept is explained back to the model."""
    parsed = parse_tool_call(
        name=name, arguments=arguments, tools=available_agent_tools(web_settings=context.web_settings),
    )
    if isinstance(parsed, ToolResult):
        return parsed
    if isinstance(parsed, LookupMetaListHelpArguments):
        return _lookup_metalist_help(parsed, context)
    if isinstance(parsed, ViewOverviewArguments):
        return _view_overview(context)
    if isinstance(parsed, ReadViewNotesArguments):
        return _read_view_notes(parsed, context)
    if isinstance(parsed, SearchViewNotesArguments):
        return _search_view_notes(parsed, context)
    if isinstance(parsed, OpenWebPagesArguments):
        return await _open_web_pages(parsed, context)
    raise AssertionError(f"Tool {name} has no implementation")


def _lookup_metalist_help(arguments: LookupMetaListHelpArguments, context: ToolContext) -> ToolResult:
    skills = tuple(context.skills.for_action(f"help_{topic}") for topic in arguments.topics)
    payload = {
        "installed_version": __version__,
        "topics": [
            {"topic": topic, "title": skill.title, "help": skill.content}
            for topic, skill in zip(arguments.topics, skills, strict=True)
        ],
    }
    return ToolResult(content=_json(payload), is_error=False, disclosed_note_text="", note_ids=(),
                      note_evidence=(), web_evidence=(), activated_skills=skills)


def _view_overview(context: ToolContext) -> ToolResult:
    snapshot = context.investigation.snapshot
    tree_sizes: dict[str, int] = {root_id: 0 for root_id in snapshot.ordered_root_ids}
    for note_id in snapshot.ordered_note_ids:
        tree_sizes[snapshot.notes_by_id[note_id].root_note_id] += 1
    budget = context.investigation.max_page_approximate_tokens // OVERVIEW_BUDGET_DIVISOR
    listed: list[dict[str, object]] = []
    used_tokens = 0
    for root_id in snapshot.ordered_root_ids:
        entry = {"root_id": root_id, "notes_in_view": tree_sizes[root_id], "preview": _preview(snapshot, root_id)}
        entry_tokens = estimate_input_tokens(entry)
        if used_tokens + entry_tokens > budget:
            break
        listed.append(entry)
        used_tokens += entry_tokens
    payload = {
        "view_label": snapshot.descriptor.label,
        "view_kind": snapshot.descriptor.scope_kind,
        "search_query": snapshot.descriptor.search_query,
        "note_count": snapshot.note_count,
        "tree_count": snapshot.result_tree_count,
        "selected_note": snapshot.selected_note.as_payload(),
        "trees": listed,
        "trees_not_listed": snapshot.result_tree_count - len(listed),
        "privacy": "Notes excluded by the AI privacy settings are not part of the view.",
    }
    return ToolResult(content=_json(payload), is_error=False,
                      disclosed_note_text="\n".join(str(entry["preview"]) for entry in listed),
                      note_ids=snapshot.selected_note.reference_note_ids, note_evidence=(),
                      web_evidence=(), activated_skills=())


def _preview(snapshot, root_id: str) -> str:
    if root_id not in snapshot.notes_by_id:
        return ""
    lines = snapshot.notes_by_id[root_id].content_text.strip().splitlines()
    if not lines:
        return ""
    return lines[0][:MAX_OVERVIEW_PREVIEW_CHARACTERS]


def _read_view_notes(arguments: ReadViewNotesArguments, context: ToolContext) -> ToolResult:
    tree_read = context.investigation.read_root_trees(requested_ids=tuple(arguments.note_ids))
    return _tree_read_result(context.investigation.snapshot, tree_read, {})


def _search_view_notes(arguments: SearchViewNotesArguments, context: ToolContext) -> ToolResult:
    words = tuple(word.lower() for word in arguments.query.split())
    assert words
    snapshot = context.investigation.snapshot
    matching_note_ids = tuple(
        note_id for note_id in snapshot.ordered_note_ids
        if _note_matches(snapshot.notes_by_id[note_id], words)
    )
    search_payload: dict[str, object] = {
        "query": arguments.query,
        "matching_note_count": len(matching_note_ids),
        "matching_note_ids": list(matching_note_ids[:MAX_SEARCH_MATCH_IDS]),
    }
    if not matching_note_ids:
        return ToolResult(content=_json({**search_payload, "trees": []}), is_error=False, disclosed_note_text="",
                          note_ids=(), note_evidence=(), web_evidence=(), activated_skills=())
    tree_read = context.investigation.read_root_trees(requested_ids=matching_note_ids)
    assert tree_read.unknown_ids == ()
    return _tree_read_result(snapshot, tree_read, search_payload)


def _note_matches(note, words: tuple[str, ...]) -> bool:
    text = note.content_text.lower()
    tags = tuple(term.lower() for term in (*note.explicit_tag_terms, *note.proposed_tag_terms))
    return all(
        word in text or any(word.lstrip("#") in tag for tag in tags)
        for word in words
    )


def _tree_read_result(snapshot, tree_read: RootTreeRead, extra_payload: dict[str, object]) -> ToolResult:
    payload = {
        **extra_payload,
        "trees": list(tree_read.payload.result_trees),
        "unread_root_ids": list(tree_read.unread_root_ids),
        "too_large_root_ids": list(tree_read.too_large_root_ids),
        "unknown_ids": list(tree_read.unknown_ids),
    }
    disclosed = "\n".join(
        " ".join((note.content_text, *note.explicit_tag_terms, *note.proposed_tag_terms))
        for note_id in tree_read.payload.evidence_note_ids
        for note in (snapshot.notes_by_id[note_id],)
    )
    return ToolResult(content=_json(payload), is_error=False, disclosed_note_text=disclosed,
                      note_ids=tree_read.payload.evidence_note_ids, note_evidence=(tree_read.payload,),
                      web_evidence=(), activated_skills=())


async def _open_web_pages(arguments: OpenWebPagesArguments, context: ToolContext) -> ToolResult:
    pages, evidence = await open_web_pages(
        session_key=context.session_key,
        web_settings=context.web_settings,
        capabilities=context.web_capabilities,
        note_text_guard=context.note_text_guard,
        urls=arguments.urls,
    )
    return ToolResult(content=_json({"pages": pages}), is_error=False, disclosed_note_text="",
                      note_ids=(), note_evidence=(), web_evidence=evidence, activated_skills=())


def _error_location(location: tuple[object, ...]) -> str:
    if not location:
        return "arguments"
    return ".".join(str(part) for part in location)


def _error_result(message: str) -> ToolResult:
    return ToolResult(content=_json({"error": message}), is_error=True, disclosed_note_text="",
                      note_ids=(), note_evidence=(), web_evidence=(), activated_skills=())


def tool_message_result(payload: dict[str, object]) -> ToolResult:
    """A plain result the agent loop reports back to the model (menus, confirmations)."""
    return ToolResult(content=_json(payload), is_error=False, disclosed_note_text="",
                      note_ids=(), note_evidence=(), web_evidence=(), activated_skills=())


def tool_error_result(message: str) -> ToolResult:
    return _error_result(message)


def _json(payload: dict[str, object]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
