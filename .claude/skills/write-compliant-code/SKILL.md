---
name: write-compliant-code
description: Write new Python or JavaScript that passes the ShockHarness quality gate on the first run. Use when adding or changing executable code in a repository that runs shockharness. Covers clear contracts, no catch outside a declared boundary, no parameter defaults or fallback values, no numeric literal other than 0, 1 or -1, named constants for meaningful 0/1/-1 values, and keeping data, configuration and specification files separate from source.
---

# Write compliant code

ShockHarness (`shockharness check`) is a deterministic static-analysis gate for
Python and JavaScript. Its one idea: unexpected failures, missing information
and unexplained decisions must not silently become apparently valid program
behavior. This skill is for writing code that passes the gate the first time;
use `fix-violations` for existing findings, `pre-commit-review` before commit.

## The contract you are writing to

Three hard policies are on by default in the `strict` profile. Each rule below
is quoted from `shockharness rules explain <ID>`; run that command when you need
the full detection guarantees.

| Rule | What fails | Default |
|---|---|---|
| `MAGIC001` / `MAGIC003` | a numeric literal other than `0`, `1` or `-1` in executable code (`2`, `1.5`, `0x10`, `10n`, a literal in a Python type annotation) / a `-1` standing for a value (`selected = -1`, `return -1`): name what it means | error / review |
| `EXC001` | a catch outside an approved boundary: bare `except:`, `except Exception`, an untyped JavaScript `catch (e)`, or any catch in a file no boundary covers | error |
| `EXC002` | a handler that swallows the exception, only logs it, or replaces it without its cause | error |
| `EXC003` | an approved `try` whose body does more than the one operation the boundary sanctions | error |
| `DEF001` | a function parameter default (`def f(a, b=1)`, `function f(a = 1)`), a dataclass field default or `default_factory` | error |
| `DEF002` | `m.get(k, v)`, `getattr(o, a, v)`, `o?.x ?? v`, `const {x = v} = o`; `m.get(k)` with its implicit `None` is a review finding | error |
| `DEF003` | `x or v`, `x \|\| v` used as a value rather than as Boolean logic | review |
| `DEF004` | `x ?? v`, `x if x is not None else v` | error |
| `DEF005` | a handler that returns a default value instead of failing | error |
| `DEF006` | `os.getenv("X", v)`, `process.env.X \|\| v`, `const { X = v } = process.env` | error |
| `SUPP001` / `SUPP002` | a malformed suppression comment / one that silences nothing | error / warning |
| `EXC004` | `return`, `break` or `continue` that leaves a `finally` block | warning |
| `STUB001` / `STUB002` | a stub (`raise NotImplementedError`, an empty body, `throw new Error("not implemented")`) / an import of a mock or test module in production code | warning |
| `ASSERT001` / `ASSERT002` | a Python `assert` that checks external input (raise a typed error instead) / asserts relied on while nothing refuses `python -O` | warning / review |
| `BOOL001` | `f(x, True, False)`: pass flags by keyword or an options object | review |
| `STATE001` / `IMPORT001` / `DOM001` | module state written from functions / a side effect at import time / `event.target instanceof HTMLElement` before `.closest(...)`, which drops clicks on SVG icons (test `instanceof Element`) | warning |
| `ASYNC001`-`ASYNC003` | a coroutine or Promise dropped, a task started without an owner, a settled batch never checked for failures (see `async-lifecycle`) | warning |
| `PROCESS001` / `RESULT001` / `RETRY001` / `BATCH001` | a shell command built from data or an unchecked exit status / a must-use result thrown away / a retry with no limit / a loop that drops per-item failures | warning |
| `TYPE001` / `SLEEP001` / `STUB003` | `Any`, `cast`, `# type: ignore` / a fixed sleep instead of a condition / a check that always returns `True` | review |
| `INPUT001` / `INPUT002` | request data reaching a shell, query, path or redirect without a validator / an environment variable passed on unchecked | warning / review |
| `PROV001` / `GUARD001` | a made-up identifier where the other callers pass an issued one / a call without the check its other callers make | review |

A clean report says `gate: PASS (exit 0)`. Exit `1` is a policy violation, `2`
an invalid configuration or invocation, `3` a tool failure or, under
`parse_errors = "fail"`, a file that could not be parsed. A report lists any
registered rule that is not implemented yet under `rules not implemented (not
analyzed)`: a clean run never implies such a rule was checked. The
complexity family (`CPLX001`-`CPLX006`) is advisory: warnings that never fail
a plain `check`; see the `refactor-complexity` skill.

## Principles

1. **Make the contract explicit.** Every value a function needs is a required
   parameter or a validated field of a settings object. Every failure is a
   raised, typed error. If a caller may omit something, the type says so
   (`int | None`) and the code branches on it explicitly, naming what it does.
2. **No catch outside a declared boundary.** A boundary is a
   `[[tool.shockharness.rules.exceptions.boundaries]]` entry in
   `.shockharness.toml` with `path`, `language`, the qualified `exception` and a
   `reason`. Boundaries are where the program meets the outside world: reading
   a file, decoding external input, a network call, a subprocess. Inside the
   boundary the `try` wraps exactly one operation and the handler converts the
   failure into a typed error the caller must handle; it never returns a
   success-shaped value, and a failed read or write reaches the caller or the
   user, never nothing. Declare a boundary for a catch you are writing, in that
   file (an unused one is `EXC005`); it names what the outside world raises,
   never the project's own error, which derives from `Exception`, never
   `SystemExit`: only the entry point turns it into an exit.
3. **No defaults, no fallbacks.** Do not write `b=1`, `.get(k, v)`, `x or v`,
   `x ?? v`, `os.getenv("X", "3")`, `process.env.PORT || 3000`. Read required
   data with indexing (`raw["PORT"]`, `env.PORT` followed by validation) so a
   missing value fails loudly, once, at load time.
4. **No numeric literal other than 0, 1 or -1.** A number in code needs a contract:
   variable policy (timeouts, limits, page sizes) becomes a required,
   validated configuration parameter; a fixed value (a spec's exit code, a
   protocol value) becomes a module-level named constant that says what it is
   for and cites its source (`EXIT_USAGE = 2  # SPEC.md`), with no suppression.
   Never name it after its value (`TWO = 2`, MAGIC004) or disguise it (`1 + 1`,
   `len("  ")`, `int("30")`, `indent="  "`, a parsed string: MAGIC005; a data file).
5. **Name a 0, 1 or -1 that carries meaning.** The rule permits them, it does
   not recommend them. An exit code, a sentinel ("nothing selected"), a flag, a
   first page, a protocol value: give it a name (`EXIT_OK = 0`, `NO_SELECTION =
   -1`). Plain arithmetic and indexing stay literal: `i + 1`, `items[-1]`,
   `text[:-1]`, `indexOf(x) === -1`, `range(0, n)`, `start = 0`.
6. **Separate source from data, configuration and specification.** Numbers
   belong in `.toml`, `.json`, `.env.example`, a schema, or named constants.
   Build-tool configuration files (`conftest.py`, `*.config.js`, `.eslintrc.js`,
   listed under `rules.magic_numbers.configuration_files`) are exempt from
   `MAGIC001` and the report says so per file. Test values stay in the test,
   which is exempt from `MAGIC001`; never move them into a data file.
7. **Validate what you return, not only what you receive.** When a function's
   contract promises something about its result (non-empty, sorted, within a
   range, exactly the expected keys), check it before returning and raise on
   violation. The check states the promise in code, and a broken promise fails
   where it is broken instead of in a caller. Never turn the check into a
   fallback (`return result or []`).

   ```python
   def page_of(items: list[str], page: int, size: int) -> list[str]:
       if page < FIRST_PAGE or size < 1:
           raise ValueError(f"page {page} of size {size} is not a valid page")
       result = items[(page - FIRST_PAGE) * size : page * size]
       if len(result) > size:
           raise AssertionError(f"page holds {len(result)} items, more than {size}")
       return result
   ```

   ```javascript
   export function sortedIds(records) {
     const ids = records.map((record) => record.id).sort();
     if (new Set(ids).size !== ids.length) {
       throw new Error("record ids are not unique");
     }
     return ids;
   }
   ```
8. **Prefer immutable values.** A value nobody can change needs no owner, cannot
   be altered behind a caller's back, and makes the order of calls irrelevant.
   Build data once and hand it on: `@dataclass(frozen=True)` for records,
   `tuple` and `frozenset` (or a `Mapping` you never write to) for collections,
   `Object.freeze` and `const` in JavaScript. When a function needs a changed
   value, prefer returning a new one (`dataclasses.replace`, a new tuple,
   `{...obj, x}`) over mutating its input. Mutating local variables, and objects
   the function itself created, is fine: a list built up in a loop, a dict
   filled before it is returned. Mutating what other code can also see (a
   function's inputs, shared values, module-level state that functions write,
   which is `STATE001`) is discouraged rather than forbidden: when it is the
   clearer design, say so in the function's name or docstring.

   ```python
   from dataclasses import dataclass, replace


   @dataclass(frozen=True)
   class Order:
       items: tuple[str, ...]
       paid: bool


   def with_item(order: Order, item: str) -> Order:
       return replace(order, items=(*order.items, item))  # the caller's order is unchanged


   ALLOWED_CURRENCIES = frozenset({"EUR", "USD"})
   ```

   ```javascript
   export const ALLOWED_CURRENCIES = Object.freeze(["EUR", "USD"]);

   export function withItem(order, item) {
     return Object.freeze({ ...order, items: [...order.items, item] });
   }
   ```

   Fine: `totals = {}` filled in a loop and returned. Discouraged: `def
   add_item(order, item): order.items.append(item)`, which changes every holder
   of `order`, and `function markPaid(order) { order.paid = true; }`, which a
   caller cannot see coming from the call site.
9. **Assert internal invariants; raise for expected failures.** Where the code relies on
   something being true (the ordering has a head here, a started run is in the history),
   assert it where it must hold: an assert that fires is a bug found at its source. Input from
   outside (a request field, a file, the configuration, an environment variable, an argument)
   fails for reasons that are not bugs: check it where it enters and raise a typed error
   (`ASSERT001` reports an assert on input). A state the user can reach is no failure: disable
   the control or say so, never throw. Python drops asserts under `-O`, so an entry point
   whose code asserts refuses to run optimized (`ASSERT002`); code with no asserts needs no
   such guard. JavaScript's `console.assert` only logs.

   ```python
   def next_step(plan: Plan) -> Step:
       assert plan.steps, "a scheduled plan always has a step"
       return plan.steps[0]
   ```
10. **Declare property contracts where the repository has them**
   (`rules.property_contracts`; the `property-contracts` skill has the details). Put a
   parameter's `requires(x, "p")` first in the body; write `requires(x)` with no
   property to record that a parameter needs nothing; return `produces(...)` only where
   the property is really established, and `preserves(result, source)` where a result
   keeps its source's properties. Predicate tolerances go in named constants.

## Examples

### Python

Non-compliant (five findings):

```python
import os

def fetch(url, timeout=30):                      # DEF001 (timeout=30), MAGIC001 (30)
    retries = int(os.getenv("RETRIES", "3"))     # DEF006
    try:
        return client.get(url, timeout=timeout)
    except Exception:                            # EXC001 broad catch, no boundary
        return None                              # DEF005 exception-to-default
```

Compliant:

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class HttpSettings:
    timeout_seconds: float
    retries: int

def load_http_settings(raw: Mapping[str, str]) -> HttpSettings:
    """Build settings from a mapping such as os.environ; a missing key raises KeyError."""
    timeout = float(raw["REQUEST_TIMEOUT_SECONDS"])
    retries = int(raw["RETRIES"])
    if timeout <= 0:
        raise ValueError(f"REQUEST_TIMEOUT_SECONDS must be positive, got {timeout}")
    if retries < 0:
        raise ValueError(f"RETRIES must not be negative, got {retries}")
    return HttpSettings(timeout_seconds=timeout, retries=retries)

def fetch(client: Client, url: str, settings: HttpSettings) -> Response:
    return client.get(url, timeout=settings.timeout_seconds)   # a failure propagates, typed, to the caller
```

If `client.get` must be caught (a network boundary), declare it and keep the
`try` to that single call:

```toml
[[tool.shockharness.rules.exceptions.boundaries]]
path = "src/app/http.py"
language = "python"
exception = "requests.exceptions.Timeout"
reason = "Network I/O; a timeout becomes a typed FetchError the caller handles"
```

```python
def fetch(client: Client, url: str, settings: HttpSettings) -> Response:
    # Boundary (declared in .shockharness.toml): one network call.
    try:
        response = client.get(url, timeout=settings.timeout_seconds)
    except requests.exceptions.Timeout as exc:
        raise FetchError(url, settings.timeout_seconds) from exc
    return response
```

A meaningful 0 or 1 gets a name even though the rule allows it: `EXIT_OK = 0`,
`EXIT_VIOLATIONS = 1`, and `return EXIT_OK` rather than `return 0`.

### JavaScript

Non-compliant:

```javascript
export function loadConfig(env = process.env) {            // DEF001
  const port = Number(env.PORT || 3000);                    // DEF006, MAGIC001
  const { retries = 3 } = env;                              // DEF006, MAGIC001
  return { port, retries };
}

export async function fetchJson(url) {
  try {
    const response = await fetch(url);
    return await response.json();                           // EXC003 if a boundary existed: two operations
  } catch (err) {                                           // EXC001 untyped catch
    return null;                                            // DEF005
  }
}
```

Compliant:

```javascript
export function loadConfig(env) {
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new TypeError(`PORT must be a positive integer, got ${env.PORT}`);
  }
  const retries = Number(env.RETRIES);
  if (!Number.isInteger(retries) || retries < 0) {
    throw new TypeError(`RETRIES must be a non-negative integer, got ${env.RETRIES}`);
  }
  return Object.freeze({ port, retries });
}

export async function fetchJson(url) {
  const response = await fetch(url);        // a rejection propagates to the caller
  return response.json();
}
```

A JavaScript `catch` has no type, so the convention for an approved boundary
is a guard that re-throws everything else as the handler's first statement:

```javascript
// Boundary (declared in .shockharness.toml, exception = "TimeoutError"): one call.
try {
  return await fetchWithTimeout(url, config.requestTimeoutMs);
} catch (err) {
  if (!(err instanceof TimeoutError)) throw err;
  throw new FetchError(url, err);
}
```

A protocol constant needs no suppression: as a module-level named constant (`export const
NOT_FOUND = 404; // RFC 9110 section 15.5.5`) it is not reported. A suppression is for code
the rule cannot see is right: same line, exact rule ID, a reason:

```javascript
const point = pointAt(title, saved.start); // shockharness: ignore[DOM003] reason="the title field holds text only"
```

The finding stays in every report with the suppression attached; only the gate ignores it. A
suppression with no rule ID, or a reason-less one, is a `SUPP001` error; one that silences
nothing is a `SUPP002` warning.

## Workflow

1. Before writing, read the repository's `.shockharness.toml`: which profile
   is active, which boundaries exist, which paths are overridden and why. Do
   not add a boundary or an override to make your code pass; propose it with a
   reason and let the review decide.
2. Write the contract first: required parameters, a validated settings
   object, typed errors. Then the code.
3. Run the analyzer on what you touched, then on the whole configured scope:

   ```bash
   shockharness check path/to/changed_file.py
   shockharness check .
   shockharness rules explain DEF002        # when a finding's message is not enough
   ```

4. Run the project's tests. A clean gate is not a working program.
5. For each remaining finding follow `fix-violations`; for the commit follow
   `pre-commit-review`.

## Checklist

- [ ] Every value the code needs is a required parameter or a validated settings field; no `=` default in a signature, no `.get(k, v)`, `or`, `??`, `getenv("X", v)`.
- [ ] No `try`/`catch` outside a boundary declared in `.shockharness.toml`; each approved `try` wraps one operation and re-raises a typed error with its cause.
- [ ] No numeric literal other than `0` or `1`; each number lives in configuration or a cited, named constant.
- [ ] Each `0` or `1` that means something (exit code, sentinel, flag) has a name.
- [ ] Data, configuration and specification live in data files or named constants, not in executable source; test values stay in the tests.
- [ ] `shockharness check .` ends in `gate: PASS (exit 0)` and the tests pass.
- [ ] Any suppression has an exact rule ID and a reason naming what the rule cannot see.
- [ ] Each function whose result carries a promise (non-empty, sorted, bounded, a known key set) checks it before returning and raises on violation.
- [ ] Records are frozen and collections immutable where nothing needs to change them; functions prefer returning new values to mutating their inputs (local variables may be mutated freely), and any input they do mutate is named as such.
- [ ] Internal invariants are asserted where they must hold; input from outside is checked with a typed error, never an assert; the entry point refuses `python -O` only when the code asserts.
- [ ] Where the repository declares property contracts, each new function on a declared pipeline states its `requires` first and its `produces`/`preserves` on return; nothing produces a property it has not established.
- [ ] Where code rejects a value outside a set ("not a known tag") that other code offers the user (suggestions, a menu), both build from one function, and a test checks that every offered value of each kind is accepted: separately built lists drift, and no static check sees across an HTTP request.

## Setting ShockHarness up

Installing it, the policy file, the first run on an existing codebase, CI and installing
these skills are the `adopt-shockharness` skill.
