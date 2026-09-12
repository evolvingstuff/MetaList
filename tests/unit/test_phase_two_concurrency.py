import asyncio
from app.services import sync
from app.services.bulk_operation import BulkOperationGuard, BulkOperationBusy
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi import HTTPException

from app.models.database import SafeSession
from app.db.session import GuardedConnection
from app.api.transactions import transactional_route


def test_read_permissions_are_isolated_across_overlapping_threads():
    entered, release, first_exited = Event(), Event(), Event()
    def second():
        connection = sqlite3.connect(':memory:')
        try:
            with SafeSession.allow_reads('second'):
                entered.set()
                assert first_exited.wait(2)
                assert GuardedConnection(connection).execute('SELECT 1').fetchone() == (1,)
                assert release.wait(2)
        finally:
            connection.close()
    SafeSession.enable_read_guard()
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            try:
                with SafeSession.allow_reads('first'):
                    future = executor.submit(second)
                    assert entered.wait(2)
                first_exited.set()
                with sqlite3.connect(':memory:') as connection:
                    with pytest.raises(RuntimeError, match='read forbidden'):
                        GuardedConnection(connection).execute('SELECT 1')
            finally:
                release.set()
                first_exited.set()
            future.result()
        assert not SafeSession._reads_enabled
    finally:
        SafeSession.disable_read_guard()


def test_async_mutations_cannot_overlap_each_others_transaction():
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        @transactional_route
        async def mutation():
            entered.set()
            await release.wait()
        task = asyncio.create_task(mutation())
        await entered.wait()
        try:
            with pytest.raises(HTTPException) as exc:
                await asyncio.wait_for(mutation(), timeout=.2)
            assert exc.value.status_code == 409
        finally:
            release.set()
            await task
    asyncio.run(scenario())


def test_clipboard_and_recovery_snapshots_do_not_share_nested_records():
    records = [{'content': {'text': 'original'}}]
    sync.set_clipboard('fixture', records)
    snapshot = sync.capture_sync_state()
    records[0]['content']['text'] = 'caller mutation'
    returned = sync.get_clipboard('fixture')
    returned[0]['content']['text'] = 'reader mutation'
    assert sync.get_clipboard('fixture')[0]['content']['text'] == 'original'
    sync.restore_sync_state(snapshot)
    snapshot[2]['fixture'][0]['content']['text'] = 'snapshot mutation'
    assert sync.get_clipboard('fixture')[0]['content']['text'] == 'original'
    sync.reset_state()


def test_bulk_answer_from_worker_is_delivered_on_owning_loop():
    async def scenario():
        guard = BulkOperationGuard()
        with guard.acquire('session'):
            question, future = guard.question(('yes', 'no'))
            await asyncio.to_thread(guard.answer, 'session', question, 'yes')
            assert await asyncio.wait_for(future, 1) == 'yes'
            with pytest.raises(ValueError):
                guard.answer('session', question, 'no')
    asyncio.run(scenario(), debug=True)


def test_bulk_admission_is_denied_during_mutation():
    guard = BulkOperationGuard()
    with guard.track_mutation():
        with pytest.raises(BulkOperationBusy):
            with guard.acquire('session'):
                raise AssertionError('Concurrent bulk operation admitted')
    with guard.acquire('session'):
        assert guard.operation_id
