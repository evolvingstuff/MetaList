from types import SimpleNamespace
from app.models.database import SafeSession
from app.models import note_crud, list_operations
from app.services import store as adapter_module
from app.security import encryption
from app.usecases.delete_subtree import apply_delete_subtree, apply_restore_records
from app.usecases.move import apply_move

import pytest

from app.services import note_store as module
from app.services.note_store import NoteStore
from app.services.hierarchy import HierarchyError
from app.services.search_index import SearchIndex
from app.services.tag_ontology import TagOntology


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setattr(module, 'search_index', SearchIndex())
    monkeypatch.setattr(module, 'get_cached_content', lambda note_id: note_id)
    monkeypatch.setattr(module, 'get_cached_text', lambda note_id: note_id)
    monkeypatch.setattr(module, 'get_cached_tags', lambda _: '')
    monkeypatch.setattr(module, 'get_cached_proposed_tags', lambda _: '')
    monkeypatch.setattr(module, 'get_ontology', TagOntology.empty)
    store = NoteStore()
    store._timing_enabled = False
    store.load_from_db(None, prefetched_rows=[
        dict(id='a', parent_id=None, prev_id=None, next_id='b', is_collapsed=False),
        dict(id='b', parent_id=None, prev_id='a', next_id=None, is_collapsed=False),
    ])
    return store


def test_record_pointers_are_authoritative_without_a_duplicate_link_map(store):
    assert not hasattr(store, '_links')
    assert store._note_map['a'].next_id == 'b'
    assert store.get_note('a').next_id == 'b'
    assert store.snapshot()['b'].prev_id == 'a'


def test_insert_collapse_and_metadata_refresh_preserve_order_and_old_snapshots(store):
    before = store.get_note('a')
    store.add_note_from_db(SimpleNamespace(id='new',parent_id=None,prev_id=None,next_id='a',is_collapsed=False), 'new', '', '')
    store.set_collapsed('b', True)
    store.bulk_update_metadata([SimpleNamespace(id='a', updated_at=None)], rebuild=True)
    assert store.get_children(None) == ['new','a','b']
    assert before.prev_id is None
    assert store.get_note('a').prev_id == 'new'
    store.remove_note('new')
    assert store.get_children(None) == ['a','b']
    assert store.get_note('a').prev_id is None


def test_corrupt_sibling_cycle_is_rejected_instead_of_reordered(store):
    original = store.snapshot()
    rows = [dict(id='a',parent_id=None,prev_id='b',next_id='b',is_collapsed=False),
            dict(id='b',parent_id=None,prev_id='a',next_id='a',is_collapsed=False)]
    with pytest.raises(RuntimeError, match='[Oo]rder|[Ll]ink|[Cc]ycle'):
        store.load_from_db(None, prefetched_rows=rows)
    assert store.snapshot() == original
    assert store.get_children(None) == ['a', 'b']


def test_bulk_metadata_validates_hierarchy_before_publishing(store):
    original = store.snapshot()
    with pytest.raises(HierarchyError, match='[Cc]ycle'):
        store.bulk_update_metadata([
            SimpleNamespace(id='a', parent_id='b', prev_id=None, next_id=None),
            SimpleNamespace(id='b', parent_id='a', prev_id=None, next_id=None),
        ], rebuild=True)
    assert store.snapshot() == original
    assert store.get_children(None) == ['a', 'b']


def test_bulk_metadata_rejects_missing_records(store):
    with pytest.raises(KeyError, match='missing'):
        store.bulk_update_metadata([SimpleNamespace(id='missing', updated_at=None)], rebuild=True)


@pytest.fixture
def database_store(store, monkeypatch):
    SafeSession.use_memory_db()
    SafeSession.disable_read_guard()
    encryption.set_encryption_required(False)
    store.load_from_db(None, prefetched_rows=[])
    monkeypatch.setattr(note_crud, 'note_store', store)
    monkeypatch.setattr(list_operations, 'note_store', store)
    monkeypatch.setattr(adapter_module, '_note_store', store)
    session = SafeSession()
    for note_id in ['tail', 'middle', 'head']:
        note_crud.NoteCRUD.create_note_top(session, note_id, None)
    session.commit()
    yield store, session
    session.close()


def test_database_delete_middle_keeps_neighbors_and_hydration_consistent(database_store):
    store, session = database_store
    note_crud.NoteCRUD.delete_note(session, 'middle')
    session.commit()
    assert store.get_children(None) == ['head', 'tail']
    store.load_from_db(session, prefetched_rows=None)
    assert store.get_children(None) == ['head', 'tail']


def test_database_cross_parent_move_and_undo_delete_restore(database_store):
    store, session = database_store
    list_operations.ListOperations.move_note(session, 'middle', 'head', None, None)
    session.commit()
    assert store.get_children(None) == ['head', 'tail']
    assert store.get_children('head') == ['middle']
    snapshot = [store.get_note('head'), store.get_note('middle')]
    apply_delete_subtree('head')
    assert store.get_children(None) == ['tail']
    apply_restore_records(snapshot, '')
    assert store.get_children(None) == ['head','tail']
    assert store.get_children('head') == ['middle']
    apply_move('middle', None, 'head', 'tail')
    assert store.get_children(None) == ['head','middle','tail']
    store.load_from_db(session, prefetched_rows=None)
    assert store.get_children(None) == ['head','middle','tail']
