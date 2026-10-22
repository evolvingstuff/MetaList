---
name: fix-violations
description: Repair ShockHarness findings (MAGIC001, EXC001-EXC003, DEF001-DEF006, SUPP001/SUPP002) without masking behavior. Use when shockharness check or gate exits 1, when a CI job running ShockHarness fails, or when asked to clean up magic numbers, broad catches, parameter defaults or fallback values. Covers running the analyzer, finding the intended contract behind each finding, adding a characterization test, changing the code, rerunning tests and analyzer, and the rules for suppressions.
---

# Fix violations

A ShockHarness finding says that code hides a decision: a number with no
contract, a failure turned into a value, a missing value silently replaced.
Fixing it means making the decision explicit, not making the finding go away.
This skill is the corrective workflow; `write-compliant-code` is the
preventive one and `pre-commit-review` is the final check.

## Never do these

- **Never delete a `try`/`except` or `try`/`catch` to satisfy `EXC001`** without
  deciding, and writing down, what the caller must now handle. Removing the
  catch may be right (the failure should propagate) or may hide that a
  boundary is missing from `.shockharness.toml`.
- **Never replace `.get(key, default)` with `[key]` mechanically** to satisfy
  `DEF002`. Indexing turns a silent default into a `KeyError`, which is correct
  only if the key is required. If it is optional, the type must say so and the
  code must branch on absence explicitly.
- **Never add a suppression without a contract review.** A suppression needs an
  exact rule ID and a reason that names what the rule cannot see (`# shockharness:
  ignore[VERIFY005] reason="reached through importlib by name"`). "Legacy", "TODO" and
  "false positive" are not reasons. A malformed suppression is a `SUPP001`
  error; one that silences nothing is a `SUPP002` warning.
- **Never widen a boundary, loosen a profile or lower a severity to get green.**
  Those are policy changes; propose them with a recorded rationale.
- **Never trade a forbidden catch for a quieter failure**: a check that returns
  the same fallback, a `raise SystemExit` deep in the code, or a project error
  derived from `SystemExit`. A failed read or write is reported, never dropped.
- **Never move a number into an unexplained constant** (`THIRTY = 30`, MAGIC004)
  **or spell it otherwise** (`len("  ")`, `int("30")`, `indent="  "`, MAGIC005). The name
  must say what the value means; a module-level named constant needs no suppression.

## Workflow

### 1. Run the analyzer and read the whole report

```bash
shockharness check .                                  # text report, exit 1 on violations
shockharness check . --format json --output report.json
shockharness rules explain EXC003                     # guarantees, limitations, remediation for one rule
```

Each finding line is `path:line:col: RULE severity: message  [evidence]`; an *unknown*
finding reads `RULE severity (unknown): ...` (JSON: `"status": "unknown"`). The message
names the construct, the confidence (`exact`, `approximate`, `unresolved`) and, for
`EXC001`, why no boundary applies. The `unknown:` trailer line counts unknown findings and
names the families whose `fail_on_unknown` makes them gate. Also read the `config:` line
(profile, deviations) and any `rules not implemented (not analyzed)` line, so you know what
was not checked.

### 2. For each finding, identify the intended contract

Ask what the code promises when the value is absent or the operation fails.

| Finding | Question | Typical answer |
|---|---|---|
| `MAGIC001` | Why this number? Who decides it? | Variable policy: a required, validated configuration parameter. Invariant or protocol value: a module-level named constant with a cited source (no suppression needed; decision 36). Never disguise it as arithmetic, a length, a string or a data file. |
| `DEF001` | May the caller really omit this argument? | Usually no: make it required and update the callers. If yes: the type is `T \| None`, and the body branches on `None` by name. |
| `DEF002`, `DEF004`, `DEF003` | Is the key or value required? Is absence a normal state? | Required: index it, let `KeyError`/`TypeError` surface at load time, or validate once at the boundary. Absence is a normal state (an empty view has no root entry, an unused tag has no posting): branch where the absence matters and do the absent case's own work there (`if tag not in index: continue`); do not force an index there, that turns a normal state into a crash. A helper that returns a stand-in (`if k in m: return m[k]` then `return []`) is the fallback again, and one that takes the default as a parameter (`value_or(mapping, key, default)`) is `.get` under another name. A stand-in that really is the meaning gets a suppression with the reason, once. From outside (configuration, a request): validate where it enters. |
| `DEF006` | Where is configuration validated? | In one load function that reads required keys, validates them and raises on a missing or invalid value. Nothing downstream reads the environment. |
| `EXC001`, `EXC003` | Is this really an external boundary? | External (file, network, subprocess, decoding external input): declare a boundary with `path`, `language`, qualified `exception`, `reason`; keep one operation inside the `try`; re-raise a typed error with `from exc`. Internal: remove the catch and fix the cause or let it propagate. |
| `EXC002`, `DEF005` | What should the caller see when this fails? | A typed error. Not `None`, not `[]`, not a logged line and a continue, and not a hand-written copy of the library's check. At the entry point, inside a declared boundary, a named non-zero exit status (`return EXIT_USAGE`) is fine. |
| `SUPP001`, `SUPP002` | Is the suppression still justified? | Fix the comment syntax, or delete a suppression that no longer silences anything. |
| `EXC004` | Should the exception really disappear? | No: move the `return` after the `try`; keep `finally` to cleanup. If it must be discarded, catch the type at a declared boundary. |
| `STUB001` | What should this do? | Implement it, delete the unused entry point, or stop and say the behavior is underspecified. Never write a plausible fake. An abstract method is `@abstractmethod` on an ABC or a `Protocol`. |
| `STUB002` | Why does production depend on a test double? | Invert it: production defines the interface, tests inject the double. A real production module under `tests/` moves. |
| `ASSERT001` | Is this input from outside, or an invariant of the code? | Input (the finding names its source): check it where it enters and raise a typed error that names the problem. Never delete an assert to satisfy a finding, and never turn an internal invariant into an `if`. |
| `ASSERT002` | Can the program run under `python -O`? | Make the entry point refuse it once (`if sys.flags.optimize: raise SystemExit(...)`); keep the asserts. |
| `BOOL001` | What does the flag switch? | Pass it by keyword (`escape=True`) or in an options object; a flag that selects behavior may be two functions. |
| `STATE001` | Who owns this state? Does it need to change at all? | A fixed table becomes a `tuple`/`frozenset`/`Object.freeze`d value (`write-compliant-code`, principle 8). Otherwise an object the caller creates and passes in, or a new value returned. A deliberate cache goes in `[[rules.module_state.allowed]]` with its reason. |
| `DOM002` | Should a press on this control count as "outside"? | Usually no: add its selector to the skip list it misses and add a browser test that presses it in each mode. If yes, suppress with that reason. |
| `DEAD001`, `DEAD002` | Should production call this? | Reconnect it and test the production path, or delete it and its tests; a helper only tests use belongs under `tests/`. Code a framework or a string reaches goes in `rules.dead_code.entry_points`. |
| `DUP001`, `DUP002` | Which copy is right? | Keep that one in a shared module and import it everywhere; delete the copies. Copies that differ on purpose get names that say how. |
| `VERIFY005` | What does the code under test call now? | Stub that instead, or drop the stub; one kept for code reached dynamically takes a suppression with that reason. |
| `IMPORT002` | Why may this file not import that module? | Move what it needs to a module both may import, or have the caller pass it in. A wrong boundary is changed in the configuration, where it is reviewed. |
| `DOM003` | Can this content hold anything but text? | Yes: keep the point as a node and offset, or a path of child indexes, and test clicks with `isPointInRange`. Text only: suppress with that reason. |
| `DOM001` | Does the handler mean to ignore clicks on SVG icons? | No: test `instanceof Element` (where `closest` is defined), or call `closest` first and narrow its result. A deliberate filter names the narrower class (`HTMLButtonElement`). |
| `IMPORT001` | Who asked for this effect? | Move it into a function the entry point calls (`main()`, a factory, `start()`). |
| `PROCESS001` | Can the data contain shell syntax? Who checks the exit status? | An argument list without a shell; `check=True`, or read the status and raise a typed error. |
| `RESULT001` | Was the value supposed to change? | Use the result (`name = name.strip()`), call the mutating form (`sort`, `forEach`), or delete the line. |
| `TYPE001` | What is the real type? Does a type checker run? | Name it, validate at the boundary, or narrow with `isinstance`; keep an escape only where a runtime check backs it. If no checker is configured (no mypy or pyright settings, no `tsc` or `checkJs`), `# type: ignore` silences nothing and the annotations are unchecked: recommend adopting one, gated on new errors only against a baseline of today's, as with ShockHarness's own baseline. |
| `SLEEP001` | What condition is the sleep waiting for? | Wait on it (an event, a future, a readiness check with a deadline); a pacing interval comes from configuration. |
| `RETRY001` | When does it give up? | Bound the attempts, retry only transient failures, re-raise the last error. |
| `BATCH001` | Who learns which items failed? | Collect the failures and return them, or raise after the loop. |
| `STUB003` | What should the check decide? | Implement it; a deliberate constant becomes a named setting. |
| `INPUT001` | What does this operation accept, and who checked it? | Parse the input into that type at the boundary (`int(...)`, a model, a schema, an allowlist lookup) and pass the parsed value; build commands as argument lists, queries with parameters. A project validator goes in `rules.input.*_validators`. Never wrap the value in a no-op to silence the finding. |
| `MAGIC003` | What does this -1 mean here? | If it stands for something ("nothing selected", "never ran", "no limit"), name it once (`NO_SELECTION = -1`) or use a value that cannot be mistaken for a real one (`None`, an enum member). If it is plain arithmetic or an index, add the callee to `rules.sentinels.*_index_callees` or leave the finding as reviewed. |
| `PROV001` | Where do the other callers get this identifier? | Get it the same way (start the run, create the record, pass what it returned). A new identifier, if really wanted, is made where the others are issued. |
| `GUARD001` | What do the other callers know that this one does not? | Make the same check, or handle the failure the call raises; if this site cannot reach the failing case, say why. |
| `INPUT002` | Is the variable required? | Require it where configuration loads (`os.environ["X"]`, or check and raise naming the variable); if it is optional, say so with an explicit check of the unset case. |
| `ASYNC001`-`ASYNC003` | Who waits for this work and sees it fail? | `await` or return it; start tasks in a `TaskGroup`; check every settled result for failure. See the `async-lifecycle` skill. |
| `PROP001` | Which declared producer establishes the property, and does this value pass through it? | Find the producer (the catalog's `producers`, or the function that `produces` it) and route the value through it. If the property really is established by something the analyzer cannot see, add `produces(x, "p")` at that point and a test that exercises it. Never satisfy `PROP001` by removing a `requires`, and never add a `produces` you cannot justify; if the contract cannot be determined from the code and the spec, stop and report. See the `property-contracts` skill. |
| `PROP008` | What must this parameter carry, and what does the result carry? | State it: `requires(x, "p")` first in the body, `return produces(...)` or `preserves(...)`; `requires(x)` with no property records that the parameter needs nothing. If you cannot tell, stop and ask rather than guess. |

An **unknown** finding means the rule could not establish the property, not that the code is
fine or that it is wrong. Treat it as a request for the missing information, and supply it:

| Unknown finding | What could not be determined | Supply it by |
|---|---|---|
| `EXC001`, an exception type that does not resolve | which class the handler catches | Import the exception class by name (`from pkg.errors import FetchError`), or catch the class directly instead of a variable, call or subscript; then declare the boundary for that qualified name if the catch is a real boundary |
| `EXC001`, an opaque promise rejection handler | whether the handler checks the error class and rethrows the rest | Write the handler inline, or define it at the top level of the same module, with the `instanceof` guard and rethrow |
| `EXC001`, a `with` whose capture manager cannot be established, or a manager with no readable exception type | which exceptions the block captures | Construct the manager in the `with` itself (`with Manager(TimeoutError):`), pass the exception classes as plain arguments, and list the manager in `rules.exceptions.capture_managers` |
| `DEF002` on a receiver not proven a mapping | whether `.get(k, v)` is a mapping fallback at all | Annotate or construct the receiver as a mapping (`table: dict[str, int] = {}`), after which the finding is a plain violation to fix as above; if the receiver is not a mapping (an HTTP client), restructure the call (keyword arguments) or suppress with a reason naming the receiver's real type |

Never suppress an unknown finding without stating what could not be determined and why it is
acceptable: the reason must name the missing fact (`reason="session is requests.Session;
.get(url, params) is an HTTP call, not a mapping fallback"`). Never set `fail_on_unknown =
false` to get green; it is a policy deviation like any other loosening.

### 3. Add a characterization test first

Before changing the code, write a test that pins the behavior you intend: the missing key
raises, the invalid value raises with a clear message, the timeout surfaces as the typed
error, the explicit page size is honored. Run it; it should fail on the current code when
the current behavior is wrong, or pass when you are only removing an implicit path. Either
way it protects the contract through the change.

### 4. Change the code

Make the smallest change that states the contract. Update every caller that relied on the
default. Prefer a required settings object loaded once over threading new parameters through
many signatures.

### 5. Rerun tests and analyzer

```bash
pytest -q                       # or: node --test
shockharness check .
```

Both must pass. Then, if the repository gates pull requests:

```bash
shockharness gate --base origin/main --head HEAD    # after committing; exit 1 only on new hard violations
```

## Worked examples

### Python: `MAGIC001` + `DEF001` + `DEF006`

Finding lines:

```text
src/app/pages.py:3:36: DEF001 error: parameter 'page_size' of paginate() has a default value: 10  [def paginate(items, page_size=10):]
src/app/pages.py:3:36: MAGIC001 error: Numeric literal 10 has no permitted justification in executable code  [def paginate(items, page_size=10):]
src/app/settings.py:6:19: DEF006 error: environment variable "PAGE_SIZE" falls back to "10"; os.getenv(...) substitutes a fallback when environment variable "PAGE_SIZE" is unset (getenv)  [page_size = int(os.getenv("PAGE_SIZE", "10"))]
```

Contract: the page size is operator policy, so it is a required, validated
setting; the function takes it explicitly. Characterization test:

```python
def test_page_size_is_required() -> None:
    with pytest.raises(KeyError):
        load_settings({})
    with pytest.raises(ValueError, match="PAGE_SIZE"):
        load_settings({"PAGE_SIZE": "0"})
    assert paginate(["a", "b", "c"], load_settings({"PAGE_SIZE": "2"}).page_size) == [["a", "b"], ["c"]]
```

Fix:

```python
def load_settings(raw: Mapping[str, str]) -> Settings:
    page_size = int(raw["PAGE_SIZE"])
    if page_size < 1:
        raise ValueError(f"PAGE_SIZE must be at least 1, got {page_size}")
    return Settings(page_size=page_size)

def paginate(items: list[str], page_size: int) -> list[list[str]]:
    if page_size < 1:
        raise ValueError(f"page_size must be at least 1, got {page_size}")
    return [items[start : start + page_size] for start in range(0, len(items), page_size)]
```

### Python: `EXC001` + `DEF005` at a real boundary

```text
src/app/store.py:9:5: DEF005 error: except handler converts the exception into a fallback value: return {} (EXC002 classification return_fallback; the handler is reported once, here)  [except json.JSONDecodeError:]
src/app/store.py:9:5: EXC001 error: except handler of 'json.JSONDecodeError' is forbidden: catch of 'json.JSONDecodeError' is not approved by any boundary for this file  [except json.JSONDecodeError:]
```

Decoding a file is external input, so a boundary is legitimate. Declare it:

```toml
[[tool.shockharness.rules.exceptions.boundaries]]
path = "src/app/store.py"
language = "python"
exception = "json.JSONDecodeError"
reason = "Store file content is external input; malformed JSON becomes a typed StoreError"
```

Keep one operation inside the `try` (`EXC003`) and raise a typed error with its
cause instead of returning `{}`:

```python
def load_store(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    # Boundary (declared in .shockharness.toml): decoding external input.
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise StoreError(f"{path}: malformed store file: {exc}") from exc
    if not isinstance(data, dict):
        raise StoreError(f"{path}: store must be a JSON object")
    return data
```

Characterization test: a malformed file raises `StoreError` whose message
names the path; a valid file loads.

### JavaScript: `DEF002` + `MAGIC001` + untyped `catch`

```text
src/config.js:2:19: DEF002 error: env.REQUEST_TIMEOUT_MS falls back to 2500; '??' substitutes a fallback when the property or lookup result is null or undefined  [const timeout = env.REQUEST_TIMEOUT_MS ?? 2500;]
src/config.js:2:45: MAGIC001 error: Numeric literal 2500 has no permitted justification in executable code  [const timeout = env.REQUEST_TIMEOUT_MS ?? 2500;]
src/http.js:4:5: DEF005 error: catch clause converts the exception into a fallback value: return null; (EXC002 classification return_fallback; the handler is reported once, here)  [} catch (err) {]
src/http.js:4:5: EXC001 error: catch clause is forbidden: untyped catch binds every error; a JavaScript catch passes only inside an approved boundary whose error class the handler checks with instanceof and otherwise rethrows  [} catch (err) {]
```

(`env.X ?? v` on a parameter is `DEF002`; the same fallback written as
`process.env.X ?? v` is `DEF006`.)

Fix the configuration read so the value is required and validated once:

```javascript
export function loadConfig(env) {
  const raw = env.REQUEST_TIMEOUT_MS;
  const timeout = Number(raw);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError(`REQUEST_TIMEOUT_MS must be a positive number, got ${raw}`);
  }
  return Object.freeze({ requestTimeoutMs: timeout });
}
```

Decide the failure contract for `fetchJson`. If the caller should see the
failure, remove the catch:

```javascript
export async function fetchJson(url) {
  const response = await fetch(url);
  return response.json();
}
```

If a specific failure is a boundary, declare it with an error class and use
the guard convention (`if (!(err instanceof TimeoutError)) throw err;` as the
first statement) and re-throw a typed error; never return `null`.

Characterization test (`node --test`):

```javascript
test("config is required", () => {
  assert.equal(loadConfig({ REQUEST_TIMEOUT_MS: "2500" }).requestTimeoutMs, 2500);
  assert.throws(() => loadConfig({}), TypeError);
});
```

### Python and JavaScript: `DEF002` where absence is a normal state

A tag that no note carries has no posting. Indexing would raise for a
legitimate state; a fallback would hide a typo in the tag. Branch where the
absence matters and do the absent case's own work there:

```python
def matching_notes(index: dict[str, list[str]], tags: list[str]) -> set[str]:
    found: set[str] = set()
    for tag in tags:
        if tag not in index:
            continue  # a tag that no note carries matches nothing
        found.update(index[tag])
    return found
```

```javascript
export function matchingNotes(index, tags) {
  const found = new Set();
  for (const tag of tags) {
    if (!index.has(tag)) continue; // a tag that no note carries matches nothing
    for (const id of index.get(tag)) found.add(id);
  }
  return found;
}
```

A helper that returns a stand-in for the missing value (`if tag in index:
return index[tag]` then `return []`) is the fallback again, whatever it is
called; one that takes the stand-in as a parameter is `.get` under another name.
If a stand-in really is the meaning, keep the lookup and record the decision
once, on its line: `# shockharness: ignore[DEF002] reason="..."`.

Removing an entry that may be absent reads the same way: `cache.pop(key, None)`
as a statement is a `DEF002` review finding of kind `discarded_removal`. If the
key is always present, write `del cache[key]` so a missing key fails; if absence
is normal, write `if key in cache: del cache[key]` and say why.

## Propose a rule

When you find a bug that ShockHarness did not report, write down the rule that would have
caught it, even if you fix the bug right away. A rule over a syntactic pattern is better
than a heuristic. Note:

- the pattern, as a minimal triggering example in the language it occurred in;
- why it is a bug (what the program did instead of failing);
- the proposed rule, and how it decides (which call, which argument, which
  missing check);
- the false positives you expect, and what would keep the rule quiet on them.

Put the note wherever the project collects tooling feedback (an issue, a notes file the
maintainers read). Do not edit the analyzer, its configuration or a baseline to act on it.

## When a suppression is the right fix

Only when the code is right for a reason the rule cannot see, and you can name it. A value
from an outside authority (an HTTP status, a well-known port) needs none: as a module-level
named constant it is not reported (`NOT_FOUND = 404  # RFC 9110 section 15.5.5`).

```python
monkeypatch.setattr(plugins, "load", fake_load)  # shockharness: ignore[VERIFY005] reason="reached through importlib by name"
```

```javascript
const point = pointAt(title, saved.start); // shockharness: ignore[DOM003] reason="the title field holds text only"
```

The suppression sits on the same line as the finding, names exactly one rule ID that exists
(`shockharness rules list`), and carries a quoted reason. The finding remains in every
report, marked suppressed; the count of suppressions is part of the report, and reviewers
read it.

## Checklist

- [ ] The full report was read, including `config:` deviations and the rules not analyzed.
- [ ] Each finding has a stated contract (required value, typed error, optional branch, cited constant).
- [ ] Each unknown finding was answered by supplying the missing information (resolvable import, inline or module-level handler, configured manager, typed receiver), or suppressed with a reason that names what could not be determined.
- [ ] A characterization test exists for each changed contract and runs green.
- [ ] No `try`/`except` was deleted, no `.get` replaced with indexing, no suppression added without the contract decision written in the commit or review.
- [ ] Any new boundary has `path`, `language`, qualified `exception` and a `reason`, and its `try` wraps one operation.
- [ ] Every suppression has an exact rule ID and a reason that names what the rule cannot see.
- [ ] Tests and `shockharness check .` both pass; `gate --base <default branch> --head HEAD` passes after committing.
- [ ] Any bug found along the way that ShockHarness did not report has a written rule proposal (pattern, why it is a bug, the rule, expected false positives).

## Setting ShockHarness up

Installing it, the policy file, the first run on an existing codebase, CI and installing
these skills are the `adopt-shockharness` skill.
