"""Load packaged agent skill resources."""

from __future__ import annotations

from importlib.resources import files


def load_skill(name: str) -> str:
    assert isinstance(name, str) and name != ""
    skill = files(__package__).joinpath(name).read_text(encoding="utf-8")
    assert skill.strip() != "", f"Agent skill resource is empty: {name}"
    return skill.rstrip("\n")


SCOPED_INVESTIGATION_SKILL = load_skill("scoped-investigation.md")
