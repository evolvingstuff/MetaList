"""Fields another party may leave out: HTTP headers, cookies, query parameters,
meta attributes. Absent is a normal answer for these, never a defect."""

from __future__ import annotations

from typing import Mapping


def sent_or_none(fields: Mapping[str, str], name: str) -> str | None:
    """The value sent under this name, or None when none was sent."""
    if name not in fields:
        return None
    return fields[name]
