# Testing Status

## Required compatibility gates

[Compatibility rules and release gates](compatibility-gates.md) define the concrete contracts refactors must preserve. `Publish to PyPI` builds one distribution pair, then runs independent Python compatibility, per-OS JavaScript/sanity, installed-package/update, browser-smoke, and browser-soak jobs. Chrome and Firefox cover every OS; Windows also covers Edge over non-loopback verified HTTPS. Browser errors, stage diagnostics, and screenshots are retained without diagnostic upload creating secondary failures. Each release requires a successful exact-commit main matrix; the tag job checks that run and publishes its tested artifacts without rerunning the matrix.

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

After the two gates, development startup also prints a **ShockHarness report**:
[ShockHarness](https://github.com/evolvingstuff/ShockHarness) is a strict,
deterministic static-analysis policy for Python and JavaScript (exception
transparency, no implicit defaults, no magic numbers, advisory complexity). It
is the `shockharness==0.3.0` pin in pyproject's `dev` extra (Python 3.11+ only)
and is scoped by `.shockharness.toml` at the repository root. The step is an
assessment, not a gate: it never fails startup, whatever it finds, and the
existing gates are unchanged. The console shows one headline (files, findings
by severity), the rules and files with the most findings, and a last line with
the time the run took and what the per-file cache did (`.shockharness-cache/`,
ignored by git: a run after the first reuses every unchanged file, so only
changed files and the cross-file work cost time); the full report is written
to `logs/shockharness/latest.json` (ignored by git). Without
the tool installed, or when its configuration is invalid, startup says so and
goes on. CI does not run it. To run it by hand:
`.venv/bin/shockharness check . --exit-zero`.

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
the flat action envelope and inactive-placeholder projection, concise
structured-failure presentation, Instructor mode/request handling and retry traces,
transient context, packaged/default and namespace-overridden prompts, prompt-template
placeholder validation, read-only note tools, latest-run debug snapshots plus full session history, live
Instructor attempt/retry status, default-on exact debug detail, persisted default-hidden
developer activity panels, compact hidden-mode progress, duplicate lifecycle-panel
collapse, required per-panel approximate input-token metadata, API/session isolation,
packaged prompt resources, per-call OpenAI wire bodies,
action-status parsing, and the debugger UI contract:

- `tests/unit/test_agent_runtime.py`
- `tests/unit/test_agent_prompt_settings.py`
- `tests/unit/test_ai_chat.py`
- `tests/unit/test_ai_routes.py`
- `tests/unit/ai_chat_panel_service.test.mjs`
- `tests/unit/ai_chat_ui_contract.test.mjs`
- `tests/unit/agent_prompt_service.test.mjs`

Web-agent coverage uses the same current-production assembly rule. Deterministic
tests cover all three modes, disclosure-derived URL capabilities, hidden selected
notes, batched action schemas, public-address enforcement, redirect handling,
HTML/plain-text/PDF extraction, duplicate reuse, retained evidence, mixed
citations, unrestricted full-mode page opening, and partial external failures.
`tests/unit/test_eval_selection.py` verifies that editing `web-browsing.md` selects
only regression cases whose prepared production requests actually load that skill;
the ordinary no-web cases still receive the current production
`WEB_ACCESS_CONTEXT` and are not frozen prompt captures.

For deterministic browser automation, the server still exposes a
`TEST_MODE`-only reset endpoint: `POST /api2/test/reset`.

`BROWSER_TEST_BROWSER=chrome BROWSER_TEST_SUITE=ai-privacy npm run test:browser` checks the chat-hover privacy
preview with synthetic notes: blacklist matches, missing whitelist matches,
excluded descendants, and an allowed note. It verifies blurred content without lock
icons, plus repeated hover cleanup in light and dark themes. Passed
locally in Chrome 131 and Firefox 155; screenshots are saved under `/tmp/metalist-ai-privacy-*.png`.

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
- `python scripts/check_types.py check`: mypy (pinned in the dev extra, configured in `[tool.mypy]`) over `app/`, `main.py` and `serve_namespace.py`, compared with `scripts/mypy-baseline.txt`, the errors that predate the checker, listed without line numbers. A new error fails; so does a fixed one until `python scripts/check_types.py update` shrinks the baseline. mypy checks as Linux on Python 3.10 on every OS, so all CI legs compare against the same list; CI runs it once per OS beside the startup sanity gates, and COMMIT FEATURE runs it too.
- `BROWSER_TEST_BROWSER=chrome npm run test:browser`: optional small real-browser smoke. Run from the checkout with `.venv` and `npm install` dependencies available; `BROWSER_TEST_BROWSER` names the engine (`chrome` or `firefox`) on every run, the harness picks none for you. Puppeteer uses its installed testing Chrome; this does not require end users to install Node. Suites that build a fixture run their cases through `runThenCleanUp` (`scripts/suite-outcome.mjs`): the fixture is removed whatever happened, and a case failure is reported ahead of any cleanup failure. Each run starts with the backup reminder Off: it is Weekly by default and a fresh namespace has no backup, so its card would float over what checks click (only `BROWSER_TEST_SUITE=backup-reminder` turns it on). A fresh temporary namespace and available loopback HTTP and HTTPS ports are created for each run (never the default HTTPS 8443, so a running MetaList can still start); the harness terminates only its own server. It prints the disposable artifact directory and saves server logs on failure. No personal data root or existing archive is used.

The browser smoke waits for `data-app-ready`, verifies rendered edit/undo results and sibling move/delete/undo ordering after reload, uploads/downloads an attachment, creates a password, logs in, creates and restores an encrypted backup, observes the actual server restart, reauthenticates, verifies restored content and the unchanged archive hash, then logs out. HTTPS streaming has a separate deterministic real-TLS test in `test_phase_two_http.py`; the browser suite requires no AI provider.

### Exit-edit scroll regressions

`scripts/browser-dictation-paste-regressions.mjs` (`BROWSER_TEST_SUITE=dictation-paste`, also in full smoke) pastes dictated text into the search bar, a tag bar and a note (text before "start tags" into the note, tags after it into the tag bar) and checks the cleaned result and that one undo restores the paste, removing both text and tags for a note paste with the real undo shortcut; every cleanup rule is covered in `tests/unit/test_dictation_cleanup.py`. It also copies a note with ⌘C, then, with no window switch, puts plain text on the clipboard from outside MetaList and sends a real ⌘V (as a dictation app does) into a note and into its tag bar: the text goes in and no copy of the note appears.

`scripts/browser-file-drop-preview-regressions.mjs` (`BROWSER_TEST_SUITE=file-drop-previews`, also in full smoke) drops files as Finder does and checks: a `.md` file gives an `.MD` pill and an expanded child rendered as Markdown; `.csv`, `.txt` and `.json` dropped together give `.CSV`, `.TXT` and `.JSON` pills in one note and a child each in drop order (a CSV table, plain text with HTML shown literally, pretty-printed JSON); a 300 KB `.txt` keeps only its pill with an info banner; and a `.csv` dropped into the note being edited (after entering edit mode has finished; a drop during it is refused as busy) adds its pill there and its child last, while editing continues and the note stays at the same height (exact pixels).

`scripts/browser-scroll-regressions.mjs` builds a long note between short ones and checks that leaving edit mode with Escape keeps your place: the paragraph at the caret (sampled on every frame, so a one-frame jump fails) or at the reading line stays at the same height; a collapsed note left without an edit shows collapsed again just below the search controls, while one that was edited stays expanded (also after a reload) with the edited line where it was; the same holds in a content-volume sorted tab; clicking another note while editing keeps the clicked paragraph under the pointer; leaving edit mode never adds a highlight or other click-through overlay over the notes, in any case; each drag case from `docs/ui/interaction-principles.md` (a short note moved down onto a note running past the window's bottom, a short note moved up, a note taller than the window moved down to the bottom edge, and a sideways indent then outdent) lands with its edge on the drop line (±2px) and never scrolls on any frame, while a note dropped before one hidden under the search controls scrolls just enough to sit right below them with the usual gap (±2px, no extra headroom); a `@markdown` note left with the reading line on its Mermaid source keeps its top in place; clicking into a note keeps the clicked line under the pointer with the caret on it (a paragraph in a long rich-text note, a Markdown paragraph below a Mermaid diagram, each of three Markdown list items), clicking each box of a Mermaid diagram puts the caret on its source line under the pointer, and clicking empty diagram space starts its ```` ```mermaid ```` source where the diagram's top was; in CSV, JSON, Markdown-table and LaTeX notes, clicking a row, key or formula puts its source line under the pointer with the caret on it, and Escape returns the clicked spot to the same height; and late content keeps its space (an inline image renders with its pixel `width`/`height`, and a Mermaid diagram shown again holds its earlier height while it re-renders). All cases run and failures are reported together. Fixtures delete their notes afterwards. Run just these cases with `BROWSER_TEST_BROWSER=chrome BROWSER_TEST_SUITE=exit-edit-scroll npm run test:browser`. Its `reload` helper looks for the ready app again if Chrome replaced the page's frame during the reload (Puppeteer briefly reports the old frame as detached); any other error fails as usual.

`scripts/browser-sorted-tab-regressions.mjs` builds 200 root notes (more than the band of loaded roots) and checks the sorted-tab rules: `Enter` outside edit mode is blocked with a banner in content-volume and alphabetical tabs (the reported `Infinite scroll blocked` crash came from an empty note sorting outside the band) and scrolling afterwards hits no fatal error; `⌘ + Enter` on a root note is blocked in content-volume and created tabs while the note stays in edit mode; created and updated tabs add the new note at the top; and in content-volume and updated tabs a note grown or touched while editing keeps its neighbours through a save and view refresh, then moves to the top on Escape while the note that was below it stays at the same screen height. Run just these cases with `BROWSER_TEST_BROWSER=chrome BROWSER_TEST_SUITE=sorted-tabs npm run test:browser`.

`scripts/browser-search-input-regressions.mjs` types `- tag` (a space after the minus) and checks that the explanation appears under the search field and nothing runs, that pressing Enter in the search and Enter to add a note under it both show a polite banner without the fatal overlay (no note is added), and that after a reload the restored `- tag` is not run as `tag`. In the full smoke it runs right after the background sort-menu check, because its searches persist in search history (which that check is sensitive to) and its reloads must come before the password/backup steps, after which a reload requires logging in again. Run just these cases with `BROWSER_TEST_BROWSER=chrome BROWSER_TEST_SUITE=search-input npm run test:browser`.

`scripts/browser-reference-paste-regressions.mjs` (`BROWSER_TEST_SUITE=reference-paste`, also in full smoke) copies a note with `⌘C` while editing it, then checks, with `⌘` and again with Control, with the caret shown and hidden: `⌘R` adds a sibling below holding `![[UUID]]` (saved, selected with no caret, one `⌘Z` removes it), fills an empty note the way `⌘V` does, or with nothing selected makes a new top note; `⇧⌘R` adds a first child where `⇧⌘V` puts its copy; in a content-volume tab `⌘R` is blocked with the same banner as `⌘V`; with nothing copied neither key does anything (and the page does not reload); the menu's Paste Sibling Reference and Paste Child Reference match the keys. Paste Reference Into Note, last in the Paste group (after the other references) when right-clicking in the edited note's text, puts the reference where the right-click was on its own line (mid-line, mid-word with nothing selected, on an empty line) or in place of text selected beforehand; the note stays in edit mode with the caret after it, one undo and redo, saved and shown embedded; it is not offered on a note not being edited, on the padding, on the tag bar, or with nothing copied. Keys are sent as a keyboard reports them: with Shift held the letter arrives in upper case (Control+Shift+R is `R`), which once made `⇧`+Control shortcuts miss their handlers.

`scripts/browser-click-caret-regressions.mjs` (`BROWSER_TEST_SUITE=click-caret`, also in full smoke) checks that one click opens a note with the caret showing, focused, where typing then lands (on the character boundary the browser finds under the click): in plain text, in rendered Markdown (the clicked list item's source line, also for a short item with too little text around it to match),  from another note being edited, on the padding (top-left: the note's start; bottom-right: its end), on a second click in the same note, and in a collapsed note. A note pasted with `⌘V` and a note opened by pressing its robot stay without a caret. Around note references, in link and embed mode: a click in text after a reference (`foo` / reference / `bar`, short lines included), after the second of two references, after the second reference to the same note, and after a reference written inline puts the caret exactly at the click; a click on the embedded note itself puts it at the start of its `![[UUID]]` source.

`scripts/browser-editable-embed-regressions.mjs` (`BROWSER_TEST_SUITE=editable-embeds`, also in full smoke) checks embeds (a note whose only content is `[[UUID]]`). To-do checkboxes: a checkbox in an embed is not a control (no pointer cursor or hover), and pressing it does nothing (no toggle, no edit mode, nothing moves) for the embed's root, a child shown inside it, and an embed nested in an embed; a note being edited stays edited, the caret where it was; the holder's own checkbox still toggles the holder; a search-redacted holder toggles nothing. Collapse: the holder shows the source's children in order, then its own; each note inside shows its saved collapse with an arrow where it can collapse (none for a one-line note without children); the holder's arrow folds the source everywhere and the holder's own children with it, folding the source elsewhere folds the holder, one undo brings both back; an arrow inside the embed folds that note everywhere; every arrow stays exactly under the pointer and nothing scrolls; while editing, the note is saved and left first; links, full screen and floating windows show no embed arrows. Shading: exact tints per embed level in light and dark, and a holder's own child takes the level around it.

`scripts/browser-floating-control-regressions.mjs` (`BROWSER_TEST_SUITE=floating-controls`, a separate suite) presses floating controls while a note is being edited: the error banner's × closes it on the first press and the note stays in edit mode (the × had used an inline `onclick`, which the Content-Security-Policy blocks, so it never worked); `Zoom Image` from the image menu saves and leaves edit mode first, and its × closes it on the first press. Both failed before the fix.

`scripts/browser-ai-chat-refusal-regressions.mjs` (`BROWSER_TEST_SUITE=ai-chat-refusal`, a separate suite) has the page stand in for the server's chat (refused Sends get a 409 with a reason, answered ones join the transcript the session reload returns) and checks exact transcripts: a refused Send stays with the server's reason; a later answered Send leaves it above; two refusals stay in order above the next answer; closing and reopening the chat keeps them; when the server trims the turn a refusal followed, the refusal goes with it, and one from before any message stays; Clear chat clears them; a page reload forgets them. The first case failed before the panel stopped reloading after a refusal, and the later-Send cases before refused turns were kept (`tests/unit/ai_chat_refused_turns.test.mjs` covers the merge).

`scripts/browser-tab-switch-regressions.mjs` (`BROWSER_TEST_SUITE=tab-switching`, a separate suite) searches `scratchpad` in one tab and `todo` in a new one, then clicks between them four times: after each switch the active tab (browser and server), the active search, the search box and the notes shown all belong to the picked tab. Each search is typed and entered at once, without waiting for the suggestions.

`scripts/browser-search-suggestion-regressions.mjs` (`BROWSER_TEST_SUITE=search-suggestions`, a separate suite) holds the suggestions response so a list built for older text is on screen: Enter then keeps and searches what was typed, closes the list and no list follows; an arrow does not move through the old list, and the new list arrives with its first suggestion highlighted. With an up-to-date list, Enter applies the highlighted suggestion and an arrow then Enter applies the one picked; a list arriving while typing is the one for the text in the box. The two older-list cases failed before the fix (Enter turned `todo` into `scratchpad`).

`scripts/browser-tag-bar-suggestion-regressions.mjs` (`BROWSER_TEST_SUITE=tag-bar-suggestions`, a separate suite) runs the same five cases as `search-suggestions` in an edited note's tag bar: on an older list Enter leaves the typed text alone and closes the list (no list follows), and an arrow does not move through it; on an up-to-date list Enter and arrow-then-Enter apply the suggestion shown; a list arriving while typing is the one for the text in the bar. The two older-list cases failed before the fix (Enter turned `qux` into `zebrafoo`).

`scripts/browser-ontology-search-regressions.mjs` (`BROWSER_TEST_SUITE=ontology-search`, a separate suite) runs the same five cases as `search-suggestions` in Edit Tag Relationships' tag search, holding its `/api2/ontology/tags` responses and recording which tag each Enter opens: on an older list Enter opens the typed tag and closes the list (no list follows), and an arrow does not move through it; on an up-to-date list Enter and arrow-then-Enter open the result shown; a list arriving while typing is the one for the text in the box. The two older-list cases failed before the fix (Enter opened `zebrafoo` instead of the typed `quxalpha`).

`scripts/browser-input-target-regressions.mjs` (`BROWSER_TEST_SUITE=input-target`, a separate suite) clicks a note and types 50 ms later, four rounds, both from no note being edited and while the other note is: the typing lands in the clicked note, and a capture-phase probe counts input events reaching a note other than the edited one (always 0, so the input handler throws if one ever does). Measured with this probe: keys pressed within about 20 ms of the click arrive before the note is editable and are not typed anywhere.

`scripts/browser-reminder-surface-regressions.mjs` (`BROWSER_TEST_SUITE=reminder-surface`, a separate suite) makes a reminder due, starts editing a note and presses the popup's `Got it` once: the reminder is cleared on that first press and the note is still in edit mode; pressing a second reminder's title then opens Reminders with edit mode ended. It failed before the popup was added to the outside-press handlers' exceptions.

`scripts/browser-backup-reminder-regressions.mjs` (`BROWSER_TEST_SUITE=backup-reminder`, a separate suite) checks the backup reminder's agreed cases: due when the app opens, the card floats with its corner exactly 18px from the window's right and bottom while the first note, the scroll and focus stay exactly where they are with the reminder off; the age shows in days; Off removes it at once and turning it on shows it at once; coming due while editing leaves the caret, note and page exactly in place and typing goes on; Back Up Now while editing saves the typing, leaves edit mode and opens Backup Settings on the first press; Cancel keeps the card; while the menu is open the card waits and shows when it closes; × hides it for exactly a day from the click and a reload keeps it hidden; a release notice and the card stack without overlapping and share a right edge; and a real backup into a temporary folder removes it and restarts the clock. The page answers `GET /api2/backup/times` from a sessionStorage fixture rather than any backup file being retimed, because existing backups are immutable. In Firefox the shared right edge is compared at its layout resolution (1/60 px). Run it with `BROWSER_TEST_BROWSER=chrome BROWSER_TEST_SUITE=backup-reminder npm run test:browser`.

`scripts/browser-collapse-outline-regressions.mjs` (`BROWSER_TEST_SUITE=collapse-outlines`, also in full smoke) checks that toggling a note's arrow only folds it: on every animation frame the outlines of the note and the note around it keep exactly the color they had and the arrow stays under the pointer (child and top-level notes, collapsing and expanding, with and without animation).

`scripts/browser-delete-warning-regressions.mjs` (`BROWSER_TEST_SUITE=delete-warning`, also in full smoke) checks the warning for removing a referenced note: through the note menu (not editing) the dialog counts the referring notes, Cancel keeps the note, Delete deletes it and one undo brings it back with its embed working; with `⌘⌫` while editing, edit mode ends (saved) as the dialog shows and Cancel leaves the note saved, out of edit mode; `⌘X` asks the same way and copies nothing on Cancel; a reference to a child counts, one from inside the deleted subtree does not; an unreferenced note is deleted or cut at once.

### Writing-assistant correction regressions

`scripts/browser-writing-assistant-regressions.mjs` uses simulated Grammarly hosts with light DOM, open/closed shadow roots, pointer and keyboard activation. It verifies that corrections preserve the edit session and formatting, then persist through an ordinary outside click and reload. A separate case changes editor text without dispatching `input`, exits with Escape, and verifies storage after reload. Fixtures delete their notes so subsequent ordering tests remain independent. These tests do not install Grammarly or prove compatibility with a particular Grammarly release.

Run just these cases with `BROWSER_TEST_BROWSER=chrome BROWSER_TEST_SUITE=writing-assistant npm run test:browser`. For Firefox, set `BROWSER_TEST_BROWSER=firefox` and `BROWSER_TEST_EXECUTABLE=/absolute/path/to/firefox`. Both engines use disposable profiles and namespaces. `tests/unit/external_editor_save.test.mjs` additionally checks unchanged/sanitizer-only snapshots, tag-only saves, collapse-state ordering, and repeated saves. No production CSP exception is added for automation.

Local validation on macOS passed the full Chrome smoke and the focused correction suite in Firefox 155.0.1. Firefox required Puppeteer Core 25.11.0, installed separately under `/tmp`; the repository's older driver could not launch that build, and its older bundled Firefox hit an automation/CSP conflict. `BROWSER_TEST_DRIVER_MODULE=/absolute/path/to/puppeteer-core.js` selects a compatible external driver without changing project dependencies. Safari, Windows, and a live Grammarly installation have not been verified by these synthetic tests.

After the final save-during-expansion adjustment, the correction cases still passed in Chrome and Firefox, all 728 Node tests passed, and the JS startup gate passed. That full Chrome rerun later timed out waiting for `data-app-ready` on the reload at the start of `checkFloatingNotes`; its cause remains unresolved. Retained failure log: `/tmp/metalist-grammarly-final-chrome.log` (disposable server artifacts `metalist-browser-0jOC9U`). The earlier complete pass is not a claim that the final full-suite run passed.

A subsequent diagnostic run passed the complete Chrome suite against the final save logic, including floating notes, editing, formatting, attachments, and encrypted restore (`/tmp/metalist-grammarly-diagnostic-chrome.log`, disposable artifacts `metalist-browser-AxvWRj`). The harness now retains browser console, navigation, and failed-request events in `browser.log` alongside server logs on failure. The prior reload timeout did not recur, so its cause remains unconfirmed; no timeout, security policy, or application startup behavior was changed to obtain the pass. The user does not have Grammarly; real-provider confirmation remains pending independently of ordinary editing regression checks.

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
- Release tagging requires a successful `Publish to PyPI` build and complete Windows/macOS/Linux matrix at the Python 3.10 and 3.14 endpoints for the exact pushed candidate commit. Local validation does not replace that gate.

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


## Opt-in prompt regressions

See [evals/README.md](../../evals/README.md) for exporting input/output pairs,
constructing fixed scenarios, and explicitly evaluating current production prompts
and context builders. Live cases default to five trials and four concurrent requests. Prefix-grouped
scheduling primes each shared prefix with a scored call before overlap; trials
within each case remain sequential. Reports include actual cached-token usage, outcomes
and errors. Incorrect answers exit 1; provider/judge errors exit 2. Compare saved
before/after reports with unchanged scenarios and expectations. Output cases use
an explicitly configured Instructor judge. Ordinary test commands never run this
live suite.

Since the tool-using agent replaced up-front routing (2026-10), whole agent runs are
tested with `python -m evals agent` over `evals/agent-cases/` (174 cases: 168
migrated routing-era cases, 3 combined ones, and 3 summaries of notes chosen by a
category the notes don't spell out), on Luna at Low thinking only.
Each run checks required and forbidden tool calls, the default tool order, whether
a Yes/No was asked, and a judged answer. `test_agent_evals.py` covers the runner
with a scripted model. The routing and help results below describe the earlier
design and are kept as history.

`test_agent_history.py` exercises the real OpenAI SDK/Instructor against a simulated
HTTP provider, covering retry pairs, multi-turn retention, session isolation,
partial/cancelled output, and the authenticated no-cache endpoint.
`test_prompt_regressions.py` checks expectation matching, independent repetitions,
judge criteria, propagation of current prompts/builders/catalogs/schemas, failure
exit status, export-to-case drafts,
comparison, and skill instruction lifetime without provider calls.
`browser-ai-history-regressions.mjs` checks the authenticated empty-history endpoint
and the export button's downloaded JSON for a simulated multi-turn history. It is
included in full smoke and selectable via `BROWSER_TEST_SUITE=ai-history`.

Web output coverage includes a 30-item Hacker News list-page fixture and a direct
article control. The list case requires a useful summary with at least eight
distinct destination-link citations and checks every specifically named story
against its exact `page_link` token. The article case requires body claims to cite
the opened article instead of an incidental outgoing link. Both cases build through
the current production skill, final prompt, context builder, and evidence catalog.
The 2026-09-24 candidate scored 5/5 on each live case; the focused deterministic
web/prompt/eval suite passed 208 tests with no skips.

Complete-scope summary coverage adds current-production `summary_batch` and
`summary_final` contexts. The synthetic garden case checks that the structured
batch selects supporting note IDs from its supplied evidence, and that final
synthesis preserves both fixed findings, cites their original note IDs, and
describes only the complete supplied scope. Runtime tests separately enforce
application-owned root coverage, permission before inference, unlimited total
batches with four active requests at most, writing→streaming→complete preview
transitions (never more than four visibly writing), compact throttled stream
previews, one correction request for structural-placeholder citations with a
classified failure after that, out-of-order completion with canonical
synthesis order, citations to the permitted selected-note tree (and rejection when
that note is unavailable), worker cancellation when the stream closes, recursive
reduction, cancellation, and atomic failure. `ai_chat_summary_progress.test.mjs`
behaviorally checks progress-card placement before the streaming answer (without
ever moving the card), compact streaming and one-line completed batch cards,
ordering, and invalid-transition failures.


2026-09-17 prompt-suite validation: **1,517 Python tests passed, 7 skipped**;
**728 JavaScript tests passed**; startup checks passed across **410 Python** and
**183 JS/JSX** files. The focused export browser check passed in **Chrome 131** and
**Firefox 155.0.1** on macOS. Provider capture tests use real SDK/Instructor code
with a simulated HTTP transport; no paid live regressions were run. Windows UI
and real-model accuracy have not been measured by these checks.


The live suite/fixtures and ordinary tests remain repository-only: wheel package
selection includes `app*`, and `MANIFEST.in` prunes `evals/` and `tests/` from the
source distribution. `scripts/check_distribution.py` rejects either tree in both
artifact formats. Runtime history capture/export still ships with the app.

`evals/cases/actions/` adds 24 entirely synthetic routing cases (eight for each
current route), about 210 KB total. Both baseline and candidate configurations
validate without model calls. The initial live Luna run scored 218/240 correct,
15 incorrect, and 7 validation errors. A keyword-based intent override caused
those validation errors; that override and its prompt signal have since been
removed. Case expectations remain unchanged; see the suite README. This collection
does not import personal history exports or query the live note database.


2026-09-17 removal of intent heuristics: the saved-note keyword validator, injected
routing signal, phrase-based system instruction, and legacy rationale-text action
override were removed. Instructor still validates structured actions; execution
still enforces permissions, scope, and tool limits. Synthetic conversations and
expected actions were not changed. Both the removal-only run and the final prompt
run scored **240/240 correct, zero incorrect, zero errors** with `gpt-5.6-luna`,
thinking off, 24 cases × 10 repetitions. This is a sample, not a guarantee of
future accuracy. The measured results describe the then-current prompts; v2 cases now rebuild current production requests.
The original run was 218/240 correct, 15 incorrect, and 7 validation errors.
Full local reports: `/tmp/metalist-luna-synthetic-live-20260917/`,
`/tmp/metalist-luna-no-keyword-routing-20260917/`, and
`/tmp/metalist-luna-no-keyword-candidate-20260917/` (includes `RESULTS.md`).
Final candidate estimated cost: $0.02515422. Ordinary validation passed **1,524
Python tests, 7 skipped**, **728 JavaScript tests**, and both startup gates;
focused prompt/fixture checks also passed after updating the final prompt.


## MetaList help and menu regression coverage

The help route has ten packaged skills and 54 allowed menu destinations. Only
selected skills enter the second model call. The normal deterministic suite checks
transient instruction lifetime, overrides, schema validation, real runtime and
SDK/Instructor history, session-bound/single-use API acknowledgments, disconnect
cleanup and browser timeouts. JS tests cover every destination, scope changes,
modals, cancellation, visibility and no execution of highlighted commands.

`MetaListHelpResponse` validates balanced CommonMark backtick and tilde fences
before a help answer can reach the browser. The deterministic regression reproduces
the reported equal-length nested Mermaid failure and accepts a longer outer fence.
The live `help-output-diagram-code-fences` case builds the current production help
prompt and formatting skill, then checks both factual accuracy and fence structure.
With the copyable four-backtick outer-fence contract, Luna passed **5/5** live runs
with zero provider errors on September 27, 2026. The other two cases whose requests
load the formatting skill also ran five times; the final affected set passed
**15/15** with zero provider errors. An earlier **14/15** run is preserved in the
results record: it caught a false claim that Mermaid source shared Excalidraw's
AI-visibility limitation, which the skill and source documentation now disambiguate.

`BROWSER_TEST_BROWSER=chrome BROWSER_TEST_SUITE=agent-help npm run test:browser` uses a disposable namespace.
It opens all 54 targets, rejects stale scope, closes/reopens settings with deferred
responses, and runs a simulated chat stream through the real controller and
acknowledgment client. It never submits operations or calls OpenAI. This caught
and fixed asynchronous modal lifecycle bugs and a missing acknowledgment URL.

Final local validation: **1,611 Python tests passed, 7 skipped**, **789 JavaScript
tests passed**. Startup gates passed 413 Python and 184 JS/JSX files. All 54 menu
destinations plus chat acknowledgment/lifecycle checks passed **Chrome 131** and
**Firefox 155.0.1**, on macOS. Windows and Safari UI were not exercised. Wheel and
sdist checks verified 457 runtime files, packaged help registry/catalog imports,
and absence of `evals/` and `tests/`. This is not release-matrix validation.

Live Luna tests were explicitly run **five times per case**, which is also the CLI
default. Initial help: **480/495 (96.97%)**, 15
incorrect, zero errors. Four revised help checks: **20/20**, reported separately.
Existing routing: raw **105/120**; two overly restrictive topic expectations were
corrected after reviewing skill content, and rescoring the same outputs gives
**115/120 (95.83%)**. Five quoted-command responses still skip product-help lookup.
Output-judge limitations and individual scores are preserved in
`evals/cases/help/RESULTS.md`. None of these scores override LLM actions with
keywords, imply a universal 100% threshold, or count repeated trials as new cases.

Password-login follow-up: the initial focused help browser run covered only
passwordless startup and missed the separate `Auth.handleLogin` initialization.
That path omitted the required `openMenu` callback and blocked opening an encrypted
workspace. A new disposable password-login step reproduced the reported fatal
error before the fix. Both startup paths now supply the callback; unit checks
exercise forwarding from each entrypoint. The expanded password-login plus all
54 menu checks pass in Chrome 131 and Firefox 155.0.1; all 791 JS tests and the JS
startup gate pass. No Python logic changed for this correction.


Encryption-help correction: the exact reported question failed the new coverage
criteria **0/5** with the frozen incomplete skill and scored **5/5** after expanding
the on-demand privacy reference from the code/schema inventory and security docs.
Five output cases and one route case were added (105 help cases total). Those six
plus the existing cloud-privacy output case scored **35/35**, five fresh Luna
attempts each, zero errors. Output cases use explicit LLM-as-judge criteria; the
route case uses structured expectations. All 97 focused deterministic tests and
the wheel/sdist resource checks passed. Full paths, costs and per-case results
are in `evals/cases/help/RESULTS.md`. Restart the server to reload packaged skills.

Final feature validation after the composer fix: all **795 JavaScript tests** and
both startup gates passed. The expanded Chrome/Firefox help suite also checks
repeated composer clicks before and after closing an agent-opened password
generator. Pointer release, cancellation and blur consume the height snapshot;
the strict state checks remain enabled. The user confirmed manual testing before
the feature commit.


## Selective LLM prompt regressions

For prompt or skill changes, use `python -m evals run ... --changed-since <report>`
with all candidate case paths. Every request is rebuilt from current production
code; only changed/new cases are sent to the model, five times by default. A skill
edit affects only cases actually loading that skill. Shared prompt/schema/builder
changes select their affected cases automatically. Dry-run first to inspect the
selection without API calls. Partial reports preserve unchanged historical results
and their source paths; historical failures retain failing exit codes. The new
report can serve as the next baseline. Use a full run for execution/provider
changes outside prepared requests. See `evals/README.md` for commands and limits.
