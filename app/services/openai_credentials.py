"""Server-side OpenAI API-key storage with encryption-aware persistence."""

from __future__ import annotations

from dataclasses import dataclass
from threading import RLock

from app.db.session import begin_writer
from app.db.settings_sql import clear_openai_api_key
from app.db.settings_sql import fetch_settings
from app.db.settings_sql import insert_default_settings
from app.db.settings_sql import update_openai_api_key
from app.models.database import SafeSession
from app.security.encryption import get_encryption_service_with_token
from app.security.encryption import is_encryption_required


_MINIMUM_API_KEY_CHARACTERS = 20
_MAXIMUM_API_KEY_CHARACTERS = 512


@dataclass(frozen=True, slots=True)
class OpenAICredentialStatus:
    configured: bool
    persistent: bool


class OpenAICredentialInputError(ValueError):
    """Invalid user-supplied OpenAI credential."""


def validate_openai_api_key(api_key: str) -> str:
    if not isinstance(api_key, str):
        raise TypeError("OpenAI API key must be text")
    if api_key != api_key.strip():
        raise OpenAICredentialInputError(
            "OpenAI API key must not contain surrounding whitespace"
        )
    if not api_key.startswith("sk-"):
        raise OpenAICredentialInputError("OpenAI API key must start with sk-")
    if len(api_key) < _MINIMUM_API_KEY_CHARACTERS:
        raise OpenAICredentialInputError("OpenAI API key is too short")
    if len(api_key) > _MAXIMUM_API_KEY_CHARACTERS:
        raise OpenAICredentialInputError("OpenAI API key is too long")
    if any(character.isspace() or ord(character) < 32 for character in api_key):
        raise OpenAICredentialInputError(
            "OpenAI API key must not contain whitespace or control characters"
        )
    return api_key


class OpenAICredentialStore:
    def __init__(self) -> None:
        self._lock = RLock()
        self._session_keys: dict[str, str] = {}

    def configure(self, *, token: str, session_key: str, api_key: str) -> OpenAICredentialStatus:
        normalized = validate_openai_api_key(api_key)
        self._validate_session_key(session_key)
        if is_encryption_required():
            encryption_service = get_encryption_service_with_token(token)
            if encryption_service is None:
                raise RuntimeError("OpenAI API key persistence requires an active DEK")
            ciphertext, nonce, tag = encryption_service.encrypt_for_storage(normalized)
            with begin_writer() as connection:
                insert_default_settings(connection)
                update_openai_api_key(
                    connection,
                    ciphertext=ciphertext,
                    nonce=nonce,
                    tag=tag,
                )
            with self._lock:
                self._forget_session_key_locked(session_key)
            return OpenAICredentialStatus(configured=True, persistent=True)

        self._assert_no_plaintext_persisted_key()
        with self._lock:
            self._session_keys[session_key] = normalized
        return OpenAICredentialStatus(configured=True, persistent=False)

    def resolve(self, *, token: str, session_key: str) -> str:
        self._validate_session_key(session_key)
        if is_encryption_required():
            return self._load_persisted_key(token=token)
        self._assert_no_plaintext_persisted_key()
        with self._lock:
            if session_key not in self._session_keys:
                raise RuntimeError("OpenAI API key is not configured")
            return self._session_keys[session_key]

    def status(self, *, token: str, session_key: str) -> OpenAICredentialStatus:
        self._validate_session_key(session_key)
        if is_encryption_required():
            persisted = self._load_persisted_key_if_present(token=token)
            return OpenAICredentialStatus(
                configured=persisted != "",
                persistent=persisted != "",
            )
        self._assert_no_plaintext_persisted_key()
        with self._lock:
            configured = session_key in self._session_keys
        return OpenAICredentialStatus(configured=configured, persistent=False)

    def clear(self, *, session_key: str) -> OpenAICredentialStatus:
        self._validate_session_key(session_key)
        with self._lock:
            self._forget_session_key_locked(session_key)
        if is_encryption_required():
            with begin_writer() as connection:
                insert_default_settings(connection)
                clear_openai_api_key(connection)
        else:
            self._assert_no_plaintext_persisted_key()
        return OpenAICredentialStatus(configured=False, persistent=False)

    def clear_session(self, *, session_key: str) -> None:
        self._validate_session_key(session_key)
        with self._lock:
            self._forget_session_key_locked(session_key)

    def _forget_session_key_locked(self, session_key: str) -> None:
        """A session that never set a key has none to forget."""
        if session_key in self._session_keys:
            del self._session_keys[session_key]

    def reset(self) -> None:
        with self._lock:
            self._session_keys.clear()

    @staticmethod
    def _validate_session_key(session_key: str) -> None:
        if not isinstance(session_key, str) or session_key == "":
            raise ValueError("OpenAI credential session key must be non-empty")

    @staticmethod
    def _settings() -> dict[str, object]:
        session = SafeSession()
        try:
            with SafeSession.allow_reads("openai_credentials:settings"):
                settings = fetch_settings(session.connection())
            if settings is None:
                raise RuntimeError("OpenAI credentials require app_settings row")
            return settings
        finally:
            session.close()

    def _assert_no_plaintext_persisted_key(self) -> None:
        settings = self._settings()
        values = self._credential_columns(settings=settings)
        if any(value is not None for value in values):
            raise RuntimeError(
                "Unencrypted namespace contains persisted OpenAI credential data"
            )

    def _load_persisted_key(self, *, token: str) -> str:
        api_key = self._load_persisted_key_if_present(token=token)
        if api_key == "":
            raise RuntimeError("OpenAI API key is not configured")
        return api_key

    def _load_persisted_key_if_present(self, *, token: str) -> str:
        settings = self._settings()
        ciphertext, nonce, tag = self._credential_columns(settings=settings)
        if ciphertext is None and nonce is None and tag is None:
            return ""
        if not isinstance(ciphertext, str) or ciphertext == "":
            raise RuntimeError("Stored OpenAI API key ciphertext is invalid")
        if not isinstance(nonce, bytes) or not isinstance(tag, bytes):
            raise RuntimeError("Stored OpenAI API key encryption metadata is incomplete")
        encryption_service = get_encryption_service_with_token(token)
        if encryption_service is None:
            raise RuntimeError("OpenAI API key decryption requires an active DEK")
        plaintext = encryption_service.decrypt_from_storage(ciphertext, nonce, tag)
        return validate_openai_api_key(plaintext)

    @staticmethod
    def _credential_columns(
        *,
        settings: dict[str, object],
    ) -> tuple[object, object, object]:
        return (
            settings["openai_api_key_ciphertext"],
            settings["openai_api_key_encryption_nonce"],
            settings["openai_api_key_encryption_tag"],
        )


openai_credential_store = OpenAICredentialStore()
