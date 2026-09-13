from __future__ import annotations

import json
import re

from app.db.session import begin_writer
from app.db.settings_sql import (
    fetch_settings,
    insert_default_settings,
    update_client_preferences_json,
    update_command_palette_usage_json,
    update_tag_prefix_settings_json,
)
from app.models.database import SafeSession
from app.security.encryption import get_encryption_service
from app.security.encryption import get_encryption_service_with_token
from app.security.encryption import is_encryption_required
from app.services.agent.prompt_settings import FINAL_RESPONSE_PROMPT_PREFERENCE_KEY
from app.services.agent.prompt_settings import SYSTEM_PROMPT_PREFERENCE_KEY
from app.services.agent.prompt_settings import TOOL_RESULT_PROMPT_PREFERENCE_KEY
from app.services.agent.prompt_settings import validate_final_response_prompt
from app.services.agent.prompt_settings import validate_system_prompt
from app.services.agent.prompt_settings import validate_tool_result_prompt
from app.services.agent.cloud_privacy import CLOUD_PRIVACY_POLICY_PREFERENCE_KEY
from app.services.agent.cloud_privacy import validate_cloud_privacy_policy_preference
from app.services.agent.retrieval_settings import MAX_PAGE_APPROXIMATE_TOKENS_PREFERENCE_KEY
from app.services.agent.retrieval_settings import OPENAI_MAX_PAGE_APPROXIMATE_TOKENS_PREFERENCE_KEY
from app.services.agent.retrieval_settings import validate_max_page_approximate_tokens_preference
from app.services.agent.retrieval_settings import validate_openai_max_page_approximate_tokens_preference
from app.services.agent.skill_settings import AGENT_SKILL_PREFERENCE_KEYS
from app.services.agent.skill_settings import SUPERSEDED_AGENT_SKILL_PREFERENCE_KEYS
from app.services.agent.skill_settings import validate_agent_skill_content
from app.services.ollama_provider import normalize_ollama_base_url
from app.services.ollama_provider import validate_ollama_model
from app.services.agent.openai_inference import validate_openai_model


_ALLOWED_CLIENT_PREFERENCES = {
    "pref.ai.tagging.vocabulary": {"existing", "new"},
    "pref.ai.tagging.focus": {"existing", "new", "both"},
    "pref.ai.prompt.tagging": "agent_system_prompt",
    "pref.show_backlinks": {"true", "false"},
    "pref.show_note_tags": {"true", "false"},
    "pref.show_tab_ui": {"true", "false"},
    "pref.show_search_results_count": {"true", "false"},
    "pref.show_ai_chat": {"true", "false"},
    "pref.animated_transitions": {"true", "false"},
    "pref.reminder_surface_expanded": {"true", "false"},
    "pref.note_layout.top_level_note_size": {"same", "larger", "largest"},
    "pref.note_layout.child_indentation": {"compact", "standard", "wide"},
    "pref.note_layout.vertical_spacing": {"compact", "comfortable", "spacious"},
    "pref.theme": {"system", "light", "dark"},
    "pref.search_suggestion_windows": "tag_activity_windows",
    "pref.show_search_suggestion_window_labels": {"true", "false"},
    "pref.limit_note_credits_per_search_context": {"true", "false"},
    "pref.ai.provider": {"ollama", "openai"},
    "pref.ai.ollama_base_url": "ollama_base_url",
    "pref.ai.ollama_model": "ollama_model",
    "pref.ai.openai_model": "openai_model",
    "pref.ai.thinking_level": {"off", "low", "medium", "high"},
    "pref.ai.show_diagnostics": {"true", "false"},
    CLOUD_PRIVACY_POLICY_PREFERENCE_KEY: "cloud_privacy_policy",
    MAX_PAGE_APPROXIMATE_TOKENS_PREFERENCE_KEY: (
        "agent_max_page_approximate_tokens"
    ),
    OPENAI_MAX_PAGE_APPROXIMATE_TOKENS_PREFERENCE_KEY: (
        "openai_agent_max_page_approximate_tokens"
    ),
    "pref.ai.tagging.batch_tokens": "agent_max_page_approximate_tokens",
    "pref.ai.openai.tagging.batch_tokens": "openai_agent_max_page_approximate_tokens",
    SYSTEM_PROMPT_PREFERENCE_KEY: "agent_system_prompt",
    FINAL_RESPONSE_PROMPT_PREFERENCE_KEY: "agent_final_response_prompt",
    TOOL_RESULT_PROMPT_PREFERENCE_KEY: "agent_tool_result_prompt",
    "pref.ai.chat_width": "ai_chat_width",
    "pref.ai.composer_height": "ai_chat_composer_height",
    **{key: "agent_skill" for key in AGENT_SKILL_PREFERENCE_KEYS},
    **{key: "agent_skill" for key in SUPERSEDED_AGENT_SKILL_PREFERENCE_KEYS},
}

_OBSOLETE_CLIENT_PREFERENCES = frozenset(
    {
        "pref.show_perf_overlay",
        "pref.reminder_default_popup_sound_enabled",
        "pref.reminder_default_popup_sound_id",
        "pref.reminder_default_ack_sound_enabled",
        "pref.reminder_default_ack_sound_id",
        "pref.reminder_popup_sound_enabled",
        "pref.reminder_ack_sound_enabled",
        "pref.reminder_popup_sound_id",
        "pref.reminder_ack_sound_id",
        "pref.search_suggestion_falloff",
        "pref.show_note_timestamps",
        "pref.show_rhs_panel",
        "pref.ai.retrieval.max_note_characters",
        "pref.ai.retrieval.max_page_characters",
        "pref.ai.retrieval.max_notes_per_page",
        "pref.ai.retrieval.max_ranked_tags_per_page",
        "pref.ai.retrieval.max_working_summary_characters",
        "pref.ai.retrieval.ideal_narrowed_scope_approximate_tokens",
        "pref.ai.openai.retrieval.max_note_characters",
        "pref.ai.openai.retrieval.max_page_characters",
        "pref.ai.openai.retrieval.max_notes_per_page",
        "pref.ai.openai.retrieval.max_ranked_tags_per_page",
        "pref.ai.openai.retrieval.max_working_summary_characters",
        "pref.ai.openai.retrieval.ideal_narrowed_scope_approximate_tokens",
    }
)

_UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}$"
)


def _parse_json_object(*, raw_json: object, label: str) -> dict[str, object]:
    if not isinstance(label, str) or label == "":
        raise ValueError("label must be a non-empty string")
    if raw_json is None:
        return {}
    if not isinstance(raw_json, str):
        raise RuntimeError(f"{label} must be stored as a string")
    if raw_json == "":
        return {}

    parsed = json.loads(raw_json)
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{label} must decode to an object")
    normalized: dict[str, object] = {}
    for key, value in parsed.items():
        if not isinstance(key, str):
            raise RuntimeError(f"{label} keys must be strings")
        normalized[key] = value
    return normalized


def _serialize_json_object(*, payload: dict[str, object], label: str) -> str:
    if not isinstance(payload, dict):
        raise TypeError(f"{label} must be a dict")
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


def _resolve_encryption_service(*, token: str):
    if not isinstance(token, str):
        raise TypeError("token must be a string")
    if token != "":
        return get_encryption_service_with_token(token)
    return get_encryption_service()


def _decode_stored_json(
    *,
    stored_json: object,
    nonce: object,
    tag: object,
    label: str,
    token: str,
) -> object:
    if (nonce is None) != (tag is None):
        raise RuntimeError(f"{label} has incomplete encryption metadata")
    if stored_json is None or stored_json == "":
        if nonce is not None:
            raise RuntimeError(f"{label} has encryption metadata without a payload")
        return stored_json
    if not isinstance(stored_json, str):
        raise RuntimeError(f"{label} must be stored as a string")
    if nonce is None:
        if is_encryption_required():
            raise RuntimeError(f"{label} is plaintext in an encrypted namespace")
        return stored_json
    service = _resolve_encryption_service(token=token)
    if service is None:
        raise RuntimeError(f"{label} decryption requires an active DEK")
    return service.decrypt_from_storage(stored_json, nonce, tag)


def _encode_json_for_storage(*, plaintext_json: str, token: str) -> tuple[str, bytes | None, bytes | None]:
    service = _resolve_encryption_service(token=token)
    if service is not None:
        return service.encrypt_for_storage(plaintext_json)
    if is_encryption_required():
        raise RuntimeError("Client-state persistence requires an active DEK")
    return plaintext_json, None, None


class ClientStateValidationError(ValueError, RuntimeError):
    """Invalid serialized client preference or usage input."""


def _validate_client_preferences(preferences: dict[str, object]) -> dict[str, str]:
    if not isinstance(preferences, dict):
        raise TypeError("preferences must be a dict")

    normalized: dict[str, str] = {}
    for key, value in preferences.items():
        if not isinstance(key, str) or key == "":
            raise ClientStateValidationError("client preference keys must be non-empty strings")
        if key in _OBSOLETE_CLIENT_PREFERENCES:
            continue
        if key not in _ALLOWED_CLIENT_PREFERENCES:
            raise ClientStateValidationError(f"Unknown client preference key: {key}")
        if not isinstance(value, str):
            raise ClientStateValidationError(f"Client preference {key} must be a string")
        allowed_values = _ALLOWED_CLIENT_PREFERENCES[key]
        if allowed_values == "tag_activity_windows":
            _validate_tag_activity_windows_preference(key=key, value=value)
        elif allowed_values == "ollama_base_url":
            value = normalize_ollama_base_url(value)
        elif allowed_values == "ollama_model":
            value = validate_ollama_model(value)
        elif allowed_values == "openai_model":
            value = validate_openai_model(value)
        elif allowed_values == "ai_chat_width":
            _validate_ai_chat_width_preference(key=key, value=value)
        elif allowed_values == "ai_chat_composer_height":
            _validate_ai_chat_composer_height_preference(key=key, value=value)
        elif allowed_values == "agent_max_page_approximate_tokens":
            value = validate_max_page_approximate_tokens_preference(value)
        elif allowed_values == "openai_agent_max_page_approximate_tokens":
            value = validate_openai_max_page_approximate_tokens_preference(value)
        elif allowed_values == "agent_system_prompt":
            value = validate_system_prompt(value)
        elif allowed_values == "agent_final_response_prompt":
            value = validate_final_response_prompt(value)
        elif allowed_values == "agent_tool_result_prompt":
            value = validate_tool_result_prompt(value)
        elif allowed_values == "agent_skill":
            value = validate_agent_skill_content(value)
        elif allowed_values == "cloud_privacy_policy":
            value = validate_cloud_privacy_policy_preference(value)
        elif value not in allowed_values:
            raise ClientStateValidationError(f"Invalid client preference value for {key}: {value}")
        normalized[key] = value
    return normalized



def _validate_ai_chat_width_preference(*, key: str, value: str) -> None:
    if re.fullmatch(r"[1-9][0-9]*", value) is None:
        raise ClientStateValidationError(f"Invalid client preference value for {key}: {value}")
    width = int(value)
    if width < 280 or width > 5000:
        raise ClientStateValidationError(f"Invalid client preference value for {key}: {value}")


def _validate_ai_chat_composer_height_preference(*, key: str, value: str) -> None:
    if re.fullmatch(r"[1-9][0-9]*", value) is None:
        raise ClientStateValidationError(f"Invalid client preference value for {key}: {value}")
    height = int(value)
    if height < 74 or height > 220:
        raise ClientStateValidationError(f"Invalid client preference value for {key}: {value}")


def _validate_tag_activity_windows_preference(*, key: str, value: str) -> None:
    parsed = json.loads(value)
    if not isinstance(parsed, list):
        raise ClientStateValidationError(f"Invalid client preference value for {key}: expected a list")
    if len(parsed) > 20:
        raise ClientStateValidationError(f"Invalid client preference value for {key}: too many slots")
    seen: set[int] = set()
    for day_count in parsed:
        if not isinstance(day_count, int) or isinstance(day_count, bool):
            raise ClientStateValidationError(f"Invalid client preference value for {key}: expected integers")
        if day_count < 1 or day_count > 365:
            raise ClientStateValidationError(f"Invalid client preference value for {key}: out-of-range window")
        if day_count in seen:
            raise ClientStateValidationError(f"Invalid client preference value for {key}: duplicate window")
        seen.add(day_count)
    canonical = json.dumps(parsed, separators=(",", ":"))
    if canonical != value:
        raise ClientStateValidationError(f"Invalid client preference value for {key}: non-canonical JSON")


def _validate_usage_state(usage_state: dict[str, object]) -> dict[str, dict[str, object]]:
    if not isinstance(usage_state, dict):
        raise TypeError("usage_state must be a dict")

    normalized: dict[str, dict[str, object]] = {}
    for endpoint_id, raw_record in usage_state.items():
        if not isinstance(endpoint_id, str) or endpoint_id == "":
            raise ClientStateValidationError("usage endpoint ids must be non-empty strings")
        if endpoint_id in _OBSOLETE_CLIENT_PREFERENCES:
            continue
        if not isinstance(raw_record, dict):
            raise ClientStateValidationError(f"Usage record for {endpoint_id} must be an object")
        if "count" not in raw_record:
            raise ClientStateValidationError(f"Usage record for {endpoint_id} missing count")
        if "lastUsedAt" not in raw_record:
            raise ClientStateValidationError(f"Usage record for {endpoint_id} missing lastUsedAt")
        if "lastQueryTokens" not in raw_record:
            raise ClientStateValidationError(f"Usage record for {endpoint_id} missing lastQueryTokens")

        count = raw_record["count"]
        last_used_at = raw_record["lastUsedAt"]
        last_query_tokens = raw_record["lastQueryTokens"]

        if not isinstance(count, int) or count < 1:
            raise ClientStateValidationError(f"Usage count for {endpoint_id} must be a positive integer")
        if not isinstance(last_used_at, int) or last_used_at < 0:
            raise ClientStateValidationError(f"Usage lastUsedAt for {endpoint_id} must be a non-negative integer")
        if not isinstance(last_query_tokens, list):
            raise ClientStateValidationError(f"Usage lastQueryTokens for {endpoint_id} must be a list")

        normalized_tokens: list[str] = []
        for token in last_query_tokens:
            if not isinstance(token, str):
                raise ClientStateValidationError(f"Usage lastQueryTokens for {endpoint_id} must be strings")
            normalized_tokens.append(token)

        normalized[endpoint_id] = {
            "count": count,
            "lastUsedAt": last_used_at,
            "lastQueryTokens": normalized_tokens,
        }
    return normalized


def load_client_preferences(*, token: str) -> dict[str, str]:
    session = SafeSession()
    try:
        with SafeSession.allow_reads("client_state:load_preferences"):
            settings = fetch_settings(session.connection())
        if settings is None:
            return {}
        stored_json = _decode_stored_json(
            stored_json=settings["client_preferences_json"],
            nonce=settings["client_preferences_encryption_nonce"],
            tag=settings["client_preferences_encryption_tag"],
            label="client_preferences_json",
            token=token,
        )
        parsed = _parse_json_object(
            raw_json=stored_json,
            label="client_preferences_json",
        )
        return _validate_client_preferences(parsed)
    finally:
        session.close()


def save_client_preferences(*, preferences: dict[str, object], token: str) -> dict[str, str]:
    normalized = _validate_client_preferences(preferences)
    serialized = _serialize_json_object(payload=normalized, label="preferences")
    stored_json, nonce, tag = _encode_json_for_storage(
        plaintext_json=serialized,
        token=token,
    )
    with begin_writer() as connection:
        insert_default_settings(connection)
        update_client_preferences_json(
            connection,
            client_preferences_json=stored_json,
            client_preferences_encryption_nonce=nonce,
            client_preferences_encryption_tag=tag,
        )
    return normalized


def load_command_palette_usage(*, token: str) -> dict[str, dict[str, object]]:
    session = SafeSession()
    try:
        with SafeSession.allow_reads("client_state:load_usage"):
            settings = fetch_settings(session.connection())
        if settings is None:
            return {}
        stored_json = _decode_stored_json(
            stored_json=settings["command_palette_usage_json"],
            nonce=settings["command_palette_usage_encryption_nonce"],
            tag=settings["command_palette_usage_encryption_tag"],
            label="command_palette_usage_json",
            token=token,
        )
        parsed = _parse_json_object(
            raw_json=stored_json,
            label="command_palette_usage_json",
        )
        return _validate_usage_state(parsed)
    finally:
        session.close()


def save_command_palette_usage(
    *,
    usage_state: dict[str, object],
    token: str,
) -> dict[str, dict[str, object]]:
    normalized = _validate_usage_state(usage_state)
    serialized = _serialize_json_object(payload=normalized, label="usage_state")
    stored_json, nonce, tag = _encode_json_for_storage(
        plaintext_json=serialized,
        token=token,
    )
    with begin_writer() as connection:
        insert_default_settings(connection)
        update_command_palette_usage_json(
            connection,
            command_palette_usage_json=stored_json,
            command_palette_usage_encryption_nonce=nonce,
            command_palette_usage_encryption_tag=tag,
        )
    return normalized


def load_client_state(*, token: str) -> dict[str, object]:
    return {
        "preferences": load_client_preferences(token=token),
        "command_palette_usage": load_command_palette_usage(token=token),
    }


def rewrite_client_state_storage(
    *,
    connection,
    encryption_service: object,
    force_plaintext: bool,
) -> int:
    if encryption_service is None:
        raise RuntimeError("Client-state rewrite requires an active encryption service")
    rewritten_count = 0
    fields = (
        (
            "client_preferences_json",
            "client_preferences_encryption_nonce",
            "client_preferences_encryption_tag",
        ),
        (
            "command_palette_usage_json",
            "command_palette_usage_encryption_nonce",
            "command_palette_usage_encryption_tag",
        ),
        (
            "tag_prefix_settings_json",
            "tag_prefix_settings_encryption_nonce",
            "tag_prefix_settings_encryption_tag",
        ),
    )
    settings = fetch_settings(connection)
    if settings is None:
        raise RuntimeError("Client-state rewrite requires app_settings row")
    for value_column, nonce_column, tag_column in fields:
        value = settings[value_column]
        nonce = settings[nonce_column]
        tag = settings[tag_column]
        if value is None or value == "":
            if nonce is not None or tag is not None:
                raise RuntimeError(f"{value_column} has metadata without a payload")
            continue
        if not isinstance(value, str):
            raise RuntimeError(f"{value_column} must be stored as a string")
        if (nonce is None) != (tag is None):
            raise RuntimeError(f"{value_column} has incomplete encryption metadata")
        if force_plaintext:
            if nonce is None:
                continue
            stored_value = encryption_service.decrypt_from_storage(value, nonce, tag)
            next_nonce = None
            next_tag = None
        else:
            if nonce is not None:
                continue
            stored_value, next_nonce, next_tag = encryption_service.encrypt_for_storage(value)
        if value_column == "client_preferences_json":
            update_client_preferences_json(
                connection,
                client_preferences_json=stored_value,
                client_preferences_encryption_nonce=next_nonce,
                client_preferences_encryption_tag=next_tag,
            )
        elif value_column == "command_palette_usage_json":
            update_command_palette_usage_json(
                connection,
                command_palette_usage_json=stored_value,
                command_palette_usage_encryption_nonce=next_nonce,
                command_palette_usage_encryption_tag=next_tag,
            )
        else:
            if value_column != "tag_prefix_settings_json":
                raise RuntimeError(f"Unsupported client-state storage field: {value_column}")
            update_tag_prefix_settings_json(
                connection,
                tag_prefix_settings_json=stored_value,
                tag_prefix_settings_encryption_nonce=next_nonce,
                tag_prefix_settings_encryption_tag=next_tag,
            )
        rewritten_count += 1
    return rewritten_count
