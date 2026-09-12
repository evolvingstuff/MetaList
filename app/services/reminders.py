from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
import calendar
import json
from threading import RLock
from typing import Mapping, Optional
from uuid import UUID, uuid4

from app.db.reminders_sql import (
    delete_all_reminder_rows,
    delete_reminder_row,
    fetch_all_reminder_rows,
    upsert_reminder_row,
)
from app.db.session import begin_writer
from app.security.encryption import (
    get_encryption_service,
    get_encryption_service_with_token,
    is_encryption_required,
)


REMINDER_STATUS_ACTIVE = "active"
REMINDER_STATUS_PAUSED = "paused"
REMINDER_STATUS_DONE = "done"
REMINDER_STATUSES = frozenset(
    {
        REMINDER_STATUS_ACTIVE,
        REMINDER_STATUS_PAUSED,
        REMINDER_STATUS_DONE,
    }
)

ATTACHMENT_ATTACHED = "attached"
ATTACHMENT_UNATTACHED = "unattached"
ATTACHMENT_TYPES = frozenset({ATTACHMENT_ATTACHED, ATTACHMENT_UNATTACHED})

SCHEDULE_ONE_TIME = "one_time"
SCHEDULE_RECURRING = "recurring"
SCHEDULE_KINDS = frozenset({SCHEDULE_ONE_TIME, SCHEDULE_RECURRING})

TIME_MODE_DATE_TIME = "date_time"
TIME_MODE_DATE_ONLY = "date_only"
TIME_MODES = frozenset({TIME_MODE_DATE_TIME, TIME_MODE_DATE_ONLY})

PERSISTENCE_DROP_IF_MISSED = "drop_if_missed"
PERSISTENCE_KEEP_UNTIL_SEEN = "keep_until_seen"
PERSISTENCE_MODES = frozenset(
    {
        PERSISTENCE_DROP_IF_MISSED,
        PERSISTENCE_KEEP_UNTIL_SEEN,
    }
)

DATE_TRIGGER_ON_FIRST_NON_IDLE_USE = "on_first_non_idle_use"
RECURRENCE_FREQUENCIES = frozenset({"daily", "weekly", "monthly", "yearly"})
RECURRENCE_END_TYPES = frozenset({"never", "on_date", "after_count"})
PRE_REMINDER_UNITS = frozenset({"minutes", "hours", "days"})


@dataclass(frozen=True)
class _EncryptedReminderRow:
    reminder_id: str
    payload_json: str
    payload_encryption_nonce: bytes
    payload_encryption_tag: bytes
    created_at: datetime
    updated_at: datetime


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _serialize_dt(value: datetime) -> str:
    if not isinstance(value, datetime):
        raise TypeError("value must be a datetime")
    if value.tzinfo is None:
        raise ValueError("datetime must include timezone")
    return value.isoformat()


def _parse_dt(value: object, *, field_name: str) -> datetime:
    if not isinstance(value, str) or value == "":
        raise ValueError(f"{field_name} must be a non-empty ISO datetime string")
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError(f"{field_name} must include timezone")
    return parsed


def _parse_time_of_day(value: object, *, field_name: str) -> time:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be HH:MM string")
    parts = value.split(":")
    if len(parts) != 2:
        raise ValueError(f"{field_name} must be HH:MM string")
    hour = int(parts[0])
    minute = int(parts[1])
    return time(hour=hour, minute=minute)


def _serialize_time_of_day(value: time) -> str:
    if not isinstance(value, time):
        raise TypeError("value must be a time")
    return f"{value.hour:02d}:{value.minute:02d}"


def _parse_date(value: object, *, field_name: str) -> date:
    if not isinstance(value, str) or value == "":
        raise ValueError(f"{field_name} must be a non-empty YYYY-MM-DD string")
    return date.fromisoformat(value)


def _serialize_date(value: date) -> str:
    if not isinstance(value, date):
        raise TypeError("value must be a date")
    return value.isoformat()


def _coerce_nullable_str(value: object, *, field_name: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string or null")
    return value


def _required_mapping_value(mapping: Mapping[str, object], key: str) -> object:
    if not isinstance(key, str) or key == "":
        raise ValueError("key must be a non-empty string")
    if key in mapping:
        return mapping[key]
    raise ValueError(f"{key} is required")


def _mapping_value_or(mapping: Mapping[str, object], key: str, default_value: object) -> object:
    if not isinstance(key, str) or key == "":
        raise ValueError("key must be a non-empty string")
    if key in mapping:
        return mapping[key]
    return default_value


def _require_string(value: object, *, field_name: str, allow_blank: bool) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    if not allow_blank and value.strip() == "":
        raise ValueError(f"{field_name} must be non-empty")
    return value.strip()


def _require_choice(value: object, *, field_name: str, choices: frozenset[str]) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    if value not in choices:
        raise ValueError(f"{field_name} has unsupported value: {value!r}")
    return value


def _require_bool(value: object, *, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{field_name} must be a boolean")
    return value


def _require_int(value: object, *, field_name: str, min_value: int) -> int:
    if not isinstance(value, int):
        raise ValueError(f"{field_name} must be an integer")
    if value < min_value:
        raise ValueError(f"{field_name} must be >= {min_value}")
    return value




def _normalize_pre_reminder(raw_pre_reminder: object, *, time_mode: str) -> dict[str, object] | None:
    if raw_pre_reminder is None:
        return None
    if not isinstance(raw_pre_reminder, dict):
        raise ValueError("pre_reminder must be an object or null")
    amount = _require_int(
        _required_mapping_value(raw_pre_reminder, "amount"),
        field_name="pre_reminder.amount",
        min_value=1,
    )
    unit = _require_choice(
        _required_mapping_value(raw_pre_reminder, "unit"),
        field_name="pre_reminder.unit",
        choices=PRE_REMINDER_UNITS,
    )
    if time_mode == TIME_MODE_DATE_ONLY and unit != "days":
        raise ValueError("date-only reminders require day-based pre_reminder")
    return {
        "amount": amount,
        "unit": unit,
    }


def _local_date_from_dt(value: datetime) -> date:
    if not isinstance(value, datetime):
        raise TypeError("value must be datetime")
    if value.tzinfo is None:
        raise ValueError("value must include timezone")
    return value.date()


def _add_months(value: date, months: int) -> date:
    if not isinstance(months, int) or months <= 0:
        raise ValueError("months must be a positive integer")
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _add_years(value: date, years: int) -> date:
    if not isinstance(years, int) or years <= 0:
        raise ValueError("years must be a positive integer")
    target_year = value.year + years
    day = min(value.day, calendar.monthrange(target_year, value.month)[1])
    return date(target_year, value.month, day)


def _normalize_recurrence_rule(raw_rule: object, *, time_mode: str) -> dict[str, object]:
    if not isinstance(raw_rule, dict):
        raise ValueError("recurrence_rule must be an object")
    frequency = _require_choice(
        _required_mapping_value(raw_rule, "frequency"),
        field_name="recurrence_rule.frequency",
        choices=RECURRENCE_FREQUENCIES,
    )
    interval = _require_int(
        _required_mapping_value(raw_rule, "interval"),
        field_name="recurrence_rule.interval",
        min_value=1,
    )
    raw_end = _required_mapping_value(raw_rule, "end")
    if not isinstance(raw_end, dict):
        raise ValueError("recurrence_rule.end must be an object")
    end_type = _require_choice(
        _required_mapping_value(raw_end, "type"),
        field_name="recurrence_rule.end.type",
        choices=RECURRENCE_END_TYPES,
    )
    end: dict[str, object] = {"type": end_type}
    if end_type == "on_date":
        end["value"] = _serialize_date(
            _parse_date(_required_mapping_value(raw_end, "value"), field_name="recurrence_rule.end.value")
        )
    elif end_type == "after_count":
        end["value"] = _require_int(
            _required_mapping_value(raw_end, "value"),
            field_name="recurrence_rule.end.value",
            min_value=1,
        )

    normalized: dict[str, object] = {
        "frequency": frequency,
        "interval": interval,
        "end": end,
    }
    if frequency == "weekly":
        raw_weekdays = _mapping_value_or(raw_rule, "weekdays", None)
        if raw_weekdays is None:
            normalized["weekdays"] = []
        else:
            if not isinstance(raw_weekdays, list):
                raise ValueError("recurrence_rule.weekdays must be a list")
            weekdays: list[int] = []
            for raw_weekday in raw_weekdays:
                weekday = _require_int(
                    raw_weekday,
                    field_name="recurrence_rule.weekdays[]",
                    min_value=0,
                )
                if weekday > 6:
                    raise ValueError("recurrence_rule.weekdays[] must be between 0 and 6")
                if weekday not in weekdays:
                    weekdays.append(weekday)
            weekdays.sort()
            normalized["weekdays"] = weekdays
    if frequency == "monthly" and "day_of_month" in raw_rule:
        day_of_month = _require_int(
            _required_mapping_value(raw_rule, "day_of_month"),
            field_name="recurrence_rule.day_of_month",
            min_value=1,
        )
        if day_of_month > 31:
            raise ValueError("recurrence_rule.day_of_month must be between 1 and 31")
        normalized["day_of_month"] = day_of_month
    if frequency == "yearly":
        if "month" in raw_rule:
            month = _require_int(
                _required_mapping_value(raw_rule, "month"),
                field_name="recurrence_rule.month",
                min_value=1,
            )
            if month > 12:
                raise ValueError("recurrence_rule.month must be between 1 and 12")
            normalized["month"] = month
        if "day" in raw_rule:
            day = _require_int(_required_mapping_value(raw_rule, "day"), field_name="recurrence_rule.day", min_value=1)
            if day > 31:
                raise ValueError("recurrence_rule.day must be between 1 and 31")
            normalized["day"] = day
    if time_mode == TIME_MODE_DATE_TIME:
        if "time_of_day" in raw_rule and _required_mapping_value(raw_rule, "time_of_day") is not None:
            normalized["time_of_day"] = _serialize_time_of_day(
                _parse_time_of_day(
                    _required_mapping_value(raw_rule, "time_of_day"),
                    field_name="recurrence_rule.time_of_day",
                )
            )
    else:
        normalized["date_trigger_policy"] = DATE_TRIGGER_ON_FIRST_NON_IDLE_USE
    return normalized


def _end_allows_date(rule: Mapping[str, object], candidate: date, occurrence_count: int) -> bool:
    raw_end = rule["end"]
    if not isinstance(raw_end, dict):
        raise RuntimeError("recurrence end must be an object")
    end_type = raw_end["type"]
    if end_type == "never":
        return True
    if end_type == "on_date":
        end_date = _parse_date(raw_end["value"], field_name="recurrence_rule.end.value")
        return candidate <= end_date
    if end_type == "after_count":
        max_count = raw_end["value"]
        if not isinstance(max_count, int):
            raise RuntimeError("after_count value must be int")
        return occurrence_count < max_count
    raise RuntimeError(f"Unsupported recurrence end type: {end_type!r}")


def _candidate_date_for_month(value: date, day_of_month: int) -> date:
    last_day = calendar.monthrange(value.year, value.month)[1]
    return date(value.year, value.month, min(day_of_month, last_day))


def _candidate_date_for_year(value: date, month: int, day: int) -> date:
    last_day = calendar.monthrange(value.year, month)[1]
    return date(value.year, month, min(day, last_day))


def _next_recurrence_date(
    *,
    rule: Mapping[str, object],
    after_date: date,
    anchor_date: date,
    occurrence_count: int,
) -> Optional[date]:
    frequency = rule["frequency"]
    interval = rule["interval"]
    if not isinstance(frequency, str):
        raise RuntimeError("recurrence frequency must be string")
    if not isinstance(interval, int):
        raise RuntimeError("recurrence interval must be int")

    if frequency == "daily":
        candidate = anchor_date
        while candidate <= after_date:
            candidate = date.fromordinal(candidate.toordinal() + interval)
        if not _end_allows_date(rule, candidate, occurrence_count):
            return None
        return candidate

    if frequency == "weekly":
        raw_weekdays = _mapping_value_or(rule, "weekdays", [])
        if not isinstance(raw_weekdays, list):
            raise RuntimeError("weekly weekdays must be a list")
        weekdays = [int(entry) for entry in raw_weekdays]
        if not weekdays:
            weekdays = [anchor_date.weekday()]
        candidate = date.fromordinal(after_date.toordinal() + 1)
        for _ in range(0, 3710):
            weeks_since_anchor = (candidate - anchor_date).days // 7
            if weeks_since_anchor >= 0 and weeks_since_anchor % interval == 0 and candidate.weekday() in weekdays:
                if not _end_allows_date(rule, candidate, occurrence_count):
                    return None
                return candidate
            candidate = date.fromordinal(candidate.toordinal() + 1)
        raise RuntimeError("weekly recurrence search exceeded guard")

    if frequency == "monthly":
        day_of_month = _mapping_value_or(rule, "day_of_month", anchor_date.day)
        if not isinstance(day_of_month, int):
            raise RuntimeError("monthly day_of_month must be int")
        candidate_month = anchor_date
        while True:
            candidate = _candidate_date_for_month(candidate_month, day_of_month)
            if candidate > after_date:
                if not _end_allows_date(rule, candidate, occurrence_count):
                    return None
                return candidate
            candidate_month = _add_months(candidate_month, interval)

    if frequency == "yearly":
        month = _mapping_value_or(rule, "month", anchor_date.month)
        day = _mapping_value_or(rule, "day", anchor_date.day)
        if not isinstance(month, int) or not isinstance(day, int):
            raise RuntimeError("yearly month/day must be int")
        candidate_year_date = anchor_date
        while True:
            candidate = _candidate_date_for_year(candidate_year_date, month, day)
            if candidate > after_date:
                if not _end_allows_date(rule, candidate, occurrence_count):
                    return None
                return candidate
            candidate_year_date = _add_years(candidate_year_date, interval)

    raise RuntimeError(f"Unsupported recurrence frequency: {frequency!r}")


def compute_next_date_only_occurrence(
    *,
    reminder: Mapping[str, object],
    after_local_date: date,
) -> Optional[str]:
    rule = reminder["recurrence_rule"]
    if not isinstance(rule, dict):
        raise RuntimeError("recurring reminder requires recurrence_rule")
    anchor_date = _parse_date(reminder["scheduled_date"], field_name="scheduled_date")
    occurrence_count = _require_int(
        _mapping_value_or(reminder, "occurrence_count", 0),
        field_name="occurrence_count",
        min_value=0,
    )
    next_date = _next_recurrence_date(
        rule=rule,
        after_date=after_local_date,
        anchor_date=anchor_date,
        occurrence_count=occurrence_count,
    )
    if next_date is None:
        return None
    return _serialize_date(next_date)


def _date_is_recurrence_occurrence(*, reminder: Mapping[str, object], candidate: date) -> bool:
    if reminder["schedule_kind"] != SCHEDULE_RECURRING:
        raise ValueError("date match requires recurring reminder")
    if reminder["time_mode"] != TIME_MODE_DATE_ONLY:
        raise ValueError("date match requires date-only reminder")
    rule = reminder["recurrence_rule"]
    if not isinstance(rule, dict):
        raise RuntimeError("recurring reminder requires recurrence_rule")
    anchor_date = _parse_date(reminder["scheduled_date"], field_name="scheduled_date")
    previous_date = date.fromordinal(candidate.toordinal() - 1)
    occurrence_count = _require_int(
        _mapping_value_or(reminder, "occurrence_count", 0),
        field_name="occurrence_count",
        min_value=0,
    )
    next_date = _next_recurrence_date(
        rule=rule,
        after_date=previous_date,
        anchor_date=anchor_date,
        occurrence_count=occurrence_count,
    )
    return next_date == candidate


def compute_next_date_time_occurrence(
    *,
    reminder: Mapping[str, object],
    after_dt: datetime,
) -> Optional[str]:
    rule = reminder["recurrence_rule"]
    if not isinstance(rule, dict):
        raise RuntimeError("recurring reminder requires recurrence_rule")
    scheduled_at = _parse_dt(reminder["scheduled_at"], field_name="scheduled_at")
    anchor_date = _local_date_from_dt(scheduled_at)
    occurrence_count = _require_int(
        _mapping_value_or(reminder, "occurrence_count", 0),
        field_name="occurrence_count",
        min_value=0,
    )
    next_date = _next_recurrence_date(
        rule=rule,
        after_date=_local_date_from_dt(after_dt),
        anchor_date=anchor_date,
        occurrence_count=occurrence_count,
    )
    if next_date is None:
        return None

    if "time_of_day" in rule:
        fire_time = _parse_time_of_day(rule["time_of_day"], field_name="recurrence_rule.time_of_day")
    else:
        fire_time = scheduled_at.timetz().replace(tzinfo=None)
    candidate = datetime.combine(next_date, fire_time, tzinfo=scheduled_at.tzinfo)
    if candidate <= after_dt:
        later_date = _next_recurrence_date(
            rule=rule,
            after_date=next_date,
            anchor_date=anchor_date,
            occurrence_count=occurrence_count,
        )
        if later_date is None:
            return None
        candidate = datetime.combine(later_date, fire_time, tzinfo=scheduled_at.tzinfo)
    return _serialize_dt(candidate)


def _compute_initial_next_fields(reminder: dict[str, object], *, now: datetime) -> None:
    status = reminder["status"]
    if status != REMINDER_STATUS_ACTIVE:
        reminder["next_fire_at"] = None
        reminder["next_fire_date"] = None
        return

    schedule_kind = reminder["schedule_kind"]
    time_mode = reminder["time_mode"]
    if schedule_kind == SCHEDULE_ONE_TIME:
        if time_mode == TIME_MODE_DATE_TIME:
            reminder["next_fire_at"] = reminder["scheduled_at"]
            reminder["next_fire_date"] = None
        else:
            reminder["next_fire_at"] = None
            reminder["next_fire_date"] = reminder["scheduled_date"]
        return

    if time_mode == TIME_MODE_DATE_TIME:
        scheduled_at = _parse_dt(reminder["scheduled_at"], field_name="scheduled_at")
        if scheduled_at > now:
            reminder["next_fire_at"] = _serialize_dt(scheduled_at)
        else:
            reminder["next_fire_at"] = compute_next_date_time_occurrence(
                reminder=reminder,
                after_dt=now,
            )
        reminder["next_fire_date"] = None
    else:
        scheduled_date = _parse_date(reminder["scheduled_date"], field_name="scheduled_date")
        today = _local_date_from_dt(now)
        if (
            scheduled_date < today
            and reminder["persistence_mode"] == PERSISTENCE_KEEP_UNTIL_SEEN
            and _date_is_recurrence_occurrence(reminder=reminder, candidate=scheduled_date)
        ):
            reminder["next_fire_date"] = _serialize_date(scheduled_date)
        else:
            reminder["next_fire_date"] = compute_next_date_only_occurrence(
                reminder=reminder,
                after_local_date=date.fromordinal(today.toordinal() - 1),
            )
        reminder["next_fire_at"] = None


def normalize_reminder_payload(
    raw: Mapping[str, object],
    *,
    now: datetime,
    recompute_next: bool,
) -> dict[str, object]:
    if not isinstance(raw, Mapping):
        raise TypeError("reminder payload must be a mapping")
    reminder_id = _require_string(_mapping_value_or(raw, "id", str(uuid4())), field_name="id", allow_blank=False)
    attachment_type = _require_choice(
        _required_mapping_value(raw, "attachment_type"),
        field_name="attachment_type",
        choices=ATTACHMENT_TYPES,
    )
    note_id = _coerce_nullable_str(_required_mapping_value(raw, "note_id"), field_name="note_id")
    if attachment_type == ATTACHMENT_ATTACHED:
        raise ValueError("note-attached reminders are not implemented yet")
    if attachment_type == ATTACHMENT_UNATTACHED and note_id is not None:
        raise ValueError("unattached reminder requires note_id null")

    title = _require_string(_mapping_value_or(raw, "title", ""), field_name="title", allow_blank=True)
    if attachment_type == ATTACHMENT_UNATTACHED and title == "":
        raise ValueError("standalone reminder requires non-empty title")
    details = _require_string(_mapping_value_or(raw, "details", ""), field_name="details", allow_blank=True)

    schedule_kind = _require_choice(
        _required_mapping_value(raw, "schedule_kind"),
        field_name="schedule_kind",
        choices=SCHEDULE_KINDS,
    )
    time_mode = _require_choice(_required_mapping_value(raw, "time_mode"), field_name="time_mode", choices=TIME_MODES)
    status = _require_choice(_mapping_value_or(raw, "status", REMINDER_STATUS_ACTIVE), field_name="status", choices=REMINDER_STATUSES)
    pre_reminder = _normalize_pre_reminder(_mapping_value_or(raw, "pre_reminder", None), time_mode=time_mode)
    persistence_mode = _require_choice(
        _required_mapping_value(raw, "persistence_mode"),
        field_name="persistence_mode",
        choices=PERSISTENCE_MODES,
    )

    recurrence_rule: Optional[dict[str, object]] = None
    if schedule_kind == SCHEDULE_RECURRING:
        recurrence_rule = _normalize_recurrence_rule(_required_mapping_value(raw, "recurrence_rule"), time_mode=time_mode)
    elif _mapping_value_or(raw, "recurrence_rule", None) is not None:
        raise ValueError("one-time reminder requires recurrence_rule null")

    scheduled_at: Optional[str] = None
    scheduled_date: Optional[str] = None
    date_trigger_policy: Optional[str] = None
    if time_mode == TIME_MODE_DATE_TIME:
        scheduled_at = _serialize_dt(_parse_dt(_required_mapping_value(raw, "scheduled_at"), field_name="scheduled_at"))
        if _mapping_value_or(raw, "scheduled_date", None) is not None or _mapping_value_or(raw, "next_fire_date", None) is not None:
            raise ValueError("date-time reminders require date-only fields to be null")
    else:
        scheduled_date = _serialize_date(_parse_date(_required_mapping_value(raw, "scheduled_date"), field_name="scheduled_date"))
        date_trigger_policy = DATE_TRIGGER_ON_FIRST_NON_IDLE_USE
        if _mapping_value_or(raw, "scheduled_at", None) is not None or _mapping_value_or(raw, "next_fire_at", None) is not None:
            raise ValueError("date-only reminders require date-time fields to be null")

    created_at = _mapping_value_or(raw, "created_at", None)
    if created_at is None:
        created_at_text = _serialize_dt(now)
    else:
        created_at_text = _serialize_dt(_parse_dt(created_at, field_name="created_at"))

    updated_at = _mapping_value_or(raw, "updated_at", None)
    if updated_at is None:
        updated_at_text = _serialize_dt(now)
    else:
        updated_at_text = _serialize_dt(_parse_dt(updated_at, field_name="updated_at"))

    reminder: dict[str, object] = {
        "id": reminder_id,
        "note_id": note_id,
        "title": title,
        "details": details,
        "attachment_type": attachment_type,
        "schedule_kind": schedule_kind,
        "time_mode": time_mode,
        "scheduled_at": scheduled_at,
        "next_fire_at": None,
        "scheduled_date": scheduled_date,
        "next_fire_date": None,
        "pre_reminder": pre_reminder,
        "pre_reminder_last_seen_key": _coerce_nullable_str(
            _mapping_value_or(raw, "pre_reminder_last_seen_key", None),
            field_name="pre_reminder_last_seen_key",
        ),
        "date_trigger_policy": date_trigger_policy,
        "recurrence_rule": recurrence_rule,
        "persistence_mode": persistence_mode,
        "status": status,
        "last_fired_at": _coerce_nullable_str(_mapping_value_or(raw, "last_fired_at", None), field_name="last_fired_at"),
        "last_fired_date": _coerce_nullable_str(_mapping_value_or(raw, "last_fired_date", None), field_name="last_fired_date"),
        "last_seen_at": _coerce_nullable_str(_mapping_value_or(raw, "last_seen_at", None), field_name="last_seen_at"),
        "is_currently_missed": bool(_mapping_value_or(raw, "is_currently_missed", False)),
        "missed_since": _coerce_nullable_str(_mapping_value_or(raw, "missed_since", None), field_name="missed_since"),
        "missed_count": _require_int(_mapping_value_or(raw, "missed_count", 0), field_name="missed_count", min_value=0),
        "snoozed_until": _coerce_nullable_str(_mapping_value_or(raw, "snoozed_until", None), field_name="snoozed_until"),
        "occurrence_count": _require_int(_mapping_value_or(raw, "occurrence_count", 0), field_name="occurrence_count", min_value=0),
        "created_at": created_at_text,
        "updated_at": updated_at_text,
    }
    if recompute_next:
        _compute_initial_next_fields(reminder, now=now)
    else:
        if time_mode == TIME_MODE_DATE_TIME:
            reminder["next_fire_at"] = _coerce_nullable_str(_mapping_value_or(raw, "next_fire_at", None), field_name="next_fire_at")
            reminder["next_fire_date"] = None
            if reminder["next_fire_at"] is not None:
                reminder["next_fire_at"] = _serialize_dt(
                    _parse_dt(reminder["next_fire_at"], field_name="next_fire_at")
                )
        else:
            reminder["next_fire_at"] = None
            reminder["next_fire_date"] = _coerce_nullable_str(_mapping_value_or(raw, "next_fire_date", None), field_name="next_fire_date")
            if reminder["next_fire_date"] is not None:
                reminder["next_fire_date"] = _serialize_date(
                    _parse_date(reminder["next_fire_date"], field_name="next_fire_date")
                )
    return reminder


def _deserialize_payload_json(payload_json: str) -> dict[str, object]:
    if not isinstance(payload_json, str) or payload_json == "":
        raise ValueError("reminder payload_json must be a non-empty string")
    parsed = json.loads(payload_json)
    if not isinstance(parsed, dict):
        raise RuntimeError("reminder payload_json must decode to an object")
    return normalize_reminder_payload(parsed, now=_utc_now(), recompute_next=False)


def _serialize_payload(reminder: Mapping[str, object]) -> str:
    normalized = normalize_reminder_payload(reminder, now=_utc_now(), recompute_next=False)
    return json.dumps(normalized, separators=(",", ":"), sort_keys=True)


def _row_is_encrypted(row: Mapping[str, object]) -> bool:
    nonce = row["payload_encryption_nonce"]
    tag = row["payload_encryption_tag"]
    if (nonce is None) != (tag is None):
        raise RuntimeError(
            "reminders row has incomplete encryption metadata: "
            f"id={row['id']} nonce={nonce is not None} tag={tag is not None}"
        )
    return nonce is not None


class ReminderStore:
    """Namespace-local reminder cache with encrypted write-through persistence."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._reminders: dict[str, dict[str, object]] = {}
        self._encrypted_rows: dict[str, _EncryptedReminderRow] = {}

    def bootstrap(self, *, connection) -> None:
        rows = fetch_all_reminder_rows(connection)
        reminders: dict[str, dict[str, object]] = {}
        encrypted_rows: dict[str, _EncryptedReminderRow] = {}
        for row in rows:
            reminder_id = row["id"]
            payload_json = row["payload_json"]
            created_at = row["created_at"]
            updated_at = row["updated_at"]
            if not isinstance(reminder_id, str) or reminder_id == "":
                raise RuntimeError("reminders.id must be a non-empty string")
            if not isinstance(payload_json, str) or payload_json == "":
                raise RuntimeError("reminders.payload_json must be a non-empty string")
            if not isinstance(created_at, datetime):
                raise TypeError("reminders.created_at must be datetime")
            if not isinstance(updated_at, datetime):
                raise TypeError("reminders.updated_at must be datetime")

            if _row_is_encrypted(row):
                nonce = row["payload_encryption_nonce"]
                tag = row["payload_encryption_tag"]
                if not isinstance(nonce, bytes) or not isinstance(tag, bytes):
                    raise TypeError("encrypted reminder nonce/tag must be bytes")
                encrypted_rows[reminder_id] = _EncryptedReminderRow(
                    reminder_id=reminder_id,
                    payload_json=payload_json,
                    payload_encryption_nonce=nonce,
                    payload_encryption_tag=tag,
                    created_at=created_at,
                    updated_at=updated_at,
                )
                continue
            reminder = _deserialize_payload_json(payload_json)
            if reminder["id"] != reminder_id:
                raise RuntimeError(f"reminder payload id mismatch for {reminder_id}")
            reminders[reminder_id] = reminder

        with self._lock:
            self._reminders = reminders
            self._encrypted_rows = encrypted_rows
            self._try_decrypt_locked(token="", require_success=False)

    def ensure_decrypted(self, *, token: str) -> None:
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        with self._lock:
            self._try_decrypt_locked(token=token, require_success=True)

    def reset(self) -> None:
        with self._lock:
            self._reminders = {}
            self._encrypted_rows = {}

    def clear_persisted_state_for_tests(self) -> None:
        with begin_writer() as connection:
            delete_all_reminder_rows(connection)
        self.reset()

    def list_reminders(self) -> list[dict[str, object]]:
        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            return [deepcopy(reminder) for reminder in self._sorted_reminders_locked()]

    def get_reminder(self, *, reminder_id: str) -> dict[str, object]:
        if not isinstance(reminder_id, str) or reminder_id == "":
            raise ValueError("reminder_id must be a non-empty string")
        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            if reminder_id not in self._reminders:
                raise KeyError(f"Reminder not found: {reminder_id}")
            return deepcopy(self._reminders[reminder_id])


    def create_reminder(self, *, payload: Mapping[str, object], token: str) -> dict[str, object]:
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        now = _utc_now()
        raw = dict(payload)
        raw["id"] = str(uuid4())
        raw["created_at"] = _serialize_dt(now)
        raw["updated_at"] = _serialize_dt(now)
        reminder = normalize_reminder_payload(raw, now=now, recompute_next=True)
        if reminder["status"] == REMINDER_STATUS_DONE:
            raise ValueError("done reminders are deleted, not stored")
        with self._lock:
            self._try_decrypt_locked(token=token, require_success=True)
            reminder_id = reminder["id"]
            assert isinstance(reminder_id, str)
            while reminder_id in self._reminders:
                reminder["id"] = str(uuid4())
                reminder_id = reminder["id"]
                assert isinstance(reminder_id, str)
            self._reminders[reminder_id] = deepcopy(reminder)
            self._persist_locked(reminder=reminder, token=token, connection=None, encryption_service=None, force_plaintext=False)
            return deepcopy(reminder)

    def update_reminder(self, *, reminder_id: str, payload: Mapping[str, object], token: str) -> dict[str, object]:
        if not isinstance(reminder_id, str) or reminder_id == "":
            raise ValueError("reminder_id must be a non-empty string")
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        with self._lock:
            self._try_decrypt_locked(token=token, require_success=True)
            if reminder_id not in self._reminders:
                raise KeyError(f"Reminder not found: {reminder_id}")
            existing = self._reminders[reminder_id]
            raw = dict(payload)
            raw["id"] = reminder_id
            raw["created_at"] = existing["created_at"]
            raw["updated_at"] = _serialize_dt(_utc_now())
            reminder = normalize_reminder_payload(raw, now=_utc_now(), recompute_next=True)
            if reminder["status"] == REMINDER_STATUS_DONE:
                raise ValueError("done reminders are deleted, not stored")
            self._reminders[reminder_id] = deepcopy(reminder)
            self._persist_locked(reminder=reminder, token=token, connection=None, encryption_service=None, force_plaintext=False)
            return deepcopy(reminder)

    def delete_reminder(self, *, reminder_id: str, token: str) -> None:
        if not isinstance(reminder_id, str) or reminder_id == "":
            raise ValueError("reminder_id must be a non-empty string")
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        with self._lock:
            self._try_decrypt_locked(token=token, require_success=True)
            if reminder_id not in self._reminders:
                raise KeyError(f"Reminder not found: {reminder_id}")
            del self._reminders[reminder_id]
            with begin_writer() as connection:
                delete_reminder_row(connection, reminder_id=reminder_id)

    def acknowledge_reminder(
        self,
        *,
        reminder_id: str,
        token: str,
        now: datetime,
        local_date: date,
        activity_kind: str,
    ) -> dict[str, object]:
        if not isinstance(now, datetime):
            raise TypeError("now must be datetime")
        if now.tzinfo is None:
            raise ValueError("now must include timezone")
        if not isinstance(local_date, date):
            raise TypeError("local_date must be date")
        if activity_kind not in {"idle", "non_idle_use"}:
            raise ValueError("activity_kind must be idle or non_idle_use")
        return self._acknowledge_status(
            reminder_id=reminder_id,
            token=token,
            now=now,
            local_date=local_date,
            activity_kind=activity_kind,
        )

    def acknowledge_pre_reminder(
        self,
        *,
        reminder_id: str,
        token: str,
        pre_reminder_key: str,
        now: datetime,
    ) -> dict[str, object]:
        if not isinstance(pre_reminder_key, str) or pre_reminder_key == "":
            raise ValueError("pre_reminder_key must be a non-empty string")
        if not isinstance(now, datetime):
            raise TypeError("now must be datetime")
        if now.tzinfo is None:
            raise ValueError("now must include timezone")
        if not isinstance(reminder_id, str) or reminder_id == "":
            raise ValueError("reminder_id must be a non-empty string")
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        with self._lock:
            self._try_decrypt_locked(token=token, require_success=True)
            if reminder_id not in self._reminders:
                raise KeyError(f"Reminder not found: {reminder_id}")
            reminder = self._reminders[reminder_id]
            if reminder["pre_reminder"] is None:
                raise ValueError("reminder has no pre_reminder")
            reminder["pre_reminder_last_seen_key"] = pre_reminder_key
            reminder["last_seen_at"] = _serialize_dt(now)
            reminder["updated_at"] = _serialize_dt(now)
            self._persist_locked(reminder=reminder, token=token, connection=None, encryption_service=None, force_plaintext=False)
            return deepcopy(reminder)

    def dismiss_reminder(self, *, reminder_id: str, token: str) -> dict[str, object]:
        return self._mutate_status(reminder_id=reminder_id, token=token, action="dismiss", now=_utc_now())

    def mark_done(self, *, reminder_id: str, token: str) -> dict[str, object]:
        return self._mutate_status(reminder_id=reminder_id, token=token, action="done", now=_utc_now())

    def pause_reminder(self, *, reminder_id: str, token: str) -> dict[str, object]:
        return self._mutate_status(reminder_id=reminder_id, token=token, action="pause", now=_utc_now())

    def resume_reminder(self, *, reminder_id: str, token: str) -> dict[str, object]:
        return self._mutate_status(reminder_id=reminder_id, token=token, action="resume", now=_utc_now())

    def skip_next(self, *, reminder_id: str, token: str) -> dict[str, object]:
        return self._mutate_status(reminder_id=reminder_id, token=token, action="skip_next", now=_utc_now())

    def evaluate_due(
        self,
        *,
        now: datetime,
        local_date: date,
        activity_kind: str,
        token: str,
    ) -> dict[str, object]:
        if not isinstance(now, datetime):
            raise TypeError("now must be datetime")
        if now.tzinfo is None:
            raise ValueError("now must include timezone")
        if not isinstance(local_date, date):
            raise TypeError("local_date must be date")
        if activity_kind not in {"idle", "non_idle_use"}:
            raise ValueError("activity_kind must be idle or non_idle_use")
        if not isinstance(token, str):
            raise TypeError("token must be a string")

        emitted: list[dict[str, object]] = []
        changed: list[dict[str, object]] = []
        with self._lock:
            self._try_decrypt_locked(token=token, require_success=True)
            for reminder_id in list(self._reminders.keys()):
                reminder = self._reminders[reminder_id]
                before = deepcopy(reminder)
                event = _evaluate_single_reminder(
                    reminder=reminder,
                    now=now,
                    local_date=local_date,
                    activity_kind=activity_kind,
                )
                if event is not None:
                    emitted.append(event)
                if reminder != before:
                    reminder["updated_at"] = _serialize_dt(now)
                    changed.append(deepcopy(reminder))
                    if reminder["status"] == REMINDER_STATUS_DONE:
                        del self._reminders[reminder_id]
                        with begin_writer() as connection:
                            delete_reminder_row(connection, reminder_id=reminder_id)
                        continue
                    self._persist_locked(
                        reminder=reminder,
                        token=token,
                        connection=None,
                        encryption_service=None,
                        force_plaintext=False,
                    )
        return {"events": emitted, "changed": changed}

    def rewrite_persisted_reminders(
        self,
        *,
        encryption_service: object | None,
        force_plaintext: bool,
        connection,
    ) -> int:
        if not isinstance(force_plaintext, bool):
            raise TypeError("force_plaintext must be a bool")
        count = 0
        with self._lock:
            self._try_decrypt_locked(token="", require_success=True)
            for reminder in self._reminders.values():
                self._persist_locked(
                    reminder=reminder,
                    token="",
                    connection=connection,
                    encryption_service=encryption_service,
                    force_plaintext=force_plaintext,
                )
                count += 1
        return count

    def _mutate_status(
        self,
        *,
        reminder_id: str,
        token: str,
        action: str,
        now: datetime,
    ) -> dict[str, object]:
        if not isinstance(reminder_id, str) or reminder_id == "":
            raise ValueError("reminder_id must be a non-empty string")
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        with self._lock:
            self._try_decrypt_locked(token=token, require_success=True)
            if reminder_id not in self._reminders:
                raise KeyError(f"Reminder not found: {reminder_id}")
            reminder = self._reminders[reminder_id]
            if action in {"acknowledge", "dismiss"}:
                reminder["is_currently_missed"] = False
                reminder["missed_since"] = None
                reminder["last_seen_at"] = _serialize_dt(now)
                if reminder["schedule_kind"] == SCHEDULE_ONE_TIME:
                    reminder["status"] = REMINDER_STATUS_DONE
                    reminder["next_fire_at"] = None
                    reminder["next_fire_date"] = None
            elif action == "done":
                reminder["status"] = REMINDER_STATUS_DONE
                reminder["next_fire_at"] = None
                reminder["next_fire_date"] = None
                reminder["is_currently_missed"] = False
                reminder["missed_since"] = None
            elif action == "pause":
                reminder["status"] = REMINDER_STATUS_PAUSED
            elif action == "resume":
                reminder["status"] = REMINDER_STATUS_ACTIVE
                _compute_initial_next_fields(reminder, now=now)
            elif action == "skip_next":
                if reminder["schedule_kind"] != SCHEDULE_RECURRING:
                    raise ValueError("skip_next requires a recurring reminder")
                _advance_recurring_reminder(reminder=reminder, now=now)
            else:
                raise RuntimeError(f"Unsupported reminder action: {action}")
            reminder["updated_at"] = _serialize_dt(now)
            if reminder["status"] == REMINDER_STATUS_DONE:
                completed_reminder = deepcopy(reminder)
                del self._reminders[reminder_id]
                with begin_writer() as connection:
                    delete_reminder_row(connection, reminder_id=reminder_id)
                return completed_reminder
            self._persist_locked(reminder=reminder, token=token, connection=None, encryption_service=None, force_plaintext=False)
            return deepcopy(reminder)

    def _acknowledge_status(
        self,
        *,
        reminder_id: str,
        token: str,
        now: datetime,
        local_date: date,
        activity_kind: str,
    ) -> dict[str, object]:
        if not isinstance(reminder_id, str) or reminder_id == "":
            raise ValueError("reminder_id must be a non-empty string")
        if not isinstance(token, str):
            raise TypeError("token must be a string")
        with self._lock:
            self._try_decrypt_locked(token=token, require_success=True)
            if reminder_id not in self._reminders:
                raise KeyError(f"Reminder not found: {reminder_id}")
            reminder = self._reminders[reminder_id]
            reminder["is_currently_missed"] = False
            reminder["missed_since"] = None
            reminder["last_seen_at"] = _serialize_dt(now)
            if reminder["schedule_kind"] == SCHEDULE_ONE_TIME:
                reminder["status"] = REMINDER_STATUS_DONE
                reminder["next_fire_at"] = None
                reminder["next_fire_date"] = None
            else:
                _acknowledge_due_occurrence(
                    reminder=reminder,
                    now=now,
                    local_date=local_date,
                    activity_kind=activity_kind,
                )
            reminder["updated_at"] = _serialize_dt(now)
            if reminder["status"] == REMINDER_STATUS_DONE:
                completed_reminder = deepcopy(reminder)
                del self._reminders[reminder_id]
                with begin_writer() as connection:
                    delete_reminder_row(connection, reminder_id=reminder_id)
                return completed_reminder
            self._persist_locked(reminder=reminder, token=token, connection=None, encryption_service=None, force_plaintext=False)
            return deepcopy(reminder)

    def _try_decrypt_locked(self, *, token: str, require_success: bool) -> None:
        if not self._encrypted_rows:
            return
        service = self._resolve_encryption_service(token=token, explicit_service=None)
        if service is None:
            if require_success:
                raise RuntimeError("reminder decryption requires an active DEK")
            return
        decrypt_fn = getattr(service, "decrypt_from_storage", None)
        if not callable(decrypt_fn):
            raise TypeError("encryption service must expose decrypt_from_storage")

        decrypted: dict[str, dict[str, object]] = {}
        for row in self._encrypted_rows.values():
            plaintext = decrypt_fn(
                row.payload_json,
                row.payload_encryption_nonce,
                row.payload_encryption_tag,
            )
            if not isinstance(plaintext, str):
                raise TypeError("decrypted reminder payload must be a string")
            reminder = _deserialize_payload_json(plaintext)
            if reminder["id"] != row.reminder_id:
                raise RuntimeError(f"reminder payload id mismatch for {row.reminder_id}")
            decrypted[row.reminder_id] = reminder
        self._reminders.update(decrypted)
        self._encrypted_rows = {}

    def _persist_locked(
        self,
        *,
        reminder: Mapping[str, object],
        token: str,
        connection,
        encryption_service: object | None,
        force_plaintext: bool,
    ) -> None:
        if not isinstance(force_plaintext, bool):
            raise TypeError("force_plaintext must be bool")
        payload_json = _serialize_payload(reminder)
        stored_json = payload_json
        nonce: Optional[bytes] = None
        tag: Optional[bytes] = None
        if not force_plaintext:
            service = self._resolve_encryption_service(
                token=token,
                explicit_service=encryption_service,
            )
            if service is not None:
                encrypt_fn = getattr(service, "encrypt_for_storage", None)
                if not callable(encrypt_fn):
                    raise TypeError("encryption service must expose encrypt_for_storage")
                stored_json, nonce, tag = encrypt_fn(payload_json)
            elif is_encryption_required():
                raise RuntimeError("reminder persistence requires an active DEK")
        created_at = _parse_dt(reminder["created_at"], field_name="created_at")
        updated_at = _parse_dt(reminder["updated_at"], field_name="updated_at")
        reminder_id = reminder["id"]
        if not isinstance(reminder_id, str):
            raise RuntimeError("reminder id must be string")
        if connection is not None:
            upsert_reminder_row(
                connection,
                reminder_id=reminder_id,
                payload_json=stored_json,
                payload_encryption_nonce=nonce,
                payload_encryption_tag=tag,
                created_at=created_at,
                updated_at=updated_at,
            )
            return
        with begin_writer() as writer_connection:
            upsert_reminder_row(
                writer_connection,
                reminder_id=reminder_id,
                payload_json=stored_json,
                payload_encryption_nonce=nonce,
                payload_encryption_tag=tag,
                created_at=created_at,
                updated_at=updated_at,
            )

    def _resolve_encryption_service(self, *, token: str, explicit_service: object | None):
        if explicit_service is not None:
            dek = getattr(explicit_service, "dek", None)
            if dek is None:
                raise RuntimeError("explicit encryption service must have an active DEK")
            return explicit_service
        if token:
            return get_encryption_service_with_token(token)
        return get_encryption_service()

    def _sorted_reminders_locked(self) -> list[dict[str, object]]:
        return sorted(
            self._reminders.values(),
            key=lambda reminder: (
                reminder["next_fire_at"] or reminder["next_fire_date"] or "9999-12-31T23:59:59+00:00",
                reminder["created_at"],
                reminder["id"],
            ),
        )


def _advance_recurring_reminder(*, reminder: dict[str, object], now: datetime) -> None:
    if reminder["schedule_kind"] != SCHEDULE_RECURRING:
        raise ValueError("advance requires recurring reminder")
    reminder["occurrence_count"] = int(_mapping_value_or(reminder, "occurrence_count", 0)) + 1
    if reminder["time_mode"] == TIME_MODE_DATE_TIME:
        base = now
        current_next = reminder["next_fire_at"]
        if isinstance(current_next, str):
            base = _parse_dt(current_next, field_name="next_fire_at")
        reminder["next_fire_at"] = compute_next_date_time_occurrence(
            reminder=reminder,
            after_dt=base,
        )
        reminder["next_fire_date"] = None
    else:
        base_date = _local_date_from_dt(now)
        current_next_date = reminder["next_fire_date"]
        if isinstance(current_next_date, str):
            base_date = _parse_date(current_next_date, field_name="next_fire_date")
        reminder["next_fire_date"] = compute_next_date_only_occurrence(
            reminder=reminder,
            after_local_date=base_date,
        )
        reminder["next_fire_at"] = None
    if reminder["next_fire_at"] is None and reminder["next_fire_date"] is None:
        reminder["status"] = REMINDER_STATUS_DONE


def _mark_missed(*, reminder: dict[str, object], missed_since: str) -> None:
    if reminder["persistence_mode"] != PERSISTENCE_KEEP_UNTIL_SEEN:
        raise ValueError("missed state only applies to keep_until_seen reminders")
    if reminder["is_currently_missed"] is False:
        reminder["missed_count"] = int(reminder["missed_count"]) + 1
    reminder["is_currently_missed"] = True
    reminder["missed_since"] = missed_since


def _restore_unseen_past_date_only_anchor(*, reminder: dict[str, object], local_date: date) -> None:
    if reminder["schedule_kind"] != SCHEDULE_RECURRING:
        return
    if reminder["time_mode"] != TIME_MODE_DATE_ONLY:
        return
    if reminder["persistence_mode"] != PERSISTENCE_KEEP_UNTIL_SEEN:
        return
    if reminder["occurrence_count"] != 0:
        return
    scheduled_date = _parse_date(reminder["scheduled_date"], field_name="scheduled_date")
    if scheduled_date >= local_date:
        return
    if not _date_is_recurrence_occurrence(reminder=reminder, candidate=scheduled_date):
        return
    next_fire_date = reminder["next_fire_date"]
    if next_fire_date is None:
        reminder["next_fire_date"] = _serialize_date(scheduled_date)
        return
    if not isinstance(next_fire_date, str):
        raise RuntimeError("date-only reminder next_fire_date must be string or None")
    if _parse_date(next_fire_date, field_name="next_fire_date") > local_date:
        reminder["next_fire_date"] = _serialize_date(scheduled_date)


def _repair_invalid_recurring_date_only_next(*, reminder: dict[str, object], local_date: date) -> None:
    if reminder["schedule_kind"] != SCHEDULE_RECURRING:
        return
    if reminder["time_mode"] != TIME_MODE_DATE_ONLY:
        return
    next_fire_date = reminder["next_fire_date"]
    if not isinstance(next_fire_date, str):
        return
    candidate = _parse_date(next_fire_date, field_name="next_fire_date")
    if _date_is_recurrence_occurrence(reminder=reminder, candidate=candidate):
        return
    reminder["next_fire_date"] = compute_next_date_only_occurrence(
        reminder=reminder,
        after_local_date=date.fromordinal(local_date.toordinal() - 1),
    )


def _acknowledge_due_occurrence(
    *,
    reminder: dict[str, object],
    now: datetime,
    local_date: date,
    activity_kind: str,
) -> None:
    if reminder["schedule_kind"] != SCHEDULE_RECURRING:
        return
    if reminder["time_mode"] == TIME_MODE_DATE_TIME:
        next_fire_at = reminder["next_fire_at"]
        if not isinstance(next_fire_at, str):
            return
        if _parse_dt(next_fire_at, field_name="next_fire_at") > now:
            return
        _advance_recurring_reminder(reminder=reminder, now=now)
        return

    if activity_kind != "non_idle_use":
        return
    _restore_unseen_past_date_only_anchor(reminder=reminder, local_date=local_date)
    _repair_invalid_recurring_date_only_next(reminder=reminder, local_date=local_date)
    next_fire_date = reminder["next_fire_date"]
    if not isinstance(next_fire_date, str):
        return
    if _parse_date(next_fire_date, field_name="next_fire_date") > local_date:
        return
    _advance_recurring_reminder(reminder=reminder, now=now)


def _emit_event(*, reminder: Mapping[str, object], event_kind: str) -> dict[str, object]:
    return {
        "kind": event_kind,
        "reminder": deepcopy(dict(reminder)),
    }


def _evaluate_single_reminder(
    *,
    reminder: dict[str, object],
    now: datetime,
    local_date: date,
    activity_kind: str,
) -> Optional[dict[str, object]]:
    if reminder["status"] != REMINDER_STATUS_ACTIVE:
        return None
    snoozed_until = reminder["snoozed_until"]
    if isinstance(snoozed_until, str) and _parse_dt(snoozed_until, field_name="snoozed_until") > now:
        return None

    if reminder["time_mode"] == TIME_MODE_DATE_TIME:
        next_fire_at = reminder["next_fire_at"]
        if not isinstance(next_fire_at, str):
            return None
        fire_at = _parse_dt(next_fire_at, field_name="next_fire_at")
        if fire_at > now:
            return None
        reminder["last_fired_at"] = _serialize_dt(now)
        reminder["last_fired_date"] = _serialize_date(_local_date_from_dt(now))
        if reminder["persistence_mode"] == PERSISTENCE_KEEP_UNTIL_SEEN:
            _mark_missed(reminder=reminder, missed_since=_serialize_dt(fire_at))
        if reminder["schedule_kind"] == SCHEDULE_RECURRING:
            _advance_recurring_reminder(reminder=reminder, now=now)
        else:
            if reminder["persistence_mode"] == PERSISTENCE_DROP_IF_MISSED:
                reminder["status"] = REMINDER_STATUS_DONE
            reminder["next_fire_at"] = None
        return _emit_event(reminder=reminder, event_kind="due")

    if activity_kind != "non_idle_use":
        return None
    _restore_unseen_past_date_only_anchor(reminder=reminder, local_date=local_date)
    _repair_invalid_recurring_date_only_next(reminder=reminder, local_date=local_date)
    next_fire_date = reminder["next_fire_date"]
    if not isinstance(next_fire_date, str):
        return None
    fire_date = _parse_date(next_fire_date, field_name="next_fire_date")
    if fire_date > local_date:
        return None
    if fire_date < local_date:
        if reminder["persistence_mode"] == PERSISTENCE_DROP_IF_MISSED:
            if reminder["schedule_kind"] == SCHEDULE_RECURRING:
                while isinstance(reminder["next_fire_date"], str) and _parse_date(reminder["next_fire_date"], field_name="next_fire_date") < local_date:
                    _advance_recurring_reminder(reminder=reminder, now=now)
                if reminder["next_fire_date"] == _serialize_date(local_date):
                    return _evaluate_single_reminder(
                        reminder=reminder,
                        now=now,
                        local_date=local_date,
                        activity_kind=activity_kind,
                    )
            else:
                reminder["status"] = REMINDER_STATUS_DONE
                reminder["next_fire_date"] = None
            return None
        _mark_missed(reminder=reminder, missed_since=_serialize_date(fire_date))
        if reminder["schedule_kind"] == SCHEDULE_RECURRING:
            _advance_recurring_reminder(reminder=reminder, now=now)
        return _emit_event(reminder=reminder, event_kind="missed")

    reminder["last_fired_at"] = _serialize_dt(now)
    reminder["last_fired_date"] = _serialize_date(local_date)
    if reminder["persistence_mode"] == PERSISTENCE_KEEP_UNTIL_SEEN:
        _mark_missed(reminder=reminder, missed_since=_serialize_date(local_date))
    if reminder["schedule_kind"] == SCHEDULE_RECURRING:
        _advance_recurring_reminder(reminder=reminder, now=now)
    else:
        if reminder["persistence_mode"] == PERSISTENCE_DROP_IF_MISSED:
            reminder["status"] = REMINDER_STATUS_DONE
        reminder["next_fire_date"] = None
    return _emit_event(reminder=reminder, event_kind="due")


reminder_store = ReminderStore()
