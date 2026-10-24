"""Suggest with AI in the Export and Print dialog (docs/ui/controls.md): what the AI
may read of an export or print, the request, the answer, and the routes."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import HTTPException, Response

import app.api.routes.ai as ai_routes
import app.services.agent.openai_inference as openai_inference_module
import app.services.ai_setup as ai_setup_module
from app.models.database import SafeSession
from app.security.encryption import clear_encryption_key, set_encryption_required
from app.services import auth_service
from app.services.agent.cloud_privacy import CloudPrivacyBoundary
from app.services.agent.cloud_privacy import CloudPrivacyPolicy
from app.services.agent.inference import InferenceAttempt
from app.services.agent.inference import InferenceProviderError
from app.services.agent.inference import InferenceResponse
from app.services.agent.inference import StructuredInferenceError
from app.services.agent.export_title_suggestions import EXPORT_TITLE_INPUT_TOKENS
from app.services.agent.export_title_suggestions import ExportTitleAnswer
from app.services.agent.export_title_suggestions import build_export_title_request
from app.services.agent.export_title_suggestions import export_title_messages
from app.services.agent.export_title_suggestions import suggest_export_title
from app.services.agent.strict_structured_outputs import strict_openai_schema
from app.services.agent.structured_inference import _structured_max_output_tokens
from app.services.agent.token_estimation import estimate_input_tokens
from app.services.agent.trace import agent_trace_store
from app.services.content_cache import clear_cache
from app.services.file_registry import file_registry
from app.services.input_errors import InputRejected
from app.services.note_store import store
from app.services.ontology_rules_store import bootstrap_ontology_rules_store
from app.services.openai_credentials import OpenAICredentialStatus
from app.usecases.create_note import apply_insert_note


@pytest.fixture
def live_database(tmp_path, monkeypatch):
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "fixture.metalist.db")
    monkeypatch.setattr(SafeSession, "_use_memory", False)
    clear_encryption_key()
    set_encryption_required(False)
    clear_cache()
    store.reset()
    file_registry.reset()
    session = SafeSession()
    auth_service.AuthService(session).initialize_settings()
    bootstrap_ontology_rules_store(connection=session.connection())
    store.load_from_db(None, prefetched_rows=[])
    yield session
    session.close()
    store.reset()
    clear_cache()
    file_registry.reset()
    clear_encryption_key()
    set_encryption_required(False)


def _note(note_id: str, parent_id: str | None, previous_id: str | None, *, content: str, tags: str) -> None:
    apply_insert_note(note_id, parent_id, previous_id, None, "", content=content, tags=tags, proposed_tags="")


def _boundary(*blacklist_tags: str) -> CloudPrivacyBoundary:
    return CloudPrivacyBoundary(provider="openai", apply_cloud_policy=True, policy=CloudPrivacyPolicy(
        whitelist_tags=(), whitelist_phrases=(), blacklist_tags=blacklist_tags, blacklist_phrases=(),
    ))


def _policy(*blacklist_tags: str) -> dict[str, str]:
    return {"pref.ai.cloud_privacy_policy": json.dumps(
        {"blacklist_phrases": [], "blacklist_tags": list(blacklist_tags), "whitelist_phrases": [], "whitelist_tags": []},
        separators=(",", ":"), sort_keys=True,
    )}


def _trip() -> None:
    _note("trip", None, None, content="<div>Kyoto trip</div>", tags="travel")
    _note("day", "trip", None, content="<div>Temples ![[11111111-1111-1111-1111-111111111111]] and tea</div>", tags="")
    _note("wifi", "trip", "day", content="<div>hunter22</div>", tags="@password")
    _note("router", "wifi", None, content="<div>Router in the hall</div>", tags="")
    _note("diary", "trip", "wifi", content="<div>Dear diary</div>", tags="private")
    _note("entry", "diary", None, content="<div>Felt tired</div>", tags="")


def test_the_ai_reads_the_print_in_order_without_hidden_notes_passwords_or_references(live_database) -> None:
    _trip()
    request = build_export_title_request(root_ids=["trip"], allowed_note_ids=None, boundary=_boundary("private"))
    assert request.notes == (
        {"depth": 0, "content_text": "Kyoto trip", "tags": ["travel"]},
        {"depth": 1, "content_text": "Temples and tea", "tags": []},
    )
    # A password, or a hidden note, goes with everything under it.
    assert all(word not in json.dumps(request.notes).lower() for word in ("hunter22", "router", "diary", "tired"))
    assert request.availability == "partial"

    everything = build_export_title_request(root_ids=["day"], allowed_note_ids=None, boundary=_boundary())
    assert everything.availability == "ready"
    hidden = build_export_title_request(root_ids=["diary"], allowed_note_ids=None, boundary=_boundary("private"))
    assert (hidden.notes, hidden.availability) == ((), "private"), "no request is ever sent"
    assert build_export_title_request(root_ids=["wifi"], allowed_note_ids={"wifi"}, boundary=_boundary()).availability == "private"
    _note("blank", None, "trip", content="<div>![[11111111-1111-1111-1111-111111111111]]</div>", tags="")
    assert build_export_title_request(root_ids=["blank"], allowed_note_ids=None, boundary=_boundary()).availability == "nothing"


def test_a_view_print_sends_only_the_notes_the_view_shows_from_the_top(live_database) -> None:
    _trip()
    request = build_export_title_request(root_ids=["trip"], allowed_note_ids={"trip", "wifi"}, boundary=_boundary())
    assert [note["content_text"] for note in request.notes] == ["Kyoto trip"], "notes the search leaves out are not printed"
    assert request.availability == "partial"

    previous = None
    for index in range(400):
        _note(f"n{index}", None, previous, content=f"<div>Line {index} about the garden and its plants</div>", tags="")
        previous = f"n{index}"
    long = build_export_title_request(root_ids=[f"n{index}" for index in range(400)], allowed_note_ids=None, boundary=_boundary())
    assert long.notes[0]["content_text"] == "Line 0 about the garden and its plants", "from the top"
    assert 0 < len(long.notes) < 400 and estimate_input_tokens(list(long.notes)) <= EXPORT_TITLE_INPUT_TOKENS
    assert long.availability == "ready", "what does not fit is not private"

    _note("essay", None, previous, content=f"<div>{'word ' * 5000}</div>", tags="")
    essay = build_export_title_request(root_ids=["essay"], allowed_note_ids=None, boundary=_boundary())
    assert len(essay.notes[0]["content_text"]) == 2000, "a long note is cut, not sent whole"


def test_asking_again_names_the_titles_already_given(live_database) -> None:
    _trip()
    request = build_export_title_request(root_ids=["trip"], allowed_note_ids=None, boundary=_boundary())
    first = export_title_messages(request, ())
    assert [message["role"] for message in first] == ["system", "user"]
    assert "titles_already_suggested" not in first[-1]["content"]
    again = export_title_messages(request, ("Kyoto in Spring",))
    assert "differs from every title" in again[1]["content"]
    assert json.loads(again[-1]["content"])["titles_already_suggested"] == ["Kyoto in Spring"]
    assert "search" not in again[-1]["content"], "the search is never sent"


class _Answers:
    def __init__(self, title: str) -> None:
        self.title = title
        self.requests: list[list[dict[str, str]]] = []

    async def infer_structured(self, *, base_url, model, thinking_level, messages, response_model, on_progress):
        self.requests.append(messages)
        attempt = InferenceAttempt(request={}, response={}, error="", duration_ms=1.0, validation_errors=())
        return InferenceResponse(content=json.dumps({"title": self.title}), thinking="", usage={}, attempts=[attempt])


class _Rejected(_Answers):
    async def infer_structured(self, *, base_url, model, thinking_level, messages, response_model, on_progress):
        attempt = InferenceAttempt(request={}, response={}, error="cut off", duration_ms=1.0, validation_errors=())
        raise StructuredInferenceError(attempts=[attempt])


def _suggest(request, inference) -> str:
    run_id = agent_trace_store.start_run(session_key="session", model="gpt-5.6-luna", user_message="Suggest a title")
    # lint: allow-PY001 rationale="the session's trace is cleared whether the title came or the AI failed"
    try:
        return asyncio.run(suggest_export_title(
            request=request, previous_titles=(), inference=inference, base_url="https://api.example",
            model="gpt-5.6-luna", thinking_level="low", web_mode="none", session_key="session", run_id=run_id,
        ))
    finally:
        agent_trace_store.clear_session(session_key="session")


def test_the_answer_is_one_short_line(live_database) -> None:
    _trip()
    request = build_export_title_request(root_ids=["trip"], allowed_note_ids=None, boundary=_boundary())
    assert _suggest(request, _Answers('  "Spring in\nKyoto."  ')) == "Spring in Kyoto"
    long = _suggest(request, _Answers("A very long title " * 10))
    assert len(long) <= 80 and not long.endswith(" ") and long.startswith("A very long title")
    with pytest.raises(InferenceProviderError, match="without a title"):
        _suggest(request, _Answers(' "" '))
    with pytest.raises(InferenceProviderError, match="suggesting a title"):
        _suggest(request, _Rejected(""))


def _set_ai_ready(monkeypatch, *, is_ready: bool) -> None:
    monkeypatch.setattr(ai_setup_module.openai_credential_store, "status",
                        lambda **kwargs: OpenAICredentialStatus(configured=is_ready, persistent=False))
    monkeypatch.setattr(ai_setup_module.openai_credential_store, "resolve",
                        lambda **kwargs: "sk-test-0123456789abcdefghijklmnop")


def _scope(exported: str, note_id: str) -> dict[str, object]:
    return {"provider": "openai", "search": "", "tab_id": "tab-1", "is_untagged_view": False,
            "exported": exported, "note_id": note_id}


def _availability(exported: str, note_id: str) -> str:
    return ai_routes.export_title_availability(
        payload=ai_routes.ExportTitleScope(**_scope(exported, note_id)), response=Response(), token="token",
    ).availability


def _title_lines(note_id: str) -> list[dict[str, object]]:
    response = ai_routes.suggest_export_title_with_ai(
        payload=ai_routes.ExportTitleSuggestionRequest(
            **_scope("note", note_id), model="gpt-5.6-luna", thinking_level="low", previous_titles=[],
        ),
        token="token",
    )

    async def read() -> list[dict[str, object]]:
        return [json.loads(line) async for line in response.body_iterator]

    return asyncio.run(read())


def test_the_routes_say_whether_the_ai_can_ask_and_stream_its_title(live_database, monkeypatch) -> None:
    _trip()
    monkeypatch.setattr(ai_routes.token_service, "get_session_key", lambda token: "session")
    monkeypatch.setattr(ai_routes, "load_client_preferences", lambda *, token: _policy("private"))
    monkeypatch.setattr(ai_routes.tab_state_store, "get_sort_mode", lambda *, tab_id: "normal")
    monkeypatch.setattr(ai_routes.tab_state_store, "get_date_filter", lambda *, tab_id: None)
    monkeypatch.setattr(ai_routes.tab_state_store, "get_file_filter", lambda *, tab_id: None)

    _set_ai_ready(monkeypatch, is_ready=False)
    assert _availability("note", "trip") == "unavailable"
    with pytest.raises(HTTPException, match="The AI is not set up"):
        _title_lines("trip")

    _set_ai_ready(monkeypatch, is_ready=True)
    assert [_availability("note", "trip"), _availability("note", "diary"), _availability("note", "day")] == [
        "partial", "private", "ready",
    ]
    assert _availability("view", "") == "partial"
    answers = _Answers("Kyoto in Spring")
    monkeypatch.setattr(openai_inference_module, "OpenAIInferenceAdapter", lambda **kwargs: answers)
    assert _title_lines("trip") == [{"type": "title", "title": "Kyoto in Spring"}]
    assert "Dear diary" not in json.dumps(answers.requests) and "hunter22" not in json.dumps(answers.requests)
    with pytest.raises(InputRejected, match="private"):
        _title_lines("diary")

    class _Failing(_Answers):
        async def infer_structured(self, **kwargs):
            raise InferenceProviderError("OpenAI API request failed: connection reset")

    monkeypatch.setattr(openai_inference_module, "OpenAIInferenceAdapter", lambda **kwargs: _Failing(""))
    assert _title_lines("trip") == [{"type": "failed", "message": "OpenAI API request failed: connection reset"}]


def test_a_title_after_a_chat_in_the_session_is_traced_as_its_own_run(live_database, monkeypatch) -> None:
    """Reported 2026-10-18: once the session had a chat answer in its trace, Suggest
    title failed with a server error: it recorded its attempts under a run id it never
    started, which the trace store refuses."""
    _trip()
    monkeypatch.setattr(ai_routes.token_service, "get_session_key", lambda token: "session")
    monkeypatch.setattr(ai_routes, "load_client_preferences", lambda *, token: _policy("private"))
    monkeypatch.setattr(ai_routes.tab_state_store, "get_sort_mode", lambda *, tab_id: "normal")
    monkeypatch.setattr(ai_routes.tab_state_store, "get_date_filter", lambda *, tab_id: None)
    monkeypatch.setattr(ai_routes.tab_state_store, "get_file_filter", lambda *, tab_id: None)
    _set_ai_ready(monkeypatch, is_ready=True)
    monkeypatch.setattr(openai_inference_module, "OpenAIInferenceAdapter", lambda **kwargs: _Answers("Kyoto in Spring"))
    agent_trace_store.clear_session(session_key="session")
    chat_run = agent_trace_store.start_run(session_key="session", model="gpt-5.6-luna", user_message="Hello")
    agent_trace_store.complete_run(session_key="session", run_id=chat_run)

    assert _title_lines("trip") == [{"type": "title", "title": "Kyoto in Spring"}]
    title_run = agent_trace_store.snapshot(session_key="session")["run"]
    agent_trace_store.clear_session(session_key="session")
    assert title_run["run_id"] != chat_run and title_run["status"] == "complete"
    assert [event["type"] for event in title_run["events"]] == ["EXPORT_TITLE_INFERENCE"]


def test_a_print_names_its_note_or_none() -> None:
    with pytest.raises(ValueError, match="names the note"):
        ai_routes.ExportTitleScope(**_scope("note", ""))
    with pytest.raises(ValueError, match="names the note"):
        ai_routes.ExportTitleScope(**_scope("view", "trip"))


def test_the_real_openai_adapter_accepts_the_answer_format() -> None:
    # The stand-ins above skip what the real adapter checks first: an output
    # limit for the answer, and a schema OpenAI strict mode accepts.
    assert _structured_max_output_tokens(ExportTitleAnswer) == 8_192
    schema = strict_openai_schema(ExportTitleAnswer.model_json_schema())
    assert (schema["required"], schema["additionalProperties"]) == (["title"], False)
    assert "maxLength" not in json.dumps(schema), "checked locally, not sent"
