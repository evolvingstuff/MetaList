"""An unlock hands the memory its short-lived objects used back to the system once the
note store has loaded: glibc otherwise keeps it (93 MB on a 107,500-note unlock)."""

from __future__ import annotations

import app.api.routes.auth as auth_routes
from app.services.hydration_state import HydrationState


def test_an_unlock_hands_freed_memory_back_after_loading(monkeypatch) -> None:
    events: list[str] = []
    state = HydrationState()
    monkeypatch.setattr(auth_routes, "hydration_state", state)

    def populate(_session) -> list:
        events.append("cache")
        return []

    monkeypatch.setattr(auth_routes, "populate_cache_from_db", populate)
    monkeypatch.setattr(auth_routes.note_store, "load_from_db", lambda _db, *, prefetched_rows: events.append("store"))
    monkeypatch.setattr(auth_routes, "release_freed_memory", lambda: events.append("release"))
    state.begin(first_load=True, message="Unlocking")

    auth_routes._run_hydration(rebuild_required=True)

    assert events == ["cache", "store", "release"]
    assert "hand freed memory back" in [step["step"] for step in state.last_run_timings()["steps"]]
