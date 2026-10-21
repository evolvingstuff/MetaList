import os
import subprocess
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _import_app(*, flags: list[str], environ: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *flags, "-c", "import app"],
        cwd=_REPO_ROOT, env=environ, capture_output=True, encoding="utf-8", check=False,
    )


def test_importing_app_fails_under_python_dash_o():
    result = _import_app(flags=["-O"], environ=dict(os.environ))
    assert result.returncode != 0
    assert "must not run with python -O" in result.stderr


def test_importing_app_fails_under_pythonoptimize():
    result = _import_app(flags=[], environ={**os.environ, "PYTHONOPTIMIZE": "1"})
    assert result.returncode != 0
    assert "PYTHONOPTIMIZE" in result.stderr


def test_importing_app_works_normally():
    environ = {key: value for key, value in os.environ.items() if key != "PYTHONOPTIMIZE"}
    result = _import_app(flags=[], environ=environ)
    assert result.returncode == 0, result.stderr
