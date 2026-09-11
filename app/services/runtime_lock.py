"""Fail-closed teardown of decrypted in-memory namespace state."""

from __future__ import annotations

from app.security.encryption import clear_encryption_key
from app.security.encryption import is_encryption_available
from app.security.encryption import is_encryption_required
from app.models.database import SafeSession
from app.services import auth_cache_state
from app.services.content_cache import clear_cache
from app.services.file_registry import file_registry
from app.services.file_storage import bootstrap_file_registry
from app.services.hydration_state import hydration_state
from app.services.link_titles import link_title_store
from app.services.note_store import store as note_store
from app.services.ontology_rules_store import lock_ontology_rules_store
from app.services.reminders import reminder_store
from app.services.remote_image_proxy import remote_image_proxy_registry
from app.services.search_history import search_history_store
from app.services.sound_storage import sound_store
from app.services.sync import reset_state as reset_sync_state
from app.services.sync_state import reset_state as reset_legacy_sync_state
from app.services.tab_state import tab_state_store
from app.services.undo_state import reset_all_undo_state
from app.services.view_cache import view_cache
from app.services.ai_chat import ai_chat_store
from app.services.agent.trace import agent_trace_store


def _rebootstrap_encrypted_store_metadata() -> None:
    session = SafeSession()
    try:
        with SafeSession.allow_reads("runtime_lock:encrypted_store_metadata"):
            connection = session.connection()
            tab_state_store.bootstrap(connection=connection)
            link_title_store.bootstrap(connection=connection)
            reminder_store.bootstrap(connection=connection)
            search_history_store.bootstrap(connection=connection)
    finally:
        session.close()


def purge_decrypted_runtime_state() -> bool:
    """Purge plaintext-bearing stores when an encrypted namespace locks."""
    if not is_encryption_required():
        return False
    if not is_encryption_available(""):
        return False

    view_cache.clear()
    ai_chat_store.reset()
    agent_trace_store.reset()
    tab_state_store.reset()
    link_title_store.reset()
    reminder_store.reset()
    remote_image_proxy_registry.reset()
    search_history_store.reset()
    sound_store.reset()
    reset_sync_state()
    reset_legacy_sync_state()
    reset_all_undo_state()
    lock_ontology_rules_store()
    clear_encryption_key()
    clear_cache()
    note_store.reset()
    auth_cache_state.reset_cache_state()
    file_registry.reset()
    hydration_state.reset()
    _rebootstrap_encrypted_store_metadata()
    bootstrap_file_registry()
    return True
