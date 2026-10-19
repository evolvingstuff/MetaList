from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.config import KDF_ALGORITHM
from app.config import KDF_MEMORY_COST_KIB
from app.config import KDF_PARALLELISM
from app.config import KDF_TIME_COST
from app.config import VAULT_VERSION
from app.services.auth_service import AuthService


def _auth_service_without_database() -> AuthService:
    return AuthService.__new__(AuthService)


def test_password_policy_rejects_passwords_shorter_than_twelve_characters() -> None:
    auth = _auth_service_without_database()

    assert auth.password_policy_error("S7!vN2@qP4x") is not None


def test_password_policy_rejects_passwords_longer_than_seventy_two_characters() -> None:
    auth = _auth_service_without_database()

    assert auth.password_policy_error("x" * 73) is not None


def test_password_policy_rejects_common_predictable_passwords() -> None:
    auth = _auth_service_without_database()

    assert auth.password_policy_error("password1234") is not None


def test_password_policy_accepts_a_strong_password_without_composition_rules() -> None:
    auth = _auth_service_without_database()

    assert auth.password_policy_error("cobalt otter lantern violin") is None


def test_existing_short_password_remains_valid_for_login(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth = _auth_service_without_database()
    settings = SimpleNamespace(
        encryption_enabled=True,
        vault_version=VAULT_VERSION,
        kdf_algorithm=KDF_ALGORITHM,
        auth_verifier="stored-verifier",
        auth_salt=b"auth-salt",
        auth_iterations=KDF_TIME_COST,
        kek_iterations=KDF_TIME_COST,
        kdf_memory_cost_kib=KDF_MEMORY_COST_KIB,
        kdf_parallelism=KDF_PARALLELISM,
    )
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    monkeypatch.setattr(auth, "hash_password", lambda *args: "stored-verifier")
    monkeypatch.setattr(
        auth,
        "password_policy_error",
        lambda password: pytest.fail("login must not apply the new-password policy"),
    )

    assert auth.verify_password("abcd") is True
