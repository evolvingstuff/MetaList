# Testing Status

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
