# Security Architecture

Deferred, non-blocking security improvements and the conditions that should
trigger a new threat-model review are tracked in
[`FUTURE-SECURITY-WORK.md`](FUTURE-SECURITY-WORK.md).

## Overview

This document describes the security architecture for MetaList3's password protection and note encryption system. The system uses a two-key architecture to provide strong security while maintaining good performance.

## Current Security Posture (Implemented)

- At-rest data encryption uses AES-256-GCM for note content, note tags, and ontology rules.
- Password-derived key material uses Argon2id with persisted per-vault KDF profile metadata (`vault_version=3`, `kdf_algorithm=ARGON2ID`, memory + parallelism fields).
- `/api2/auth/login` is rate-limited (keyed by client IP, with `x-forwarded-for` first-hop support).
- Runtime hardening runs at startup:
  - core dumps disabled on POSIX
  - optional macOS checks for encrypted swap and no RAM-to-disk hibernation behavior.
- Before any namespace restart/launch work, `main.py` prints its resolved
  `METALIST_ENVIRONMENT`. Development mode also runs source-level startup
  sanity gates; production mode skips them:
  - Python AST/default/transaction-route rules
  - JS tree-sitter sanity rules for `try/catch`, default params, destructuring defaults, and defaulting operators.
- Password policy is intentionally permissive in current dev mode (see "Password Requirements").

## Two-Key Encryption System

### Key Components

1. **KEK (Key Encryption Key)**
   - Derived from user's password using Argon2id with configurable time-cost (currently 3)
   - Uses a dedicated `kek_salt` (distinct from the auth verifier salt)
   - Never stored on disk - only derived transiently during login/password change operations
   - Used solely to encrypt/decrypt the DEK
   - Not retained after unwrapping the DEK

2. **Auth Verifier**
   - Used only to verify a password attempt during login
   - Computed as `Argon2id(password, auth_salt, auth_iterations)` and stored in the DB
   - Uses a dedicated `auth_salt` (distinct from `kek_salt`)
   - Provides a password guessing target (expected) but is not usable for unwrapping the DEK

3. **DEK (Data Encryption Key)**
   - 256-bit randomly generated AES key
   - Created once when password protection is first enabled
   - Stored in database encrypted by the KEK
   - Used for all note encryption/decryption operations
   - Remains constant even when user changes their password

4. **Vault Metadata**
   - `vault_version` defines the wrapped-key format (current: `3`)
   - `kdf_algorithm` defines password KDF profile (current: `ARGON2ID`)
   - When encryption is enabled, these fields are required and enforced

### Encryption Flow

```
Initial Password Setup:
1. User sets password
2. Password → Argon2id (current config time-cost) → KEK
3. Generate random 256-bit DEK
4. Encrypt DEK with KEK → Encrypted DEK
5. Store Encrypted DEK + Argon2id cost metadata in database
6. Use DEK to encrypt all notes with AES-256-GCM

Login Flow:
1. User enters password
2. Verify password via Auth Verifier (auth_salt + auth_iterations)
3. Derive KEK (kek_salt + kek_iterations)
4. Retrieve Encrypted DEK from database
5. Decrypt DEK using KEK
6. If `PRAGMA user_version` is behind, create an automatic namespace backup and run every database migration in order with the DEK.
7. Purge obsolete SQLite pages/WAL data in the live database and advance its version. Historical backup files remain byte-for-byte unchanged.
8. Discard KEK; keep only DEK in memory for session.
9. Use DEK for all note operations.
10. If the server started with encryption enabled, cache + note-store hydration is deferred.
   - The client calls `/api2/auth/hydrate` after login.
   - The progress UI is always shown after password submission, including when the database is already current and hydration is fast.

Password Change Flow:
1. Verify old password using stored Argon2id time-cost
2. Decrypt DEK using old KEK
3. Derive new KEK from new password (current config time-cost)
4. Re-encrypt DEK with new KEK
5. Store newly encrypted DEK + new Argon2id cost metadata in database
6. Notes remain unchanged (still encrypted with same DEK)
```

### Performance Benefits

- **Login**: One expensive Argon2id operation (stored time-cost)
- **Note Operations**: Fast AES-256-GCM encryption/decryption using cached DEK
- **Bulk Operations**: No KDF work per note, just fast AES operations
- **Password Changes**: Only need to re-encrypt the DEK, not all notes
- **Cost Upgrades**: Automatic upgrade to stronger Argon2id costs on password changes

## Cryptographic Details

### Argon2id Configuration
- **Algorithm**: Argon2id
- **Time Cost**: Configurable (currently 3), stored per password hash
- **Memory Cost**: 65,536 KiB
- **Parallelism**: 4
- **Salt**: 32 bytes, randomly generated per password
- **Output**: 256-bit key

### AES-256-GCM Configuration
- **Key Size**: 256 bits (from DEK)
- **Nonce**: 96 bits, randomly generated per encryption
- **Tag**: 128 bits for authentication
- **Mode**: Galois/Counter Mode (GCM) for authenticated encryption

### Database Storage

```sql
app_settings table:
- auth_verifier: Argon2id-based password verifier (not a KEK)
- auth_salt: Salt for auth verifier
- auth_iterations: Argon2id time-cost for auth verifier
- kek_salt: Salt for KEK derivation
- kek_iterations: Argon2id time-cost for KEK derivation
- vault_version: Wrapped-key vault format version (required when encrypted)
- kdf_algorithm: Password KDF profile name (required when encrypted)
- kdf_memory_cost_kib: Argon2id memory-cost parameter persisted per vault
- kdf_parallelism: Argon2id parallelism parameter persisted per vault
- encrypted_dek: DEK encrypted with KEK
- dek_nonce: Nonce used for DEK encryption
- dek_tag: Authentication tag for DEK encryption
- encryption_enabled: Boolean flag
- encryption_algorithm: "AES-256-GCM"
- client_preferences_json: Encrypted command-palette/UI preferences when password-protected
- client_preferences_encryption_nonce / client_preferences_encryption_tag
- command_palette_usage_json: Encrypted palette usage and query tokens when password-protected
- command_palette_usage_encryption_nonce / command_palette_usage_encryption_tag
- tag_prefix_settings_json + nonce/tag: Reserved encrypted tag-prefix settings payload

notes table:
- content: Encrypted note content (Base64)
- encryption_nonce: Per-note nonce for AES-GCM
- encryption_tag: Per-note authentication tag
- tags: Encrypted note tags (Base64)
- tags_encryption_nonce: Tags nonce for AES-GCM
- tags_encryption_tag: Tags authentication tag

ontology_rules table:
- rule_text: Encrypted rule text (Base64) when password protection is enabled
- rule_encryption_nonce: Per-rule nonce for AES-GCM
- rule_encryption_tag: Per-rule authentication tag

Important: if any note rows have `encryption_nonce/encryption_tag` (content)
or `tags_encryption_nonce/tags_encryption_tag` (tags) set, that field is
encrypted and unrecoverable without the DEK. The same applies to ontology rule
rows with `rule_encryption_nonce/rule_encryption_tag`. If the
`app_settings.encrypted_dek` fields are cleared while encrypted rows remain,
the server should refuse to start rather than display placeholders. When
password protection is enabled, new rule writes must be encrypted (no plaintext
writes).
```

## Security Properties

### Shell Execution

The server rejects `@shell` execution and shell-output polling unless the
top-level process was explicitly launched with `--enable-shell`. The source
or installed orchestrator propagates that capability to every namespace child without
persisting it in namespace data. Enabling shell defaults `METALIST_HOST` to
`127.0.0.1`, but an explicit LAN/wildcard bind may be used so other clients can
access non-shell features.

Shell start and status routes independently require both a loopback client and
a loopback request host. They also require password protection for the active
namespace. The execution check runs before the note is loaded and before the
shell-session service can start a host process. Passwordless namespaces,
remote clients, LAN-host requests, and launches without `--enable-shell` can
still render shell-tagged notes, but attempting to run one returns an inline
error response.

The built-in HTTPS proxy discards incoming `Forwarded` and `X-Forwarded-*`
headers, then writes `X-Forwarded-For` from the actual socket peer and
`X-Forwarded-Proto=https`. This prevents a LAN client from claiming a loopback
identity. On a combined LAN/shell launch, use loopback HTTP on the host laptop
for shell actions and the LAN HTTPS address for remote non-shell access.

### Stored Note HTML

Stored note bodies use a strict shared allowlist in
`app/static/note-html-policy.json`:

- The browser loads the vendored DOMPurify build at startup and sanitizes note
  HTML before save, update, or split requests.
- The server independently sanitizes every create, update, restore, and legacy
  model write with nh3 before encryption/database persistence. Browser output
  is never trusted as the authoritative check.
- Decrypted historical rows are sanitized again before entering the in-memory
  content cache, preventing previously stored executable markup from reaching
  note rendering even before that row is saved again.
- Scripts, event handlers, forms, frames, SVG/MathML, arbitrary classes/data
  attributes, unsafe URL schemes, and unsafe CSS are removed. Formatting tags,
  links, tables, indentation, and bounded embedded image markup remain supported.

HTTP responses also receive a nonce-based Content Security Policy. Scripts are
limited to same-origin files and explicitly nonced inline startup blocks;
objects, frames, base-tag replacement, and cross-origin form submission are
blocked. `X-Content-Type-Options`, deny-framing, no-referrer, and restrictive
Permissions Policy headers provide additional browser hardening. Inline styles
remain enabled because note formatting and existing templates require them, so
the sanitizer's CSS-property/value allowlist remains an important layer.

### Outbound Link-Title Requests

Automatic link titles fetch only normalized HTTP(S) URLs. For every initial URL
and redirect, MetaList resolves DNS once, rejects the entire result if any
address is loopback, private, link-local, reserved, or otherwise non-global,
and pins the actual TCP connection to the validated public address. The
original hostname remains in the HTTP request and TLS SNI/certificate check.
DNS failures stop the request instead of falling through to a second,
unvalidated lookup, and proxy environment variables cannot reroute the pinned
connection.

### Sensitive Telemetry

Runtime logs and browser diagnostics describe application structure without
recording decrypted user data:

- Before an encrypted namespace is unlocked, persistent startup diagnostics are
  plaintext because no DEK exists in memory and decrypted vault data is not
  hydrated. Successful DEK unwrap switches the process to authenticated logging
  before any note, rule, tab, reminder, or tag-activity decryption begins.
- While unlocked, every Loguru file record and every direct `stdout`/`stderr`
  write is stored as an independent `MLLOG1` AES-256-GCM envelope under the
  namespace DEK using a domain-separated HKDF logging key and a fresh random
  nonce. Plaintext Loguru sinks are filtered out and plaintext fault logging is
  disabled for the unlocked interval.
- Logout returns to plaintext startup diagnostics only after decrypted runtime
  stores and the session key have been purged. Password removal and backup
  restore close the encrypted diagnostic session after their sensitive work.
- Password-bearing request models use Pydantic `SecretStr`, so model rendering
  and JSON serialization cannot expose submitted login, creation, current,
  replacement, or removal passwords. Canary tests cover rejected login and
  password-change paths, and an AST regression test rejects direct password
  values passed to logging or `print` from the authentication modules.
- Server request telemetry records method, route path, timing, client address,
  and whether a query string exists; it never retains the query-string value or
  request body.
- Search telemetry records counts and timings without search expressions, tags,
  or note text.
- Validation failures retain only the error type and field location. Rejected
  input, validation messages, and validation context are discarded before logging
  or returning a 422 response.
- Persistent exception diagnostics retain the exception type and traceback frame
  locations, not the exception message or local values. Uvicorn's raw access log
  is disabled because request targets can contain searches.
- Browser API/state debug logging is disabled by default. If enabled for
  development, it reports only request/response structure; shared mode logging
  discards caller-provided state and payload objects, and direct console calls do
  not serialize raw `Error` objects.
- Browser `sessionStorage` contains opaque tab/client identifiers and transition
  counters only. Legacy authentication keys are removed during authentication
  initialization; legacy preferences and command-palette usage are removed after
  successful migration into encrypted server storage.
- Browser CSP restricts fetch, XHR, WebSocket, and related connection APIs to
  MetaList's own origin plus local `data:` and `blob:` resources. External image
  and link-title retrieval therefore crosses the authenticated server boundary;
  browser JavaScript cannot directly send note data to arbitrary HTTP(S) hosts.
- Every response carries `Cache-Control: no-store, private`, `Pragma: no-cache`,
  and an expired `Expires` value. Browsers therefore must not retain decrypted
  API responses, file downloads, exports, pages, redirects, or error bodies in
  their HTTP caches.

### Application, Database, and Vault Versions

- Application release: `app/version.py` is the single source for the installed package and runtime UI; current release is `0.4.2`.
- Database schema/data: `PRAGMA user_version` is a monotonic integer managed by `app/db/migrations.py`; current version is `9`.
- Vault format: `VAULT_VERSION` remains an independent crypto compatibility number; current version is `3`.

Passwordless namespaces run pending migrations during startup. Encrypted namespaces remain usable for password verification at their old database version, then create a backup and run all intermediate migrations after the password unwraps the DEK. Migration functions are ordered, transactional, idempotent, and refuse databases newer than the running application.

Database migration `0 → 1` adds ciphertext metadata for client preferences, command-palette usage, and tag-prefix settings. Existing non-empty payloads are encrypted during the next successful namespace login. Password creation/removal also rewrites client state in the same direction as the rest of the namespace data.

Database migration `1 → 2` adds `namespace_content_migrations`, a namespace-local ledger for resumable content transformations. The ledger stores migration identity, status, timestamps, and aggregate counts only; it never stores note text or remote URLs.

Database migration `2 → 3` removes the legacy search-history schema that exposed an unsalted deterministic query hash plus plaintext scores/timestamps and replaces it with an opaque payload table. Migration `3 → 4` intentionally deletes the incompatible query-score history and starts the tag-activity model empty. Tag activity is stored as at most one row with a random UUIDv4 and a versioned payload containing sparse per-day tag counts. In encrypted namespaces, the entire payload is protected with AES-256-GCM; its row UUID is authenticated as associated data, every rewrite uses a fresh nonce, and inspection reveals no dates, tag names, counts, or queries. Password transitions rewrite this aggregate payload with the rest of namespace state. After unlock, migration enables SQLite secure deletion, truncates the WAL, and vacuums only the live database. Historical backups and obsolete sidecars inside backup sets remain immutable; if restored, their database version is migrated only on the installed live copy.

### Backup Immutability

Existing backup archives are immutable. MetaList can create a new archive using exclusive creation, validate/read one, restore from one, or delete one through the explicit retention/delete or namespace-deletion workflow. It never rewrites, replaces, renames, repackages, migrates, touches, or changes permissions on an existing archive. Login and database migrations do not enumerate user-configured backup folders.

Restore hashes the selected archive and every legacy sidecar before reading it, installs the database into the live destination, and hashes the sources again. Any byte change fails loudly. A restored passwordless database is migrated after installation; an encrypted older version stays locked and migrates after its own password unwraps its DEK. The source backup remains unchanged in either case. `BKP001` startup sanity rejects overwrite-capable archive modes, historical-backup transformation functions, backup-service imports from database migrations, archive replacement/move APIs, and deletion outside the explicit retention path. The gate cannot be suppressed.

No remote-image content migration is active. Remote HTTP(S) image URLs remain encrypted note content and image bytes are never added to namespace databases or backups. Browser CSP restricts image loads to same-origin, `data:`, and `blob:` sources, so a remote `<img>` inserted during paste or editing cannot contact its host directly. Before pasted HTML enters the editor, MetaList registers remote image URLs with the authenticated in-memory proxy, replaces their load-bearing `src` with opaque process-local `/api2/remote-images/{token}` references, and displays the response through an in-memory `blob:` URL. Storage sanitization restores the original remote URL in the encrypted note instead of persisting either temporary reference. View rendering likewise removes remote `src` values and exposes only opaque proxy paths. The authenticated proxy resolves tokens from memory, validates public DNS targets, pins connections, repeats validation after redirects, strips ambient browser credentials/referrers, caps transfers at 10 MiB and decoded dimensions at 16 megapixels, and verifies an explicit image-format allowlist with Pillow. Proxy mappings and downloaded bytes are not persisted, responses use `Cache-Control: no-store`, in-page object URLs are revoked on unload, and mappings are purged when an encrypted namespace locks.

### Recovery of live database changes

Password creation/removal and backup restore enlist both the notes database and
the files database in one recoverable operation. Before the first live
write, `app/db/live_recovery.py` takes consistent SQLite rollback images and
flushes a checksummed manifest in `.<database-name>.recovery` beside the live DB.
These are temporary live transaction files, separate from historical backups.
They preserve the original encryption state and wrapped key together. Creating
a password can therefore temporarily retain the previous plaintext state in
this owner-only transaction directory until the transition commits.

A durable commit marker is written only after the database commits and file
flushes. An operation interrupted before that marker rolls the complete set
back on the next startup, before encryption auditing or migrations. Recovery is
retryable if it is itself interrupted. Originally absent sidecars are removed
on rollback. Successful cleanup removes the transaction images; the empty
`.recovery.lock` file may remain. Do not manually delete a pending recovery
directory: resolve the disk/permission problem and restart so recovery can finish.
If recovery cannot restore runtime state, the server revokes tokens and remains
in maintenance mode instead of serving a partially rebuilt namespace.

Restore checks archive checksums and stages both SQLite databases, checks their
integrity and supported version, and only then copies into live destinations.
Profile changes and current-namespace reset remain inside the recovery boundary.
Restoring another namespace stops its verified server first; an occupied port
whose server identity cannot be verified causes the restore to fail. Open that
namespace again after restoration. Restore sources remain immutable. Legacy
schema migration continues to run only on the installed live database.

Mutating HTTP requests also record runtime rollback hooks. A failed write
rebuilds notes, search/backlinks/inherited tags, content caches, and persisted
service stores from SQLite, then restores the request's undo/redo and sync
snapshot. Normal successful edits do not copy the entire namespace. Storage
transitions hold maintenance through commit/recovery and reject overlapping
mutating requests. The request admission counter also excludes overlapping asynchronous mutations; contention returns 409 without blocking the event loop.

### Locking and sensitive runtime work

Encrypted logout clears the existing runtime stores plus evidence-token and
tag-matching LRUs. Sensitive caches are disabled while locked; their calculation
and clearing share a lock so a computation already underway cannot refill a
purged cache. Unlock enables caching again. Session replacement clears the LRUs
and AI state. Runtime generations cancel registered AI streams and prevent old
hydration/link-title jobs from publishing into a later unlocked session. Shell
runs are stopped, their reader threads are joined, and retained output is cleared
when an encrypted namespace locks.

These controls release application-owned references. They do not promise
forensic erasure of Python allocations, OS buffers, already-transmitted provider
requests, or a network worker's temporary local variables before it returns.
Process interruption and rollback are tested with disposable databases; physical
power loss and Windows/Linux filesystem behavior still require platform validation.

### Encrypted Namespace Storage Audit

Run the read-only audit from a source checkout:

```bash
.venv/bin/python scripts/audit_encrypted_namespaces.py
```

Installed packages also expose `metalist-audit-encryption`. Both commands scan
every canonical database under `~/MetaList/namespaces`. Use
`--namespaces-dir /path/to/namespaces` to audit another namespace root.

`main.py` runs the same read-only scan before every launcher startup, and
`serve_namespace.py` runs it before every namespace-server startup. A passing
scan is printed normally. Findings are classified as `MIGRATION` or `FATAL`.
Only the known authenticated migrations—version-0 client-state payloads and
version-2/3 search-history replacement—may defer remediation until login;
startup continues solely so those migrations can unwrap the DEK and rewrite them. Plaintext anywhere else,
incomplete/malformed encryption metadata, unknown storage, nonce reuse, schema
damage, discovery failures, and current-version plaintext stop startup before
any namespace listener launches. The standalone audit command still exits
nonzero for migration findings so backup gates never treat a plaintext archive
as fully protected.

For each namespace whose `app_settings.encryption_enabled` flag is set, the
audit checks the main and sibling files databases. It validates every declared
sensitive payload/ciphertext/nonce/tag tuple, AES-GCM nonce and tag sizes,
cross-database DEK nonce uniqueness, encrypted-vault metadata, SQLite integrity,
and the complete known table/column contract. Unknown tables or columns fail the
audit so a new persisted feature cannot silently bypass review. Stored values
and row identifiers are never printed. Plaintext namespaces are listed but not
audited for ciphertext coverage.

Exit status is `0` only when at least one namespace is found and every encrypted
namespace passes; any unreadable database, schema drift, unprotected sensitive
column, malformed encryption metadata, or reused DEK nonce exits `1`.

This is primarily a logical storage-contract audit and does not decrypt data. It
proves that sensitive live SQLite values use the application's ciphertext
storage format, but cannot authenticate ciphertext without each namespace
password. The authenticated `2 → 3` migration separately removes its legacy
query identifiers from live freelist/WAL storage. Historical backups retain their original snapshot bytes and migrate only after restoration into the live database path.
The audit itself still does not inspect arbitrary stale bytes in backups, logs,
swap, or filesystem snapshots.

### Strengths
- **Strong Key Derivation**: Memory-hard Argon2id protects against brute force
- **Future-Proof**: Stored KDF cost allows seamless security upgrades
- **Authenticated Encryption**: AES-GCM prevents tampering and ensures integrity
- **Memory-Only KEK**: KEK never touches disk
- **Unique Nonces**: Each encryption uses a fresh random nonce
- **Defense in Depth**: Multiple layers (auth + encryption)

### Threat Model

**Protected Against:**
- Database theft (encrypted notes, strong Argon2id)
- Brute force attacks (configurable KDF costs)
- Tampering (GCM authentication)
- Rainbow tables (random salts)
- Replay attacks (unique nonces)
- Security obsolescence (upgradeable KDF costs)

**Not Protected Against:**
- Process-memory inspection or dumps while a namespace is unlocked; the server
  holds the DEK and decrypted runtime stores in RAM.
- Browser-process inspection, a sufficiently privileged browser extension, or
  other client compromise while decrypted content is rendered.
- A malicious local process or server administrator with access to application
  memory or executable code.
- Weak passwords (use password strength requirements)

## Implementation Notes

### Session Management
- An unlocked namespace process maintains the DEK in memory (not the password
  or KEK) so it can serve authenticated sessions.
- DEK is tied to authentication tokens
- Explicit logout removes the live DEK reference and purges decrypted runtime
  stores. Optional idle browser-auth expiry intentionally keeps the hydrated
  server cache warm for re-login and is not a memory-purge boundary.
- Dropping references is not guaranteed forensic erasure: Python and browser
  runtimes do not promise that released allocations are immediately
  overwritten, so stale bytes may remain until reused or the process exits.
- Server restart requires re-authentication

### Mutation Transaction Enforcement
- Mutating FastAPI routes are expected to use `@transactional_route`.
- Startup sanity rejects mutation endpoints that omit the decorator or place it in the wrong order.
- Request-scoped writer sessions are reused across the wrapped route path so the commit happens once at the end of the request, not in intermediate steps.

### Runtime Memory Safeguards
- Core dumps are disabled at process startup (`RLIMIT_CORE=0`) on POSIX systems.
- On macOS, startup hardening checks can enforce:
  - no hibernation-to-disk behavior (`hibernatemode=0`, `standby=0`, `autopoweroff=0`)
  - swap reported as encrypted by the OS (`sysctl vm.swapusage` includes `(encrypted)`).
- These checks fail startup when enabled and not satisfied.
- Environment toggles:
  - `SECURITY_HARDENING_ENABLED`
  - `SECURITY_REQUIRE_MACOS_NO_HIBERNATION`
  - `SECURITY_REQUIRE_ENCRYPTED_SWAP`
- Default behavior:
  - core dump disabling enabled by default
  - macOS hibernation/swap enforcement disabled by default (enable explicitly for strict mode).
- Windows user-mode crash-dump policy is controlled by Windows and the host
  administrator. MetaList does not claim to prevent Windows Error Reporting,
  Task Manager, a debugger, or another sufficiently privileged process from
  capturing its unlocked process memory.

## Remote Access / HTTPS

- Plain `python main.py` from a source checkout now restarts already-running namespaces from the current checkout, launches stopped namespaces with their saved profiles, prints their URLs, and exits.
- `python main.py --namespace work` starts a separate process against `~/MetaList/namespaces/work/work.metalist.db`.
- After a namespace has been launched once with explicit ports, `python main.py work` reuses that namespace's remembered HTTP / HTTPS ports from its main namespace DB.
- With no explicit namespace on a single-namespace launch, the default namespace DB is `~/MetaList/namespaces/default/default.metalist.db`.
- Deleting a namespace removes its namespace directory on disk, including the namespace SQLite databases, launch-profile metadata, and backups under `~/MetaList/namespaces/<namespace>/`.
- HTTPS is opt-in via existing PEM files at `certs/metalist-cert.pem` and `certs/metalist-key.pem`, or explicit `METALIST_TLS_CERT` and `METALIST_TLS_KEY`.
- The default listener is loopback-only (`127.0.0.1`). When PEMs exist, MetaList starts HTTPS on the same bind host at port `8443` and redirects non-loopback HTTP hostnames to HTTPS.
- For direct HTTPS from an explicit single-namespace `python main.py ...` run, set both:
  - `METALIST_TLS_CERT=/path/to/fullchain.pem`
  - `METALIST_TLS_KEY=/path/to/privkey.pem`
- For a quick LAN cert, use `./scripts/generate-lan-cert.sh` and then open `https://<lan-ip>:8443` from the other machine.
- For HTTPS terminated by a reverse proxy, keep MetaList on loopback and trust forwarded headers only from the proxy IPs:
  - `METALIST_HOST=127.0.0.1`
  - `METALIST_ALLOWED_HOSTS=notes.example.com`
  - `METALIST_FORWARDED_ALLOW_IPS=127.0.0.1,::1` (default)
- An external proxy must preserve the original `Host` header and replace `X-Forwarded-For`/`X-Forwarded-Proto` with authoritative values. MetaList ignores `X-Forwarded-Host`; Uvicorn accepts forwarded scheme/client metadata only from `METALIST_FORWARDED_ALLOW_IPS`.
- Every request must use a loopback host, the specific non-wildcard `METALIST_HOST`, or a hostname/IP explicitly listed in `METALIST_ALLOWED_HOSTS`. This blocks hostile DNS-rebinding `Host` values.
- State-changing browser requests must carry an `Origin` that exactly matches the effective request scheme, host, and port. Bearer-token clients without the auth cookie may omit `Origin`; cookie-authenticated requests may not.
- Login rate limiting uses Uvicorn's resolved client address. A trusted proxy can supply that address through `X-Forwarded-For`; an untrusted sender's header is ignored by Uvicorn and never parsed directly by application code.
- Namespace selection is independent of listener ports. Use `--namespace` / `METALIST_NAMESPACE` for DB selection and `--port` / `METALIST_PORT` for listener selection.
- Listener precedence is explicit CLI flags > env vars > saved namespace profile in the namespace DB. A namespace without a saved launch profile must be launched once with explicit ports or configured from the UI.

### Agent Access
- MetaList does not expose an MCP endpoint, MCP client, agent sidecar, or agent-specific command-line entry point.
- Legacy `mcp_port` values may remain in schema-v1 namespace launch-profile rows and backup metadata for compatibility, but no runtime listener or route consumes them.
- The read-only AI chat freezes server-resolved view membership. Before any cloud
  prompt or debug trace is constructed, a namespace-level disclosure policy removes
  notes matching configured blacklist tags/phrases and requires an OR whitelist
  match when a whitelist is present. Tag checks use inherited plus ontology-expanded
  search tags, blacklist wins, and a hidden ancestor removes its full subtree.
  `@password` always removes its full subtree for local and cloud providers.
- `POST /api2/ai/cloud-privacy/preview` is authenticated and applies the same
  evaluator to visible note IDs solely to render readable gray hover feedback. It
  does not replace or weaken server-side scope filtering.

### Multi-Client Support
- Token issuance clears any previous tokens for that namespace process (one active browser tab/session per namespace)
- Token verification is bound to an `X-Metalist-Tab-Id` owner (tab-scoped sessions)
- Browser auth cookies use namespace-scoped names (`metalist_auth_<namespace>`), so sessions on different namespace ports do not overwrite each other in the browser's host-wide cookie jar.
- DEK is stored in memory alongside the active token; no DEK is persisted to disk
- Explicit logout fails closed for password-protected namespaces: the server purges the DEK, decrypted notes, caches, tab state, reminders, tag activity, attachment metadata, undo/sync state, and ontology state before serving the locked session. Idle expiry is disabled by default; when explicitly enabled, it invalidates browser authentication but keeps the hydrated server cache warm so re-login does not rebuild the namespace.

### Authentication Route Boundary

- Public application/API endpoints are matched by exact path. Login, passwordless session creation, status, pre-login namespace selection, and the namespace restart landing pages are individually allowlisted.
- Prefix matching is reserved for static assets and opaque namespace delete/rename job polling paths.
- Similar-looking paths do not inherit public access: for example, `/api2/auth/session` is public while `/api2/auth/sessions` remains authenticated.
- The authentication-router inventory test fails if a future auth endpoint crosses the public boundary without an explicit test update.
- `/dev/use-dev-db` and `/dev/use-file-db` are mounted only in `TEST_MODE`; production processes do not expose those routes.

### Login Rate Limiting
- Enforced on `POST /api2/auth/login` before password verification.
- Default configuration:
  - `LOGIN_RATE_LIMIT_MAX_ATTEMPTS=5`
  - `LOGIN_RATE_LIMIT_WINDOW_SECONDS=300`
  - `LOGIN_RATE_LIMIT_BLOCK_SECONDS=300`
- Keying strategy:
  - first `x-forwarded-for` hop when present
  - fallback to direct client IP
  - fallback to user-agent prefix when IP is unavailable.

### Password Requirements
- New and changed passwords must contain 12-72 characters.
- No character-class composition rules are imposed; spaces and passphrases are supported.
- The server uses the offline `zxcvbn` estimator and requires score 3 or higher,
  rejecting common words, known password patterns, dates, repeats, keyboard walks,
  and similarly predictable choices. Passwords are never sent to a third party.
- Existing passwords are grandfathered: login verifies them against their stored
  Argon2id profile without applying the newer creation policy.
- The 72-character ceiling is applied before estimation to bound estimator work.
- The random-password generator uses browser `crypto.getRandomValues()` and scores
  results locally with the official JavaScript zxcvbn build. The browser scorer is
  lazy-loaded only when the generator opens; generated passwords are not submitted
  to a server for scoring.

## Data Import Strategy

For fresh imports using `convert-from-legacy.py`:

1. This is a destructive fresh-import path (existing DB is deleted first).
2. Import plaintext legacy data into a new SQLite database.
3. Optionally set a password at import time.
4. Password enablement writes the same vault metadata (`vault_version`, `kdf_algorithm`)
   and KDF parameters used by the runtime auth service.
5. Input selection:
   - pass `--input /path/to/export.json` for non-interactive runs
   - omit `--input` to use the Tk file picker.
6. Namespace targeting:
   - pass `--namespace work` to import into `~/MetaList/namespaces/work/work.metalist.db`
   - omit `--namespace` to import into `~/MetaList/namespaces/default/default.metalist.db`.
7. Launch profile prompting:
   - if `--namespace`, `--port`, or `--https-port` are omitted, the importer prompts for them
   - the chosen ports are saved in the namespace DB so later `python main.py work` can reuse them.

## API Endpoints

When password protection is enabled, browser requests use:
- HttpOnly `metalist_auth_<namespace>` cookie
- `X-Metalist-Tab-Id: <uuid>` (required by auth/token verification)

Non-browser/manual clients may still send:
- `Authorization: Bearer <token>`

Auth:
- `POST /api2/auth/login` - Authenticate and establish session
- `POST /api2/auth/logout` - Revoke token and clear in-memory keys
- `POST /api2/auth/session` - Claim passwordless session (only when no password is set)
- `GET /api2/auth/status` - Poll auth/encryption status
- `GET /api2/auth/client-state` - Load namespace-scoped client preferences and command-palette usage
- `PUT /api2/auth/client-state/preferences` - Persist namespace-scoped client preferences
- `PUT /api2/auth/client-state/command-palette-usage` - Persist namespace-scoped command-palette usage history
- `POST /api2/auth/namespaces/delete/preflight` / `POST /api2/auth/namespaces/delete` - Delete a named non-default namespace after typed namespace confirmation and, when that namespace is password-protected, password re-entry. Deleting the active namespace moves the tab to a namespace-removal status page while a detached worker shuts down the current namespace and deletes its directory; deleting an inactive namespace stays in the current tab.
- `POST /api2/auth/settings/password/create` - Enable password protection
- `PUT /api2/auth/settings/password/change` - Change password (re-encrypts DEK)
- `DELETE /api2/auth/settings/password/remove` - Disable encryption
- `GET /api2/auth/sessions` - List active session(s)

Backup:
- `GET /api2/backup/settings` - Read backup destination settings
- `PUT /api2/backup/settings` - Update the configured backup folder, selected namespaces, and per-namespace retention count
- `GET /api2/backup/list` - List available configured-folder backup snapshots
- `POST /api2/backup/run` - Atomically accept and persist the required folder/namespace/retention settings, create one versioned archive per selected namespace, apply retention, and return concrete result rows; the UI does not report success before this response
- `POST /api2/backup/restore` - Restore the selected folder archive snapshot and trigger the usual post-restore runtime reset/restart flow
  - Backup scope follows the active DB path, so namespaced runs use `~/MetaList/namespaces/<namespace>/backups/` and write one versioned archive per snapshot, for example `cla-<timestamp>.metalist-backup.tar.gz`. Legacy `.bak` snapshots remain restorable.
  - Restoring `cla` into `cla` is allowed even when that namespace already exists. Importing `cla` under another target name requires that target namespace to be new and rejects saved launch-port conflicts.
  - Backup settings are stored per namespace; when namespace encryption is enabled, that settings payload is encrypted at rest too.
  - Manual backup runs now target one selected folder and can include multiple namespaces in the same run.
- `POST /api2/backup/folder/pick` - Open the native folder picker and return the selected absolute backup path

Notes:
- `POST /api2/notes/view`
- `POST /api2/notes/{note_id}/run-shell` - Run an `@shell` note only when the active namespace is password-protected
- `POST /api2/notes/new`
- `POST /api2/notes/new-sibling/{note_id}`
- `POST /api2/notes/new-child/{note_id}`
- `PUT /api2/notes/{note_id}`
- `PUT /api2/notes/{note_id}/save`
- `POST /api2/notes/{note_id}/move`
- `POST /api2/notes/{note_id}/collapse`
- `POST /api2/notes/{note_id}/expand`
- `DELETE /api2/notes/{note_id}`
- `POST /api2/notes/{note_id}/copy`
- `POST /api2/notes/paste-sibling/{target_note_id}`
- `POST /api2/notes/paste-child/{target_note_id}`
- `POST /api2/notes/undo`
- `POST /api2/notes/redo`

## Monitoring and Logging

### Should Log:
- Authentication attempts (success/failure)
- Login rate-limit blocks (key + retry delay, no secrets)
- Password change events
- Session creation/destruction
- Encryption system enable/disable

### Should NOT Log:
- Passwords or keys
- Decrypted note content
- Token values
- Salt or nonce values

## Future Enhancements

- **Advanced UI Controls**: Add UI option to customize Argon2id time-cost during password changes
  - Toggle for "Advanced Settings" in password change modal
  - Input field for custom time-cost with validation (1 - 10 range)
  - Real-time estimate of login delay impact
  - Default to current config value but allow override
- **Key Rotation**: Periodically generate new DEK and re-encrypt notes
- **Hardware Security Module (HSM)**: Store DEK in HSM for additional protection
- **Client-Side Encryption**: End-to-end encryption with client-side keys
- **Multi-Factor Authentication**: Additional authentication layer


### Request bounds and lock ownership

The HTTPS transport retains separate listeners and sends response headers and body chunks immediately. It uses at most 32 workers, 64 KiB chunks, a 60-second socket idle timeout, and a 30-minute total request deadline checked between transfers. Disconnects close the upstream connection when observed during a read/write or by timeout. Chunked incoming bodies are explicitly rejected with 501; ambiguous Content-Length/Transfer-Encoding and duplicated Host headers return 400. Hop-by-hop headers are stripped in both directions, including fields nominated by Connection. Forwarded peer headers are replaced with the actual client address.

Strict required note request contracts and client preference/usage validation run before route mutations. Invalid external bodies return sanitized 422 without their input values; stale note IDs return 404. Host/Origin validation precedes URL parsing by other middleware. Internal invariant failures still propagate. The obsolete v1 API returns 410 instead of terminating the server.

Attachment uploads default to 100 MiB per file, configurable with positive-byte `METALIST_MAX_ATTACHMENT_BYTES`. The multipart envelope limit is that value plus 1 MiB, enforced on actual received bytes as well as declared length. Four concurrent attachment transfers (uploads and downloads) are admitted; excess requests return 429. Over-limit files return 413 before storage/registry changes. Readers close their temporary file in `finally`; multipart overflow uses the parser's cleanup path. Downloads preflight stored blob length and reject oversized legacy attachments before reading the blob; increase the configured limit when retrieving one. Startup and metadata lookups omit blobs. Encryption/decryption still require complete per-file buffers; password transitions process one file at a time. No aggregate namespace quota is imposed.

Lock ownership: synchronous route transactions and background hydration/link publication use `bulk_operation_guard.lock`; its separate short admission mutex protects mutation counts and bulk operation/question state. No admission mutex is held across an await. Bulk answers/cancellation are queued with `call_soon_threadsafe`. Tokens and sync/clipboard operations each have their own RLock and return copied snapshots; clipboard snapshots copy nested values. NoteStore, search index, tab/reminder/link stores and sensitive caches retain their existing private locks. Hydration/link work checks the runtime generation before publishing. Acquire the outer bulk lock before admission/service locks; do not acquire the outer bulk lock from inside a service lock. These guards protect existing mutation paths, not a general serializable snapshot API spanning every independent GET.

Temporary DB read permission is a ContextVar layered over startup's global read state, so one thread/task cannot enable another's reads or restore a stale global value.

Database version 9 removes sound support from the installed live namespace only. Encrypted payload cleanup requires successful unlock. The sidecar table drop is idempotent; an interrupted 8→9 migration can retry after restart. Existing backups and legacy sidecars are never migrated in place.


## Runtime memory and shell budgets (2026-09-12)

All environment limits below are positive integers read at process startup. Changing them requires restarting the namespace.

| Setting | Default | Behavior at limit |
|---|---:|---|
| `METALIST_VIEW_CACHE_BYTES` | 67108864 (64 MiB) | Evict least-recent baselines; an uncached view receives a full snapshot. |
| `METALIST_UNDO_BYTES` | 33554432 (32 MiB) | Global undo/redo payload budget; also used independently for server clipboard payloads. |
| `METALIST_UNDO_OPERATIONS` | 100 | Discard complete oldest operations in each undo context. |
| `METALIST_CLIENT_ENTRIES` | 32 | Bound client registries, view baselines, and retained shell run records. |
| `METALIST_CLIENT_IDLE_SECONDS` | 1800 | Expire idle view/client/undo state on subsequent access. |
| `METALIST_SHELL_MAX_SECONDS` | 1800 | Timeout zero uses this deadline; requests above it are rejected. |
| `METALIST_SHELL_MAX_RUNS` | 4 | Additional active runs receive 429. |
| `METALIST_SHELL_OUTPUT_BYTES` | 4194304 (4 MiB) | Combined stdout/stderr bytes; retain the bounded prefix, stop the run, and display the limit error. |

A view cache retains only the latest search/sort baseline for each client/tab. Closed tabs and replaced/logged-out sessions discard obsolete client payloads. View diagnostics expose entry/hit/miss/eviction counts and estimated bytes only. Sensitive memoization caches each cap retained inputs/results at 16 MiB and are cleared on lock. Object accounting includes shared container/dataclass payloads but is an estimate of retained Python allocations, not a process-RSS guarantee. Namespace data, temporary serialization, database caches and request buffers have separate costs.

Undo limits preserve whole operations. If a single operation exceeds the available budget, its context loses both older undo and redo so later undo cannot cross an untracked mutation. Reaching history trimmed by an operation/byte limit produces an explanatory info banner. Idle/client eviction or session replacement discards the whole context; users should not treat undo as durable recovery.

Shell output is read in 4 KiB chunks and completed results expire after five minutes even without polling. Logout, replacement login/session, lock, restore, and shutdown stop runs and clear output. POSIX uses a separate process group; Windows enumerates and stops descendants in reverse order, including children of an exited parent. These are lifecycle controls for explicitly authorized local commands, not an OS security sandbox: deliberately detached processes can escape ancestry/group cleanup. Real POSIX cleanup is tested locally; actual Windows validation remains required. Polling an expired run returns 404.

## Supported hierarchy and runtime reads

Notes support **256 levels, counting a root as level one**. Hydration rejects cycles, missing parents and deeper trees. Live insertion/reparenting validates the destination and subtree height before writing; invalid requests return 422. Views, clipboard rendering, HTML export and AI tree serialization use iterative traversal. The finite depth also keeps nested JSON within supported encoder/browser constraints. Restore validates only the installed live database; the source archive and legacy sidecars remain immutable.

Ordinary protected-route authentication uses in-memory encryption/session state. Schema initialization runs once per live database identity, with explicit invalidation after restore/recovery or database switching. Intentional runtime SQLite access includes auth status/version inspection, attachments, startup/unlock/restore, first session-timeout cache hydration, and topology checks inside mutations. Sorted views cache subtree aggregates by NoteStore revision and reuse unchanged content lengths; edits, moves, deletes, undo and hydration invalidate them.
