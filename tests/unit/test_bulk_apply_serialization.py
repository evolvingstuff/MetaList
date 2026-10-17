"""A bulk AI operation applies its tags while a few requests are still let
through (saving preferences, the privacy preview, debug details). Those hold
bulk_operation_guard.lock from capturing undo and sync state to any rollback,
so the apply step takes that lock too: it never clears undo history while such
a request is reading it, and a request that fails cannot restore undo and sync
state from before the bulk change."""

import threading
from contextlib import contextmanager
from types import SimpleNamespace

import app.usecases.bulk_tag_proposals as bulk
from app.services.bulk_operation import bulk_operation_guard

NOTE_ID = "note-1"
# How long the apply is given to finish while the request holds the lock; with
# the lock taken by the apply, this is how long it waits.
OVERLAP_WAIT_SECONDS = 0.5
JOIN_SECONDS = 5


@contextmanager
def _no_transaction():
    yield SimpleNamespace()


def _stand_in_for_storage(monkeypatch, events):
    monkeypatch.setattr(bulk.store, "get_note", lambda note_id: SimpleNamespace(tags=""))
    monkeypatch.setattr(bulk.store, "apply_bulk_tag_sources", lambda changes: None)
    monkeypatch.setattr(bulk, "encrypt", lambda value, token: (value, None, None))
    monkeypatch.setattr(bulk, "begin_request_transaction", _no_transaction)
    monkeypatch.setattr(bulk, "begin_writer", _no_transaction)
    monkeypatch.setattr(bulk, "update_note_fields_preserving_updated_at", lambda connection, note_id, **fields: None)
    monkeypatch.setattr(bulk, "record_explicit_tag_addition_batch", lambda **arguments: None)
    monkeypatch.setattr(bulk, "cache_note_tags", lambda note_id, tags: None)
    monkeypatch.setattr(bulk, "cache_note_proposed_tags", lambda note_id, tags: None)
    monkeypatch.setattr(bulk, "reset_all_undo_state", lambda: events.append("undo history reset"))
    monkeypatch.setattr(bulk, "generate_new_uuid", lambda: "new-sync-uuid")


def test_the_bulk_apply_waits_for_a_request_that_holds_the_lock(monkeypatch):
    events = []
    _stand_in_for_storage(monkeypatch, events)
    request_holds_lock = threading.Event()
    request_may_finish = threading.Event()

    def allowed_request():
        with bulk_operation_guard.lock:
            request_holds_lock.set()
            assert request_may_finish.wait(JOIN_SECONDS)
            events.append("request finished")

    request = threading.Thread(target=allowed_request)
    request.start()
    assert request_holds_lock.wait(JOIN_SECONDS)
    apply = threading.Thread(target=bulk.apply_bulk_proposals,
                             kwargs={"changes": {NOTE_ID: ("tagged", "")}, "token": "token"})
    apply.start()
    apply.join(OVERLAP_WAIT_SECONDS)
    request_may_finish.set()
    request.join(JOIN_SECONDS)
    apply.join(JOIN_SECONDS)
    assert not request.is_alive() and not apply.is_alive()
    assert events == ["request finished", "undo history reset"], "the bulk apply ran while the request held the lock"
