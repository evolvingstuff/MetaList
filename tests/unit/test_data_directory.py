from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from app.data_directory import resolve_data_directory


def test_data_directory_defaults_to_current_users_metalist_directory() -> None:
    assert resolve_data_directory(environ={}) == Path.home() / "MetaList"


@pytest.mark.parametrize("configured_directory", ["", " ", "relative", "./data", "~/MetaList"])
def test_data_directory_rejects_empty_and_relative_paths(configured_directory: str) -> None:
    with pytest.raises(ValueError, match="absolute path"):
        resolve_data_directory(environ={"METALIST_DATA_DIRECTORY": configured_directory})


def test_data_directory_accepts_absolute_unicode_path_without_creating_it(tmp_path: Path) -> None:
    directory = tmp_path / "MetaList données"

    assert resolve_data_directory(environ={"METALIST_DATA_DIRECTORY": str(directory)}) == directory

    assert not directory.exists()


def test_runtime_paths_follow_data_directory_without_initializing_storage(tmp_path: Path) -> None:
    directory = tmp_path / "isolated MetaList"
    environment = dict(os.environ)
    environment["METALIST_DATA_DIRECTORY"] = str(directory)
    completed = subprocess.run(
        [sys.executable, "-c", (
            "import json, sys; import app.server_runtime as runtime; "
            "assert 'app.config' not in sys.modules; "
            "print(json.dumps([str(path) for path in ("
            "runtime.resolve_namespaces_directory(), runtime.resolve_runtime_logs_directory(), "
            "runtime.resolve_managed_runtime_directory(), runtime.resolve_namespace_delete_jobs_directory(), "
            "runtime.resolve_namespace_rename_jobs_directory(), runtime._DEFAULT_CERT_PATH, runtime._DEFAULT_KEY_PATH)]))"
        )],
        cwd=Path(__file__).resolve().parents[2], env=environment,
        capture_output=True, text=True, check=True,
    )

    assert json.loads(completed.stdout) == [
        str(directory / "namespaces"), str(directory / "logs"), str(directory / "runtime"),
        str(directory / "runtime" / "namespace-delete-jobs"),
        str(directory / "runtime" / "namespace-rename-jobs"),
        str(directory / "certs" / "metalist-cert.pem"),
        str(directory / "certs" / "metalist-key.pem"),
    ]
    assert not directory.exists()
