from __future__ import annotations

import importlib.resources
import importlib.util
from pathlib import Path

import app.services.agent.skills as skill_resources


def test_skill_module_import_requires_only_active_skill_resource(monkeypatch, tmp_path: Path) -> None:
    active_skill = "Scoped investigation instructions"
    (tmp_path / "scoped-investigation.md").write_text(active_skill, encoding="utf-8")
    monkeypatch.setattr(importlib.resources, "files", lambda package: tmp_path)
    specification = importlib.util.spec_from_file_location(
        "isolated_agent_skills",
        skill_resources.__file__,
        submodule_search_locations=[],
    )
    assert specification is not None and specification.loader is not None
    isolated_resources = importlib.util.module_from_spec(specification)

    specification.loader.exec_module(isolated_resources)

    assert isolated_resources.SCOPED_INVESTIGATION_SKILL == active_skill
    assert not hasattr(isolated_resources, "SEARCH_NOTES_SKILL")
