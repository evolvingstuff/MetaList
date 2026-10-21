"""Type-check the app with mypy against a baseline of known errors.

    python scripts/check_types.py check    # fails on any error not in the baseline,
                                           # and on any baseline entry that is now fixed
    python scripts/check_types.py update   # rewrites the baseline from the current errors

The baseline (scripts/mypy-baseline.txt) lists each known error once per occurrence,
without line numbers, so editing a file does not move its entries. New errors fail the
check; fixing one fails it too until the baseline is updated, so it only ever shrinks.
mypy checks as Linux on Python 3.11 on every OS ([tool.mypy] in pyproject.toml), so all
platforms compare against the same list.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path
import re
import subprocess
import sys

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_BASELINE_PATH = _PROJECT_ROOT / "scripts" / "mypy-baseline.txt"
_CHECKED_PATHS = ("app", "main.py", "serve_namespace.py")
_ERROR_LINE = re.compile(r"^(?P<path>[^:\n]+):(?P<line>\d+): error: (?P<message>.*)$")
_BASELINE_HEADER = "# Known mypy errors, one line per occurrence (scripts/check_types.py).\n"
_USAGE = "Usage: python scripts/check_types.py check|update"
# The script itself and its one command.
_EXPECTED_ARGV_LENGTH = 2
# mypy exits 0 with no errors and 1 with errors; anything else means it could not run.
_MYPY_FOUND_ERRORS = 1


def _current_errors() -> list[str]:
    result = subprocess.run(
        [sys.executable, "-m", "mypy", *_CHECKED_PATHS],
        cwd=_PROJECT_ROOT, capture_output=True, text=True, check=False,
    )
    if result.returncode not in (0, _MYPY_FOUND_ERRORS):
        raise RuntimeError(f"mypy could not run (exit {result.returncode}):\n{result.stdout}{result.stderr}")
    errors = []
    for line in result.stdout.splitlines():
        match = _ERROR_LINE.match(line)
        if match is None:
            continue
        path = match.group("path").replace("\\", "/")
        errors.append(f"{path}: {match.group('message')}")
    if result.returncode == _MYPY_FOUND_ERRORS and not errors:
        raise RuntimeError(f"mypy reported errors in a form this script does not read:\n{result.stdout}")
    return sorted(errors)


def _baseline() -> list[str]:
    return sorted(line for line in _BASELINE_PATH.read_text(encoding="utf-8").splitlines() if line and not line.startswith("#"))


def check() -> None:
    current, known = Counter(_current_errors()), Counter(_baseline())
    new = current - known
    fixed = known - current
    for entry in sorted(new.elements()):
        print(f"new: {entry}")
    for entry in sorted(fixed.elements()):
        print(f"fixed: {entry}")
    if new:
        raise SystemExit(f"{sum(new.values())} new type error(s); fix them (the baseline is for errors that predate it)")
    if fixed:
        raise SystemExit(f"{sum(fixed.values())} baseline error(s) are fixed; run `python scripts/check_types.py update`")
    print(f"Type check passed: {sum(current.values())} known error(s), none new")


def update() -> None:
    errors = _current_errors()
    _BASELINE_PATH.write_text(_BASELINE_HEADER + "".join(f"{entry}\n" for entry in errors), encoding="utf-8")
    print(f"Baseline written: {len(errors)} error(s)")


if __name__ == "__main__":
    if len(sys.argv) != _EXPECTED_ARGV_LENGTH or sys.argv[1] not in ("check", "update"):
        raise SystemExit(_USAGE)
    if sys.argv[1] == "check":
        check()
    else:
        update()
