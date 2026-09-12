"""Invalidate asynchronous work when the unlocked namespace is replaced or locked."""

import asyncio
from threading import RLock


_lock = RLock()
_generation = 0
_tasks: set[asyncio.Task] = set()


def current_generation() -> int:
    with _lock:
        return _generation


def register_current_task() -> asyncio.Task:
    task = asyncio.current_task()
    if task is None:
        raise RuntimeError('Namespace streaming requires an asyncio task')
    with _lock:
        _tasks.add(task)
    return task


def unregister_task(task: asyncio.Task) -> None:
    with _lock:
        _tasks.discard(task)


def invalidate_runtime_work() -> None:
    global _generation
    with _lock:
        _generation += 1
        tasks = tuple(_tasks)
        _tasks.clear()
    for task in tasks:
        if not task.done():
            task.get_loop().call_soon_threadsafe(task.cancel)
