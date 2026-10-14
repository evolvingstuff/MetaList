"""Suggest Tags with AI for one note: the AI setup layer, the privacy check on the
note as edited, the ranked vocabulary, the request, validation, and adding the
proposals (docs/ui/tag-bar.md, "Suggest Tags with AI")."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import HTTPException, Response

import app.api.routes.ai as ai_routes
import app.services.ai_setup as ai_setup_module
import app.usecases.tag_proposals as proposal_module
from app.models.database import SafeSession
from app.security.encryption import clear_encryption_key, set_encryption_required
from app.services import auth_service
from app.services.agent.cloud_privacy import CloudPrivacyBoundary
from app.services.agent.cloud_privacy import CloudPrivacyPolicy
from app.services.agent.cloud_privacy import cloud_privacy_evaluator
from app.services.agent.inference import InferenceAttempt
from app.services.agent.inference import InferenceContextWindow
from app.services.agent.inference import InferenceProviderError
from app.services.agent.inference import InferenceResponse
from app.services.agent.note_tag_suggestions import MAX_NEW_TAGS
from app.services.agent.note_tag_suggestions import build_note_tag_request
from app.services.agent.note_tag_suggestions import ranked_vocabulary
from app.services.agent.note_tag_suggestions import suggest_note_tags
from app.services.agent.skill_settings import DEFAULT_AGENT_SKILLS
from app.services.agent.tagging_run import tag_batch_messages
from app.services.agent.web_settings import AgentWebSettings
from app.services.content_cache import clear_cache
from app.services.file_registry import file_registry
from app.services.input_errors import InputRejected
from app.services.note_store import store
from app.services.ontology_rules_store import bootstrap_ontology_rules_store
from app.services.openai_credentials import OpenAICredentialStatus
from app.services.tag_suggestions import suggest_tags_with_reasons_for_note
from app.usecases.create_note import apply_insert_note
from app.usecases.delete_subtree import apply_delete_subtree
from app.utils.text_utils import strip_html


TAG_SKILL = DEFAULT_AGENT_SKILLS.for_action("tag_proposals")
VIEWPORT = {"scrollY": 0, "scrollAnchor": None}


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


def _note(note_id: str, parent_id: str | None, *, content: str, tags: str) -> None:
    apply_insert_note(note_id, parent_id, None, None, "", content=content, tags=tags, proposed_tags="")


def _boundary(*, blacklist_tags: tuple[str, ...], whitelist_tags: tuple[str, ...]) -> CloudPrivacyBoundary:
    return CloudPrivacyBoundary(provider="openai", apply_cloud_policy=True, policy=CloudPrivacyPolicy(
        whitelist_tags=whitelist_tags, whitelist_phrases=(), blacklist_tags=blacklist_tags,
        blacklist_phrases=("secret plan",),
    ))


def _draft_reason(note_id: str, *, tags: str, content: str, boundary: CloudPrivacyBoundary) -> str:
    return cloud_privacy_evaluator.draft_exclusion_reason(
        note_id=note_id,
        draft_effective_tags=store.draft_effective_tag_terms(note_id=note_id, tags=tags, plaintext=strip_html(content)),
        draft_content_html=content, boundary=boundary,
    )


def _set_ai_ready(monkeypatch, *, is_ready: bool) -> None:
    monkeypatch.setattr(ai_setup_module.openai_credential_store, "status",
                        lambda **kwargs: OpenAICredentialStatus(configured=is_ready, persistent=False))
    monkeypatch.setattr(ai_setup_module.openai_credential_store, "resolve",
                        lambda **kwargs: "sk-test-0123456789abcdefghijklmnop")


class _FakeInference:
    """Answers each structured request with the next reply, recording the messages."""

    def __init__(self, replies: list[dict[str, object]]) -> None:
        self.replies = list(replies)
        self.requests: list[list[dict[str, str]]] = []

    async def inspect_context_window(self, *, base_url: str, model: str) -> InferenceContextWindow:
        return InferenceContextWindow(model=model, maximum_tokens=400_000, loaded_tokens=400_000, required_tokens=1)

    async def infer_structured(self, *, base_url, model, thinking_level, messages, response_model, on_progress):
        self.requests.append(messages)
        content = json.dumps(self.replies.pop(0))
        attempt = InferenceAttempt(request={}, response={}, error="", duration_ms=1.0, validation_errors=())
        return InferenceResponse(content=content, thinking="", usage={}, attempts=[attempt])


class _FailingInference(_FakeInference):
    async def infer_structured(self, *, base_url, model, thinking_level, messages, response_model, on_progress):
        raise InferenceProviderError("OpenAI API request failed: connection reset")


def _suggest(request, inference) -> tuple[str, ...]:
    return asyncio.run(suggest_note_tags(
        request=request, inference=inference, base_url="https://api.openai.com/v1", model="gpt-5.6-luna",
        thinking_level="low", web_settings=AgentWebSettings(mode="none"), session_key="session",
    ))


# The AI setup layer: features ask whether an AI is set up, never for a provider's key.

def test_ai_setup_reports_ready_providers_and_refuses_a_connection_without_one(monkeypatch) -> None:
    _set_ai_ready(monkeypatch, is_ready=False)
    setup = ai_setup_module.describe_ai_setup(token="token", session_key="session")
    assert setup.is_ready is False
    assert setup.is_ready_for("openai") is False
    with pytest.raises(ai_setup_module.AiNotSetUp):
        ai_setup_module.connect_to_ai(provider="openai", token="token", session_key="session")

    _set_ai_ready(monkeypatch, is_ready=True)
    setup = ai_setup_module.describe_ai_setup(token="token", session_key="session")
    assert setup.ready_providers == ("openai",)
    connection = ai_setup_module.connect_to_ai(provider="openai", token="token", session_key="session")
    assert (connection.provider, connection.label, connection.base_url) == ("openai", "OpenAI", "https://api.openai.com/v1")


# Privacy, judged on the note as it is being edited.

def test_draft_privacy_follows_unsaved_tags_and_text_and_saved_ancestors(live_database) -> None:
    _note("parent", None, content="<div>Trips</div>", tags="travel")
    _note("trip", "parent", content="<div>Kyoto in April</div>", tags="kyoto")
    boundary = _boundary(blacklist_tags=("private",), whitelist_tags=())

    assert _draft_reason("trip", tags="kyoto", content="<div>Kyoto in April</div>", boundary=boundary) == ""
    assert _draft_reason("trip", tags="kyoto Private", content="<div>Kyoto</div>", boundary=boundary) == "blacklisted"
    assert _draft_reason("trip", tags="kyoto", content="<div>The secret plan</div>", boundary=boundary) == "blacklisted"
    assert _draft_reason("trip", tags="kyoto @password", content="<div>Kyoto</div>", boundary=boundary) == "password_protected"

    hidden_parent = _boundary(blacklist_tags=("travel",), whitelist_tags=())
    assert _draft_reason("trip", tags="kyoto", content="<div>Kyoto</div>", boundary=hidden_parent) == "blacklisted"


def test_draft_privacy_sees_a_whitelisted_tag_before_it_is_saved(live_database) -> None:
    _note("trip", None, content="<div>Kyoto</div>", tags="kyoto")
    boundary = _boundary(blacklist_tags=(), whitelist_tags=("share",))

    assert cloud_privacy_evaluator.exclusion_reason(note_id="trip", boundary=boundary) == "not_whitelisted"
    assert _draft_reason("trip", tags="kyoto share", content="<div>Kyoto</div>", boundary=boundary) == ""


# The vocabulary: ranked for the note, then by use, from notes the AI may see only.

def test_vocabulary_ranks_the_notes_tags_first_counts_visible_notes_and_never_sends_hidden_tags(live_database) -> None:
    _note("trip", None, content="<div>Temples in Kyoto and a ryokan</div>", tags="travel")
    for index in range(3):
        _note(f"recipe-{index}", None, content="<div>Dinner</div>", tags="cooking")
    _note("gion", None, content="<div>Gion</div>", tags="Kyoto travel")
    _note("kyoto-2", None, content="<div>Kiyomizu</div>", tags="kyoto")
    _note("diary", None, content="<div>Dear diary</div>", tags="private kyoto confidential-project")
    boundary = _boundary(blacklist_tags=("private",), whitelist_tags=())

    vocabulary = ranked_vocabulary(note_id="trip", boundary=boundary)

    tags = [tag.casefold() for tag, _count in vocabulary]
    counts = {tag.casefold(): count for tag, count in vocabulary}
    # Named in the note's text, so first, though cooking is on more notes.
    assert tags[0] == "kyoto"
    assert tags.index("kyoto") < tags.index("cooking")
    # Only visible notes count (either case): the diary's kyoto is not counted, its other tags are never sent.
    assert counts["kyoto"] == 2
    assert counts["cooking"] == 3
    assert "private" not in tags and "confidential-project" not in tags
    # The note's own tag is in its own tags, not the vocabulary.
    assert "travel" not in tags


# The request: the production tagging instructions, for one note.

def test_request_uses_the_production_tagging_instructions_with_one_note_rules(live_database) -> None:
    _note("parent", None, content="<div>Japan 2027</div>", tags="travel")
    _note("trip", "parent", content="<div>Temples in Kyoto</div>", tags="")
    _note("other", None, content="<div>Gion</div>", tags="kyoto")
    boundary = _boundary(blacklist_tags=(), whitelist_tags=())

    request = build_note_tag_request(note_id="trip", boundary=boundary, tag_skill=TAG_SKILL)

    payload = json.loads(request.messages[-1]["content"])
    production = tag_batch_messages(
        tag_skill=TAG_SKILL,
        vocabulary_scope="The accepted_vocabulary lists the user's existing tags that this request may see.",
        focus="both", user_payload=payload,
    )
    assert request.messages[:2] == production[:2]
    assert "This request tags the one note in result_trees" in request.messages[2]["content"]
    assert request.messages[3] == production[2]
    assert payload["result_trees"] == [{"note_id": "trip", "content_text": "Temples in Kyoto", "tags": [], "proposed_tags": []}]
    assert payload["ancestors"] == [{"content_text": "Japan 2027", "tags": ["travel"]}]
    assert payload["tagging_mode"] == "new"
    assert payload["accepted_vocabulary"][0] == "kyoto"
    assert len(payload["accepted_vocabulary"]) == len(payload["accepted_vocabulary_note_counts"])
    assert request.batch.note_ids == frozenset({"trip"})


def test_suggestions_keep_existing_tags_case_and_at_most_two_new_tags(live_database) -> None:
    _note("trip", None, content="<div>Temples in Kyoto</div>", tags="")
    _note("other", None, content="<div>Gion</div>", tags="Kyoto japan")
    request = build_note_tag_request(note_id="trip", boundary=_boundary(blacklist_tags=(), whitelist_tags=()), tag_skill=TAG_SKILL)
    inference = _FakeInference([{"proposals": [{"note_id": "trip", "tags": [
        "kyoto", "temples", "shrines", "japan", "zen-gardens",
    ]}]}])

    assert MAX_NEW_TAGS == 2
    assert _suggest(request, inference) == ("Kyoto", "temples", "shrines", "japan")


def test_an_answer_about_another_note_is_sent_back_for_correction(live_database) -> None:
    _note("parent", None, content="<div>Japan</div>", tags="")
    _note("trip", "parent", content="<div>Kyoto</div>", tags="")
    request = build_note_tag_request(note_id="trip", boundary=_boundary(blacklist_tags=(), whitelist_tags=()), tag_skill=TAG_SKILL)
    inference = _FakeInference([
        {"proposals": [{"note_id": "parent", "tags": ["japan"]}]},
        {"proposals": [{"note_id": "trip", "tags": ["kyoto"]}]},
    ])

    assert _suggest(request, inference) == ("kyoto",)
    assert len(inference.requests) == 2
    assert "outside the current permitted scope" in inference.requests[1][-1]["content"]


# Adding the proposals: undoable, and only what the note does not have yet.

def test_adding_proposals_skips_tags_the_note_has_or_already_proposes(live_database, monkeypatch) -> None:
    _note("parent", None, content="<div>Japan</div>", tags="travel")
    _note("trip", "parent", content="<div>Kyoto</div>", tags="kyoto")
    undo_records = []
    monkeypatch.setattr(proposal_module, "record_tag_sources", lambda *args, **kwargs: undo_records.append(kwargs))

    def add(tags: tuple[str, ...]) -> dict[str, object]:
        return proposal_module.CmdAddTagProposals(
            note_id="trip", tags=tags, token="", client_id="client", undo_context="context", viewport=VIEWPORT,
        ).execute()

    first = add(("Kyoto", "temples", "travel", "Temples", "gion"))
    assert (first["status"], first["added"], first["proposedTags"]) == ("added", ["temples", "gion"], "temples gion")
    assert store.get_note("trip").proposed_tags == "temples gion"
    assert undo_records[-1]["before_proposed_tags"] == "" and undo_records[-1]["after_proposed_tags"] == "temples gion"

    second = add(("gion", "kyoto"))
    assert (second["status"], second["added"]) == ("unchanged", [])
    assert len(undo_records) == 1

    with pytest.raises(ValueError, match="plain tags"):
        add(("@markdown",))


# The routes.

def _availability(note_id: str, *, tags: str, content: str) -> bool:
    return ai_routes.note_tag_suggestion_availability(
        note_id=note_id,
        payload=ai_routes.NoteTagSuggestionAvailabilityRequest(provider="openai", tags=tags, content_html=content),
        response=Response(), token="token",
    ).is_available


def test_the_menu_item_shows_only_when_an_ai_is_set_up_and_may_see_the_edited_note(live_database, monkeypatch) -> None:
    _note("trip", None, content="<div>Kyoto</div>", tags="kyoto")
    monkeypatch.setattr(ai_routes.token_service, "get_session_key", lambda token: "session")
    policy = json.dumps({"blacklist_phrases": [], "blacklist_tags": ["private"], "whitelist_phrases": [], "whitelist_tags": []},
                        separators=(",", ":"), sort_keys=True)
    monkeypatch.setattr(ai_routes, "load_client_preferences", lambda *, token: {"pref.ai.cloud_privacy_policy": policy})

    _set_ai_ready(monkeypatch, is_ready=False)
    assert _availability("trip", tags="kyoto", content="<div>Kyoto</div>") is False
    _set_ai_ready(monkeypatch, is_ready=True)
    assert _availability("trip", tags="kyoto", content="<div>Kyoto</div>") is True
    assert _availability("trip", tags="kyoto private", content="<div>Kyoto</div>") is False


def _suggestion_lines(note_id: str) -> list[dict[str, object]]:
    response = ai_routes.suggest_tags_for_note_with_ai(
        note_id=note_id,
        payload=ai_routes.NoteTagSuggestionRequest(provider="openai", model="gpt-5.6-luna", thinking_level="low"),
        token="token",
    )

    async def read() -> list[dict[str, object]]:
        return [json.loads(line) async for line in response.body_iterator]

    return asyncio.run(read())


def test_the_suggestion_route_streams_tags_or_why_the_ai_failed(live_database, monkeypatch) -> None:
    _note("trip", None, content="<div>Temples in Kyoto</div>", tags="")
    _note("other", None, content="<div>Gion</div>", tags="kyoto")
    monkeypatch.setattr(ai_routes.token_service, "get_session_key", lambda token: "session")
    monkeypatch.setattr(ai_routes, "load_client_preferences", lambda *, token: {})
    _set_ai_ready(monkeypatch, is_ready=True)

    answers = _FakeInference([{"proposals": [{"note_id": "trip", "tags": ["kyoto", "temples"]}]}])
    monkeypatch.setattr(ai_setup_module, "OpenAIInferenceAdapter", lambda **kwargs: answers)
    assert _suggestion_lines("trip") == [{"type": "tags", "tags": ["kyoto", "temples"]}]
    assert store.get_note("trip").proposed_tags == "", "asking writes nothing"

    monkeypatch.setattr(ai_setup_module, "OpenAIInferenceAdapter", lambda **kwargs: _FailingInference([]))
    assert _suggestion_lines("trip") == [{"type": "failed", "message": "OpenAI API request failed: connection reset"}]


def test_the_suggestion_route_refuses_a_hidden_note_and_an_ai_that_is_not_set_up(live_database, monkeypatch) -> None:
    _note("diary", None, content="<div>Dear diary</div>", tags="private")
    monkeypatch.setattr(ai_routes.token_service, "get_session_key", lambda token: "session")
    policy = json.dumps({"blacklist_phrases": [], "blacklist_tags": ["private"], "whitelist_phrases": [], "whitelist_tags": []},
                        separators=(",", ":"), sort_keys=True)
    monkeypatch.setattr(ai_routes, "load_client_preferences", lambda *, token: {"pref.ai.cloud_privacy_policy": policy})

    _set_ai_ready(monkeypatch, is_ready=True)
    with pytest.raises(InputRejected, match="privacy settings hide this note"):
        _suggestion_lines("diary")
    _set_ai_ready(monkeypatch, is_ready=False)
    with pytest.raises(HTTPException, match="The AI is not set up"):
        _suggestion_lines("diary")


def test_the_tag_bar_never_suggests_a_tag_whose_last_note_was_deleted(live_database) -> None:
    # Regression: the deleted note's tag stayed listed with no notes, and explaining
    # why it was suggested failed the whole suggestion request.
    _note("gone", None, content="<div>Edge case</div>", tags="edgeshortfixture")
    _note("trip", None, content="<div>Temples</div>", tags="")
    _note("other", None, content="<div>Gion</div>", tags="kyoto")
    apply_delete_subtree("gone")

    suggestions = suggest_tags_with_reasons_for_note(
        note_id="trip", anchors=[], explicit_tags=[], prefix="", content_html="<div>Temples</div>",
        limit=20, include_already_applying=False,
    )

    assert [suggestion.tag for suggestion in suggestions] == ["kyoto"]
    assert ranked_vocabulary(note_id="trip", boundary=_boundary(blacklist_tags=(), whitelist_tags=())) == (("kyoto", 1),)
