from __future__ import annotations

from pathlib import Path

import pytest

from app.startup_sanity import assert_startup_sanity
from app.startup_sanity import collect_startup_sanity_violations


def test_repository_passes_startup_sanity() -> None:
    assert_startup_sanity(Path(__file__).resolve().parents[2])


def _write_file(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_startup_sanity_rejects_forbidden_try_except(tmp_path: Path) -> None:
    _write_file(
        tmp_path / "bad.py",
        """
def bad():
    try:
        internal_call()
    except ValueError:
        raise
""".strip()
        + "\n",
    )

    paths, violations = collect_startup_sanity_violations(tmp_path)

    assert len(paths) == 1
    assert any(
        violation.rule_id == "PY001"
        and "exception type not allowlisted: ValueError" in violation.message
        for violation in violations
    )

    with pytest.raises(RuntimeError, match="PY001"):
        assert_startup_sanity(tmp_path)


def test_startup_sanity_rejects_missing_transactional_route(tmp_path: Path) -> None:
    _write_file(
        tmp_path / "routes.py",
        """
from fastapi import APIRouter

router = APIRouter(prefix="/notes")

@router.post("/move")
def move():
    return {"ok": True}
""".strip()
        + "\n",
    )

    _, violations = collect_startup_sanity_violations(tmp_path)

    assert any(
        violation.rule_id == "TXN001"
        and "POST /notes/move (move) missing @transactional_route" in violation.message
        for violation in violations
    )


def test_startup_sanity_rejects_misordered_transactional_route(tmp_path: Path) -> None:
    _write_file(
        tmp_path / "routes.py",
        """
from fastapi import APIRouter

from app.api.transactions import transactional_route

router = APIRouter(prefix="/notes")

@transactional_route
@router.post("/move")
def move():
    return {"ok": True}
""".strip()
        + "\n",
    )

    _, violations = collect_startup_sanity_violations(tmp_path)

    assert any(
        violation.rule_id == "TXN002"
        and "@transactional_route directly below the route decorator" in violation.message
        for violation in violations
    )


def test_startup_sanity_honors_suppression_comments(tmp_path: Path) -> None:
    _write_file(
        tmp_path / "suppressed.py",
        """
def bad():
    # lint: allow-PY001 rationale="intentional suppression for test"
    try:
        internal_call()
    except ValueError:
        raise
""".strip()
        + "\n",
    )

    _, violations = collect_startup_sanity_violations(tmp_path)

    assert any(
        violation.rule_id == "PY001"
        and "exception type not allowlisted: ValueError" in violation.message
        for violation in violations
    )
    assert not any(
        violation.rule_id == "PY001"
        and "try body has no allowlisted external call" in violation.message
        for violation in violations
    )


def test_installed_distribution_scan_excludes_neighboring_packages(tmp_path: Path) -> None:
    _write_file(tmp_path / "main.py", "APP_NAME = 'MetaList'\n")
    _write_file(tmp_path / "app" / "owned.py", "VALUE = 1\n")
    _write_file(
        tmp_path / "argon2" / "dependency.py",
        "VALUE = environ.get('EXTERNAL_DEFAULT', '1')\n",
    )

    paths, violations = collect_startup_sanity_violations(tmp_path)
    relative_paths = [path.relative_to(tmp_path).as_posix() for path in paths]

    assert relative_paths == ["app/owned.py", "main.py"]
    assert violations == []


def test_startup_sanity_rejects_historical_backup_mutation_capabilities(tmp_path: Path) -> None:
    _write_file(
        tmp_path / "app" / "services" / "backup_service.py",
        """
import os
import tarfile

def upgrade_backup(backup_path, replacement_path):
    with tarfile.open(backup_path, mode="w:gz"):
        pass
    # lint: allow-BKP001 rationale="backup immutability cannot be suppressed"
    os.replace(replacement_path, backup_path)
""".strip()
        + "\n",
    )

    _, violations = collect_startup_sanity_violations(tmp_path)
    backup_violations = [
        violation for violation in violations if violation.rule_id == "BKP001"
    ]

    assert len(backup_violations) == 3
    assert any("transformation functions are forbidden" in item.message for item in backup_violations)
    assert any("created exclusively" in item.message for item in backup_violations)
    assert any("os.replace" in item.message for item in backup_violations)


def test_startup_sanity_rejects_backup_service_import_from_database_migrations(
    tmp_path: Path,
) -> None:
    _write_file(
        tmp_path / "app" / "db" / "migrations.py",
        "from app.services.backup_service import list_backups\n",
    )

    _, violations = collect_startup_sanity_violations(tmp_path)

    assert any(
        violation.rule_id == "BKP001"
        and "migrations must not import the backup service" in violation.message
        for violation in violations
    )


def test_startup_sanity_allows_only_new_backup_creation_from_authenticated_migration(
    tmp_path: Path,
) -> None:
    _write_file(
        tmp_path / "app" / "services" / "auth_service.py",
        """
from app.services.backup_service import create_timestamped_backup
from app.services.backup_service import list_backups
""".strip()
        + "\n",
    )

    _, violations = collect_startup_sanity_violations(tmp_path)

    assert any(
        violation.rule_id == "BKP001"
        and "may only create a new backup" in violation.message
        for violation in violations
    )


def test_startup_sanity_rejects_backup_access_from_login(tmp_path: Path) -> None:
    _write_file(
        tmp_path / "app" / "api" / "routes" / "auth.py",
        """
def login():
    list_backups()
""".strip()
        + "\n",
    )

    _, violations = collect_startup_sanity_violations(tmp_path)

    assert any(
        violation.rule_id == "BKP001"
        and "login must not enumerate" in violation.message
        for violation in violations
    )


def test_startup_sanity_rejects_direct_backup_write_handles(tmp_path: Path) -> None:
    _write_file(
        tmp_path / "app" / "services" / "backup_service.py",
        """
def damage(backup_path):
    with backup_path.open("wb") as handle:
        handle.write(b"damage")
""".strip()
        + "\n",
    )

    _, violations = collect_startup_sanity_violations(tmp_path)

    assert any(
        violation.rule_id == "BKP001"
        and "must not be opened for writing" in violation.message
        for violation in violations
    )


def test_startup_sanity_rejects_backup_replacement_outside_backup_service(
    tmp_path: Path,
) -> None:
    _write_file(
        tmp_path / "app" / "other_service.py",
        """
import os

def damage(source_path, backup_path):
    os.replace(source_path, backup_path)
""".strip()
        + "\n",
    )

    _, violations = collect_startup_sanity_violations(tmp_path)

    assert any(
        violation.rule_id == "BKP001"
        and "os.replace" in violation.message
        for violation in violations
    )


def test_startup_sanity_allows_exclusive_backup_creation_and_explicit_deletion(
    tmp_path: Path,
) -> None:
    _write_file(
        tmp_path / "app" / "services" / "backup_service.py",
        """
import tarfile

def create_backup(backup_path):
    with tarfile.open(backup_path, mode="x:gz"):
        pass

def delete_oldest_backups_in_directory(backup_path):
    backup_path.unlink()
""".strip()
        + "\n",
    )

    _, violations = collect_startup_sanity_violations(tmp_path)

    assert not any(violation.rule_id == "BKP001" for violation in violations)
