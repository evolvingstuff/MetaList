"""Tag properties (docs/design/tag-properties.md): jogging:miles=3:duration=30.

The tag is everything before the first colon; what follows are its properties. For
search, inheritance, ontology rules and tag counts a token with properties is its tag:
jogging:miles=3 is jogging. Meta tags (@size=2) and tags inside scopes have none.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
import re
from typing import Dict, FrozenSet, List, Mapping, Tuple

from app.services.input_errors import InputRejected

PROPERTY_SEPARATOR = ":"
META_TAG_PREFIX = "@"


def has_property_syntax(token: str) -> bool:
    if not isinstance(token, str):
        raise TypeError(f"token must be a string, got {type(token)}")
    return token.find(PROPERTY_SEPARATOR) > 0 and not token.startswith(META_TAG_PREFIX)


def tag_part_of_token(token: str) -> str:
    """The tag a token names: jogging for jogging:miles=3, the token itself otherwise."""
    if not has_property_syntax(token):
        return token
    return token[: token.index(PROPERTY_SEPARATOR)]


# --- Values and search conditions -------------------------------------------------

PROPERTY_ASSIGNMENT = "="
# Search's OR operator is never a tag, so never a property term's tag either.
RESERVED_OR = "OR"
# The property a valued tag carries without naming it: jogging=3 is jogging:value=3.
IMPLICIT_PROPERTY = "value"
MISSING_OPERATOR = "?"
# A bare property name in a search: the note has the property, with any value.
PRESENT_OPERATOR = ""
COMPARISON_OPERATORS = (">=", "<=", ">", "<", "=")
# Comparisons a search can write without naming a property: date>=2024-01. (date=2024-01
# stays the valued tag it has always been.)
IMPLICIT_COMPARISON_OPERATORS = (">=", "<=", ">", "<")

# jogging:miles=MAX and =MIN: the notes with the largest or smallest value, among those
# the rest of the search finds. Exact capitals, as OR is.
MAX_KEYWORD = "MAX"
MIN_KEYWORD = "MIN"
EXTREME_KEYWORDS = (MAX_KEYWORD, MIN_KEYWORD)

VALUE_NUMBER = "number"
VALUE_TEMPORAL = "temporal"
VALUE_TIME = "time"
VALUE_TEXT = "text"
# Which kind MAX and MIN compare when a property's values are of several, on a tie.
VALUE_KIND_ORDER = (VALUE_NUMBER, VALUE_TEMPORAL, VALUE_TIME, VALUE_TEXT)

_NUMBER_RE = re.compile(r"^(-?(?:\d+(?:\.\d+)?|\.\d+))([A-Za-z%][A-Za-z%/]*)?$")
_DATE_RE = re.compile(r"^(\d{4})-(\d{2})(?:-(\d{2}))?$")
_DATE_TIME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$")
_TIME_RE = re.compile(
    r"^(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(am|pm|a\.m\.|p\.m\.)?$", re.IGNORECASE,
)
_PROPERTY_NAME_RE = re.compile(r"^[A-Za-z][^:=<>?]*$")
_HOURS_ON_A_CLOCK = 12
_HOURS_IN_DAY = 24
_MINUTES_IN_HOUR = 60
_SECONDS_IN_MINUTE = 60
_FIRST_DAY = 1
_AFTERNOON = "p"


@dataclass(frozen=True, slots=True)
class PropertyValue:
    """A property's value as compared: its kind, what orders it, and a number's unit."""

    kind: str
    # A number's value, a date's or date-time's moment, a time's seconds after midnight,
    # or casefolded text.
    sort_key: object
    # A number's unit as written after it, casefolded ("mg" for 10mg); "" for none.
    unit: str


def _number_value(text: str) -> PropertyValue | None:
    match = _NUMBER_RE.match(text)
    if match is None:
        return None
    unit = match.group(2)
    if unit is None:
        unit = ""
    if unit.casefold() in {"am", "pm"}:
        return None
    return PropertyValue(kind=VALUE_NUMBER, sort_key=Decimal(match.group(1)), unit=unit.casefold())


def _temporal_value(text: str) -> PropertyValue | None:
    date_time = _DATE_TIME_RE.match(text)
    if date_time is not None:
        year, month, day, hour, minute, second = (int(part) if part else 0 for part in date_time.groups())
        moment = _valid_moment(year, month, day, hour=hour, minute=minute, second=second)
    else:
        date_only = _DATE_RE.match(text)
        if date_only is None:
            return None
        # A month without a day is its first day: 2024-01 is 2024-01-01.
        day = _FIRST_DAY
        if date_only.group(3) is not None:
            day = int(date_only.group(3))
        moment = _valid_moment(int(date_only.group(1)), int(date_only.group(2)), day, hour=0, minute=0, second=0)
    if moment is None:
        return None
    return PropertyValue(kind=VALUE_TEMPORAL, sort_key=moment, unit="")


def _valid_moment(year: int, month: int, day: int, *, hour: int, minute: int, second: int) -> datetime | None:
    if not 1 <= month <= len(calendar.month_abbr) - 1:
        return None
    if not 1 <= day <= calendar.monthrange(year, month)[1]:
        return None
    if hour >= _HOURS_IN_DAY or minute >= _MINUTES_IN_HOUR or second >= _SECONDS_IN_MINUTE:
        return None
    return datetime(year, month, day, hour, minute, second)


def _time_value(text: str) -> PropertyValue | None:
    match = _TIME_RE.match(text)
    if match is None:
        return None
    hour_text, minute_text, second_text, meridiem = match.groups()
    # A bare number (10) is a number; a time has minutes or am/pm.
    if minute_text is None and meridiem is None:
        return None
    hour = int(hour_text)
    # 10am has no minutes and 10:30 no seconds: none.
    minute = 0
    if minute_text is not None:
        minute = int(minute_text)
    second = 0
    if second_text is not None:
        second = int(second_text)
    if meridiem is not None:
        if not 1 <= hour <= _HOURS_ON_A_CLOCK:
            return None
        # 12am is midnight and 12pm noon.
        hour %= _HOURS_ON_A_CLOCK
        if meridiem.casefold().startswith(_AFTERNOON):
            hour += _HOURS_ON_A_CLOCK
    if hour >= _HOURS_IN_DAY or minute >= _MINUTES_IN_HOUR or second >= _SECONDS_IN_MINUTE:
        return None
    return PropertyValue(
        kind=VALUE_TIME, sort_key=(hour * _MINUTES_IN_HOUR + minute) * _SECONDS_IN_MINUTE + second, unit="",
    )


def parse_property_value(text: str) -> PropertyValue:
    """A value as the first kind it reads as: a time (10:30, 10:30pm, 10am), a date or
    date-time (2024-01, 2024-01-15, 2024-01-15T10:30), a number with an optional unit
    (3, -2.5, 10mg), else text. A year alone (2026) is a number."""
    if not isinstance(text, str) or text == "":
        raise ValueError("A property value must be non-empty text")
    for reader in (_time_value, _temporal_value, _number_value):
        value = reader(text)
        if value is not None:
            return value
    return PropertyValue(kind=VALUE_TEXT, sort_key=text.casefold(), unit="")


def is_property_name(name: str) -> bool:
    """A property's name: a letter first, then no : = < > ?."""
    return _PROPERTY_NAME_RE.match(name) is not None


def split_property_segments(text: str) -> List[str]:
    """The text after a tag, split where a colon is followed by a letter (or ends it)."""
    segments: List[str] = []
    current = ""
    for index, char in enumerate(text):
        is_last = index == len(text) - 1
        if char == PROPERTY_SEPARATOR and (is_last or text[index + 1].isascii() and text[index + 1].isalpha()):
            segments.append(current)
            current = ""
            continue
        current += char
    segments.append(current)
    return segments


def token_properties(token: str) -> Tuple[str, Dict[str, PropertyValue]]:
    """A tag token's tag name (casefolded, without its value) and its properties by
    casefolded name: jogging=3:miles=3 is ("jogging", {"value": 3, "miles": 3}). A
    property the tag bar would not keep (no value, repeated) is left out."""
    tag_part = tag_part_of_token(token)
    name, assignment, implicit_value = tag_part.partition(PROPERTY_ASSIGNMENT)
    properties: Dict[str, PropertyValue] = {}
    if assignment and implicit_value != "":
        properties[IMPLICIT_PROPERTY] = parse_property_value(implicit_value)
    if has_property_syntax(token):
        for segment in split_property_segments(token[len(tag_part) + 1:]):
            property_name, has_value, value = segment.partition(PROPERTY_ASSIGNMENT)
            key = property_name.casefold()
            if not has_value or value == "" or _PROPERTY_NAME_RE.match(property_name) is None or key in properties:
                continue
            properties[key] = parse_property_value(value)
    return name.casefold(), properties


@dataclass(frozen=True, slots=True)
class PropertyCondition:
    """One property search term: jogging:miles>2, jogging:miles?, jogging:miles, date>=2024-01."""

    tag: str
    name: str
    operator: str
    # The compared value as typed; "" for ? and a bare name.
    value_text: str

    @property
    def key(self) -> Tuple[str, str]:
        return self.tag.casefold(), self.name.casefold()

    @property
    def is_extreme(self) -> bool:
        """jogging:miles=MAX or =MIN: decided across the notes found, not one note alone."""
        return self.operator == "=" and self.value_text in EXTREME_KEYWORDS

    def format(self) -> str:
        if self.name == IMPLICIT_PROPERTY and self.operator in IMPLICIT_COMPARISON_OPERATORS:
            return f"{self.tag}{self.operator}{self.value_text}"
        return f"{self.tag}{PROPERTY_SEPARATOR}{self.name}{self.operator}{self.value_text}"


def is_property_term(token: str) -> bool:
    """Whether a search term is about a property rather than a tag."""
    if token.startswith(META_TAG_PREFIX):
        return False
    if has_property_syntax(token):
        return True
    return any(operator in token for operator in ("<", ">"))


def property_term_tag(token: str) -> str:
    """The tag a property term is about, read without checking the rest of it."""
    return re.split(r"[:<>]", token, maxsplit=1)[0]


def parse_property_term(token: str) -> PropertyCondition:
    """A property search term, or InputRejected saying how to write one."""
    if has_property_syntax(token):
        tag, rest = token.split(PROPERTY_SEPARATOR, 1)
        if rest.endswith(MISSING_OPERATOR):
            return _condition(tag, rest[:-1], MISSING_OPERATOR, "")
        for operator in COMPARISON_OPERATORS:
            if operator in rest:
                name, value = rest.split(operator, 1)
                return _condition(tag, name, operator, value)
        return _condition(tag, rest, PRESENT_OPERATOR, "")
    for operator in IMPLICIT_COMPARISON_OPERATORS:
        if operator in token:
            tag, value = token.split(operator, 1)
            return _condition(tag, IMPLICIT_PROPERTY, operator, value)
    raise InputRejected(f"{token} is not a property search (for example jogging:miles>2)")


def _condition(tag: str, name: str, operator: str, value_text: str) -> PropertyCondition:
    if tag == RESERVED_OR:
        raise InputRejected("OR is reserved and cannot be used as a tag")
    if tag == "" or PROPERTY_ASSIGNMENT in tag or PROPERTY_SEPARATOR in tag or tag.startswith(META_TAG_PREFIX):
        raise InputRejected(f"Name the tag before the property (for example jogging:miles>2), not {tag!r}")
    if _PROPERTY_NAME_RE.match(name) is None:
        raise InputRejected("A property name starts with a letter (for example jogging:miles>2)")
    has_value = operator not in (MISSING_OPERATOR, PRESENT_OPERATOR)
    if value_text in EXTREME_KEYWORDS and operator != "=":
        raise InputRejected(f"{value_text} goes after = (for example jogging:miles={value_text})")
    if has_value and value_text == "":
        raise InputRejected(f"Write a value after {operator} (for example jogging:miles{operator}2)")
    if any(mark in value_text for mark in ("<", ">", "?")) or value_text.startswith("="):
        raise InputRejected("One property per search term (for example jogging:miles>2 jogging:duration<40)")
    if PROPERTY_ASSIGNMENT in value_text:
        raise InputRejected("One property per search term (for example jogging:miles>2 jogging:duration<40)")
    return PropertyCondition(tag=tag, name=name, operator=operator, value_text=value_text)


def value_satisfies(value: PropertyValue, condition: PropertyCondition) -> bool:
    """Whether a note's value meets a comparison. Values of another kind are skipped
    (miles=far never answers miles>2); a query's unit, when it has one, must match."""
    if condition.operator in (MISSING_OPERATOR, PRESENT_OPERATOR) or condition.is_extreme:
        raise ValueError("Only comparisons compare values")
    wanted = parse_property_value(condition.value_text)
    if value.kind != wanted.kind:
        return False
    if wanted.unit != "" and value.unit != wanted.unit:
        return False
    actual_key = value.sort_key
    wanted_key = wanted.sort_key
    if condition.operator == "=":
        return actual_key == wanted_key
    if condition.operator == ">":
        return actual_key > wanted_key
    if condition.operator == "<":
        return actual_key < wanted_key
    if condition.operator == ">=":
        return actual_key >= wanted_key
    assert condition.operator == "<=", condition.operator
    return actual_key <= wanted_key


# --- Suggestions --------------------------------------------------------------------

# "1 note", "2 notes", by whether the count is one.
_NOTE_NOUNS = {True: "note", False: "notes"}
PROPERTY_SUGGESTIONS_IN_TAG_BAR = "tag-bar"
PROPERTY_SUGGESTIONS_IN_SEARCH = "search"
# A rule's condition in Edit Tag Relationships: read as a search reads, without MAX/MIN.
PROPERTY_SUGGESTIONS_IN_RULE = "rule"
PROPERTY_SUGGESTION_PLACES = frozenset({
    PROPERTY_SUGGESTIONS_IN_TAG_BAR, PROPERTY_SUGGESTIONS_IN_SEARCH, PROPERTY_SUGGESTIONS_IN_RULE,
})
# A number and the start of its unit: 10, 10m, -2.5k.
_NUMBER_AND_PARTIAL_UNIT_RE = re.compile(r"^(-?(?:\d+(?:\.\d+)?|\.\d+))([A-Za-z%][A-Za-z%/]*)?$")


@dataclass(frozen=True, slots=True)
class PropertySuggestion:
    # What replaces the typed text (jogging:miles=), what the list shows (miles=), and
    # why it is suggested (shown when it is right-clicked).
    replacement: str
    label: str
    reasons: Tuple[str, ...]
    # How many notes use it (none for MAX and MIN).
    note_count: int


@dataclass(frozen=True, slots=True)
class PropertyCompletion:
    """What is being typed in a property: a name after a tag's colon (property_name
    None), or the unit after a value's number."""

    tag: str
    property_name: str | None
    # The typed start of the name or unit, and everything typed before it.
    partial: str
    before: str
    # A value's number, for the unit's label (5 for 5mg).
    number: str
    # Names the token already has (the tag bar never offers one twice).
    excluded_names: FrozenSet[str]
    # In the tag bar a chosen name gets its =, ready for the value.
    name_suffix: str
    # A search's = with no value yet (or MA, MI): MAX and MIN are offered.
    offers_extremes: bool

    def suggestion(self, completed: str, notes_by_tag: Dict[str, int]) -> PropertySuggestion:
        reasons = tuple(
            f"On {count} {_NOTE_NOUNS[count == 1]} tagged {tag}"
            for tag, count in sorted(notes_by_tag.items(), key=lambda item: (-item[1], item[0]))
        )
        # A name gets its suffix (= in the tag bar); a unit shows with its number.
        note_count = sum(notes_by_tag.values())
        if self.property_name is None:
            label = f"{completed}{self.name_suffix}"
            return PropertySuggestion(
                replacement=f"{self.before}{label}", label=label, reasons=reasons, note_count=note_count,
            )
        return PropertySuggestion(
            replacement=f"{self.before}{completed}", label=f"{self.number}{completed}", reasons=reasons,
            note_count=note_count,
        )


def read_property_completion(typed: str, *, in_tag_bar: bool, offers_extremes: bool) -> PropertyCompletion | None:
    """The property name or unit being typed at the end of a tag-bar token
    (jogging:miles=3:du, drug:dosage=10m) or a search term (exercise:mi, drug:dosage>5m,
    date>5), or None when neither is."""
    if typed.startswith(META_TAG_PREFIX):
        return None
    # In the tag bar a chosen name gets its =, ready for the value.
    name_suffix = ""
    if in_tag_bar:
        name_suffix = PROPERTY_ASSIGNMENT
    if has_property_syntax(typed):
        tag, rest = typed.split(PROPERTY_SEPARATOR, 1)
        if PROPERTY_ASSIGNMENT in tag:
            tag = tag.split(PROPERTY_ASSIGNMENT, 1)[0]
        if in_tag_bar:
            segments = split_property_segments(rest)
            current = segments[-1]
            excluded = frozenset(segment.partition(PROPERTY_ASSIGNMENT)[0].casefold() for segment in segments[:-1])
            name, operator, value = current.partition(PROPERTY_ASSIGNMENT)
        else:
            excluded = frozenset()
            name, operator, value = _split_at_operator(rest)
        if operator == "":
            if name != "" and _PROPERTY_NAME_RE.match(name) is None:
                return None
            return PropertyCompletion(
                tag=tag, property_name=None, partial=name, before=typed[: len(typed) - len(name)], number="",
                excluded_names=excluded, name_suffix=name_suffix, offers_extremes=False,
            )
        if offers_extremes and operator == "=" and any(keyword.startswith(value) for keyword in EXTREME_KEYWORDS):
            return PropertyCompletion(
                tag=tag, property_name=name, partial=value, before=typed[: len(typed) - len(value)], number="",
                excluded_names=frozenset(), name_suffix="", offers_extremes=True,
            )
        return _unit_completion(typed, tag=tag, property_name=name, value=value)
    if in_tag_bar:
        return None
    name, operator, value = _split_at_operator(typed)
    if operator not in IMPLICIT_COMPARISON_OPERATORS:
        return None
    return _unit_completion(typed, tag=name, property_name=IMPLICIT_PROPERTY, value=value)


def _split_at_operator(text: str) -> Tuple[str, str, str]:
    for operator in COMPARISON_OPERATORS:
        if operator in text:
            name, value = text.split(operator, 1)
            return name, operator, value
    return text, "", ""


def _unit_completion(typed: str, *, tag: str, property_name: str, value: str) -> PropertyCompletion | None:
    match = _NUMBER_AND_PARTIAL_UNIT_RE.match(value)
    if tag == "" or match is None or _PROPERTY_NAME_RE.match(property_name) is None:
        return None
    partial = match.group(2)
    if partial is None:
        partial = ""
    return PropertyCompletion(
        tag=tag, property_name=property_name, partial=partial, before=typed[: len(typed) - len(partial)],
        number=match.group(1), excluded_names=frozenset(), name_suffix="", offers_extremes=False,
    )


def condition_holds(
    condition: PropertyCondition, *, values: Mapping[Tuple[str, str], PropertyValue],
    own_tag_names: FrozenSet[str], tag_names: FrozenSet[str],
) -> bool:
    """Whether one note's values meet a super tag term, as search and rules read it.
    values: the note's own values by casefolded (tag, property); own_tag_names: the
    casefolded names of the tags written on the note; tag_names: the term's tag and every
    tag implying it. The term has its property (jogging:miles), lacks it on a tag of its
    own (jogging:miles?), or has a value that compares (jogging:miles>2); any one value
    is enough. MAX and MIN need the property; which notes hold the extreme is decided
    across the notes found."""
    keys = [(tag_name, condition.key[1]) for tag_name in tag_names if (tag_name, condition.key[1]) in values]
    if condition.operator == MISSING_OPERATOR:
        return bool(own_tag_names & tag_names) and not keys
    if condition.operator == PRESENT_OPERATOR or condition.is_extreme:
        return len(keys) > 0
    return any(value_satisfies(values[key], condition) for key in keys)

