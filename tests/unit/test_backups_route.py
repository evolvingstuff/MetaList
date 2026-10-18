from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

import app.api.routes.backups as backups_route
from app.db.schema import initialize_schema
from app.db.settings_sql import insert_default_settings
from app.db.settings_sql import update_password_settings
from app.services.backup_service import BackupFileInfo
from app.services.encryption import EncryptionService


def _write_password_protected_target_database(*, database_path: Path, password: str) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    auth_salt = b"auth-salt-123456"
    auth_iterations = backups_route.KDF_MIN_TIME_COST
    memory_cost_kib = backups_route.KDF_MIN_MEMORY_COST_KIB
    parallelism = backups_route.KDF_MIN_PARALLELISM
    auth_verifier = EncryptionService().derive_master_key(
        password,
        auth_salt,
        auth_iterations,
        memory_cost_kib,
        parallelism,
    ).hex()

    connection = sqlite3.connect(database_path)
    try:
        initialize_schema(connection)
        insert_default_settings(connection)
        update_password_settings(
            connection,
            auth_verifier=auth_verifier,
            auth_salt=auth_salt,
            auth_iterations=auth_iterations,
            kek_salt=b"kek-salt-1234567",
            kek_iterations=auth_iterations,
            vault_version=backups_route.VAULT_VERSION,
            kdf_algorithm=backups_route.KDF_ALGORITHM,
            kdf_memory_cost_kib=memory_cost_kib,
            kdf_parallelism=parallelism,
            encrypted_dek=b"encrypted-dek",
            dek_nonce=b"dek-nonce",
            dek_tag=b"dek-tag",
            encryption_algorithm="AES-256-GCM",
        )
        connection.commit()
    finally:
        connection.close()


def test_serialize_settings_response_returns_folder_and_namespace_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(backups_route, "_list_available_namespaces", lambda: ["default", "work"])

    response = backups_route._serialize_settings_response(
        {
            "folder_path": "/tmp/backups",
            "selected_namespaces": ["work"],
            "retention_count": 30,
        }
    )

    payload = response.model_dump()
    assert payload == {
        "folder_path": "/tmp/backups",
        "selected_namespaces": ["work"],
        "available_namespaces": ["default", "work"],
        "retention_count": 30,
    }


def test_serialize_settings_response_removes_deleted_saved_namespaces(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(backups_route, "_list_available_namespaces", lambda: ["cla", "thomas"])

    response = backups_route._serialize_settings_response(
        {
            "folder_path": "/tmp/backups",
            "selected_namespaces": ["default", "cla", "recovered", "thomas"],
            "retention_count": 5,
        }
    )

    assert response.available_namespaces == ["cla", "thomas"]
    assert response.selected_namespaces == ["cla", "thomas"]


def test_list_available_namespaces_requires_an_existing_namespace_database(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    namespaces_directory = tmp_path / "namespaces"
    for namespace in ("default", "recovered", "cla", "thomas"):
        (namespaces_directory / namespace).mkdir(parents=True)
    (namespaces_directory / "cla" / "cla.metalist.db").touch()
    (namespaces_directory / "thomas" / "thomas.metalist.db").touch()
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaces_directory",
        lambda: namespaces_directory,
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: namespaces_directory / namespace / f"{namespace}.metalist.db",
    )

    assert backups_route._list_available_namespaces() == ["cla", "thomas"]


def test_put_backup_settings_normalizes_and_passes_folder_path_and_namespaces(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: dict[str, object] = {}
    expected_folder = tmp_path / "backup-folder"
    default_database = tmp_path / "default.metalist.db"
    work_database = tmp_path / "work.metalist.db"
    default_database.touch()
    work_database.touch()

    def _capture_update_settings(
        *,
        token: str,
        folder_path: str,
        selected_namespaces: list[str],
        retention_count: int,
    ) -> dict[str, object]:
        captured["token"] = token
        captured["folder_path"] = folder_path
        captured["selected_namespaces"] = selected_namespaces
        captured["retention_count"] = retention_count
        return {
            "folder_path": folder_path,
            "selected_namespaces": selected_namespaces,
            "retention_count": retention_count,
        }

    monkeypatch.setattr(backups_route, "update_backup_settings", _capture_update_settings)
    monkeypatch.setattr(backups_route, "_list_available_namespaces", lambda: ["default", "work"])
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: {
            "default": default_database,
            "work": work_database,
        }[namespace],
    )

    payload = backups_route.BackupSettingsUpdateRequest(
        folder_path=f"  {expected_folder}  ",
        selected_namespaces=["work", "default"],
        retention_count=10,
    )

    response = backups_route.put_backup_settings(payload=payload, token="token")

    assert captured["folder_path"] == str(expected_folder)
    assert captured["selected_namespaces"] == ["default", "work"]
    assert expected_folder.is_dir() is True
    assert response.folder_path == str(expected_folder)
    assert response.selected_namespaces == ["default", "work"]


def test_run_backup_writes_each_selected_namespace_to_configured_folder(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "synced" / "MetaList Backups"
    default_database = tmp_path / "default.metalist.db"
    work_database = tmp_path / "work.metalist.db"
    default_database.touch()
    work_database.touch()
    default_backup = BackupFileInfo(
        filename="default-20260419-090000-000000.metalist-backup.tar.gz",
        created_at="2026-04-19T09:00:00+00:00",
        size_bytes=128,
    )
    work_backup = BackupFileInfo(
        filename="work-20260419-090001-000000.metalist-backup.tar.gz",
        created_at="2026-04-19T09:00:01+00:00",
        size_bytes=256,
    )

    captured_settings: dict[str, object] = {}
    monkeypatch.setattr(
        backups_route,
        "update_backup_settings",
        lambda **settings: captured_settings.update(settings) or settings,  # shockharness: ignore[DEF003] reason="the stub records its call, then returns its value (append/update return None)"
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: {
            "default": default_database,
            "work": work_database,
        }[namespace],
    )
    monkeypatch.setattr(
        backups_route,
        "create_timestamped_backup_for_paths",
        lambda database_path, _backup_directory: default_backup if database_path == default_database else work_backup,
    )
    monkeypatch.setattr(
        backups_route,
        "list_backups_in_directory",
        lambda _backup_directory, *, database_path=None: (
            [default_backup] if database_path == default_database else [work_backup]
        ),
    )

    response = backups_route.run_backup(
        payload=backups_route.BackupSettingsUpdateRequest(
            folder_path=str(folder_directory),
            selected_namespaces=["default", "work"],
            retention_count=30,
        ),
        token="token",
    )

    assert folder_directory.is_dir() is True
    assert captured_settings == {
        "folder_path": str(folder_directory),
        "retention_count": 30,
        "selected_namespaces": ["default", "work"],
        "token": "token",
    }
    assert len(response.results) == 2
    assert response.results[0].namespace == "default"
    assert response.results[0].destination == "folder"
    assert response.results[0].success is True
    assert response.results[0].created_filename == default_backup.filename
    assert response.results[0].size_bytes == default_backup.size_bytes
    assert response.results[1].namespace == "work"
    assert response.results[1].created_filename == work_backup.filename
    assert response.results[1].size_bytes == work_backup.size_bytes


def test_run_backup_ignores_deleted_namespaces_in_saved_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    cla_database = tmp_path / "cla.metalist.db"
    cla_database.touch()
    backup = BackupFileInfo(
        filename="cla-20260801-194825-000000.metalist-backup.tar.gz",
        created_at="2026-08-01T19:48:25+00:00",
        size_bytes=128,
    )
    monkeypatch.setattr(backups_route, "update_backup_settings", lambda **settings: settings)
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: cla_database if namespace == "cla" else tmp_path / f"missing-{namespace}.db",
    )
    monkeypatch.setattr(
        backups_route,
        "create_timestamped_backup_for_paths",
        lambda database_path, backup_directory: backup,
    )
    monkeypatch.setattr(
        backups_route,
        "list_backups_in_directory",
        lambda backup_directory, *, database_path=None: [backup],
    )

    response = backups_route.run_backup(
        payload=backups_route.BackupSettingsUpdateRequest(
            folder_path=str(folder_directory),
            selected_namespaces=["default", "cla", "recovered"],
            retention_count=5,
        ),
        token="token",
    )

    assert [result.namespace for result in response.results] == ["cla"]


def test_run_backup_rejects_when_no_namespaces_are_selected(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    with pytest.raises(backups_route.HTTPException) as excinfo:
        backups_route.run_backup(
            payload=backups_route.BackupSettingsUpdateRequest.model_construct(
                folder_path=str(tmp_path / "backups"),
                selected_namespaces=[],
                retention_count=30,
            ),
            token="token",
        )

    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == "Select at least one namespace to back up"


def test_pick_backup_folder_returns_selected_folder(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_path = tmp_path / "MetaList Backups"
    monkeypatch.setattr(
        backups_route,
        "_pick_backup_folder_path",
        lambda: str(folder_path),
    )

    response = backups_route.pick_backup_folder(token="token")

    assert response.selected is True
    assert response.folder_path == str(folder_path)


def test_pick_backup_folder_returns_not_selected_when_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        backups_route,
        "_pick_backup_folder_path",
        lambda: None,
    )

    response = backups_route.pick_backup_folder(token="token")

    assert response.selected is False
    assert response.folder_path == ""


def test_restore_preflight_reports_existing_different_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    folder_directory.mkdir()
    backup_filename = "source-20260419-090000-000000.metalist-backup.tar.gz"
    (folder_directory / backup_filename).write_bytes(b"backup")
    target_database_path = tmp_path / "namespaces" / "target" / "target.metalist.db"
    _write_password_protected_target_database(
        database_path=target_database_path,
        password="target-password",
    )

    monkeypatch.setattr(
        backups_route,
        "load_backup_settings",
        lambda *, token: {
            "folder_path": str(folder_directory),
            "selected_namespaces": ["source"],
            "retention_count": 30,
        },
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespace_directory",
        lambda *, namespace: tmp_path / "namespaces" / namespace,
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: tmp_path / "namespaces" / namespace / f"{namespace}.metalist.db",
    )

    payload = backups_route.BackupRestoreRequest(
        backup_id=f"folder::source::{backup_filename}",
        source="folder",
        backup_filename=backup_filename,
        backup_namespace="source",
        target_namespace="target",
    )

    monkeypatch.setattr(
        backups_route,
        "read_backup_launch_profile",
        lambda backup_path, *, expected_namespace: backups_route.BackupLaunchProfile(
            namespace=expected_namespace,
            port=8001,
            https_port=None,
            mcp_port=8766,
        ),
    )
    monkeypatch.setattr(
        backups_route,
        "load_namespace_launch_profile",
        lambda *, namespace: backups_route.NamespaceLaunchProfile(
            namespace=namespace,
            port=8010,
            https_port=8453,
            mcp_port=8770,
        ),
    )
    monkeypatch.setattr(backups_route, "load_all_namespace_launch_profiles", lambda: [])

    response = backups_route.restore_backup_preflight(payload=payload, token="token")

    assert response.target_namespace == "target"
    assert response.target_exists is True
    assert response.target_requires_password is True
    assert response.same_namespace is False
    assert response.restored_profile is not None
    assert response.restored_profile.port == 8001
    assert response.suggested_profile is not None
    assert response.suggested_profile.port == 8010
    assert response.suggested_profile.https_port == 8453
    assert response.port_conflicts == []


def test_same_name_restore_into_new_namespace_assigns_conflict_free_ports(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    folder_directory.mkdir()
    backup_filename = "henry-20260419-090000-000000.metalist-backup.tar.gz"
    backup_path = folder_directory / backup_filename
    backup_path.write_bytes(b"backup")
    target_database_path = tmp_path / "namespaces" / "henry" / "henry.metalist.db"
    saved_profiles: list[dict[str, object]] = []

    monkeypatch.setattr(
        backups_route,
        "load_backup_settings",
        lambda *, token: {
            "folder_path": str(folder_directory),
            "selected_namespaces": ["default"],
            "retention_count": 30,
        },
    )
    monkeypatch.setattr(backups_route, "_restore_target_exists", lambda *, target_namespace: False)
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: target_database_path,
    )
    monkeypatch.setattr(
        backups_route,
        "read_backup_launch_profile",
        lambda path, *, expected_namespace: backups_route.BackupLaunchProfile(
            namespace="henry",
            port=8000,
            https_port=8443,
            mcp_port=8765,
        ),
    )
    monkeypatch.setattr(
        backups_route,
        "load_all_namespace_launch_profiles",
        lambda: [
            backups_route.NamespaceLaunchProfile(
                namespace="default",
                port=8000,
                https_port=8443,
                mcp_port=8765,
            )
        ],
    )
    monkeypatch.setattr(backups_route, "restore_backup_to_paths", lambda path, database_path: None)
    monkeypatch.setattr(
        backups_route,
        "save_namespace_launch_profile",
        lambda **kwargs: saved_profiles.append(kwargs),
    )

    response = backups_route.restore_backup(
        payload=backups_route.BackupRestoreRequest(
            backup_id=f"folder::henry::{backup_filename}",
            source="folder",
            backup_filename=backup_filename,
            backup_namespace="henry",
            target_namespace="henry",
        ),
        token="token",
    )

    assert response.target_namespace == "henry"
    assert saved_profiles == [
        {
            "namespace": "henry",
            "port": 8001,
            "https_port": 8444,
            "mcp_port": None,
        }
    ]


def test_same_name_restore_into_existing_namespace_retains_target_ports(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    folder_directory.mkdir()
    backup_filename = "henry-20260419-090000-000000.metalist-backup.tar.gz"
    (folder_directory / backup_filename).write_bytes(b"backup")
    target_database_path = tmp_path / "namespaces" / "henry" / "henry.metalist.db"
    saved_profiles: list[dict[str, object]] = []

    monkeypatch.setattr(
        backups_route,
        "load_backup_settings",
        lambda *, token: {
            "folder_path": str(folder_directory),
            "selected_namespaces": ["henry"],
            "retention_count": 30,
        },
    )
    monkeypatch.setattr(backups_route, "_restore_target_exists", lambda *, target_namespace: True)
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: target_database_path,
    )
    monkeypatch.setattr(
        backups_route,
        "load_namespace_launch_profile",
        lambda *, namespace: backups_route.NamespaceLaunchProfile(
            namespace="henry",
            port=8002,
            https_port=8445,
            mcp_port=8767,
        ),
    )
    monkeypatch.setattr(backups_route, "restore_backup_to_paths", lambda path, database_path: None)
    monkeypatch.setattr(
        backups_route,
        "save_namespace_launch_profile",
        lambda **kwargs: saved_profiles.append(kwargs),
    )

    backups_route.restore_backup(
        payload=backups_route.BackupRestoreRequest(
            backup_id=f"folder::henry::{backup_filename}",
            source="folder",
            backup_filename=backup_filename,
            backup_namespace="henry",
            target_namespace="henry",
        ),
        token="token",
    )

    assert saved_profiles == [
        {
            "namespace": "henry",
            "port": 8002,
            "https_port": 8445,
            "mcp_port": 8767,
        }
    ]


def test_restore_import_rejects_existing_target_without_overwrite_confirmation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    folder_directory.mkdir()
    backup_filename = "source-20260419-090000-000000.metalist-backup.tar.gz"
    (folder_directory / backup_filename).write_bytes(b"backup")
    target_directory = tmp_path / "namespaces" / "target"
    target_directory.mkdir(parents=True)

    monkeypatch.setattr(
        backups_route,
        "resolve_namespace_directory",
        lambda *, namespace: tmp_path / "namespaces" / namespace,
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: tmp_path / "namespaces" / namespace / f"{namespace}.metalist.db",
    )

    payload = backups_route.BackupRestoreImportRequest(
        backup_id=f"folder::source::{backup_filename}",
        source="folder",
        backup_filename=backup_filename,
        backup_namespace="source",
        target_namespace="target",
        overwrite_existing_target=False,
        target_password="",
        launch_profile=backups_route.BackupRestoreLaunchProfileRequest(
            port=8001,
            https_port=None,
            mcp_port=8766,
        ),
    )

    with pytest.raises(backups_route.HTTPException) as excinfo:
        backups_route.import_backup(payload=payload, token="token")

    assert excinfo.value.status_code == 409
    assert excinfo.value.detail == "Target namespace already exists: target"


def test_restore_import_rejects_restored_profile_port_conflict(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    folder_directory.mkdir()
    backup_filename = "source-20260419-090000-000000.metalist-backup.tar.gz"
    (folder_directory / backup_filename).write_bytes(b"backup")

    monkeypatch.setattr(
        backups_route,
        "load_backup_settings",
        lambda *, token: {
            "folder_path": str(folder_directory),
            "selected_namespaces": ["source"],
            "retention_count": 30,
        },
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespace_directory",
        lambda *, namespace: tmp_path / "namespaces" / namespace,
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: tmp_path / "namespaces" / namespace / f"{namespace}.metalist.db",
    )
    monkeypatch.setattr(
        backups_route,
        "load_all_namespace_launch_profiles",
        lambda: [
            backups_route.NamespaceLaunchProfile(
                namespace="source",
                port=8001,
                https_port=None,
                mcp_port=8766,
            )
        ],
    )

    payload = backups_route.BackupRestoreImportRequest(
        backup_id=f"folder::source::{backup_filename}",
        source="folder",
        backup_filename=backup_filename,
        backup_namespace="source",
        target_namespace="target",
        overwrite_existing_target=False,
        target_password="",
        launch_profile=backups_route.BackupRestoreLaunchProfileRequest(
            port=8001,
            https_port=None,
            mcp_port=8766,
        ),
    )

    with pytest.raises(backups_route.HTTPException) as excinfo:
        backups_route.import_backup(payload=payload, token="token")

    assert excinfo.value.status_code == 409
    assert excinfo.value.detail == "HTTP port 8001 from backup conflicts with HTTP port reserved for namespace source"


def test_restore_import_passes_source_namespace_for_new_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    folder_directory.mkdir()
    backup_filename = "source-20260419-090000-000000.metalist-backup.tar.gz"
    backup_path = folder_directory / backup_filename
    backup_path.write_bytes(b"backup")
    restored: dict[str, object] = {}

    monkeypatch.setattr(
        backups_route,
        "load_backup_settings",
        lambda *, token: {
            "folder_path": str(folder_directory),
            "selected_namespaces": ["source"],
            "retention_count": 30,
        },
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespace_directory",
        lambda *, namespace: tmp_path / "namespaces" / namespace,
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: tmp_path / "namespaces" / namespace / f"{namespace}.metalist.db",
    )
    monkeypatch.setattr(
        backups_route,
        "read_backup_launch_profile",
        lambda backup_path, *, expected_namespace: None,
    )
    monkeypatch.setattr(backups_route, "load_all_namespace_launch_profiles", lambda: [])

    def _capture_restore(backup_path: Path, database_path: Path, *, source_namespace: str | None) -> None:
        restored["backup_path"] = backup_path
        restored["database_path"] = database_path
        restored["source_namespace"] = source_namespace

    monkeypatch.setattr(backups_route, "restore_backup_to_paths_from_namespace", _capture_restore)
    monkeypatch.setattr(
        backups_route,
        "save_namespace_launch_profile",
        lambda **kwargs: restored.__setitem__("saved_profile", kwargs),
    )

    payload = backups_route.BackupRestoreImportRequest(
        backup_id=f"folder::source::{backup_filename}",
        source="folder",
        backup_filename=backup_filename,
        backup_namespace="source",
        target_namespace="target",
        overwrite_existing_target=False,
        target_password="",
        launch_profile=backups_route.BackupRestoreLaunchProfileRequest(
            port=8010,
            https_port=None,
        ),
    )

    response = backups_route.import_backup(payload=payload, token="token")

    assert response.target_namespace == "target"
    assert response.open_namespace_suggested is True
    assert restored["backup_path"] == backup_path
    assert restored["database_path"] == tmp_path / "namespaces" / "target" / "target.metalist.db"
    assert restored["source_namespace"] == "source"
    assert restored["saved_profile"] == {
        "namespace": "target",
        "port": 8010,
        "https_port": None,
        "mcp_port": None,
    }


def test_restore_import_restarts_when_overwriting_active_namespace(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    folder_directory.mkdir()
    backup_filename = "source-20260419-090000-000000.metalist-backup.tar.gz"
    (folder_directory / backup_filename).write_bytes(b"backup")
    events: list[str] = []

    monkeypatch.setattr(backups_route, "ACTIVE_NAMESPACE", "target")
    monkeypatch.setattr(backups_route, "_restore_target_exists", lambda *, target_namespace: True)
    monkeypatch.setattr(backups_route, "_verify_target_namespace_password", lambda **kwargs: None)
    monkeypatch.setattr(
        backups_route,
        "load_namespace_launch_profile",
        lambda *, namespace: backups_route.NamespaceLaunchProfile(
            namespace=namespace,
            port=8002,
            https_port=8445,
            mcp_port=8767,
        ),
    )
    monkeypatch.setattr(
        backups_route,
        "load_backup_settings",
        lambda *, token: {
            "folder_path": str(folder_directory),
            "selected_namespaces": ["source"],
            "retention_count": 30,
        },
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: tmp_path / "namespaces" / namespace / f"{namespace}.metalist.db",
    )
    monkeypatch.setattr(backups_route, "load_all_namespace_launch_profiles", lambda: [])
    monkeypatch.setattr(
        backups_route,
        "restore_backup_to_paths_from_namespace",
        lambda *args, **kwargs: events.append("restore"),
    )
    monkeypatch.setattr(
        backups_route,
        "save_namespace_launch_profile",
        lambda **kwargs: events.append(f"save_profile:{kwargs}"),
    )
    monkeypatch.setattr(
        backups_route.maintenance_service,
        "enter_maintenance",
        lambda message: events.append("enter_maintenance"),
    )
    monkeypatch.setattr(
        backups_route.maintenance_service,
        "exit_maintenance",
        lambda: events.append("exit_maintenance"),
    )
    monkeypatch.setattr(
        backups_route,
        "_reset_runtime_state_after_restore",
        lambda: events.append("reset_runtime"),
    )
    monkeypatch.setattr(
        backups_route,
        "_schedule_server_restart_after_restore",
        lambda *, delay_seconds: events.append(f"schedule_restart:{delay_seconds}"),
    )

    payload = backups_route.BackupRestoreImportRequest(
        backup_id=f"folder::source::{backup_filename}",
        source="folder",
        backup_filename=backup_filename,
        backup_namespace="source",
        target_namespace="target",
        overwrite_existing_target=True,
        target_password="",
        launch_profile=backups_route.BackupRestoreLaunchProfileRequest(
            port=8010,
            https_port=None,
            mcp_port=8770,
        ),
    )

    response = backups_route.import_backup(payload=payload, token="token")

    assert response.active_namespace_restarted is True
    assert response.open_namespace_suggested is False
    assert events == [
        "enter_maintenance",
        "restore",
        "save_profile:{'namespace': 'target', 'port': 8002, 'https_port': 8445, 'mcp_port': 8767}",
        "reset_runtime",
        "exit_maintenance",
        "schedule_restart:0.5",
    ]


def test_restore_import_rejects_missing_password_for_existing_protected_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    folder_directory.mkdir()
    backup_filename = "source-20260419-090000-000000.metalist-backup.tar.gz"
    (folder_directory / backup_filename).write_bytes(b"backup")
    target_database_path = tmp_path / "namespaces" / "target" / "target.metalist.db"
    _write_password_protected_target_database(
        database_path=target_database_path,
        password="target-password",
    )

    monkeypatch.setattr(
        backups_route,
        "resolve_namespace_directory",
        lambda *, namespace: tmp_path / "namespaces" / namespace,
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: tmp_path / "namespaces" / namespace / f"{namespace}.metalist.db",
    )

    payload = backups_route.BackupRestoreImportRequest(
        backup_id=f"folder::source::{backup_filename}",
        source="folder",
        backup_filename=backup_filename,
        backup_namespace="source",
        target_namespace="target",
        overwrite_existing_target=True,
        target_password="",
        launch_profile=backups_route.BackupRestoreLaunchProfileRequest(
            port=8010,
            https_port=None,
            mcp_port=8770,
        ),
    )

    with pytest.raises(backups_route.HTTPException) as excinfo:
        backups_route.import_backup(payload=payload, token="token")

    assert excinfo.value.status_code == 400
    assert excinfo.value.detail == "Target namespace password is required"


def test_restore_import_rejects_wrong_password_for_existing_protected_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    folder_directory.mkdir()
    backup_filename = "source-20260419-090000-000000.metalist-backup.tar.gz"
    (folder_directory / backup_filename).write_bytes(b"backup")
    target_database_path = tmp_path / "namespaces" / "target" / "target.metalist.db"
    _write_password_protected_target_database(
        database_path=target_database_path,
        password="target-password",
    )

    monkeypatch.setattr(
        backups_route,
        "resolve_namespace_directory",
        lambda *, namespace: tmp_path / "namespaces" / namespace,
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: tmp_path / "namespaces" / namespace / f"{namespace}.metalist.db",
    )

    payload = backups_route.BackupRestoreImportRequest(
        backup_id=f"folder::source::{backup_filename}",
        source="folder",
        backup_filename=backup_filename,
        backup_namespace="source",
        target_namespace="target",
        overwrite_existing_target=True,
        target_password="wrong-password",
        launch_profile=backups_route.BackupRestoreLaunchProfileRequest(
            port=8010,
            https_port=None,
            mcp_port=8770,
        ),
    )

    with pytest.raises(backups_route.HTTPException) as excinfo:
        backups_route.import_backup(payload=payload, token="token")

    assert excinfo.value.status_code == 403
    assert excinfo.value.detail == "Target namespace password is incorrect"


def test_restore_import_accepts_correct_password_for_existing_protected_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    folder_directory = tmp_path / "backups"
    folder_directory.mkdir()
    backup_filename = "source-20260419-090000-000000.metalist-backup.tar.gz"
    backup_path = folder_directory / backup_filename
    backup_path.write_bytes(b"backup")
    target_database_path = tmp_path / "namespaces" / "target" / "target.metalist.db"
    _write_password_protected_target_database(
        database_path=target_database_path,
        password="target-password",
    )
    restored: dict[str, object] = {}

    monkeypatch.setattr(
        backups_route,
        "load_backup_settings",
        lambda *, token: {
            "folder_path": str(folder_directory),
            "selected_namespaces": ["source"],
            "retention_count": 30,
        },
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespace_directory",
        lambda *, namespace: tmp_path / "namespaces" / namespace,
    )
    monkeypatch.setattr(
        backups_route,
        "resolve_namespaced_database_path",
        lambda *, namespace: tmp_path / "namespaces" / namespace / f"{namespace}.metalist.db",
    )
    monkeypatch.setattr(
        backups_route,
        "load_namespace_launch_profile",
        lambda *, namespace: backups_route.NamespaceLaunchProfile(
            namespace=namespace,
            port=8002,
            https_port=8445,
            mcp_port=8767,
        ),
    )
    monkeypatch.setattr(backups_route, "load_all_namespace_launch_profiles", lambda: [])

    def _capture_restore(backup_path: Path, database_path: Path, *, source_namespace: str | None) -> None:
        restored["backup_path"] = backup_path
        restored["database_path"] = database_path
        restored["source_namespace"] = source_namespace

    monkeypatch.setattr(backups_route, "restore_backup_to_paths_from_namespace", _capture_restore)
    monkeypatch.setattr(
        backups_route,
        "save_namespace_launch_profile",
        lambda **kwargs: restored.__setitem__("saved_profile", kwargs),
    )

    payload = backups_route.BackupRestoreImportRequest(
        backup_id=f"folder::source::{backup_filename}",
        source="folder",
        backup_filename=backup_filename,
        backup_namespace="source",
        target_namespace="target",
        overwrite_existing_target=True,
        target_password="target-password",
        launch_profile=backups_route.BackupRestoreLaunchProfileRequest(
            port=8010,
            https_port=None,
            mcp_port=8770,
        ),
    )

    response = backups_route.import_backup(payload=payload, token="token")

    assert response.target_namespace == "target"
    assert response.open_namespace_suggested is True
    assert restored["backup_path"] == backup_path
    assert restored["database_path"] == target_database_path
    assert restored["source_namespace"] == "source"
    assert restored["saved_profile"] == {
        "namespace": "target",
        "port": 8002,
        "https_port": 8445,
        "mcp_port": 8767,
    }


def _write_folder_backup(folder: Path, filename: str, *, modified_at: float) -> Path:
    path = folder / filename
    path.write_bytes(b"backup")
    os.utime(path, (modified_at, modified_at))
    return path


def test_run_backup_keeps_the_newest_backups_and_deletes_only_the_oldest_beyond_the_keep_count(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The folder backup deletes, per namespace, the oldest backups beyond the keep
    count, and nothing else: newer backups, other namespaces' backups and unrelated
    files stay."""
    folder = tmp_path / "Downloads"
    folder.mkdir()
    database = tmp_path / "default.metalist.db"
    database.touch()
    older_default = [
        _write_folder_backup(folder, f"default-2026041{day}-090000-000000.metalist-backup.tar.gz", modified_at=1_000 + day)
        for day in range(5)
    ]
    other_namespace = [
        _write_folder_backup(folder, f"work-2026041{day}-090000-000000.metalist-backup.tar.gz", modified_at=1_000 + day)
        for day in range(2)
    ]
    unrelated = _write_folder_backup(folder, "notes.txt", modified_at=1_000)
    created_name = "default-20260419-090000-000000.metalist-backup.tar.gz"

    def create_newest(database_path: Path, backup_directory: Path) -> BackupFileInfo:
        assert database_path == database and backup_directory == folder
        _write_folder_backup(folder, created_name, modified_at=2_000)
        return BackupFileInfo(filename=created_name, created_at="2026-04-19T09:00:00+00:00", size_bytes=6)

    monkeypatch.setattr(backups_route, "update_backup_settings", lambda **settings: settings)
    monkeypatch.setattr(backups_route, "resolve_namespaced_database_path", lambda *, namespace: database)
    monkeypatch.setattr(backups_route, "create_timestamped_backup_for_paths", create_newest)

    response = backups_route.run_backup(
        payload=backups_route.BackupSettingsUpdateRequest(
            folder_path=str(folder), selected_namespaces=["default"], retention_count=3,
        ),
        token="token",
    )

    kept_default = sorted(path.name for path in folder.glob("default-*"))
    assert kept_default == sorted([created_name, older_default[3].name, older_default[4].name])
    assert all(path.exists() for path in other_namespace), "another namespace's backups are not counted or deleted"
    assert unrelated.exists(), "files that are not backups are never deleted"
    assert (response.results[0].deleted_count, response.results[0].remaining_count) == (3, 3)
