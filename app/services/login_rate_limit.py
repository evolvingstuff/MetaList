from __future__ import annotations

import math
import time
from collections import deque
from threading import RLock

from app.config import (
    LOGIN_RATE_LIMIT_BLOCK_SECONDS,
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
    LOGIN_RATE_LIMIT_WINDOW_SECONDS,
)


class _AttemptBucket:
    __slots__ = ("attempts", "blocked_until")

    def __init__(self) -> None:
        self.attempts: deque[float] = deque()
        self.blocked_until = 0.0


class LoginRateLimiter:
    def __init__(
        self,
        max_attempts: int,
        window_seconds: int,
        block_seconds: int,
    ) -> None:
        if max_attempts <= 0:
            raise ValueError(f"max_attempts must be positive: {max_attempts}")
        if window_seconds <= 0:
            raise ValueError(f"window_seconds must be positive: {window_seconds}")
        if block_seconds <= 0:
            raise ValueError(f"block_seconds must be positive: {block_seconds}")
        self._max_attempts = max_attempts
        self._window_seconds = window_seconds
        self._block_seconds = block_seconds
        self._buckets: dict[str, _AttemptBucket] = {}
        self._lock = RLock()

    def _prune_attempts(self, bucket: _AttemptBucket, now: float) -> None:
        cutoff = now - self._window_seconds
        while bucket.attempts and bucket.attempts[0] < cutoff:
            bucket.attempts.popleft()

    def check_allowed(self, key: str) -> tuple[bool, int]:
        now = time.monotonic()
        with self._lock:
            # A key without failures has no bucket.
            if key not in self._buckets:
                return True, 0
            bucket = self._buckets[key]
            if bucket.blocked_until > now:
                remaining = math.ceil(bucket.blocked_until - now)
                return False, remaining
            self._prune_attempts(bucket, now)
            if not bucket.attempts:
                del self._buckets[key]
            return True, 0

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            if key not in self._buckets:
                self._buckets[key] = _AttemptBucket()
            bucket = self._buckets[key]
            if bucket.blocked_until > now:
                return
            self._prune_attempts(bucket, now)
            bucket.attempts.append(now)
            if len(bucket.attempts) >= self._max_attempts:
                bucket.blocked_until = now + self._block_seconds
                bucket.attempts.clear()

    def record_success(self, key: str) -> None:
        with self._lock:
            if key in self._buckets:
                del self._buckets[key]


login_rate_limiter = LoginRateLimiter(
    max_attempts=LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
    window_seconds=LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    block_seconds=LOGIN_RATE_LIMIT_BLOCK_SECONDS,
)
