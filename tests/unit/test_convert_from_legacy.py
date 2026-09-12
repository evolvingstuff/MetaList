from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from types import ModuleType
from types import SimpleNamespace

from app.db.migrations import CURRENT_DATABASE_VERSION


_PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _load_converter_module() -> ModuleType:
    module_path = _PROJECT_ROOT / "convert-from-legacy.py"
    spec = importlib.util.spec_from_file_location("metalist_test_convert_from_legacy", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load converter module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_configure_namespace_launch_profile_does_not_save_before_database_recreation(
    monkeypatch,
) -> None:
    converter = _load_converter_module()
    monkeypatch.setenv("METALIST_NAMESPACE", "test-placeholder")
    expected_profile = converter.NamespaceLaunchProfile(
        namespace="default",
        port=8000,
        https_port=8443,
        mcp_port=8765,
    )

    monkeypatch.setattr(
        converter,
        "parse_bootstrap_args",
        lambda argv: converter.BootstrapArgs(
            namespace="default",
            port=8000,
            https_port=8443,
        ),
    )
    monkeypatch.setattr(
        converter,
        "resolve_namespace_launch_defaults",
        lambda **kwargs: expected_profile,
    )
    monkeypatch.setattr(
        converter,
        "save_namespace_launch_profile",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("launch profile must be saved only after database recreation")
        ),
    )

    assert converter._configure_namespace_launch_profile([]) == expected_profile


def test_mark_database_current_writes_current_user_version(tmp_path: Path) -> None:
    converter = _load_converter_module()
    database_path = tmp_path / "default.metalist.db"

    class _Session:
        def __init__(self) -> None:
            self._connection = sqlite3.connect(database_path)

        def connection(self) -> sqlite3.Connection:
            return self._connection

        def commit(self) -> None:
            self._connection.commit()

        def close(self) -> None:
            self._connection.close()

    converter.SafeSession = _Session
    converter.CURRENT_DATABASE_VERSION = 7

    converter._mark_database_current()

    with sqlite3.connect(database_path) as connection:
        row = connection.execute("PRAGMA user_version").fetchone()
    assert row == (7,)


def test_delete_existing_namespace_databases_removes_notes_and_files_artifacts(
    tmp_path: Path,
) -> None:
    converter = _load_converter_module()
    note_database_path = tmp_path / "default.metalist.db"
    file_database_path = tmp_path / "default.metalist.files.db"
    converter.resolve_file_database_path = lambda path: file_database_path
    database_artifacts = (
        note_database_path,
        Path(f"{note_database_path}-wal"),
        Path(f"{note_database_path}-shm"),
        file_database_path,
        Path(f"{file_database_path}-wal"),
        Path(f"{file_database_path}-shm"),
    )
    for artifact_path in database_artifacts:
        artifact_path.write_bytes(b"stale")

    converter._delete_existing_namespace_databases(note_database_path)

    assert all(not artifact_path.exists() for artifact_path in database_artifacts)


def test_successful_conversion_saves_profile_then_marks_database_current(monkeypatch) -> None:
    converter = _load_converter_module()
    profile = converter.NamespaceLaunchProfile(
        namespace="default",
        port=8000,
        https_port=8443,
        mcp_port=8765,
    )
    calls: list[str] = []

    monkeypatch.setattr(converter, "_configure_namespace_launch_profile", lambda argv: profile)
    monkeypatch.setattr(converter, "_load_runtime_dependencies", lambda: None)
    converter.KDF_TIME_COST = 3
    converter.KDF_MIN_TIME_COST = 1
    converter.KDF_MAX_TIME_COST = 10
    monkeypatch.setattr(
        converter,
        "parse_args",
        lambda *args, **kwargs: SimpleNamespace(input_path="legacy.json", kdf_iterations=3),
    )
    monkeypatch.setattr(converter, "_resolve_input_path", lambda input_path: Path(input_path))
    monkeypatch.setattr(
        converter,
        "_load_json",
        lambda path: {"encryption": {"encrypted": False}, "data": []},
    )
    monkeypatch.setattr(converter, "_prompt_for_password", lambda: None)
    monkeypatch.setattr(converter, "_prepare_database", lambda: calls.append("prepare") or Path("db"))

    class _Session:
        def connection(self):
            return object()

        def commit(self) -> None:
            calls.append("import-commit")

        def close(self) -> None:
            calls.append("import-close")

    converter.SafeSession = _Session
    monkeypatch.setattr(converter, "_apply_order", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        converter,
        "save_namespace_launch_profile",
        lambda **kwargs: calls.append("save-profile") or profile,
    )
    monkeypatch.setattr(converter, "_mark_database_current", lambda: calls.append("mark-current"))

    assert converter.main([]) == 0
    assert calls[-2:] == ["save-profile", "mark-current"]


def test_converter_creates_current_encrypted_database_with_launch_profile(tmp_path: Path) -> None:
    legacy_path = tmp_path / "legacy.json"
    legacy_path.write_text(
        json.dumps(
            {
                "encryption": {"encrypted": False},
                "data": [
                    {
                        "id": 1,
                        "creation": 1_700_000_000_000,
                        "last_edit": 1_700_000_001_000,
                        "subitems": [
                            {
                                "indent": 0,
                                "data": "legacy note",
                                "tags": "@imported",
                                "collapse": False,
                            }
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    fresh_home = tmp_path / "home"
    fresh_home.mkdir()
    namespace_directory = fresh_home / "MetaList" / "namespaces" / "default"
    namespace_directory.mkdir(parents=True)
    file_database_path = namespace_directory / "default.metalist.files.db"
    with sqlite3.connect(file_database_path) as connection:
        connection.execute("CREATE TABLE stale_sound_payload (ciphertext BLOB NOT NULL)")
        connection.execute("INSERT INTO stale_sound_payload (ciphertext) VALUES (?)", (b"old-key",))
        connection.commit()
    environ = os.environ.copy()
    environ["HOME"] = str(fresh_home)
    environ["METALIST_DATA_DIRECTORY"] = str(fresh_home / "MetaList")
    for name in (
        "METALIST_NAMESPACE",
        "METALIST_PORT",
        "METALIST_HTTPS_PORT",
    ):
        if name in environ:
            del environ[name]

    completed = subprocess.run(
        [
            sys.executable,
            str(_PROJECT_ROOT / "convert-from-legacy.py"),
            "--namespace",
            "default",
            "--port",
            "8000",
            "--https-port",
            "8443",
            "--kdf-iterations",
            "1",
            "--input",
            str(legacy_path),
        ],
        cwd=_PROJECT_ROOT,
        env=environ,
        input="y\ncorrect-horse\ncorrect-horse\n",
        capture_output=True,
        check=False,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    database_path = namespace_directory / "default.metalist.db"
    with sqlite3.connect(database_path) as connection:
        version_row = connection.execute("PRAGMA user_version").fetchone()
        profile_row = connection.execute(
            "SELECT namespace, port, https_port, mcp_port FROM namespace_launch_profile"
        ).fetchone()
        settings_row = connection.execute(
            "SELECT encryption_enabled, vault_version FROM app_settings WHERE id = 1"
        ).fetchone()
    with sqlite3.connect(file_database_path) as connection:
        stale_table_row = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stale_sound_payload'"
        ).fetchone()
        file_count_row = connection.execute("SELECT COUNT(*) FROM files").fetchone()
        sound_count_row = connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sounds'").fetchone()
    assert version_row == (CURRENT_DATABASE_VERSION,)
    assert profile_row == ("default", 8000, 8443, None)
    assert settings_row[0] == 1
    assert isinstance(settings_row[1], int)
    assert stale_table_row is None
    assert file_count_row == (0,)
    assert sound_count_row == (0,)


def test_import_item_skips_invalid_legacy_ontology_rules(monkeypatch, capsys) -> None:
    converter = _load_converter_module()
    inserted_rules: list[str] = []
    converter.insert_rule = lambda connection, **kwargs: inserted_rules.append(kwargs["rule_text"])

    class _Session:
        def connection(self):
            return object()

    note_count, rule_count = converter._import_item(
        _Session(),
        {
            "id": 7,
            "creation": 1_700_000_000_000,
            "last_edit": 1_700_000_001_000,
            "subitems": [
                {
                    "indent": 0,
                    "data": "&lt; = direction<br>alpha => beta",
                    "tags": "@implies",
                }
            ],
        },
        {},
        {},
    )

    assert note_count == 0
    assert rule_count == 1
    assert inserted_rules == ["alpha => beta"]
    captured = capsys.readouterr()
    assert "Skipping invalid legacy ontology rule" in captured.err
    assert "< => direction" in captured.err
    assert "direction => <" in captured.err
