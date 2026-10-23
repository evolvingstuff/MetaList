---
name: verification-integrity
description: Keep a change from weakening the checks that judge it, in a repository that runs shockharness. Use whenever tests, linters, type checks or the gate fail and it is tempting to make them pass by skipping, focusing, suppressing, neutralizing or loosening instead of fixing; when editing .shockharness.toml, a baseline, CI workflows or ruff, flake8, pytest, coverage or ESLint settings; and when shockharness reports VERIFY001, VERIFY002, VERIFY003 or VERIFY004. Explains what each finding means, what to do instead, and why these findings cannot be suppressed inline.
---

# Verification integrity

A failing check is information. Making it pass without fixing what it reports hides
the information from everyone who relies on the green build, including the person who
asked for the change. ShockHarness's VERIFY rules exist to catch exactly that, and
they are written so that the change under review cannot excuse itself.

The rule for an agent is simple: **fix the cause, or stop and say what you could not
fix.** Never make a check pass by weakening it.

## What counts as weakening

| Finding | What the change added | Do this instead |
|---|---|---|
| `VERIFY001` | a skip, xfail or focus marker on a test (`@pytest.mark.skip`, `pytestmark`, `self.skipTest`, `it.skip`, `it.only`, `xit`, `fdescribe`, ...) | fix the code or the test; delete a test whose behavior is gone; remove `.only`/`fit` debugging leftovers |
| `VERIFY002` | a blanket suppression comment (`# noqa`, `# type: ignore`, `// eslint-disable`, `// @ts-ignore`, `# pragma: no cover`, ...) | fix what the tool reports; if a suppression is genuinely right, name the exact code (`# noqa: E501`) and say why in the review |
| `VERIFY003` | a looser policy: a disabled rule, a raised threshold, a wider `exclude`, baseline fingerprints, `continue-on-error`, `--exit-zero`, an ignored ruff code, a deselected test, a lowered `fail_under`; or a key that loosens the organization's `--policy` file | revert it; if the policy really should change, propose it as its own change, with the reason, for the owners to review |
| `VERIFY004` | an assertion that cannot fail (`assert True`, `expect(1).toBe(1)`), a test whose assertions were all removed, a test emptied to `pass` | restore the assertion that was removed; if the expected value changed, assert the new value and explain why |
| `ROLE001` | code classified as a test that production imports, a test file with no tests, or (in a diff) a production file newly classified as a test | keep shipped code out of the test tree; give a test file real tests or list it as support code; never move code under `tests/` or widen the test globs to escape the production rules |

These findings are **not suppressible inline**: `# shockharness: ignore[VERIFY001]` is
itself an error (SUPP001). A change cannot grant itself permission with a comment it
adds. Exceptions live in configuration (`rules.verification`, `[[overrides]]`) or in
the organization's policy file, where review sees them, and a change that edits those
is reported by VERIFY003.

## Commands

```bash
shockharness check .                                    # plain run: VERIFY rules need a base
shockharness gate --base origin/main --head HEAD        # runs VERIFY001-VERIFY004 on the change
shockharness diff --base origin/main --head HEAD --format json --output diff.json
shockharness rules explain VERIFY003
```

`gate` exits 1 on VERIFY findings only when the repository (or its policy file) sets
`rules.verification.severity = "error"`; by default they are warnings. Treat a warning
as a blocker anyway: it says the change weakened its own verification.

The strictest of the current configuration's and the base revision's
`rules.verification` applies, so lowering the VERIFY severity or disabling the family in
the same change does not hide the change; it is reported too.

## Workflow when a check fails

1. Read the failure. Name the cause in one sentence (wrong value, missing case, broken
   contract, flaky dependency, environment problem).
2. Fix the cause in the code under change, or in the test if the test is wrong about
   the intended behavior. A test that is wrong is fixed, not skipped.
3. If the cause is outside the change (a flaky external service, a platform the code
   does not support), say so and leave the failure visible. A platform skip with a
   reason that the repository lists in `rules.verification.allowed_skip_reasons` is the
   only acceptable skip, and adding a reason to that list is a policy change (VERIFY003).
4. Run the tests and `shockharness gate --base <default branch> --head HEAD` on the
   committed change. Quote both outputs.
5. Report what is still failing and why, instead of making it pass.

## Examples

Python, before and after:

```python
# Weakened (VERIFY001, VERIFY004): the failing test is skipped and neutralized.
@pytest.mark.skip(reason="flaky")
def test_total():
    assert True

# Fixed: the rounding bug is fixed in total(); the test keeps its real assertion.
def test_total():
    assert total([Decimal("0.10"), Decimal("0.20")]) == Decimal("0.30")
```

```python
# Weakened (VERIFY002): a blanket suppression hides every check on the line.
from legacy import *  # noqa

# Acceptable when deliberate and reviewed: the exact code is named.
from legacy import widget  # noqa: F401 (re-exported for the public API)
```

JavaScript, before and after:

```javascript
// Weakened (VERIFY001, VERIFY004): focus hides every other test; the assertion cannot fail.
it.only("parses dates", () => { expect(1).toBe(1); });

// Fixed: no focus marker; the assertion checks the behavior.
it("parses dates", () => { expect(parseDate("2026-01-02").getDate()).toBe(expectedDay); });
```

Policy files, before and after:

```toml
# Weakened (VERIFY003): the rule that failed is switched off and the gate softened.
[tool.shockharness.rules.magic_numbers]
enabled = false
[tool.shockharness.gates]
new_hard_violations = "warn"
```

```yaml
# Weakened (VERIFY003): the gate can no longer fail the workflow.
- run: shockharness gate --base origin/main --head HEAD --exit-zero
  continue-on-error: true
```

## The organization policy file

An organization can fix keys centrally with `shockharness check --policy FILE` (or the
reusable workflow's `policy-repository` input). The file lives outside the analyzed
repository, usually in a separate protected repository, so the change under review
cannot edit it. Repository configuration may tighten a policy key, never loosen it: a
looser value is ignored, the policy's value applies, and VERIFY003 reports the attempt.
A list is one key, so a policy with `overrides = []` forbids repository overrides.

## Trust model

No local tool can stop someone with write access from editing the configuration that
would report them, or from not running the tool at all. Verification integrity holds
when the gate runs in CI as a required check on protected branches, policy files and
workflows need owner review (CODEOWNERS), and the organization's policy file lives
outside the repository. An agent does its part by never attempting the weakening in the
first place and by reporting honestly what it could not fix.

## Checklist

- [ ] No test was skipped, focused, emptied or given an assertion that cannot fail to get a green run.
- [ ] No suppression comment was added without naming exact codes, and none for VERIFY rules.
- [ ] No ShockHarness setting, baseline, workflow or tool configuration was loosened in this change.
- [ ] `shockharness gate --base <default branch> --head HEAD` was run on the committed change and its output quoted.
- [ ] Every VERIFY finding in the output is answered by reverting the weakening, not by explaining it away.
- [ ] Anything still failing is reported as failing, with its cause, instead of hidden.

## Setting ShockHarness up

Installing it, the policy file, the first run on an existing codebase, CI and installing
these skills are the `adopt-shockharness` skill.
