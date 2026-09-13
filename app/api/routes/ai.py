"""Authenticated AI provider and session-chat endpoints."""

from __future__ import annotations

import asyncio
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
from app.services.ai_chat import ai_chat_store
from app.services.ai_chat_rendering import find_note_citation_ids
from app.services.ai_chat_rendering import render_ai_chat_markdown_to_html
from app.services.agent.context import AgentContextBuilder
from app.services.agent.cloud_privacy import cloud_privacy_evaluator
from app.services.agent.cloud_privacy import resolve_cloud_privacy_boundary
from app.services.agent.inference import InferenceAdapter
from app.services.agent.model_policy import SingleModelPolicy
from app.services.agent.ollama_inference import OllamaInferenceAdapter
from app.services.agent.openai_inference import OPENAI_API_BASE_URL
from app.services.agent.openai_inference import OPENAI_MODELS
from app.services.agent.openai_inference import OpenAIInferenceAdapter
from app.services.agent.openai_inference import validate_openai_model
from app.services.agent.openai_cost_tracking import OpenAICostSnapshot
from app.services.agent.openai_cost_tracking import openai_cost_tracker
from app.services.agent.permissions import AgentPermissionPolicy
from app.services.agent.prompt_settings import AgentPromptSet
from app.services.agent.skill_settings import AgentSkillSet
from app.services.agent.retrieval_settings import AgentRetrievalSettings
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.agent.prompt_settings import DEFAULT_AGENT_PROMPTS
from app.services.agent.prompt_settings import resolve_agent_prompt_set
from app.services.agent.retrieval_settings import resolve_agent_retrieval_settings
from app.services.agent.scope import AgentScopeDescriptor
from app.services.agent.scope import scoped_search_snapshot_factory
from app.services.agent.runtime import AgentRuntime
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.agent.skill_settings import resolve_agent_skill_set
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.agent.tools import read_only_agent_tools
from app.services.agent.trace import agent_trace_store
from app.services.client_state_service import load_client_preferences
from app.services.markdown_rendering import render_markdown_to_html
from app.services.managed_ollama_runtime import ManagedOllamaRuntimeError
from app.services.managed_ollama_runtime import managed_ollama_runtime
from app.services.note_store import store as note_store
from app.services.ollama_provider import OllamaProviderError
from app.services.ollama_provider import ollama_provider
from app.services.ollama_provider import resolve_ollama_think_value
from app.services.ollama_provider import validate_ollama_model
from app.services.openai_credentials import OpenAICredentialInputError
from app.services.openai_credentials import openai_credential_store
from app.services.openai_credentials import validate_openai_api_key
from app.services.sync import set_clipboard, get_current_sync_uuid
from app.services.agent.tagging_run import TaggingRun, proposal_scope_ids
from app.services.agent.retrieval_settings import resolve_tagging_batch_tokens
from app.services.agent.tagging import TAGGING_PROMPT_KEY, TAGGING_POLICY_KEY, DEFAULT_TAGGING_PROMPT
from app.usecases.bulk_tag_proposals import apply_bulk_proposals, prepare_proposal_changes
from app.services.bulk_operation import bulk_operation_guard
from app.services.tab_state import tab_state_store
from app.services.tokens import token_service


router = APIRouter(prefix="/ai", tags=["ai"])

agent_context_builder = AgentContextBuilder()


def _agent_runtime(*, inference: InferenceAdapter) -> AgentRuntime:
    return AgentRuntime(
        context_builder=agent_context_builder,
        inference=inference,
        model_policy=SingleModelPolicy(),
        permission_policy=AgentPermissionPolicy(),
        tool_registry=read_only_agent_tools,
        trace_store=agent_trace_store,
        provider_label=inference.provider_label,
    )


agent_runtime = _agent_runtime(
    inference=OllamaInferenceAdapter(provider=ollama_provider)
)




class AiModelsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["ollama", "openai"]


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

    provider: Literal["ollama", "openai"]
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


class AiSkillDefaultResponse(BaseModel):
    skill_id: str
    title: str
    description: str
    trigger_action: str
    preference_key: str
    content: str
    superseded_preference_keys: list[str]


class AiPromptDefaultsResponse(BaseModel):
    system_prompt: str
    final_response_prompt: str
    tool_result_prompt: str
    skills: list[AiSkillDefaultResponse]


class AiModelPullRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["ollama"]
    model: str

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        return validate_ollama_model(value)


class AiChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["ollama", "openai"]
    model: str
    thinking_level: Literal["off", "low", "medium", "high"]
    show_diagnostics: bool
    message: str = Field(..., max_length=32_000)
    scope: AgentScopeDescriptor

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
        if self.provider == "ollama":
            validate_ollama_model(self.model)
            resolve_ollama_think_value(
                model=self.model,
                thinking_level=self.thinking_level,
            )
        else:
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
    provider: Literal["ollama", "openai"]
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


def _render_ai_response_note_content(markdown_text: str) -> str:
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
    del token
    if payload.provider == "openai":
        return AiModelsResponse(models=list(OPENAI_MODELS))
    try:
        runtime_info = await asyncio.to_thread(managed_ollama_runtime.ensure_running)
        models = await ollama_provider.list_models(base_url=runtime_info.base_url)
    except (ManagedOllamaRuntimeError, OllamaProviderError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return AiModelsResponse(models=models)


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
    # lint: allow-PY001 rationale="validate user-supplied secret after Pydantic has masked it"
    try:
        api_key = validate_openai_api_key(payload.api_key.get_secret_value())
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


@router.get("/prompts/defaults", response_model=AiPromptDefaultsResponse)
def get_ai_prompt_defaults(
    response: Response,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> AiPromptDefaultsResponse:
    del token
    response.headers["Cache-Control"] = "no-store"
    return AiPromptDefaultsResponse(
        system_prompt=DEFAULT_AGENT_PROMPTS.system_prompt,
        final_response_prompt=DEFAULT_AGENT_PROMPTS.final_response_prompt,
        tool_result_prompt=DEFAULT_AGENT_PROMPTS.tool_result_prompt,
        skills=[
            AiSkillDefaultResponse(
                skill_id=skill.skill_id,
                title=skill.title,
                description=skill.description,
                trigger_action=skill.trigger_action,
                preference_key=skill.preference_key,
                content=skill.content,
                superseded_preference_keys=list(skill.superseded_preference_keys),
            )
            for skill in DEFAULT_AGENT_SKILLS.skills
        ],
    )


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


@router.post("/models/pull")
@transactional_route
def pull_ai_model(
    payload: AiModelPullRequest,
    token: Annotated[str, Depends(require_request_auth_token)],
) -> StreamingResponse:
    del token

    async def stream_events() -> AsyncIterator[str]:
        try:
            runtime_info = await asyncio.to_thread(managed_ollama_runtime.ensure_running)
            async for event in ollama_provider.stream_pull(
                base_url=runtime_info.base_url,
                model=payload.model,
            ):
                yield f"{json.dumps(event, separators=(',', ':'))}\n"
        # lint: allow-PY001 rationale="pull errors must be delivered after response headers are sent"
        except (ManagedOllamaRuntimeError, OllamaProviderError) as exc:
            error_event = {"type": "error", "message": str(exc)}
            yield f"{json.dumps(error_event, separators=(',', ':'))}\n"

    return StreamingResponse(
        stream_events(),
        media_type="application/x-ndjson",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-store",
            "Content-Encoding": "identity",
        },
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
    note_content = _render_ai_response_note_content(content)
    clipboard_record = {
        "id": f"ai-chat:{message_id}",
        "parent_id": None,
        "prev_id": None,
        "next_id": None,
        "is_collapsed": False,
        "content": note_content,
        "tags": tags,
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
    openai_api_key = ""
    if payload.provider == "openai":
        credential_status = openai_credential_store.status(
            token=token,
            session_key=session_key,
        )
        if not credential_status.configured:
            raise HTTPException(
                status_code=409,
                detail="OpenAI API key is not configured",
            )
        openai_api_key = openai_credential_store.resolve(
            token=token,
            session_key=session_key,
        )
    preferences = load_client_preferences(token=token)
    prompts = resolve_agent_prompt_set(preferences=preferences)
    skills = resolve_agent_skill_set(preferences=preferences)
    retrieval_settings = resolve_agent_retrieval_settings(
        preferences=preferences,
        provider=payload.provider,
    )
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
    frozen_scope = scoped_search_snapshot_factory.freeze(
        descriptor=payload.scope,
        authoritative_search_query=authoritative_search_query,
        authoritative_sort_mode=authoritative_sort_mode,
        run_id=str(uuid4()),
        session_key=session_key,
        privacy_boundary=privacy_boundary,
    )
    tagging_run = TaggingRun(token=token, snapshot=frozen_scope, preferences=preferences, sync_uuid=get_current_sync_uuid(),
        batch_tokens=resolve_tagging_batch_tokens(preferences, payload.provider))
    ai_chat_store.synchronize_disclosure_boundary(
        session_key=session_key,
        disclosure_key=cloud_privacy_evaluator.history_disclosure_key(boundary=privacy_boundary),
    )
    turn_id = ai_chat_store.start_turn(
        session_key=session_key,
        user_content=payload.message,
        provider=payload.provider,
        model=payload.model,
    )
    provider_messages = ai_chat_store.provider_messages(session_key=session_key)
    initial_messages = agent_context_builder.build_initial_messages(
        canonical_messages=provider_messages,
        prompts=prompts,
    )
    initial_approx_input_tokens = estimate_input_tokens(initial_messages)

    turn_stream = ChatTurnStream(store=ai_chat_store, notes=note_store, session_key=session_key,
                                 turn_id=turn_id, initial_input_tokens=initial_approx_input_tokens)
    events = _stream_runtime_events(payload=payload, openai_api_key=openai_api_key,
        session_key=session_key, provider_messages=provider_messages, prompts=prompts, skills=skills,
        retrieval_settings=retrieval_settings, frozen_scope=frozen_scope, tagging_run=tagging_run,
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
    *, payload: AiChatRequest, openai_api_key: str, session_key: str,
    provider_messages: list[dict[str, str]], prompts: AgentPromptSet, skills: AgentSkillSet,
    retrieval_settings: AgentRetrievalSettings, frozen_scope: ScopedSearchSnapshot,
    tagging_run: TaggingRun, initial_input_tokens: int,
) -> AsyncIterator[dict[str, object]]:
    action, start_label = 'provider_runtime', 'Connecting to OpenAI API'
    ready_label = 'OpenAI API ready · 1,050,000-token context'
    base_url = OPENAI_API_BASE_URL
    if payload.provider == 'ollama':
        action = 'ollama_runtime'
        start_label = 'Starting MetaList-managed Ollama · 32,768-token context'
        runtime = agent_runtime
    else:
        runtime = _agent_runtime(inference=OpenAIInferenceAdapter(api_key=openai_api_key, cost_tracker=openai_cost_tracker))
    yield dict(type='action_status', action=action, status='started', label=start_label,
               approx_input_tokens=initial_input_tokens, output_tokens_received=0, duration_ms=0.0)
    if payload.provider == 'ollama':
        runtime_info = await asyncio.to_thread(managed_ollama_runtime.ensure_running)
        base_url = runtime_info.base_url
        ready_label = f'MetaList-managed Ollama ready · {runtime_info.context_tokens:,}-token context'
    yield dict(type='action_status', action=action, status='completed', label=ready_label,
               approx_input_tokens=initial_input_tokens, output_tokens_received=0, duration_ms=0.0)
    events = runtime.stream_scoped(session_key=session_key, base_url=base_url,
            selected_model=payload.model, thinking_level=payload.thinking_level,
            canonical_messages=provider_messages, prompts=prompts, skills=skills,
            retrieval_settings=retrieval_settings, frozen_scope=frozen_scope, tag_handler=tagging_run.stream)
    try:
        async for event in events:
            yield event
    finally:
        await events.aclose()


class BulkAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question_id: str = Field(..., min_length=1)
    value: Literal["existing", "new", "proceed", "cancel", "focus_existing", "focus_new", "focus_both"]


@router.post("/proposals/answer")
@transactional_route
async def answer_bulk_question(payload: BulkAnswerRequest, token: Annotated[str, Depends(require_request_auth_token)]):
    # lint: allow-PY001 rationale="validate an external structured question answer and report stale or invalid user input"
    try:
        bulk_operation_guard.answer(token_service.get_session_key(token), payload.question_id, payload.value)
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
    return {"policy": preferences.get(TAGGING_POLICY_KEY, ""),
            "prompt": preferences.get(TAGGING_PROMPT_KEY, DEFAULT_TAGGING_PROMPT),
            "default_prompt": DEFAULT_TAGGING_PROMPT}
