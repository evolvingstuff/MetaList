"""Run the full checks in the order that is fastest and safe on one machine: the browser suite
first and alone (it fills 8 cores; anything beside it times its runs out), then every other
check at once. COMMIT FEATURE runs them without the browser suite, which runs before a push
(AGENTS.md, "COMMIT FEATURE" and "Before pushing main").

    .venv/bin/python scripts/full_checks.py --no-browser   # COMMIT FEATURE, against main
    .venv/bin/python scripts/full_checks.py                # everything
    .venv/bin/python scripts/full_checks.py --base v0.22.0

The ShockHarness gate and the Windows-style clone read commits, so the working tree must be
clean: commit first. Each check writes its whole output to logs/checks/<time>/<check>.log;
the summary gives each one's result, time and last line. Exit status 1 when any check fails.

Python versions: the local .venv, plus one environment per supported version in
.venv-py<version> (created with uv on first use, then kept in sync with requirements/ci.txt).
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# The release matrix's endpoints (scripts/release.py SUPPORTED_PYTHONS; a unit test keeps them equal).
SUPPORTED_PYTHONS = ("3.11", "3.14")
LOCAL_PYTHON = ROOT / ".venv" / "bin" / "python"
CI_REQUIREMENTS = ROOT / "requirements" / "ci.txt"
SANITY_CODE = (
    "from pathlib import Path; "
    "from app.startup_sanity import assert_startup_sanity; "
    "from app.startup_js_sanity import assert_startup_js_sanity; "
    "assert_startup_sanity(Path.cwd()); assert_startup_js_sanity(Path.cwd())"
)
# The checks after the browser suite run at once: about one process each, on 8 cores.
PARALLEL_CHECKS = 8
SUMMARY_NAME_WIDTH = 24
RESULT_WORDS = {True: "PASS", False: "FAIL"}


@dataclass(frozen=True)
class Command:
    arguments: tuple[str, ...]
    cwd: Path


@dataclass(frozen=True)
class Check:
    name: str
    # Run one after another; the check fails at the first that fails.
    commands: tuple[Command, ...]
    # The summary is the last output line starting with this ("" for the last line). A
    # failing check that never printed one shows its last line, the error.
    summary_prefix: str


@dataclass(frozen=True)
class Outcome:
    name: str
    passed: bool
    seconds: float
    last_line: str
    log: Path


def _run(check: Check, log_directory: Path) -> Outcome:
    log = log_directory / f"{check.name}.log"
    started = time.monotonic()
    failed_exit = 0
    with log.open("w", encoding="utf-8") as stream:
        for command in check.commands:
            stream.write(f"$ {' '.join(command.arguments)}\n")
            stream.flush()
            completed = subprocess.run(command.arguments, cwd=command.cwd, stdout=stream, stderr=subprocess.STDOUT, check=False)
            if completed.returncode != 0:
                failed_exit = completed.returncode
                break
    lines = [line for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert lines, f"{check.name} wrote no output"
    summaries = [line for line in lines if line.startswith(check.summary_prefix)]
    seconds = time.monotonic() - started
    if failed_exit == 0:
        assert summaries, f"{check.name} passed without a line starting with {check.summary_prefix!r}"
        return Outcome(name=check.name, passed=True, seconds=seconds, last_line=summaries[-1], log=log)
    if not summaries:
        summaries = lines
    return Outcome(name=check.name, passed=False, seconds=seconds, last_line=f"exit {failed_exit}: {summaries[-1]}", log=log)


def _python_environment(version: str) -> Path:
    return ROOT / f".venv-py{version.replace('.', '')}"


def _pytest(python: Path, cwd: Path) -> Command:
    return Command((str(python), "-m", "pytest", "-q", "tests/unit", "-p", "no:cacheprovider"), cwd)


def _supported_python_check(version: str) -> Check:
    environment = _python_environment(version)
    python = environment / "bin" / "python"
    prepare: list[Command] = []
    if not python.exists():
        prepare.append(Command(("uv", "venv", "--python", version, str(environment)), ROOT))
    # Exactly the CI dependencies, so a package only the local .venv has cannot hide a failure.
    prepare.append(Command(("uv", "pip", "sync", "--python", str(python), str(CI_REQUIREMENTS)), ROOT))
    return Check(f"pytest-{version}", (*prepare, _pytest(python, ROOT)), "")


def _windows_clone_check(branch: str, scratch: Path) -> Check:
    # Windows runners check out with core.autocrlf=true (AGENTS.md, "Windows Line Endings").
    clone = scratch / "crlf-clone"
    return Check("pytest-windows-clone", (
        Command(("git", "-c", "core.autocrlf=true", "clone", "-q", "--branch", branch, str(ROOT), str(clone)), scratch),
        _pytest(LOCAL_PYTHON, clone),
    ), "")


def _checks_after_browser(*, base: str, branch: str, scratch: Path) -> list[Check]:
    local = sys.executable
    return [
        Check("pytest-local", (_pytest(LOCAL_PYTHON, ROOT),), ""),
        *(_supported_python_check(version) for version in SUPPORTED_PYTHONS),
        _windows_clone_check(branch, scratch),
        Check("js-unit", (Command(("npm", "test"), ROOT),), "ℹ pass"),
        Check("types", (Command((local, "scripts/check_types.py", "check"), ROOT),), ""),
        Check("supply-chain", (Command((local, "scripts/check_supply_chain.py", "check"), ROOT),), ""),
        Check("startup-sanity", (Command((local, "-c", SANITY_CODE), ROOT),), ""),
        Check("shockharness-gate", (
            Command((str(ROOT / ".venv" / "bin" / "shockharness"), "gate", "--base", base, "--head", "HEAD"), ROOT),
        ), "gate:"),
    ]


def _git(*arguments: str) -> str:
    return subprocess.run(("git", *arguments), cwd=ROOT, capture_output=True, encoding="utf-8", check=True).stdout.strip()


def _print_summary(outcomes: list[Outcome]) -> None:
    print()
    for outcome in outcomes:
        print(f"{RESULT_WORDS[outcome.passed]}  {outcome.name:{SUMMARY_NAME_WIDTH}} {outcome.seconds:6.1f}s  {outcome.last_line}")
    for outcome in outcomes:
        if not outcome.passed:
            print(f"      {outcome.name}: {outcome.log}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", default="main", help="revision the ShockHarness gate compares against")
    parser.add_argument("--no-browser", action="store_true",
                        help="skip the browser suite (COMMIT FEATURE; the whole browser suite runs before a push)")
    options = parser.parse_args()

    if _git("status", "--porcelain"):
        print("Uncommitted changes: commit first. The ShockHarness gate and the Windows clone read commits only.")
        return 1
    branch = _git("branch", "--show-current")
    assert branch, "a branch must be checked out (not a detached HEAD)"
    log_directory = ROOT / "logs" / "checks" / datetime.now().strftime("%Y%m%dT%H%M%S")
    log_directory.mkdir(parents=True, exist_ok=False)
    print(f"Checking {branch} at {_git('rev-parse', '--short', 'HEAD')} against {options.base}; logs in {log_directory}")

    started = time.monotonic()
    outcomes: list[Outcome] = []
    if not options.no_browser:
        print("Browser suite (alone)...", flush=True)
        outcomes.append(_run(Check("browser", (Command(("npm", "run", "test:browser:all"), ROOT),), ""), log_directory))
        print(f"  {RESULT_WORDS[outcomes[-1].passed]} in {outcomes[-1].seconds:.0f}s", flush=True)

    with tempfile.TemporaryDirectory(prefix="metalist-checks-") as scratch:
        checks = _checks_after_browser(base=options.base, branch=branch, scratch=Path(scratch))
        print(f"{len(checks)} checks at once...", flush=True)
        with ThreadPoolExecutor(max_workers=PARALLEL_CHECKS) as pool:
            outcomes.extend(pool.map(lambda check: _run(check, log_directory), checks))

    _print_summary(outcomes)
    failed = [outcome.name for outcome in outcomes if not outcome.passed]
    print(f"\n{len(outcomes) - len(failed)} of {len(outcomes)} passed in {time.monotonic() - started:.0f}s")
    if failed:
        print(f"Failed: {', '.join(failed)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
