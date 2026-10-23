---
name: pre-commit-review
description: Review a change against the ShockHarness quality gate before committing or opening a pull request. Use when asked to review, check, verify or sign off a diff in a repository that runs shockharness, or before any commit there. Runs shockharness gate or check, reports unsupported analysis, suppressions, policy deviations and remaining warnings, runs the project's tests, and never claims a pass without having run the commands.
---

# Pre-commit review

The review has one rule: **never claim a pass you did not run.** Every
statement in the review quotes the command and the lines of output that back
it. A report that says "looks compliant" without the gate's own `gate: PASS
(exit 0)` line is not a review.

## Commands

Run from the repository root, in this order.

```bash
git status --short                                   # what is about to be committed
shockharness config validate                         # exit 0; profile and every policy deviation
shockharness check .                                 # working tree, full configured scope
shockharness exceptions .                            # every suppression, boundary, override and exclusion in one list
shockharness gate --base origin/main --head HEAD     # committed revisions only: exit 1 on NEW hard violations
pytest -q                                            # or the project's test command: node --test, npm test
```

Use the repository's default branch in `--base` (`main`, `master`, `develop`).
`gate` compares two **committed** revisions through local git; uncommitted
changes are not part of `HEAD`, so run `check .` for the working tree and
`gate` after committing (or on the CI run of the pull request). If the
repository uses a baseline, add `--baseline .shockharness-baseline.json` to
`check`. If the repository exposes `shockharness` only through a tool runner,
prefix the commands accordingly (`uvx --from 'shockharness==<pin>'
shockharness ...`).

Exit codes: `0` pass, `1` policy violations, `2` invalid configuration or
invocation, `3` tool failure or, under `parse_errors = "fail"`, a file that
could not be parsed. Exit `2` and `3` are review blockers of their own: they
mean nothing was verified.

## What to report, in this order

1. **Unsupported analysis.** Quote the `rules not implemented (not analyzed)`
   line when the report has one, and the `N failed` count
   of files that could not be analyzed. A clean gate covers only the rules
   that ran and the files that parsed. Name any file reported as a parse
   failure or excluded by configuration when it is part of the change.
2. **Policy deviations.** Quote the `config:` line and every `policy
   deviation` line from `config validate`: a profile below `strict`, a loosened
   mode, a severity cap, each declared exception boundary, each
   `[[overrides]]` entry. The review says whether the change added or widened
   one, and whether its `reason` holds.
3. **Suppressions.** Quote the `N suppressed` count and list each suppression
   the change adds or touches, with its rule ID and reason. Check that the rule
   ID exists (`shockharness rules list`), the reason cites a source, and the
   finding it silences is the one intended (`--no-inline-suppressions` shows
   every finding including suppressed ones). An unused suppression is a
   `SUPP002` warning and should be deleted. `shockharness exceptions .` lists
   every inline suppression with its reason and whether it silences anything,
   and every configuration exception with the file and line it comes from:
   the reviewer's view of what the code and the configuration exempt.
4. **Remaining findings and warnings.** List every `error`, `warning` and
   `review` finding in the changed files with its line, including the `review`
   findings that do not gate (`DEF003`, the implicit `None` of `.get(k)`,
   `approximate` confidences) and the complexity warnings (`CPLX001`-`CPLX006`,
   never gating; `gate --base/--head` lists per-unit regressions under
   `complexity regressions against base`). For each, say whether it is addressed, accepted
   with a stated contract, or left for a follow-up with a named owner.
   **Unknown findings** (`RULE severity (unknown): ...`; quote the `unknown:`
   trailer line, which also names the families whose `fail_on_unknown` makes
   them gate) are listed separately: the analyzer could not establish the
   property, so the change has neither passed nor failed that check. Ask for the
   missing information to be supplied (a resolvable exception import, an inline
   or module-level rejection handler, the manager constructed in the `with` and
   listed in `capture_managers`, a receiver typed as a mapping); see
   `fix-violations`. An unknown finding in a family with `fail_on_unknown =
   false` does not fail the gate and still blocks the review until it is
   answered or suppressed with a reason that states what could not be
   determined. A suppression of an unknown finding without such a reason, or a
   change that sets `fail_on_unknown = false`, is a blocking item.
5. **Tests.** Quote the test runner's summary line (`N passed`, or `node
   --test`'s `# pass N` / `# fail N`). A change that removes a default,
   a catch or a fallback must come with a characterization test for the new
   contract (see `fix-violations`); say which test that is.
6. **Verdict.** `PASS` only when `check .` (and `gate`, when run) exited `0`,
   the tests passed, and items 1-4 contain nothing unresolved. Otherwise
   `BLOCKED` with the first blocking item.

**Bugs the analyzer missed.** If the review finds a bug that ShockHarness did
not report, add a rule proposal to it: the pattern as a minimal example, why it
is a bug, the proposed rule (a syntactic rule rather than a heuristic), and the
false positives you expect. It goes wherever the project collects tooling
feedback; the review never edits the analyzer, its configuration or a baseline
to act on it.

## Review template

```text
Scope: <files changed>
Config: shockharness config validate -> exit 0; profile strict; deviations: <quoted lines or "none">
Analyzer: shockharness check . -> exit <n>
  <quoted summary lines: files, findings by severity, suppressed, rules not implemented>
  <quoted gate line>
Gate vs base: shockharness gate --base origin/main --head HEAD -> exit <n>; <quoted '<n> new, <n> fixed, <n> unchanged finding(s)' line>
Suppressions in this change: <rule ID, file:line, reason> or none
Remaining findings in changed files: <list> or none
Tests: <command> -> <quoted summary line>
Verdict: PASS | BLOCKED (<first blocking item>)
```

## Examples

### A review that passes

```text
Scope: src/app/settings.py, src/app/pages.py, tests/test_pages.py
Config: shockharness config validate -> exit 0; profile strict; deviations: tests/** disables MAGIC001, DEF001 (reason: fixtures encode literal expected outputs)
Analyzer: shockharness check . -> exit 0
  shockharness 0.26.0: 7 file(s), 7 analyzed, 0 failed; 1 finding(s), 1 suppressed
  gate: PASS (exit 0)
Gate vs base: shockharness gate --base origin/main --head HEAD -> exit 0; 0 new, 2 fixed, 1 unchanged finding(s)
Suppressions in this change: none (the existing MAGIC001 suppression on src/app/http.py:9, RFC 9110 section 15.5.5, is unchanged)
Remaining findings in changed files: none
Tests: pytest -q -> 14 passed in 0.31s
Verdict: PASS
```

### A review that blocks

```text
Scope: src/client.js
Config: shockharness config validate -> exit 0; profile strict; deviations: none
Analyzer: shockharness check . -> exit 1
  src/client.js:12:5: DEF005 error: catch clause converts the exception into a fallback value: return null; (EXC002 classification return_fallback; the handler is reported once, here)  [} catch (err) {]
  src/client.js:12:5: EXC001 error: catch clause is forbidden: untyped catch binds every error; a JavaScript catch passes only inside an approved boundary whose error class the handler checks with instanceof and otherwise rethrows  [} catch (err) {]
  shockharness 0.26.0: 3 file(s), 3 analyzed, 0 failed; 2 finding(s), 0 suppressed
  gate: FAIL (exit 1)
Gate vs base: not run (working tree uncommitted)
Suppressions in this change: none
Remaining findings in changed files: DEF005 and EXC001 at src/client.js:12; the failure of fetch() is turned into null
Tests: node --test -> # pass 6 / # fail 0 (no test covers the failure path)
Verdict: BLOCKED (EXC001/DEF005: decide the failure contract; see fix-violations)
```

### Python and JavaScript snippets the review should catch

```python
limit = options.get("limit", 100)          # DEF002 + MAGIC001: required value? validated where?
except Exception:                           # EXC001: broad catch outside a boundary
    log.warning("ignored")                  # EXC002: logging-only handler
```

```javascript
const port = process.env.PORT || 3000;      // DEF006 + MAGIC001
export function paginate(items, size = 10)  // DEF001 + MAGIC001
```

And what passes: a required, validated settings object; a `try` inside a
declared boundary that wraps one operation and re-throws a typed error; a
protocol value as a module-level named constant with its source (no suppression):

```python
NOT_FOUND = 404  # RFC 9110 section 15.5.5
```

## Checklist

- [ ] `config validate`, `check .` (with `--baseline` if the repository uses one) and the tests were actually run; exit codes quoted.
- [ ] `gate --base <default branch> --head HEAD` run on committed revisions, or explicitly marked "not run" with the reason.
- [ ] Unsupported analysis quoted: rules not implemented, files not analyzed.
- [ ] Every policy deviation quoted; any new boundary or override reviewed for its reason.
- [ ] Every suppression in the change listed with rule ID and cited reason; unused ones deleted.
- [ ] Every remaining finding in changed files listed with a disposition.
- [ ] Every unknown finding in changed files answered by supplying the missing information, or suppressed with a reason that names what could not be determined.
- [ ] Characterization tests named for every removed default, catch or fallback.
- [ ] Verdict is `PASS` only with `gate: PASS (exit 0)` and a green test summary in the quoted output.
- [ ] `shockharness exceptions .` read; any exception the change adds is listed above with its reason.
- [ ] Any bug the review found that the analyzer missed has a rule proposal attached.
- [ ] An element the change attaches to `document.body` (a notice, banner, overlay or card) is skipped by every page-level press handler that treats a press as "outside" (leaving edit mode, closing a menu), and a browser test presses each of its buttons in each mode (editing, searching).

## Setting ShockHarness up

Installing it, the policy file, the first run on an existing codebase, CI and installing
these skills are the `adopt-shockharness` skill.
