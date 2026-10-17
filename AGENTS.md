# Agent Operating Protocol

## Startup Checklist
At the start of EVERY conversation/context:
1. **Check if `docs/AI-SUMMARY.md` exists** – If it does, read it immediately to understand the project. If neither the `docs/` directory nor the summary file exist, ask: "No docs/AI-SUMMARY.md found. Would you like me to create one with SUMMARIZE to help me better understand your project?"
2. **Check PLAN.md** – If PLAN.md exists, ask whether to use it as-is or replace it. If it doesn’t exist, do nothing unless the user explicitly invokes PLAN.

Each action below follows a structured workflow with clear steps and success criteria.

---

## Action Catalogue
This document defines standardized workflows triggered by action commands in ALL CAPS. The commands fall into two groups:

### Development Actions
- **PLAN:** Create or refresh the working plan for the current feature.
  - Draft a comprehensive plan tailored to the feature request.
  - If PLAN.md exists, replace its contents; otherwise create it.
  - Present the plan and obtain explicit user approval before proceeding.
  - Once approved, immediately request permission to run the COMMIT CHECKPOINT workflow so the plan is preserved in version control.
  - Use PLAN.md to guide the work until the feature is complete. On COMMIT FEATURE, remove PLAN.md as part of that workflow.
  - Do not create PLAN.md automatically when handling FEATURE unless the user asks for PLAN.
- **FEATURE:** Implement a new feature with proper git branching and testing.
- **BUG:** Fix a bug (missing/incorrect behavior) using a failing test first, then code changes, then passing tests.
- **CODE REVIEW:** Systematic code quality review against established principles.
- **SECURITY REVIEW:** Check for security vulnerabilities and best practices.
- **DOCS REVIEW:** Verify documentation accuracy and completeness.
- **BRAINSTORM:** Discuss design decisions, without proposing specific code changes.
- **SUMMARIZE:** Create/update `docs/AI-SUMMARY.md` with compact project documentation.

### Git Actions
- **COMMIT CHECKPOINT** – Save progress on current feature branch.
- **COMMIT FEATURE** – Complete feature and merge to main. Remove PLAN.md as part of this process.
- **COMMIT** – Ask for clarification between checkpoint vs feature.
- **ROLLBACK** or **REVERT** – Undo all uncommitted changes on current branch.

## Environment Notes
- All Python work happens inside the `.venv` virtual environment; activate it (e.g. `source .venv/bin/activate`) or call `.venv/bin/python` directly when running tooling or scripts.

## CRITICAL: Backup Immutability

Existing backup files are immutable recovery artifacts.

- MetaList and agents may create a new backup, read/validate a backup, restore from a backup, or delete backups only through the explicitly authorized retention/delete or namespace-deletion workflow.
- **NEVER rewrite, replace, rename, repackage, migrate, chmod, touch, or otherwise modify an existing backup file.** This applies to internal namespace backups and user-configured folders such as Downloads.
- Database migrations operate only on the live database. Login/startup migrations must never enumerate or transform historical backups.
- Restore must leave every source archive and legacy sidecar byte-for-byte unchanged. Old database versions migrate only after installation as the live database: immediately for plaintext databases or after unlock for encrypted databases.
- A requested backup conversion must create a distinct new file with exclusive creation and retain the original unchanged.
- Backup creation must fail if its destination already exists; overwrite-capable archive modes and `os.replace`/rename-style publication are forbidden.
- `BKP001` startup-sanity findings cannot be suppressed. Do not weaken or bypass this gate.

## CRITICAL: Database Schema Changes Require a Version Bump

Any change to the persistent schema of the notes database **or its sibling `*.files.db`** (a new table, a new or removed column, a changed constraint) must bump `CURRENT_DATABASE_VERSION` in `app/db/version.py` and register a matching step in `app/db/migrations.py`. This applies even to purely additive changes, and even when `initialize_schema`/`initialize_file_schema` already adds the new pieces idempotently on open. Precedents: 4→5 (OpenAI credential columns), 5→6 (proposed tags), 8→9 (retiring the files-database `sounds` table), 9→10 (file revisions and diagram previews).

- The migration step must be idempotent. It must accept a database that on-open schema helpers have already partly or fully upgraded, and it must verify the final shape.
- Update `app/encryption_audit.py` in the same change. Key the expected schema on the database version: older versions may lack the new pieces or already have them; from the new version on, they are required. Classify every new column as an encrypted payload (with a `_PayloadSpec`) or as readable structural metadata. Add the new version to `_MIGRATION_DEFERRED_PLAINTEXT_FIELDS_BY_DATABASE_VERSION`.
- Why: the startup encryption audit fails closed on unknown tables and columns. Without a version bump, an older MetaList opening the database reports a confusing audit failure instead of "database version N is newer than supported", and the audit cannot tell an unmigrated database from a half-migrated one.
- Tests must cover: migrating a database created before the change; migrating one the app already upgraded on open; the audit before and after the new version; and updated `applied_versions` expectations.
- Document readable structural metadata in `docs/security/README.md`.

## CRITICAL: On-screen Behavior Follows the Interaction Principles

What MetaList does on screen after an action (scrolling, editing, dragging, collapsing, highlighting, layout) is derived from `docs/ui/interaction-principles.md`, not decided case by case. In short: keep the user's point of attention still; only the user's action changes the screen; if something would leave sight, move it the minimum distance back; deliberate choices persist and the user's work stays visible; never highlight the results of the user's own actions.

Before changing any such behavior:

1. Name the principle the change follows.
2. List every case it touches (for example dragging up and down, short and tall notes, landing in view, behind the search controls, past the window edge) with the expected result. Get the user's agreement on that list before changing code.
3. Write a test per case that checks exact positions, with no loose tolerances that would let the reported problem pass. Run the tests for cases that work today against the unchanged code first, so a regression fails a test instead of reaching the user.
4. Change one behavior at a time, and let the user try it before stacking the next change.

Never answer an unwanted behavior with "you can turn it off": fix the behavior.

## Git Permissions Policy

### CRITICAL: Test All Platforms Before a PyPI Release Tag

- Before creating or pushing any PyPI release tag (including `v*` tags), the **exact commit being tagged** must have a successful full distribution build, clean package installation, dependency check, and installed-application startup test on **Windows, macOS, and Linux**, at the supported Python endpoints **3.10 and 3.14**.
- Verify the built wheel and source distribution contain required runtime resources. Run startup tests outside the source checkout so source files cannot hide packaging omissions.
- Use the successful release-validation workflow run for that exact commit as evidence (MetaList: `Publish to PyPI`). Pending, skipped, canceled, failed, or unavailable platform results block release tagging; a local test run or a successful older commit is insufficient.
- If code, dependencies, packaging, or release configuration changes after validation, rerun the full matrix for the new commit before tagging. Do not create the tag first and rely on its subsequent workflow to discover failures.
- The publishing job must also require every platform check to pass and must publish the same distribution artifacts that were tested. Manual dispatch must not bypass these checks.
- A tag workflow must reuse the exact successful main-run distribution artifact after independently checking all required main-job conclusions and artifact provenance. It must not rebuild the distribution or rerun the cross-platform matrix on the tag. The release driver must verify the published PyPI files against that main-run artifact and perform a clean public install.
- This gate does not authorize git tagging, pushing, or publishing; existing user-permission requirements still apply.

### CRITICAL: Run the Full Release Matrix Once, on Main

- Do focused checks during feature development; do not require the full Windows, macOS, and Linux release matrix on feature branches or duplicate it locally. A push to `main` is the sole automatic release-candidate matrix run; an explicit manual check on `main` cannot replace that push run as release evidence. Do not schedule duplicate full-matrix runs for unchanged code or share a canceling concurrency group across event types.
- After review and the required human testing, merge and push `main`. Treat its exact-commit matrix as the release gate. Never create a PyPI release tag until every required main job passes and the tested distribution artifact is available.
- If main validation fails, preserve the logs/artifacts, identify the cause, fix it in a new commit, and validate that new commit on main. Never rerun a failed job merely to obtain green status; a rerun may confirm a diagnosis but does not erase the original failure.
- A tag push checks the successful exact-commit main run and publishes its tested artifact without rerunning the matrix. Do not add a second full matrix on feature branches or tags.

### CRITICAL: Always Ask Before Git Operations
**NEVER perform ANY git operations that modify the repository without explicit user permission.** When the user approves a modifying git command, execute it once using the shell tool with `with_escalated_permissions=true` so the harness shows the Proposed Command dialog for confirmation. If the user already granted permission for that specific command, run it—do not re-ask repeatedly.

#### Operations That REQUIRE Permission:
- `git add` – Staging files
- `git commit` – Creating commits
- `git push` – Pushing to remote
- `git pull` – Pulling from remote (can cause merges)
- `git merge` – Merging branches
- `git rebase` – Rebasing branches
- `git reset` – Resetting commits/changes
- `git checkout -b` – Creating new branches
- `git branch -d` – Deleting branches
- `git stash` – Stashing changes
- ANY operation that changes repository state

#### Operations That DON'T Need Permission:
- `git status` – Checking status
- `git log` – Viewing history
- `git diff` – Viewing differences
- `git branch` – Listing branches
- `git remote -v` – Viewing remotes
- ANY read-only operation

#### How to Ask:
Before performing any modifying git operation, ask: "Would you like me to [specific git operation]?" Example: "Would you like me to stage these files with git add?"

#### Exception:
The FEATURE, BUG, COMMIT CHECKPOINT, COMMIT FEATURE, and ROLLBACK/REVERT workflows have implicit permission for their defined git operations when explicitly invoked by the user.

---

## Git Workflow

### FEATURE
If the user says:

FEATURE: I would like to ... (description goes here)

Follow these steps:
1. Check if there are uncommitted changes in git and warn the user if so.
2. If everything is checked in, propose the branch creation command. Branch names must follow `feature/<meaningful-branch-name>`. Run the approved command with escalation once permission is granted.
3. Before starting implementation, inspect the `docs/` directory (create it if the project needs one) and review any Markdown files that relate to the feature so context is fresh. Organize with subfolders when that clarifies scope. If a potentially relevant doc is missing, flag it to the user (including suggested renames) before proceeding.
4. Interactively implement the feature as usual, keeping track of which docs must be updated.

The user can then test the changes and iterate as necessary.

### BUG
If the user says:

BUG: I want to ... (problem description, steps to reproduce, expected vs actual)

Follow these steps:
1. Confirm reproduction steps, expected outcome, and the current failure (ask for missing info, logs, and environment details).
2. If the user invoked BUG from `main`, treat it like FEATURE: check for uncommitted changes, then propose creating a `feature/<meaningful-branch-name>` branch and run the approved command with escalation once permission is granted. If BUG is invoked from an existing feature branch, continue on that branch.
3. Identify the test framework already in the repo (e.g. pytest, unittest, cypress, playwright). If none exists, suggest installing one (and explain why) before changing production code.
4. Write a minimal test that matches the reported steps and expected behavior. Verify the test fails against current code for the right reason before making production code changes.
5. Implement the smallest fix that makes the test pass. Follow fail-fast/loud rules; use asserts to document invariants where appropriate.
6. Run the relevant tests until they pass.
7. Propose a ShockHarness rule (see below).

### Every Bug Suggests a ShockHarness Rule
Whenever you run into a bug (reported, found in testing, or met in passing), hypothesize a ShockHarness rule that, had it existed, would have caught it before it shipped. A rule is better than a heuristic: say what code shape it matches, why that shape causes the bug, and roughly how often it would fire falsely. A heuristic is the fallback when no precise rule fits. Tell the user the proposal along with the fix, so it can go to the ShockHarness project.

### PLAN
If the user says `PLAN:` (optionally followed by context):
1. Review the current feature goals and write PLAN.md (create or replace) with a structured plan specific to the feature.
2. Present the finished plan to the user for approval. Do not continue until approval is received.
3. After approval, immediately run the COMMIT CHECKPOINT workflow (with user permission for the required git commands) so PLAN.md is preserved.
4. Reference PLAN.md throughout the feature work. On COMMIT FEATURE, delete PLAN.md as part of the process after merging and before reporting completion.

### Testing and Commits

#### Windows Line Endings
Windows CI runners check out with `core.autocrlf=true`, which rewrites LF to CRLF in text files. Local runs on macOS or Linux never see this, so a test that hashes, compares or byte-reads committed files can pass locally and fail only on Windows. This happened with 0.10.0: vendored bundle checksums mismatched on Windows.

- Before pushing a change that adds or alters such a test, or adds files whose exact bytes matter, run the Python unit suite in a Windows-style clone: `git -c core.autocrlf=true clone --branch <branch> . /tmp/metalist-crlf`. Then run `python -m pytest -q tests/unit` inside it. The clone contains only committed files, so commit first or copy the changed files in.
- Files whose bytes are pinned or reviewed belong under a `-text` rule in `.gitattributes` (as `app/static/js/vendor/**` is), so every platform checks out identical bytes. Do not make a test tolerate line-ending differences instead.

#### If Testing Fails
If the user tests the code and reports failure:
1. Suggest doing a `git reset --hard HEAD` to undo the changes.
2. Ask if the user wants to proceed with the reset before running it.

#### If Testing Succeeds
If the code works, suggest committing. There are two types:

**COMMIT CHECKPOINT**
- We aren't done with the feature yet.
- But we've made visible progress we want to capture.
- Commit to the feature branch but stay on it.
- Don't merge to main yet.
- we should always run pytest before each checkpoint
- A checkpoint runs only the quick unit suites (pytest, and the JS unit tests when JS changed), then commits right away. Do NOT run the full browser smoke, the Python 3.10 suite or the ShockHarness diff for a checkpoint: they take about 15 minutes and hold up the user, who usually has more to change.

**COMMIT FEATURE**
- The entire feature has been tested by the user and is working as expected.
- Update any relevant Markdown in `docs/` to reflect the feature. If the right document does not exist yet, ask the user whether to create a new one (and create `docs/` or subfolders when necessary). Suggest renames to keep docs organized when appropriate.
- Remove PLAN.md as part of this workflow.
- Run the full checks once, here (not at checkpoints): the full browser smoke, the Python unit suite on 3.10 as well as the local version, the JS unit tests, and the ShockHarness diff. Fix any failure before merging.
- Commit the changes to the feature branch.
- Merge the branch into main.
- Delete the feature branch.

**COMMIT** (without qualifier)
- If the user just says COMMIT, ask for clarification:
  - "Is this a checkpoint (partial progress) or is the feature complete?"

### Rollback/Revert
If the user says `ROLLBACK` or `REVERT`, undo all the uncommitted changes made on that branch.

---

# Code Review Workflow

If the user says:

CODE REVIEW: (optional specific focus area)

Follow these steps:
1. Scan all Python files in the current directory and subdirectories.
2. Apply the code review principles listed below.
3. Report findings with file:line references.
4. Suggest specific fixes for each issue found.

## Code Review Principles

### CRITICAL VIOLATIONS (Must Fix)
- **Bad exception handling** – try/except blocks that hide internal logic bugs
- **Imports not at top** – All imports must be at file top (except rare circular import cases)
- **Default fallbacks** – `if not x: x = "default"` patterns hide bugs
- **Soft error handling** – Warning logs instead of crashes for internal errors

### QUALITY VIOLATIONS (Should Fix)
- **Overly long functions** – Functions >50 lines need justification
- **Deep nesting** – More than 3 levels of if/for/while nesting
- **Missing early exits** – Functions that don't exit early on error conditions
- **Low assertion density** – Should have *at least* 5% of LOC as assertions/validations
- **Ambiguous naming** – Variables/functions with unclear purpose or scope
- **Unnecessary side effects** – Functions that modify state when they could return values

### SIDE EFFECT VIOLATIONS
Flag functions that have side effects when they could be pure:

Bad (unnecessary side effects):
```python
def calculate_tax(order):
    order.tax_amount = order.subtotal * 0.08  # Modifies input
    order.total = order.subtotal + order.tax_amount

def process_items(items):
    for item in items:
        item.processed = True  # Modifies input list items
```

Good (side-effect free):
```python
def calculate_tax(subtotal: float) -> float:
    return subtotal * 0.08

def calculate_total(subtotal: float, tax: float) -> float:
    return subtotal + tax

def mark_items_processed(items: List[Item]) -> List[Item]:
    return [item.copy(processed=True) for item in items]
```

**Acceptable side effects:**
- Database operations
- File I/O operations
- API calls
- Logging (when necessary)
- Cache updates

### AMBIGUOUS NAMING EXAMPLES
Bad names to flag:
- `data`, `info`, `result`, `temp`, `obj`, `item`, `thing`
- `process()`, `handle()`, `manage()`, `do_something()`
- Single letters (except loop counters `i`, `j`, `k`)
- Abbreviations without context (`usr`, `req`, `resp` without clear domain)
- Boolean variables not starting with `is_`, `has_`, `can_`, `should_`

Good naming patterns:
- `user_account`, `api_response`, `validation_errors`
- `calculate_tax()`, `send_email()`, `parse_json_config()`
- `is_authenticated`, `has_permission`, `can_delete`

### REVIEW OUTPUT FORMAT
```
FILE: path/to/file.py
  CRITICAL: Line 45 - Exception handling without re-raise
  QUALITY: Line 23 - Function 'process_data' is 78 lines long
  QUALITY: Line 67 - 4 levels of nesting in loop
  QUALITY: Line 12 - Ambiguous variable name 'data' - what kind of data?
  QUALITY: Line 89 - Function 'handle()' - handle what specifically?
  QUALITY: Line 156 - Function modifies input parameter instead of returning new value
```

# Security Review Workflow

If the user says:

SECURITY REVIEW: (optional specific focus area)

Follow these steps:
1. Scan all code files for security vulnerabilities.
2. Check configuration files and environment setup.
3. Review API endpoints and authentication logic.
4. Report findings with severity levels and file:line references.

## Security Review Principles

### CRITICAL VULNERABILITIES (Fix Immediately)
- **Hardcoded secrets** – API keys, passwords, tokens in source code
- **SQL injection** – Unparameterized queries, string concatenation
- **Authentication bypasses** – Missing auth checks, weak session handling
- **Command injection** – Unescaped user input in system calls
- **Path traversal** – User-controlled file paths without validation

### HIGH RISK (Fix Soon)
- **Exposed debug endpoints** – Debug routes in production
- **Weak input validation** – Missing sanitization, oversized inputs
- **Information disclosure** – Stack traces, detailed error messages to users
- **Missing HTTPS enforcement** – HTTP endpoints for sensitive data
- **Weak password policies** – No complexity requirements, short lengths

### MEDIUM RISK (Should Fix)
- **Missing rate limiting** – No protection against abuse
- **Weak CORS policies** – Overly permissive cross-origin settings
- **Insufficient logging** – Security events not tracked
- **Default configurations** – Unchanged default passwords, settings

### SECURITY OUTPUT FORMAT
```
FILE: path/to/file.py
  CRITICAL: Line 23 - Hardcoded API key in source code
  HIGH: Line 67 - SQL query built with string concatenation
  MEDIUM: Line 145 - No rate limiting on login endpoint
```

# Documentation Review Workflow

If the user says:

DOCS REVIEW: (optional specific focus area)

Follow these steps:
1. Check that setup instructions actually work.
2. Verify API documentation matches current code.
3. Identify missing or outdated documentation.
4. Test code examples in documentation.

## Documentation Review Principles

### CRITICAL ISSUES (Fix Immediately)
- **Broken setup instructions** – Steps that don't work for new developers
- **Outdated API docs** – Endpoints, parameters, responses that don't match code
- **Missing critical docs** – No README, deployment guide, or development setup
- **Dead links** – Broken internal/external links

### QUALITY ISSUES (Should Fix)
- **Missing code examples** – Complex APIs without usage examples
- **Unclear explanations** – Technical concepts without context
- **Missing troubleshooting** – No common issues section
- **Outdated screenshots** – UI images that don't match current interface
- **No changelog** – Changes not documented for users
- **Missing API examples** – Endpoints without request/response samples

### DOCS OUTPUT FORMAT
```
FILE: README.md
  CRITICAL: Setup step 3 fails - missing dependency installation
  QUALITY: Line 45 - Code example uses deprecated API

FILE: api_docs.md
  CRITICAL: POST /users endpoint no longer accepts 'role' parameter
  QUALITY: Missing example for error responses
```

# Summarize Workflow

If the user says:

SUMMARIZE

Follow these steps:
1. Check if `docs/AI-SUMMARY.md` exists (create `docs/` first if missing).
2. If it doesn't exist, ask: "docs/AI-SUMMARY.md not found. Would you like me to create one?"
3. Analyze the entire codebase structure and files.
4. Create or update `docs/AI-SUMMARY.md` with the most compact yet comprehensive overview.
5. Focus on what an LLM needs to quickly understand the project.

## docs/AI-SUMMARY.md Structure
```
# AI-SUMMARY

## Project: [Name]
[One sentence description]

## Architecture
- `/src`: [purpose]
- `/api`: [purpose]
- Entry: `main.py` - [what it does]

## Design
- Pattern: [name] for [purpose]
- State: [how managed]
- Error handling: [approach]

## Workflows
- Feature X: `file.py:function()` → `other.py:process()` → result
- API flow: request → [processing] → response

## Setup
```bash
pip install -r requirements.txt
python main.py
```

## Quick Ref
- Config: `config.py` - all settings
- Main logic: `core.py:main_function()`
- Add feature: modify `handlers.py`
```

## Summarization Principles

### EXTREME CONCISENESS
- Use bullet points over paragraphs
- Abbreviate when clear
- Skip obvious details
- Focus on non-intuitive aspects

### LLM-OPTIMIZED
- Structure for rapid comprehension
- Emphasize relationships and connections
- Include file paths for navigation
- Highlight gotchas and exceptions

### MAINTENANCE
- Update existing `docs/AI-SUMMARY.md` if it exists
- Preserve useful existing content
- Add new discoveries
- Remove outdated information

---

## Execution Philosophy

FAIL FAST AND LOUD: Whether you're running scripts, services, or tests, failures must surface immediately and noisily. Avoid graceful degradation or silent fallbacks—let the process crash with a clear error so issues can be identified and fixed quickly.

### CRITICAL: NO SOFT FAILURES - AGENTS READ THIS

Claude: You have a persistent anti-pattern where you add "helpful" error handling that masks bugs:
- try/except blocks that log warnings instead of crashing **for internal logic errors**
- Fallback values like `if not x: x = "default"`
- "This shouldn't happen" comments with graceful degradation
- Warning logs instead of raising exceptions **for programming errors**

#### WHEN TRY/EXCEPT IS OKAY:
**External system interactions** (these are NOT bugs, they're expected failures):
```python
# Good - external API can legitimately fail
try:
    response = requests.get(api_url, timeout=5)
    response.raise_for_status()
except requests.Timeout:
    # Retry logic is appropriate here
    return retry_api_call(api_url)
except requests.RequestException as e:
    # Log and re-raise or handle appropriately
    logger.error(f"API call failed: {e}")
    raise

# Good - user input can be invalid
try:
    user_age = int(user_input)
except ValueError:
    raise ValidationError("Age must be a number")

# Good - file operations can fail
try:
    with open(config_file) as f:
        config = json.load(f)
except FileNotFoundError:
    raise ConfigError(f"Config file {config_file} not found")
```

**MetaList: rejected user input.** Input that fails validation (e.g. a search that does not parse) raises `InputRejected` (`app/services/input_errors.py`). It is an expected failure, not a defect: the server answers it as a polite `400` (`{"detail", "inputRejected": true}`, `app/main.py`), the browser shows it as a calm banner (`ServerInputRejectedError`, `error-overlay.js`) instead of the fatal red overlay, and the startup sanity checker allows a `try` whose handlers catch only `InputRejected` to handle it without re-raising. Write the message for the user and say how to fix the input. Every other exception still fails fast and loud.

#### WHEN TRY/EXCEPT IS BAD:
**Internal logic errors** (these ARE bugs that should crash immediately):
```python
# Bad - hiding programming errors
try:
    result = my_calculation(data)
    return result.total_amount  # If this fails, it's a bug!
except AttributeError:
    logger.warning("Calculation failed, using 0")  # WRONG!
    return 0  # This hides the real bug

# Bad - masking type errors
try:
    return process_user_data(user_dict["email"])
except KeyError:
    return process_user_data("default@example.com")  # WRONG!
```

THE RULE IS SIMPLE:
- **External failures** (network, file I/O, user input, database) → Handle appropriately with try/except
- **Internal logic errors** (AttributeError, KeyError in your own code, None checks) → CRASH IMMEDIATELY
- If you think "this shouldn't happen" → CRASH IMMEDIATELY
- If you want to add a fallback for YOUR code → CRASH IMMEDIATELY instead

Error handling is for external systems. Internal errors are bugs that need fixing.

## CRITICAL: NO OPTIONAL FIELDS

Claude: ALMOST NEVER use Optional[T] fields in request/response models. Use required fields instead.

Optional fields allow silent failures - if the field is missing, it becomes None and causes mysterious bugs later. Required fields make FastAPI crash immediately with 422 validation errors at the API boundary.

BEFORE using Optional[T], you MUST:
1. Ask for explicit human approval
2. Explain WHY you think Optional is appropriate for this specific case
3. Get confirmation before proceeding

Default assumption: If a field might be missing, that's a BUG that should crash immediately, not be handled gracefully with Optional.

### Assertions
- Use `assert` aggressively inside internal business logic to document invariants and catch bugs early. Target the ~5% assertion density guideline from the code review section and prefer explicit asserts over silent corrective logic.

---

# Code Style Requirements

## Import Organization
ALL imports must be at the top of Python files. Never put imports inside functions or methods unless there is an exceptional technical reason (like avoiding circular imports).

Bad:
```python
def my_function():
    import os  # WRONG
    return os.getcwd()
```

Good:
```python
import os

def my_function():
    return os.getcwd()
```

If this finds any soft error handling, FIX IT IMMEDIATELY before proceeding.
DO NOT continue with other tasks until all error handling is removed.

---

# Testing Philosophy

## CRITICAL: Cross-Platform Regression Coverage Must Be Symmetric

Core product behavior must receive the same regression coverage on every supported operating system. For MetaList, Windows, macOS, and Linux must each run the complete Python unit suite and installed-package/update validation at the supported Python endpoints **3.10 and 3.14**. Each operating system must also run the complete JavaScript unit suite and both startup sanity gates once; these checks do not vary by Python minor version.

- A single-OS unit run plus narrower cross-platform smoke tests is not equivalent and is forbidden as release coverage.
- Installed-package, updater, persistence, encryption, authentication, hydration, and startup checks must exercise the same core behavior on all supported operating systems. Do not assume code is platform-independent merely because it usually runs above an abstraction layer.
- Platform-specific tests are additive. Windows Edge, PowerShell, process-control, installer, and other OS-specific checks must supplement the shared suite, never replace any part of it.
- Browser-visible core workflows must run the same blocking scenarios in real Chrome and Firefox on Windows, macOS, and Linux. Platform browsers such as Edge are additive and cannot substitute for Chrome or Firefox on any operating system.
- When a test cannot run unchanged on every supported OS, document the concrete platform constraint, preserve equivalent assertions elsewhere, and add the platform-specific coverage needed to test the real behavior. Do not silently skip or weaken assertions.
- Every required OS/Python leg must pass for the exact candidate commit. A passing result on another OS, Python version, earlier commit, or narrower smoke path cannot stand in for a missing or failed leg.
- When changing CI, compare the tests and gates executed by each matrix leg. Any asymmetry must be intentional, documented, and limited to genuinely platform-specific additions.

## CRITICAL: LLM Regression Tests Must Exercise Current Production Prompts

The purpose of LLM regression tests is to detect behavior regressions when prompts change. Every regression run must build requests through current production prompt and context builders, using current system instructions, skills, catalogs, context formatting, and response schemas. Changes to any of these must automatically reach all applicable existing regression cases.

- Keep scenario inputs, conversation history, evidence, and expected behavior fixed. Do not freeze production instructions inside executable fixtures or replay captured prompts as regression coverage.
- Captured requests may remain diagnostic provenance, but must never replace current production request construction during regression runs.
- Do not require manual prompt bindings or fixture refreshes for existing cases to exercise new prompts. Add tests proving production prompt and builder changes reach regression requests.
- Never change expectations merely to make a new prompt pass. Expectation changes require an intentional, separately reviewed change in product requirements.
- Compare saved before/after reports using the same scenarios and expectations. Incorrect behavior must produce a failing exit status; provider errors must also fail and remain in the denominator.
- Distinguish harness/unit validation from live model evaluation. Mocked tests and dry runs do not establish that a new prompt passes LLM regressions.


NEVER commit code that has not been tested by the human. Always wait for user confirmation that changes have been tested and work correctly before committing. If the user asks to commit and hasn't already said something equivalent to "looks great" (meaning testing passed), ask first: "Have you tested these changes?"

Exception: For COMMIT CHECKPOINT or COMMIT FEATURE, if the changes are documentation-only (e.g. Markdown updates in `docs/`, `README.md`, or other doc files), testing is not required. In that case, respond that tests were not run because it was docs-only.

---

# git
Do not run git commands without explicit user permission. Once permission is granted, execute the approved git command(s) using the shell tool so the user gets a Proposed Command confirmation.

NEVER do this: `rm -f .git/index.lock`

NEVER push to github automatically. The human will do that at their discretion.
