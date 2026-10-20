"""Unlocking records how long each phase took, for the Memory Usage dialog's Last unlock."""

from __future__ import annotations

from app.services.hydration_state import HydrationState


def test_each_phase_is_timed_until_the_next_starts_and_the_last_until_finish() -> None:
    state = HydrationState()
    assert state.last_run_timings() == {"phases": [], "steps": [], "totalSeconds": 0.0}
    state.begin(first_load=True, message="Unlocking")
    state.set_phase(phase="decrypt", message="Decrypting", total=0)
    state.record_steps({"decrypt note text": 0.5, "sanitize note HTML": 0.25})
    state.set_phase(phase="note_store", message="Store", total=0)
    state.finish()
    timings = state.last_run_timings()
    assert [entry["phase"] for entry in timings["phases"]] == ["starting", "decrypt", "note_store"]
    assert all(entry["seconds"] >= 0 for entry in timings["phases"])
    assert timings["steps"] == [
        {"step": "decrypt note text", "seconds": 0.5},
        {"step": "sanitize note HTML", "seconds": 0.25},
    ]
    assert timings["totalSeconds"] >= sum(entry["seconds"] for entry in timings["phases"]) - 1e-9


def test_the_last_unlock_survives_a_lock_and_is_replaced_by_the_next() -> None:
    state = HydrationState()
    state.begin(first_load=True, message="Unlocking")
    state.set_phase(phase="decrypt", message="Decrypting", total=0)
    state.finish()
    state.reset()
    assert [entry["phase"] for entry in state.last_run_timings()["phases"]] == ["starting", "decrypt"]
    state.begin(first_load=False, message="Unlocking")
    state.finish()
    assert [entry["phase"] for entry in state.last_run_timings()["phases"]] == ["starting"]
