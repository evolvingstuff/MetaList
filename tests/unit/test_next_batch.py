from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.api.middleware import auth as auth_middleware
from app.services import tokens
import json
import sqlite3
from datetime import datetime, timezone
from types import SimpleNamespace
import pytest
from app.services import view_cache as view_module, root_sorting
from app.services.hierarchy import hierarchy_depths, validate_database_parent, HierarchyError
from app.models.utils import render_note_data_read_only, note_data_to_html, note_data_to_plain_text
from app.models import database as database_module
from app.models.database import SafeSession
from app.security.sensitive_cache import sensitive_lru_cache, enable_sensitive_caches
from app.services.view_cache import ViewCache
from app.services.view_state import ViewState
from app.services import undo_state, snapshot, html_export, note_store as note_store_module, sync
from app.services.note_store import NoteStore
from app.services.search_index import SearchIndex
from app.services.tag_ontology import TagOntology
from app.services.agent.evidence_serialization import serialize_evidence_result_trees
from app.usecases import copy_note
from app.services import windows_process_control


def test_view_cache_retains_only_current_search_per_tab():
    cache = ViewCache()
    state = ViewState([], {}, {}, {}, {}, {})
    for number in range(200):
        cache.set(client_id='client', tab_id='tab', search=str(number), sort_mode='normal', is_untagged_view=False, state=state)
    assert len(cache._cache) == 1
    assert cache.get(client_id='client', tab_id='tab', search='old', sort_mode='normal', is_untagged_view=False) is None


def test_undo_history_discards_complete_old_operations():
    undo_state.reset_all_undo_state()
    for number in range(150):
        undo_state.record_update('client','context','note',before=str(number),after=str(number+1),before_tags='',after_tags='',viewport={'scrollY':0,'scrollAnchor':None})
    assert len(undo_state._clients['client'].history) == 100
    assert undo_state._clients['client'].history[0]['before'] == '50'
    undo_state.reset_all_undo_state()


def test_view_byte_budget_does_not_retain_oversized_baseline(monkeypatch):
    monkeypatch.setattr(view_module, 'VIEW_BYTES', 4096)
    cache = ViewCache()
    cache.set(client_id='client',tab_id='tab',search='',sort_mode='normal',is_untagged_view=False,state=ViewState([],{}, {},{}, {},{'large':'x'*8192}))
    assert cache.diagnostics()['bytes'] == 0


def test_oversized_undo_operation_clears_history_without_splitting(monkeypatch):
    monkeypatch.setattr(undo_state, 'UNDO_BYTES', 4096)
    undo_state.reset_all_undo_state()
    undo_state.record_update('client','context','note',before='a',after='x'*8192,before_tags='',after_tags='',viewport={'scrollY':0,'scrollAnchor':None})
    assert undo_state._clients['client'].history == []
    assert undo_state.undo_history_limited('client')
    undo_state.reset_all_undo_state()


def test_hierarchy_depth_limit_and_cycles():
    parents = {str(i):str(i-1) if i else None for i in range(256)}
    assert hierarchy_depths(parents)['255'] == 256
    parents['256'] = '255'
    with pytest.raises(HierarchyError, match='256'):
        hierarchy_depths(parents)
    with pytest.raises(HierarchyError, match='cycle'):
        hierarchy_depths({'a':'b','b':'a'})


def test_parent_validation_rejects_deep_and_cyclic_moves_before_write():
    with sqlite3.connect(':memory:') as connection:
        connection.execute('CREATE TABLE notes (id TEXT PRIMARY KEY, parent_id TEXT)')
        connection.executemany('INSERT INTO notes VALUES (?,?)', [(str(i),str(i-1) if i else None) for i in range(256)])
        with pytest.raises(HierarchyError, match='256'):
            validate_database_parent(connection, 'new', '255', is_new=True)
        with pytest.raises(HierarchyError, match='own subtree'):
            validate_database_parent(connection, '0', '10', is_new=False)
        assert connection.execute('SELECT count(*) FROM notes').fetchone()[0] == 256


def test_clipboard_rendering_handles_a_deep_supported_chain():
    root = {'content':'root','tags':'','children':[]}
    current = root
    for index in range(255):
        child = {'content':f'child-{index}','tags':'','children':[]}
        current['children'].append(child)
        current = child
    rendered = render_note_data_read_only(root)
    assert 'child-254' in note_data_to_plain_text(rendered)
    assert 'child-254' in note_data_to_html(rendered)


def test_root_metrics_reuse_work_and_invalidate_after_change(monkeypatch):
    now = datetime.now(timezone.utc)
    records = {'a':SimpleNamespace(content='a',parent_id=None,created_at=now,updated_at=now),
               'b':SimpleNamespace(content='longer',parent_id=None,created_at=now,updated_at=now)}
    class Store:
        revision = 0
        snapshots = 0
        def snapshot(self):
            self.snapshots += 1
            return dict(records)
        def get_children(self, parent):
            assert parent is None
            return list(records)
    store = Store()
    monkeypatch.setattr(root_sorting, 'note_store', store)
    root_sorting.clear_root_sort_cache()
    assert root_sorting.get_root_ids_for_sort_mode('content-volume', root_timestamps={}) == ['b','a']
    assert root_sorting.get_root_ids_for_sort_mode('content-volume', root_timestamps={}) == ['b','a']
    assert store.snapshots == 1
    records['a'].content = 'x'*20
    store.revision += 1
    assert root_sorting.get_root_ids_for_sort_mode('content-volume', root_timestamps={}) == ['a','b']
    assert store.snapshots == 2
    root_sorting.clear_root_sort_cache()


def test_database_connections_do_not_repeat_schema_bootstrap(monkeypatch):
    SafeSession.use_memory_db()
    monkeypatch.setattr(database_module, 'initialize_schema', lambda connection: pytest.fail('Repeated schema initialization'))
    for _ in range(3):
        session = SafeSession()
        session.close()


def test_sensitive_cache_does_not_keep_large_plaintext_keys():
    enable_sensitive_caches()
    @sensitive_lru_cache(maxsize=10, max_bytes=1024)
    def size(value):
        return len(value)
    assert size('x'*2048) == 2048
    assert size.cache_info().currsize == 0
    assert size('small') == 5
    assert size.cache_info().currsize == 1
    size.cache_clear()


@pytest.fixture
def deep_store(monkeypatch):
    monkeypatch.setattr(note_store_module, 'search_index', SearchIndex())
    monkeypatch.setattr(note_store_module, 'get_cached_content', lambda note_id: 'level-' + note_id)
    monkeypatch.setattr(note_store_module, 'get_cached_text', lambda note_id: 'level-' + note_id)
    monkeypatch.setattr(note_store_module, 'get_cached_tags', lambda _: '')
    monkeypatch.setattr(note_store_module, 'get_cached_proposed_tags', lambda _: '')
    monkeypatch.setattr(note_store_module, 'get_ontology', TagOntology.empty)
    store = NoteStore()
    store._timing_enabled = False
    rows = []
    for i in range(256):
        parent_id = None
        if i > 0:
            parent_id = str(i - 1)
        rows.append(dict(id=str(i), parent_id=parent_id, prev_id=None, next_id=None, is_collapsed=False))
    store.load_from_db(None, prefetched_rows=rows)
    return store, rows


def test_deep_chain_hydrates_views_copies_exports_and_serializes(monkeypatch, deep_store):
    store, rows = deep_store
    monkeypatch.setattr(snapshot, 'note_store', store)
    monkeypatch.setattr(snapshot, 'get_all_locks', lambda: {})
    monkeypatch.setattr(root_sorting, 'note_store', store)
    monkeypatch.setattr(html_export, 'note_store', store)
    monkeypatch.setattr(copy_note, 'store', SimpleNamespace(get=store.get_note, children=store.get_children))
    state = snapshot.build_view_state(editing_note_id=None, search=None, sort_mode='normal', client_known_note_ids=set(), client_seen_root_ids=set(), anchor_root_id=None, is_untagged_view=False)
    assert len(state.structure) == 256
    assert len(copy_note.snapshot_subtree_preorder('0')) == 256
    assert 'level-255' in json.dumps(copy_note._build_serialized_tree('0'))
    assert 'level-255' in html_export.build_notes_export_document(search=None, theme='light', token='fixture-token', root_note_id=None)
    parents = {row['id']: row['parent_id'] or '' for row in rows}
    children = {row['id']: tuple(store.get_children(row['id'])) for row in rows}
    payload = serialize_evidence_result_trees(root_ids=('0',), evidence_payloads_by_id={'255': {'note_id':'255','content_text':'deep evidence'}}, parent_id_by_id=parents, child_ids_by_id=children)
    assert 'deep evidence' in json.dumps(payload)
    parents['0'] = '255'
    with pytest.raises(RuntimeError, match='cycle'):
        serialize_evidence_result_trees(root_ids=('0',), evidence_payloads_by_id={'255':{}}, parent_id_by_id=parents, child_ids_by_id=children)
    rows[0]['parent_id'] = '255'
    with pytest.raises(HierarchyError, match='cycle'):
        store.load_from_db(None, prefetched_rows=rows)


def test_windows_tree_cleanup_enumerates_descendants_before_killing(monkeypatch):
    calls = []
    monkeypatch.setattr(windows_process_control, '_run_powershell', lambda **kwargs: calls.append(kwargs))
    monkeypatch.setattr(windows_process_control, '_creation_filetime', lambda process: 1)
    windows_process_control.stop_process_tree(process=SimpleNamespace(pid=123))
    script = calls[0]['script']
    assert 'Get-CimInstance Win32_Process' in script
    assert 'ParentProcessId' in script
    assert '$pending.Count-1' in script
    assert 'Stop-Process -Force -ErrorAction Stop' in script


def test_protected_middleware_does_not_open_database_connections(monkeypatch):
    monkeypatch.setattr(tokens, 'get_session_timeout_minutes', lambda: 0)
    service = tokens.TokenService()
    token = service.create_token('fixture', 'fixture-tab', dek=None)
    monkeypatch.setattr(auth_middleware, 'token_service', service)
    monkeypatch.setattr(SafeSession, '_create_connection', lambda: pytest.fail('Ordinary auth opened SQLite'))
    app = FastAPI()
    app.add_middleware(auth_middleware.AuthMiddleware)
    @app.get('/api2/fixture')
    def endpoint():
        return {'ok': True}
    client = TestClient(app)
    response = client.get('/api2/fixture', headers={'Authorization':'Bearer '+token, 'X-Metalist-Tab-Id':'fixture-tab'})
    assert response.status_code == 200
    assert response.json() == {'ok': True}


def test_client_expiry_releases_clipboard_locks_and_view_baselines(monkeypatch):
    now = [0.0]
    monkeypatch.setattr(sync, 'monotonic', lambda: now[0])
    monkeypatch.setattr(view_module, 'monotonic', lambda: now[0])
    sync.reset_state()
    sync.acquire_note_lock('note', 'old-client')
    sync.set_clipboard('old-client', [{'content':'private'}])
    cache = ViewCache()
    cache.set(client_id='old-client',tab_id='tab',search='',sort_mode='normal',is_untagged_view=False,state=ViewState([],{}, {},{}, {},{}))
    now[0] = 1801
    sync.touch_client('new-client')
    assert sync.get_all_locks() == {}
    assert sync._clipboards == {}
    assert cache.diagnostics()['entries'] == 0
    sync.reset_state()


def test_cycles_fail_in_view_copy_and_export(monkeypatch, deep_store):
    store, _ = deep_store
    original_children = store.get_children
    monkeypatch.setattr(store, 'get_children', lambda parent: ['0'] if parent == '255' else original_children(parent))
    monkeypatch.setattr(snapshot, 'note_store', store)
    monkeypatch.setattr(snapshot, 'get_all_locks', lambda: {})
    monkeypatch.setattr(root_sorting, 'note_store', store)
    monkeypatch.setattr(html_export, 'note_store', store)
    monkeypatch.setattr(copy_note, 'store', SimpleNamespace(get=store.get_note, children=store.get_children))
    with pytest.raises(RuntimeError, match='[Cc]ycle'):
        snapshot.build_view_state(editing_note_id=None,search=None,sort_mode='normal',client_known_note_ids=set(),client_seen_root_ids=set(),anchor_root_id=None,is_untagged_view=False)
    with pytest.raises(RuntimeError, match='[Cc]ycle'):
        copy_note.snapshot_subtree_preorder('0')
    with pytest.raises(RuntimeError, match='[Cc]ycle'):
        html_export._render_exported_note(note_id='0', allowed_note_ids=None, embed_render_context=None)


def test_sort_aggregates_follow_edits_moves_deletes_and_hydration(monkeypatch, deep_store):
    store, rows = deep_store
    monkeypatch.setattr(root_sorting, 'note_store', store)
    root_sorting.clear_root_sort_cache()
    initial = root_sorting._get_root_subtree_content_volume('0')
    store.update_note_from_db(SimpleNamespace(id='255'), plaintext='x'*100, tags='', proposed_tags='')
    assert root_sorting._get_root_subtree_content_volume('0') == initial - len('level-255') + 100
    store.bulk_update_metadata([SimpleNamespace(id='0', next_id='255'), SimpleNamespace(id='255',parent_id=None,prev_id='0',next_id=None)], rebuild=True)
    assert root_sorting._get_root_subtree_content_volume('255') == 100
    assert root_sorting._get_root_subtree_content_volume('0') == initial - len('level-255')
    store.remove_note('255')
    assert root_sorting.get_root_ids_for_sort_mode('content-volume', root_timestamps={}) == ['0']
    store.load_from_db(None, prefetched_rows=rows)
    assert root_sorting._get_root_subtree_content_volume('0') == initial
    root_sorting.clear_root_sort_cache()


def test_timestamp_sort_does_not_parse_html(monkeypatch, deep_store):
    store, _ = deep_store
    monkeypatch.setattr(root_sorting, 'note_store', store)
    monkeypatch.setattr(root_sorting, 'strip_html', lambda content: pytest.fail('Timestamp sort parsed HTML'))
    root_sorting.clear_root_sort_cache()
    # This fixture intentionally has absent dates; metrics may carry that value,
    # while the public timestamp accessor rejects it if requested for display.
    assert root_sorting._metrics(include_text=False)['0']['updated'] is None
    root_sorting.clear_root_sort_cache()


def test_timestamp_aggregate_does_not_hide_invalid_descendant_dates(monkeypatch, deep_store):
    store, _ = deep_store
    now = datetime.now(timezone.utc)
    store.update_note_from_db(SimpleNamespace(id='0', created_at=now, updated_at=now), plaintext='root', tags='', proposed_tags='')
    monkeypatch.setattr(root_sorting, 'note_store', store)
    root_sorting.clear_root_sort_cache()
    with pytest.raises(RuntimeError, match='timestamps'):
        root_sorting.get_root_sort_timestamps('updated')
    root_sorting.clear_root_sort_cache()


def test_creation_sort_reads_only_roots_without_snapshotting_descendants(monkeypatch, deep_store):
    store, _ = deep_store
    now = datetime.now(timezone.utc)
    store.update_note_from_db(SimpleNamespace(id='0', created_at=now, updated_at=now), plaintext='root', tags='', proposed_tags='')
    monkeypatch.setattr(root_sorting, 'note_store', store)
    monkeypatch.setattr(store, 'snapshot', lambda: pytest.fail('Creation sorting traversed descendants'))
    assert root_sorting.get_root_sort_timestamps('created') == {'0': now}
