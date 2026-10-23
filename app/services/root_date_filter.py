"""Date range filter: a tab shows only the root notes created, or last updated, in a
range of local dates (docs/ui/command-palette.md, Date range).

The dates are the ones the Created and Updated sort orders use: a root's own
creation time, or the latest update anywhere in its subtree. Relative ranges
(Today, Last 7 days, ...) are counted from the day the view is built, so they move
with the calendar; a custom range has fixed dates, either end open.
"""

from __future__ import annotations

from calendar import monthrange
from dataclasses import dataclass
import re
from datetime import date, datetime, timedelta
from typing import Dict, List

from app.services.input_errors import InputRejected
from app.services.root_sorting import get_root_sort_timestamps

DATE_FILTER_FIELDS = frozenset({"created", "updated"})
DATE_RANGE_TODAY = "today"
DATE_RANGE_LAST_7_DAYS = "last-7-days"
DATE_RANGE_LAST_30_DAYS = "last-30-days"
DATE_RANGE_THIS_YEAR = "this-year"
DATE_RANGE_CUSTOM = "custom"
# What a request sends to show every date again (no filter).
DATE_RANGE_NONE = "none"
DATE_RANGE_KINDS = frozenset({
    DATE_RANGE_TODAY, DATE_RANGE_LAST_7_DAYS, DATE_RANGE_LAST_30_DAYS, DATE_RANGE_THIS_YEAR, DATE_RANGE_CUSTOM,
})
# How many days a relative range spans, today included.
_WEEK_DAYS = 7
_MONTH_DAYS = 30
_DAYS_SPANNED = {DATE_RANGE_TODAY: 1, DATE_RANGE_LAST_7_DAYS: _WEEK_DAYS, DATE_RANGE_LAST_30_DAYS: _MONTH_DAYS}
_FIRST_MONTH = 1
_FIRST_DAY = 1
_MONTHS_IN_YEAR = 12
# monthrange() returns (weekday of the first day, number of days).
_DAYS_IN_MONTH = 1
_ISO_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
# An open end of a custom range.
OPEN_DATE = ""
_FILTER_KEYS = ("field", "rangeKind", "fromDate", "toDate")


@dataclass(frozen=True)
class RootDateFilter:
    field: str
    range_kind: str
    # ISO dates (YYYY-MM-DD) of a custom range, OPEN_DATE for an open end; both
    # OPEN_DATE for a relative range.
    from_date: str
    to_date: str


def _parse_iso_date(value: str, name: str) -> date:
    if not isinstance(value, str) or _ISO_DATE_RE.fullmatch(value) is None:
        raise InputRejected(f"{name} must be a date (YYYY-MM-DD), not {value!r}")
    year, month, day = (int(part) for part in value.split("-"))
    if not _FIRST_MONTH <= month <= _MONTHS_IN_YEAR or not _FIRST_DAY <= day <= monthrange(year, month)[_DAYS_IN_MONTH]:
        raise InputRejected(f"{name} is not a day of the calendar: {value}")
    return date(year, month, day)


def make_root_date_filter(*, field: str, range_kind: str, from_date: str, to_date: str) -> RootDateFilter:
    """A validated filter; a request or saved tab state that is not one is rejected."""
    if field not in DATE_FILTER_FIELDS:
        raise InputRejected("The date range filters on created or updated")
    if range_kind not in DATE_RANGE_KINDS:
        raise InputRejected(f"Unknown date range: {range_kind!r}")
    if range_kind != DATE_RANGE_CUSTOM:
        if from_date != OPEN_DATE or to_date != OPEN_DATE:
            raise InputRejected("Only a custom date range has dates of its own")
        return RootDateFilter(field=field, range_kind=range_kind, from_date=OPEN_DATE, to_date=OPEN_DATE)
    if from_date == OPEN_DATE and to_date == OPEN_DATE:
        raise InputRejected("A custom date range needs a start or an end date")
    if from_date != OPEN_DATE and to_date != OPEN_DATE:
        if _parse_iso_date(from_date, "From") > _parse_iso_date(to_date, "To"):
            raise InputRejected("The start of a date range must not be after its end")
    elif from_date != OPEN_DATE:
        _parse_iso_date(from_date, "From")
    else:
        _parse_iso_date(to_date, "To")
    return RootDateFilter(field=field, range_kind=range_kind, from_date=from_date, to_date=to_date)


def root_date_filter_from_payload(payload: object) -> RootDateFilter:
    if not isinstance(payload, dict):
        raise InputRejected("A date range filter must be an object")
    for key in _FILTER_KEYS:
        if key not in payload:
            raise InputRejected(f"A date range filter needs {key}")
    return make_root_date_filter(
        field=payload["field"], range_kind=payload["rangeKind"],
        from_date=payload["fromDate"], to_date=payload["toDate"],
    )


def root_date_filter_payload(date_filter: RootDateFilter) -> Dict[str, str]:
    return {
        "field": date_filter.field,
        "rangeKind": date_filter.range_kind,
        "fromDate": date_filter.from_date,
        "toDate": date_filter.to_date,
    }


def local_today() -> date:
    return datetime.now().astimezone().date()


def _custom_end(value: str) -> date | None:
    """A custom range's end; None for an open end."""
    if value == OPEN_DATE:
        return None
    return date.fromisoformat(value)


def date_filter_bounds(date_filter: RootDateFilter, *, today: date) -> tuple[date | None, date | None]:
    """The first and last local dates the filter keeps; None for an open end."""
    if date_filter.range_kind == DATE_RANGE_CUSTOM:
        return _custom_end(date_filter.from_date), _custom_end(date_filter.to_date)
    if date_filter.range_kind == DATE_RANGE_THIS_YEAR:
        return date(today.year, _FIRST_MONTH, _FIRST_DAY), today
    # The range ends today, so it starts one day fewer than it spans before it.
    return today - timedelta(days=_DAYS_SPANNED[date_filter.range_kind] - 1), today


def filter_root_ids_by_date(root_ids: List[str], date_filter: RootDateFilter, *, today: date) -> List[str]:
    """The roots, in their order, whose date (local) falls in the filter's range."""
    timestamps = get_root_sort_timestamps(date_filter.field)
    first, last = date_filter_bounds(date_filter, today=today)
    kept: List[str] = []
    for root_id in root_ids:
        if root_id not in timestamps:
            raise RuntimeError(f"Missing root {date_filter.field} timestamp for {root_id}")
        root_date = timestamps[root_id].astimezone().date()
        if first is not None and root_date < first:
            continue
        if last is not None and root_date > last:
            continue
        kept.append(root_id)
    return kept
