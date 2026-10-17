"""Admit a release tag only after its exact main commit passed the full matrix."""

from __future__ import annotations

import argparse
import ast
from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.parse
import urllib.request


WORKFLOW = "publish-pypi.yml"
WORKFLOW_NAME = "Publish to PyPI"
SYSTEMS = ("ubuntu-latest", "macos-latest", "windows-latest")
PYTHONS = ("3.10", "3.14")
BROWSER_LABELS = (
    "Linux Chrome and Firefox",
    "macOS Chrome and Firefox",
    "Windows Chrome and Firefox",
    "Windows Edge HTTPS",
)
# Counted by hand as a cross-check of expected_main_jobs(): build and publish; per system a
# JavaScript job plus a Python and a package job per Python; per browser label a smoke and a soak.
EXPECTED_MAIN_JOB_COUNT = 25
GITHUB_API_TIMEOUT_SECONDS = 30


class ReleaseValidationError(RuntimeError):
    """The tag cannot be safely published from an earlier validation run."""


def expected_main_jobs() -> dict[str, str]:
    jobs = {"build": "success", "publish": "skipped"}
    for system in SYSTEMS:
        jobs[f"JavaScript and sanity ({system})"] = "success"
        for python_version in PYTHONS:
            jobs[f"Python ({system}, {python_version})"] = "success"
            jobs[f"Package and update ({system}, {python_version})"] = "success"
    for label in BROWSER_LABELS:
        jobs[f"Browser smoke ({label})"] = "success"
        jobs[f"Browser soak ({label})"] = "success"
    assert len(jobs) == EXPECTED_MAIN_JOB_COUNT
    return jobs


def validate_main_jobs(jobs: list[dict[str, object]]) -> None:
    names = [str(job["name"]) for job in jobs]
    duplicates = sorted(name for name, count in Counter(names).items() if count != 1)
    actual = {str(job["name"]): str(job["conclusion"]) for job in jobs}
    expected = expected_main_jobs()
    if duplicates or actual != expected:
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        wrong = sorted(name for name in expected.keys() & actual.keys() if actual[name] != expected[name])
        raise ReleaseValidationError(
            "Exact-commit main validation is incomplete or failed: "
            f"duplicates={duplicates}; missing={missing}; extra={extra}; "
            f"wrong={[(name, actual[name], expected[name]) for name in wrong]}"
        )


def select_main_run(
    runs: list[dict[str, object]], *, repository: str, commit: str,
) -> dict[str, object]:
    matches = [
        run for run in runs
        if run["head_sha"] == commit
        and run["head_branch"] == "main"
        and run["event"] == "push"
        and run["name"] == WORKFLOW_NAME
        and run["path"] == f".github/workflows/{WORKFLOW}"
        and run["head_repository"] is not None
        and run["head_repository"]["full_name"] == repository
    ]
    if len(matches) != 1:
        raise ReleaseValidationError(
            f"Expected one main validation run at {commit}, found {len(matches)}"
        )
    run = matches[0]
    if run["status"] != "completed" or run["conclusion"] != "success":
        raise ReleaseValidationError(f"Main validation run {run['id']} has not passed")
    if run["run_attempt"] != 1:
        raise ReleaseValidationError(f"Main validation run {run['id']} was rerun")
    return run


def validate_artifact(
    artifacts: list[dict[str, object]], *, run_id: int, commit: str,
) -> None:
    candidates = [artifact for artifact in artifacts if artifact["name"] == "pypi-distributions"]
    if len(candidates) != 1:
        raise ReleaseValidationError(f"Expected one tested distribution artifact, found {len(candidates)}")
    artifact = candidates[0]
    if artifact["expired"] is not False:
        raise ReleaseValidationError("Tested distribution artifact has expired")
    source_run = artifact["workflow_run"]
    if source_run["id"] != run_id or source_run["head_sha"] != commit:
        raise ReleaseValidationError("Distribution artifact belongs to another workflow run or commit")


def validate_tag_version(*, root: Path, tag: str) -> str:
    if re.fullmatch(r"v\d+\.\d+\.\d+", tag) is None:
        raise ReleaseValidationError(f"Invalid release tag: {tag}")
    version = tag[1:]
    statements = ast.parse((root / "app/version.py").read_text(encoding="utf-8")).body
    if statements and isinstance(statements[0], ast.Expr) and isinstance(
        statements[0].value, ast.Constant
    ) and isinstance(statements[0].value.value, str):
        statements = statements[1:]
    if len(statements) != 1 or not isinstance(statements[0], ast.Assign):
        raise ReleaseValidationError(f"Tag {tag} does not match app/version.py")
    assignment = statements[0]
    if (
        len(assignment.targets) != 1
        or not isinstance(assignment.targets[0], ast.Name)
        or assignment.targets[0].id != "__version__"
        or not isinstance(assignment.value, ast.Constant)
        or assignment.value.value != version
    ):
        raise ReleaseValidationError(f"Tag {tag} does not match app/version.py")
    return version


def check_distributions(*, directory: Path, version: str) -> None:
    expected = {
        f"metalist-{version}-py3-none-any.whl",
        f"metalist-{version}.tar.gz",
    }
    actual = {path.name for path in directory.iterdir()}
    if actual != expected or any(not path.is_file() or path.is_symlink() for path in directory.iterdir()):
        raise ReleaseValidationError(
            f"Downloaded distributions do not match tag v{version}: {sorted(actual)}"
        )


def github_json(*, repository: str, token: str, path: str, parameters: dict[str, str]) -> dict:
    url = f"https://api.github.com/repos/{repository}/{path}"
    if parameters:
        url = f"{url}?{urllib.parse.urlencode(parameters)}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "metalist-release-validation",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=GITHUB_API_TIMEOUT_SECONDS) as response:
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise ReleaseValidationError(f"GitHub returned a non-object response for {path}")
    return payload


def resolve_main_run(*, repository: str, token: str, commit: str) -> int:
    listing = github_json(
        repository=repository, token=token,
        path=f"actions/workflows/{WORKFLOW}/runs",
        parameters={"branch": "main", "event": "push", "head_sha": commit, "per_page": "100"},
    )
    runs = listing["workflow_runs"]
    if listing["total_count"] != len(runs):
        raise ReleaseValidationError("Main validation search exceeded one API page")
    run = select_main_run(runs, repository=repository, commit=commit)
    run_id = int(run["id"])
    jobs_listing = github_json(
        repository=repository, token=token,
        path=f"actions/runs/{run_id}/jobs",
        parameters={"filter": "latest", "per_page": "100"},
    )
    jobs = jobs_listing["jobs"]
    if jobs_listing["total_count"] != len(jobs):
        raise ReleaseValidationError("Main validation jobs exceeded one API page")
    validate_main_jobs(jobs)
    artifact_listing = github_json(
        repository=repository, token=token,
        path=f"actions/runs/{run_id}/artifacts",
        parameters={"per_page": "100"},
    )
    artifacts = artifact_listing["artifacts"]
    if artifact_listing["total_count"] != len(artifacts):
        raise ReleaseValidationError("Main validation artifacts exceeded one API page")
    validate_artifact(artifacts, run_id=run_id, commit=commit)
    return run_id


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-distributions", type=Path)
    arguments = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    tag = os.environ["RELEASE_TAG"]
    version = validate_tag_version(root=root, tag=tag)
    if arguments.check_distributions is not None:
        check_distributions(directory=arguments.check_distributions, version=version)
        return
    token = os.environ["GITHUB_TOKEN"]
    repository = os.environ["GITHUB_REPOSITORY"]
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True, encoding="utf-8",
    ).strip()
    run_id = resolve_main_run(repository=repository, token=token, commit=commit)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        output.write(f"run_id={run_id}\n")
    print(f"Validated main commit {commit} in run {run_id}; reusing its tested distributions")


if __name__ == "__main__":
    main()
