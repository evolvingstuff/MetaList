"""Opt-in live evaluation for conversation-aware scoped routing."""

from __future__ import annotations

import asyncio
import json
import os
from types import MappingProxyType

import pytest

from app.services.agent.actions import ScopedRouteConstraints
from app.services.agent.actions import ScopedRouteEnvelope
from app.services.agent.actions import bind_scoped_route_constraints
from app.services.agent.actions import request_explicitly_requires_saved_notes
from app.services.agent.context import AgentContextBuilder
from app.services.agent.ollama_inference import OllamaInferenceAdapter
from app.services.agent.prompt_settings import DEFAULT_AGENT_PROMPTS
from app.services.agent.scope import AgentScopeDescriptor
from app.services.agent.scope import FrozenScopedNote
from app.services.agent.scope import FrozenScopedTreeNode
from app.services.agent.scope import ScopedSearchSnapshot
from app.services.managed_ollama_runtime import managed_ollama_runtime
from app.services.ollama_provider import OllamaProvider


pytestmark = pytest.mark.live_ollama

_MODEL_ENVIRONMENT_KEY = "METALIST_LIVE_OLLAMA_MODEL"
_NOTE_ID = "11111111-1111-4111-8111-111111111111"


def _snapshot() -> ScopedSearchSnapshot:
    descriptor = AgentScopeDescriptor(
        scope_kind="search",
        active_tab_id="live-continuation-tab",
        scope_tab_id="live-continuation-tab",
        search_query="arXiv",
        sort_mode="normal",
        date_filter_active=False,
        date_filter_metric="",
        date_filter_start="",
        date_filter_end="",
        reference_root_ids=[],
        label="arXiv",
    )
    note = FrozenScopedNote(
        note_id=_NOTE_ID,
        parent_id="",
        root_note_id=_NOTE_ID,
        content_text="Synthetic non-neural paper evidence.",
        explicit_tags_text="arXiv",
        explicit_tag_terms=("arXiv",),
        created_at="2026-08-31T00:00:00+00:00",
        updated_at="2026-08-31T00:00:00+00:00",
        order_index=0,
    )
    tree_node = FrozenScopedTreeNode(
        note_id=_NOTE_ID,
        parent_id="",
        root_note_id=_NOTE_ID,
        child_ids=(),
    )
    return ScopedSearchSnapshot(
        run_id="live-continuation-run",
        session_key="live-continuation-session",
        descriptor=descriptor,
        created_at="2026-08-31T00:00:00+00:00",
        ordered_root_ids=(_NOTE_ID,),
        ordered_note_ids=(_NOTE_ID,),
        notes_by_id=MappingProxyType({_NOTE_ID: note}),
        tree_nodes_by_id=MappingProxyType({_NOTE_ID: tree_node}),
    )


async def _infer_changed_scope_retry_route(
    *,
    adapter: OllamaInferenceAdapter,
    base_url: str,
    model: str,
) -> ScopedRouteEnvelope:
    current_user_request = "oops, I changed context. try again"
    canonical_messages = [
        {
            "role": "user",
            "content": "please summarize the non-neural papers",
        },
        {
            "role": "assistant",
            "content": (
                "I don't have any saved notes in the current scope, so I can't "
                "summarize the non-neural papers."
            ),
        },
        {"role": "user", "content": current_user_request},
    ]
    messages = AgentContextBuilder().build_scoped_route_messages(
        canonical_messages=canonical_messages,
        prompts=DEFAULT_AGENT_PROMPTS,
        snapshot=_snapshot(),
    )
    constraints = ScopedRouteConstraints(
        explicit_saved_notes_request=request_explicitly_requires_saved_notes(
            current_user_request
        )
    )
    with bind_scoped_route_constraints(constraints):
        response = await adapter.infer_structured(
            base_url=base_url,
            model=model,
            thinking_level="off",
            messages=messages,
            response_model=ScopedRouteEnvelope,
            on_progress=lambda _progress: None,
        )
        return ScopedRouteEnvelope.model_validate_json(response.content)


def test_live_model_retries_unresolved_note_request_against_changed_scope() -> None:
    model = os.environ[_MODEL_ENVIRONMENT_KEY].strip()
    if model == "":
        raise ValueError(f"{_MODEL_ENVIRONMENT_KEY} must not be blank")
    runtime = managed_ollama_runtime.ensure_running()
    adapter = OllamaInferenceAdapter(provider=OllamaProvider(transport=None))
    route = asyncio.run(
        _infer_changed_scope_retry_route(
            adapter=adapter,
            base_url=runtime.base_url,
            model=model,
        )
    )
    print(json.dumps({"model": model, "route": route.model_dump()}, sort_keys=True))
    assert route.kind == "investigate_current_scope"
