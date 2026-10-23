---
name: async-lifecycle
description: Keep asynchronous work observable in a repository that runs shockharness. Use when writing or changing async Python (asyncio, anyio, trio) or JavaScript (Promises, async functions), when a call to an async function is not awaited, when starting background tasks, when using asyncio.gather(return_exceptions=True) or Promise.allSettled, when scrolling or animating to a position after awaiting something that changes the page, and when shockharness reports ASYNC001, ASYNC002 or ASYNC003. Explains each finding and the owned, awaited or returned alternatives.
---

# Async lifecycle

An async call that nobody awaits is a promise that nobody keeps. The caller returns
success, the work runs later or never, and its failure surfaces, if at all, as a warning
in a log that no request is attached to. This is a swallowed exception without a
`catch`, and ShockHarness reports it the same way.

The rule for an agent: **every coroutine, task and Promise has an owner that waits for it
and sees its failure.** The owner is the function that awaits it, a caller it is returned
to, or a supervisor that outlives it (a `TaskGroup`, `Promise.all` whose result is
awaited).

## What the findings mean

| Finding | What the code does | Do this instead |
|---|---|---|
| `ASYNC001` | calls an async function (or `fetch`, `asyncio.sleep`, ...) as a statement, or with `void`, and drops the coroutine or Promise | `await` it, `return` it, or hand it to an owner; a top-level JavaScript entry point ends in `.catch(...)` that reports and sets the exit code |
| `ASYNC002` | `asyncio.create_task(...)` / `ensure_future(...)` as a statement: the task's handle is dropped | start it in a `TaskGroup`, or keep the handle and await or cancel it |
| `ASYNC003` | `gather(..., return_exceptions=True)` / `Promise.allSettled` whose results are thrown away or never checked for failure | check every result and raise or report the failures; use plain `gather` / `Promise.all` when the first failure should fail the batch |

`ASYNC001` finds project functions declared `async` across files through the call graph;
a call matched only by name is reported as `unknown`. Without type information an
arbitrary library call is never assumed to return a Promise: only the catalog in
`rules.async_lifecycle` counts. The rules ship at `warning`; a repository that wants them
to gate sets `rules.async_lifecycle.severity = "error"`.

## Commands

```bash
shockharness check .                       # ASYNC findings with the rest
shockharness rules explain ASYNC001
shockharness gate --base origin/main --head HEAD
```

## Examples

Python:

```python
# ASYNC001: save() is async; this line creates a coroutine and drops it. Nothing is saved.
async def handle(record):
    save(record)
    return OK

# Owned: awaited.
async def handle(record):
    await save(record)
    return OK

# ASYNC002: the task can be garbage-collected mid-flight; its exception is never retrieved.
async def handle(user):
    asyncio.create_task(notify(user))
    return OK

# Owned: the group waits for the task and raises its failure.
async def handle(user):
    async with asyncio.TaskGroup() as group:
        group.create_task(notify(user))
    return OK

# ASYNC003: every failure in the batch becomes a value and is thrown away.
async def sync_all(jobs):
    await asyncio.gather(*jobs, return_exceptions=True)

# Inspected: failures are raised together.
async def sync_all(jobs):
    results = await asyncio.gather(*jobs, return_exceptions=True)
    failures = [r for r in results if isinstance(r, Exception)]
    if failures:
        raise ExceptionGroup("sync failed", failures)
```

JavaScript:

```javascript
// ASYNC001: writeRecord is async; the Promise and its rejection are dropped.
export function saveRecord(record) {
  writeRecord(record);
  return true;
}

// Owned: the caller sees the failure.
export async function saveRecord(record) {
  await writeRecord(record);
  return true;
}

// ASYNC001 with void: void does not handle the rejection, it hides it.
void writeRecord(record);

// An entry point that cannot be awaited reports its failure.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// ASYNC003: results thrown away.
Promise.allSettled(jobs);

// Inspected: rejected entries are reported.
export async function runAll(jobs) {
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length > 0) {
    throw new AggregateError(failed.map((result) => result.reason), "jobs failed");
  }
}
```

## When fire-and-forget is intended

Sometimes work should outlive the request: a metrics flush, a cache warm-up. That is a
design decision, so make the owner explicit: a long-lived supervisor object that keeps
the tasks, logs their exceptions, and is shut down cleanly; or a job queue. Register a
custom supervisor in `rules.async_lifecycle.supervisors` (a policy deviation, so review
sees it). Do not silence the finding with `void` or by assigning the task to `_`.

## Positions measured across an await

After awaiting something that changes the page (a list refresh, a load of more items, a
re-render), a position measured once is already a guess, and it goes on aging while an
animation runs: background work can load or remove items above the target mid-scroll, and
the animation ends at the old number. No rule reports this. Do not animate to a position
measured once. Place at once, or scroll to the element and re-measure it each frame.

```javascript
// Stale: measured once, then animated over many frames while the list may still change.
await refreshList();
const y = window.scrollY + row.getBoundingClientRect().top;
animateScrollTo(y);

// At once: nothing can move the list between the measurement and the scroll.
await refreshList();
window.scrollTo(0, window.scrollY + row.getBoundingClientRect().top);

// Animated: each frame measures the element again, so the target follows it.
await refreshList();
animateScrollTo(() => window.scrollY + row.getBoundingClientRect().top);
```

## Checklist

- [ ] Every call to an async function is awaited, returned, or handed to an owner.
- [ ] Every task is started in a `TaskGroup` (or nursery), or its handle is kept and awaited or cancelled.
- [ ] Every `gather(return_exceptions=True)` / `Promise.allSettled` result is checked for failures, or the batch is returned to a caller that checks it.
- [ ] No `void` on a Promise; top-level entry points end in a `.catch` that reports and sets the exit code.
- [ ] Tests await what they call: an unawaited coroutine in a test makes it pass without checking anything.
- [ ] After an await that changes the page, a scroll is placed at once or re-measures its element each frame, never animated to a position measured once.

## Setting ShockHarness up

Installing it, the policy file, the first run on an existing codebase, CI and installing
these skills are the `adopt-shockharness` skill.
