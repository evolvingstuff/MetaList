# Testing Status

## Required compatibility gates (added 2026-09-14; not yet run)

[Compatibility rules and release gates](compatibility-gates.md) define the concrete contracts refactors must preserve. The installed-wheel matrix now checks every JS/CSS/JSON/icon asset through repeated concurrent HTTP and verified HTTPS transfers, including connection reuse. Its Windows/Python 3.12 leg additionally runs real Edge against non-loopback HTTPS, with two namespaces, three cold contexts, and three uncached loads each. Edge errors/screenshots are retained in CI. No manual Edge test is required for routine releases. The 0.6.3 installed-wheel asset check passed locally on macOS/Python 3.12; Windows Edge and all 15 installed-asset checks passed at 7d409aa3 in CI run 34877186696. One Windows upgrade cleanup failure still blocks release; its fix requires a new full matrix. The user excluded testing the HTTPS issue on the other laptop, not ordinary automated tests.

Current validation includes the full isolated Python suite, Node unit tests, Python/JS startup gates, real HTTP/TLS integration tests, a focused Puppeteer browser smoke, and installed-wheel platform checks. Historical results below retain their original dates and counts.

Development-mode startup sanity is part of normal `main.py` startup, but it
can also be run directly without launching namespaces:

- Set `METALIST_ENVIRONMENT=development` in the ignored repository-root
  `.env` file to enable the startup sanity gates. Production mode is the
  default when the setting is absent, and startup always prints the resolved
  mode.

- Python + JS prelaunch gate:
  - `.venv/bin/python -c "from pathlib import Path; import main; main._run_startup_sanity_gates(repo_root=Path.cwd())"`
- Python-only source audit:
  - `.venv/bin/python -c "from pathlib import Path; from app.startup_sanity import assert_startup_sanity; assert_startup_sanity(Path.cwd())"`
- JS-only source audit:
  - `.venv/bin/python -c "from pathlib import Path; from app.startup_js_sanity import assert_startup_js_sanity; assert_startup_js_sanity(Path.cwd())"`

Those startup sanity checks are pure Python. End users do not need Node to run
the app.

The complete command-palette endpoint registry is checked against every row in
its shipped JSON tag configuration by `tests/unit/command_palette_tag_config.test.mjs`.
The test uses the same loader and validator as browser initialization and rejects
unknown, missing, or duplicate entries. This catches stale configuration after
removing a command, including the removed diagram action that blocked startup
in v0.4.1.

There is targeted JS unit coverage for external HTML paste sanitization:

- `tests/unit/html_paste_sanitizer_service.test.mjs`
- Run with: `node --test tests/unit/html_paste_sanitizer_service.test.mjs`

Node is still required for the `.mjs` JS unit tests and Mermaid diagram
rendering, but not for the startup sanity gate.

The read-only agent harness has focused coverage for typed action boundaries,
the flat Ollama action envelope and inactive-placeholder projection, concise
structured-failure presentation, Instructor mode/request handling and retry traces,
transient context, packaged/default and namespace-overridden prompts, prompt-template
placeholder validation, read-only note tools, latest-run trace replacement, live
Instructor attempt/retry status, default-on exact debug detail, persisted default-hidden
developer activity panels, compact hidden-mode progress, duplicate lifecycle-panel
collapse, required per-panel approximate input-token metadata, API/session isolation,
packaged prompt resources, per-call Ollama wire bodies,
action-status parsing, and the debugger UI contract:

- `tests/unit/test_agent_runtime.py`
- `tests/unit/test_agent_prompt_settings.py`
- `tests/unit/test_ai_chat.py`
- `tests/unit/test_ai_routes.py`
- `tests/unit/ai_chat_panel_service.test.mjs`
- `tests/unit/ai_chat_ui_contract.test.mjs`
- `tests/unit/agent_prompt_service.test.mjs`

For deterministic browser automation, the server still exposes a
`TEST_MODE`-only reset endpoint: `POST /api2/test/reset`.

That reset clears all state a browser harness is allowed to assume away:

- notes + app settings tables
- search interaction history
- view cache
- tab-state store
- issued auth tokens
- in-memory sync state in `app/services/sync.py` including note locks and
  server clipboard contents

`app/static/js/main.js` sets `data-app-ready="true"` only after
`Auth.init()`, `ModeManager.init()`, and `CommandPalette.init()` finish and
the main app has been revealed. Any future browser harness should wait on
that boundary instead of racing startup.

## Current Direction

As of 2026-04-08, the Cypress harness was removed because it was costing more
time than it was saving. The September smoke suite follows these constraints:

- start with a very small smoke suite
- keep shared interaction logic covered below the browser layer
- treat full-browser coverage as optional confidence testing, not the primary
  debugging loop

## Ontology

Ontology rules are DB-backed and editable via the UI/API. Unit coverage lives in:

- `tests/unit/test_ontology_rules_store_sqlite.py`

See `docs/design/ontology-rules-v1.md`.


## Current commands and isolation (2026-09-12)

- `.venv/bin/pytest -q`: complete Python suite. `tests/conftest.py` creates a temporary data root **before app imports**, clears inherited `METALIST_*`, API-prefix and test-mode overrides, and removes its fixture directory after pytest. Tests needing special configuration set it in their fixture/subprocess environment. Never point tests at a personal namespace or historical backup directory.
- `npm test`: all `tests/unit/*.test.mjs` Node tests.
- `npm run test:browser`: optional small real-browser smoke. Run from the checkout with `.venv` and `npm install` dependencies available. Puppeteer uses its installed testing Chrome; this does not require end users to install Node. A fresh temporary namespace and available loopback port are created for each run; the harness terminates only its own server. It prints the disposable artifact directory and saves server logs on failure. No personal data root or existing archive is used.

The browser smoke waits for `data-app-ready`, verifies rendered edit/undo results and sibling move/delete/undo ordering after reload, uploads/downloads an attachment, creates a password, logs in, creates and restores an encrypted backup, observes the actual server restart, reauthenticates, verifies restored content and the unchanged archive hash, then logs out. HTTPS streaming has a separate deterministic real-TLS test in `test_phase_two_http.py`; the browser suite requires no AI provider.

Resource/hierarchy regressions live in `test_next_batch.py` and `test_shell_session_service.py`. They cover byte/entry/idle limits, deep chains and cycles across consumers, sort invalidation after edits/moves/deletes/hydration, connection bootstrap, ordinary middleware without SQLite, bounded shell output/admission/deadlines, descendant cleanup and idle expiration. The local run is macOS; Windows process-tree behavior needs actual platform validation before release.

Third-batch local result: 1,397 Python tests, 628 Node tests, both startup gates and the browser smoke passed. The final wheel/sdist resource check verified 426 runtime files. One existing Starlette TestClient deprecation warning remains.


F15 boundary coverage is indexed in `docs/REFACTORS.md`: `test_refactor_ordering.py` uses both isolated records and real SQLite mutations; `test_refactor_boundaries.py` covers malformed encryption/stream contracts and cleanup. Existing snapshot, formatting, tag suggestions, password recovery, and AI/privacy suites check preserved behavior.

F15 local result (2026-09-12): **1,411 Python tests**, **628 Node tests**, both startup gates and the expanded browser smoke passed. Wheel/sdist verification checked **424 runtime files**, confirmed all six retired service modules absent, and imported agent resources outside the checkout. Dependency consistency passed. This is macOS validation, not the cross-platform installed-application release matrix.


## Supply-chain and installed-package checks

After installing `requirements/ci.txt` with `--require-hashes`, run:

```bash
.venv/bin/python scripts/check_supply_chain.py check
.venv/bin/python scripts/check_supply_chain.py audit --output /tmp/metalist-dependency-audit
.venv/bin/python -m build --no-isolation
.venv/bin/python scripts/check_distribution.py dist
```

The audit needs network access and fails on advisories or an incomplete request. It removes environment markers only from the metadata audit input so other platforms' versions are checked; installation still respects markers and verifies locked hashes. Vendored-library smoke checks execute the actual DOMPurify, Markdown, and Mermaid builds. Full release requirements are in [supply-chain controls](../security/supply-chain.md); mapped coverage is in [coverage-map.md](coverage-map.md).

F17/F18 local result (2026-09-12): **1,421 Python tests**, **628 Node tests**, startup gates (**392 Python / 175 JS files**), actual patched-vendor browser rendering/sanitization and the complete disposable browser smoke passed. Wheel/sdist checks verified **425 runtime files** and excluded obsolete vendor bundles. A fresh hash-verified installed wheel passed actual two-namespace CLI/HTTP/HTTPS startup outside the checkout on macOS/Python 3.12.3. Source editable installation and 41-document local/15-URL external Markdown link checks passed. The hosted release matrix remains a separate exact-commit requirement.

## 0.5.0 release preparation (2026-09-12)

- The user confirmed testing of the remediation and formatting changes and authorized COMMIT FEATURE. The application version and its regression now specify 0.5.0.
- Local macOS validation: **1,449 Python tests** (13.07 s; existing Starlette TestClient deprecation warning), **659 JavaScript tests**, both development startup gates (**395 Python / 178 JS files**), and the full disposable browser smoke passed. Browser artifacts: `/var/folders/ms/_3pl0plx0kj8fnkmcfs1mjt80000gn/T/metalist-browser-rbVluh`.
- Lock exports, pinned Actions, vendor checksums/licenses, and a fresh audit of **94 locked Python versions across all platform markers and four vendor versions** passed with no known advisories. Temporary audit reports: `/tmp/metalist-release-050-audit/`.
- Built 0.5.0 wheel and source distribution; verified **430 runtime files** in both and imported packaged agent resources outside the checkout. Installed the wheel with hash-verified runtime dependencies into a fresh isolated environment; `pip check` and installed CLI/two-namespace HTTP/HTTPS startup passed on **macOS, Python 3.12.3**. Temporary artifacts: `/tmp/metalist-release-050-dist/`; installed-smoke log: `/tmp/metalist-release-050-smoke.log`.
- Hosted validation subsequently passed for commit `4db4162512276e48dbb26c2ce30f110469c8a644`: distribution build and all Windows/macOS/Linux × Python 3.10–3.13 jobs succeeded in [Publish to PyPI run 34738923630](https://github.com/evolvingstuff/metalist/actions/runs/34738923630); publication was skipped. This validates only that commit. Later changes require a new successful exact-commit matrix before tagging; no tag or publication is authorized by this record.

## 0.6.0 release preparation (2026-09-13)

- User-tested floating windows and UI refinements are merged into `main` at `5ab527cf`. The release candidate updates the authoritative version and version regression to 0.6.0 and adds release notes in README.
- Feature validation passed **1,460 Python tests**, **710 JavaScript tests**, and startup gates (**395 Python / 182 JS files**). The release version tests also pass after the bump. Disposable browser checks covered floating-window navigation, dragging/resizing, live updates, passwords, searches/tabs, deletion/undo, and login/logout; targeted light/dark checks verified steady read-only hover borders.
- Local macOS/Python 3.12.3 release validation passed: wheel and source distribution build, **435 runtime files** verified in both archives, packaged agent-resource imports, clean installation with hash-verified runtime dependencies, `pip check`, and installed CLI/two-namespace HTTP/HTTPS startup outside the checkout. Lock exports, vendor checksums/licenses, and Action pins passed. Disposable artifacts and logs: `/tmp/metalist-release-060-o4z4nz28/`.
- Release tagging requires a successful `Publish to PyPI` build and complete Windows/macOS/Linux × Python 3.10–3.13 matrix for the exact pushed candidate commit. Local validation does not replace that gate; hosted validation was pending when this preparation record was written.

## State lifecycle regression audit (2026-09-13)

- Local macOS checks: **1,449 Python tests**, **679 JavaScript tests**, development startup gates (**395 Python / 178 JS files**), and the complete disposable browser smoke passed. The existing Starlette TestClient deprecation warning remains.
- `tag_bar_focus_lifecycle.test.mjs` covers first/repeated editor/tag transfers, selected text and caret restoration, detached ranges, missing selections, and crossing note boundaries. Direct redundant setters still throw.
- `state_transition_regressions.test.mjs` exercises actual controllers/services with controlled external dependencies: streamed and final-only chat, unchanged rendered HTML, repeated session clearing, unchanged/changed bulk completion, logged-out polling, image completion after cleanup, and palette opening with non-HTML focus. Ontology and password clipboard suites cover repeated navigation, dialog resets, and repeated copying/clearing.
- `browser-smoke.mjs` and `browser-state-regressions.mjs` exercise repeated Tab/Shift+Tab with exact selection assertions, sibling/child creation, tag editing, indent/outdent boundaries, deletion/undo, ontology dialog cancellation/reopening and relationship creation, repeated focus, and arrow boundaries. Simulated AI responses exercise the real stream parser, chat rendering, and unchanged bulk completion without an AI provider. The existing attachment, formatting, hydration, and encrypted restore checks also pass.
- Repeated ontology HTTP rejections preserve the server error message; two regression tests reproduce the redundant error-state publication that previously masked it.
- Version Info lifecycle coverage in `version_info_modal.test.mjs` exercises the actual base-modal opening/rendering sequence with strict modal state: initial loading, reopening, delayed responses after close/reopen, and malformed responses. The browser suite opens Version Info twice and compares the displayed version with the real authenticated status endpoint.
- The user confirmed these lifecycle fixes passed manual testing and authorized a checkpoint on 2026-09-13. A new committed candidate's hosted release matrix is still required before release; the earlier release validation does not cover these fixes.


### 0.6.3 local release candidate validation (2026-09-14)
- Python unit suite: 1,484 passed. JavaScript unit suite: 717 passed. Python and JS startup sanity gates passed.
- The new six-client TLS fixture initially failed at handshake; see the separately documented accept-queue correction in [compatibility gates](compatibility-gates.md). The unchanged regression and full suite passed after that correction.
- Built wheel and source distribution; verified all 440 runtime files against the checkout.
- Fresh macOS/Python 3.12 environment installed hash-verified runtime requirements and the built wheel. `pip check` passed. Installed CLI and two disposable namespaces passed outside the checkout, including all 193 installed assets over HTTP/verified HTTPS, six connections and three passes per namespace.
- Lock exports, vendor checksums/licenses and Action pins passed. The disposable browser flow passed during feature validation, with simulated release/installer responses.
- Cross-platform exact-commit validation and Windows Edge remain pending. This record does not authorize a release tag or claim a real in-app upgrade has been human-tested; that is planned from this first updater release to a later release.


### 0.6.3 first CI run: harness corrections
[Run 34874922926](https://github.com/evolvingstuff/metalist/actions/runs/34874922926) built successfully and passed the complete installed-asset check on every OS/Python leg. Fourteen real-updater checks then failed because their `_verify_namespace` calls omitted the newly required TLS context. The Windows/Python 3.12 Edge leg timed out in `certutil -user -addstore Root` before launching Edge; its missing artifact was a consequence of that setup failure.

The updater harness now creates a verifying TLS context from its disposable installation’s generated certificate and passes it to both pre-update and post-update checks. Edge setup uses the machine Root store on the disposable GitHub-hosted Windows VM and removes the same certificate by thumbprint afterward. [GitHub documents administrator access with UAC disabled on hosted Windows VMs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners); [Microsoft documents the machine store as certutil’s default, with `-user` selecting the user store](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/certutil). Browser TLS verification remains enabled. `setup-results.json` is written even when certificate setup or browser startup fails, and `test_release_smoke_setup.py` covers setup failure, browser failure cleanup, and the unattended certificate commands. A new exact-commit platform/Edge run is required; the failed run cannot authorize tagging.

Local validation of these harness corrections: 1,487 Python unit tests passed, Python/JavaScript startup sanity passed, and the real uv update smoke passed on macOS/Python 3.12 using a disposable 0.0.0 installation upgraded to the built 0.6.3 wheel, verified TLS before/after, immutable backups, interpreter preservation and two namespace restarts. The actual Windows Edge run remains pending the next CI commit.

### 0.6.3 Windows probe cleanup correction

CI run 34877186696 at 7d409aa3 passed the build, actual Edge HTTPS startup/reloads, every installed-asset leg, and 14 of 15 complete upgrade jobs. Windows/Python 3.12 failed with WinError 32 deleting the temporary update probe fault log. The existing preflight stopped only its launcher; a descendant Python server could retain the log. This was a cleanup failure, not a startup timeout.

Preflight now stops the Windows launcher tree even if the launcher has already exited. The existing Windows tree-stop helper retains each process handle and waits for exit after termination, before returning to temporary-directory deletion. This also makes its existing shell cleanup caller wait for termination. No startup deadline, transport setting, cleanup-error suppression, or backup operation was changed. Two regressions reproduce surviving children after successful and failed readiness and pass with the fix. Native Windows verification remains pending the next exact-commit release matrix.

Local validation: all 1,489 Python unit tests and the Python/JavaScript startup sanity gates passed. Actual Windows process termination remains subject to the next CI run.

### PowerShell exit-status regression

Run 34879831716 at 17a62c04 passed Linux/macOS but failed all five Windows updater jobs with PowerShell exit 1 and empty stderr. Running the exact cleanup script in official portable PowerShell 7.6.6 on macOS reproduced that result when the launcher was already gone. The final expected missing-process lookup leaves PowerShell success status false. Cleanup now explicitly returns success after completing every stop/wait, with terminating error behavior enabled so enumeration, termination and method failures cannot reach that success exit.

Real PowerShell regressions cover an already-exited launcher, stopping/waiting for a live disposable process, and propagation of enumeration, termination and wait failures. Only the Windows-only WMI snapshot is substituted in cross-platform tests; Get-Process and exit-status behavior run in PowerShell. CI requires a PowerShell runtime instead of skipping these tests. Local checks use a SHA-256-verified official portable runtime in /tmp; full native Windows updater validation still requires the next exact-commit matrix. See [Microsoft’s exit-status contract](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1).

Local verification: 1,494 Python tests passed with real PowerShell enabled, plus both startup sanity gates.

### Tag-run failure and process identity checks

Commit ef826582 passed the complete branch matrix in run 34883739479, including every Windows updater and Edge HTTPS. The v0.6.3 tag rerun (34884820603) failed on Windows/Python 3.13; publication was blocked. The updater command failed, then cleanup could not launch PowerShell (0xC0000142, DLL initialization failure). Cleanup failure prevented the original update log from being printed, so the initial cause cannot be established from that run. No blind retry or release-gate bypass was performed.

Review found a concrete independent ownership flaw: ParentProcessId alone can refer to an unrelated older process after PID reuse. Real PowerShell regressions fail against ef826582 by selecting that older process and pass after correction, both with a live and an exited root launcher. The tree-stop API now takes the owned Popen object and reads its creation time through GetProcessTimes on its retained Windows handle. Tree traversal rejects children older than their parent, and each target handle’s creation identity must still match the selected process before termination. Updater and shell callers pass their owned process object. This fixes the demonstrated selection flaw without claiming it conclusively caused the tag-run failure. Native Windows validation is still required.

Smoke diagnostics are printed before attempting child cleanup; the local release-index server is shut down and joined even if cleanup raises. This preserves the primary updater log and avoids secondary socket-server shutdown noise. Existing errors remain fatal. [Microsoft documents ParentProcessId reuse and the CreationDate check](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process).

Local validation: 1,496 Python tests passed with real PowerShell enabled; both startup sanity gates passed. The PID-reuse regressions failed against the exact previous commit before passing with this change.

### Linux PowerShell fixture identity correction

Run 34887017802 at 89361930 stopped in the Ubuntu build unit suite: the live-process fixture queried StartTime in two separate PowerShell/.NET hosts, producing a false identity mismatch on Linux. The fixture now obtains its expected start time inside the same PowerShell host that checks and stops the disposable process. Native Windows still exercises GetProcessTimes on the retained process handle; production identity validation is unchanged. All 1,496 local tests and both startup sanity gates passed with real PowerShell enabled. Docker validation was not run; the user requested proceeding without Docker. Linux confirmation remains the next CI build.
