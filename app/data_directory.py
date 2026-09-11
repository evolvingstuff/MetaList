"""Resolve the persistent data root without importing application runtime state.

METALIST_DATA_DIRECTORY accepts an absolute directory path. When omitted,
MetaList uses the current user's ~/MetaList directory.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path


def resolve_data_directory(*, environ: Mapping[str, str]) -> Path:
    if "METALIST_DATA_DIRECTORY" not in environ:
        return Path.home() / "MetaList"
    configured_directory = environ["METALIST_DATA_DIRECTORY"]
    if not isinstance(configured_directory, str) or configured_directory.strip() == "":
        raise ValueError("METALIST_DATA_DIRECTORY must be a nonempty absolute path")
    directory = Path(configured_directory)
    if not directory.is_absolute():
        raise ValueError("METALIST_DATA_DIRECTORY must be an absolute path")
    return directory
