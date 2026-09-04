from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.db.session import begin_writer
from app.db.tab_state_sql import upsert_tab_state_row
from app.models.database import SafeSession
from app.security.encryption import set_encryption_required
from app.services.tab_state import TabStateStore


@pytest.fixture(autouse=True)
def _isolated_memory_db(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    set_encryption_required(False)
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    try:
        yield
    finally:
        set_encryption_required(False)
        SafeSession.use_file_db()


def test_create_tab_copies_sort_mode_from_source_tab() -> None:
    store = TabStateStore()
    initial = store.snapshot()
    source_tab_id = initial["activeTabId"]
    initial["tabs"][source_tab_id]["sortMode"] = "updated"
    updated = store.update(
        active_tab_id=source_tab_id,
        tabs=initial["tabs"],
        tab_order=initial["tabOrder"],
    )

    duplicated = store.create_tab(copy_from_tab_id=source_tab_id)
    new_tab_id = duplicated["newTabId"]

    assert duplicated["tabs"][new_tab_id]["sortMode"] == "updated"
    assert updated["tabs"][source_tab_id]["sortMode"] == "updated"


def test_set_sort_mode_resets_scroll_state_and_marks_change() -> None:
    store = TabStateStore()
    snapshot = store.snapshot()
    tab_id = snapshot["activeTabId"]
    payload = snapshot["tabs"]
    payload[tab_id]["scrollY"] = 250
    payload[tab_id]["scrollAnchor"] = {
        "anchorId": "root-a",
        "anchorBias": "top",
        "intraOffset": 0,
        "beltPrev": [],
        "beltNext": [],
        "anchorSortKey": {"domIndex": 0},
    }
    store.update(
        active_tab_id=tab_id,
        tabs=payload,
        tab_order=snapshot["tabOrder"],
    )

    result = store.set_sort_mode(tab_id=tab_id, sort_mode="created")

    assert result["changed"] is True
    assert result["tabs"][tab_id]["sortMode"] == "created"
    assert result["tabs"][tab_id]["scrollY"] == 0
    assert result["tabs"][tab_id]["scrollAnchor"] is None


def test_set_sort_mode_is_noop_when_value_matches() -> None:
    store = TabStateStore()
    snapshot = store.snapshot()
    tab_id = snapshot["activeTabId"]

    result = store.set_sort_mode(tab_id=tab_id, sort_mode="normal")

    assert result["changed"] is False
    assert result["tabs"][tab_id]["sortMode"] == "normal"


def test_set_sort_mode_accepts_alphabetical() -> None:
    store = TabStateStore()
    snapshot = store.snapshot()
    tab_id = snapshot["activeTabId"]

    result = store.set_sort_mode(tab_id=tab_id, sort_mode="alphabetical")

    assert result["changed"] is True
    assert result["tabs"][tab_id]["sortMode"] == "alphabetical"


def test_set_sort_mode_accepts_content_volume() -> None:
    store = TabStateStore()
    snapshot = store.snapshot()
    tab_id = snapshot["activeTabId"]

    result = store.set_sort_mode(tab_id=tab_id, sort_mode="content-volume")

    assert result["changed"] is True
    assert result["tabs"][tab_id]["sortMode"] == "content-volume"


def test_bootstrap_restores_persisted_tab_state() -> None:
    store = TabStateStore()
    initial = store.snapshot()
    tab_id = initial["activeTabId"]
    payload = initial["tabs"]
    payload[tab_id]["searchQuery"] = "project-x"
    payload[tab_id]["scrollY"] = 180
    payload[tab_id]["anchorRootId"] = "root-1"
    payload[tab_id]["scrollAnchor"] = {
        "anchorId": "root-1",
        "anchorBias": "top",
        "intraOffset": 12,
        "beltPrev": ["root-0"],
        "beltNext": ["root-2"],
        "anchorSortKey": {"domIndex": 3},
    }
    persisted = store.update(
        active_tab_id=tab_id,
        tabs=payload,
        tab_order=initial["tabOrder"],
    )

    reloaded = TabStateStore()
    session = SafeSession()
    try:
        with SafeSession.allow_reads("tests:tab_state:bootstrap"):
            reloaded.bootstrap(connection=session.connection())
    finally:
        session.close()

    snapshot = reloaded.snapshot()
    assert snapshot == persisted
    assert snapshot["tabs"][tab_id]["searchQuery"] == "project-x"
    assert snapshot["tabs"][tab_id]["anchorRootId"] == "root-1"


def test_legacy_tab_payload_discards_removed_calendar_state() -> None:
    store = TabStateStore()
    legacy_snapshot = store.snapshot()
    tab_id = legacy_snapshot["activeTabId"]
    payload = legacy_snapshot["tabs"]
    payload[tab_id]["dateFilter"] = {
        "metric": "created",
        "startDate": "2026-05-01",
        "endDate": "2026-05-18",
    }
    payload[tab_id]["calendarMetric"] = "updated"
    payload[tab_id]["calendarScrollTop"] = 333
    payload[tab_id]["calendarScrollPinnedToNewest"] = False

    with begin_writer() as connection:
        upsert_tab_state_row(
            connection,
            state_json=json.dumps(legacy_snapshot),
            state_encryption_nonce=None,
            state_encryption_tag=None,
            updated_at=datetime.now(timezone.utc),
        )

    reloaded = TabStateStore()
    session = SafeSession()
    try:
        with SafeSession.allow_reads("tests:tab_state:legacy_calendar_fields"):
            reloaded.bootstrap(connection=session.connection())
    finally:
        session.close()

    normalized_tab = reloaded.snapshot()["tabs"][tab_id]
    assert "dateFilter" not in normalized_tab
    assert "calendarMetric" not in normalized_tab
    assert "calendarScrollTop" not in normalized_tab
    assert "calendarScrollPinnedToNewest" not in normalized_tab
