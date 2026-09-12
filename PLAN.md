# MetaList review and remediation plan

Date: 2026-09-12  
Reviewed baseline: `43e0b259` (`misc`), clean working tree after the user's merge.  
Status: **Discussion draft — implementation is not approved.**

## Purpose and scope

Address the current code review's security, data integrity, concurrency, resource use, algorithmic efficiency, maintainability, testing, and documentation findings. Discuss the decisions below before selecting implementation batches. This document does not authorize implementation, commits, merges, pushes, release tags, or publishing.

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

- [ ] Add failure-injection tests for password creation/removal before and after each sidecar rewrite and the main commit, including restart/recovery assertions.
- [ ] Choose a recoverable transaction design: durable transition journal with staged live databases, or consolidation of persistence into one atomic database boundary. Do not assume SQLite WAL transactions across separate databases are crash-atomic.
- [ ] Keep a recoverable key envelope until every dependent ciphertext transition is durably complete; preserve old state until recovery can finish or roll back the whole operation.
- [ ] Publish encryption flags, caches, tokens, and success responses only after the durable transition completes.
- [ ] Validate notes, accepted/proposed tags, files, sounds, ontology, reminders, tabs, preferences, link titles, search activity, and credentials in both directions.

**Done when:** interruption at every boundary leaves either the complete previous state or a deterministic recoverable new state; no ciphertext loses its key and failed password removal does not silently expose sidecars.

### F02 — Enforce cloud privacy on conversation reuse

**P1 · Reproduced at the provider-context boundary.** `app/services/ai_chat.py:275`, `app/api/routes/ai.py:731`, `app/services/agent/context.py:61`.

The current scope is privacy-filtered, but `provider_messages()` includes all completed assistant prose regardless of the provider that generated it. An Ollama answer containing a cloud-blacklisted note's content is replayed when the next turn uses OpenAI. Tightening privacy settings or marking previously discussed content private also leaves prior prose available for replay. Citation stripping removes identifiers, not the sensitive answer text. No external request was sent during verification.

- [ ] Decide how provider switches and stricter privacy policies affect model-visible history. Recommended first implementation: start a fresh model context at those boundaries while retaining a clearly separated display transcript if desired.
- [ ] Enforce this on the server, including callers that bypass the browser settings flow.
- [ ] If preserving history is required, record evidence provenance and a disclosure-policy generation per turn; conservatively exclude any turn whose safety cannot be established. Do not rely on text replacement to sanitize arbitrary paraphrases.
- [ ] Add outbound-body canary tests for Ollama → OpenAI, policy tightening, `@password` changes, and follow-up requests. Verify both routing and final-generation bodies.
- [ ] Document user-typed chat disclosures separately from automatic replay of note-derived answers.

**Done when:** local-only or newly restricted note-derived prose cannot enter a cloud request through history, even when the current frozen scope is empty.

### F03 — Purge every plaintext-bearing cache on explicit lock/logout

**P1 · Reproduced.** `app/services/agent/evidence_serialization.py:46`, `app/services/tag_term_matching.py:140`, `app/services/runtime_lock.py:43`.

The evidence-token LRU uses complete note text and tags in its cache keys; tag-matching LRUs retain tag strings. The real purge function leaves these populated. This is retained live application state, beyond the documented limitation that released Python allocations cannot be forensically erased. Evidence entries can also retain old versions of large trees until eviction.

- [ ] Inventory module-level caches, worker-owned results, shell output, clipboard/undo state, traces, and in-flight work that can retain decrypted material.
- [ ] Give sensitive services an explicit reset contract and invoke it on logout, restore/session replacement where appropriate, and namespace teardown.
- [ ] Clear all evidence/token and tag-matching LRUs; consider revision/digest keys and byte budgets instead of retaining entire plaintext trees in process-global keys.
- [ ] Prevent in-flight workers from repopulating cleared stores after lock, using cancellation and a checked session/generation boundary.
- [ ] Add tests that warm each cache, perform the actual purge, and verify no live cache entries remain. The current reproduction mocked only post-purge database bootstrap to isolate cache teardown.

**Done when:** the documented purge contract covers every sensitive store and worker; retain the honest distinction between clearing references and forensic memory erasure.

### F04 — Keep memory, search, undo, and SQLite consistent on request failure

**P1 · Reproduced.** `app/usecases/update_content.py:105`, `app/usecases/update_content.py:121`, `app/usecases/create_note.py:82`, `app/db/session.py:133`.

Inside a request transaction, exiting `begin_writer()` does not commit. Several usecases nevertheless update memory immediately afterward. A later exception rolls SQLite back while the NoteStore still contains the new text; the probe produced database=`before`, memory=`after`. Existing transaction tests check SQL rollback, not full runtime consistency.

- [ ] Add failure tests for saves, create/split/paste, moves, delete/restore, tags, and undo/redo, including failures in later work and at commit.
- [ ] Define a unit-of-work model that preserves intra-command read-your-writes while publishing shared state only after commit, or provides complete runtime rollback/reload on failure.
- [ ] Reuse `after_request_commit()` where appropriate; do not mechanically defer all updates because multi-step commands currently depend on seeing their own changes.
- [ ] Include search postings, inherited/reference tags, backlinks, content caches, undo/redo, activity history, and sync UUIDs in the consistency boundary.

**Done when:** after success, failure, cancellation, or commit error, persisted and served state agree; a failed request cannot leave a visible edit that disappears on restart.

### F05 — Make multi-database restore a recoverable operation

**P1 · Reproduced.** `app/services/backup_service.py:748`, especially the live notes copy at line 789 and subsequent sidecar copy.

Restore installs the notes database before the files database. Injecting failure at the second copy left restored notes and current attachments from different snapshots. The source archive remained byte-for-byte unchanged, so archive immutability works but does not provide live-destination atomicity.

- [ ] Extract and validate every component before modifying live destinations: checksums, SQLite integrity, supported schema, encryption metadata, namespace/profile compatibility, and required sidecars.
- [ ] Quiesce all writers and background jobs for the target namespace before installation.
- [ ] Preserve distinct recovery copies of live targets and use a durable recovery record for the whole set. Sequential file replacements alone are not a multi-file atomic transaction.
- [ ] Recover all targets on failure, including profile rewriting, checkpointing, migration, and restart preparation.
- [ ] Add failure/restart tests at each installation stage for archive and legacy restores, encrypted/plaintext states, missing sidecars, and cross-namespace restores.

**Done when:** restore cannot leave a mixed live namespace; source archives and legacy sidecars remain unchanged in bytes and metadata throughout.

## Phase 2 — Request handling, concurrency, and resource limits

### F06 — Preserve streaming through HTTPS and bound proxy resources

**P1 for broken streaming; P2 for resource hardening · Code-confirmed.** `main.py:580–618`.

The proxy reads the complete request body and calls `response.read()` before sending response headers. AI streaming/progress therefore arrives only after backend completion over HTTPS. Chunked request bodies are not decoded, and complete bodies consume memory in the proxy as well as the application.

- [ ] Decide between native ASGI TLS and retaining the separate proxy. Preserve existing HTTP/HTTPS namespace URLs and trusted-forwarding behavior.
- [ ] If retaining it, implement bounded request/response streaming, explicit transfer-framing validation, disconnect cancellation, connection cleanup, deadlines, and bounded concurrent connections.
- [ ] Support chunked requests correctly or reject them explicitly before forwarding; do not silently replace a body with empty bytes.
- [ ] Add a real listener test proving that the first chat/progress chunk reaches an HTTPS client before the backend completes, plus upload/download and disconnect tests.

**Done when:** HTTPS preserves incremental behavior and bounded memory without weakening Host, Origin, or forwarding-header checks.

### F07 — Fix read-guard concurrency and audit shared-state access

**P2 · Read-guard defect reproduced; remaining synchronization audit is an opportunity.** `app/models/database.py:178`, `app/services/tokens.py:14`, `app/api/transactions.py:47`, `app/services/bulk_operation.py:19`.

Overlapping `SafeSession.allow_reads()` scopes restore stale process-global values: A exits while B is active and disables B's reads; B then leaves reads enabled globally. Token compound operations also lack their own synchronization. Synchronous mutation routes already share a bulk-operation lock, so do not assume every old lock-race finding remains reachable; async routes, middleware, GETs, hydration, and background workers need separate analysis.

- [ ] Replace temporary process-global permission changes with context-local read permission layered over the global startup state.
- [ ] Add deterministic overlapping-thread/task tests that verify allowed scopes and unrelated denied reads simultaneously.
- [ ] Map lock ownership and lock ordering for auth/token operations, sync/clipboard, NoteStore/search publication, hydration, and bulk operations.
- [ ] Reproduce reachable races before changing synchronization; make compound operations atomic and return snapshots rather than mutable shared objects.
- [ ] Verify async routes cannot interleave shared mutations in ways the synchronous wrapper prevents; avoid thread locks held across asynchronous waits.

**Done when:** concurrent requests cannot leave the read guard open, invalidate another scope's permission, or expose partially updated runtime state.

### F08 — Validate external input at the HTTP boundary

**P2 · Code-confirmed.** `app/api/routes/notes.py:189`, `app/api/routes/notes.py:909`, `app/api/routes/auth.py:145`, `app/main.py:137`, `app/security/request_boundary.py:111`.

Many routes accept raw dictionaries and index required keys; `{}` for a view request raises `KeyError` rather than schema validation. Separately, the default validation handler converts Pydantic request errors into internal errors. Host/Origin parsing also calls `urlsplit()` outside its ValueError handling, so malformed bracketed hosts can escape as server errors. These are external-input failures, not internal invariants.

- [ ] Introduce required request models and reusable typed viewport/tab/undo structures, enums, lengths, and numeric limits. Preserve intentional nullable values only after discussing their protocol meaning; do not silently add optional fields.
- [ ] Return sanitized stable 4xx responses for invalid bodies, headers, stale IDs, and unsupported actions, while preserving loud failures for actual programming errors.
- [ ] Audit invalid Host/Origin parsing and duplicate/framing headers at both application and proxy boundaries.
- [ ] Discuss removing the optional client `iterations` field from password changes and using server-owned KDF policy.
- [ ] Verify generated OpenAPI describes the real required contract; test malformed input through the full middleware stack rather than only calling helpers.

**Done when:** bad external input does not masquerade as an internal defect or mutate state, and internal bugs remain visible.

### F09 — Bound attachment and sound uploads before allocation

**P2 · Code-confirmed.** `app/api/routes/files.py:45`, `app/services/file_storage.py:113`, `app/api/routes/sounds.py`.

General uploads use an unbounded `await file.read()` and have no attachment size cap. Sounds enforce their storage policy only after reading the upload. Encryption/download paths also materialize complete blobs.

- [ ] Discuss per-file limits and whether an aggregate namespace quota is useful; choose limits from actual expected usage.
- [ ] Read in bounded chunks and reject excess bytes early, including uploads without a trustworthy Content-Length. Keep a service-level guard for non-HTTP callers.
- [ ] Coordinate HTTP, multipart/spool, proxy, encrypted blob, and download memory bounds; measure large-file behavior rather than claiming that `StreamingResponse(BytesIO(...))` is incremental storage I/O.
- [ ] Test exact-limit/over-limit uploads, cancellation, temp-file cleanup, and unchanged DB/registry state on rejection.

### F10 — Bound shell execution and integrate it with session teardown

**P2 · Code-confirmed; only applies when shell capability is explicitly enabled.** `app/services/shell_session_service.py:92`, `app/services/shell_session_service.py:188`, `app/services/shell_session_service.py:201`.

Timeout zero disables the deadline; each output character is retained as a list entry, full output is rejoined on every poll, and active runs have no concurrency/output cap. Timeout kills the shell process but does not deliberately terminate its process tree; reader joins can wait for descendants that retain pipe handles. Completed-output retention is pruned only on later activity.

- [ ] Discuss server-owned duration, concurrent-run, and output-byte caps, plus explicit behavior for long-running commands.
- [ ] Buffer in chunks with bounded retained output and an explicit visible limit condition; return incremental output using a cursor if useful.
- [ ] Terminate process groups on POSIX and process trees on Windows; verify pipes/readers finish.
- [ ] Cancel or deliberately detach jobs under an agreed policy on logout, restore, and namespace shutdown; clear sensitive output.
- [ ] Use small bounded subprocess fixtures for timeout/descendant tests. Do not load-test by running an uncontrolled infinite-output command.

### F11 — Bound view caches, undo history, and obsolete client state

**P2 · Code-confirmed.** `app/services/view_cache.py:9`, `app/services/undo_state.py:286`, `app/services/agent/evidence_serialization.py:46`.

Each distinct client/tab/search/sort view keeps another complete snapshot with no eviction. Undo/redo and client registries likewise retain arbitrary numbers of payloads. An entry-count bound alone is insufficient for caches whose entries contain complete trees.

- [ ] Prefer one current diff baseline per active client/tab where compatible; otherwise use measured byte and entry budgets with lifecycle eviction.
- [ ] Define undo operation/byte limits and user-visible semantics for evicting old complete operations; preserve valid undo/redo and bulk-operation boundaries.
- [ ] Evict closed tabs, superseded sessions, expired clients, and obsolete cached tree versions; integrate with F03.
- [ ] Add hit/miss/size diagnostics containing counts only and tests proving repeated searches/edits stay within bounds.

## Phase 3 — Algorithmic efficiency

### F12 — Remove repeated full-scope scans during AI evidence sizing

**P2 · Reproduced and measured.** `app/services/agent/investigation.py:169–201`.

For every retained root, `_full_root_token_cost()` scans every frozen structure node to find that root's members. With R roots and N nodes this costs O(R × N), even when token estimates are cached. Independent roots produce quadratic visits.

- [ ] Group structure nodes by root once alongside evidence-note grouping, or retain those groups in the immutable scope representation.
- [ ] Preserve canonical order, complete-root prefix semantics, privacy filtering, exact omitted counts, and cache invalidation.
- [ ] Add a deterministic operation-count regression with 1,000/2,000 roots; measure cold/warm behavior with small and large root payloads.

**Done when:** grouping/visiting structure is O(N) per retention pass, excluding necessary serialization and within-root ordering work.

### F13 — Reduce repeated full-tree work in sorted views and auth requests

**P2 · Code-confirmed repeated work; optimization choices require profiling.** `app/services/root_sorting.py:69`, `app/services/root_sorting.py:100`, `app/services/snapshot.py:551`, `app/api/middleware/auth.py:117`, `app/models/database.py:63`, `app/db/schema.py:197`.

Sorted snapshots compute root metrics across the namespace before filtering/windowing; content-volume sorting reparses every note's HTML on each request. Protected requests open a synchronous SafeSession in async middleware, and every connection reruns schema initialization and table inspection. This contradicts the broad documentation claim that runtime view requests perform no SQLite reads.

- [ ] Profile representative large namespaces for normal, timestamp, alphabetical, content-volume, filtered, and no-change views.
- [ ] Reuse sanitized cached plain text and maintain root aggregate timestamps/lengths with invalidation for edits, moves, deletes, restore, and undo.
- [ ] Separate one-time schema bootstrap/migration from normal connection setup; keep auth state memory-owned with explicit transition updates.
- [ ] Keep blocking I/O off the event loop and measure request latency, connection counts, SQL statements, and allocations before/after.
- [ ] Clarify intentional runtime DB exceptions such as attachment reads and version inspection instead of weakening the architectural contract silently.

### F14 — Remove recursion limits from supported note hierarchies

**P2 · Code-confirmed risk; maximum supported depth is undecided.** `app/services/snapshot.py:634`, `app/services/agent/evidence_serialization.py:155`, `app/services/html_export.py:240`, `app/usecases/copy_note.py`.

Rendering, export/copy, and evidence serialization recurse through user-controlled note depth. Some ancestor walks repeat full paths, and evidence serialization copies an ancestor set at every level. No consistent maximum hierarchy depth was identified.

- [ ] Discuss whether arbitrarily deep imported trees are supported or a documented depth limit is appropriate.
- [ ] Prefer iterative traversals and memoized ancestor/root resolution for supported data; retain cycle detection and deterministic ordering.
- [ ] Test a deep valid chain and cycles across hydration, view, copy, export, and AI evidence. Account for JSON encoder/browser limits as well as Python traversal.

## Phase 4 — Refactoring and developer workflow

### F15 — Consolidate state ownership and split large modules by responsibility

**P2 · Opportunity, with concrete legacy defects.** `app/services/note_store.py:85`, `app/services/store.py:11`, `docs/REFACTORS.md`, `app/services/transaction_manager.py:122`, `app/services/note_service.py:2`.

- [ ] Make note ordering have one authoritative representation. `_links/_heads/_tails` and record `prev_id/next_id` currently duplicate state; retain local invariants while migrating callers and serialization.
- [ ] Confirm supported external imports, then remove the unused legacy service/transaction/query/undo subsystem. The old `TransactionManager.undo()/redo()` reference nonexistent `command_stack`, and old `NoteService` imports FastAPI into the service layer.
- [ ] Split auth transitions into prepare/persist/publish/recover phases after F01/F04; extract AI stream lifecycle, view selection/render/diff, and formatting handlers along established responsibility boundaries.
- [ ] Prioritize the 319-line chat handler, 297-line view builder, 290-line hydration method, 250-line tag-suggestion function, and 244/241-line password transitions. Avoid mechanical splitting solely to satisfy a line-count threshold.
- [ ] Move routine function-local imports in active usecases to module scope; preserve documented circular-import or startup-order exceptions only where necessary.
- [ ] Replace ambiguous names and untyped state dictionaries at edited boundaries. Count meaningful assertions/validations and enforce invariants where needed; do not add redundant assertions merely to reach a percentage.
- [ ] Audit broad exception/fallback paths for hidden internal failures, but preserve handling for network, file I/O, invalid input, and legitimate absent-state cases. `CapturedExceptionContext` is still exception handling and must receive the same scrutiny as `try/except`.

**Done when:** active behavior is preserved under targeted tests, ownership is explicit, and obsolete code no longer disguises a second architecture.

### F16 — Make test commands and isolation reliable

**P2 for isolation; P3 for command cleanup · Reproduced/code-confirmed.** `tests/unit/test_convert_from_legacy.py:204`, `package.json:10`, `docs/testing/harness.md`.

- [ ] Fix the importer subprocess test to explicitly set or clear `METALIST_DATA_DIRECTORY` along with namespace/port overrides; assert that no path outside its fixture root is changed.
- [ ] Establish a disposable-root test bootstrap before application imports and audit subprocess environment inheritance, file/memory DB switching, global singleton reset, and test ordering.
- [ ] Replace the failing `npm test` placeholder with the real Node test command. Assess module-type declarations against all existing tooling before changing them.
- [ ] Add focused integration tests for the reproduced gaps; existing helper-level tests and startup AST checks do not establish cross-component correctness.
- [ ] Discuss a minimal browser smoke suite for login/logout, edit/undo, HTTPS streaming, attachment round-trip, and restore/restart. The project deliberately removed Cypress; do not automatically restore a large browser framework.
- [ ] Measure branch/line coverage if useful, prioritizing failure boundaries over a blanket percentage target. Do not reuse the August review's 66% figure as a current measurement.

### F17 — Complete supply-chain verification without duplicating existing release gates

**P3 · Defense-in-depth opportunity; no vulnerable dependency is claimed by this review.** `.github/workflows/publish-pypi.yml`, `pyproject.toml`, `uv.lock`, vendored assets under `app/static/js/vendor/`.

- [ ] Run a current known-vulnerability audit of the resolved Python graph and inventory vendored browser libraries with versions/provenance. Verify findings against primary advisories before recommending upgrades.
- [ ] Discuss locked/hash-verified transitive installs in CI and immutable commit-SHA pins for third-party Actions, with an update process.
- [ ] Preserve the existing Python/JS/sanity gates, wheel/sdist resource verification, clean installed-package smoke matrix, and publication of the tested artifacts.
- [ ] Confirm exact-commit evidence across Windows/macOS/Linux and every supported Python version before any separately authorized release tag. Never tag first to discover failures afterward.

## Phase 5 — Documentation and closeout

### F18 — Reconcile documentation with the implemented system

**P3 · Confirmed drift, with good existing feature coverage.** `docs/AI-SUMMARY.md`, `docs/security/README.md`, `docs/security/FUTURE-SECURITY-WORK.md`, `docs/testing/harness.md`, `CODE_REVIEW.md`.

- [ ] Update `docs/AI-SUMMARY.md`: one section still reports database version 5 while current code/docs report 8; its old trigram description conflicts with the implemented scan-based text search and newer summary text.
- [ ] Reconcile the memory-first contract with authentication/schema reads and deliberate attachment/version exceptions; update it again after F13.
- [ ] Correct security text describing first-hop `X-Forwarded-For` throttling and a single login KDF operation; current code uses trusted request-client metadata and separate verifier/KEK derivations.
- [ ] Refresh deferred-security documentation: full tests, artifact resource checks, and installed-package platform validation are now implemented, while vulnerability auditing and immutable Action pins remain separate opportunities.
- [ ] Document the agreed provider/history boundary, cache purge and in-flight cancellation contract, password-transition/restore recovery protocol, quotas, shell lifecycle, and supported hierarchy depth as their fixes land.
- [ ] Add a failure-recovery runbook distinguishing live database migrations from immutable archives. Never suggest modifying an existing backup to repair or upgrade it.
- [ ] Mark the August review as historical or add a dated finding-status index after discussion. Preserve historical results; do not silently overwrite them with current test counts.
- [ ] Maintain a compact mapping of feature → implementation → tests → docs. Update touched docs within each implementation batch instead of postponing all documentation until the end.
- [ ] Validate setup/test examples in disposable environments and check external links as a separate read-only documentation pass.

## Prior review items already addressed

Do not reopen these as current defects without new evidence:

- Forwarded-header spoofing: the HTTPS proxy now strips supplied forwarding headers and writes the actual peer address; login uses `request.client.host`.
- Shell exposure: explicit launch capability, password protection, and loopback client/host checks exist. F10 concerns resource/lifecycle behavior within that authorized capability.
- Duplicate file-table deletion during backup reset: the current helper deletes files once and sounds once.
- Missing Python/JS CI gates and installed-package validation: these now exist in the release workflow. F17 concerns the remaining audit/pinning work.

## Decisions for discussion

1. **Implementation order:** agree to prioritize F01–F05 before broad refactoring, while treating broken HTTPS streaming (F06) as an independent high-priority workflow fix.
2. **Cloud conversation behavior:** fresh model context on provider/policy changes, or provenance-aware retained history? Recommended initial scope is the conservative fresh-context boundary.
3. **Durable recovery architecture:** staged live databases plus a recovery journal, or a larger storage consolidation? Decide once for password transitions and restore.
4. **Quotas and retention:** choose practical attachment, undo/cache, shell output/concurrency/duration limits; no arbitrary limits are approved by this draft.
5. **TLS implementation:** retain and repair the proxy, or serve TLS directly while preserving current URLs and launch behavior?
6. **Hierarchy support:** iterative support for deep trees, a declared maximum depth, or both?
7. **Testing scope:** agree on a small integration/browser layer and dependency-audit cadence without recreating a costly broad UI harness.
8. **Refactoring scope:** confirm compatibility requirements before deleting legacy modules or changing request schemas.

## Execution and acceptance protocol

- [ ] Discuss and approve the plan, editing scope/priority and recording the decisions above.
- [ ] After explicit plan approval, request the documentation-only COMMIT CHECKPOINT required by the repository workflow. No commit has been made or authorized by creation of this draft.
- [ ] For each agreed batch, inspect the then-current tree and branch state and follow the repository's branch/git permission rules. Do not push automatically.
- [ ] For bug fixes, first convert the applicable probe into a minimal regression and demonstrate failure for the correct reason; then implement and run the relevant tests.
- [ ] Keep security/data-integrity fixes and broad refactors in separate reviewable batches. Preserve backup immutability, fail-loud internal invariants, and the existing release gates throughout.
- [ ] Run affected tests and startup checks per batch. Before committing application changes, obtain the user's confirmation that they tested the behavior; follow the checkpoint test policy.
- [ ] At completion, run the full isolated Python/Node suites, dependency consistency checks, and necessary integration/distribution/platform checks for the changes made. Record actual results and outstanding limitations.
- [ ] Update relevant documentation and the finding-status checklist. Follow COMMIT FEATURE only when explicitly requested; remove `PLAN.md` as part of that approved workflow, preserving durable architecture/recovery decisions in `docs/`.

No application code was changed for this review or plan. All implementation checkboxes remain open.
