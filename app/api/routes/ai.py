"""Authenticated AI provider and session-chat endpoints."""

from __future__ import annotations

import json
import math
from collections.abc import AsyncIterator
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator
from typing_extensions import Self

from app.api.request_auth import require_request_auth_token
from app.api.transactions import transactional_route
from app.models.utils import note_data_to_html
from app.models.utils import render_note_data_read_only
from app.services.ai_chat_stream import ChatTurnStream
from app.services.ai_setup import AiConnection
from app.services.ai_setup import AiNotSetUp
from app.services.ai_setup import AiProvider
from app.services.ai_setup import connect_to_ai
from app.services.ai_chat import ai_chat_store
from app.services.ai_chat_rendering import find_note_citation_ids
from app.services.ai_chat_rendering import find_web_citation_ids
from app.services.ai_chat_rendering import render_ai_chat_markdown_to_html
from app.services.agent.context import AgentContextBuilder
from app.services.agent.cloud_privacy import cloud_privacy_evaluator
from app.services.agent.cloud_privacy import resolve_cloud_privacy_boundary
from app.services.agent.inference import InferenceAdapter
from app.services.agent.model_policy import SingleModelPolicy
from app.services.agent.openai_inference import OPENAI_MODELS
from app.services.agent.openai_inference import validate_openai_model
from app.services.agent.openai_cost_tracking import OpenAICostSnapshot
from app.services.agent.openai_cost_tracking import openai_cost_tracker
from app.services.agent.prompt_settings import AgentPromptSet
from app.services.agent.skill_settings import AgentSkillSet
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.prompt_settings import DEFAULT_AGENT_PROMPTS
from app.services.agent.retrieval_settings import resolve_agent_retrieval_settings
from app.services.agent.scope import AgentScopeDescriptor
from app.services.agent.scope import scoped_search_snapshot_factory
from app.services.agent.runtime import AgentRuntime
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.agent.trace import agent_trace_store
from app.services.agent.menu_actions import MenuResult, menu_action_store
from app.services.client_state_service import load_client_preferences
from app.services.markdown_rendering import render_markdown_to_html
from app.services.note_store import store as note_store
from app.services.openai_credentials import OpenAICredentialInputError
from app.services.openai_credentials import openai_credential_store
from app.services.openai_credentials import validate_openai_api_key
from app.services.sync import set_clipboard, get_current_sync_uuid
from app.services.agent.tagging_run import TaggingRun, proposal_scope_ids
from app.services.agent.retrieval_settings import resolve_tagging_batch_tokens
from app.services.agent.web_settings import AgentWebSettings
from app.services.agent.web_settings import resolve_agent_web_settings
from app.services.agent.web_evidence import web_evidence_store
from app.services.agent.summary_batch_store import summary_batch_store
from app.services.agent.tagging import TAGGING_POLICY_KEY
from app.usecases.bulk_tag_proposals import apply_bulk_proposals, prepare_proposal_changes
from app.services.bulk_operation import bulk_operation_guard
from app.services.tab_state import tab_state_store
from app.services.tokens import token_service
from app.services.agent.inference import InferenceProviderError
from app.services.agent.note_tag_suggestions import build_note_tag_request
from app.services.agent.export_title_suggestions import MAX_PREVIOUS_TITLES
from app.services.agent.export_title_suggestions import ExportTitleRequest
from app.services.agent.export_title_suggestions import build_export_title_request
from app.services.agent.export_title_suggestions import suggest_export_title
from app.services.agent.note_tag_suggestions import NoteTagRequest
from app.services.agent.note_tag_suggestions import suggest_note_tags
from app.services.snapshot import resolve_view_scope_membership
from app.services.html_export import resolve_export_scope
from app.services.ai_setup import describe_ai_setup
from app.services.input_errors import InputRejected
from app.utils.text_utils import strip_html


router = APIRouter(prefix="/ai", tags=["ai"])

agent_context_builder = AgentContextBuilder()


def _require_ai_connection(*, provider: AiProvider, token: str, session_key: str) -> AiConnection:
    # lint: allow-PY001 rationale="the user removed or never added the AI's key: an expected 409, not a defect"
    try:
        return connect_to_ai(provider=provider, token=token, session_key=session_key)
    # lint: allow-PY001 rationale="the user removed or never added the AI's key: an expected 409, not a defect"
    except AiNotSetUp as exc:
        raise HTTPException(status_code=409, detail="The AI is not set up: add its API key in AI settings") from exc


def _agent_runtime(*, inference: InferenceAdapter) -> AgentRuntime:
    return AgentRuntime(
        context_builder=agent_context_builder,
        inference=inference,
        model_policy=SingleModelPolicy(),
        trace_store=agent_trace_store,
        provider_label=inference.provider_label,
    )


class AiModelsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["openai"]


class AiModelsResponse(BaseModel):
    models: list[str]


class OpenAICredentialRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    api_key: SecretStr


class OpenAICredentialStatusResponse(BaseModel):
    configured: bool
    persistent: bool


class OpenAICostResponse(BaseModel):
    estimated_cost_usd: float = Field(..., ge=0)
    uncached_input_tokens: int = Field(..., ge=0)
    cached_input_tokens: int = Field(..., ge=0)
    cache_write_tokens: int = Field(..., ge=0)
    output_tokens: int = Field(..., ge=0)


class CloudPrivacyPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["openai"]
    note_ids: list[str] = Field(..., max_length=20_000)

    @field_validator("note_ids")
    @classmethod
    def validate_note_ids(cls, values: list[str]) -> list[str]:
        if any(not isinstance(value, str) or value.strip() == "" for value in values):
            raise ValueError("Privacy preview note ids must be non-empty strings")
        normalized = [value.strip() for value in values]
        if len(set(normalized)) != len(normalized):
            raise ValueError("Privacy preview note ids must be unique")
        return normalized


class CloudPrivacyPreviewResponse(BaseModel):
    hidden_note_ids: list[str]


class AiChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["openai"]
    model: str
    thinking_level: Literal["off", "low", "medium", "high"]
    show_diagnostics: bool
    message: str = Field(..., max_length=32_000)
    scope: AgentScopeDescriptor
    selected_note_id: str = Field(..., max_length=128, pattern=r"^(?:\S+)?$")

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        normalized = value.strip()
        if normalized == "":
            raise ValueError("AI model must not be blank")
        return normalized

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        if value.strip() == "":
            raise ValueError("Chat message must not be blank")
        return value

    @model_validator(mode="after")
    def validate_thinking_level_for_model(self) -> Self:
        validate_openai_model(self.model)
        return self


class NoteTagSuggestionAvailabilityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: AiProvider
    # The note as it is being edited, unsaved changes included.
    tags: str = Field(..., max_length=1024 * 1024)
    content_html: str = Field(..., max_length=16 * 1024 * 1024)


class NoteTagSuggestionAvailabilityResponse(BaseModel):
    is_available: bool


class NoteTagSuggestionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: AiProvider
    model: str
    thinking_level: Literal["off", "low", "medium", "high"]
    # The note alone, or it and the notes below it the view shows.
    include_children: bool
    # The view the note is in ('' for no search).
    search: str = Field(..., max_length=1024 * 1024)
    tab_id: str = Field(..., min_length=1, max_length=256)
    is_untagged_view: bool

    @model_validator(mode="after")
    def validate_model_for_provider(self) -> Self:
        assert self.provider == "openai"
        validate_openai_model(self.model)
        return self


class ExportTitleScope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: AiProvider
    # The view exported or printed, or the one its note is in ('' for no search).
    search: str = Field(..., max_length=1024 * 1024)
    tab_id: str = Field(..., min_length=1, max_length=256)
    is_untagged_view: bool
    # A note with its children ("note"), or the view as it is shown ("view", note_id '').
    exported: Literal["note", "view"]
    note_id: str = Field(..., max_length=256)

    @model_validator(mode="after")
    def validate_exported_note(self) -> Self:
        if (self.exported == "note") != (self.note_id != ""):
            raise ValueError("A note's export names the note; the view's export names none")
        return self


class ExportTitleAvailabilityResponse(BaseModel):
    # "unavailable": no AI is set up (no button); then as ExportTitleAvailability.
    availability: Literal["unavailable", "nothing", "private", "partial", "ready"]


class ExportTitleSuggestionRequest(ExportTitleScope):
    model: str
    thinking_level: Literal["off", "low", "medium", "high"]
    # Titles the AI gave in this dialog: it gives another.
    previous_titles: list[str] = Field(..., max_length=MAX_PREVIOUS_TITLES)

    @model_validator(mode="after")
    def validate_model_for_provider(self) -> Self:
        assert self.provider == "openai"
        validate_openai_model(self.model)
        return self


class AiChatActivity(BaseModel):
    sequence: int = Field(..., ge=1)
    action: str
    status: Literal["started", "completed"]
    label: str
    approx_input_tokens: int = Field(..., ge=1)
    output_tokens_received: int = Field(..., ge=0)
    duration_ms: float = Field(..., ge=0)

    @field_validator("duration_ms")
    @classmethod
    def validate_duration_ms(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("AI chat activity duration must be finite")
        return value


class AiChatMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    rendered_content: str
    thinking: str
    rendered_thinking: str
    status: Literal["complete", "streaming", "error"]
    error: str
    provider: Literal["openai"]
    model: str
    activities: list[AiChatActivity]


class AiSessionResponse(BaseModel):
    messages: list[AiChatMessage]


class AiClearResponse(BaseModel):
    message: str


class AiDebugDetailToggleRequest(BaseModel):
    enabled: bool


class AiDebugSnapshotResponse(BaseModel):
    enabled: bool
    has_trace: bool
    run: dict[str, Any]


class AiCopyMessageRequest(BaseModel):
    client_id: str = Field(..., min_length=1, max_length=128)

    @field_validator("client_id")
    @classmethod
    def validate_client_id(cls, value: str) -> str:
        normalized = value.strip()
        if normalized == "":
            raise ValueError("Client id must not be blank")
        return normalized


class AiCopyMessageResponse(BaseModel):
    message_id: str
    html: str
    plain_text: str
    tags: str


def _render_ai_response_note_content(*, markdown_text: str, session_key: str) -> str:
    if not isinstance(markdown_text, str) or markdown_text == "":
        raise ValueError("AI response Markdown must be a non-empty string")
    allowed_note_ids = find_note_citation_ids(
        markdown_text,
        notes=note_store,
    )
    rendered_content = render_ai_chat_markdown_to_html(
        markdown_text,
        notes=note_store,
        allowed_note_ids=allowed_note_ids,
        allowed_web_evidence=web_evidence_store.available_references_for_ids(
            session_key=session_key,
            evidence_ids=find_web_citation_ids(markdown_text),
        ),
    )
    if rendered_content == "":
        raise RuntimeError("Completed AI response rendered to empty HTML")
    return (
        '<div class="ai-chat-message-content meta-markdown" '
        'data-markdown-rendered="true">'
        f"{rendered_content}</div>"
    )


@router.post("/models", response_model=AiModelsResponse)
@transactional_route
async def list_ai_models(
    payload: AiModelsRequest,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> AiModelsResponse:
    del token, payload
    return AiModelsResponse(models=list(OPENAI_MODELS))


@router.get(
    "/openai/credential",
    response_model=OpenAICredentialStatusResponse,
)
def get_openai_credential_status(
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> OpenAICredentialStatusResponse:
    response.headers["Cache-Control"] = "no-store"
    session_key = token_service.get_session_key(token)
    status = openai_credential_store.status(token=token, session_key=session_key)
    return OpenAICredentialStatusResponse(
        configured=status.configured,
        persistent=status.persistent,
    )


@router.put(
    "/openai/credential",
    response_model=OpenAICredentialStatusResponse,
)
@transactional_route
def put_openai_credential(
    payload: OpenAICredentialRequest,
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> OpenAICredentialStatusResponse:
    response.headers["Cache-Control"] = "no-store"
    session_key = token_service.get_session_key(token)
    submitted_api_key = payload.api_key.get_secret_value()
    # lint: allow-PY001 rationale="validate user-supplied secret after Pydantic has masked it"
    try:
        api_key = validate_openai_api_key(submitted_api_key)
    # lint: allow-PY001 rationale="return a concise validation error without echoing the secret"
    except OpenAICredentialInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    status = openai_credential_store.configure(
        token=token,
        session_key=session_key,
        api_key=api_key,
    )
    return OpenAICredentialStatusResponse(
        configured=status.configured,
        persistent=status.persistent,
    )


@router.delete(
    "/openai/credential",
    response_model=OpenAICredentialStatusResponse,
)
@transactional_route
def delete_openai_credential(
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> OpenAICredentialStatusResponse:
    response.headers["Cache-Control"] = "no-store"
    session_key = token_service.get_session_key(token)
    status = openai_credential_store.clear(session_key=session_key)
    return OpenAICredentialStatusResponse(
        configured=status.configured,
        persistent=status.persistent,
    )


@router.post(
    "/notes/{note_id}/tag-suggestions/availability",
    response_model=NoteTagSuggestionAvailabilityResponse,
)
@transactional_route
def note_tag_suggestion_availability(
    note_id: str,
    payload: NoteTagSuggestionAvailabilityRequest,
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> NoteTagSuggestionAvailabilityResponse:
    """Whether "Suggest Tags with AI" applies: an AI is set up and may see the note as edited."""
    response.headers["Cache-Control"] = "no-store"
    if not note_store.has_note(note_id):
        raise HTTPException(status_code=404, detail=f"Note not found: {note_id}")
    session_key = token_service.get_session_key(token)
    if not describe_ai_setup(token=token, session_key=session_key).is_ready_for(payload.provider):
        return NoteTagSuggestionAvailabilityResponse(is_available=False)
    boundary = resolve_cloud_privacy_boundary(
        preferences=load_client_preferences(token=token),
        provider=payload.provider,
    )
    draft_effective_tags = note_store.draft_effective_tag_terms(
        note_id=note_id, tags=payload.tags, plaintext=strip_html(payload.content_html),
    )
    reason = cloud_privacy_evaluator.draft_exclusion_reason(
        note_id=note_id, draft_effective_tags=draft_effective_tags,
        draft_content_html=payload.content_html, boundary=boundary,
    )
    return NoteTagSuggestionAvailabilityResponse(is_available=reason == "")


@router.post("/notes/{note_id}/tag-suggestions")
@transactional_route
def suggest_tags_for_note_with_ai(
    note_id: str,
    payload: NoteTagSuggestionRequest,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> StreamingResponse:
    """Ask the AI for the saved note's tags (and its children's): streams {"type": "progress"}
    lines, then one {"type": "proposals"} or {"type": "failed"} line.

    Nothing is written: the client adds what it gets back as proposals
    (POST /notes/{id}/tag-proposals/add), one undo step.
    """
    if not note_store.has_note(note_id):
        raise HTTPException(status_code=404, detail=f"Note not found: {note_id}")
    session_key = token_service.get_session_key(token)
    connection = _require_ai_connection(provider=payload.provider, token=token, session_key=session_key)
    preferences = load_client_preferences(token=token)
    boundary = resolve_cloud_privacy_boundary(preferences=preferences, provider=payload.provider)
    if cloud_privacy_evaluator.exclusion_reason(note_id=note_id, boundary=boundary) != "":
        raise InputRejected(
            "Your AI privacy settings hide this note from the AI, so it can't suggest tags for it"
        )
    scope = resolve_view_scope_membership(
        search=payload.search,
        sort_mode=tab_state_store.get_sort_mode(tab_id=payload.tab_id),
        is_untagged_view=payload.is_untagged_view,
    )
    if note_id not in scope.allowed_note_ids:
        raise HTTPException(status_code=409, detail="The note is not in this view any more")
    request = build_note_tag_request(
        note_id=note_id, include_children=payload.include_children, boundary=boundary,
        tag_skill=DEFAULT_AGENT_SKILLS.for_action("tag_proposals"), scope_note_ids=scope.allowed_note_ids,
        batch_tokens=resolve_tagging_batch_tokens(preferences, payload.provider),
    )
    events = _note_tag_suggestion_events(
        request=request, connection=connection, payload=payload,
        web_settings=resolve_agent_web_settings(preferences=preferences), session_key=session_key,
    )
    return StreamingResponse(
        events,
        media_type="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store", "Content-Encoding": "identity"},
    )


async def _note_tag_suggestion_events(
    *, request: NoteTagRequest, connection: AiConnection, payload: NoteTagSuggestionRequest,
    web_settings: AgentWebSettings, session_key: str,
) -> AsyncIterator[str]:
    events = suggest_note_tags(
        request=request, inference=connection.inference, base_url=connection.base_url,
        model=payload.model, thinking_level=payload.thinking_level,
        web_settings=web_settings, session_key=session_key,
    )
    # lint: allow-PY001 rationale="the AI provider failed or kept answering unusably: the client shows why"
    try:
        async for event in events:  # shockharness: ignore[EXC003] reason="each pull from the provider's stream is the external operation; the body only forwards the event"
            yield json.dumps(event) + "\n"
    # lint: allow-PY001 rationale="the AI provider failed or kept answering unusably: the client shows why"
    except InferenceProviderError as exc:
        yield json.dumps({"type": "failed", "message": str(exc)}) + "\n"
    finally:
        await events.aclose()


def _export_title_request(scope: ExportTitleScope, token: str) -> ExportTitleRequest:
    """What the AI may read of the export or print: the notes the AI privacy settings let it see."""
    note_id = None
    if scope.exported == "note":
        note_id = scope.note_id
        if not note_store.has_note(note_id):
            raise HTTPException(status_code=404, detail=f"Note not found: {note_id}")
    search = None
    if scope.search != "":
        search = scope.search
    root_ids, allowed_note_ids = resolve_export_scope(
        search=search,
        sort_mode=tab_state_store.get_sort_mode(tab_id=scope.tab_id),
        is_untagged_view=scope.is_untagged_view, root_note_id=note_id,
    )
    boundary = resolve_cloud_privacy_boundary(preferences=load_client_preferences(token=token), provider=scope.provider)
    return build_export_title_request(root_ids=root_ids, allowed_note_ids=allowed_note_ids, boundary=boundary)


@router.post("/export-title/availability", response_model=ExportTitleAvailabilityResponse)
@transactional_route
def export_title_availability(
    payload: ExportTitleScope,
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> ExportTitleAvailabilityResponse:
    """Whether the Export and Print dialog's "Suggest with AI" can ask, and what it says about private notes."""
    response.headers["Cache-Control"] = "no-store"
    session_key = token_service.get_session_key(token)
    if not describe_ai_setup(token=token, session_key=session_key).is_ready_for(payload.provider):
        return ExportTitleAvailabilityResponse(availability="unavailable")
    return ExportTitleAvailabilityResponse(availability=_export_title_request(payload, token).availability)


@router.post("/export-title")
@transactional_route
def suggest_export_title_with_ai(
    payload: ExportTitleSuggestionRequest,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> StreamingResponse:
    """Ask the AI for an export's or print's title: one {"type": "title"} or {"type": "failed"} line.
    Streamed, so Stop (the client going away) ends the request."""
    session_key = token_service.get_session_key(token)
    connection = _require_ai_connection(provider=payload.provider, token=token, session_key=session_key)
    request = _export_title_request(payload, token)
    if not request.notes:
        raise InputRejected("These notes are private, so the AI can't suggest a title")
    web_mode = resolve_agent_web_settings(preferences=load_client_preferences(token=token)).mode
    return StreamingResponse(
        _export_title_events(
            request=request, payload=payload, connection=connection, web_mode=web_mode, session_key=session_key,
        ),
        media_type="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store", "Content-Encoding": "identity"},
    )


async def _export_title_events(
    *, request: ExportTitleRequest, payload: ExportTitleSuggestionRequest, connection: AiConnection,
    web_mode: str, session_key: str,
) -> AsyncIterator[str]:
    previous_titles = tuple(payload.previous_titles)
    # lint: allow-PY001 rationale="the AI provider failed or answered without a title: the dialog shows why"
    try:
        title = await suggest_export_title(
            request=request, previous_titles=previous_titles, inference=connection.inference,
            base_url=connection.base_url, model=payload.model, thinking_level=payload.thinking_level,
            web_mode=web_mode, session_key=session_key,
        )
    # lint: allow-PY001 rationale="the AI provider failed or answered without a title: the dialog shows why"
    except InferenceProviderError as exc:
        yield json.dumps({"type": "failed", "message": str(exc)}) + "\n"
        return
    yield json.dumps({"type": "title", "title": title}) + "\n"


def _openai_cost_response(snapshot: OpenAICostSnapshot) -> OpenAICostResponse:
    return OpenAICostResponse(
        estimated_cost_usd=float(snapshot.estimated_cost_usd),
        uncached_input_tokens=snapshot.uncached_input_tokens,
        cached_input_tokens=snapshot.cached_input_tokens,
        cache_write_tokens=snapshot.cache_write_tokens,
        output_tokens=snapshot.output_tokens,
    )


@router.get("/openai/cost", response_model=OpenAICostResponse)
def get_openai_cost(
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> OpenAICostResponse:
    del token
    response.headers["Cache-Control"] = "no-store"
    return _openai_cost_response(openai_cost_tracker.snapshot())


@router.post("/openai/cost/reset", response_model=OpenAICostResponse)
@transactional_route
def reset_openai_cost(
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> OpenAICostResponse:
    del token
    response.headers["Cache-Control"] = "no-store"
    openai_cost_tracker.reset()
    return _openai_cost_response(openai_cost_tracker.snapshot())


@router.post(
    "/cloud-privacy/preview",
    response_model=CloudPrivacyPreviewResponse,
)
@transactional_route
def preview_cloud_privacy(
    payload: CloudPrivacyPreviewRequest,
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> CloudPrivacyPreviewResponse:
    response.headers["Cache-Control"] = "no-store"
    missing_note_ids = [
        note_id for note_id in payload.note_ids if not note_store.has_note(note_id)
    ]
    if missing_note_ids:
        raise HTTPException(
            status_code=409,
            detail="Visible note set changed before privacy preview",
        )
    preferences = load_client_preferences(token=token)
    boundary = resolve_cloud_privacy_boundary(
        preferences=preferences,
        provider=payload.provider,
    )
    hidden_note_ids = cloud_privacy_evaluator.hidden_note_ids(
        note_ids=tuple(payload.note_ids),
        boundary=boundary,
    )
    return CloudPrivacyPreviewResponse(
        hidden_note_ids=[
            note_id for note_id in payload.note_ids if note_id in hidden_note_ids
        ]
    )


@router.get("/session", response_model=AiSessionResponse)
def get_ai_session(
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> AiSessionResponse:
    response.headers["Cache-Control"] = "no-store"
    session_key = token_service.get_session_key(token)
    snapshot = ai_chat_store.snapshot(session_key=session_key)
    messages: list[AiChatMessage] = []
    for message in snapshot["messages"]:
        activities = message["activities"]
        if not isinstance(activities, list):
            raise TypeError("AI chat message activities must be a list")
        rendered_content = ""
        rendered_thinking = ""
        if message["role"] == "assistant" and message["content"] != "":
            allowed_note_ids = find_note_citation_ids(
                message["content"],
                notes=note_store,
            )
            rendered_content = render_ai_chat_markdown_to_html(
                message["content"],
                notes=note_store,
                allowed_note_ids=allowed_note_ids,
                allowed_web_evidence=web_evidence_store.available_references_for_ids(
                    session_key=session_key,
                    evidence_ids=find_web_citation_ids(message["content"]),
                ),
            )
        if message["role"] == "assistant" and message["thinking"] != "":
            rendered_thinking = render_markdown_to_html(message["thinking"])
        messages.append(
            AiChatMessage(
                id=message["id"],
                role=message["role"],
                content=message["content"],
                rendered_content=rendered_content,
                thinking=message["thinking"],
                rendered_thinking=rendered_thinking,
                status=message["status"],
                error=message["error"],
                provider=message["provider"],
                model=message["model"],
                activities=[
                    AiChatActivity(
                        sequence=index,
                        action=activity["action"],
                        status=activity["status"],
                        label=activity["label"],
                            approx_input_tokens=activity["approx_input_tokens"],
                            output_tokens_received=activity["output_tokens_received"],
                            duration_ms=activity["duration_ms"],
                        )
                    for index, activity in enumerate(activities, start=1)
                ],
            )
        )
    return AiSessionResponse(messages=messages)


@router.delete("/session", response_model=AiClearResponse)
@transactional_route
def clear_ai_session(
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> AiClearResponse:
    response.headers["Cache-Control"] = "no-store"
    session_key = token_service.get_session_key(token)
    ai_chat_store.clear_session(session_key=session_key)
    web_evidence_store.clear_session(session_key=session_key)
    summary_batch_store.clear_session(session_key=session_key)
    agent_trace_store.clear_trace(session_key=session_key)
    return AiClearResponse(message="Chat cleared")


@router.get("/debug", response_model=AiDebugSnapshotResponse)
def get_ai_debug_snapshot(
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> AiDebugSnapshotResponse:
    response.headers["Cache-Control"] = "no-store"
    session_key = token_service.get_session_key(token)
    return AiDebugSnapshotResponse.model_validate(
        agent_trace_store.snapshot(session_key=session_key)
    )


@router.get("/history")
def get_ai_history(
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> list:
    response.headers["Cache-Control"] = "no-store"
    return agent_trace_store.export_history(
        session_key=token_service.get_session_key(token)
    )


@router.put("/debug", response_model=AiDebugSnapshotResponse)
@transactional_route
def put_ai_debug_details(
    payload: AiDebugDetailToggleRequest,
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> AiDebugSnapshotResponse:
    response.headers["Cache-Control"] = "no-store"
    session_key = token_service.get_session_key(token)
    agent_trace_store.set_exact_details_enabled(
        session_key=session_key,
        enabled=payload.enabled,
    )
    return AiDebugSnapshotResponse.model_validate(
        agent_trace_store.snapshot(session_key=session_key)
    )


@router.post("/messages/{message_id}/copy", response_model=AiCopyMessageResponse)
@transactional_route
def copy_ai_message(
    message_id: str,
    payload: AiCopyMessageRequest,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> AiCopyMessageResponse:
    if message_id.strip() == "":
        raise HTTPException(status_code=404, detail="AI response not found")
    session_key = token_service.get_session_key(token)
    snapshot = ai_chat_store.snapshot(session_key=session_key)
    matching_messages = [
        message
        for message in snapshot["messages"]
        if message["id"] == message_id and message["role"] == "assistant"
    ]
    if len(matching_messages) == 0:
        raise HTTPException(status_code=404, detail="AI response not found")
    if len(matching_messages) != 1:
        raise RuntimeError("AI chat session contains duplicate message ids")

    message = matching_messages[0]
    if message["status"] != "complete":
        raise HTTPException(status_code=409, detail="AI response is not complete")
    content = message["content"]
    if content == "":
        raise HTTPException(status_code=409, detail="AI response is empty")

    tags = "@llm"
    note_content = _render_ai_response_note_content(
        markdown_text=content,
        session_key=session_key,
    )
    clipboard_record = {
        "id": f"ai-chat:{message_id}",
        "parent_id": None,
        "prev_id": None,
        "next_id": None,
        "is_collapsed": False,
        "content": note_content,
        "tags": tags,
        "proposed_tags": "",
    }
    set_clipboard(payload.client_id, [clipboard_record])

    rendered_tree = render_note_data_read_only(
        {"content": note_content, "tags": tags, "children": []},
    )
    return AiCopyMessageResponse(
        message_id=message_id,
        html=note_data_to_html(rendered_tree),
        plain_text=content,
        tags=tags,
    )


@router.post("/chat")
@transactional_route
def stream_ai_chat(
    payload: AiChatRequest,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> StreamingResponse:
    session_key = token_service.get_session_key(token)
    connection = _require_ai_connection(provider=payload.provider, token=token, session_key=session_key)
    preferences = load_client_preferences(token=token)
    prompts = DEFAULT_AGENT_PROMPTS
    skills = DEFAULT_AGENT_SKILLS
    retrieval_settings = resolve_agent_retrieval_settings(
        preferences=preferences,
        provider=payload.provider,
    )
    web_settings = resolve_agent_web_settings(preferences=preferences)
    privacy_boundary = resolve_cloud_privacy_boundary(
        preferences=preferences,
        provider=payload.provider,
    )
    authoritative_active_tab_id = tab_state_store.get_active_tab_id()
    if payload.scope.active_tab_id != authoritative_active_tab_id:
        raise HTTPException(
            status_code=409,
            detail="Active MetaList tab changed before Send",
        )
    authoritative_search_query = tab_state_store.get_search_query(
        tab_id=payload.scope.scope_tab_id
    )
    authoritative_sort_mode = tab_state_store.get_sort_mode(
        tab_id=payload.scope.scope_tab_id
    )
    active_search_query = authoritative_search_query
    active_sort_mode = authoritative_sort_mode
    if payload.selected_note_id and payload.scope.active_tab_id != payload.scope.scope_tab_id:
        active_search_query = tab_state_store.get_search_query(tab_id=authoritative_active_tab_id)
        active_sort_mode = tab_state_store.get_sort_mode(tab_id=authoritative_active_tab_id)
    frozen_scope = scoped_search_snapshot_factory.freeze(
        descriptor=payload.scope,
        authoritative_search_query=authoritative_search_query,
        authoritative_sort_mode=authoritative_sort_mode,
        run_id=str(uuid4()),
        session_key=session_key,
        privacy_boundary=privacy_boundary,
        selected_note_id=payload.selected_note_id,
        authoritative_active_search_query=active_search_query,
        authoritative_active_sort_mode=active_sort_mode,
    )
    tagging_run = TaggingRun(token=token, snapshot=frozen_scope, preferences=preferences, sync_uuid=get_current_sync_uuid(),
        batch_tokens=resolve_tagging_batch_tokens(preferences, payload.provider))
    disclosure_changed = ai_chat_store.synchronize_disclosure_boundary(
        session_key=session_key,
        disclosure_key=cloud_privacy_evaluator.history_disclosure_key(boundary=privacy_boundary),
    )
    if disclosure_changed:
        web_evidence_store.clear_session(session_key=session_key)
        summary_batch_store.clear_session(session_key=session_key)
    turn_id = ai_chat_store.start_turn(
        session_key=session_key,
        user_content=payload.message,
        provider=payload.provider,
        model=payload.model,
    )
    provider_messages = ai_chat_store.provider_messages(session_key=session_key)
    earlier_actions = ai_chat_store.earlier_actions(session_key=session_key)
    initial_messages = agent_context_builder.build_initial_messages(
        canonical_messages=provider_messages,
        prompts=prompts,
    )
    initial_approx_input_tokens = estimate_input_tokens(initial_messages)

    turn_stream = ChatTurnStream(store=ai_chat_store, notes=note_store,
                                 web_evidence_store=web_evidence_store, session_key=session_key,
                                 turn_id=turn_id, initial_input_tokens=initial_approx_input_tokens)
    events = _stream_runtime_events(payload=payload, connection=connection,
        session_key=session_key, provider_messages=provider_messages, prompts=prompts, skills=skills,
        retrieval_settings=retrieval_settings, frozen_scope=frozen_scope, tagging_run=tagging_run,
        web_settings=web_settings, earlier_actions=earlier_actions,
        initial_input_tokens=initial_approx_input_tokens)

    return StreamingResponse(
        turn_stream.events(events),
        media_type="application/x-ndjson",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-store",
            "Content-Encoding": "identity",
        },
    )


async def _stream_runtime_events(
    *, payload: AiChatRequest, connection: AiConnection, session_key: str,
    provider_messages: list[dict[str, str]], prompts: AgentPromptSet, skills: AgentSkillSet,
    retrieval_settings: AgentRetrievalSettings, frozen_scope: ScopedSearchSnapshot,
    tagging_run: TaggingRun, initial_input_tokens: int, web_settings: AgentWebSettings,
    earlier_actions: list[dict[str, object]],
) -> AsyncIterator[dict[str, object]]:
    action, start_label = 'provider_runtime', f'Connecting to {connection.label} API'
    ready_label = connection.ready_label
    base_url = connection.base_url
    runtime = _agent_runtime(inference=connection.inference)
    yield dict(type='action_status', action=action, status='started', label=start_label,
               approx_input_tokens=initial_input_tokens, output_tokens_received=0, duration_ms=0.0)
    yield dict(type='action_status', action=action, status='completed', label=ready_label,
               approx_input_tokens=initial_input_tokens, output_tokens_received=0, duration_ms=0.0)
    events = runtime.stream_agent(session_key=session_key, base_url=base_url,
            selected_model=payload.model, thinking_level=payload.thinking_level,
            canonical_messages=provider_messages, prompts=prompts, skills=skills,
            retrieval_settings=retrieval_settings, web_settings=web_settings,
            frozen_scope=frozen_scope, tagging_run=tagging_run, earlier_actions=earlier_actions)
    try:
        async for event in events:
            yield event
    finally:
        await events.aclose()


@router.post("/menu-result")
@transactional_route
async def acknowledge_menu_result(payload: MenuResult, token: Annotated[str, Depends(require_request_auth_token)]):
    session_key = token_service.get_session_key(token)
    # lint: allow-PY001 rationale="browser acknowledgments can be stale or belong to another session"
    try:
        menu_action_store.acknowledge(session_key=session_key, result=payload)
    # lint: allow-PY001 rationale="reject invalid external menu acknowledgment with a conflict response"
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"acknowledged": True}


class BulkAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question_id: str = Field(..., min_length=1)
    value: Literal[
        "existing",
        "new",
        "proceed",
        "cancel",
        "focus_existing",
        "focus_new",
        "focus_both",
        "prefix_focus_existing",
        "prefix_focus_new",
        "prefix_focus_both",
        "summarize_all",
        "use_prefix",
        "yes",
        "no",
    ]


@router.post("/proposals/answer")
@transactional_route
async def answer_bulk_question(payload: BulkAnswerRequest, token: Annotated[str, Depends(require_request_auth_token)]):
    session_key = token_service.get_session_key(token)
    # lint: allow-PY001 rationale="validate an external structured question answer and report stale or invalid user input"
    try:
        bulk_operation_guard.answer(session_key, payload.question_id, payload.value)
    # lint: allow-PY001 rationale="invalid or stale user answers are expected request failures"
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "answered"}


class BulkManageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["accept", "remove"]
    scope: AgentScopeDescriptor
    target: Literal["current", "namespace"]
    tag_filter: str = Field(..., max_length=256)


@router.post("/proposals/manage")
@transactional_route
def manage_bulk_proposals(payload: BulkManageRequest, token: Annotated[str, Depends(require_request_auth_token)]):
    if payload.scope.active_tab_id != tab_state_store.get_active_tab_id():
        raise HTTPException(status_code=409, detail="Active tab changed")
    if payload.scope.search_query != tab_state_store.get_search_query(tab_id=payload.scope.scope_tab_id):
        raise HTTPException(status_code=409, detail="Search context changed")
    async def execute():
        with bulk_operation_guard.acquire(token_service.get_session_key(token)):
            note_ids = proposal_scope_ids(payload.scope)
            if payload.target == "namespace":
                note_ids = tuple(note_store.list_note_ids())
            changes, count, _ = prepare_proposal_changes(
                note_ids,
                payload.action,
                payload.tag_filter,
                {},
            )
            apply_bulk_proposals(changes=changes, token=token)
            yield json.dumps({"changed": bool(changes), "notes": len(changes), "proposals": count})
    return StreamingResponse(execute(), media_type="application/json")


@router.get("/proposals/settings")
def get_tagging_settings(token: Annotated[str, Depends(require_request_auth_token)]):
    preferences = load_client_preferences(token=token)
    return {"policy": preferences.get(TAGGING_POLICY_KEY, "")}
