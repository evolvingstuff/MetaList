---
name: property-contracts
description: Declare and keep property contracts (requires / produces / preserves) in a repository that enables rules.property_contracts. Use when a value must carry a fact the code cannot see in it (normalized, redacted, sanitized HTML, a validated path), when shockharness reports PROP001-PROP008, when writing the catalog, a predicate or a test bootstrap that calls enable, and when the repository runs at enforcement = "complete". Explains how to choose properties, where each declaration goes, the runtime modes, and the sorry count.
---

# Property contracts

Some facts about a value are not visible in the value: this series is normalized, this
note is redacted, this markup is safe to assign to the page. A property contract writes
the fact into the code. Calls of four functions from the project's own copy of the
runtime file, each returning its first argument, declare them; ShockHarness checks every
path to the place that needs the fact. The full guide is `docs/property-contracts.md` in
the ShockHarness repository, and the design is its
`docs/shockharness_property_contracts_spec.md`.

## The declarations

| Call | Where | Means |
|---|---|---|
| `requires(x, "p", ...)` | first in the body, before any other use of the parameter | the caller must pass `x` carrying `p` |
| `requires(x)` | first in the body | considered: `x` needs nothing (counts toward the sorry count) |
| `produces(value, "p", ...)` | at the point `p` is really established, usually `return produces(...)` | `value` now carries `p` |
| `preserves(result, source)` | `return preserves(expr, x)` | `result` carries what `source` carried |
| `preserves_except(result, source, "p", ...)` | the same, less some properties | |

Every operation the analysis cannot credit destroys every property (arithmetic, a
rebuilt dict, a library call). The idiom for "computed from `x`, still everything `x`
was, plus `p`" is `return produces(preserves(expr, x), "p")`.

A generic wrapper (`head(x, n)`, `first(items)`) that returns `preserves(result, x)`
on a parameter that requires nothing passes on whatever each caller's argument carried.
`return x` alone carries nothing; say `preserves`.

## What the findings mean

| Finding | What to do |
|---|---|
| `PROP001` | Route the value through the property's declared producer. If something the analyzer cannot see really establishes it, add `produces(x, "p")` there and a test that exercises that point. **Never remove a `requires` to satisfy it.** An unknown `PROP001` means a call the analysis cannot follow (a method on a value, a registry lookup, a call deeper than `max_depth`): call the function directly, or declare at the point the property is established. |
| `PROP002` | Only the catalog's producers may produce the property: call the producer, or ask for this function to be added to the catalog. |
| `PROP003` | Fix the spelling, or add the property to the catalog with its description, producers and runtime level. |
| `PROP004` | Establish the property on every return, or accept that the result does not carry it. |
| `PROP005` | Paste `shockharness contracts static-properties` into the bootstrap's `enable(...)`, or register the missing predicate. |
| `PROP006` | Write each property as a string literal and pass the arguments positionally. |
| `PROP007` | Move the `requires` to the top of the body. |
| `PROP008` | State the parameter's `requires` and the return's `produces`/`preserves`. If the code and the spec do not tell you what the contract is, stop and ask. |

If you cannot determine the contract from the code and the spec, **stop and report it**
rather than guessing. A property is a design decision, not a fix.

## Choosing properties

- A property is a fact that is **not observable from the value** and that later code
  depends on: `redacted`, `validated_path`, `cloud_disclosable`. "Is a list" is a type,
  not a property.
- Use one property per pipeline step that later code relies on. Name it for what was
  established, in `lower_snake_case`.
- Give it `producers` when only one function may establish it (the sanitizer, the
  privacy evaluator), and a `reason` on every sink.
- Strings and numbers cannot carry runtime state: their properties are
  `runtime = "static"`. Objects can be `"check"`; a property with a cheap, pure
  predicate can be `"verify"`.

## Examples

Python, non-compliant: the result of an inline computation is passed on as if
normalized, and `fit`'s requirement was deleted to make the finding go away.

```python
def fit(series):
    return train(series)            # was: requires(series, "normalized")

def pipeline(raw):
    return fit((raw - raw.mean()) / raw.std())
```

Python, compliant:

```python
from app.contracts import preserves, produces, requires

def normalize(x):
    requires(x, "numeric")
    return produces(preserves((x - x.mean()) / x.std(), x), "normalized")

def fit(series):
    requires(series, "normalized", "numeric")
    return train(series)

def pipeline(raw):
    requires(raw, "numeric")
    return fit(normalize(raw))
```

JavaScript, non-compliant then compliant (an `innerHTML` sink requiring
`sanitized_html`):

```javascript
el.innerHTML = `<b>${tag}</b>`;                       // PROP001: tag is not escaped

import { escapeHtml } from "./html.js";
el.innerHTML = `<b>${escapeHtml(tag)}</b>`;           // composed from escaped parts
```

TypeScript is read as JavaScript; annotations are ignored:

```typescript
export function redact(note: Note): Note {
  requires(note, "decrypted");
  return produces(stripPrivate(note), "redacted");
}
```

## The runtime and `enable`

The runtime file is identity-only until test code calls `enable` once, before any
declaration has run. Production never calls it, and no environment variable turns it on.

- **Python tests:** `conftest.py` calls `enable("check", [...])` before importing the
  application. The list is the catalog's static properties; paste
  `shockharness contracts static-properties`.
- **A server under a browser suite:** a test-only entry script calls `enable` and then
  starts the server exactly as the production entry does.
- **A browser:** a test-entry page whose first module script calls `enable`, or an
  init script (Playwright `addInitScript`) that sets
  `globalThis.__shockharnessContracts = { mode: "check", static: [...] }`. In Node, call
  `enable` and then `await import(...)` the application.
- `enable("verify", [...])` also runs predicates. Register each one once, at startup, in
  the catalog's `registration_module`: `register("normalized", predicate, "mean 0, sd
  1")`. A predicate is pure, does not change the value, and keeps its tolerances in named
  constants.

## Commands

```bash
shockharness contracts install --language python --dest app/contracts.py
shockharness contracts install --language javascript --dest static/js/vendor/shockharness-contracts.js
shockharness contracts install --check          # CI: an edited or stale copy fails
shockharness contracts static-properties        # the list enable(...) takes
shockharness check .
shockharness exceptions .                       # includes the sorry count under complete
shockharness rules explain PROP001
```

## `complete` and the sorry count

With `enforcement = "complete"` (or a path in `complete_paths`), every parameter of every
module-level function and method needs a `requires`, and every return a `produces` or
`preserves` (PROP008). `requires(x)` with no property is the honest answer for a
parameter that needs nothing. `shockharness exceptions .` lists each one: the project's
sorry count, read by reviewers like suppressions. Do not add `requires(x)` to silence
PROP008 when the parameter does need something; that hides the contract the level exists
to expose.

## Checklist

- [ ] Each property is a fact the value cannot show, named for what was established, in the catalog with its `runtime` level.
- [ ] Each `requires` is first in its function; each `produces` is where the property is really established, with a test that exercises that point.
- [ ] No `requires` was removed, and no `produces` added without justification, to satisfy a finding.
- [ ] Pass-through helpers say `preserves(result, x)`; nothing relies on `return x` carrying a property.
- [ ] The test bootstrap calls `enable` once with the list `shockharness contracts static-properties` prints; production never calls it.
- [ ] Predicates are pure, registered once in the registration module, with named tolerances.
- [ ] `shockharness check .` passes, and under `complete` every `requires(x)` in `shockharness exceptions .` is a real decision.

## Setting ShockHarness up

Installing it, the policy file, the first run on an existing codebase, CI and installing
these skills are the `adopt-shockharness` skill.
