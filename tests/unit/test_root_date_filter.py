"""Date range filter (app/services/root_date_filter.py): which root notes a tab shows,
how a tab keeps its range, and the note being edited staying in view."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Dict, List, Optional

import pytest

import app.services.root_sorting as root_sorting
import app.services.snapshot as snapshot
from app.models.database import SafeSession
from app.security.encryption import set_encryption_required
from app.services.input_errors import InputRejected
from app.services.root_date_filter import (
    OPEN_DATE,
    RootDateFilter,
    date_filter_bounds,
    make_root_date_filter,
)
from app.services.tab_state import TabStateStore

TODAY = date(2026, 10, 23)
# Midday local time: the same local date in every time zone the test may run in.
MIDDAY = 12


def _preset(range_kind: str, *, field: str) -> RootDateFilter:
    return make_root_date_filter(field=field, range_kind=range_kind, from_date=OPEN_DATE, to_date=OPEN_DATE)


def _custom(from_date: str, to_date: str, *, field: str) -> RootDateFilter:
    return make_root_date_filter(field=field, range_kind="custom", from_date=from_date, to_date=to_date)


@pytest.mark.parametrize(("range_kind", "first", "last"), [
    ("today", date(2026, 10, 23), date(2026, 10, 23)),
    ("last-7-days", date(2026, 10, 17), date(2026, 10, 23)),
    ("last-30-days", date(2026, 9, 24), date(2026, 10, 23)),
    ("this-year", date(2026, 1, 1), date(2026, 10, 23)),
])
def test_preset_ranges_count_back_from_today_including_it(range_kind: str, first: date, last: date) -> None:
    assert date_filter_bounds(_preset(range_kind, field="updated"), today=TODAY) == (first, last)


def test_a_custom_range_keeps_its_dates_and_may_leave_one_end_open() -> None:
    assert date_filter_bounds(_custom("2026-10-01", "2026-10-22", field="created"), today=TODAY) == (
        date(2026, 10, 1), date(2026, 10, 22),
    )
    assert date_filter_bounds(_custom("2026-10-01", OPEN_DATE, field="created"), today=TODAY) == (date(2026, 10, 1), None)
    assert date_filter_bounds(_custom(OPEN_DATE, "2026-10-22", field="created"), today=TODAY) == (None, date(2026, 10, 22))


@pytest.mark.parametrize(("field", "range_kind", "from_date", "to_date"), [
    ("written", "today", OPEN_DATE, OPEN_DATE),
    ("updated", "last-week", OPEN_DATE, OPEN_DATE),
    ("updated", "today", "2026-10-01", OPEN_DATE),
    ("updated", "custom", OPEN_DATE, OPEN_DATE),
    ("updated", "custom", "2026-10-22", "2026-10-01"),
    ("updated", "custom", "2026-02-30", OPEN_DATE),
    ("updated", "custom", "10/01/2026", OPEN_DATE),
])
def test_a_range_that_is_not_one_is_rejected(field: str, range_kind: str, from_date: str, to_date: str) -> None:
    with pytest.raises(InputRejected):
        make_root_date_filter(field=field, range_kind=range_kind, from_date=from_date, to_date=to_date)


@pytest.fixture
def memory_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    set_encryption_required(False)
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    try:
        yield
    finally:
        set_encryption_required(False)
        SafeSession.use_file_db()


def test_a_tab_keeps_its_range_across_a_reload_and_starts_again_at_its_top(memory_db) -> None:
    store = TabStateStore()
    initial = store.snapshot()
    tab_id = initial["activeTabId"]
    initial["tabs"][tab_id]["scrollY"] = 250
    store.update(reference_views={}, active_tab_id=tab_id, tabs=initial["tabs"], tab_order=initial["tabOrder"])

    chosen = _custom("2026-10-01", "2026-10-22", field="created")
    result = store.set_date_filter(tab_id=tab_id, date_filter=chosen)
    assert result["changed"] is True
    assert result["tabs"][tab_id]["scrollY"] == 0
    assert result["dateFilters"] == {
        tab_id: {"field": "created", "rangeKind": "custom", "fromDate": "2026-10-01", "toDate": "2026-10-22"},
    }
    assert store.set_date_filter(tab_id=tab_id, date_filter=chosen)["changed"] is False

    reloaded = TabStateStore()
    session = SafeSession()
    try:
        with SafeSession.allow_reads("tests:root_date_filter:bootstrap"):
            reloaded.bootstrap(connection=session.connection())
    finally:
        session.close()
    assert reloaded.get_date_filter(tab_id=tab_id) == chosen

    cleared = store.set_date_filter(tab_id=tab_id, date_filter=None)
    assert cleared["changed"] is True
    assert cleared["dateFilters"] == {}
    assert store.get_date_filter(tab_id=tab_id) is None


def test_a_new_tab_starts_without_its_sources_range_and_a_closed_tab_drops_its_own(memory_db) -> None:
    store = TabStateStore()
    source_tab_id = store.snapshot()["activeTabId"]
    store.set_date_filter(tab_id=source_tab_id, date_filter=_preset("today", field="updated"))

    new_tab_id = store.create_tab(copy_from_tab_id=source_tab_id)["newTabId"]
    assert store.get_date_filter(tab_id=new_tab_id) is None

    store.set_date_filter(tab_id=new_tab_id, date_filter=_preset("this-year", field="created"))
    after_delete = store.delete_tab(tab_id=new_tab_id)
    assert list(after_delete["dateFilters"]) == [source_tab_id]


@dataclass(frozen=True)
class _Note:
    id: str
    parent_id: Optional[str]
    prev_id: Optional[str]
    next_id: Optional[str]
    is_collapsed: bool
    content: str
    tags: str
    created_at: datetime
    updated_at: datetime
    proposed_tags: str = ""
    proposed_tag_terms: frozenset[str] = frozenset()


class _FakeNoteStore:
    revision = 0

    def __init__(self, *, notes: Dict[str, _Note], children_by_parent: Dict[Optional[str], List[str]]):
        self._notes = notes
        self._children_by_parent = children_by_parent

    def snapshot(self):
        return dict(self._notes)

    def has_backlinks(self, note_id: str) -> bool:
        return False

    def has_note(self, note_id: str) -> bool:
        return note_id in self._notes

    def get_note(self, note_id: str) -> _Note:
        return self._notes[note_id]

    def get_children(self, parent_id: Optional[str]) -> List[str]:
        return list(self._children_by_parent.get(parent_id, []))

    def list_note_ids(self) -> List[str]:
        return list(self._notes.keys())

    def get_inherited_non_meta_tag_terms(self, note_id: str):
        return frozenset()


def _local(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, MIDDAY).astimezone()


def _note(note_id: str, *, parent_id: Optional[str], created: date, updated: date) -> _Note:
    return _Note(
        id=note_id, parent_id=parent_id, prev_id=None, next_id=None, is_collapsed=False,
        content=f"<div>{note_id}</div>", tags="", created_at=_local(created), updated_at=_local(updated),
    )


@pytest.fixture
def three_roots(monkeypatch: pytest.MonkeyPatch) -> None:
    """An old root with a child edited today, a root made in September, one made today."""
    notes = {
        "old": _note("old", parent_id=None, created=date(2025, 3, 1), updated=date(2025, 3, 1)),
        "old-child": _note("old-child", parent_id="old", created=date(2025, 3, 2), updated=TODAY),
        "september": _note("september", parent_id=None, created=date(2026, 9, 10), updated=date(2026, 9, 10)),
        "today": _note("today", parent_id=None, created=TODAY, updated=TODAY),
    }
    store = _FakeNoteStore(notes=notes, children_by_parent={None: ["old", "september", "today"], "old": ["old-child"]})
    monkeypatch.setattr(snapshot, "note_store", store)
    monkeypatch.setattr(snapshot, "get_all_locks", lambda: {})
    monkeypatch.setattr(snapshot, "local_today", lambda: TODAY)
    monkeypatch.setattr(root_sorting, "note_store", store)


def _shown_roots(date_filter: RootDateFilter | None, *, editing_note_id: str | None) -> List[str]:
    state = snapshot.build_view_state(
        editing_note_id=editing_note_id, find_reveal_note_id=None, search=None, sort_mode="normal",
        date_filter=date_filter, file_filter=None, client_known_note_ids=set(), previous_root_ids=[], visible_top_root_id=None,
        visible_bottom_root_id=None, is_untagged_view=False, start_at_list_end=False,
    )
    # An empty view has no root entry.
    roots: List[str] = []
    if None in state.children_by_parent:
        roots = state.children_by_parent[None]
    assert state.metadata["rootCountTotal"] == len(roots)
    return roots


@pytest.mark.parametrize(("date_filter", "roots"), [
    (None, ["old", "september", "today"]),
    # Created: the root's own creation.
    (_preset("today", field="created"), ["today"]),
    (_preset("this-year", field="created"), ["september", "today"]),
    # Last updated: the latest update anywhere under the root.
    (_preset("today", field="updated"), ["old", "today"]),
    (_custom("2026-09-01", "2026-09-30", field="updated"), ["september"]),
    (_custom(OPEN_DATE, "2026-09-30", field="created"), ["old", "september"]),
    (_custom("2026-10-24", OPEN_DATE, field="created"), []),
])
def test_the_view_shows_the_roots_whose_date_is_in_the_range(
    three_roots, date_filter: RootDateFilter | None, roots: List[str],
) -> None:
    assert _shown_roots(date_filter, editing_note_id=None) == roots


def test_the_note_being_edited_stays_while_its_date_is_outside_the_range(three_roots) -> None:
    september = _custom("2026-09-01", "2026-09-30", field="updated")
    # Editing the old root's child moved its root's date to today; it stays in its place.
    assert _shown_roots(september, editing_note_id="old-child") == ["old", "september"]
    # Once editing ends it leaves the view.
    assert _shown_roots(september, editing_note_id=None) == ["september"]
