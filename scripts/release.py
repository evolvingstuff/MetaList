"""Publish one validated MetaList version through the GitHub/PyPI release path."""
from __future__ import annotations

from http import HTTPStatus
import argparse
import ast
from collections import Counter
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import venv
import zipfile

import requests
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn, TimeElapsedColumn


REPOSITORY = "evolvingstuff/metalist"
WORKFLOW = "publish-pypi.yml"
WORKFLOW_NAME = "Publish to PyPI"
SUPPORTED_SYSTEMS = ("ubuntu-latest", "macos-latest", "windows-latest")
SUPPORTED_PYTHONS = ("3.10", "3.14")
POLL_SECONDS = 15
WORKFLOW_TIMEOUT_SECONDS = 3 * 60 * 60
PYPI_TIMEOUT_SECONDS = 5 * 60


class ReleaseError(RuntimeError):
    """An external release precondition or operation failed."""


def run_command(
    command: list[str],
    *,
    directory: Path,
    stdin: str,
) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment["GIT_TERMINAL_PROMPT"] = "0"
    completed = subprocess.run(
        command,
        cwd=directory,
        env=environment,
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip()
        if not detail:
            detail = completed.stdout.strip()
        raise ReleaseError(f"Command failed ({' '.join(command)}):\n{detail}")
    return completed


def run_command_allow_failure(command: list[str], *, directory: Path) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment["GIT_TERMINAL_PROMPT"] = "0"
    return subprocess.run(
        command,
        cwd=directory,
        env=environment,
        input="",
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def git_output(root: Path, *arguments: str) -> str:
    return run_command(["git", *arguments], directory=root, stdin="").stdout.strip()


def read_version(root: Path) -> str:
    source = (root / "app/version.py").read_text(encoding="utf-8")
    statements = ast.parse(source).body
    if (
        statements
        and isinstance(statements[0], ast.Expr)
        and isinstance(statements[0].value, ast.Constant)
        and isinstance(statements[0].value.value, str)
    ):
        statements = statements[1:]
    if len(statements) != 1 or not isinstance(statements[0], ast.Assign):
        raise ReleaseError("app/version.py must contain exactly one semantic __version__ assignment")
    assignment = statements[0]
    if (
        len(assignment.targets) != 1
        or not isinstance(assignment.targets[0], ast.Name)
        or assignment.targets[0].id != "__version__"
        or not isinstance(assignment.value, ast.Constant)
        or not isinstance(assignment.value.value, str)
        or re.fullmatch(r"\d+\.\d+\.\d+", assignment.value.value) is None
    ):
        raise ReleaseError("app/version.py must contain exactly one semantic __version__ assignment")
    return assignment.value.value


def expected_jobs(*, publish_conclusion: str) -> dict[str, str]:
    jobs = {"build": "success", "publish": publish_conclusion}
    for system in SUPPORTED_SYSTEMS:
        jobs[f"JavaScript and sanity ({system})"] = "success"
        for python_version in SUPPORTED_PYTHONS:
            jobs[f"Python ({system}, {python_version})"] = "success"
            jobs[f"Package and update ({system}, {python_version})"] = "success"
    browser_labels = (
        "Linux Chrome and Firefox",
        "macOS Chrome and Firefox",
        "Windows Chrome and Firefox",
        "Windows Edge HTTPS",
    )
    for label in browser_labels:
        jobs[f"Browser smoke ({label})"] = "success"
        jobs[f"Browser soak ({label})"] = "success"
    assert len(jobs) == 25
    return jobs


def validate_jobs(jobs: list[dict[str, object]], *, is_tag: bool) -> None:
    names = [str(job["name"]) for job in jobs]
    duplicates = sorted(name for name, count in Counter(names).items() if count != 1)
    if duplicates:
        raise ReleaseError(f"Workflow returned duplicate jobs: {duplicates}")
    actual = {str(job["name"]): str(job["conclusion"]) for job in jobs}
    if is_tag:
        if "publish" not in actual:
            raise ReleaseError("Tag workflow did not create a publication job")
        publication = actual["publish"]
        del actual["publish"]
        if publication != "success" or any(conclusion != "skipped" for conclusion in actual.values()):
            raise ReleaseError(
                "Tag workflow must publish from the validated main artifact without rerunning checks: "
                f"publish={publication}; other jobs={actual}"
            )
        expected_skipped_prefixes = (
            "build", "Python (", "JavaScript and sanity (", "Package and update (",
            "Browser smoke (", "Browser soak (",
        )
        if len(actual) != len(expected_skipped_prefixes) or any(
            sum(name.startswith(prefix) for name in actual) != 1
            for prefix in expected_skipped_prefixes
        ):
            raise ReleaseError(f"Tag workflow did not skip exactly the six validation jobs: {actual}")
        return
    expected = expected_jobs(publish_conclusion="skipped")
    if actual != expected:
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        wrong = sorted(name for name in expected.keys() & actual.keys() if actual[name] != expected[name])
        raise ReleaseError(
            "Main release job matrix did not match the required 25 jobs. "
            f"Missing={missing}; extra={extra}; wrong conclusions="
            f"{[(name, actual[name], expected[name]) for name in wrong]}"
        )


def matching_runs(
    runs: list[dict[str, object]], *, commit: str, branch: str,
) -> list[dict[str, object]]:
    return [
        run for run in runs
        if run["head_sha"] == commit
        and run["head_branch"] == branch
        and run["event"] == "push"
        and run["name"] == WORKFLOW_NAME
        and run["path"] == f".github/workflows/{WORKFLOW}"
    ]


def select_run(runs: list[dict[str, object]], *, commit: str, branch: str) -> dict[str, object]:
    matching = matching_runs(runs, commit=commit, branch=branch)
    if not matching:
        raise ReleaseError(f"No {WORKFLOW_NAME} push run found for {branch} at {commit}")
    matching.sort(key=lambda run: int(run["id"]), reverse=True)
    return matching[0]


def artifact_hashes(archive: bytes, *, version: str) -> dict[str, str]:
    filenames = {
        f"metalist-{version}-py3-none-any.whl",
        f"metalist-{version}.tar.gz",
    }
    with zipfile.ZipFile(BytesIO(archive)) as bundle:
        names = bundle.namelist()
        if len(names) != len(set(names)) or set(names) != filenames:
            raise ReleaseError(f"Distribution artifact had unexpected files: {names}")
        return {
            name: hashlib.sha256(bundle.read(name)).hexdigest()
            for name in sorted(names)
        }


def pypi_hashes(payload: dict[str, object], *, version: str) -> dict[str, str]:
    info = payload["info"]
    assert isinstance(info, dict)
    if info["version"] != version:
        raise ReleaseError(f"PyPI returned a different version for {version}")
    urls = payload["urls"]
    assert isinstance(urls, list)
    filenames = [str(entry["filename"]) for entry in urls]
    if len(filenames) != len(set(filenames)):
        raise ReleaseError(f"PyPI returned duplicate distribution files: {filenames}")
    hashes = {
        str(entry["filename"]): str(entry["digests"]["sha256"])
        for entry in urls
    }
    expected_names = {
        f"metalist-{version}-py3-none-any.whl",
        f"metalist-{version}.tar.gz",
    }
    if set(hashes) != expected_names:
        raise ReleaseError(f"PyPI release had unexpected files: {sorted(hashes)}")
    return hashes


class GitHubClient:
    def __init__(self, *, username: str, password: str) -> None:
        assert username
        assert password
        self._authentication = (username, password)
        self._base_url = f"https://api.github.com/repos/{REPOSITORY}"
        self._headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "metalist-release-driver",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _request(self, path: str, *, parameters: dict[str, str]) -> requests.Response:
        response = requests.get(
            f"{self._base_url}/{path}",
            params=parameters,
            auth=self._authentication,
            headers=self._headers,
            timeout=30,
        )
        response.raise_for_status()
        return response

    def workflow_runs(self, *, branch: str) -> list[dict[str, object]]:
        response = self._request(
            f"actions/workflows/{WORKFLOW}/runs",
            parameters={"branch": branch, "event": "push", "per_page": "100"},
        )
        payload = response.json()
        runs = payload["workflow_runs"]
        assert isinstance(runs, list)
        return runs

    def jobs(self, *, run_id: int) -> list[dict[str, object]]:
        payload = self._request(
            f"actions/runs/{run_id}/jobs",
            parameters={"filter": "latest", "per_page": "100"},
        ).json()
        jobs = payload["jobs"]
        assert isinstance(jobs, list)
        if payload["total_count"] != len(jobs):
            raise ReleaseError("Release workflow unexpectedly exceeded one page of jobs")
        return jobs

    def artifact(self, *, run_id: int, name: str) -> dict[str, object]:
        payload = self._request(
            f"actions/runs/{run_id}/artifacts",
            parameters={"per_page": "100"},
        ).json()
        artifacts = [entry for entry in payload["artifacts"] if entry["name"] == name]
        if len(artifacts) != 1:
            raise ReleaseError(f"Expected one {name!r} artifact, found {len(artifacts)}")
        if artifacts[0]["expired"] is not False:
            raise ReleaseError(f"The {name!r} artifact has expired")
        return artifacts[0]

    def download_artifact(self, *, artifact_id: int) -> bytes:
        path = f"actions/artifacts/{artifact_id}/zip"
        response = requests.get(
            f"{self._base_url}/{path}",
            auth=self._authentication,
            headers=self._headers,
            allow_redirects=False,
            timeout=30,
        )
        response.raise_for_status()
        if response.status_code != HTTPStatus.FOUND:
            raise ReleaseError(f"GitHub artifact request returned HTTP {response.status_code}, expected 302")
        download = requests.get(response.headers["Location"], timeout=60)
        download.raise_for_status()
        return download.content


def github_credentials(root: Path) -> tuple[str, str]:
    if "GITHUB_TOKEN" in os.environ:
        token = os.environ["GITHUB_TOKEN"]
        if not token:
            raise ReleaseError("GITHUB_TOKEN is present but empty")
        return "x-access-token", token
    completed = run_command(
        ["git", "credential", "fill"],
        directory=root,
        stdin="protocol=https\nhost=github.com\n\n",
    )
    credentials = dict(
        line.split("=", 1)
        for line in completed.stdout.splitlines()
        if "=" in line
    )
    if "username" not in credentials or "password" not in credentials:
        raise ReleaseError("No GitHub credential found; configure git credentials or GITHUB_TOKEN")
    if not credentials["username"] or not credentials["password"]:
        raise ReleaseError("The configured GitHub credential is empty")
    return credentials["username"], credentials["password"]


def remote_tag_target(root: Path, tag: str) -> str:
    output = git_output(
        root,
        "ls-remote",
        "--tags",
        "origin",
        f"refs/tags/{tag}",
        f"refs/tags/{tag}^{{}}",
    )
    targets = {
        reference: sha
        for sha, reference in (line.split("\t", 1) for line in output.splitlines() if line)
    }
    # An annotated tag lists its commit as the peeled ^{} reference; a lightweight
    # tag points at it directly; a tag not on the remote yet has no target ("").
    for reference in (f"refs/tags/{tag}^{{}}", f"refs/tags/{tag}"):
        if reference in targets:
            return targets[reference]
    return ""


def local_tag_target(root: Path, tag: str) -> str:
    completed = run_command_allow_failure(
        ["git", "show-ref", "--verify", "--quiet", f"refs/tags/{tag}"],
        directory=root,
    )
    if completed.returncode == 1:
        return ""
    if completed.returncode != 0:
        detail = completed.stderr.strip()
        if not detail:
            detail = completed.stdout.strip()
        raise ReleaseError(f"Could not inspect local tag {tag}: {detail}")
    return git_output(root, "rev-parse", f"refs/tags/{tag}^{{commit}}")


def preflight(root: Path, *, version: str, console: Console) -> tuple[str, str, bool]:
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ReleaseError("Version must use X.Y.Z format")
    if git_output(root, "status", "--porcelain"):
        raise ReleaseError("The repository must be clean before release")
    if git_output(root, "branch", "--show-current") != "main":
        raise ReleaseError("Releases must run from the main branch")
    remote = git_output(root, "remote", "get-url", "origin")
    if not re.search(r"(?:github\.com[:/])evolvingstuff/metalist(?:\.git)?$", remote):
        raise ReleaseError(f"origin does not point to {REPOSITORY}: {remote}")
    console.print("[cyan]Fetching current main and release tags…[/cyan]")
    run_command(
        ["git", "fetch", "--prune", "--tags", "origin", "main"], directory=root, stdin="",
    )
    commit = git_output(root, "rev-parse", "HEAD")
    if commit != git_output(root, "rev-parse", "origin/main"):
        raise ReleaseError("Local main and origin/main must resolve to the same commit")
    if read_version(root) != version:
        raise ReleaseError(f"app/version.py does not declare requested version {version}")
    tag = f"v{version}"
    local_target = local_tag_target(root, tag)
    remote_target = remote_tag_target(root, tag)
    if local_target and local_target != commit:
        raise ReleaseError(f"Local {tag} points to {local_target}, expected {commit}")
    if remote_target and remote_target != commit:
        raise ReleaseError(f"Remote {tag} points to {remote_target}, expected {commit}")
    if remote_target and not local_target:
        run_command(
            ["git", "fetch", "origin", f"refs/tags/{tag}:refs/tags/{tag}"],
            directory=root,
            stdin="",
        )
        assert local_tag_target(root, tag) == commit
    return commit, tag, bool(remote_target)


def workflow_summary(jobs: list[dict[str, object]]) -> str:
    counts = Counter(str(job["status"]) for job in jobs)
    successful = sum(job["conclusion"] == "success" for job in jobs)
    return (
        f"{successful} passed · {counts['in_progress']} running · "
        f"{counts['queued']} queued · {len(jobs)} created"
    )


def wait_for_workflow(
    client: GitHubClient,
    *,
    commit: str,
    branch: str,
    is_tag: bool,
    console: Console,
) -> dict[str, object]:
    deadline = time.monotonic() + WORKFLOW_TIMEOUT_SECONDS
    label = "exact main validation"
    if is_tag:
        label = "tag publication"
    with Progress(
        SpinnerColumn(), TextColumn("{task.description}"), TimeElapsedColumn(), console=console
    ) as progress:
        task = progress.add_task(f"Waiting for {label}", total=None)
        while time.monotonic() < deadline:
            runs = matching_runs(client.workflow_runs(branch=branch), commit=commit, branch=branch)
            if not runs:
                progress.update(task, description=f"Waiting for {label} to appear")
                time.sleep(POLL_SECONDS)
                continue
            runs.sort(key=lambda run: int(run["id"]), reverse=True)
            run = runs[0]
            jobs = client.jobs(run_id=int(run["id"]))
            progress.update(task, description=f"{label.capitalize()}: {workflow_summary(jobs)}")
            if run["status"] == "completed":
                if run["conclusion"] != "success":
                    failures = [
                        (job["name"], job["conclusion"])
                        for job in jobs
                        if job["conclusion"] not in {"success", "skipped"}
                    ]
                    raise ReleaseError(f"{label.capitalize()} failed: {failures}")
                if not is_tag and run["run_attempt"] != 1:
                    raise ReleaseError("Main validation was rerun; create a new candidate commit")
                validate_jobs(jobs, is_tag=is_tag)
                return run
            time.sleep(POLL_SECONDS)
    raise ReleaseError(f"Timed out waiting for {label}")


def ensure_remote_tag(root: Path, *, tag: str, commit: str, already_remote: bool, console: Console) -> None:
    if already_remote:
        console.print(f"[cyan]Resuming existing remote tag {tag} at {commit[:12]}[/cyan]")
        return
    if not local_tag_target(root, tag):
        run_command(
            ["git", "tag", "-a", tag, "-m", f"MetaList {tag.removeprefix('v')}", commit],
            directory=root,
            stdin="",
        )
    assert local_tag_target(root, tag) == commit
    console.print(f"[cyan]Pushing {tag} at {commit[:12]}…[/cyan]")
    run_command(["git", "push", "origin", f"refs/tags/{tag}"], directory=root, stdin="")
    if remote_tag_target(root, tag) != commit:
        raise ReleaseError(f"Remote {tag} did not resolve to {commit} after push")


def wait_for_pypi(*, version: str, console: Console) -> dict[str, object]:
    deadline = time.monotonic() + PYPI_TIMEOUT_SECONDS
    url = f"https://pypi.org/pypi/metalist/{version}/json"
    with Progress(
        SpinnerColumn(), TextColumn("{task.description}"), TimeElapsedColumn(), console=console
    ) as progress:
        progress.add_task(f"Waiting for metalist {version} on PyPI", total=None)
        while time.monotonic() < deadline:
            response = requests.get(url, timeout=30)
            if response.status_code == HTTPStatus.OK:
                payload = response.json()
                assert isinstance(payload, dict)
                return payload
            if response.status_code != HTTPStatus.NOT_FOUND:
                raise ReleaseError(f"PyPI returned HTTP {response.status_code} for {version}")
            time.sleep(POLL_SECONDS)
    raise ReleaseError(f"Timed out waiting for metalist {version} on PyPI")


# PyPI serves the simple index as HTML and as JSON, cached separately; pip asks
# for JSON with this header (pip/_internal/index/collector.py). Waiting on the
# HTML page let 0.15.0's clean install run while pip still got an index without
# the release, so the wait reads the index exactly as pip does.
PIP_SIMPLE_INDEX_ACCEPT = (
    "application/vnd.pypi.simple.v1+json, application/vnd.pypi.simple.v1+html; q=0.1, text/html; q=0.01"
)
PIP_SIMPLE_INDEX_JSON_TYPE = "application/vnd.pypi.simple.v1+json"


def pip_index_lists(filename: str) -> bool:
    response = requests.get(
        "https://pypi.org/simple/metalist/",
        headers={"Accept": PIP_SIMPLE_INDEX_ACCEPT},
        timeout=30,
    )
    response.raise_for_status()
    content_type = response.headers["Content-Type"]
    if not content_type.startswith(PIP_SIMPLE_INDEX_JSON_TYPE):
        raise ReleaseError(f"PyPI answered pip's index request with {content_type}, not the JSON simple index")
    files = response.json()["files"]
    return any(entry["filename"] == filename for entry in files)


def wait_for_pypi_install_index(*, version: str, console: Console) -> None:
    deadline = time.monotonic() + PYPI_TIMEOUT_SECONDS
    filename = f"metalist-{version}-py3-none-any.whl"
    with Progress(
        SpinnerColumn(), TextColumn("{task.description}"), TimeElapsedColumn(), console=console
    ) as progress:
        progress.add_task(f"Waiting for metalist {version} in the PyPI install index", total=None)
        while time.monotonic() < deadline:
            if pip_index_lists(filename):
                return
            time.sleep(POLL_SECONDS)
    raise ReleaseError(f"Timed out waiting for metalist {version} in the PyPI install index")


def command_to_log(command: list[str], *, directory: Path, log_path: Path) -> None:
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"\n$ {' '.join(command)}\n")
        log.flush()
        completed = subprocess.run(
            command,
            cwd=directory,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=dict(os.environ, PIP_CONFIG_FILE=os.devnull),
        )
    if completed.returncode != 0:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        tail = "\n".join(lines[-60:])
        raise ReleaseError(f"Installed-package verification failed. Log: {log_path}\n{tail}")


def verify_clean_install(root: Path, *, version: str, run_id: int, console: Console) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = root / "logs/releases" / f"{timestamp}-{version}-{run_id}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"metalist-pypi-{version}-") as temporary_name:
        temporary = Path(temporary_name)
        environment = temporary / "environment"
        with console.status("[cyan]Creating clean verification environment[/cyan]"):
            venv.EnvBuilder(with_pip=True).create(environment)
        scripts = environment / ("Scripts" if os.name == "nt" else "bin")
        python = scripts / ("python.exe" if os.name == "nt" else "python")
        commands = [
            [
                str(python), "-m", "pip", "--isolated", "install", "--no-cache-dir",
                "--index-url", "https://pypi.org/simple", f"metalist=={version}",
            ],
            [str(python), "-m", "pip", "--isolated", "check"],
            [
                str(python), "-I", "-c",
                f"import importlib.metadata as m; assert m.version('metalist') == '{version}'",
            ],
            [
                str(python), "-I", str(root / "scripts/smoke_installed_package.py"),
                "--browser-cold-runs", "1", "--browser-reloads", "1",
            ],
        ]
        descriptions = (
            "Installing the public PyPI release",
            "Checking installed dependencies",
            "Checking installed version identity",
            "Running real HTTP/HTTPS installed-package smoke",
        )
        for description, command in zip(descriptions, commands, strict=True):
            with console.status(f"[cyan]{description}[/cyan]"):
                command_to_log(command, directory=temporary, log_path=log_path)
    return log_path


def release(version: str, *, console: Console) -> None:
    root = Path(__file__).resolve().parents[1]
    commit, tag, already_remote = preflight(root, version=version, console=console)
    username, password = github_credentials(root)
    client = GitHubClient(username=username, password=password)
    main_run = wait_for_workflow(
        client, commit=commit, branch="main", is_tag=False, console=console,
    )
    console.print(f"[green]✓[/green] Exact main matrix passed: {main_run['html_url']}")
    artifact = client.artifact(run_id=int(main_run["id"]), name="pypi-distributions")
    archive = client.download_artifact(artifact_id=int(artifact["id"]))
    ci_hashes = artifact_hashes(archive, version=version)
    console.print("[green]✓[/green] Exact main distribution artifact is available")
    ensure_remote_tag(
        root, tag=tag, commit=commit, already_remote=already_remote, console=console,
    )
    tag_run = wait_for_workflow(
        client, commit=commit, branch=tag, is_tag=True, console=console,
    )
    console.print(f"[green]✓[/green] Tag publication passed: {tag_run['html_url']}")
    pypi_payload = wait_for_pypi(version=version, console=console)
    public_hashes = pypi_hashes(pypi_payload, version=version)
    if ci_hashes != public_hashes:
        raise ReleaseError(
            f"PyPI files differ from the tested GitHub artifact: CI={ci_hashes}; PyPI={public_hashes}"
        )
    console.print("[green]✓[/green] PyPI wheel and source distribution match tested CI artifacts")
    wait_for_pypi_install_index(version=version, console=console)
    log_path = verify_clean_install(
        root, version=version, run_id=int(tag_run["id"]), console=console,
    )
    console.print(
        Panel.fit(
            f"[bold green]MetaList {version} released and verified[/bold green]\n"
            f"Commit: {commit}\n"
            f"Workflow: {tag_run['html_url']}\n"
            f"PyPI: https://pypi.org/project/metalist/{version}/\n"
            f"Verification log: {log_path}",
            title="Release complete",
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate, tag, publish, and verify one MetaList release without an LLM.",
    )
    parser.add_argument("version", help="Release version in X.Y.Z form; must match app/version.py")
    arguments = parser.parse_args()
    console = Console()
    original_exception_hook = sys.excepthook

    def render_uncaught_error(exception_type, error, traceback) -> None:
        if isinstance(error, ReleaseError):
            console.print(Panel.fit(str(error), title="Release stopped", border_style="red"))
        else:
            original_exception_hook(exception_type, error, traceback)

    sys.excepthook = render_uncaught_error
    release(arguments.version, console=console)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
