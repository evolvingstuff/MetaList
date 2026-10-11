"""The server keeps the session's decrypted preferences in memory.

Tag suggestions read a preference on every keystroke; decrypting the stored
preferences each time would be wasteful. The copy belongs to the session that
read it, follows every save, and goes with the other sensitive caches.
"""

from contextlib import contextmanager

import pytest

import app.services.client_state_service as client_state
from app.security.sensitive_cache import clear_sensitive_caches
from app.security.sensitive_cache import disable_and_clear_sensitive_caches
from app.security.sensitive_cache import enable_sensitive_caches


@pytest.fixture
def stored(monkeypatch: pytest.MonkeyPatch) -> dict:
    """The stored preferences, with a count of how often they are decrypted."""
    database = {"preferences": {"pref.show_note_tags": "true"}, "reads": 0}

    def read_client_preferences(*, token: str) -> dict[str, str]:
        database["reads"] += 1
        return dict(database["preferences"])

    @contextmanager
    def begin_writer():
        yield object()

    def update_client_preferences_json(connection, *, client_preferences_json, **_metadata):
        database["preferences"] = dict(database["pending"])

    def encode_json_for_storage(*, plaintext_json: str, token: str):
        return plaintext_json, None, None

    monkeypatch.setattr(client_state, "_read_client_preferences", read_client_preferences)
    monkeypatch.setattr(client_state, "begin_writer", begin_writer)
    monkeypatch.setattr(client_state, "insert_default_settings", lambda connection: None)
    monkeypatch.setattr(client_state, "update_client_preferences_json", update_client_preferences_json)
    monkeypatch.setattr(client_state, "_encode_json_for_storage", encode_json_for_storage)
    clear_sensitive_caches()
    yield database
    enable_sensitive_caches()
    clear_sensitive_caches()


def _save(database: dict, preferences: dict[str, str], token: str) -> None:
    database["pending"] = preferences
    client_state.save_client_preferences(preferences=preferences, token=token)


def test_a_session_decrypts_its_preferences_once(stored: dict) -> None:
    first = client_state.load_client_preferences(token="session-a")
    first["pref.show_note_tags"] = "changed by the caller"
    second = client_state.load_client_preferences(token="session-a")
    assert second == {"pref.show_note_tags": "true"}
    assert stored["reads"] == 1


def test_a_save_replaces_the_copy_in_memory(stored: dict) -> None:
    client_state.load_client_preferences(token="session-a")
    _save(stored, {"pref.suggest_already_applying_tags": "true"}, "session-a")
    assert client_state.load_client_preferences(token="session-a") == {"pref.suggest_already_applying_tags": "true"}
    assert stored["reads"] == 1


def test_a_new_session_reads_them_again(stored: dict) -> None:
    client_state.load_client_preferences(token="session-a")
    client_state.load_client_preferences(token="session-b")
    assert stored["reads"] == 2


def test_lock_logout_and_restore_drop_the_copy(stored: dict) -> None:
    client_state.load_client_preferences(token="session-a")
    clear_sensitive_caches()
    client_state.load_client_preferences(token="session-a")
    assert stored["reads"] == 2


def test_nothing_is_kept_while_the_namespace_is_locked(stored: dict) -> None:
    disable_and_clear_sensitive_caches()
    client_state.load_client_preferences(token="session-a")
    client_state.load_client_preferences(token="session-a")
    assert stored["reads"] == 2


def test_the_tag_suggestions_setting_is_off_unless_turned_on(stored: dict) -> None:
    assert client_state.suggests_already_applying_tags(token="session-a") is False
    _save(stored, {"pref.suggest_already_applying_tags": "true"}, "session-a")
    assert client_state.suggests_already_applying_tags(token="session-a") is True
    _save(stored, {"pref.suggest_already_applying_tags": "false"}, "session-a")
    assert client_state.suggests_already_applying_tags(token="session-a") is False
