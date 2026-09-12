from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

import pytest

from app.db.schema import initialize_schema
from app.db.session import begin_writer
from app.models.database import SafeSession
from app.services.reminders import (
    PERSISTENCE_DROP_IF_MISSED,
    PERSISTENCE_KEEP_UNTIL_SEEN,
    REMINDER_STATUS_ACTIVE,
    REMINDER_STATUS_DONE,
    ReminderStore,
    SCHEDULE_ONE_TIME,
    SCHEDULE_RECURRING,
    TIME_MODE_DATE_ONLY,
    TIME_MODE_DATE_TIME,
    _acknowledge_due_occurrence,
    _evaluate_single_reminder,
    normalize_reminder_payload,
)


def _now(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    assert parsed.tzinfo is not None
    return parsed


def _prepare_memory_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(SafeSession, "_db_path", tmp_path / "notes.db")
    SafeSession.use_memory_db()
    with begin_writer() as connection:
        initialize_schema(connection)


def test_acknowledged_one_time_reminder_is_deleted_from_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _prepare_memory_db(tmp_path, monkeypatch)
    store = ReminderStore()
    try:
        store.clear_persisted_state_for_tests()
        reminder = store.create_reminder(
            payload={
                "note_id": None,
                "title": "One time",
                "details": "Join at https://example.test/visit",
                "attachment_type": "unattached",
                "schedule_kind": SCHEDULE_ONE_TIME,
                "time_mode": TIME_MODE_DATE_ONLY,
                "scheduled_at": None,
                "scheduled_date": "2026-06-08",
                "recurrence_rule": None,
                "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
                "status": REMINDER_STATUS_ACTIVE,
            },
            token="",
        )
        reminder_id = reminder["id"]
        assert isinstance(reminder_id, str)
        assert reminder["details"] == "Join at https://example.test/visit"
        assert len(store.list_reminders()) == 1

        completed = store.acknowledge_reminder(
            reminder_id=reminder_id,
            token="",
            now=_now("2026-06-08T10:00:00+00:00"),
            local_date=date(2026, 6, 8),
            activity_kind="non_idle_use",
        )
        assert completed["status"] == REMINDER_STATUS_DONE
        assert completed["details"] == "Join at https://example.test/visit"
        assert store.list_reminders() == []
    finally:
        store.clear_persisted_state_for_tests()
        SafeSession.use_file_db()


def test_drop_if_missed_one_time_reminder_is_deleted_from_store(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _prepare_memory_db(tmp_path, monkeypatch)
    store = ReminderStore()
    try:
        store.clear_persisted_state_for_tests()
        store.create_reminder(
            payload={
                "note_id": None,
                "title": "Forget me",
                "attachment_type": "unattached",
                "schedule_kind": SCHEDULE_ONE_TIME,
                "time_mode": TIME_MODE_DATE_ONLY,
                "scheduled_at": None,
                "scheduled_date": "2026-06-08",
                "recurrence_rule": None,
                "persistence_mode": PERSISTENCE_DROP_IF_MISSED,
                "status": REMINDER_STATUS_ACTIVE,
            },
            token="",
        )
        assert len(store.list_reminders()) == 1

        result = store.evaluate_due(
            now=_now("2026-06-09T10:00:00+00:00"),
            local_date=date(2026, 6, 9),
            activity_kind="non_idle_use",
            token="",
        )
        assert result["events"] == []
        assert len(result["changed"]) == 1
        assert result["changed"][0]["status"] == REMINDER_STATUS_DONE
        assert store.list_reminders() == []
    finally:
        store.clear_persisted_state_for_tests()
        SafeSession.use_file_db()


def test_retired_sound_fields_are_discarded_from_reminders(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _prepare_memory_db(tmp_path, monkeypatch)
    store = ReminderStore()
    try:
        store.clear_persisted_state_for_tests()
        reminder = store.create_reminder(
            payload={
                "note_id": None,
                "title": "Sounded",
                "attachment_type": "unattached",
                "schedule_kind": SCHEDULE_ONE_TIME,
                "time_mode": TIME_MODE_DATE_ONLY,
                "scheduled_at": None,
                "scheduled_date": "2026-06-08",
                "recurrence_rule": None,
                "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
                "popup_sound_enabled": True,
                "popup_sound_id": "builtin.silent",
                "ack_sound_enabled": True,
                "ack_sound_id": "22222222-2222-4222-8222-222222222222",
                "status": REMINDER_STATUS_ACTIVE,
            },
            token="",
        )

        assert not any("sound" in key for key in reminder)

        store.reset()
        session = SafeSession()
        try:
            store.bootstrap(connection=session.connection())
        finally:
            session.close()
        reloaded = store.get_reminder(reminder_id=reminder["id"])
        assert not any("sound" in key for key in reloaded)
    finally:
        store.clear_persisted_state_for_tests()
        SafeSession.use_file_db()


def test_date_only_reminder_fires_on_non_idle_use_only() -> None:
    now = _now("2026-06-08T10:00:00+00:00")
    reminder = normalize_reminder_payload(
        {
            "id": "reminder-1",
            "note_id": None,
            "title": "Check the thing",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_ONE_TIME,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-06-08",
            "recurrence_rule": None,
            "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
        },
        now=now,
        recompute_next=True,
    )

    idle_event = _evaluate_single_reminder(
        reminder=reminder,
        now=now,
        local_date=date(2026, 6, 8),
        activity_kind="idle",
    )
    assert idle_event is None
    assert reminder["last_fired_date"] is None
    assert reminder["is_currently_missed"] is False

    active_event = _evaluate_single_reminder(
        reminder=reminder,
        now=now,
        local_date=date(2026, 6, 8),
        activity_kind="non_idle_use",
    )
    assert active_event is not None
    assert active_event["kind"] == "due"
    assert reminder["last_fired_date"] == "2026-06-08"
    assert reminder["is_currently_missed"] is True
    assert reminder["missed_since"] == "2026-06-08"


def test_reminder_details_default_to_blank_for_legacy_payloads() -> None:
    reminder = normalize_reminder_payload(
        {
            "id": "reminder-legacy-details",
            "note_id": None,
            "title": "Legacy",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_ONE_TIME,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-06-08",
            "recurrence_rule": None,
            "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
        },
        now=_now("2026-06-07T10:00:00+00:00"),
        recompute_next=True,
    )

    assert reminder["details"] == ""
    assert reminder["pre_reminder"] is None
    assert reminder["pre_reminder_last_seen_key"] is None


def test_date_only_pre_reminder_must_be_day_based() -> None:
    with pytest.raises(ValueError, match="date-only reminders require day-based pre_reminder"):
        normalize_reminder_payload(
            {
                "id": "reminder-date-only-pre-hours",
                "note_id": None,
                "title": "Invalid pre-reminder",
                "attachment_type": "unattached",
                "schedule_kind": SCHEDULE_ONE_TIME,
                "time_mode": TIME_MODE_DATE_ONLY,
                "scheduled_at": None,
                "scheduled_date": "2026-06-08",
                "recurrence_rule": None,
                "pre_reminder": {"amount": 12, "unit": "hours"},
                "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
            },
            now=_now("2026-06-07T10:00:00+00:00"),
            recompute_next=True,
        )


def test_acknowledged_pre_reminder_keeps_one_time_reminder_live(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _prepare_memory_db(tmp_path, monkeypatch)
    store = ReminderStore()
    try:
        store.clear_persisted_state_for_tests()
        reminder = store.create_reminder(
            payload={
                "note_id": None,
                "title": "Appointment",
                "attachment_type": "unattached",
                "schedule_kind": SCHEDULE_ONE_TIME,
                "time_mode": TIME_MODE_DATE_TIME,
                "scheduled_at": "2026-06-08T09:30:00+00:00",
                "scheduled_date": None,
                "recurrence_rule": None,
                "pre_reminder": {"amount": 1, "unit": "days"},
                "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
                "status": REMINDER_STATUS_ACTIVE,
            },
            token="",
        )
        reminder_id = reminder["id"]
        assert isinstance(reminder_id, str)
        assert reminder["pre_reminder"] == {"amount": 1, "unit": "days"}

        updated = store.acknowledge_pre_reminder(
            reminder_id=reminder_id,
            token="",
            pre_reminder_key="appointment-pre-key",
            now=_now("2026-06-07T10:00:00+00:00"),
        )

        assert updated["status"] == REMINDER_STATUS_ACTIVE
        assert updated["next_fire_at"] == "2026-06-08T09:30:00+00:00"
        assert updated["pre_reminder_last_seen_key"] == "appointment-pre-key"
        assert len(store.list_reminders()) == 1
    finally:
        store.clear_persisted_state_for_tests()
        SafeSession.use_file_db()


def test_attached_reminders_are_deferred_until_picker_ux_exists() -> None:
    with pytest.raises(ValueError, match="note-attached reminders are not implemented yet"):
        normalize_reminder_payload(
            {
                "id": "reminder-attached",
                "note_id": "note-1",
                "title": "Attached prompt",
                "attachment_type": "attached",
                "schedule_kind": SCHEDULE_ONE_TIME,
                "time_mode": TIME_MODE_DATE_ONLY,
                "scheduled_at": None,
                "scheduled_date": "2026-06-08",
                "recurrence_rule": None,
                "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
            },
            now=_now("2026-06-07T10:00:00+00:00"),
            recompute_next=True,
        )


def test_date_only_drop_if_missed_is_silent_and_done() -> None:
    now = _now("2026-06-09T10:00:00+00:00")
    reminder = normalize_reminder_payload(
        {
            "id": "reminder-2",
            "note_id": None,
            "title": "Ephemeral prompt",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_ONE_TIME,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-06-08",
            "recurrence_rule": None,
            "persistence_mode": PERSISTENCE_DROP_IF_MISSED,
        },
        now=_now("2026-06-07T10:00:00+00:00"),
        recompute_next=True,
    )

    event = _evaluate_single_reminder(
        reminder=reminder,
        now=now,
        local_date=date(2026, 6, 9),
        activity_kind="non_idle_use",
    )
    assert event is None
    assert reminder["status"] == REMINDER_STATUS_DONE
    assert reminder["is_currently_missed"] is False
    assert reminder["missed_count"] == 0
    assert reminder["next_fire_date"] is None


def test_date_only_keep_until_seen_surfaces_missed_on_next_use() -> None:
    reminder = normalize_reminder_payload(
        {
            "id": "reminder-3",
            "note_id": None,
            "title": "Sticky prompt",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_ONE_TIME,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-06-08",
            "recurrence_rule": None,
            "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
        },
        now=_now("2026-06-07T10:00:00+00:00"),
        recompute_next=True,
    )

    event = _evaluate_single_reminder(
        reminder=reminder,
        now=_now("2026-06-09T10:00:00+00:00"),
        local_date=date(2026, 6, 9),
        activity_kind="non_idle_use",
    )
    assert event is not None
    assert event["kind"] == "missed"
    assert reminder["status"] == REMINDER_STATUS_ACTIVE
    assert reminder["is_currently_missed"] is True
    assert reminder["missed_since"] == "2026-06-08"
    assert reminder["missed_count"] == 1


def test_recurring_date_only_keep_until_seen_preserves_past_due_anchor() -> None:
    reminder = normalize_reminder_payload(
        {
            "id": "reminder-rent",
            "note_id": None,
            "title": "RENT",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_RECURRING,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-06-01",
            "recurrence_rule": {
                "frequency": "monthly",
                "interval": 1,
                "day_of_month": 1,
                "end": {"type": "never"},
                "date_trigger_policy": "on_first_non_idle_use",
            },
            "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
        },
        now=_now("2026-06-06T10:00:00+00:00"),
        recompute_next=True,
    )
    assert reminder["next_fire_date"] == "2026-06-01"

    event = _evaluate_single_reminder(
        reminder=reminder,
        now=_now("2026-06-06T10:05:00+00:00"),
        local_date=date(2026, 6, 6),
        activity_kind="non_idle_use",
    )
    assert event is not None
    assert event["kind"] == "missed"
    assert reminder["is_currently_missed"] is True
    assert reminder["missed_since"] == "2026-06-01"
    assert reminder["next_fire_date"] == "2026-07-01"


def test_recurring_date_only_keep_until_seen_repairs_legacy_skipped_anchor() -> None:
    reminder = normalize_reminder_payload(
        {
            "id": "reminder-rent-legacy",
            "note_id": None,
            "title": "RENT",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_RECURRING,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-06-01",
            "next_fire_date": "2026-07-01",
            "recurrence_rule": {
                "frequency": "monthly",
                "interval": 1,
                "day_of_month": 1,
                "end": {"type": "never"},
                "date_trigger_policy": "on_first_non_idle_use",
            },
            "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
            "occurrence_count": 0,
        },
        now=_now("2026-06-06T10:00:00+00:00"),
        recompute_next=False,
    )
    assert reminder["next_fire_date"] == "2026-07-01"

    event = _evaluate_single_reminder(
        reminder=reminder,
        now=_now("2026-06-06T10:05:00+00:00"),
        local_date=date(2026, 6, 6),
        activity_kind="non_idle_use",
    )
    assert event is not None
    assert event["kind"] == "missed"
    assert reminder["missed_since"] == "2026-06-01"
    assert reminder["next_fire_date"] == "2026-07-01"


def test_recurring_monthly_date_only_uses_last_day_for_shorter_months() -> None:
    reminder = normalize_reminder_payload(
        {
            "id": "reminder-month-end",
            "note_id": None,
            "title": "Month end",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_RECURRING,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-03-31",
            "recurrence_rule": {
                "frequency": "monthly",
                "interval": 1,
                "day_of_month": 31,
                "end": {"type": "never"},
                "date_trigger_policy": "on_first_non_idle_use",
            },
            "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
        },
        now=_now("2026-03-30T10:00:00+00:00"),
        recompute_next=True,
    )
    assert reminder["next_fire_date"] == "2026-03-31"

    event = _evaluate_single_reminder(
        reminder=reminder,
        now=_now("2026-03-31T10:05:00+00:00"),
        local_date=date(2026, 3, 31),
        activity_kind="non_idle_use",
    )
    assert event is not None
    assert event["kind"] == "due"
    assert reminder["next_fire_date"] == "2026-04-30"


def test_recurring_weekly_date_only_uses_selected_weekday_not_anchor_date() -> None:
    saturday = normalize_reminder_payload(
        {
            "id": "reminder-saturday",
            "note_id": None,
            "title": "Saturday",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_RECURRING,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-06-06",
            "recurrence_rule": {
                "frequency": "weekly",
                "interval": 1,
                "weekdays": [5],
                "end": {"type": "never"},
                "date_trigger_policy": "on_first_non_idle_use",
            },
            "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
        },
        now=_now("2026-06-06T10:00:00+00:00"),
        recompute_next=True,
    )
    sunday = normalize_reminder_payload(
        {
            "id": "reminder-sunday",
            "note_id": None,
            "title": "Sunday",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_RECURRING,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-06-06",
            "recurrence_rule": {
                "frequency": "weekly",
                "interval": 1,
                "weekdays": [6],
                "end": {"type": "never"},
                "date_trigger_policy": "on_first_non_idle_use",
            },
            "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
        },
        now=_now("2026-06-06T10:00:00+00:00"),
        recompute_next=True,
    )
    assert saturday["next_fire_date"] == "2026-06-06"
    assert sunday["next_fire_date"] == "2026-06-07"


def test_recurring_weekly_date_only_repairs_legacy_invalid_next_date() -> None:
    reminder = normalize_reminder_payload(
        {
            "id": "reminder-sunday-legacy",
            "note_id": None,
            "title": "Sunday",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_RECURRING,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-06-06",
            "next_fire_date": "2026-06-06",
            "recurrence_rule": {
                "frequency": "weekly",
                "interval": 1,
                "weekdays": [6],
                "end": {"type": "never"},
                "date_trigger_policy": "on_first_non_idle_use",
            },
            "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
        },
        now=_now("2026-06-06T10:00:00+00:00"),
        recompute_next=False,
    )
    event = _evaluate_single_reminder(
        reminder=reminder,
        now=_now("2026-06-06T10:05:00+00:00"),
        local_date=date(2026, 6, 6),
        activity_kind="non_idle_use",
    )
    assert event is None
    assert reminder["next_fire_date"] == "2026-06-07"


def test_acknowledge_advances_locally_shown_recurring_date_only_occurrence() -> None:
    reminder = normalize_reminder_payload(
        {
            "id": "reminder-saturday-local",
            "note_id": None,
            "title": "Saturday",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_RECURRING,
            "time_mode": TIME_MODE_DATE_ONLY,
            "scheduled_at": None,
            "scheduled_date": "2026-06-06",
            "recurrence_rule": {
                "frequency": "weekly",
                "interval": 1,
                "weekdays": [5],
                "end": {"type": "never"},
                "date_trigger_policy": "on_first_non_idle_use",
            },
            "persistence_mode": PERSISTENCE_KEEP_UNTIL_SEEN,
        },
        now=_now("2026-06-06T10:00:00+00:00"),
        recompute_next=True,
    )
    assert reminder["next_fire_date"] == "2026-06-06"

    _acknowledge_due_occurrence(
        reminder=reminder,
        now=_now("2026-06-06T10:05:00+00:00"),
        local_date=date(2026, 6, 6),
        activity_kind="non_idle_use",
    )
    assert reminder["next_fire_date"] == "2026-06-13"


def test_recurring_date_time_advances_after_due_fire() -> None:
    reminder = normalize_reminder_payload(
        {
            "id": "reminder-4",
            "note_id": None,
            "title": "Weekly prompt",
            "attachment_type": "unattached",
            "schedule_kind": SCHEDULE_RECURRING,
            "time_mode": TIME_MODE_DATE_TIME,
            "scheduled_at": "2026-06-08T09:00:00+00:00",
            "scheduled_date": None,
            "recurrence_rule": {
                "frequency": "weekly",
                "interval": 1,
                "weekdays": [0],
                "end": {"type": "never"},
                "time_of_day": "09:00",
            },
            "persistence_mode": PERSISTENCE_DROP_IF_MISSED,
        },
        now=_now("2026-06-07T10:00:00+00:00"),
        recompute_next=True,
    )
    assert reminder["next_fire_at"] == "2026-06-08T09:00:00+00:00"

    event = _evaluate_single_reminder(
        reminder=reminder,
        now=_now("2026-06-08T09:05:00+00:00"),
        local_date=date(2026, 6, 8),
        activity_kind="idle",
    )
    assert event is not None
    assert event["kind"] == "due"
    assert reminder["status"] == REMINDER_STATUS_ACTIVE
    assert reminder["occurrence_count"] == 1
    assert reminder["next_fire_at"] == "2026-06-15T09:00:00+00:00"
