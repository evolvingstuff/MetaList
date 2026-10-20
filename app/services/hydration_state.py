from __future__ import annotations

import time
from threading import Lock
from typing import Dict, List

_PHASE_ORDER = (
    "database_check",
    "decrypt",
    "note_store",
    "tag_inference",
    "search_index",
    "matcher_inference",
)
_PHASE_INDEX = {phase: index for index, phase in enumerate(_PHASE_ORDER)}
_PHASE_COUNT = len(_PHASE_ORDER)
_PERCENT_COMPLETE = 100
# Running hydration never reports complete; only finish() does.
_RUNNING_PERCENT_MAX = _PERCENT_COMPLETE - 1


def _calculate_overall_percent(
    *, status: str, phase: str, processed: int, total: int
) -> int:
    if status == "ready":
        return _PERCENT_COMPLETE
    if phase == "complete":
        return _PERCENT_COMPLETE
    if phase in _PHASE_INDEX:
        index = _PHASE_INDEX[phase]
        if total > 0:
            phase_progress = processed / total
        else:
            phase_progress = 0
        fraction = (index + phase_progress) / _PHASE_COUNT
        percent = int(fraction * _PERCENT_COMPLETE)
        if status == "running" and percent > _RUNNING_PERCENT_MAX:
            return _RUNNING_PERCENT_MAX
        if percent < 0:
            return 0
        return percent
    return 0


class HydrationState:
    def __init__(self) -> None:
        self._lock = Lock()
        self._status = "idle"
        self._phase = ""
        self._message = ""
        self._processed = 0
        self._total = 0
        self._first_load = False
        self._error = ""
        # How long each phase of the running unlock took, and of the last one finished
        # (the Memory Usage dialog shows it; timings only, never content).
        self._phase_started_at = 0.0
        self._run_started_at = 0.0
        self._phase_seconds: List[Dict[str, object]] = []
        self._step_seconds: List[Dict[str, object]] = []
        self._last_phases: List[Dict[str, object]] = []
        self._last_steps: List[Dict[str, object]] = []
        self._last_total_seconds = 0.0

    def begin(self, first_load: bool, message: str) -> None:
        with self._lock:
            now = time.perf_counter()
            self._run_started_at = now
            self._phase_started_at = now
            self._phase_seconds = []
            self._step_seconds = []
            self._status = "running"
            self._phase = "starting"
            self._message = message
            self._processed = 0
            self._total = 0
            self._first_load = first_load
            self._error = ""

    def set_phase(self, phase: str, message: str, total: int) -> None:
        if total < 0:
            raise ValueError(f"total must be >= 0, got {total}")
        with self._lock:
            if self._status != "running":
                raise RuntimeError("Hydration is not running")
            self._close_phase_locked()
            self._phase = phase
            self._message = message
            self._processed = 0
            self._total = total

    def update(self, processed: int) -> None:
        if processed < 0:
            raise ValueError(f"processed must be >= 0, got {processed}")
        with self._lock:
            if self._status != "running":
                raise RuntimeError("Hydration is not running")
            if self._total <= 0:
                if self._total == 0 and processed == 0:
                    self._processed = 0
                    return
                raise RuntimeError("Hydration total must be set before updates")
            if processed > self._total:
                raise RuntimeError(
                    f"Hydration progress exceeded total: {processed} > {self._total}"
                )
            self._processed = processed

    def finish(self) -> None:
        with self._lock:
            if self._status != "running":
                raise RuntimeError("Hydration is not running")
            if self._total > 0:
                self._processed = self._total
            self._close_phase_locked()
            self._last_phases = list(self._phase_seconds)
            self._last_steps = list(self._step_seconds)
            self._last_total_seconds = time.perf_counter() - self._run_started_at
            self._status = "ready"
            self._phase = "complete"
            self._message = "Workspace ready"

    def _close_phase_locked(self) -> None:
        now = time.perf_counter()
        self._phase_seconds.append({"phase": self._phase, "seconds": now - self._phase_started_at})
        self._phase_started_at = now

    def record_steps(self, seconds_by_step: Dict[str, float]) -> None:
        """Time spent on steps within a phase (decrypting, sanitizing, extracting text)."""
        with self._lock:
            if self._status != "running":
                raise RuntimeError("Hydration is not running")
            for step, seconds in seconds_by_step.items():
                assert seconds >= 0, f"step {step} took negative time"
                self._step_seconds.append({"step": step, "seconds": seconds})

    def last_run_timings(self) -> Dict[str, object]:
        """The last finished unlock's phases and steps in seconds; none before the first."""
        with self._lock:
            return {
                "phases": list(self._last_phases),
                "steps": list(self._last_steps),
                "totalSeconds": self._last_total_seconds,
            }

    def fail(self, message: str) -> None:
        with self._lock:
            self._status = "error"
            self._phase = "error"
            self._message = message
            self._error = message

    def is_running(self) -> bool:
        with self._lock:
            return self._status == "running"

    def reset(self) -> None:
        with self._lock:
            self._status = "idle"
            self._phase = ""
            self._message = ""
            self._processed = 0
            self._total = 0
            self._first_load = False
            self._error = ""

    def snapshot(self) -> Dict[str, object]:
        with self._lock:
            overall_percent = _calculate_overall_percent(
                status=self._status,
                phase=self._phase,
                processed=self._processed,
                total=self._total,
            )
            return {
                "status": self._status,
                "phase": self._phase,
                "message": self._message,
                "processed": self._processed,
                "total": self._total,
                "first_load": self._first_load,
                "error": self._error,
                "overall_percent": overall_percent,
            }


hydration_state = HydrationState()
