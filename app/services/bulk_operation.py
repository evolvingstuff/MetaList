"""Namespace-local guard and pending answers for an active bulk operation."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from threading import RLock, Lock
from uuid import uuid4
from app.services.agent.inference import InferenceProviderError


class BulkOperationBusy(InferenceProviderError):
    pass


class BulkOperationGuard:
    def __init__(self):
        self.lock = RLock()
        self.operation_id = ""
        self.session_key = ""
        self.active_mutations = 0
        self._mutation_lock = Lock()
        self.questions: dict[str, tuple[asyncio.Future, frozenset[str]]] = {}

    @contextmanager
    def acquire(self, session_key: str):
        with self.lock, self._mutation_lock:
            if self.operation_id or self.active_mutations:
                raise BulkOperationBusy("Another operation is still running; try again after it finishes")
            self.operation_id = str(uuid4())
            self.session_key = session_key
        try:
            yield self.operation_id
        finally:
            with self.lock, self._mutation_lock:
                for future, _ in self.questions.values():
                    future.get_loop().call_soon_threadsafe(future.cancel)
                self.questions.clear()
                self.operation_id = ""
                self.session_key = ""

    @contextmanager
    def track_mutation(self):
        with self._mutation_lock:
            if self.active_mutations:
                raise BulkOperationBusy("Another request is changing the namespace; retry after it finishes")
            self.active_mutations += 1
        try:
            yield
        finally:
            with self._mutation_lock:
                self.active_mutations -= 1
                assert self.active_mutations >= 0

    def question(self, choices: tuple[str, ...]) -> tuple[str, asyncio.Future]:
        with self._mutation_lock:
            assert self.operation_id
            question_id = str(uuid4())
            future = asyncio.get_running_loop().create_future()
            self.questions[question_id] = (future, frozenset(choices))
            return question_id, future

    def answer(self, session_key: str, question_id: str, value: str):
        with self._mutation_lock:
            if session_key != self.session_key or question_id not in self.questions:
                raise ValueError("This question is no longer pending")
            future, choices = self.questions[question_id]
            if value not in choices or future.done():
                raise ValueError("Invalid or already submitted answer")
            del self.questions[question_id]
            future.get_loop().call_soon_threadsafe(self._deliver_answer, future, value)

    @staticmethod
    def _deliver_answer(future: asyncio.Future, value: str) -> None:
        # Cancellation may win between accepting the answer and loop delivery.
        if not future.done():
            future.set_result(value)


bulk_operation_guard = BulkOperationGuard()
