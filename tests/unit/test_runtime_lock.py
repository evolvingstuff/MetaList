from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import app.services.runtime_lock as runtime_lock
from app.models.database import SafeSession
from app.security.encryption import clear_encryption_key
from app.security.encryption import set_encryption_required
from app.security.encryption import set_session_dek


def test_purge_decrypted_runtime_state_is_noop_for_passwordless_namespace(monkeypatch) -> None:
    monkeypatch.setattr(runtime_lock, "is_encryption_required", lambda: False)
    monkeypatch.setattr(
        runtime_lock.view_cache,
        "clear",
        lambda: (_ for _ in ()).throw(AssertionError("passwordless state must remain loaded")),
    )

    assert runtime_lock.purge_decrypted_runtime_state() is False


def test_purge_decrypted_runtime_state_preserves_bootstrap_state_when_already_locked(monkeypatch) -> None:
    monkeypatch.setattr(runtime_lock, "is_encryption_required", lambda: True)
    monkeypatch.setattr(runtime_lock, "is_encryption_available", lambda token: False, raising=False)
    monkeypatch.setattr(
        runtime_lock.link_title_store,
        "reset",
        lambda: (_ for _ in ()).throw(AssertionError("locked startup state must remain bootstrapped")),
    )

    assert runtime_lock.purge_decrypted_runtime_state() is False


def test_purge_decrypted_runtime_state_clears_every_plaintext_store(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(runtime_lock, "is_encryption_required", lambda: True)
    monkeypatch.setattr(runtime_lock, "is_encryption_available", lambda token: True)

    object_methods = (
        ("view_cache", "clear"),
        ("tab_state_store", "reset"),
        ("link_title_store", "reset"),
        ("reminder_store", "reset"),
        ("search_history_store", "reset"),
        ("note_store", "reset"),
        ("auth_cache_state", "reset_cache_state"),
        ("file_registry", "reset"),
        ("hydration_state", "reset"),
    )
    for object_name, method_name in object_methods:
        monkeypatch.setattr(
            runtime_lock,
            object_name,
            SimpleNamespace(**{method_name: lambda name=object_name: calls.append(name)}),
        )

    function_names = (
        "reset_sync_state",
        "reset_legacy_sync_state",
        "reset_all_undo_state",
        "lock_ontology_rules_store",
        "clear_encryption_key",
        "clear_cache",
    )
    for function_name in function_names:
        monkeypatch.setattr(
            runtime_lock,
            function_name,
            lambda name=function_name: calls.append(name),
        )
    monkeypatch.setattr(
        runtime_lock,
        "_rebootstrap_encrypted_store_metadata",
        lambda: calls.append("rebootstrap_encrypted_store_metadata"),
    )
    monkeypatch.setattr(
        runtime_lock,
        "bootstrap_file_registry",
        lambda: calls.append("bootstrap_file_registry"),
    )

    assert runtime_lock.purge_decrypted_runtime_state() is True
    assert calls == [
        "view_cache",
        "tab_state_store",
        "link_title_store",
        "reminder_store",
        "search_history_store",
        "reset_sync_state",
        "reset_legacy_sync_state",
        "reset_all_undo_state",
        "lock_ontology_rules_store",
        "clear_encryption_key",
        "clear_cache",
        "note_store",
        "auth_cache_state",
        "file_registry",
        "hydration_state",
        "rebootstrap_encrypted_store_metadata",
        "bootstrap_file_registry",
    ]


def test_purge_rebootstraps_persistent_stores_for_next_login(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    dek = b"d" * 32
    try:
        set_encryption_required(True)
        set_session_dek(dek)

        assert runtime_lock.purge_decrypted_runtime_state() is True

        set_session_dek(dek)
        runtime_lock.tab_state_store.ensure_decrypted(token="")
        runtime_lock.link_title_store.ensure_decrypted(token="")
        runtime_lock.reminder_store.ensure_decrypted(token="")
        runtime_lock.search_history_store.ensure_decrypted(token="")
    finally:
        clear_encryption_key()
        set_encryption_required(False)
        runtime_lock.tab_state_store.reset()
        runtime_lock.link_title_store.reset()
        runtime_lock.reminder_store.reset()
        runtime_lock.search_history_store.reset()
        SafeSession.use_file_db()
