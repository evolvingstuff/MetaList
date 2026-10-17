"""Reads that walk the whole note tree in several steps (exports, backlinks)
run as serialized reads: they wait for a write in progress, so a note deleted
between two of their steps cannot break them."""

import inspect
import threading

from app.api.transactions import serialized_read_route
from app.services.bulk_operation import bulk_operation_guard

# How long the read is given to run while the write holds the lock; serialized,
# this is how long it waits.
OVERLAP_WAIT_SECONDS = 0.5
JOIN_SECONDS = 5


def test_a_serialized_read_waits_for_a_write_in_progress():
    events = []

    @serialized_read_route
    def read_whole_tree(note_id: str) -> str:
        events.append("read")
        return note_id

    write_holds_lock = threading.Event()
    write_may_finish = threading.Event()

    def write():
        with bulk_operation_guard.lock:
            write_holds_lock.set()
            assert write_may_finish.wait(JOIN_SECONDS)
            events.append("write finished")

    writer = threading.Thread(target=write)
    writer.start()
    assert write_holds_lock.wait(JOIN_SECONDS)
    reader = threading.Thread(target=read_whole_tree, args=("note-1",))
    reader.start()
    reader.join(OVERLAP_WAIT_SECONDS)
    write_may_finish.set()
    writer.join(JOIN_SECONDS)
    reader.join(JOIN_SECONDS)
    assert not writer.is_alive() and not reader.is_alive()
    assert events == ["write finished", "read"], "the read ran while the write was in progress"


def test_a_serialized_read_keeps_the_route_signature_for_fastapi():
    def route(request: object, note_id: str) -> dict:
        return {}

    assert inspect.signature(serialized_read_route(route)) == inspect.signature(route)
