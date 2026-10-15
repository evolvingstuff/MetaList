from __future__ import annotations

from pathlib import Path

import pytest

from app.startup_js_sanity import assert_startup_js_sanity
from app.startup_js_sanity import collect_startup_js_sanity_violations
from app.startup_js_sanity import discover_javascript_source_paths
from app.startup_js_sanity import discover_typescript_source_paths


def _write_file(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_discover_javascript_source_paths_excludes_vendor_and_tests(tmp_path: Path) -> None:
    included_js = tmp_path / "app" / "static" / "js" / "modules" / "main.js"
    excluded_vendor = tmp_path / "app" / "static" / "js" / "vendor" / "markdown-it.min.js"
    excluded_suffix_test = tmp_path / "frontend" / "src" / "widget.test.js"
    excluded_dir_test = tmp_path / "tests" / "ui" / "helpers.js"
    excluded_venv = tmp_path / ".venv" / "lib.js"

    _write_file(included_js, "console.log('ok');\n")
    _write_file(excluded_vendor, "console.log('vendor');\n")
    _write_file(excluded_suffix_test, "console.log('skip');\n")
    _write_file(excluded_dir_test, "console.log('skip');\n")
    _write_file(excluded_venv, "console.log('skip');\n")

    paths = discover_javascript_source_paths(tmp_path)
    rel_paths = [path.relative_to(tmp_path).as_posix() for path in paths]

    assert rel_paths == [
        "app/static/js/modules/main.js",
    ]


def test_discover_typescript_source_paths_finds_typescript_files(tmp_path: Path) -> None:
    _write_file(tmp_path / "frontend" / "src" / "widget.ts", "export const ok = true;\n")
    _write_file(tmp_path / "frontend" / "src" / "widget.tsx", "export const el = <div />;\n")
    _write_file(tmp_path / "frontend" / "src" / "widget.test.ts", "export const skip = true;\n")

    paths = discover_typescript_source_paths(tmp_path)
    rel_paths = [path.relative_to(tmp_path).as_posix() for path in paths]

    assert rel_paths == [
        "frontend/src/widget.ts",
        "frontend/src/widget.tsx",
    ]


def test_collect_startup_js_sanity_violations_reports_rule_hits(tmp_path: Path) -> None:
    _write_file(
        tmp_path / "app" / "static" / "js" / "main.js",
        """
function bad(a = 1, {x = 2}) {
  const y = foo || bar;
  window.confirm('bad');
  try {
    internalCall();
  } catch (e) {
    return 1;
  }
}
""".strip()
        + "\n",
    )

    _, violations = collect_startup_js_sanity_violations(tmp_path)
    summaries = {(violation.rule_id, violation.message) for violation in violations}

    assert ("JS002", "default parameters are forbidden") in summaries
    assert ("JS003", "destructuring defaults are forbidden") in summaries
    assert ("JS004", "defaulting operator is forbidden") in summaries
    assert ("JS001", "try block has no allowlisted external call") in summaries
    assert ("JS001", "catch must not return") in summaries
    assert ("JS001", "catch must throw (no silent handling)") in summaries
    assert ("JS005", "native browser dialogs are forbidden") in summaries


def test_assert_startup_js_sanity_passes_and_reports_count(tmp_path: Path, capsys) -> None:
    _write_file(tmp_path / "app" / "static" / "js" / "main.js", "console.log('ok');\n")
    _write_file(tmp_path / "frontend" / "src" / "widget.jsx", "const el = <div>{value}</div>;\n")

    assert_startup_js_sanity(tmp_path)

    captured = capsys.readouterr()
    assert "[startup] Running JS sanity checks..." in captured.out
    assert "[startup] JS sanity checks passed (2 JS/JSX files)" in captured.out


def test_assert_startup_js_sanity_raises_on_parse_error(tmp_path: Path, capsys) -> None:
    _write_file(tmp_path / "app" / "static" / "js" / "main.js", "const x = ;\n")

    with pytest.raises(RuntimeError, match="JS000 parse error"):
        assert_startup_js_sanity(tmp_path)

    captured = capsys.readouterr()
    assert "[startup] Running JS sanity checks..." in captured.out
    assert "[startup] JS sanity checks failed" in captured.out


def test_assert_startup_js_sanity_honors_suppression_comments(tmp_path: Path) -> None:
    _write_file(
        tmp_path / "app" / "static" / "js" / "main.js",
        """
// lint: allow-JS004 rationale="test suppression"
const x = a || b;
/* lint: allow-JS001 rationale="test suppression" */
try {
  internalCall();
} catch (e) {
  throw e;
}
""".strip()
        + "\n",
    )

    _, violations = collect_startup_js_sanity_violations(tmp_path)
    summaries = {(violation.rule_id, violation.message) for violation in violations}

    assert ("JS004", "defaulting operator is forbidden") not in summaries
    assert ("JS001", "try block has no allowlisted external call") not in summaries


def test_assert_startup_js_sanity_raises_on_typescript_files(tmp_path: Path, capsys) -> None:
    _write_file(tmp_path / "frontend" / "src" / "widget.ts", "export const ok = true;\n")

    with pytest.raises(RuntimeError, match="TypeScript files are not supported"):
        assert_startup_js_sanity(tmp_path)

    captured = capsys.readouterr()
    assert "[startup] Running JS sanity checks..." in captured.out
    assert "[startup] JS sanity checks failed" in captured.out


def test_installed_distribution_js_scan_excludes_neighboring_packages(tmp_path: Path) -> None:
    _write_file(tmp_path / "main.py", "APP_NAME = 'MetaList'\n")
    _write_file(tmp_path / "app" / "static" / "js" / "main.js", "const value = 1;\n")
    _write_file(tmp_path / "dependency" / "external.js", "const value = first || second;\n")

    paths, violations = collect_startup_js_sanity_violations(tmp_path)
    relative_paths = [path.relative_to(tmp_path).as_posix() for path in paths]

    assert relative_paths == ["app/static/js/main.js"]
    assert violations == []


def test_repository_passes_startup_js_sanity() -> None:
    repository_root = Path(__file__).resolve().parents[2]

    assert_startup_js_sanity(repository_root)


def test_a_catch_may_narrow_to_an_expected_error_class_before_handling_it(tmp_path: Path) -> None:
    # The guard shape: everything else is rethrown first; what remains is handled.
    # SyntaxError is JSON.parse's error on external text, an expected failure.
    _write_file(
        tmp_path / "app" / "static" / "js" / "main.js",
        """
function parseScene(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new Error('not a scene', { cause: error });
  }
}
function parseOther(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    throw new Error('other');
  }
}
""".strip()
        + "\n",
    )

    _, violations = collect_startup_js_sanity_violations(tmp_path)
    rows = [(violation.lineno, violation.message) for violation in violations if violation.rule_id == "JS001"]
    assert rows == [(14, "catch must throw (no silent handling)")], "only the unlisted guard class is refused"


def test_a_promise_handler_may_drop_only_a_session_that_ended(tmp_path: Path) -> None:
    # A background save whose session ended: the login screen already shows.
    _write_file(
        tmp_path / "app" / "static" / "js" / "main.js",
        """
async function saveQuietly(save) {
  await save().catch((error) => {
    if (!(error instanceof AuthenticationRequiredError)) {
      throw error;
    }
  });
}
async function saveTooQuietly(save) {
  await save().catch((error) => {
    if (!(error instanceof RangeError)) {
      throw error;
    }
  });
}
""".strip()
        + "\n",
    )

    _, violations = collect_startup_js_sanity_violations(tmp_path)
    rows = [(violation.lineno, violation.message) for violation in violations if violation.rule_id == "JS001"]
    assert rows == [(9, "promise rejection handler must propagate unapproved errors")], "only the unlisted guard class is refused"
