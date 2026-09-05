from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.db.settings_sql import fetch_settings
from app.models.database import SafeSession
from app.security.encryption import set_encryption_required
from app.security.encryption import clear_encryption_key
from app.security.encryption import set_session_dek
from app.services.client_state_service import load_client_preferences
from app.services.client_state_service import load_client_state
from app.services.client_state_service import load_command_palette_usage
from app.services.client_state_service import save_client_preferences
from app.services.client_state_service import save_command_palette_usage


@pytest.fixture
def memory_settings_db(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    set_encryption_required(False)
    try:
        yield
    finally:
        clear_encryption_key()
        set_encryption_required(False)
        SafeSession.use_file_db()


def test_load_client_state_returns_empty_objects_when_settings_row_is_missing(
    memory_settings_db,
) -> None:
    del memory_settings_db

    assert load_client_preferences(token="") == {}
    assert load_command_palette_usage(token="") == {}
    assert load_client_state(token="") == {
        "preferences": {},
        "command_palette_usage": {},
    }


def test_save_client_preferences_round_trips_through_app_settings(
    memory_settings_db,
) -> None:
    del memory_settings_db

    expected_preferences = {
        "pref.show_note_tags": "true",
        "pref.show_search_results_count": "true",
        "pref.animated_transitions": "false",
        "pref.reminder_surface_expanded": "false",
        "pref.theme": "dark",
        "pref.search_suggestion_windows": "[30,7,1]",
        "pref.show_search_suggestion_window_labels": "false",
        "pref.limit_note_credits_per_search_context": "true",
    }

    saved = save_client_preferences(preferences=expected_preferences, token="")

    assert saved == expected_preferences
    assert load_client_preferences(token="") == expected_preferences

    session = SafeSession()
    try:
        with SafeSession.allow_reads("tests:client_state:preferences"):
            settings = fetch_settings(session.connection())
        assert settings is not None
        assert json.loads(settings["client_preferences_json"]) == expected_preferences
    finally:
        session.close()


def test_save_client_preferences_drops_obsolete_preferences(
    memory_settings_db,
) -> None:
    del memory_settings_db

    saved = save_client_preferences(
        token="",
        preferences={
            "pref.theme": "dark",
            "pref.reminder_popup_sound_enabled": "true",
            "pref.reminder_popup_sound_id": "11111111-1111-4111-8111-111111111111",
            "pref.reminder_ack_sound_enabled": "true",
            "pref.reminder_ack_sound_id": "builtin.default_chime",
            "pref.show_note_timestamps": "true",
            "pref.show_rhs_panel": "true",
        }
    )

    assert saved == {"pref.theme": "dark"}
    assert load_client_preferences(token="") == {"pref.theme": "dark"}


def test_save_client_preferences_accepts_default_reminder_sound_keys(
    memory_settings_db,
) -> None:
    del memory_settings_db

    expected_preferences = {
        "pref.reminder_default_popup_sound_enabled": "true",
        "pref.reminder_default_popup_sound_id": "builtin.default_chime",
        "pref.reminder_default_ack_sound_enabled": "true",
        "pref.reminder_default_ack_sound_id": "11111111-1111-4111-8111-111111111111",
    }

    saved = save_client_preferences(preferences=expected_preferences, token="")

    assert saved == expected_preferences
    assert load_client_preferences(token="") == expected_preferences


def test_save_client_preferences_accepts_note_layout_keys(
    memory_settings_db,
) -> None:
    del memory_settings_db

    expected_preferences = {
        "pref.note_layout.top_level_note_size": "largest",
        "pref.note_layout.child_indentation": "wide",
        "pref.note_layout.vertical_spacing": "spacious",
    }

    saved = save_client_preferences(preferences=expected_preferences, token="")

    assert saved == expected_preferences
    assert load_client_preferences(token="") == expected_preferences


def test_save_client_preferences_accepts_ai_configuration(memory_settings_db) -> None:
    del memory_settings_db

    expected_preferences = {
        "pref.show_ai_chat": "true",
        "pref.ai.provider": "ollama",
        "pref.ai.ollama_base_url": "http://127.0.0.1:11434",
        "pref.ai.ollama_model": "qwen3:8b",
        "pref.ai.thinking_level": "low",
        "pref.ai.show_diagnostics": "false",
        "pref.ai.tagging.vocabulary": "new",
        "pref.ai.tagging.focus": "both",
        "pref.ai.cloud_privacy_policy": (
            '{"blacklist_phrases":["secret phrase"],'
            '"blacklist_tags":["private"],'
            '"whitelist_phrases":[],"whitelist_tags":["project"]}'
        ),
        "pref.ai.retrieval.max_page_approximate_tokens": "7000",
        "pref.ai.openai.retrieval.max_page_approximate_tokens": "500000",
        "pref.ai.prompt.system": "Custom MetaList agent",
        "pref.ai.prompt.final_response": "FINAL\n{basis}",
        "pref.ai.prompt.tool_result": "TOOL {action_name}\n{payload_json}",
        "pref.ai.skill.scoped_investigation_v7": "Custom direct investigation skill",
        "pref.ai.chat_width": "640",
        "pref.ai.composer_height": "180",
    }

    saved = save_client_preferences(preferences=expected_preferences, token="")

    assert saved == expected_preferences
    assert load_client_preferences(token="") == expected_preferences


@pytest.mark.parametrize(
    "policy",
    [
        "{}",
        '{"blacklist_phrases":[],"blacklist_tags":[],"whitelist_phrases":[]}',
        (
            '{"blacklist_phrases":[],"blacklist_tags":["bad tag"],'
            '"whitelist_phrases":[],"whitelist_tags":[]}'
        ),
        (
            '{"blacklist_phrases":[],"blacklist_tags":["private","PRIVATE"],'
            '"whitelist_phrases":[],"whitelist_tags":[]}'
        ),
    ],
)
def test_save_client_preferences_rejects_invalid_cloud_privacy_policy(
    memory_settings_db,
    policy,
) -> None:
    del memory_settings_db

    with pytest.raises(RuntimeError, match="Cloud privacy"):
        save_client_preferences(
            preferences={"pref.ai.cloud_privacy_policy": policy},
            token="",
        )


@pytest.mark.parametrize("width", ["279", "5001", "640.5", "0640"])
def test_save_client_preferences_rejects_invalid_ai_chat_width(
    memory_settings_db,
    width,
) -> None:
    del memory_settings_db

    with pytest.raises(RuntimeError, match="Invalid client preference value"):
        save_client_preferences(
            preferences={"pref.ai.chat_width": width},
            token="",
        )


@pytest.mark.parametrize("height", ["73", "221", "180.5", "0180"])
def test_save_client_preferences_rejects_invalid_ai_chat_composer_height(
    memory_settings_db,
    height,
) -> None:
    del memory_settings_db

    with pytest.raises(RuntimeError, match="Invalid client preference value"):
        save_client_preferences(
            preferences={"pref.ai.composer_height": height},
            token="",
        )


def test_save_client_preferences_rejects_unknown_ai_thinking_level(
    memory_settings_db,
) -> None:
    del memory_settings_db

    with pytest.raises(RuntimeError, match="Invalid client preference value"):
        save_client_preferences(
            preferences={"pref.ai.thinking_level": "extreme"},
            token="",
        )


def test_save_client_preferences_rejects_invalid_ai_diagnostic_visibility(
    memory_settings_db,
) -> None:
    del memory_settings_db

    with pytest.raises(RuntimeError, match="Invalid client preference value"):
        save_client_preferences(
            preferences={"pref.ai.show_diagnostics": "sometimes"},
            token="",
        )


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("pref.ai.retrieval.max_page_approximate_tokens", "499"),
        ("pref.ai.retrieval.max_page_approximate_tokens", "24001"),
        ("pref.ai.openai.retrieval.max_page_approximate_tokens", "500001"),
    ],
)
def test_save_client_preferences_rejects_invalid_agent_retrieval_limits(
    memory_settings_db,
    key,
    value,
) -> None:
    del memory_settings_db

    with pytest.raises(ValueError):
        save_client_preferences(preferences={key: value}, token="")


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("pref.ai.prompt.system", "   "),
        ("pref.ai.prompt.final_response", "Missing basis"),
        ("pref.ai.prompt.final_response", "{basis} {unknown}"),
        ("pref.ai.prompt.tool_result", "{action_name}"),
        ("pref.ai.prompt.tool_result", "{action_name} {payload_json} {unknown}"),
        ("pref.ai.skill.search_notes", "   "),
        ("pref.ai.skill.search_notes", "x" * 32_001),
    ],
)
def test_save_client_preferences_rejects_invalid_agent_prompts(
    memory_settings_db,
    key,
    value,
) -> None:
    del memory_settings_db

    with pytest.raises(ValueError):
        save_client_preferences(preferences={key: value}, token="")


def test_save_client_preferences_rejects_unsafe_ollama_url(memory_settings_db) -> None:
    del memory_settings_db

    with pytest.raises(ValueError, match="must not include credentials"):
        save_client_preferences(
            preferences={
                "pref.ai.ollama_base_url": "http://user:secret@127.0.0.1:11434",
            },
            token="",
        )


def test_save_client_preferences_validates_search_suggestion_windows(
    memory_settings_db,
) -> None:
    del memory_settings_db

    expected_preferences = {"pref.search_suggestion_windows": "[1,30]"}
    assert save_client_preferences(preferences=expected_preferences, token="") == expected_preferences

    for invalid_value in ("[0]", "[366]", "[7,7]", "[1, 7]", "not-json"):
        with pytest.raises((RuntimeError, json.JSONDecodeError)):
            save_client_preferences(
                preferences={"pref.search_suggestion_windows": invalid_value},
                token="",
            )


def test_save_command_palette_usage_round_trips_through_app_settings(
    memory_settings_db,
) -> None:
    del memory_settings_db

    expected_usage = {
        "command.logout": {
            "count": 2,
            "lastUsedAt": 1234567890,
            "lastQueryTokens": ["logout"],
        },
    }

    saved = save_command_palette_usage(usage_state=expected_usage, token="")

    assert saved == expected_usage
    assert load_command_palette_usage(token="") == expected_usage
    assert load_client_state(token="") == {
        "preferences": {},
        "command_palette_usage": expected_usage,
    }

    session = SafeSession()
    try:
        with SafeSession.allow_reads("tests:client_state:usage"):
            settings = fetch_settings(session.connection())
        assert settings is not None
        assert json.loads(settings["command_palette_usage_json"]) == expected_usage
    finally:
        session.close()


def test_encrypted_client_state_never_persists_plaintext(memory_settings_db) -> None:
    del memory_settings_db
    set_encryption_required(True)
    set_session_dek(b"d" * 32)
    preferences = {"pref.theme": "dark"}
    usage = {
        "command.logout": {
            "count": 1,
            "lastUsedAt": 42,
            "lastQueryTokens": ["secret-query"],
        },
    }

    save_client_preferences(preferences=preferences, token="")
    save_command_palette_usage(usage_state=usage, token="")

    session = SafeSession()
    try:
        with SafeSession.allow_reads("tests:client_state:encrypted"):
            settings = fetch_settings(session.connection())
        assert settings is not None
        assert "dark" not in settings["client_preferences_json"]
        assert "secret-query" not in settings["command_palette_usage_json"]
        assert settings["client_preferences_encryption_nonce"] is not None
        assert settings["client_preferences_encryption_tag"] is not None
        assert settings["command_palette_usage_encryption_nonce"] is not None
        assert settings["command_palette_usage_encryption_tag"] is not None
    finally:
        session.close()

    assert load_client_preferences(token="") == preferences
    assert load_command_palette_usage(token="") == usage


def test_save_client_preferences_rejects_unknown_preference_key(
    memory_settings_db,
) -> None:
    del memory_settings_db

    with pytest.raises(RuntimeError, match="Unknown client preference key"):
        save_client_preferences(preferences={"pref.not-real": "dark"}, token="")


def test_save_command_palette_usage_rejects_invalid_usage_record(
    memory_settings_db,
) -> None:
    del memory_settings_db

    with pytest.raises(RuntimeError, match="Usage count for command.logout must be a positive integer"):
        save_command_palette_usage(
            token="",
            usage_state={
                "command.logout": {
                    "count": 0,
                    "lastUsedAt": 1234567890,
                    "lastQueryTokens": ["logout"],
                },
            },
        )
