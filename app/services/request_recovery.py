"""Reload persisted runtime state after a failed mutating HTTP request."""

from app.db.session import after_request_rollback, current_request_state
from app.db.settings_sql import fetch_settings
from app.models.database import SafeSession
from app.security.encryption import get_encryption_service, set_encryption_required, set_session_dek, clear_encryption_key
from app.services import auth_cache_state
from app.services.content_cache import clear_cache, populate_cache_from_db
from app.services.file_registry import file_registry
from app.services.file_storage import bootstrap_file_registry
from app.services.link_titles import link_title_store
from app.services.note_store import store
from app.services.ontology_rules_store import bootstrap_ontology_rules_store, ensure_rules_decrypted_and_compiled
from app.services.reminders import reminder_store
from app.services.search_history import search_history_store
from app.services.sound_storage import sound_store
from app.services.tab_state import tab_state_store
from app.services.view_cache import view_cache
from app.services.sync import capture_sync_state, restore_sync_state
from app.services.undo_state import capture_undo_state, restore_undo_state
from app.services.maintenance_mode import maintenance_service
from app.services.tokens import token_service
from app.security.sensitive_cache import disable_and_clear_sensitive_caches
from app.services.runtime_generation import invalidate_runtime_work


def register_runtime_recovery() -> None:
    state = current_request_state()
    if state is None:
        raise RuntimeError('Runtime recovery requires a request transaction')
    was_loaded = store.loaded
    encryption = get_encryption_service()
    dek = None
    if encryption is not None:
        dek = encryption.dek
    undo = capture_undo_state()
    sync = capture_sync_state()

    def recover() -> None:
        restore_undo_state(undo)
        restore_sync_state(sync)
        if not (state.did_write or state.recoveries):
            return
        recovered = False
        try:
            reload_runtime_from_database(was_loaded=was_loaded, dek=dek)
            recovered = True
        finally:
            if not recovered:
                maintenance_service.enter_maintenance("Database recovery failed; restart after resolving the storage error")
                token_service.revoke_all_tokens()
                invalidate_runtime_work()
                disable_and_clear_sensitive_caches()
                clear_encryption_key()
                clear_cache()
                store.reset()

    after_request_rollback(recover)


def reload_runtime_from_database(*, was_loaded: bool, dek: bytes | None) -> None:
    # Rebuild only on failure; ordinary edits do not copy the full namespace.
    view_cache.clear()
    clear_cache()
    store.reset()
    file_registry.reset()
    session = SafeSession()
    try:
        with SafeSession.allow_reads('request rollback recovery'):
            connection = session.connection()
            settings = fetch_settings(connection)
            encrypted = settings is not None and bool(settings['encryption_enabled'])
            set_encryption_required(encrypted)
            clear_encryption_key()
            if encrypted and dek is not None:
                set_session_dek(dek)
            bootstrap_ontology_rules_store(connection=connection)
            tab_state_store.bootstrap(connection=connection)
            link_title_store.reset()
            link_title_store.bootstrap(connection=connection)
            reminder_store.bootstrap(connection=connection)
            search_history_store.bootstrap(connection=connection)
            bootstrap_file_registry()
            if was_loaded and (not encrypted or dek is not None):
                ensure_rules_decrypted_and_compiled(token='')
                tab_state_store.ensure_decrypted(token='')
                link_title_store.ensure_decrypted(token='')
                reminder_store.ensure_decrypted(token='')
                search_history_store.ensure_decrypted(token='')
                sound_store.bootstrap(token='')
                rows = populate_cache_from_db(session)
                store.load_from_db(None, prefetched_rows=rows)
                auth_cache_state.mark_cache_ready()
            else:
                sound_store.reset()
                auth_cache_state.reset_cache_state()
    finally:
        session.close()
