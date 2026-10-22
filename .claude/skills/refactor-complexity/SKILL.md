---
name: refactor-complexity
description: Reduce real complexity in Python or JavaScript code that ShockHarness gates, without gaming metrics. Use when asked to simplify, untangle or refactor a function or module, when review calls code hard to follow, or when preparing for ShockHarness complexity rules. Covers finding repeated cognitive work and coupling, recording call structure and behavior tests before and after, and keeping the refactor compliant with MAGIC001, EXC001-EXC003 and DEF001-DEF006.
---

# Refactor complexity

ShockHarness treats complexity as a separate, advisory family, never averaged
into the hard gate. The rules `CPLX001` (cyclomatic), `CPLX002` (cognitive),
`CPLX003` (nesting depth), `CPLX004` (NPath), `CPLX005` (coupling and
cycles) and `CPLX006` (unit size) are **warnings**: a plain `shockharness check` never fails because of
them. The only place a number can reach a verdict is a revision gate with
`gates.complexity_regressions = "fail"`, and then only for a unit that is
above a threshold *and* grew since the base revision. This skill tells you
how to use the numbers without chasing them.

Every number comes with a versioned convention (`cyclomatic/1`,
`cognitive/1`, `nesting/1`, `npath/1`, `size/1`), named in each finding and
in `metrics.complexity.conventions` of the JSON report. The cognitive score
follows the published description of cognitive complexity but is **not a
SonarSource score**: every function, method, lambda, arrow, class body and
module body is a *unit* measured on its own, and a unit's numbers exclude the
units nested in it. Extracting code therefore moves a score; it never makes
the work vanish, and the call graph records where it went.

| Rule | Fires when | Default threshold |
|---|---|---|
| `CPLX001` | cyclomatic complexity of a unit above `complexity.cyclomatic_warn` | 15 |
| `CPLX002` | cognitive complexity of a unit above `complexity.cognitive_warn` | 15 |
| `CPLX003` | decision nesting depth above `complexity.max_nesting_warn` | 4 |
| `CPLX004` | NPath estimate at or above `complexity.npath_warn`, or saturated at `complexity.npath_cap` | 200 / 10000 |
| `CPLX005` | a module import cycle (resolved edges only; one finding per cycle), or fan-out above `complexity.fan_out_warn` | 20 |
| `CPLX006` | logical lines of a unit (`size/1`) above `complexity.max_lines_warn`; module bodies exempt | 50 |

## What complexity means here

Not a count. Complexity is **repeated cognitive work**: a reader has to hold
the same condition, the same unit conversion, or the same error-handling shape
in mind in several places, and **coupling**: a change in one place forces a
change somewhere a reader could not predict. Both are what the planned rules
approximate; both can be addressed directly today.

Signs worth acting on:

- The same `if` guard or the same chain of `and`/`&&` tests appears in more
  than one function.
- A function reads configuration, validates it, performs I/O and formats the
  result, so no test can exercise one of those without the others.
- A nested branch exists only to handle an absent value that should have been
  required at load time (`DEF001`-`DEF006` territory).
- A `try` wraps several operations so that one handler has to guess which of
  them failed (`EXC003` territory).
- Two modules import each other, or a module reaches into another's internals
  to get a number it should have been given.

Signs that are not complexity: a long but linear function with one job; a
`match`/`switch` over a closed enumeration; a table of constants.

## What metric gaming looks like

Do not:

- Split a function into `step1`, `step2`, `step3` helpers that share mutable
  state through arguments or module globals. The reader now holds the same
  state across three places.
- Replace nested `if` with early `return None` or `continue` that hides an
  invalid state instead of raising.
- Move a branch into a lambda or a dict dispatch merely to lower a nesting
  count.
- Collapse conditions into one `and`/`or` expression that nobody can read, or
  turn an explicit `if x is None: raise` into `x or default` (that is a
  `DEF003` finding and a behavior change).
- Catch an exception to flatten control flow (`EXC001`), or introduce a default
  parameter so a helper has fewer call sites to update (`DEF001`).

Every one of these makes the code easier for a counter and harder for a
reader. A before/after number that improved while behavior tests shrank is a
red flag, not a success; and because the graph records each new call, a split
that lowers `CPLX002` shows up as fan-out and as resolved edges instead.

## Workflow

### 1. Record the current structure

Take the numbers and the call graph from the report before touching anything:

```bash
shockharness check . --format json --output before.json
```

In `before.json`, `metrics.complexity.functions` lists every unit with its
`key` (`path::name`), `cyclomatic`, `cognitive`, `nesting`, `npath` (with
`saturated` and `text`, e.g. `">= 10000"`) and `size`;
`metrics.complexity.files` sums them per file. `metrics.graph.units` gives
each unit's `fan_in`, `fan_out`, `fan_out_external` and its call sites per
confidence (`resolved`, `probable`, `unresolved`); `metrics.graph.edges`
lists the edges themselves; `metrics.graph.cycles` the module cycles and
`metrics.graph.shared_mutable_state` the module-level bindings written from
more than one unit. An `unresolved` call (a computed callee, a method on a
value of unknown type, a callback) is a gap the tool admits, never a guess.
Copy the rows for the units you will touch, plus the external effects (I/O,
environment, time, random) each has, into the pull-request description:

```text
src/report.py::load_report  cyclomatic 9  cognitive 14  nesting 3  fan_out 3 (read_text, parse, summarize)
src/report.py::summarize    cyclomatic 4  cognitive 5   nesting 2  fan_out 1 (format_row)   # pure
src/report.py::main         cyclomatic 2  cognitive 1   nesting 1  fan_out 2 (load_report, print)   # process boundary
```

`metrics.history.hotspots` (when the root is a git repository) ranks files by
`log1p(churn) * normalized cognitive complexity`; a hot file is where a
refactor pays, not a verdict on it.

### 2. Pin behavior with tests before changing code

Write or extend tests that exercise the observable behavior of every function
you will touch, including the failure paths: a missing key raises, a malformed
input raises a typed error, the explicit page size is honored. Run them green
on the current code. These are the before tests; they must still pass,
unchanged, after the refactor. If a test has to change, the refactor changed
behavior; say so explicitly and get it reviewed as such.

### 3. Refactor toward one decision per place

- **Hoist validation to a load step.** Read configuration once into a settings
  object with required, validated fields. Downstream functions take the object
  and never re-check it. This deletes most defensive nesting without hiding
  anything.
- **Extract the repeated condition into a named predicate** when the same
  test appears twice, and give it a test of its own.
- **Separate effects from computation.** A pure function that takes data and
  returns data is testable in isolation; the I/O wrapper around it stays thin
  and is where a declared exception boundary lives (one operation per `try`).
- **Break import cycles by moving the shared thing** (a type, a constant) into
  a module both sides depend on, rather than by lazy imports inside functions.
- **Keep the gate's rules.** No new numeric literal other than `0` or `1`, no
  default parameter on the extracted helper, no catch outside a declared
  boundary, no `or`/`??` fallback introduced to simplify a branch.

### 4. Run the gate and the tests, then compare

```bash
pytest -q                                           # or: node --test
shockharness check .                                # must still end in gate: PASS (exit 0)
shockharness check . --format json --output after.json
shockharness gate --base origin/main --head HEAD    # after committing: no new hard violations;
                                                    # lists `complexity regressions against base: N`
```

Compare `after.json` with `before.json` unit by unit (same `key`). Expect the
touched unit's `cognitive` and `nesting` to fall and the sum over the file to
stay close to the original minus what the new helpers now carry; expect one
new `resolved` edge per helper and the caller's `fan_out` to grow by the same
number. A file sum that fell far more than the helpers' own scores means
nesting penalties were removed, which is fine only if the helpers are real
units with one job and a test. The gate output names per-unit regressions
under `complexity regressions against base` (reported as warnings under the
default `gates.complexity_regressions = "warn"`); a regression is a unit above
a threshold whose number grew, so a refactor that moves work into a new
helper that is itself above a threshold is reported, as it should be.

## Examples

### Python: repeated guard and mixed effects

Before:

```python
def report(path: Path, raw_env: Mapping[str, str]) -> str:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() != "" and not line.startswith("#"):
            fields = line.split(",")
            if len(fields) == int(raw_env["COLUMNS"]):
                rows.append(fields)
    out = []
    for fields in rows:
        if len(fields) == int(raw_env["COLUMNS"]):
            out.append(" | ".join(fields))
    return "\n".join(out)
```

After (same tests, same behavior, one decision per place):

```python
@dataclass(frozen=True)
class ReportSettings:
    columns: int

def load_report_settings(raw_env: Mapping[str, str]) -> ReportSettings:
    columns = int(raw_env["COLUMNS"])
    if columns < 1:
        raise ValueError(f"COLUMNS must be at least 1, got {columns}")
    return ReportSettings(columns=columns)

def is_data_line(line: str) -> bool:
    return line.strip() != "" and not line.startswith("#")

def parse_rows(text: str, settings: ReportSettings) -> list[list[str]]:
    rows = [line.split(",") for line in text.splitlines() if is_data_line(line)]
    return [fields for fields in rows if len(fields) == settings.columns]

def render(rows: list[list[str]]) -> str:
    return "\n".join(" | ".join(fields) for fields in rows)

def report(path: Path, settings: ReportSettings) -> str:
    return render(parse_rows(path.read_text(encoding="utf-8"), settings))
```

The environment is read once, the predicate has a name and a test, the pure
functions are testable without a file, and no default, fallback, catch or
numeric literal was introduced.

### JavaScript: nested absence handling

Before:

```javascript
export function price(order, config) {
  let total = 0;
  for (const item of order.items) {
    if (item.quantity !== undefined) {
      if (item.unitPrice !== undefined) {
        total += item.quantity * item.unitPrice;
      } else {
        total += item.quantity * (config.defaultUnitPrice ?? 0);   // DEF002 and a hidden policy
      }
    }
  }
  return total;
}
```

After: absent fields are rejected where the order is built, so pricing has
one path:

```javascript
export function validateItem(item) {
  if (!Number.isInteger(item.quantity) || item.quantity < 0) {
    throw new TypeError(`quantity must be a non-negative integer, got ${item.quantity}`);
  }
  if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
    throw new TypeError(`unitPrice must be a non-negative number, got ${item.unitPrice}`);
  }
  return Object.freeze({ quantity: item.quantity, unitPrice: item.unitPrice });
}

export function price(items) {
  return items.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
}
```

The before tests for valid orders still pass; a new test pins that an item
without a price is rejected instead of silently priced at zero.

## Checklist

- [ ] Before structure (callers, callees, effects) written down; after structure compared against it.
- [ ] Behavior tests, including failure paths, green before and unchanged after; any changed test called out as a behavior change.
- [ ] Each extracted helper has one job, no default parameters, no shared mutable state.
- [ ] Validation hoisted to one load step; no absence handling left in computation.
- [ ] No new catch outside a declared boundary; no `or`/`??`/`.get(k, v)` introduced; no numeric literal other than `0`/`1`.
- [ ] `shockharness check .` passes; the before/after `metrics.complexity` rows and `metrics.graph` edges are in the pull-request description, and every new edge is a dependency a reader would expect.

## Setting ShockHarness up

Installing it, the policy file, the first run on an existing codebase, CI and installing
these skills are the `adopt-shockharness` skill.
