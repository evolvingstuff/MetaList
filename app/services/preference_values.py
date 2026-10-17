"""Reading the user's saved preferences (settings)."""

from __future__ import annotations

from typing import Mapping


def preference_or_default(preferences: Mapping[str, str], key: str, *, default: str) -> str:
    """The user's choice for this setting; one they never changed is not saved
    and takes the feature's default."""
    if key not in preferences:
        return default
    return preferences[key]
