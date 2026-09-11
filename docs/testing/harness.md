# Testing Status

The legacy unit/integration suites were removed during the API2
migration. Current coverage is a mix of Python/unit tests, small JS unit
tests, startup sanity gates, and manual regression passes.

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
time than it was saving. If browser automation is reintroduced later:

- start with a very small smoke suite
- keep shared interaction logic covered below the browser layer
- treat full-browser coverage as optional confidence testing, not the primary
  debugging loop

## Ontology

Ontology rules are DB-backed and editable via the UI/API. Unit coverage lives in:

- `tests/unit/test_ontology_rules_store_sqlite.py`

See `docs/design/ontology-rules-v1.md`.
