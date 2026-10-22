"""scripts/full_checks.py tests the Python versions the release matrix does."""

from __future__ import annotations

import ast
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def _supported_pythons(script: str) -> tuple[str, ...]:
    tree = ast.parse((_SCRIPTS / script).read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and [target.id for target in node.targets if isinstance(target, ast.Name)] == ["SUPPORTED_PYTHONS"]:
            return ast.literal_eval(node.value)
    raise AssertionError(f"{script} defines no SUPPORTED_PYTHONS")


def test_the_full_checks_run_the_release_matrix_pythons() -> None:
    assert _supported_pythons("full_checks.py") == _supported_pythons("release.py")
