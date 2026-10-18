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
