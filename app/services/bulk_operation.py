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
        # question id -> (answer, choices, asking session, owning operation id;
        # "" for a question that blocks nothing, see ask()).
        self.questions: dict[str, tuple[asyncio.Future, frozenset[str], str, str]] = {}

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
                operation_id = self.operation_id
                for question_id, (future, _, _, owner) in list(self.questions.items()):
                    if owner == operation_id:
                        future.get_loop().call_soon_threadsafe(future.cancel)
                        del self.questions[question_id]
                self.operation_id = ""
                self.session_key = ""

    @contextmanager
    def track_mutation(self):
        with self._mutation_lock:
            if self.active_mutations:
                raise BulkOperationBusy("Another request is changing the vault; retry after it finishes")
            self.active_mutations += 1
        try:
            yield
        finally:
            with self._mutation_lock:
                self.active_mutations -= 1
                assert self.active_mutations >= 0

    def question(self, choices: tuple[str, ...]) -> tuple[str, asyncio.Future]:
        """A question inside the running operation, which blocks other changes."""
        with self._mutation_lock:
            assert self.operation_id
            question_id = str(uuid4())
            future = asyncio.get_running_loop().create_future()
            self.questions[question_id] = (future, frozenset(choices), self.session_key, self.operation_id)
            return question_id, future

    @contextmanager
    def ask(self, session_key: str, choices: tuple[str, ...]):
        """A question for a step that only reads (a summary, opening web pages): it
        blocks no other change while it waits. Yields (question id, answer)."""
        assert session_key and choices
        with self._mutation_lock:
            question_id = str(uuid4())
            future = asyncio.get_running_loop().create_future()
            self.questions[question_id] = (future, frozenset(choices), session_key, "")
        try:
            yield question_id, future
        finally:
            with self._mutation_lock:
                # Already gone when it was answered.
                if question_id in self.questions:
                    del self.questions[question_id]
            if not future.done():
                future.cancel()

    def answer(self, session_key: str, question_id: str, value: str):
        with self._mutation_lock:
            if question_id not in self.questions:
                raise ValueError("This question is no longer pending")
            future, choices, asking_session_key, _ = self.questions[question_id]
            if asking_session_key != session_key:
                raise ValueError("This question is no longer pending")
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
