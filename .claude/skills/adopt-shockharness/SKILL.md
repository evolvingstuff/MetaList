---
name: adopt-shockharness
description: Set ShockHarness up in a repository - install a pinned version, write the policy file, take the first run on an existing codebase (baseline, minimal profile or warn mode), add the CI gate and Dependabot, install the agent skills, and verify each step. Use when adding ShockHarness to a project, upgrading its pin, wiring it into CI, or when a check or gate cannot run because ShockHarness is not installed or configured.
---

# Adopt ShockHarness

The other ShockHarness skills (writing, fixing, refactoring, reviewing) assume it is
installed and configured. This one sets it up. The steps below are the README's "Adopting
ShockHarness" section, word for word, so an agent with this skill installed never needs to
fetch the README.

## What the first run shows

A repository that has never run ShockHarness usually has findings on its first `check`.
The usual first one is an unexplained number, `MAGIC001`:

```python
def fetch(url):
    return http.get(url, timeout=30)  # MAGIC001: why 30?
```

```javascript
export function fetchPage(url) {
  return fetch(url, { signal: AbortSignal.timeout(30000) }); // MAGIC001
}
```

Do not fix the whole codebase before adopting it: Step 3 below gives four ways to take an
existing codebase on (a baseline, the minimal profile, warn mode, or fixing as you go), so
the gate stops new violations from day one while the old ones are paid down.

## Checklist

- [ ] ShockHarness is pinned to one exact version (a dev extra, `requirements-dev.txt`, or a tool install), never `latest`.
- [ ] `.shockharness.toml` (or `[tool.shockharness]`) exists and `shockharness config validate` passes.
- [ ] `shockharness check .` runs; existing findings are baselined, or the profile or gate mode was chosen on purpose and written down.
- [ ] CI runs the gate with the same pin, and Dependabot (or Renovate) proposes upgrades.
- [ ] The agent skills are installed for the agents that work in the repository (`init` does this; `check` prints a `skills:` line while one is missing), and their instruction files point at them.
- [ ] Each step's verification command was run and its output read.

## Adopting ShockHarness

This section is written for a coding agent (or a person) that was told to set
up ShockHarness in a repository and is reading it over HTTP. It is complete on
its own: nothing here depends on another page, and the detailed documents are
linked with absolute URLs at the end. Run every command from the repository
root.

### Step 1: install a pinned version

The version is always an exact pin; nothing updates to `latest`. Pick one:

```bash
uv tool install 'shockharness==0.26.0'                    # isolated tool environment; any repository, JavaScript included
uvx --from 'shockharness==0.26.0' shockharness version     # one-off run, nothing installed
pip install 'shockharness==0.26.0'                        # Python project: keep the pin in pyproject.toml (a dev extra) or requirements-dev.txt
```

The analyzer needs Python 3.11 or newer to run; the analyzed code may be
Python, JavaScript, TypeScript or C#. Its only runtime dependencies are `tree-sitter`,
`tree-sitter-javascript`, `tree-sitter-typescript` and `tree-sitter-c-sharp`. The pin that CI installs must live where an updater
can read it (`pyproject.toml`, a requirements file, or the workflow input in
step 4), never only inside a shell command.

### Step 2: write the policy file

```bash
shockharness init                 # writes .shockharness.toml: strict profile, every default spelled out, tests exempt; installs the skills (step 5)
shockharness config validate      # exit 0; prints the profile and every policy deviation
```

Commit `.shockharness.toml` and adjust `include`/`exclude` so only source is
analyzed; `init` already exempts tests from `MAGIC001` and `DEF001`. Never
switch a rule off to get past a finding (an override, a disabled rule, a lower
severity, a wider `exclude`): that is the user's decision, and `check` and the
hook report it as `VERIFY003` until a person commits it. A catch boundary
naming one file is the remedy `EXC001` asks for and needs no sign-off.

`init` also installs the agent skills (step 5) for every coding agent whose
files are in the repository: `.claude/` or `CLAUDE.md` means Claude Code
(`.claude/skills`), `.agents/` or `AGENTS.md` means Codex and the other agents
that read `AGENTS.md` (`.agents/skills`). It adds one line to that agent's
instruction file (`CLAUDE.md`, `AGENTS.md`) telling it to read the matching skill
before it writes code. `--agent claude` or `--agent codex` chooses instead of the
detection; `--no-skills` writes only the configuration. Commit the skills
directories and the instruction file with the configuration.

### Step 3: first run, and the four onboarding paths for an existing codebase

```bash
shockharness check .              # exit 0 pass, 1 violations, 2 invalid configuration, 3 tool failure or unparseable file
```

A codebase that predates the policy will have findings. Choose one of four
paths. All four are visible in every report, so none of them hides anything.

| Path | Command or configuration | Use it when |
|---|---|---|
| Baseline | `shockharness baseline create . --output .shockharness-baseline.json`, review and commit the file, then run `shockharness check . --baseline .shockharness-baseline.json` | You want a real gate from the first pull request: legacy findings stay listed but do not gate, new ones fail. The usual choice. |
| `profile = "minimal"` | `profile = "minimal"` in `.shockharness.toml`, or `shockharness check . --profile minimal` for one run | First contact: every rule runs and reports at `review`; only malformed suppressions fail. |
| `gates.new_hard_violations = "warn"` | `[tool.shockharness.gates]` with `new_hard_violations = "warn"` in `.shockharness.toml` | The repository has agreed that the policy is advisory for now, and that decision should be reviewed and diffed like any configuration change. It is reported as a deviation. |
| `--exit-zero` | `shockharness check . --exit-zero` | One invocation must not block (a dry run, a first SARIF upload, a scheduled strict run) and the repository's policy must not change for it. Exit 1 becomes 0; exit 2 and 3 are never masked; the report says `advisory`. |

On pull requests prefer `shockharness gate --base origin/main --head HEAD`
(use the repository's default branch; both revisions must be committed): it
exits 1 only on hard violations that are new relative to the base.

### Step 4: CI

Direct invocation works on any CI system. Install the pin from the manifest,
then run the analyzer; a report is written even when the gate fails:

```yaml
- run: pip install -e ".[dev]"      # the pin lives in pyproject.toml; a JavaScript repository uses the reusable workflow below instead
- run: shockharness check . --format sarif --output shockharness.sarif
```

On GitHub, call the reusable workflow. Pin its ref to a release tag or a full
commit SHA. The analyzer version is the `shockharness-version` input, not the
ref; the two are separate pins:

```yaml
name: ShockHarness
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  shockharness:
    uses: evolvingstuff/ShockHarness/.github/workflows/check.yml@v0.26.0
    permissions:
      contents: read
      security-events: write
    with:
      shockharness-version: "0.26.0"
      base: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || '' }}
```

Add `.github/dependabot.yml` so both pins get upgrade pull requests. Dependabot
bumps the `uses:` ref and any `pyproject.toml` or requirements pin; it does not
rewrite the `shockharness-version` input, so bump that by hand in the same
pull request:

```yaml
version: 2
updates:
  - package-ecosystem: pip
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

### Step 5: install the agent skills

Eight skills ship inside the package (`shockharness skills list` names them).
`init` installed them for the agents it found; these commands install them for
another agent, or in a repository adopted before `init` did. While a configured
repository has an agent's files and no skills installed for that agent, `check`
prints one line naming the command; `notify_missing = false` under
`[tool.shockharness.skills]` records that the repository wants none.

```bash
shockharness skills install --agent claude                              # .claude/skills/<name>/SKILL.md in this repository
shockharness skills install --agent claude --hook                       # also: findings after every edit (.claude/settings.json)
shockharness skills install --agent claude --hook --lock                # also: a lock file the project's configuration cannot loosen
shockharness skills install --agent codex                               # .agents/skills/<name>/SKILL.md in this repository
shockharness skills install --agent generic --project docs/agent-skills # any agent; prints the line to add to AGENTS.md
shockharness skills update --agent claude --check                       # exit 1 when an installed skill is stale or edited
```

Add `--user` to install into `~/.claude/skills` or `~/.agents/skills`
instead. `install` writes `.shockharness.toml` (as `init` does) when the project
has none, adds the pointer line to `CLAUDE.md` or `AGENTS.md` unless the file
already names the skills directory, and never overwrites a file without `--force`. A manifest,
`.shockharness-skills.json`, records a SHA-256 per file: `skills update`
rewrites unedited files and reports edited ones as conflicts. Put `skills
update --check` in CI to detect drift after an upgrade.

### Step 6: verify

Each command's output confirms one step.

| Step | Command | Output that confirms it |
|---|---|---|
| Install | `shockharness version` | `shockharness 0.26.0` |
| Policy | `shockharness config validate` | a line starting `shockharness: configuration is valid` naming `profile strict`, exit 0 |
| Analysis | `shockharness check .` | a report whose last lines start with `gate: PASS (exit 0)` or `gate: FAIL (exit 1)`; exit 2 or 3 means the setup is wrong, not the code |
| Baseline, if used | `shockharness check . --baseline .shockharness-baseline.json` | `gate: PASS (exit 0)` followed by `N legacy finding(s) matched the baseline` |
| Pull-request gate | `shockharness gate --base origin/main --head HEAD` | `gate: PASS (exit 0)` with new, fixed and unchanged counts |
| Skills | `shockharness skills update --agent claude --check` | a line ending `up to date`, exit 0 |
| CI | the workflow run | the `shockharness` job green; findings under the repository's Security tab when SARIF is uploaded |

Detailed documents: configuration
https://github.com/evolvingstuff/ShockHarness/blob/main/docs/configuration.md,
rules https://github.com/evolvingstuff/ShockHarness/blob/main/docs/rules.md,
CI and Dependabot
https://github.com/evolvingstuff/ShockHarness/blob/main/docs/integration.md,
skills https://github.com/evolvingstuff/ShockHarness/blob/main/docs/skills.md,
limitations
https://github.com/evolvingstuff/ShockHarness/blob/main/docs/limitations.md.

