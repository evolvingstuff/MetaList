from datetime import datetime, timezone
from types import SimpleNamespace
from app.db.notes_sql import insert_note
from app.models.database import SafeSession
from app.services import store as adapter_module
from app.security import encryption
from app.usecases.delete_subtree import _snapshot_subtree, apply_delete_subtree, apply_restore_records
from app.usecases.move import CmdMove, apply_move

import pytest

from app.services import note_store as module
from app.services.note_store import NotePosition
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
        dict(id='a', parent_id=None, prev_id=None, next_id='b', is_collapsed=False, created_at=None, updated_at=None),
        dict(id='b', parent_id=None, prev_id='a', next_id=None, is_collapsed=False, created_at=None, updated_at=None),
    ])
    return store


def test_record_pointers_are_authoritative_without_a_duplicate_link_map(store):
    assert not hasattr(store, '_links')
    assert store._note_map['a'].next_id == 'b'
    assert store.get_note('a').next_id == 'b'
    assert store.snapshot()['b'].prev_id == 'a'


def test_insert_collapse_and_metadata_refresh_preserve_order_and_old_snapshots(store):
    before = store.get_note('a')
    store.add_note_from_db(SimpleNamespace(id='new',parent_id=None,prev_id=None,next_id='a',is_collapsed=False, created_at=None, updated_at=None), 'new', '', '')
    store.set_collapsed('b', True)
    store.set_updated_ats({'a': None})
    assert store.get_children(None) == ['new','a','b']
    assert before.prev_id is None
    assert store.get_note('a').prev_id == 'new'
    store.remove_note('new')
    assert store.get_children(None) == ['a','b']
    assert store.get_note('a').prev_id is None


def test_corrupt_sibling_cycle_is_rejected_instead_of_reordered(store):
    original = store.snapshot()
    rows = [dict(id='a',parent_id=None,prev_id='b',next_id='b',is_collapsed=False, created_at=None, updated_at=None),
            dict(id='b',parent_id=None,prev_id='a',next_id='a',is_collapsed=False, created_at=None, updated_at=None)]
    with pytest.raises(RuntimeError, match='[Oo]rder|[Ll]ink|[Cc]ycle'):
        store.load_from_db(None, prefetched_rows=rows)
    assert store.snapshot() == original
    assert store.get_children(None) == ['a', 'b']


def test_bulk_metadata_validates_hierarchy_before_publishing(store):
    original = store.snapshot()
    with pytest.raises(HierarchyError, match='[Cc]ycle'):
        store.move_notes([
            NotePosition(note_id='a', parent_id='b', prev_id=None, next_id=None),
            NotePosition(note_id='b', parent_id='a', prev_id=None, next_id=None),
        ])
    assert store.snapshot() == original
    assert store.get_children(None) == ['a', 'b']


def test_bulk_metadata_rejects_missing_records(store):
    with pytest.raises(KeyError, match='missing'):
        store.move_notes([NotePosition(note_id='missing', parent_id=None, prev_id=None, next_id=None)])
    with pytest.raises(KeyError, match='missing'):
        store.set_updated_ats({'missing': None})


@pytest.fixture
def database_store(store, monkeypatch):
    SafeSession.use_memory_db()
    SafeSession.disable_read_guard()
    encryption.set_encryption_required(False)
    monkeypatch.setattr(adapter_module, '_note_store', store)
    session = SafeSession()
    timestamp = datetime.now(timezone.utc)
    for note_id, prev_id, next_id in [('head', None, 'middle'), ('middle', 'head', 'tail'), ('tail', 'middle', None)]:
        insert_note(
            session.connection(), note_id=note_id, content='', encryption_nonce=None, encryption_tag=None,
            tags='', tags_encryption_nonce=None, tags_encryption_tag=None, proposed_tags='',
            proposed_tags_encryption_nonce=None, proposed_tags_encryption_tag=None,
            parent_id=None, prev_id=prev_id, next_id=next_id, is_collapsed=False,
            created_at=timestamp, updated_at=timestamp,
        )
    session.commit()
    store.load_from_db(session, prefetched_rows=None)
    yield store, session
    session.close()


def test_database_cross_parent_move_and_undo_delete_restore(database_store):
    store, session = database_store
    apply_move('middle', 'head', None, None)
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


def test_undo_delete_restores_a_note_with_several_children(database_store):
    store, session = database_store
    apply_move('middle', 'head', None, None)
    apply_move('tail', 'head', 'middle', None)
    assert store.get_children('head') == ['middle', 'tail']
    snapshot = _snapshot_subtree('head')

    apply_delete_subtree('head')
    apply_restore_records(snapshot, '')

    assert store.get_children(None) == ['head']
    assert store.get_children('head') == ['middle', 'tail']
    store.load_from_db(session, prefetched_rows=None)
    assert store.get_children('head') == ['middle', 'tail']


@pytest.mark.parametrize('position, sibling_id', [('AFTER', 'head'), ('BEFORE', 'tail')])
def test_a_move_to_where_the_note_already_is_changes_nothing(database_store, position, sibling_id):
    """Moving a note after the sibling it already follows, or before the one it
    already precedes, is a move to its own place: nothing changes, and nothing
    is recorded to undo."""
    store, session = database_store
    command = CmdMove(note_id='middle', sibling_id=sibling_id, position=position, new_parent_id=None,
                      client_id='client', undo_context='context', viewport={})
    assert command.execute() == {'status': 'noop'}
    assert store.get_children(None) == ['head', 'middle', 'tail']
    store.load_from_db(session, prefetched_rows=None)
    assert store.get_children(None) == ['head', 'middle', 'tail']


def test_a_note_cannot_be_moved_relative_to_itself(database_store):
    store, session = database_store
    command = CmdMove(note_id='middle', sibling_id='middle', position='AFTER', new_parent_id=None,
                      client_id='client', undo_context='context', viewport={})
    with pytest.raises(RuntimeError, match='relative to itself'):
        command.execute()
    assert store.get_children(None) == ['head', 'middle', 'tail']
