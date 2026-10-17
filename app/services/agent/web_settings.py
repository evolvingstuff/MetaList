"""Validated namespace preference controlling agent access to the public web."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from app.services.preference_values import preference_or_default


WEB_ACCESS_MODE_PREFERENCE_KEY = "pref.ai.web_access_mode"
WebAccessMode = Literal["none", "contextual", "full"]
WEB_ACCESS_MODES: frozenset[str] = frozenset({"none", "contextual", "full"})


@dataclass(frozen=True, slots=True)
class AgentWebSettings:
    mode: WebAccessMode

    def __post_init__(self) -> None:
        validate_web_access_mode(self.mode)

    @property
    def can_open_pages(self) -> bool:
        return self.mode in {"contextual", "full"}

def validate_web_access_mode(value: str) -> WebAccessMode:
    if not isinstance(value, str):
        raise TypeError("Agent web access mode must be text")
    if value not in WEB_ACCESS_MODES:
        raise ValueError(f"Unsupported agent web access mode: {value}")
    return value


def resolve_agent_web_settings(*, preferences: dict[str, str]) -> AgentWebSettings:
    if not isinstance(preferences, dict):
        raise TypeError("preferences must be a dict")
    raw_mode = preference_or_default(preferences, WEB_ACCESS_MODE_PREFERENCE_KEY, default="none")
    return AgentWebSettings(mode=validate_web_access_mode(raw_mode))


DEFAULT_AGENT_WEB_SETTINGS = AgentWebSettings(mode="none")
