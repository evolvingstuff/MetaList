from pathlib import Path
import hashlib
import sqlite3
import asyncio
from dataclasses import replace

import pytest

from app.api.transactions import transactional_route
from app.db.file_schema import initialize_file_schema
from app.db.file_session import resolve_file_database_path
from app.db.schema import initialize_schema
from app.db.session import begin_request_transaction, get_request_session
from app.models.database import SafeSession
from app.security.encryption import clear_encryption_key, set_encryption_required, set_session_dek
from app.services import auth_service, backup_service, runtime_lock
from app.services.agent.evidence_serialization import EvidenceNoteTokenSource, EvidenceTreeTokenSource
from app.services.agent.evidence_serialization import estimate_cached_root_tree_tokens, _estimate_cached_root_tree_tokens
from app.services.ai_chat import AiChatSessionStore
from app.services.agent.cloud_privacy import CloudPrivacyEvaluator, resolve_cloud_privacy_boundary
from app.services.search_index import search_index
from app.services.sync import capture_sync_state, generate_new_uuid
from app.services.undo_state import capture_undo_state
from app.services.runtime_generation import current_generation, invalidate_runtime_work, register_current_task, unregister_task
from app.services import link_titles, namespace_switcher, request_recovery
from app.services.maintenance_mode import maintenance_service
from app.server_runtime import NamespaceLaunchProfile
from app.services.content_cache import clear_cache
from app.services.file_registry import file_registry
from app.services.file_storage import create_file
from app.services.note_store import store
from app.services.ontology_rules_store import bootstrap_ontology_rules_store
from app.services.tag_term_matching import split_tag_term_segments, _split_tag_term_segments_cached
from app.usecases.create_note import apply_insert_note
from app.usecases.update_content import apply_update_content


@pytest.fixture
def live_database(tmp_path, monkeypatch):
    monkeypatch.setattr(SafeSession, '_db_path', tmp_path / 'fixture.metalist.db')
    monkeypatch.setattr(SafeSession, '_use_memory', False)
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


def test_password_creation_failure_restores_sidecar_and_key_metadata(live_database, monkeypatch):
    record = create_file(original_filename='fixture.txt', mime_type='text/plain', content_bytes=b'fixture', token='fixture')
    def fail_history_rewrite(**kwargs):
        raise OSError('injected sidecar failure')
    monkeypatch.setattr(auth_service, 'encrypt_all_search_history_for_active_dek', fail_history_rewrite)
    with pytest.raises(OSError, match='injected sidecar'):
        with begin_request_transaction():
            auth_service.AuthService(live_database).set_password('aQ7!mZ2#vL9@xR4', 1)
    settings = live_database.connection().execute('SELECT encryption_enabled, encrypted_dek FROM app_settings').fetchone()
    with sqlite3.connect(resolve_file_database_path(SafeSession._db_path)) as connection:
        row = connection.execute('SELECT blob_data, blob_encryption_nonce FROM files WHERE id=?', (record.id,)).fetchone()
    assert settings[0] == 0 and settings[1] is None
    assert row == (b'fixture', None)


def test_switching_provider_does_not_replay_local_answer():
    chat = AiChatSessionStore()
    turn = chat.start_turn(session_key='fixture', user_content='Read local notes', provider='ollama', model='local')
    chat.complete_turn(session_key='fixture', turn_id=turn, final_content='LOCAL_ONLY_CANARY')
    chat.start_turn(session_key='fixture', user_content='Hello cloud', provider='openai', model='cloud')
    assert chat.provider_messages(session_key='fixture') == [{'role':'user', 'content':'Hello cloud'}]
    assert 'LOCAL_ONLY_CANARY' in str(chat.snapshot(session_key='fixture'))


def test_logout_clears_sensitive_function_caches(monkeypatch):
    set_encryption_required(True)
    set_session_dek(b'0' * 32)
    note = EvidenceNoteTokenSource('fixture', 'PRIVATE_CANARY', (), (), '', '')
    node = EvidenceTreeTokenSource('fixture', '', ())
    estimate_cached_root_tree_tokens(root_id='fixture', evidence_notes=(note,), structure_nodes=(node,))
    split_tag_term_segments('Private-Canary')
    monkeypatch.setattr(runtime_lock, '_rebootstrap_encrypted_store_metadata', lambda: None)
    monkeypatch.setattr(runtime_lock, 'bootstrap_file_registry', lambda: None)
    try:
        assert runtime_lock.purge_decrypted_runtime_state()
        assert _estimate_cached_root_tree_tokens.cache_info().currsize == 0
        assert _split_tag_term_segments_cached.cache_info().currsize == 0
        split_tag_term_segments('Late-private-value')
        assert _split_tag_term_segments_cached.cache_info().currsize == 0
    finally:
        clear_encryption_key()
        set_encryption_required(False)


def test_failed_request_restores_note_memory_and_database(live_database):
    apply_insert_note('fixture', None, None, None, '', content='before', tags='', proposed_tags='')
    @transactional_route
    def failing_save():
        apply_update_content('fixture', 'after', '', '')
        raise OSError('injected later failure')
    with pytest.raises(OSError, match='injected later'):
        failing_save()
    assert live_database.connection().execute('SELECT content FROM notes').fetchone()[0] == 'before'
    assert store.get_note('fixture').content == 'before'


def test_restore_failure_preserves_complete_live_database_set(tmp_path, monkeypatch):
    notes = tmp_path / 'fixture.metalist.db'
    files = resolve_file_database_path(notes)
    for path, initialize in ((notes, initialize_schema), (files, initialize_file_schema)):
        with sqlite3.connect(path) as connection:
            initialize(connection)
            connection.execute('CREATE TABLE review_marker(value TEXT)')
            connection.execute("INSERT INTO review_marker VALUES ('old')")
    archive = backup_service.create_timestamped_backup_for_paths(notes, tmp_path / 'backups')
    archive_path = tmp_path / 'backups' / archive.filename
    source_hash = hashlib.sha256(archive_path.read_bytes()).digest()
    for path in (notes, files):
        with sqlite3.connect(path) as connection:
            connection.execute("UPDATE review_marker SET value='new'")
    original_copy = backup_service._copy_database
    def fail_second_copy(source, target):
        if target == files:
            raise OSError('injected second database failure')
        original_copy(source, target)
    monkeypatch.setattr(backup_service, '_copy_database', fail_second_copy)
    with pytest.raises(OSError, match='injected second'):
        backup_service.restore_backup_to_paths(archive_path, notes)
    for path in (notes, files):
        with sqlite3.connect(path) as connection:
            assert connection.execute('SELECT value FROM review_marker').fetchone()[0] == 'new'
    assert hashlib.sha256(archive_path.read_bytes()).digest() == source_hash


@pytest.mark.parametrize('failure_stage', ['history_rewrite', 'main_commit'])
def test_password_removal_failure_keeps_files_encrypted_and_key_recoverable(live_database, monkeypatch, failure_stage):
    record = create_file(original_filename='fixture.txt', mime_type='text/plain', content_bytes=b'fixture', token='fixture')
    auth = auth_service.AuthService(live_database)
    password = 'aQ7!mZ2#vL9@xR4'
    assert auth.set_password(password, 1)[0]
    before = live_database.connection().execute('SELECT encrypted_dek FROM app_settings').fetchone()[0]
    with sqlite3.connect(resolve_file_database_path(SafeSession._db_path)) as connection:
        original_file = connection.execute('SELECT blob_data, blob_encryption_nonce FROM files WHERE id=?', (record.id,)).fetchone()
    def fail(*args, **kwargs):
        raise OSError('injected transition failure')
    with pytest.raises(OSError, match='injected transition'):
        with begin_request_transaction():
            if failure_stage == 'history_rewrite':
                monkeypatch.setattr(auth_service, 'decrypt_all_search_history_for_plaintext', fail)
            else:
                monkeypatch.setattr(get_request_session(), 'commit', fail)
            auth.remove_password(password)
    settings = live_database.connection().execute('SELECT encryption_enabled, encrypted_dek FROM app_settings').fetchone()
    assert settings[0] == 1 and settings[1] == before
    with sqlite3.connect(resolve_file_database_path(SafeSession._db_path)) as connection:
        assert connection.execute('SELECT blob_data, blob_encryption_nonce FROM files WHERE id=?', (record.id,)).fetchone() == original_file
    assert len(auth.unwrap_dek_for_password(password)) == 32


def test_commit_failure_restores_search_content_sync_and_undo(live_database, monkeypatch):
    apply_insert_note('fixture', None, None, None, '', content='before', tags='original', proposed_tags='')
    original_sync, original_undo = capture_sync_state(), capture_undo_state()
    def fail_commit():
        raise OSError('injected commit failure')
    @transactional_route
    def failing_save():
        monkeypatch.setattr(get_request_session(), 'commit', fail_commit)
        apply_update_content('fixture', 'after', 'changed', '')
        generate_new_uuid()
    with pytest.raises(OSError, match='injected commit'):
        failing_save()
    assert store.get_note('fixture').content == 'before'
    assert search_index.query_note_ids('original') == {'fixture'}
    assert search_index.query_note_ids('changed') == set()
    assert capture_sync_state() == original_sync
    assert capture_undo_state() == original_undo
    assert live_database.connection().execute('SELECT content FROM notes').fetchone()[0] == 'before'


@pytest.mark.parametrize('change', ['policy', 'password_tag', 'deleted_note'])
def test_privacy_change_excludes_prior_answer_even_with_empty_followup_scope(live_database, change):
    apply_insert_note('fixture', None, None, None, '', content='PRIVATE_CANARY', tags='', proposed_tags='')
    evaluator = CloudPrivacyEvaluator(notes=store, effective_tags_provider=lambda note_id: store.get_note(note_id).tag_terms)
    boundary = resolve_cloud_privacy_boundary(preferences={}, provider='openai')
    chat = AiChatSessionStore()
    first_key = evaluator.history_disclosure_key(boundary=boundary)
    chat.synchronize_disclosure_boundary(session_key='fixture', disclosure_key=first_key)
    turn = chat.start_turn(session_key='fixture', user_content='Read notes', provider='openai', model='cloud')
    chat.complete_turn(session_key='fixture', turn_id=turn, final_content='PRIVATE_CANARY')
    chat.synchronize_disclosure_boundary(session_key='fixture', disclosure_key=first_key)
    assert 'PRIVATE_CANARY' in str(chat.provider_messages(session_key='fixture'))
    if change == 'policy':
        boundary = replace(boundary, policy=replace(boundary.policy, blacklist_phrases=('PRIVATE_CANARY',)))
    elif change == 'password_tag':
        apply_update_content('fixture', 'PRIVATE_CANARY', '@password', '')
    else:
        store.reset()
        store.load_from_db(None, prefetched_rows=[])
    next_key = evaluator.history_disclosure_key(boundary=boundary)
    assert next_key != first_key
    chat.synchronize_disclosure_boundary(session_key='fixture', disclosure_key=next_key)
    chat.start_turn(session_key='fixture', user_content='Hello', provider='openai', model='cloud')
    assert chat.provider_messages(session_key='fixture') == [{'role': 'user', 'content': 'Hello'}]
    assert 'PRIVATE_CANARY' in str(chat.snapshot(session_key='fixture'))


def test_old_link_title_work_cannot_publish_after_runtime_replacement(monkeypatch):
    generation = current_generation()
    invalidate_runtime_work()
    calls = []
    monkeypatch.setattr(link_titles.link_title_store, 'apply_fetch_result', lambda value: calls.append(value))
    link_titles.link_title_store.apply_current_fetch_result(object(), generation)
    assert calls == []


def test_runtime_invalidation_cancels_streaming_work():
    async def scenario():
        ready = asyncio.Event()
        async def worker():
            task = register_current_task()
            try:
                ready.set()
                await asyncio.Event().wait()
            finally:
                unregister_task(task)
        worker_task = asyncio.create_task(worker())
        await ready.wait()
        invalidate_runtime_work()
        with pytest.raises(asyncio.CancelledError):
            await worker_task
        assert worker_task.cancelled()
    asyncio.run(scenario())


@pytest.mark.parametrize('verified', [True, False])
def test_cross_namespace_restore_stops_only_verified_target(monkeypatch, verified):
    profile = NamespaceLaunchProfile(namespace='fixture', port=8123, https_port=None, mcp_port=None)
    stopped = []
    monkeypatch.setattr(namespace_switcher, 'load_all_namespace_launch_profiles_read_only', lambda: [profile])
    port = None
    if verified:
        port = 8123
    monkeypatch.setattr(namespace_switcher, '_find_running_namespace_port', lambda **kwargs: port)
    monkeypatch.setattr(namespace_switcher, '_find_listening_pids_for_port', lambda **kwargs: [123])
    monkeypatch.setattr(namespace_switcher, '_stop_processes_listening_on_port', lambda **kwargs: stopped.append(kwargs['port']))
    if verified:
        namespace_switcher.stop_namespace_for_restore(namespace='fixture')
        assert stopped == [8123]
    else:
        with pytest.raises(RuntimeError, match='Cannot verify'):
            namespace_switcher.stop_namespace_for_restore(namespace='fixture')
        assert stopped == []


def test_storage_maintenance_lasts_through_commit(live_database, monkeypatch):
    observed = []
    @transactional_route
    def create_password():
        session = get_request_session()
        original_commit = session.commit
        def observe_commit():
            observed.append(maintenance_service.is_active())
            original_commit()
        monkeypatch.setattr(session, 'commit', observe_commit)
        maintenance_service.enter_maintenance('inner operation')
        maintenance_service.exit_maintenance()
        assert maintenance_service.is_active()
    create_password()
    assert observed == [True]
    assert not maintenance_service.is_active()



def test_failed_runtime_recovery_blocks_requests_and_discards_served_state(live_database, monkeypatch):
    apply_insert_note('fixture', None, None, None, '', content='before', tags='', proposed_tags='')
    revoked = []
    def fail_recovery(**kwargs):
        raise OSError('injected recovery read failure')
    monkeypatch.setattr(request_recovery, 'reload_runtime_from_database', fail_recovery)
    monkeypatch.setattr(request_recovery.token_service, 'revoke_all_tokens', lambda: revoked.append(True))
    @transactional_route
    def failing_save():
        apply_update_content('fixture', 'after', '', '')
        raise OSError('original save failure')
    try:
        with pytest.raises(OSError, match='recovery read'):
            failing_save()
        assert maintenance_service.is_active()
        assert not store.loaded
        assert revoked == [True]
        assert live_database.connection().execute('SELECT content FROM notes').fetchone()[0] == 'before'
    finally:
        maintenance_service.exit_maintenance()
