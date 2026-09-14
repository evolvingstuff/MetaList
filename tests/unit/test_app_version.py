from __future__ import annotations

from pathlib import Path
import tomllib

from app.config import VERSION
from app.version import __version__


def test_application_version_has_one_runtime_source() -> None:
    assert VERSION == __version__ == "0.6.2"


def test_packaging_reads_dynamic_application_version() -> None:
    project_root = Path(__file__).resolve().parents[2]
    pyproject = tomllib.loads((project_root / "pyproject.toml").read_text(encoding="utf-8"))

    assert pyproject["project"]["dynamic"] == ["version"]
    assert pyproject["tool"]["setuptools"]["dynamic"]["version"] == {
        "attr": "app.version.__version__",
    }
