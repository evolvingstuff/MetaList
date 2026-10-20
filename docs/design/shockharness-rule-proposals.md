# Rule proposals for ShockHarness

Rules proposed from bugs found in MetaList, kept here so they can be resent if needed. Rules 1 and 2 (error state overwritten by a reload; acting on an async result built for older input) were sent on 2026-10-17 and are in ShockHarness's backlog (`docs/ideas.md`, commit be9b977). Rules A to E and the false alarm below were written up the same day for the maintainer to pass on.

```text
Three rule proposals from MetaList races that STATE001 led us to (2026-10-17). Each is more precise than STATE001, which flags all module-level mutable state whether or not it is locked.

RULE A: Publish before initialize (Python, likely JS too)
Bug: app/utils/encryption.py `get_encryption_service_with_token`:
  `_encryption_service = EncryptionService()` then `_encryption_service.dek = dek`
Between the two statements, another thread's cache hit returns the shared service with dek=None, and the request fails with "no DEK". `set_session_dek` had the same shape.
Shape: an assignment of a newly constructed object to a module-level global (or a `self.` attribute that other threads read), followed in the same function by attribute writes on that global (`G.x = ...`) before the function returns. The fix is to build in a local, set the fields, and assign the global last.
False positives: low. Single-threaded modules would match, but that's harmless; the fix is always available and clearer.

RULE B: State checked outside the lock that guards its writes (Python)
Bug: app/security/authenticated_logging.py `EncryptedTextStream.write`:
  `if self._closed: raise`, then `encrypt(dek=self._dek)`, then `with self._lock: destination.write(...)`
Meanwhile `close()` sets `self._dek = b""` and `self._closed = True` under `with self._lock`. A close between the check and the write let the write land after the close.
Shape: in a class, attribute X is written inside `with self.<lock>:` in one method, and another method reads X (in a condition or as an argument) outside any `with self.<lock>:` block, then acts on that read. Same for module-level `with _lock:` and a global.
False positives: moderate. A deliberate lock-free read of one bool (a fast-path flag) would match. A "reason" suppression covers that, or it could be review severity.

RULE C: A read that writes shared state (Python)
Bug: app/services/auth_service.py `get_settings()` called `set_encryption_required(...)` from the row its own DB connection saw. GET requests call it with no serialization, so during a password change a read that saw the pre-commit row flipped the security flag back for a moment. In that window, saves stored plaintext and logout skipped the purge.
Shape: a function or method whose name says it reads (`get_*`, `fetch_*`, `load_*`, `read_*`, `is_*`, `has_*`), or that is reached from an HTTP GET handler, either assigns a module-level global or calls a `set_*`/`mark_*`/`enable_*`/`disable_*` function that does. The fix is that only the code that makes the change publishes it.
False positives: moderate for the name heuristic, because caching getters (lazy fill of a cache) would match. Those could be excluded when the written global is only ever assigned the getter's own return value. The "reached from a GET handler" variant needs the call graph but is precise.

All three are fixed in MetaList with tests that force the bad interleaving (thread barriers) and fail on the old code. For context: STATE001's 45 findings gave 4 real races plus a few minor issues; the other 44 are now suppressed with their verified lock or single-context reason.

Also, a false alarm: ASYNC003 flags `Promise.allSettled(...)` in scripts/browser-validation/browser-startup.mjs:489 as unchecked, but the very next line is `for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;`. The code is at module top level (inside a top-level `try`), which may be why the check isn't seen.

RULE D: The same small helper defined in many modules (JavaScript, Python)
Bug: MetaList had 20 separate HTML escapers, one per dialog, added between January and October 2026 as each dialog was written (there was no shared module, so each new one copied the last). All escaped the same five characters, but 6 of the 20 returned '' for a non-string where the others threw, so a bug in those dialogs showed as blank text instead of failing. The drift is the harm: one copy weaker than the rest, and no single place to fix or to name as a contract producer (the property-contracts catalog needs one `escaped_html` producer).
Shape: two or more function definitions in different modules whose bodies are identical after normalizing identifiers (parameter and local names alpha-renamed, comments and whitespace dropped), or identical up to a small edit distance on that normalized form, with the function at least N statements long (say 3) so trivial one-liners do not match. Report each group once, listing every copy, with the near-identical ones (the drifted copies) called out separately from the exact ones.
False positives: low for exact normalized matches of non-trivial bodies; intentional duplication (an entry script that must not import the app, a vendored file) is excluded by role or path, or suppressed with a reason. Near-matches are where the drift bugs live, so they are worth reporting at review severity.

RULE E: The same compound condition written out in many places (JavaScript, Python)
Bug shape: a condition that stands for one concept ("this note is the one being edited", "the app is idle", "the bank is open") is spelled out by hand at every use instead of being a named predicate. When the concept changes, someone updates some copies and not others, and the copies drift apart silently. Negated copies are a second hazard: !(a && b) written by hand as !a || !b is an easy place to slip.
Evidence from MetaList (2026-10-17): `ModeContext.isEditing && ModeContext.currentNoteId === id` appears 12 times in 5 files, and its negation `!ModeContext.isEditing || ModeContext.currentNoteId !== id` 18 more times; the test-idle condition `!mode.isLoading && !CommandGate.isBusy()` is copied into the idle() helper of 24 browser test suites, so a new idle condition (a view request in flight) would need 24 coordinated edits or the tests turn flaky.
Shape: two or more boolean expressions, in different functions or modules, that are equal after normalization: operands compared structurally with identifiers kept (the concept lives in the names), commutative && / || operands sorted, negations pushed inward by De Morgan so a condition and its hand-written negation match as one group, comparison sides normalized (a === b vs b === a). Minimum size: at least three operands, or two operands that are themselves member accesses or calls, so `x && y` noise does not match. Report each group once, listing every site, marking which sites are the negated form, and suggest a named predicate (is_editing_note(note_id)) as the remediation.
Near-misses are the valuable part: a group where one site has an extra or missing operand (a copy that drifted) should be reported separately and called out, since that is either the bug already happened or a deliberate difference that deserves a name of its own.
False positives: low for exact normalized matches at the size threshold; conditions that are coincidentally identical but mean different things are rare once identifiers must match. A deliberate repetition (a guard re-checked after an await) can be suppressed with a reason.
Related: RULE D (duplicate function bodies) is the same drift problem for behavior; this is the same for decisions. GUARD001 infers that a call is usually guarded; this rule finds the guard itself duplicated.
```

## For later: a state-ownership rule family (proposed 2026-10-17)

Not a single rule but a configurable family, in the style of the property-contracts catalog: the project declares its state design, and ShockHarness holds the code to it. The design itself (one owner or many) is the project's choice; the tool does not prescribe it.

```text
STATE OWNERSHIP (JavaScript, Python), configured per project
Motivation: MetaList keeps client state in one owner (ApplicationState / ModeContext: getters and setters, an exception on an invalid value or on a write that leaves a value unchanged). That discipline caught subtle bugs and wasted work, and MetaList enforces part of it itself (the startup sanity rule for owned state). The server keeps its client-tracking state (tab state, warm views, sync, undo, ...) in about 20 module-level stores with their own locking habits; a STATE001 audit of 45 of their globals found 4 races. The client is single-threaded, so one owner works; the server runs a thread pool plus the event loop, so one owner would need one lock and serialize unrelated requests: there, one owner per store, each with its own lock.
Configuration: the owner classes or base classes (e.g. ApplicationState in JS, a StateStore base in Python), and the threading model per language or path ("single-threaded: owners" or "threaded: one owner per store, each with a lock attribute").
Checks:
1. State lives only in declared owners: module-level mutable state outside an owner is a finding (STATE001 with an allowlist, so what remains is real).
2. Writes go through the owner: assigning an owner instance's fields from outside the owner's own methods is a finding.
3. Threaded model only: every write to an owner's fields is inside `with self.<lock>:` (the write side), and every read that a decision depends on is too (RULE B is the read side).
4. Owners inherit from the declared base that performs the runtime checks; the redundant-write check itself is runtime-only (whether a value is unchanged is not known statically).
False positives: low once owners are declared; bootstrap writes at import time or construction can be exempted by role (module initialization, __init__).
MetaList use case: TODO.md, "Server State: Owned Stores And Redundant-Write Detection".
```

## Proposed 2026-10-20: SQLite copies and immutable files

From reviewing how MetaList copies its databases. MetaList's own startup checker (BKP001) covers part of this for its backup code only; a general rule would hold every project, and every file of MetaList, to it.

```text
RULE F: A live SQLite database copied as a file (Python)
Bug shape: in WAL mode, recent commits live in the -wal file until a checkpoint folds them into the .db. A plain file copy of a database in use misses them, or catches the main file mid-write and yields a copy that opens but is subtly corrupt; it is found at restore time. MetaList copies correctly today (Connection.backup() for backups, pre-update backups, restores and recovery snapshots), but nothing outside its backup code stops a future shutil.copy of a live database.
Shape: a file copy whose source is a SQLite database: shutil.copy / copy2 / copyfile / copyfileobj / move, Path.read_bytes() written elsewhere, or tarfile/zipfile adding the path, where the path ends in .db / .sqlite / .sqlite3 (or comes from a variable or function the project declares as a database path), and the source was not produced by sqlite3.Connection.backup() or VACUUM INTO. Also: sqlite3.connect with immutable=1 on a path that may have a -wal sidecar (the newest commits are ignored).
Remediation: Connection.backup() into the destination, or VACUUM INTO; or checkpoint (PRAGMA wal_checkpoint(TRUNCATE)) with writers stopped before a plain copy.
False positives: copies of a database known to be closed or sealed (a finished snapshot); allow a suppression with a reason.

RULE G: Files declared immutable (Python), configured per project
Shape: paths or roles the project declares immutable (MetaList: backups) may be opened only for reading or exclusive creation (mode "x", "x:gz"), never "w" / "a" / "r+" / "w:gz"; no os.replace / rename / chmod / utime / truncate / unlink on them except through one configured delete function; no writable SQLite connection to them. Publishing by write-then-rename is forbidden too (it replaces).
False positives: low once the roles are declared. This is the reusable core of MetaList's BKP001.

RULE H: Import boundaries (Python, JavaScript), configured per project
Shape: module A must not import module B (MetaList: startup and database migrations must not import the backup service, so a migration can never touch a backup). Reported at the import.
False positives: none for an exact configured pair.
```

Also proposed during the same work (2026-10-19 and 20), for the maintainer to pass on with these:

- A stub that the code under test no longer reaches: a test that patches a function the test never ends up calling (a refactor routed around it) is a test that silently tests the real thing. A MetaList launch test, bypassed this way, stopped and relaunched the user's real servers.
- Set methods given a non-set inside a loop: `set.intersection` / `issubset` / `isdisjoint` / `difference` called with an array, list or generator in a loop each read the whole argument instead of hashing; sorted-array tag postings made suggestions after a tag and a space stall this way.
- A full scan per candidate: a loop over N candidates whose body iterates a whole collection of similar size (O(N²)); finding each candidate's tag family by scanning every tag did 16 million comparisons a keystroke.
- A long-lived string made by casefold() / lower() in a new set while the same code keeps a memo for that conversion: the memo is bypassed and copies multiply (38 MB in MetaList's search index).
- Server HTML handed to a browser sink that declares sanitized_html must carry sanitized_html on the Python side too (an image-resize response returned the input it had passed to the sanitizing save).
- A function that builds a whole HTML document (<!DOCTYPE html>) from rendered parts must pass them through a declared sanitizer and include a Content-Security-Policy meta (MetaList's HTML export did neither).
