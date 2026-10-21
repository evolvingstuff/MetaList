from __future__ import annotations

import hashlib
from io import BytesIO, StringIO
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import zipfile

import pytest

from app.version import __version__


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/release.py"
SPEC = importlib.util.spec_from_file_location("release_driver", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def successful_jobs(*, is_tag: bool) -> list[dict[str, str]]:
    if is_tag:
        return [
            {"name": name, "conclusion": conclusion, "status": "completed"}
            for name, conclusion in (
                ("build", "skipped"),
                ("Python (${{ matrix.os }}, ${{ matrix.python-version }})", "skipped"),
                ("JavaScript and sanity (${{ matrix.os }})", "skipped"),
                ("Package and update (${{ matrix.os }}, ${{ matrix.python-version }})", "skipped"),
                ("Browser smoke (${{ matrix.label }})", "skipped"),
                ("Browser soak (${{ matrix.label }})", "skipped"),
                ("publish", "success"),
            )
        ]
    return [
        {"name": name, "conclusion": expected, "status": "completed"}
        for name, expected in release.expected_jobs(publish_conclusion="skipped").items()
    ]


def test_required_matrix_is_symmetric_and_publish_is_event_specific() -> None:
    main = release.expected_jobs(publish_conclusion="skipped")
    tag = successful_jobs(is_tag=True)
    assert len(main) == 25
    assert len(tag) == 7
    assert {name for name in main if name.startswith("Python (")} == {
        f"Python ({system}, {version})"
        for system in release.SUPPORTED_SYSTEMS
        for version in release.SUPPORTED_PYTHONS
    }
    assert {name for name in main if name.startswith("Package and update (")} == {
        f"Package and update ({system}, {version})"
        for system in release.SUPPORTED_SYSTEMS
        for version in release.SUPPORTED_PYTHONS
    }
    assert main["publish"] == "skipped"
    assert [job["name"] for job in tag if job["conclusion"] == "success"] == ["publish"]


def test_release_driver_matrix_matches_workflow_source() -> None:
    workflow = (SCRIPT.parents[1] / ".github/workflows/publish-pypi.yml").read_text(encoding="utf-8")
    assert '    branches:\n      - "main"\n' in workflow
    assert '    tags:\n      - "v*"\n' in workflow
    assert "  pull_request:" not in workflow
    assert "  schedule:" not in workflow
    assert "${{ github.event_name }}-${{ github.ref }}" in workflow
    system_matrix = "os: [ubuntu-latest, macos-latest, windows-latest]"
    python_matrix = 'python-version: ["3.11", "3.14"]'
    assert workflow.count(system_matrix) == 3
    assert workflow.count(python_matrix) == 2
    for label in (
        "Linux Chrome and Firefox",
        "macOS Chrome and Firefox",
        "Windows Chrome and Firefox",
        "Windows Edge HTTPS",
    ):
        assert workflow.count(f"label: {label}") == 2
    assert workflow.count("if: ${{ github.ref == 'refs/heads/main' }}") == 6
    assert "run-id: ${{ steps.validation.outputs.run_id }}" in workflow
    assert "python scripts/resolve_release_validation.py" in workflow


@pytest.mark.parametrize("is_tag", [False, True])
def test_complete_required_matrix_passes(is_tag: bool) -> None:
    release.validate_jobs(successful_jobs(is_tag=is_tag), is_tag=is_tag)


@pytest.mark.parametrize("mutation", ["missing", "failed", "extra", "duplicate"])
def test_incomplete_or_failed_matrix_blocks_release(mutation: str) -> None:
    jobs = successful_jobs(is_tag=True)
    if mutation == "missing":
        jobs.pop()
    elif mutation == "failed":
        jobs[0]["conclusion"] = "failure"
    elif mutation == "extra":
        jobs.append({"name": "Unexpected", "conclusion": "success", "status": "completed"})
    else:
        jobs.append(jobs[0].copy())
    with pytest.raises(release.ReleaseError):
        release.validate_jobs(jobs, is_tag=True)


def test_tag_validation_rejects_repeated_main_matrix() -> None:
    jobs = successful_jobs(is_tag=False)
    jobs[-1]["conclusion"] = "success"
    with pytest.raises(release.ReleaseError, match="without rerunning checks"):
        release.validate_jobs(jobs, is_tag=True)


def test_run_selection_requires_exact_commit_branch_event_and_workflow() -> None:
    valid = {
        "id": 12,
        "head_sha": "abc",
        "head_branch": "v1.2.3",
        "event": "push",
        "name": release.WORKFLOW_NAME,
        "path": f".github/workflows/{release.WORKFLOW}",
    }
    wrong_runs = [
        dict(valid, id=13, head_sha="different"),
        dict(valid, id=14, head_branch="main"),
        dict(valid, id=15, event="workflow_dispatch"),
        dict(valid, id=16, name="Other workflow"),
        dict(valid, id=17, path=".github/workflows/other.yml"),
    ]
    assert release.matching_runs([*wrong_runs, valid], commit="abc", branch="v1.2.3") == [valid]
    assert release.matching_runs(wrong_runs, commit="abc", branch="v1.2.3") == []


def test_release_driver_rejects_rerun_before_tagging() -> None:
    run = {
        "id": 12,
        "head_sha": "abc",
        "head_branch": "main",
        "event": "push",
        "name": release.WORKFLOW_NAME,
        "path": f".github/workflows/{release.WORKFLOW}",
        "status": "completed",
        "conclusion": "success",
        "run_attempt": 2,
    }

    class Client:
        def workflow_runs(self, *, branch: str) -> list[dict[str, object]]:
            assert branch == "main"
            return [run]

        def jobs(self, *, run_id: int) -> list[dict[str, object]]:
            assert run_id == 12
            return successful_jobs(is_tag=False)

    console = release.Console(file=StringIO(), force_terminal=False)
    with pytest.raises(release.ReleaseError, match="was rerun"):
        release.wait_for_workflow(
            Client(), commit="abc", branch="main", is_tag=False, console=console,
        )


def distribution_zip(version: str, files: dict[str, bytes]) -> bytes:
    stream = BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return stream.getvalue()


def test_distribution_and_pypi_hashes_match_exact_release_files() -> None:
    version = "1.2.3"
    files = {
        f"metalist-{version}-py3-none-any.whl": b"wheel",
        f"metalist-{version}.tar.gz": b"source",
    }
    artifact = release.artifact_hashes(distribution_zip(version, files), version=version)
    payload = {
        "info": {"version": version},
        "urls": [
            {"filename": name, "digests": {"sha256": hashlib.sha256(content).hexdigest()}}
            for name, content in files.items()
        ],
    }
    assert artifact == release.pypi_hashes(payload, version=version)


def test_pypi_hashes_reject_duplicate_filenames() -> None:
    payload = {
        "info": {"version": "1.2.3"},
        "urls": [
            {
                "filename": "metalist-1.2.3-py3-none-any.whl",
                "digests": {"sha256": "a"},
            },
            {
                "filename": "metalist-1.2.3-py3-none-any.whl",
                "digests": {"sha256": "b"},
            },
        ],
    }
    with pytest.raises(release.ReleaseError, match="duplicate"):
        release.pypi_hashes(payload, version="1.2.3")


@pytest.mark.parametrize(
    "files",
    [
        {"metalist-1.2.3-py3-none-any.whl": b"wheel"},
        {
            "metalist-1.2.3-py3-none-any.whl": b"wheel",
            "metalist-1.2.3.tar.gz": b"source",
            "unexpected.txt": b"unexpected",
        },
    ],
)
def test_distribution_artifact_rejects_missing_or_extra_files(files: dict[str, bytes]) -> None:
    with pytest.raises(release.ReleaseError, match="unexpected files"):
        release.artifact_hashes(distribution_zip("1.2.3", files), version="1.2.3")


def test_clean_install_waits_for_the_index_pip_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    # PyPI serves the simple index as HTML and as JSON, cached separately; pip asks
    # for JSON. The 0.15.0 release saw the HTML list the wheel while pip still got
    # an index without it ("No matching distribution found"). The driver waits
    # until the index pip reads lists the wheel.
    wheel = "metalist-1.2.3-py3-none-any.whl"
    json_pages = iter((
        {"files": [{"filename": "metalist-1.2.2-py3-none-any.whl"}]},
        {"files": [{"filename": "metalist-1.2.2-py3-none-any.whl"}]},
        {"files": [{"filename": "metalist-1.2.2-py3-none-any.whl"}, {"filename": wheel}]},
    ))
    requests = []

    def get_index(url: str, *, headers: dict[str, str], timeout: int) -> SimpleNamespace:
        requests.append((url, headers["Accept"], timeout))
        payload = next(json_pages)
        return SimpleNamespace(
            json=lambda: payload,
            headers={"Content-Type": release.PIP_SIMPLE_INDEX_JSON_TYPE},
            raise_for_status=lambda: None,
        )

    monkeypatch.setattr(release.requests, "get", get_index)
    monkeypatch.setattr(release.time, "sleep", lambda seconds: None)
    console = release.Console(file=StringIO(), force_terminal=False)
    release.wait_for_pypi_install_index(version="1.2.3", console=console)
    assert requests == [("https://pypi.org/simple/metalist/", release.PIP_SIMPLE_INDEX_ACCEPT, 30)] * 3


def test_the_index_wait_asks_for_what_pip_asks_for() -> None:
    # pip's own Accept header (pip/_internal/index/collector.py): JSON first.
    assert release.PIP_SIMPLE_INDEX_ACCEPT == (
        "application/vnd.pypi.simple.v1+json, application/vnd.pypi.simple.v1+html; q=0.1, text/html; q=0.01"
    )


def test_the_index_wait_rejects_an_answer_that_is_not_the_json_index(monkeypatch: pytest.MonkeyPatch) -> None:
    def get_html(url: str, *, headers: dict[str, str], timeout: int) -> SimpleNamespace:
        return SimpleNamespace(json=lambda: {}, headers={"Content-Type": "text/html"}, raise_for_status=lambda: None)

    monkeypatch.setattr(release.requests, "get", get_html)
    console = release.Console(file=StringIO(), force_terminal=False)
    with pytest.raises(release.ReleaseError, match="not the JSON simple index"):
        release.wait_for_pypi_install_index(version="1.2.3", console=console)

def test_version_file_must_be_one_exact_assignment(tmp_path: Path) -> None:
    (tmp_path / "app").mkdir()
    (tmp_path / "app/version.py").write_text(
        '"""Application version."""\n\n__version__ = "1.2.3"\n', encoding="utf-8"
    )
    assert release.read_version(tmp_path) == "1.2.3"
    (tmp_path / "app/version.py").write_text('__version__ = "1.2.3"\nOTHER = True\n', encoding="utf-8")
    with pytest.raises(release.ReleaseError, match="exactly one"):
        release.read_version(tmp_path)


def test_release_driver_accepts_actual_application_version_file() -> None:
    assert release.read_version(SCRIPT.parents[1]) == __version__


def configure_preflight(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    override: dict[str, str],
) -> list[list[str]]:
    configuration = {
        "status": "",
        "branch": "main",
        "remote": "https://github.com/metalist-app/metalist.git",
        "origin_commit": "abc",
        "declared_version": "1.2.3",
        "local_tag": "",
        "remote_tag": "",
    }
    configuration.update(override)
    (tmp_path / "app").mkdir()
    (tmp_path / "app/version.py").write_text(
        f'__version__ = "{configuration["declared_version"]}"\n', encoding="utf-8",
    )
    responses = {
        ("status", "--porcelain"): configuration["status"],
        ("branch", "--show-current"): configuration["branch"],
        ("remote", "get-url", "origin"): configuration["remote"],
        ("rev-parse", "HEAD"): "abc",
        ("rev-parse", "origin/main"): configuration["origin_commit"],
    }
    monkeypatch.setattr(release, "git_output", lambda root, *arguments: responses[arguments])
    monkeypatch.setattr(release, "local_tag_target", lambda root, tag: configuration["local_tag"])
    monkeypatch.setattr(release, "remote_tag_target", lambda root, tag: configuration["remote_tag"])
    commands = []

    def record_command(command: list[str], **options: object) -> SimpleNamespace:
        commands.append(command)
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(release, "run_command", record_command)
    return commands


def test_preflight_accepts_only_clean_synchronized_main(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    commands = configure_preflight(tmp_path, monkeypatch, {})
    console = release.Console(file=StringIO(), force_terminal=False)
    assert release.preflight(tmp_path, version="1.2.3", console=console) == ("abc", "v1.2.3", False)
    assert commands == [["git", "fetch", "--prune", "--tags", "origin", "main"]]


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"status": "?? untracked"}, "clean"),
        ({"branch": "feature/work"}, "main branch"),
        ({"remote": "https://github.com/example/fork.git"}, "does not point"),
        # The repository moved to the metalist-app organization (2026-10-20).
        ({"remote": "https://github.com/evolvingstuff/metalist.git"}, "does not point"),
        ({"origin_commit": "different"}, "same commit"),
        ({"declared_version": "1.2.4"}, "does not declare"),
        ({"local_tag": "different"}, "Local v1.2.3 points"),
        ({"remote_tag": "different"}, "Remote v1.2.3 points"),
    ],
)
def test_preflight_rejects_unsafe_release_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    override: dict[str, str],
    message: str,
) -> None:
    configure_preflight(tmp_path, monkeypatch, override)
    console = release.Console(file=StringIO(), force_terminal=False)
    with pytest.raises(release.ReleaseError, match=message):
        release.preflight(tmp_path, version="1.2.3", console=console)
