"""ShockHarness at development startup: a report, never a gate (docs/testing/harness.md).

ShockHarness (the dev extra in pyproject.toml; it runs on Python 3.11+) is a
strict static-analysis policy for Python and JavaScript: exception
transparency, no implicit defaults, no magic numbers, plus advisory
complexity. MetaList's own startup sanity gates stay as they are. This step
runs the analyzer over the repository as `.shockharness.toml` scopes it, prints
an overview of what it finds, and writes the full report as JSON under logs/,
so the policy can be assessed before any of it is allowed to fail startup.
Without the tool installed, startup says how to install it and goes on; when
the analyzer itself cannot run (a bad configuration file), startup says why
and goes on.
"""

from __future__ import annotations

import importlib.util
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from app.services.exception_capture import CapturedExceptionContext


SHOCKHARNESS_REQUIREMENT = "shockharness==0.11.0"
SHOCKHARNESS_INSTALL_HINT = f'.venv/bin/pip install "{SHOCKHARNESS_REQUIREMENT}" (needs Python 3.11+)'
SHOCKHARNESS_REPORT_RELATIVE_PATH = Path("logs") / "shockharness" / "latest.json"
# The overview names the rules and files with the most findings, this many of each.
_TOP_RULES = 8
_TOP_FILES = 5


@dataclass(frozen=True, slots=True)
class ShockHarnessOverview:
    tool_version: str
    files: int
    files_failed: int
    # Open findings (not suppressed): error / review / warning, as the report classes them.
    findings_by_severity: tuple[tuple[str, int], ...]
    # Findings an inline suppression silences, with its reason; counted apart.
    suppressed: int
    # Policy rules (MAGIC, EXC, DEF, SUPP), most findings first.
    findings_by_rule: tuple[tuple[str, int], ...]
    # Advisory complexity rules (CPLX), most findings first.
    complexity_by_rule: tuple[tuple[str, int], ...]
    import_cycles: int
    # Files with the most policy findings.
    top_files: tuple[tuple[str, int], ...]
    elapsed_seconds: float
    # The per-file cache: enabled, disabled or bypassed; files reused and analyzed.
    cache_status: str
    cache_hits: int
    cache_misses: int


def is_shockharness_installed() -> bool:
    return importlib.util.find_spec("shockharness") is not None


def collect_shockharness_overview(repo_root: Path) -> ShockHarnessOverview:
    """Analyze the repository and write the full JSON report; the counts for the console."""
    assert is_shockharness_installed(), "ShockHarness must be installed to collect its overview"
    # A development tool for Python 3.11+: imported here, not at the top, so a
    # checkout without it (Python 3.10, or not yet installed) still starts.
    from shockharness import analyze_paths
    from shockharness.analysis import AnalysisOptions
    from shockharness.analysis import CACHE_CONFIGURED
    from shockharness.config import load_config
    from shockharness.output.json import render as render_json

    started = time.monotonic()
    config = load_config(repo_root, None)
    # The cache under .shockharness-cache/ (ignored by git) makes a run after the
    # first skip every unchanged file; .shockharness.toml configures it.
    report = analyze_paths([repo_root], repo_root, config, AnalysisOptions(inline_suppressions=True, cache=CACHE_CONFIGURED))
    elapsed_seconds = time.monotonic() - started
    report_path = repo_root / SHOCKHARNESS_REPORT_RELATIVE_PATH
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(render_json(report), encoding="utf-8")

    by_severity: Counter[str] = Counter()
    by_rule: Counter[str] = Counter()
    by_file: Counter[str] = Counter()
    suppressed = 0
    for finding in report.findings:
        if finding.is_suppressed:
            suppressed += 1
            continue
        by_severity[finding.severity] += 1
        by_rule[finding.rule_id] += 1
        if not finding.rule_id.startswith("CPLX"):
            by_file[finding.path] += 1
    files_failed = 0
    for file_result in report.files:
        if file_result.status != "analyzed":
            files_failed += 1
    return ShockHarnessOverview(
        tool_version=report.tool_version,
        files=len(report.files),
        files_failed=files_failed,
        findings_by_severity=tuple((severity, by_severity[severity]) for severity in ("error", "review", "warning")),
        suppressed=suppressed,
        findings_by_rule=tuple((rule, count) for rule, count in by_rule.most_common() if not rule.startswith("CPLX")),
        complexity_by_rule=tuple((rule, count) for rule, count in by_rule.most_common() if rule.startswith("CPLX")),
        import_cycles=len(report.metrics["graph"]["cycles"]),
        top_files=tuple(by_file.most_common(_TOP_FILES)),
        elapsed_seconds=elapsed_seconds,
        cache_status=report.coverage["cache"]["status"],
        cache_hits=report.coverage["cache"]["hits"],
        cache_misses=report.coverage["cache"]["misses"],
    )


def _counts_text(counts: tuple[tuple[str, int], ...], limit: int) -> str:
    return " · ".join(f"{name} {count:,}" for name, count in counts[:limit])


def overview_lines(overview: ShockHarnessOverview) -> tuple[str, tuple[str, ...]]:
    """The console's headline and detail lines for an overview."""
    severities = dict(overview.findings_by_severity)
    headline = (
        f"{overview.files:,} files · {severities['error']:,} errors · {severities['review']:,} review"
        f" · {severities['warning']:,} warnings"
    )
    if overview.suppressed > 0:
        headline = f"{headline} · {overview.suppressed:,} suppressed"
    headline = f"{headline} · {SHOCKHARNESS_REPORT_RELATIVE_PATH.as_posix()}"
    if overview.files_failed > 0:
        headline = f"{headline} · {overview.files_failed:,} could not be parsed"
    lines = []
    if overview.findings_by_rule:
        lines.append(f"rules: {_counts_text(overview.findings_by_rule, _TOP_RULES)}")
    complexity = _counts_text(overview.complexity_by_rule, _TOP_RULES)
    if overview.import_cycles > 0:
        complexity = f"{complexity} · {overview.import_cycles:,} import cycles"
    if complexity != "":
        lines.append(f"complexity (advisory): {complexity}")
    if overview.top_files:
        lines.append(f"most findings: {_counts_text(overview.top_files, _TOP_FILES)}")
    lines.append(f"time: {overview.elapsed_seconds:.1f}s ({_cache_text(overview)})")
    return headline, tuple(lines)


def _cache_text(overview: ShockHarnessOverview) -> str:
    """How much the per-file cache saved: what was reused, what had to be analyzed."""
    if overview.cache_status != "enabled":
        return f"cache {overview.cache_status}"
    if overview.cache_misses == 0:
        return f"cache: all {overview.cache_hits:,} files unchanged"
    if overview.cache_hits == 0:
        return f"cache cold: {overview.cache_misses:,} files analyzed"
    return f"cache: {overview.cache_hits:,} files unchanged, {overview.cache_misses:,} analyzed"


def shockharness_report_lines(repo_root: Path) -> tuple[str, tuple[str, ...]]:
    """What startup prints: the overview, or why there is none. Never raises for the tool's own reasons."""
    if not is_shockharness_installed():
        return f"not installed: {SHOCKHARNESS_INSTALL_HINT}", ()
    # The analyzer's own failures (a bad .shockharness.toml) are reported, not
    # startup failures: this step is an assessment of the policy, not a gate.
    from shockharness.errors import ShockHarnessError

    analysis_capture = CapturedExceptionContext(
        ShockHarnessError, boundary="app/startup_shockharness.py:shockharness_report_lines:analysis_capture",
    )
    overview: ShockHarnessOverview | None = None
    with analysis_capture:
        overview = collect_shockharness_overview(repo_root)
    if analysis_capture.captured_exception is not None:
        return f"could not run: {analysis_capture.captured_exception}", ()
    assert overview is not None
    return overview_lines(overview)
