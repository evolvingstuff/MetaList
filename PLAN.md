# MetaList review and remediation plan

Date: 2026-09-12  
Reviewed baseline: `43e0b259` (`misc`), clean working tree after the user's merge.  
Status: **F01–F05 human-tested and checkpointed (`93cca39d`). F06/F07/F08/F09/F12 plus complete sound removal human-tested and checkpointed (`97c06464`). F10/F11/F13/F14/F16 implemented and human-tested; checkpoint authorized. F15 was subsequently authorized and implemented below; F17/F18 were subsequently authorized and implemented in the fifth batch below.**

## Purpose and scope

Address the current code review's security, data integrity, concurrency, resource use, algorithmic efficiency, maintainability, testing, and documentation findings. The user authorized F01–F05, then F06/F07/F08/F09/F12, then removal of reminder sounds and the entire sound library. Other findings still require discussion. No code commit, merge, push, release tag, or publishing is authorized by this document.

The deployment assumption remains a personal application on a trusted computer/LAN. Confidentiality and recoverability take priority over availability-only hardening. The August review in `CODE_REVIEW.md` is historical evidence; its claims and line numbers must not be treated as current without rechecking them.

## Review evidence and limits

- Scanned 383 project Python files with AST-based structural checks; `app/` contains 225 Python files, 61,417 lines, and 2,539 functions, including 188 functions longer than 50 lines. These are review navigation metrics, not automatic defect counts.
- Inspected the active authentication, encryption, request transaction, backup/restore, AI disclosure/history, runtime purge, search/view, shell, packaging, and release paths, plus related frontend modules and documentation.
- Python suite with a disposable `METALIST_DATA_DIRECTORY`: **1,318 passed, 1 failed**. The failing importer test overrides `HOME` but inherits `METALIST_DATA_DIRECTORY`, then checks the wrong directory. That test **passed individually with the data-directory override unset**. Do not describe the original full run as all green; fix this test-isolation defect below.
- JavaScript suite: **628 passed**.
- Actual startup sanity checks: **passed**, reporting 376 Python files and 177 JS/JSX files. `BKP001` remains enforced.
- Installed dependency consistency: **`pip check` passed**. This is not a vulnerability audit.
- Markdown links checked in `README.md` and `docs/`: no missing local link targets found. Referenced plain-text paths and external links were not exhaustively validated.
- Synthetic failure injections reproduced lost attachment-key persistence, memory/SQLite divergence, partial restore, overlapping read-guard corruption, retained plaintext caches, and cross-provider conversation replay. No real namespace data or existing backups were changed.
- Evidence sizing experiment: 1,000 independent roots required 1,000,000 structure visits (~0.083 s); 2,000 required 4,000,000 (~0.293 s). These are local synthetic measurements, not production latency guarantees.
- Detailed probe scripts and logs are under `/tmp/metalist-review-20260912/`; that directory is temporary. Promote relevant probes into repository regression tests when their fixes are approved.
- This was a broad static review with targeted executable probes, not a formal verification or exhaustive manual inspection of every line. No live cloud requests, destructive load tests, current advisory database audit, full browser suite, new distribution build, or Windows/Linux validation were performed. Historical coverage percentages were not remeasured.

## Priority and evidence conventions

- **P1:** prioritize before routine refactoring because data, confidentiality, or a core workflow is affected.
- **P2:** concrete reliability/performance problems and important maintainability work.
- **P3:** lower-impact workflow/documentation improvements or defense in depth.
- **Reproduced:** exercised against current code with synthetic fixtures.
- **Code-confirmed:** the current implementation establishes the behavior; the complete failure scenario has not been exercised.
- **Opportunity:** a proposed improvement requiring measurement or a product decision, not a claimed vulnerability.

## Phase 1 — Data integrity and privacy

### F01 — Make password transitions recoverable across both databases

**P1 · Reproduced.** `app/services/auth_service.py:493`, `app/services/auth_service.py:796`, `app/services/file_storage.py:288`, `app/db/file_session.py:132`.

Attachment and sound rewrites commit through independent file-database transactions before the main request transaction commits the wrapped DEK. A simulated failure immediately after attachment encryption left `encryption_enabled=0`, no persisted wrapped key, and an encrypted attachment. After the transient key is gone, that attachment cannot be recovered from those live databases. The reverse transition can leave plaintext attachments after password removal fails.

- [x] Enlist notes and files/sounds in a durable, checksummed rollback journal before password creation/removal writes begin.
- [x] Preserve the complete previous database/key state until both databases are durable; recover interrupted operations before startup audit and migrations.
- [x] Hold storage maintenance through request commit/recovery and reject overlapping mutations.
- [x] Add failure tests after sidecar encryption/decryption and at main commit, alongside existing password/files/sounds coverage and process-exit recovery tests.

**Done when:** interruption at every boundary leaves either the complete previous state or a deterministic recoverable new state; no ciphertext loses its key and failed password removal does not silently expose sidecars.

### F02 — Enforce cloud privacy on conversation reuse

**P1 · Reproduced at the provider-context boundary.** `app/services/ai_chat.py:275`, `app/api/routes/ai.py:731`, `app/services/agent/context.py:61`.

The current scope is privacy-filtered, but `provider_messages()` includes all completed assistant prose regardless of the provider that generated it. An Ollama answer containing a cloud-blacklisted note's content is replayed when the next turn uses OpenAI. Tightening privacy settings or marking previously discussed content private also leaves prior prose available for replay. Citation stripping removes identifiers, not the sensitive answer text. No external request was sent during verification.

- [x] Retain the display transcript while starting a fresh model context on provider or disclosure changes.
- [x] Bind history server-side to the provider, policy, and namespace-wide permitted-note set; exclude unknown history provenance.
- [x] Cover provider changes, policy tightening, `@password`, deleted notes, and empty follow-up context with canary tests, including the AI route's generation input.
- [x] Document automatic history replay separately from user-typed disclosures in `docs/design/agent-harness.md`.

**Done when:** local-only or newly restricted note-derived prose cannot enter a cloud request through history, even when the current frozen scope is empty.

### F03 — Purge every plaintext-bearing cache on explicit lock/logout

**P1 · Reproduced.** `app/services/agent/evidence_serialization.py:46`, `app/services/tag_term_matching.py:140`, `app/services/runtime_lock.py:43`.

The evidence-token LRU uses complete note text and tags in its cache keys; tag-matching LRUs retain tag strings. The real purge function leaves these populated. This is retained live application state, beyond the documented limitation that released Python allocations cannot be forensically erased. Evidence entries can also retain old versions of large trees until eviction.

- [x] Clear evidence/token and all tag-matching LRUs with a synchronized sensitive-cache reset contract; disable caching while locked.
- [x] Invalidate registered AI streams and reject stale hydration/link-title results across logout and session replacement.
- [x] Stop shell runs, join output readers, and discard retained output during encrypted lock.
- [x] Exercise actual purge, locked-cache refill prevention, stale workers, stream cancellation, and a real POSIX shell process in tests.
- [x] Document retained-reference clearing separately from forensic memory erasure and transient network-worker variables.

**Done when:** the documented purge contract covers every sensitive store and worker; retain the honest distinction between clearing references and forensic memory erasure.

### F04 — Keep memory, search, undo, and SQLite consistent on request failure

**P1 · Reproduced.** `app/usecases/update_content.py:105`, `app/usecases/update_content.py:121`, `app/usecases/create_note.py:82`, `app/db/session.py:133`.

Inside a request transaction, exiting `begin_writer()` does not commit. Several usecases nevertheless update memory immediately afterward. A later exception rolls SQLite back while the NoteStore still contains the new text; the probe produced database=`before`, memory=`after`. Existing transaction tests check SQL rollback, not full runtime consistency.

- [x] Register request rollback hooks, restore undo/redo and sync snapshots, and rebuild persisted runtime state after failed writes.
- [x] Rebuild notes, content caches, search/backlinks/inherited tags, and persisted service stores only on failure; preserve existing intra-command read-your-writes behavior.
- [x] Cover failures after visible note mutation and during commit, checking both SQLite and served content/search/sync/undo state.
- [x] Surface database errors; if runtime recovery fails, revoke tokens and keep maintenance active.

**Done when:** after success, failure, cancellation, or commit error, persisted and served state agree; a failed request cannot leave a visible edit that disappears on restart.

### F05 — Make multi-database restore a recoverable operation

**P1 · Reproduced.** `app/services/backup_service.py:748`, especially the live notes copy at line 789 and subsequent sidecar copy.

Restore installs the notes database before the files database. Injecting failure at the second copy left restored notes and current attachments from different snapshots. The source archive remained byte-for-byte unchanged, so archive immutability works but does not provide live-destination atomicity.

- [x] Stage and validate archive/legacy components before live installation (archive checksums, SQLite integrity, supported database version, and existing namespace/profile checks).
- [x] Serialize current-namespace storage transitions with background publication; stop a verified non-current target server before restoring it.
- [x] Keep distinct live transaction images until the whole restore request completes, including profile and runtime-reset work.
- [x] Test second-database failure, process interruption, interrupted rollback/retry, invalid recovery checksums, missing original sidecars, and verified target shutdown.
- [x] Preserve all historical archive/legacy sources; keep BKP001 unchanged.

**Done when:** restore cannot leave a mixed live namespace; source archives and legacy sidecars remain unchanged in bytes and metadata throughout.

### Phase-one validation results

- Full Python suite with `METALIST_DATA_DIRECTORY=/tmp/metalist-phase-one-tests`: **1,346 passed**.
- JavaScript unit suite: **628 passed**.
- Startup sanity: **382 Python files and 177 JS/JSX files passed**, including unchanged BKP001 enforcement.
- Installed dependencies: **`pip check` passed**. `git diff --check` passed.
- The five original regression cases failed before implementation and pass with the fixes. Added coverage includes password-removal/commit failures, provider/policy/private-tag changes, stale workers, cancellation, shell teardown, failed runtime recovery, and subprocess exits before/after the durable recovery commit marker.
- Automated validation made no live cloud calls, existing-backup changes, or release actions. The user subsequently confirmed testing and requested COMMIT CHECKPOINT. Windows/Linux validation remains pending below.

### Phase-one acceptance

- [x] User confirmed testing completed and explicitly requested COMMIT CHECKPOINT. Individual manual scenarios were not separately reported.
- Recommended regression scenarios: password creation/unlock/removal with notes/files/sounds; restore and reopen for current/other namespaces; logout during AI/shell work; local-to-cloud conversation switching.
- [ ] Validate Windows/Linux behavior before release; local validation runs on macOS. Tests simulate process exit and storage errors, not physical power loss.

Implementation and operational details are in `docs/security/README.md`. Historical review line numbers above refer to the reviewed baseline. The importer test now explicitly isolates `METALIST_DATA_DIRECTORY`, allowing the full suite to use a disposable data directory reliably.

## Phase 2 — Request handling, concurrency, and resource limits

### F06 — Preserve streaming through HTTPS and bound proxy resources

**P1 for broken streaming; P2 for resource hardening · Code-confirmed.** `main.py:580–618`.

The proxy reads the complete request body and calls `response.read()` before sending response headers. AI streaming/progress therefore arrives only after backend completion over HTTPS. Chunked request bodies are not decoded, and complete bodies consume memory in the proxy as well as the application.

- [x] Decide between native ASGI TLS and retaining the separate proxy. Preserve existing HTTP/HTTPS namespace URLs and trusted-forwarding behavior.
- [x] If retaining it, implement bounded request/response streaming, explicit transfer-framing validation, disconnect cancellation, connection cleanup, deadlines, and bounded concurrent connections.
- [x] Support chunked requests correctly or reject them explicitly before forwarding; do not silently replace a body with empty bytes.
- [x] Add a real listener test proving that the first chat/progress chunk reaches an HTTPS client before the backend completes, plus upload/download and disconnect tests.

**Done when:** HTTPS preserves incremental behavior and bounded memory without weakening Host, Origin, or forwarding-header checks.

**Implemented:** retained the separate proxy; 64 KiB chunks, bounded workers/deadlines, explicit incoming chunked rejection. TLS first-chunk, binary round-trip, HEAD and framing regressions cover transport behavior. Disconnect cleanup occurs when detected by I/O or the idle timeout.

### F07 — Fix read-guard concurrency and audit shared-state access

**P2 · Read-guard defect reproduced; remaining synchronization audit is an opportunity.** `app/models/database.py:178`, `app/services/tokens.py:14`, `app/api/transactions.py:47`, `app/services/bulk_operation.py:19`.

Overlapping `SafeSession.allow_reads()` scopes restore stale process-global values: A exits while B is active and disables B's reads; B then leaves reads enabled globally. Token compound operations also lack their own synchronization. Synchronous mutation routes already share a bulk-operation lock, so do not assume every old lock-race finding remains reachable; async routes, middleware, GETs, hydration, and background workers need separate analysis.

- [x] Replace temporary process-global permission changes with context-local read permission layered over the global startup state.
- [x] Add deterministic overlapping-thread/task tests that verify allowed scopes and unrelated denied reads simultaneously.
- [x] Map lock ownership and lock ordering for auth/token operations, sync/clipboard, NoteStore/search publication, hydration, and bulk operations.
- [x] Reproduce reachable races before changing synchronization; make compound operations atomic and return snapshots rather than mutable shared objects.
- [x] Verify async routes cannot interleave shared mutations in ways the synchronous wrapper prevents; avoid thread locks held across asynchronous waits.

**Done when:** concurrent requests cannot leave the read guard open, invalidate another scope's permission, or expose partially updated runtime state.

**Implemented:** ContextVar read scope; token/sync RLocks; deep clipboard snapshots; atomic bulk admission; loop-safe answers; async transaction contention returns 409. Lock ownership and remaining cross-GET snapshot limitations are documented in `docs/security/README.md`.

### F08 — Validate external input at the HTTP boundary

**P2 · Code-confirmed.** `app/api/routes/notes.py:189`, `app/api/routes/notes.py:909`, `app/api/routes/auth.py:145`, `app/main.py:137`, `app/security/request_boundary.py:111`.

Many routes accept raw dictionaries and index required keys; `{}` for a view request raises `KeyError` rather than schema validation. Separately, the default validation handler converts Pydantic request errors into internal errors. Host/Origin parsing also calls `urlsplit()` outside its ValueError handling, so malformed bracketed hosts can escape as server errors. These are external-input failures, not internal invariants.

- [x] Introduce required request models and reusable typed viewport/tab/undo structures, enums, lengths, and numeric limits. Preserve intentional nullable values only after discussing their protocol meaning; do not silently add optional fields.
- [x] Return sanitized stable 4xx responses for invalid bodies, headers, stale IDs, and unsupported actions, while preserving loud failures for actual programming errors.
- [x] Audit invalid Host/Origin parsing and duplicate/framing headers at both application and proxy boundaries.
- [ ] Optional future protocol simplification: discuss removing client `iterations`. Compatibility is retained in this batch, with server-supported min/max validation.
- [x] Verify generated OpenAPI describes the real required contract; test malformed input through the full middleware stack rather than only calling helpers.

**Done when:** bad external input does not masquerade as an internal defect or mutate state, and internal bugs remain visible.

**Implemented:** strict required TypedDict contracts preserve the existing explicit-null root/search/viewport protocol; note action enums match browser payloads. Preferences/usage validate before persistence; sanitized 422, malformed/duplicate headers return 4xx, obsolete v1 returns 410. A disposable real-app subprocess tests the complete middleware stack.

### F09 — Bound attachment uploads before allocation

**P2 · Code-confirmed.** `app/api/routes/files.py:45`, `app/services/file_storage.py:113`, sound library removed.

General uploads use an unbounded `await file.read()` and have no attachment size cap. Sounds enforce their storage policy only after reading the upload. Encryption/download paths also materialize complete blobs.

- [x] Discuss per-file limits and whether an aggregate namespace quota is useful; choose limits from actual expected usage.
- [x] Read in bounded chunks and reject excess bytes early, including uploads without a trustworthy Content-Length. Keep a service-level guard for non-HTTP callers.
- [x] Coordinate HTTP, multipart/spool, proxy, encrypted blob, and download memory bounds; measure large-file behavior rather than claiming that `StreamingResponse(BytesIO(...))` is incremental storage I/O.
- [x] Test exact-limit/over-limit uploads, cancellation, temp-file cleanup, and unchanged DB/registry state on rejection.

**Decision/implementation:** use configurable 100 MiB per attachment, no aggregate quota. Incoming multipart bytes are capped before spooling completes; four attachment transfers admitted at once. Storage validates independently. Metadata/bootstrap omit blobs; downloads preflight length, and legacy files above the cap require increasing the limit. Password transitions process one complete file at a time. Sound upload/library code is removed. AES-GCM still uses per-file buffers; this is bounded whole-file storage, not streaming cryptography.

### F10 — Bound shell execution and integrate it with session teardown

**P2 · Code-confirmed; only applies when shell capability is explicitly enabled.** `app/services/shell_session_service.py:92`, `app/services/shell_session_service.py:188`, `app/services/shell_session_service.py:201`.

Timeout zero disables the deadline; each output character is retained as a list entry, full output is rejoined on every poll, and active runs have no concurrency/output cap. Timeout kills the shell process but does not deliberately terminate its process tree; reader joins can wait for descendants that retain pipe handles. Completed-output retention is pruned only on later activity.

- [x] Discuss server-owned duration, concurrent-run, and output-byte caps, plus explicit behavior for long-running commands.
- [x] Buffer in chunks with bounded retained output and an explicit visible limit condition; return incremental output using a cursor if useful.
- [x] Terminate process groups on POSIX and process trees on Windows; verify pipes/readers finish.
- [x] Cancel or deliberately detach jobs under an agreed policy on logout, restore, and namespace shutdown; clear sensitive output.
- [x] Use small bounded subprocess fixtures for timeout/descendant tests. Do not load-test by running an uncontrolled infinite-output command.

### F11 — Bound view caches, undo history, and obsolete client state

**P2 · Code-confirmed.** `app/services/view_cache.py:9`, `app/services/undo_state.py:286`, `app/services/agent/evidence_serialization.py:46`.

Each distinct client/tab/search/sort view keeps another complete snapshot with no eviction. Undo/redo and client registries likewise retain arbitrary numbers of payloads. An entry-count bound alone is insufficient for caches whose entries contain complete trees.

- [x] Prefer one current diff baseline per active client/tab where compatible; otherwise use measured byte and entry budgets with lifecycle eviction.
- [x] Define undo operation/byte limits and user-visible semantics for evicting old complete operations; preserve valid undo/redo and bulk-operation boundaries.
- [x] Evict closed tabs, superseded sessions, expired clients, and obsolete cached tree versions; integrate with F03.
- [x] Add hit/miss/size diagnostics containing counts only and tests proving repeated searches/edits stay within bounds.

## Phase 3 — Algorithmic efficiency

### F12 — Remove repeated full-scope scans during AI evidence sizing

**P2 · Reproduced and measured.** `app/services/agent/investigation.py:169–201`.

For every retained root, `_full_root_token_cost()` scans every frozen structure node to find that root's members. With R roots and N nodes this costs O(R × N), even when token estimates are cached. Independent roots produce quadratic visits.

- [x] Group structure nodes by root once alongside evidence-note grouping, or retain those groups in the immutable scope representation.
- [x] Preserve canonical order, complete-root prefix semantics, privacy filtering, exact omitted counts, and cache invalidation.
- [x] Add a deterministic operation-count regression with 1,000/2,000 roots; measure cold/warm behavior with small and large root payloads.

**Done when:** grouping/visiting structure is O(N) per retention pass, excluding necessary serialization and within-root ordering work.

**Implemented:** one root→structure grouping pass; deterministic 1,000/2,000-root regressions assert 1,000/2,000 visits. Existing cache/budget/order/privacy tests remain green.

### F13 — Reduce repeated full-tree work in sorted views and auth requests

**P2 · Implemented and profiled on synthetic namespaces.** `app/services/root_sorting.py:69`, `app/services/root_sorting.py:100`, `app/services/snapshot.py:551`, `app/api/middleware/auth.py:117`, `app/models/database.py:63`, `app/db/schema.py:197`.

Sorted snapshots compute root metrics across the namespace before filtering/windowing; content-volume sorting reparses every note's HTML on each request. Protected requests open a synchronous SafeSession in async middleware, and every connection reruns schema initialization and table inspection. This contradicts the broad documentation claim that runtime view requests perform no SQLite reads.

- [x] Profile representative large namespaces for normal, timestamp, alphabetical, content-volume, filtered, and no-change views.
- [x] Reuse sanitized cached plain text and maintain root aggregate timestamps/lengths with invalidation for edits, moves, deletes, restore, and undo.
- [x] Separate one-time schema bootstrap/migration from normal connection setup; keep auth state memory-owned with explicit transition updates.
- [x] Keep blocking I/O off the event loop and measure request latency, connection counts, SQL statements, and allocations before/after.
- [x] Clarify intentional runtime DB exceptions such as attachment reads and version inspection instead of weakening the architectural contract silently.

### F14 — Remove recursion limits from supported note hierarchies

**P2 · Code-confirmed risk; supported depth is now 256 levels.** `app/services/snapshot.py:634`, `app/services/agent/evidence_serialization.py:155`, `app/services/html_export.py:240`, `app/usecases/copy_note.py`.

Rendering, export/copy, and evidence serialization recurse through user-controlled note depth. Some ancestor walks repeat full paths, and evidence serialization copies an ancestor set at every level. No consistent maximum hierarchy depth was identified.

- [x] Discuss whether arbitrarily deep imported trees are supported or a documented depth limit is appropriate.
- [x] Prefer iterative traversals and memoized ancestor/root resolution for supported data; retain cycle detection and deterministic ordering.
- [x] Test a deep valid chain and cycles across hydration, view, copy, export, and AI evidence. Account for JSON encoder/browser limits as well as Python traversal.

## Phase 4 — Refactoring and developer workflow

### F15 — Consolidate state ownership and split large modules by responsibility

**P2 · Opportunity, with concrete legacy defects.** `app/services/note_store.py:85`, `app/services/store.py:11`, `docs/REFACTORS.md`, `app/services/transaction_manager.py:122`, `app/services/note_service.py:2`.

- [x] Make note ordering have one authoritative representation. `_links/_heads/_tails` and record `prev_id/next_id` currently duplicate state; retain local invariants while migrating callers and serialization.
- [x] Confirm supported external imports, then remove the unused legacy service/transaction/query/undo subsystem. The old `TransactionManager.undo()/redo()` reference nonexistent `command_stack`, and old `NoteService` imports FastAPI into the service layer.
- [x] Split auth transitions into prepare/persist/publish/recover phases after F01/F04; extract AI stream lifecycle, view selection/render/diff, and formatting handlers along established responsibility boundaries.
- [x] Prioritize the 319-line chat handler, 297-line view builder, 290-line hydration method, 250-line tag-suggestion function, and 244/241-line password transitions. Avoid mechanical splitting solely to satisfy a line-count threshold.
- [x] Move routine function-local imports in active usecases to module scope; preserve documented circular-import or startup-order exceptions only where necessary.
- [x] Replace ambiguous names and untyped state dictionaries at edited boundaries. Count meaningful assertions/validations and enforce invariants where needed; do not add redundant assertions merely to reach a percentage.
- [x] Audit broad exception/fallback paths for hidden internal failures, but preserve handling for network, file I/O, invalid input, and legitimate absent-state cases. `CapturedExceptionContext` is still exception handling and must receive the same scrutiny as `try/except`.

Implementation is complete; the user confirmed testing and requested COMMIT CHECKPOINT. The original references above identify the reviewed state; current ownership and the documented import exceptions are in `docs/REFACTORS.md`.

**Done when:** active behavior is preserved under targeted tests, ownership is explicit, and obsolete code no longer disguises a second architecture.

### F16 — Make test commands and isolation reliable

**P2 for isolation; P3 for command cleanup · Reproduced/code-confirmed.** `tests/unit/test_convert_from_legacy.py:204`, `package.json:10`, `docs/testing/harness.md`.

- [x] Fix the importer subprocess test to explicitly set or clear `METALIST_DATA_DIRECTORY` along with namespace/port overrides; assert that no path outside its fixture root is changed.
- [x] Establish a disposable-root test bootstrap before application imports and audit subprocess environment inheritance, file/memory DB switching, global singleton reset, and test ordering.
- [x] Replace the failing `npm test` placeholder with the real Node test command. Assess module-type declarations against all existing tooling before changing them.
- [x] Add focused integration tests for the reproduced gaps; existing helper-level tests and startup AST checks do not establish cross-component correctness.
- [x] Discuss a minimal browser smoke suite for login/logout, edit/undo, HTTPS streaming, attachment round-trip, and restore/restart. The project deliberately removed Cypress; do not automatically restore a large browser framework.
- [x] Measure branch/line coverage if useful, prioritizing failure boundaries over a blanket percentage target. Do not reuse the August review's 66% figure as a current measurement.

### F17 — Complete supply-chain verification without duplicating existing release gates

**Initial P3 review opportunity; the subsequent audit found and patched affected vendored browser versions.** `.github/workflows/publish-pypi.yml`, `pyproject.toml`, `uv.lock`, vendored assets under `app/static/js/vendor/`.

- [x] Run a current known-vulnerability audit of the resolved Python graph and inventory vendored browser libraries with versions/provenance. Verify findings against primary advisories before recommending upgrades.
- [x] Discuss locked/hash-verified transitive installs in CI and immutable commit-SHA pins for third-party Actions, with an update process.
- [x] Preserve the existing Python/JS/sanity gates, wheel/sdist resource verification, clean installed-package smoke matrix, and publication of the tested artifacts.
- [ ] Confirm exact-commit evidence across Windows/macOS/Linux and every supported Python version before any separately authorized release tag. Never tag first to discover failures afterward.

Implementation and local audit are complete; see `docs/security/supply-chain.md`. The unchecked exact-commit platform requirement is conditional on a separately authorized release and cannot be satisfied by this local working tree.

## Phase 5 — Documentation and closeout

### F18 — Reconcile documentation with the implemented system

**P3 · Confirmed drift, with good existing feature coverage.** `docs/AI-SUMMARY.md`, `docs/security/README.md`, `docs/security/FUTURE-SECURITY-WORK.md`, `docs/testing/harness.md`, `CODE_REVIEW.md`.

- [x] Update `docs/AI-SUMMARY.md`: one section still reports database version 5 while current code reports 9 after sound retirement; its old trigram description conflicts with the implemented scan-based text search and newer summary text.
- [x] Reconcile the memory-first contract with authentication/schema reads and deliberate attachment/version exceptions; update it again after F13.
- [x] Correct security text describing first-hop `X-Forwarded-For` throttling and a single login KDF operation; current code uses trusted request-client metadata and separate verifier/KEK derivations.
- [x] Refresh deferred-security documentation: full tests, artifact resource checks, and installed-package platform validation are now implemented, while vulnerability auditing and immutable Action pins remain separate opportunities.
- [x] Document the agreed provider/history boundary, cache purge and in-flight cancellation contract, password-transition/restore recovery protocol, quotas, shell lifecycle, and supported hierarchy depth as their fixes land.
- [x] Add a failure-recovery runbook distinguishing live database migrations from immutable archives. Never suggest modifying an existing backup to repair or upgrade it.
- [x] Mark the August review as historical or add a dated finding-status index after discussion. Preserve historical results; do not silently overwrite them with current test counts.
- [x] Maintain a compact mapping of feature → implementation → tests → docs. Update touched docs within each implementation batch instead of postponing all documentation until the end.
- [x] Validate setup/test examples in disposable environments and check external links as a separate read-only documentation pass.

## Prior review items already addressed

Do not reopen these as current defects without new evidence:

- Forwarded-header spoofing: the HTTPS proxy now strips supplied forwarding headers and writes the actual peer address; login uses `request.client.host`.
- Shell exposure: explicit launch capability, password protection, and loopback client/host checks exist. F10 concerns resource/lifecycle behavior within that authorized capability.
- Duplicate file-table deletion during backup reset: files are deleted once; the sound table has been retired.
- Missing Python/JS CI gates and installed-package validation: these now exist in the release workflow. F17 concerns the remaining audit/pinning work.

## Decisions for discussion

1. **Implementation order:** agree to prioritize F01–F05 before broad refactoring, while treating broken HTTPS streaming (F06) as an independent high-priority workflow fix.
2. **Cloud conversation behavior:** fresh model context on provider/policy changes, or provenance-aware retained history? Recommended initial scope is the conservative fresh-context boundary.
3. **Durable recovery architecture:** staged live databases plus a recovery journal, or a larger storage consolidation? Decide once for password transitions and restore.
4. **Quotas and retention:** this batch uses a configurable 100 MiB attachment default. Aggregate namespace quotas remain deferred. The third batch uses the documented configurable undo/cache/shell defaults.
5. **TLS implementation:** retain and repair the proxy, or serve TLS directly while preserving current URLs and launch behavior?
6. **Hierarchy support:** iterative support for deep trees, a declared maximum depth, or both?
7. **Testing scope:** agree on a small integration/browser layer and dependency-audit cadence without recreating a costly broad UI harness.
8. **Refactoring scope:** confirm compatibility requirements before deleting legacy modules or changing request schemas.

## Execution and acceptance protocol

- [x] Discuss and approve F01–F05, then F06/F07/F08/F09/F12 and complete sound removal; F10/F11/F13/F14/F16 and then F15 were subsequently authorized; F17/F18 were then authorized with “okay, do those two.”
- [x] Preserve the original plan in documentation checkpoint `9b8a323a`. The user has now authorized a separate checkpoint for the tested F01–F05 implementation.
- [ ] For each agreed batch, inspect the then-current tree and branch state and follow the repository's branch/git permission rules. Do not push automatically.
- [ ] For bug fixes, first convert the applicable probe into a minimal regression and demonstrate failure for the correct reason; then implement and run the relevant tests.
- [ ] Keep security/data-integrity fixes and broad refactors in separate reviewable batches. Preserve backup immutability, fail-loud internal invariants, and the existing release gates throughout.
- [ ] Run affected tests and startup checks per batch. Before committing application changes, obtain the user's confirmation that they tested the behavior; follow the checkpoint test policy.
- [ ] At completion, run the full isolated Python/Node suites, dependency consistency checks, and necessary integration/distribution/platform checks for the changes made. Record actual results and outstanding limitations.
- [ ] Update relevant documentation and the finding-status checklist. Follow COMMIT FEATURE only when explicitly requested; remove `PLAN.md` as part of that approved workflow, preserving durable architecture/recovery decisions in `docs/`.

F01–F05 and the second batch including sound removal are checkpointed. The user authorized F10/F11/F13/F14/F16 with “go for it”; the user confirmed testing and requested COMMIT CHECKPOINT for this third batch. F15 was subsequently authorized and implemented below; F17/F18 were subsequently authorized and implemented in the fifth batch below. This checkpoint does not merge the branch or authorize pushing or release actions.


## Added scope — remove all sound support

- [x] Remove reminder sound controls/defaults, manager command/modal, playback service, API, storage SQL/service, and `mutagen` dependency/lock entry.
- [x] Migration 8→9 strips retired live reminder/client fields and drops the live `sounds` table; encrypted migration runs after unlock. Preserve unrelated reminders, preferences, and attachments.
- [x] Keep all historical backup artifacts byte-for-byte unchanged; test plaintext/encrypted migration and idempotent retries.
- [x] Update reminder, sound-retirement, security, and AI overview docs.
- [x] User confirmed this batch was tested and requested COMMIT CHECKPOINT. Individual manual scenarios were not separately recorded.

The user confirmed testing and authorized this checkpoint. Final validation results are recorded below; remaining plan items stay deferred.

### Second-batch validation (2026-09-12)

- Full isolated Python suite: **1,375 passed** (8.02 s), one Starlette TestClient deprecation warning. Actual local HTTP/TLS listeners were enabled for transport tests; no real namespace was used.
- Node suite: **628 passed**. Python startup sanity: **386 files passed**; JS startup sanity: **175 files passed**. `BKP001` remains enforced. `git diff --check` and installed `pip check` passed.
- Final wheel and source distribution built successfully with cached build dependencies. `scripts/check_distribution.py` verified **424 runtime files** in both artifacts and imported packaged agent resources outside the checkout. Removed sound modules and `mutagen` are absent from the wheel.
- Real application middleware tests cover valid view requests, malformed Host/Origin, missing note/ontology fields, invalid client preferences/reminder dates, stale tabs, and retired v1 responses. Transport tests cover first-chunk delivery before completion, binary upload/download, HEAD, ambiguous framing, disconnection, and truncated upstream bodies. Resource tests cover exact/excess upload sizes, cancellation, multipart temporary-file cleanup, and transfer-slot release.
- Plaintext/encrypted sound migration tests preserve unrelated reminder/preferences and attachment bytes, remove the legacy sound table, verify idempotent reruns, and hash an existing backup before/after to establish immutability.
- Synthetic root-cost benchmark (grouping plus every root cost, fresh cache then warm cache): 1,000/2,000 roots with 10 characters each took **14.50/28.47 ms cold**, **2.12/4.42 ms warm**; with 2,000 characters each, **118.35/238.26 ms cold**, **2.25/4.40 ms warm**. Independent-root visit regressions enforce 1,000/2,000 visits instead of 1,000,000/4,000,000. Local synthetic timings are not production latency guarantees.
- A 100 MiB in-memory attachment fixture read in **0.197 s**, peaking at **204.50 MiB additional traced reader allocations**; the source fixture buffer and later encryption allocations are excluded. The stream was closed. This establishes whole-file buffering cost rather than claiming constant memory; transfer admission and configurable per-file bounds limit concurrency and size.
- No Windows/Linux validation, full interactive browser test, installed-application startup matrix, or release was performed. The user subsequently confirmed testing and authorized a checkpoint. No merge, push, or release is authorized.

- Checkpoint verification: pytest rerun after human confirmation — **1,375 passed** (7.82 s), one existing TestClient deprecation warning.


## Third batch — F10/F11/F13/F14/F16 (2026-09-12)

The user authorized all five recommended items. Optional limit questions received no reply; implementation uses the stated recommended defaults. The user subsequently confirmed testing and authorized a checkpoint. Cross-platform validation remains outstanding.

- **F10:** shell runs read 4 KiB chunks, share a 4 MiB stdout/stderr cap, enforce 30 minutes even for timeout zero, admit four concurrent runs, and expire completed output after five minutes without requiring another request. Logout/session replacement, restore, lock, and shutdown terminate runs. POSIX process-group integration tests pass; Windows descendant-enumeration command has a unit test but has not run on Windows. Polling expired runs returns 404. Full bounded snapshots preserve the existing browser protocol; no cursor API was needed.
- **F11:** one current baseline per client/tab, 64 MiB/32-entry view LRU, 100 whole undo operations per context with a 32 MiB global payload budget, and 32 clients with 30-minute idle expiry. Server clipboards share a separate 32 MiB budget. Sensitive function caches have 16 MiB budgets each. Eviction uses whole operations; an oversized untracked edit clears older undo/redo to prevent undo across a missing operation. The UI explains when history has been limited. Session replacement and logout clear client state. View diagnostics expose only counts/estimated bytes. Limits bound retained Python objects, not process RSS or transient request buffers.
- **F13:** revision-aware subtree timestamp/volume aggregates, bounded alphabetical keys, reuse of unchanged content lengths, memory-owned ordinary auth checks, and schema bootstrap once per live database identity. Restore/recovery invalidates schema state. Timestamp sorting does not parse HTML. Views still spend time rendering and hashing visible content; broader render-pipeline refactoring stays under F15.
- **F14:** 256 levels including the root, validated during hydration and before live inserts/reparenting. Iterative view/copy/export/evidence traversal and memoized ancestor walks preserve ordering and reject cycles. Regression coverage exercises a 256-level chain across hydration, view, clipboard, HTML export and JSON evidence, plus over-limit writes and cycles. Existing backups are never transformed; invalid restored live data fails validation/recovery.
- **F16:** pytest clears inherited namespace/runtime overrides and establishes a fresh data root before app imports. `npm test` runs the real Node suite. A small Puppeteer script uses the browser dependency already present through Mermaid tooling, with no Cypress restoration. It tests edit/undo/reload, attachment round-trip, password setup/login/logout, encrypted backup restore, actual process re-exec, reauthentication, and archive SHA-256 immutability. HTTPS first-chunk behavior remains covered by the real TLS integration tests rather than an external AI/browser dependency. A blanket coverage percentage was not measured; tests target changed failure boundaries.

### Third-batch profiling

Synthetic macOS fixture: 10,000 notes, 1,000 roots, roughly 2,000 text characters per note, default root window. Compare the checkpoint implementation with this batch. Warm timings include generating and verifying an empty no-change diff; filtered timings use a precomputed 100-root scope and exclude search matching itself. These are local measurements, not production latency promises.

| View | Before cold / warm (ms) | After cold / warm (ms) | Before / after warm peak (MiB) |
|---|---:|---:|---:|
| normal | 328.8 / 327.94 | 407.08 / 326.99 | 2.14 / 2.14 |
| created | 339.44 / 338.0 | 363.76 / 337.56 | 2.18 / 2.18 |
| updated | 355.52 / 342.47 | 345.28 / 339.76 | 2.18 / 2.18 |
| alphabetical | 361.43 / 349.85 | 353.59 / 333.93 | 3.97 / 2.14 |
| content-volume | 520.98 / 519.95 | 532.83 / 329.69 | 2.15 / 2.14 |
| filtered-volume | 522.76 / 520.33 | 526.13 / 329.28 | 2.15 / 2.14 |

Twenty in-memory connections executed **400 SQL statements before, 120 after**, including per-connection PRAGMAs; elapsed time was **1.80 ms → 0.47 ms**. An authenticated middleware regression forbids opening any SQLite connection for an ordinary protected route. Auth status/version inspection, attachment access, startup/login/restore, and topology validation within writes remain intentional database access points.

### Third-batch validation

- Full isolated Python suite: **1,397 passed** (9.35 s), one existing Starlette TestClient deprecation warning. Final timestamp regression first failed, then passed: aggregate caching must not hide malformed descendant dates.
- Node suite: **628 passed**. Startup sanity: **390 Python files**, **175 JS/JSX files** passed; `BKP001` remains enforced.
- Final browser smoke passed all scenarios above, including the empty-undo info banner after restore/session replacement. Disposable result/log directory: `/var/folders/ms/_3pl0plx0kj8fnkmcfs1mjt80000gn/T/metalist-browser-y3lkfc`.
- Wheel and source distribution rebuilt successfully; **426 runtime files** verified in both artifacts and agent resources imported outside the checkout. `pip check` and `git diff --check` passed.
- macOS validation only. Windows/Linux execution, the full installed-application release matrix, and a dependency vulnerability audit were not performed in this batch. Existing exact-commit release gates remain required before any separately authorized release.

The user confirmed testing and requested COMMIT CHECKPOINT. No merge, push, or release is authorized.

- Third-batch checkpoint verification after human confirmation: **1,397 pytest tests passed** (9.34 s), with the existing Starlette TestClient deprecation warning.


## Fourth batch — F15 (2026-09-12)

The user authorized the staged state-ownership and responsibility refactor with “okay, sounds good. proceed.” Implementation is complete; the user confirmed testing and requested COMMIT CHECKPOINT for this batch. F17/F18 were subsequently authorized and implemented in the fifth batch below. Touched architecture/security/testing documents are updated here.

- Immutable note records are the ordering authority; only derived head/tail boundaries remain. Local invariants cover touched neighbors. Bulk source/destination moves publish together; hydration and bulk metadata validate complete ordering/hierarchy before replacing the tree. Public snapshots retain their pointer fields.
- Removed six verified-unused legacy service/transaction/query/undo modules; the active `store.py` adapter and `undo_state.py` remain. No supported external import API was found for the removed files.
- Separated password note rewrites and persistence/publication phases, chat turn lifecycle, view selection/rendering, hydration/search/matcher phases, JSON/CSV rendering, and tag candidate scoring/ranking. Kept existing request and response contracts.
- Moved five routine usecase imports to module scope; documented the four remaining circular-import exceptions. Added typed boundary results and meaningful integrity checks.
- Removed search content from active undo reset logs; internal interface/metadata/invariant failures now raise. Expected external errors and legitimate absent-state behavior remain. Stream sources close on exit; internal stream defects fail the turn and propagate.
- Ranking combination uses membership sets rather than repeated list scans. Hydration reuses its plaintext mapping for matcher inference. No end-user latency speedup is claimed without a dedicated benchmark.

The user confirmed testing and authorized this checkpoint. Validation results follow. No merge, push, or release is authorized.

### Fourth-batch validation

- Full isolated Python suite: **1,411 passed** (9.55 s), with one existing Starlette TestClient deprecation warning. Listener-based HTTP/TLS tests ran against disposable state.
- Node suite: **628 passed**. Startup gates: **390 Python files**, **175 JS/JSX files** passed; `BKP001` remains enforced. `pip check` and `git diff --check` passed.
- Browser smoke passed edit/undo, sibling move/delete/undo with ordering after reload, attachment round-trip, password setup/login/hydration/logout, encrypted backup restore with actual restart, and unchanged source archive SHA-256. Disposable artifacts: `/var/folders/ms/_3pl0plx0kj8fnkmcfs1mjt80000gn/T/metalist-browser-K5jnGL`.
- Wheel and source distribution built with cached dependencies. **424 runtime files** verified in both artifacts; packaged agent resources imported outside the checkout. All six retired modules are absent from both distributions.
- Edited application modules contain **45 assertion statements and 412 explicit raises**, including pre-existing checks. These counts are an inventory, not a correctness or coverage percentage. The new tests target concrete ordering, publication, encryption, stream, and interface invariants.
- The targeted coordinating functions now span 86 lines (chat), 152 (view assembly), 83 (hydration), 157 (tag suggestions), and 73/69 (password setup/removal). Meaningful helper boundaries preserve the visible sequence of operations rather than forcing every coordinator below 50 lines.
- Local macOS validation only. Windows/Linux execution, the complete installed-application release matrix, vulnerability auditing, and live external AI provider testing were not performed. Existing release gates remain required. The user subsequently confirmed testing and authorized a checkpoint.

- Fourth-batch checkpoint verification after human confirmation: **1,411 pytest tests passed** (9.39 s), with the existing Starlette TestClient deprecation warning.


## Fifth batch — F17/F18 (2026-09-12)

The user authorized both remaining workstreams. Implementation and local validation are complete; the user confirmed testing and requested COMMIT CHECKPOINT for this batch.

- **F17 audit:** pip-audit 2.10.1 checked all 94 locked package/version pairs, including every platform marker branch and the new pinned release tools, with no known Python vulnerabilities. The existing 71-package runtime/development graph retains its versions.
- **Browser advisories:** npm archive comparisons established exact bundle provenance, including the unversioned markdown-it 10.0.0 file. OSV reported 14 matching advisories across Mermaid, DOMPurify and markdown-it; all were checked against maintainers' GitHub advisories. Updated to Mermaid 11.16.1, DOMPurify 3.4.13 and markdown-it 14.3.2; zxcvbn 4.4.2 remains. Follow-up queries for all four versions returned no known advisories. Applicability conditions and residual audit limits are documented; version matching is not proof of exploitability in MetaList.
- **CI:** hash-bearing runtime/CI exports, pinned release tools, immutable full Action commits, export/vendor/pin checks, and advisory gates. Build uses the pinned backend without isolation. Installed platform jobs install locked runtime dependencies and the same wheel with `--no-deps`. Existing full matrix/publication requirements remain intact. Distribution checks also reject obsolete vendor bundles. No release workflow was dispatched.
- **F18:** corrected schema/search/auth/KDF/password-policy/read-guard text, reconciled implemented release controls, added recovery and supply-chain runbooks and a feature/test/doc map, and marked the August review historical without changing its original measurements. Source setup now quotes editable extras and installs hash-verified dependencies first.
- **Documentation checks:** all 41 Markdown files scanned for local Markdown links with no missing destinations; all 15 external Markdown links returned success. Hash-verified CI install, editable source install and clean installed-wheel setup outside the checkout were exercised. Browser and test commands ran; Windows setup syntax is documented but was not executed locally.

Final validation details follow below. The remaining unchecked items are the conditional Windows/Linux/exact-commit release gate, the optional client `iterations` API decision, and feature closeout when explicitly requested. Existing process checklist entries remain ongoing obligations rather than additional product defects. The checkpoint is authorized; merge, push, and release are not authorized.

### Fifth-batch final validation

- Checkpoint rerun after human testing: **1,421 passed** (9.33 s), one existing Starlette TestClient deprecation warning.
- Full isolated Python suite: **1,421 passed** (9.64 s), one existing Starlette TestClient deprecation warning. Node: **628 passed**. Startup gates: **392 Python files**, **175 JS/JSX files** passed; `BKP001` remains enforced.
- Supply-chain checks passed even with an empty uv cache: exact lock exports, complete vendor coverage/checksums/licenses, and full Action commit pins. All 71 pre-existing registry package versions were retained; 23 release/audit dependencies were added. Audit reports record 94 Python versions and four final vendor versions with no known advisories.
- Browser smoke passed actual patched DOMPurify sanitization, markdown-it rendering, Mermaid rendering, note edit/move/delete/undo/reload, attachments, password login/logout, encrypted backup restore with actual restart, and source-archive hash invariance. Disposable artifacts: `/var/folders/ms/_3pl0plx0kj8fnkmcfs1mjt80000gn/T/metalist-browser-07g8dH`.
- Built wheel/sdist using pinned tools without isolation; **425 runtime files** verified in both artifacts, with obsolete vendor bundles rejected. A clean hash-verified runtime install plus the wheel with `--no-deps` passed dependency consistency and actual installed CLI/two-namespace HTTP/HTTPS startup outside the checkout on **macOS/Python 3.12.3**. Disposable environment: `/var/folders/ms/_3pl0plx0kj8fnkmcfs1mjt80000gn/T/metalist-f17-installed-0gph1148`.
- Source editable setup, installed `pip check`, documentation links, and workflow YAML/matrix/publication dependencies passed. Staged whitespace checks passed for project-authored files; the checksum-verified upstream Mermaid bundle retains its original trailing whitespace. Full hosted Windows/macOS/Linux × Python 3.10–3.13 execution remains required for the exact release commit; no hosted run, tag, push, merge, or publication was performed.


## Standards enforcement batch — user authorized tests and fixes

Scope: enforce selected exception handling and a single client-state owner, getter/setter access, and duplicate-write failures throughout the client.

- [x] Add failing regressions for swallowed Python/JS internal exceptions, capture/promise bypasses, mutable snapshots, modal lifecycle, duplicate values, and premature command-loading cleanup.
- [x] Select Python capture boundaries explicitly and distinguish domain input/resource failures from programming errors.
- [x] Propagate unknown JS failures; retain selected external failures and unconditional cleanup; move maintenance logic into scanned JavaScript.
- [x] Centralize controller fields, module UI state, caches, weak collections, preferences, reminders, and modal state under `ApplicationState`.
- [x] Enforce strict setters and immutable snapshots; remove redundant initialization/publication paths exposed by the checks.
- [x] Add startup regression gates for unowned state, unselected reconciliation, exception aliases, custom suppression, and promise rejection callbacks.
- [x] Document strict transitions versus observed snapshots and cleanup ownership.
- [x] Finish full-suite and real-browser lifecycle validation; address failures before handoff.
- [x] Human testing confirmed; COMMIT CHECKPOINT authorized for this batch.

### Standards-batch validation

- Python: **1,440 passed** (9.51 s), including exception/state startup enforcement regressions; one existing Starlette TestClient deprecation warning. JavaScript: **645 passed**. `git diff --check` passed.
- New regressions first reproduced swallowed internal failures, state ownership/accessor bypasses, duplicate writes, modal teardown/publication defects, and partial count/tab transitions. Equal composite transitions still throw; changing one component preserves unchanged components without redundant setter calls.
- Expanded browser smoke passed real editor typing/save/deselect/undo; palette navigation; repeated modal open/close; tab creation and switching with equal saved queries/scroll positions; note ordering/delete/undo/reload; actual vendor rendering/sanitization; attachments; password login/logout; and encrypted backup restore with an actual restart and unchanged source-archive hash.
- Browser artifacts are disposable: `/var/folders/ms/_3pl0plx0kj8fnkmcfs1mjt80000gn/T/metalist-browser-eKU9Oq`. Validation ran locally on macOS. This does not replace human testing or the cross-platform release gate. No commit, merge, push, or release was performed.

### Human-test follow-up — initial pointer movement

- The user reported a fatal duplicate `lastPointerClientX` write immediately after opening the app. Two regressions reproduced the exact error: one-axis/repeated movement while the overlay is hidden, and hover/document handlers observing the same pointer event.
- Fixed the browser observation boundary to publish only changed coordinates, preserving strict state setters. Tests also verify that one-axis movement updates keyboard-create eligibility and dismisses the overlay beyond its buffer.
- Validation: **647 JavaScript tests passed**, **28 Python startup/enforcement tests passed**, and the expanded full browser smoke passed initial pointer movement plus the existing workflows. Disposable browser artifacts: `/var/folders/ms/_3pl0plx0kj8fnkmcfs1mjt80000gn/T/metalist-browser-GGdCAz`. Human retesting remains pending; no commit.

### Human-test follow-up — expand/collapse mouse lifecycle

- Reproduced the reported absent `moveDragContext` cleanup on ordinary mouse-up. Cleanup now requires an existing gesture. Additional failing regressions exposed repeated drag-threshold writes and a collapse-click marker left pending by an earlier click consumer; both lifecycle defects are fixed without weakening strict setters.
- Added four mouse lifecycle regressions and real repeated expand/collapse clicks on a multiline note, waiting for each animation to finish before the next click.
- Validation: **651 JavaScript tests passed**, **28 Python startup/enforcement tests passed**, and the full expanded browser smoke passed. Disposable browser artifacts: `/var/folders/ms/_3pl0plx0kj8fnkmcfs1mjt80000gn/T/metalist-browser-qYv8dy`. Human retesting remains pending; no commit.

### Repeated human-test failure — interrupted gesture review

- The prior collapse-click cleanup was incomplete: when no matching click arrives, its WeakSet marker survives until the next press. A regression reproduced the user's same `collapseToggleClickSkips.add` failure without an intervening click.
- Removed that overlapping WeakSet. One pending mousedown-action record now belongs to one gesture; new left-button presses, pointer cancellation, and window blur cancel stale gesture state. Click consumption runs before target-specific early returns, handles held releases without a 500 ms expiry, and permits independent keyboard activation. Releasing another mouse button preserves an active left-button drag.
- Reviewed mouse gesture state writes and all scroll-anchor update callers. The expanded gesture → edit → undo sequence exposed a history snapshot that rewrote an equal scroll anchor; added a failing regression and reconciled that server snapshot without weakening the setter.
- **655 JavaScript tests passed**, **28 Python startup/enforcement tests passed**, and the full browser smoke passed rapid clicks during animation, release outside the button, held clicks, blur/cancellation, and subsequent edit/undo plus existing workflows. Artifacts: `/var/folders/ms/_3pl0plx0kj8fnkmcfs1mjt80000gn/T/metalist-browser-K90GAI`.
- These checks cover the identified failures and broader event sequences; they do not establish a count of all remaining defects. Human validation is still incomplete. No commit.

### Standards checkpoint

- The user subsequently confirmed testing and explicitly requested COMMIT CHECKPOINT.
- Required pre-checkpoint rerun: **1,440 pytest tests passed** (9.29 s), with the existing Starlette TestClient deprecation warning. Latest JavaScript suite: **655 passed**; latest expanded browser smoke passed as recorded above. Whitespace checks passed.
- Preserve the standards implementation, regression fixes, tests, and documentation on the current feature branch. Merge and push remain outside this checkpoint.
