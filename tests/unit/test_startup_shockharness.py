"""ShockHarness at development startup (app/startup_shockharness.py): an overview
of the strict policy's findings and the full JSON report, never a gate."""

from __future__ import annotations

import importlib.metadata
import json
from pathlib import Path

import pytest

from app import startup_shockharness
from app.startup_shockharness import SHOCKHARNESS_INSTALL_HINT
from app.startup_shockharness import SHOCKHARNESS_REPORT_RELATIVE_PATH
from app.startup_shockharness import ShockHarnessOverview
from app.startup_shockharness import collect_shockharness_overview
from app.startup_shockharness import is_shockharness_installed
from app.startup_shockharness import overview_lines
from app.startup_shockharness import shockharness_report_lines


# The analyzer runs on Python 3.11+ only (pyproject's dev extra carries that
# marker), so a 3.10 interpreter cannot have it: the overview tests run where
# the tool is installed, the "not installed" path everywhere.
_NEEDS_THE_ANALYZER = pytest.mark.skipif(
    not is_shockharness_installed(),
    reason="ShockHarness (the dev extra, Python 3.11+) is not installed",
)


def _repository(root: Path, *, config: str, sources: dict[str, str]) -> Path:
    (root / ".shockharness.toml").write_text(config, encoding="utf-8")
    for relative_path, text in sources.items():
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return root


_STRICT = '[tool.shockharness]\nprofile = "strict"\ninclude = ["src/**/*.py"]\n'


def test_without_the_tool_startup_says_how_to_install_it_and_goes_on(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(startup_shockharness.importlib.util, "find_spec", lambda name: None)
    assert shockharness_report_lines(tmp_path) == (f"not installed: {SHOCKHARNESS_INSTALL_HINT}", ())
    assert "shockharness==0.6.0" in SHOCKHARNESS_INSTALL_HINT and "3.11" in SHOCKHARNESS_INSTALL_HINT


@_NEEDS_THE_ANALYZER
def test_the_overview_counts_the_findings_and_writes_the_full_report(tmp_path: Path) -> None:
    root = _repository(tmp_path, config=_STRICT, sources={
        "src/ok.py": "def f(x=3):\n    return x + 2\n",
        "src/bad.py": "def broken(:\n",
    })
    overview = collect_shockharness_overview(root)
    assert (overview.files, overview.files_failed) == (2, 1)
    assert dict(overview.findings_by_severity) == {"error": 3, "review": 0, "warning": 0}
    assert overview.findings_by_rule == (("MAGIC001", 2), ("DEF001", 1)), "a default and two magic numbers"
    assert overview.complexity_by_rule == () and overview.import_cycles == 0
    assert overview.top_files == (("src/ok.py", 3),)
    assert overview.elapsed_seconds >= 0.0 and overview.tool_version == importlib.metadata.version("shockharness")
    # The first run fills the cache; the next reuses every unchanged file.
    assert (overview.cache_status, overview.cache_hits, overview.cache_misses) == ("enabled", 0, 2), "a parse failure is cached too"
    again = collect_shockharness_overview(root)
    assert (again.cache_hits, again.cache_misses) == (2, 0)
    assert (again.findings_by_rule, again.top_files) == (overview.findings_by_rule, overview.top_files), "a cached run reports the same"
    assert (root / ".shockharness-cache").is_dir()
    report = json.loads((root / SHOCKHARNESS_REPORT_RELATIVE_PATH).read_text(encoding="utf-8"))
    assert report["analysis_status"] == "failed" and len(report["findings"]) == 3, "the whole report, for reading later"
    assert SHOCKHARNESS_REPORT_RELATIVE_PATH.parts[0] == "logs", "under the ignored logs/ directory"


@_NEEDS_THE_ANALYZER
def test_suppressed_findings_are_counted_apart_from_open_ones(tmp_path: Path) -> None:
    root = _repository(tmp_path, config=_STRICT, sources={
        "src/ok.py": 'def f(x=3):  # shockharness: ignore[DEF001] reason="a fixture default"\n    return x + 2\n',
    })
    overview = collect_shockharness_overview(root)
    assert dict(overview.findings_by_severity) == {"error": 2, "review": 0, "warning": 0}, "only the open ones"
    assert overview.findings_by_rule == (("MAGIC001", 2),)
    assert overview.top_files == (("src/ok.py", 2),)
    assert overview.suppressed == 1
    assert overview_lines(overview)[0].startswith("1 files · 2 errors · 0 review · 0 warnings · 1 suppressed · ")


@_NEEDS_THE_ANALYZER
def test_a_broken_configuration_is_reported_not_raised(tmp_path: Path) -> None:
    root = _repository(tmp_path, config='[tool.shockharness]\nprofile = "strict"\nno_such_key = 1\n', sources={})
    headline, lines = shockharness_report_lines(root)
    assert headline.startswith("could not run: ") and "no_such_key" in headline
    assert lines == ()


def test_the_overview_lines_name_the_counts_the_rules_and_the_files() -> None:
    overview = ShockHarnessOverview(
        tool_version="0.2.0", files=906, files_failed=0,
        findings_by_severity=(("error", 7028), ("review", 236), ("warning", 1341)), suppressed=0,
        findings_by_rule=(("MAGIC001", 6486), ("DEF002", 385), ("EXC001", 150)),
        complexity_by_rule=(("CPLX004", 599), ("CPLX002", 371)),
        import_cycles=3,
        top_files=(("tests/unit/test_namespace_switcher.py", 177), ("app/a.js", 109)),
        elapsed_seconds=12.52, cache_status="enabled", cache_hits=0, cache_misses=906,
    )
    assert overview_lines(overview) == (
        "906 files · 7,028 errors · 236 review · 1,341 warnings · logs/shockharness/latest.json",
        (
            "rules: MAGIC001 6,486 · DEF002 385 · EXC001 150",
            "complexity (advisory): CPLX004 599 · CPLX002 371 · 3 import cycles",
            "most findings: tests/unit/test_namespace_switcher.py 177 · app/a.js 109",
            "time: 12.5s (cache cold: 906 files analyzed)",
        ),
    )
    # The time line says what the cache did: a warm run, a partly changed tree, no cache.
    from dataclasses import replace
    assert overview_lines(replace(overview, elapsed_seconds=2.3, cache_hits=906, cache_misses=0))[1][-1] == "time: 2.3s (cache: all 906 files unchanged)"
    assert overview_lines(replace(overview, cache_hits=900, cache_misses=6))[1][-1] == "time: 12.5s (cache: 900 files unchanged, 6 analyzed)"
    assert overview_lines(replace(overview, cache_status="disabled"))[1][-1] == "time: 12.5s (cache disabled)"
    parse_failures = ShockHarnessOverview(
        tool_version="0.3.0", files=2, files_failed=1,
        findings_by_severity=(("error", 0), ("review", 0), ("warning", 0)), suppressed=0,
        findings_by_rule=(), complexity_by_rule=(), import_cycles=0, top_files=(), elapsed_seconds=0.0,
        cache_status="enabled", cache_hits=0, cache_misses=1,
    )
    assert overview_lines(parse_failures) == (
        "2 files · 0 errors · 0 review · 0 warnings · logs/shockharness/latest.json · 1 could not be parsed",
        ("time: 0.0s (cache cold: 1 files analyzed)",),
    )
