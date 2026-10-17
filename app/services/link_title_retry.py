"""Retry failed link titles (command palette; docs/ui/command-palette.md).

Asks every failed or title-less link lookup again, now, through the same polite
per-site pacing as ordinary lookups (link_titles._host_pacer). It runs in the
background: the progress dialog only reads `link_title_retry_snapshot()`. A site
that asks MetaList to wait (HTTP 429) is skipped for the rest of the run, and its
links keep their normal retry schedule. Stopping, logging out, locking or logging
in drops the lookups not yet started; those in progress finish.
"""

from __future__ import annotations

from threading import Lock

from app.services.link_titles import (
    _LinkTitleFetchResult,
    _pacing_host,
    fetch_link_title,
    link_title_fetcher,
    link_title_store,
)
from app.services.runtime_generation import current_generation

_RUNNING_STATUSES = ("running", "stopping")


class _RetryRun:
    """Counts for one run; every link ends in exactly one bucket."""

    def __init__(self, *, total: int, generation: int) -> None:
        assert total > 0, "a retry run needs links to ask"
        self._lock = Lock()
        self.generation = generation
        self.total = total
        self.is_stop_requested = False
        self.found = 0
        self.still_failing: dict[str, int] = {}
        self.paused_sites: dict[str, int] = {}
        self.skipped = 0
        self.dropped = 0

    def _accounted_locked(self) -> int:
        return (self.found + sum(self.still_failing.values()) + sum(self.paused_sites.values())
                + self.skipped + self.dropped)

    def status(self) -> str:
        with self._lock:
            if self._accounted_locked() < self.total:
                if self.is_stop_requested:
                    return "stopping"
                return "running"
            if self.dropped > 0:
                return "stopped"
            return "finished"

    def should_drop(self) -> bool:
        with self._lock:
            if self.is_stop_requested:
                return True
            return self.generation != current_generation()

    def request_stop(self) -> None:
        with self._lock:
            self.is_stop_requested = True

    def record_result(self, result: _LinkTitleFetchResult) -> None:
        with self._lock:
            if result.status == "ok":
                self.found += 1
                return
            kind = result.last_error_kind
            if kind is None:
                kind = result.status
            if kind not in self.still_failing:
                self.still_failing[kind] = 0
            self.still_failing[kind] += 1

    def record_paused(self, host: str) -> None:
        with self._lock:
            if host not in self.paused_sites:
                self.paused_sites[host] = 0
            self.paused_sites[host] += 1

    def record_skipped(self) -> None:
        with self._lock:
            self.skipped += 1

    def record_dropped(self) -> None:
        with self._lock:
            self.dropped += 1

    def snapshot(self) -> dict[str, object]:
        status = self.status()
        with self._lock:
            asked = self.found + sum(self.still_failing.values())
            return {
                "status": status,
                "total": self.total,
                "asked": asked,
                "found": self.found,
                "stillFailing": dict(sorted(self.still_failing.items())),
                "pausedSites": dict(sorted(self.paused_sites.items())),
                "skipped": self.skipped,
                "dropped": self.dropped,
            }


_state_lock = Lock()
_current_run: list[_RetryRun] = []  # shockharness: ignore[STATE001] reason="every access holds _state_lock"


def _latest_run() -> _RetryRun | None:
    with _state_lock:
        if not _current_run:
            return None
        return _current_run[0]


def link_title_retry_snapshot() -> dict[str, object]:
    """The latest run's progress (status "idle" before any run) and how many links a new run would ask."""
    retryable = len(link_title_store.list_manual_retry_urls())
    run = _latest_run()
    if run is None:
        return {"status": "idle", "total": 0, "asked": 0, "found": 0, "stillFailing": {},
                "pausedSites": {}, "skipped": 0, "dropped": 0, "retryable": retryable}
    return {**run.snapshot(), "retryable": retryable}


def start_link_title_retry() -> dict[str, object]:
    """Start a run unless one is already going (then its progress is returned)."""
    with _state_lock:
        if _current_run and _current_run[0].status() in _RUNNING_STATUSES:
            run = _current_run[0]
        else:
            urls = link_title_store.list_manual_retry_urls()
            if not urls:
                _current_run.clear()
                run = None
            else:
                run = _RetryRun(total=len(urls), generation=current_generation())
                _current_run[:] = [run]
                for url in urls:
                    link_title_fetcher.submit_job(_retry_one, run, url)
    return link_title_retry_snapshot()


def stop_link_title_retry() -> dict[str, object]:
    """Drop the lookups not yet started; those in progress finish."""
    run = _latest_run()
    if run is not None:
        run.request_stop()
    return link_title_retry_snapshot()


def _retry_one(run: _RetryRun, url: str) -> None:
    if run.should_drop():
        run.record_dropped()
        return
    if not link_title_store.claim_for_manual_retry(url):
        # Already being looked up for a view, or titled since the run started.
        run.record_skipped()
        return
    result = fetch_link_title(url)
    if result.status == "deferred":
        link_title_store.discard_in_flight(url)
        run.record_paused(_pacing_host(url))
        return
    link_title_store.apply_current_fetch_result(result, run.generation)
    run.record_result(result)
