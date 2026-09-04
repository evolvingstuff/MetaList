# MetaList Code Review

Date: 2026-08-02

## Executive Summary

MetaList is generally disciplined: it has strong fail-fast invariants, clear encryption boundaries, extensive unit tests, and repository-native Python and JavaScript sanity gates. This review found no obvious hardcoded secrets, SQL injection, path traversal, or broad exception handlers that silently swallow internal failures.

The highest-value improvements are:

1. Bound memory, process, and upload resources.
2. Make global runtime state safe under concurrent FastAPI requests.
3. Make multi-database backup restoration atomic.
4. Replace raw request dictionaries with required request models.
5. Bound long-lived caches and undo history.

## Critical Findings

### 1. The built-in HTTPS proxy buffers complete requests and responses

**Files:** `main.py:503-547`

The HTTPS proxy reads the complete request body using `self.rfile.read(Content-Length)` and the complete backend response using `response.read()`.

Potential effects:

- A large request or response can consume unbounded memory.
- `StreamingResponse` endpoints are fully buffered by the proxy.
- Requests without `Content-Length`, including chunked requests, can be forwarded with an empty body.
- Large uploads and downloads may be held in memory by both the proxy and application.

**Recommendation:** Prefer serving TLS directly through an ASGI server. If the separate HTTPS listener must remain, implement bounded streaming in both directions, support chunked requests correctly, and enforce request-size limits before buffering data.

### 2. Shell execution has no practical resource boundary

**Files:**

- `app/static/js/modules/mode-manager/events/mouse-events.js:52`
- `app/services/shell_session_service.py:92-244`

The browser always requests a timeout of `0`, which disables the server timeout. The service retains stdout and stderr indefinitely, appending one character at a time, and does not cap concurrent runs.

Potential effects:

- A command such as `yes` can exhaust process memory.
- Long-running commands can remain alive indefinitely.
- Multiple shell notes can create an unbounded number of subprocesses and reader threads.
- Killing the parent shell may leave child processes alive because a new process session is created but the process group is not terminated.

**Recommendation:** Enforce server-owned maximum duration, output-byte limits, and concurrent-run limits. Truncate output explicitly with a visible marker. On POSIX, terminate the process group; use the equivalent process-tree termination mechanism on Windows.

### 3. Login throttling trusts a spoofable forwarding header

**Files:**

- `main.py:509-520`
- `app/api/routes/auth.py:542-553`

The HTTPS proxy preserves a client-provided `X-Forwarded-For` value and appends the actual address. The login route uses the first supplied address as the rate-limit key. A client can therefore rotate a forged first value to bypass login throttling.

**Recommendation:** The built-in proxy should replace externally supplied forwarding headers with values derived from the connected peer. The application should consume forwarded headers only when the immediate peer is a configured trusted proxy. Add an integration test that sends a forged `X-Forwarded-For` header through the HTTPS listener.

### 4. The database read guard is not concurrency-safe

**File:** `app/models/database.py:163-172`

`SafeSession.allow_reads()` changes a process-global `_reads_enabled` flag but releases `_read_guard_lock` while the context remains active. Overlapping contexts can restore stale values.

Example interleaving:

1. Context A observes reads disabled, then enables them.
2. Context B observes reads enabled.
3. Context A exits and disables reads while B is still active.
4. Context B exits and restores reads to enabled, leaving the guard open.

This can cause legitimate reads to fail during concurrent work and can leave post-startup reads enabled after the work finishes.

**Recommendation:** Use context-local state or a process-wide nesting counter protected for the complete transition. Holding the existing reentrant lock throughout the context is another option if serializing these read windows is acceptable. Add deterministic overlapping-context tests.

### 5. Archive restore is not atomic across the notes and files databases

**File:** `app/services/backup_service.py:724-786`

The restore path writes the notes database to its live destination before restoring or resetting the files database. If files restoration, checkpointing, or launch-profile rewriting fails, the namespace can be left with restored notes and an old or partially restored attachment database.

**Recommendation:**

1. Extract both databases into staging paths.
2. Validate manifest checksums, expected schema, `PRAGMA integrity_check`, and namespace metadata on all staged databases.
3. Preserve rollback copies of all existing targets.
4. Replace the target databases as one recoverable operation.
5. Restore every original target if any replacement or post-restore step fails.

Add failure-injection tests at each stage of the restore sequence.

## Quality and Reliability Findings

### 6. The view cache grows without eviction

**Files:**

- `app/services/view_cache.py:8-58`
- `app/api/routes/notes.py:209-216`
- `app/api/routes/notes.py:254-342`

The cache key includes client, tab, search string, and sort mode. Each distinct search can retain another complete `ViewState`. Normal search typing can therefore accumulate full snapshots for the lifetime of a passwordless process; cache clearing is limited to a few global events.

**Recommendation:** Use a bounded LRU with explicit entry and estimated-byte limits, or keep only the latest search state for each client/tab. Remove cache entries when tabs or clients are deleted and expose cache-size diagnostics.

### 7. Undo histories and client entries are unbounded

**File:** `app/services/undo_state.py:310-811`

Every client has unbounded history and redo lists. Entries can retain full before/after note content and complete deleted, pasted, or split subtrees. The `_clients` registry also has no inactivity eviction.

**Recommendation:** Define both operation-count and approximate-byte limits. Evict the oldest complete operations, preserve valid undo/redo boundaries, expire inactive clients, and add tests for truncation with large subtree operations.

### 8. Raw request dictionaries produce internal errors for malformed input

**Examples:**

- `app/api/routes/notes.py:161-169`
- `app/api/routes/notes.py:688-1229`
- `app/api/routes/ontology.py:122-230`
- `app/api/routes/reminders.py:97-221`

Many routes accept `dict` and immediately access required keys. FastAPI validates only that the body is an object; it cannot validate the required fields. For example, an empty body sent to `/notes/view` raises `KeyError` rather than producing a structured boundary error. The comment claiming FastAPI will validate those keys is incorrect.

**Recommendation:** Define strict Pydantic request models with required fields for every route. Avoid optional fields unless there is an explicitly approved protocol reason. Use validators for non-empty IDs, enums, numeric ranges, and nested viewport/undo structures. This will also make the generated OpenAPI contract accurate.

### 9. Password change contains an optional request field with a silent default

**Files:**

- `app/api/routes/auth.py:148-152`
- `app/api/routes/auth.py:1217-1233`

`PasswordChangeRequest.iterations` defaults to `None`, and the route silently substitutes the configured KDF cost. This conflicts with the repository policy that request fields should be required unless optionality is explicitly approved.

**Recommendation:** Prefer removing KDF tuning from the client contract and always use server configuration. If it must remain client-controlled, make it required and validate it at the request boundary.

### 10. Token and legacy synchronization state are not thread-safe

**Files:**

- `app/services/tokens.py:11-284`
- `app/services/sync_state.py:17-154`

Both modules mutate global dictionaries without locks. FastAPI uses worker threads for synchronous endpoints even though Uvicorn is configured with one process worker. Compound check/read/delete operations can race.

Potential effects:

- Revocation can occur between token verification and token lookup.
- Two requests can both observe an unlocked note and claim it.
- Iteration during mutation can raise runtime errors or return inconsistent snapshots.

**Recommendation:** Encapsulate compound operations under `RLock`, return immutable snapshots, and add concurrent token-revocation and note-lock-acquisition tests.

### 11. File uploads are fully buffered and general attachments have no size limit

**Files:**

- `app/api/routes/files.py:40-61`
- `app/services/file_storage.py:113-179`
- `app/api/routes/sounds.py:103-135`

General attachments are read completely into memory and have no per-file or library size limit. Sounds have persistence limits, but those limits are checked only after the complete upload is loaded.

**Recommendation:** Read uploads in bounded chunks, reject excess bytes immediately, and define per-file and aggregate-library limits for attachments. Apply independent limits in the HTTP layer, storage service, and HTTPS proxy.

### 12. Active note-tree operations can exceed Python's recursion limit

**Files:**

- `app/services/snapshot.py:519-618`
- `app/usecases/copy_note.py:29-44`
- `app/services/html_export.py:241-281`
- `app/presentation/render/note_renderer.py:316-416`

MetaList does not appear to constrain hierarchy depth, but view generation, clipboard rendering, export, and legacy rendering use recursive traversal. A sufficiently deep note chain can raise `RecursionError`.

**Recommendation:** Convert active hierarchy traversal to explicit stacks. If the product should impose a maximum depth, enforce it during mutations and validate it while hydrating existing data.

### 13. A dead legacy transaction/service subsystem remains in the application

**Files:**

- `app/services/base_service.py`
- `app/services/dependencies.py`
- `app/services/note_service.py`
- `app/services/query_service.py`
- `app/services/transaction_manager.py`
- `app/services/undo_service.py`

These modules have no active route callers and received zero coverage during the review. `TransactionManager.undo()` and `redo()` reference nonexistent `self.command_stack`. `note_service.py` also imports FastAPI's `HTTPException`, violating the documented service-layer boundary.

**Recommendation:** Remove the obsolete subsystem and any uniquely dependent model code after confirming there are no supported external imports. If it is intended for future use, migrate it to the active transaction and undo architecture and add tests before retaining it.

### 14. Backup reset performs the same deletion twice

**File:** `app/services/backup_service.py:257-266`

`_reset_file_database_to_empty()` executes `DELETE FROM files` twice before deleting sounds. This is harmless but is likely a copy/paste error.

**Recommendation:** Remove the duplicate statement and add a focused test that verifies both tables are empty after reset.

### 15. JavaScript test configuration is incomplete

**File:** `package.json:10-13`

The repository contains 306 passing Node tests, but `npm test` is the generated failing placeholder. Node also emits repeated module-type warnings because the package is not declared as an ES module.

**Recommendation:**

```json
{
  "type": "module",
  "scripts": {
    "test": "node --test tests/unit/*.mjs"
  }
}
```

Run this command in CI alongside pytest and the startup sanity gates.

## Maintainability Observations

### Large functions

The AST review found:

- 152 application functions longer than 50 lines.
- 55 application functions longer than 75 lines.
- 30 application functions longer than 100 lines.
- 8 application functions longer than 200 lines.

Notable examples:

- `app/services/note_store.py:220` — `load_from_db`, 280 lines.
- `app/services/snapshot.py:386` — `build_view_state`, 276 lines.
- `app/services/tag_suggestions.py:969` — `suggest_tags_for_note`, 250 lines.
- `app/services/undo_state.py:814` — `undo`, 245 lines.
- `app/services/undo_state.py:1061` — `redo`, 211 lines.
- `app/services/auth_service.py:239` — `set_password`, 204 lines.
- `app/services/auth_service.py:525` — `remove_password`, 205 lines.
- `app/api/routes/notes.py:161` — `view_diff`, 203 lines.

These functions should be divided along existing phases rather than mechanically split. Good extraction boundaries include validation, state preparation, persistence, in-memory publication, response serialization, and diagnostics.

### Coverage priorities

Application coverage measured during the review was 66%. Lower-coverage areas with meaningful risk include:

- `app/api/routes/auth.py`: 41%.
- `app/api/routes/notes.py`: 59%.
- `app/services/undo_state.py`: 38%.
- `app/services/hydration_state.py`: 36%.
- `app/services/namespace_deletion_worker.py`: 46%.
- `app/services/content_cache.py`: 18%.

The most valuable additional tests would cover:

1. Concurrent read-guard contexts.
2. Concurrent token revocation and note-lock acquisition.
3. HTTPS proxy streaming and forged forwarding headers.
4. Oversized uploads, downloads, and shell output.
5. Restore failure after each staged database operation.
6. Cache and undo eviction behavior.
7. Malformed request bodies returning stable client errors.
8. Deep note hierarchies.

### End-to-end boundary

The repository currently has no browser end-to-end harness. Unit tests cover many frontend services well, but they do not verify the complete behavior of authentication cookies, HTTPS proxying, uploads and downloads, restore/restart flows, or concurrent browser requests.

A small Playwright or Cypress smoke suite would provide high value for these cross-layer paths:

1. Start and establish a passwordless session.
2. Create a password, log out, and log in.
3. Create/edit/move/delete/undo a note.
4. Upload and download a file over HTTPS.
5. Create and restore a backup.
6. Restart and verify namespace state.

## Verification Performed

- Python tests: **631 passed**.
- JavaScript tests: **306 passed** using `node --test tests/unit/*.mjs`.
- Python startup sanity gate: **passed across 263 files**.
- JavaScript startup sanity gate: **passed across 139 files**.
- Python dependency consistency: **`pip check` passed**.
- Measured application coverage: **66%**.

The repository was not modified during the review itself. This document is the only artifact created from the review.
