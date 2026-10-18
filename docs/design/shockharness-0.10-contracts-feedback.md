# ShockHarness 0.10.0: property contracts on MetaList, first findings

From adopting `cloud_disclosable` on MetaList's cloud privacy boundary (2026-10-18,
`feature/property-contracts`; the catalog is in `.shockharness.toml`, the boundary map in
`docs/security/cloud-privacy-boundary.md`). Two bugs, one limitation that changes how
sinks must be written, and the first P4 measurement.

## Bug 1: the JavaScript contract flow crashes on names its entry state does not list (fixed in 0.11.0)

Fixed in 0.11.0: an object literal's methods are their own units. MetaList upgraded and
removed its override; the reproduction below passes.

`shockharness check .` exits 3 with `KeyError` in `contracts/javascript_flow.py`
(`identifier`, line 419: `return env[node_text(node)]`) as soon as the family is enabled,
before any JavaScript declares anything. Reproduction, a project with only this file and
the family enabled (one property, no sinks):

```javascript
// app/tracker.js
export const Tracker = {
    start() {
        document.addEventListener('keydown', () => {});
    },
};
```

`KeyError: 'document'`; with `document.` removed it is `KeyError: 'addEventListener'`. Any
free name read inside a method of an exported object literal seems to fail. A second case
in MetaList is a callback parameter: `new ReadableStream({start(controller) {
controller.enqueue(...) }})` in `scripts/browser-agent-help-regressions.mjs` gives
`KeyError: 'controller'`.

Expected: a global, or a name the unit does not bind, is an unknown value (or carries
nothing); it never crashes the run. (MetaList's interim override, removed with 0.11.0,
disabled PROP001 and PROP004 for its JavaScript.)

## Bug 2 (or a gap): a catalog sink naming a project function cannot match keyword arguments

```toml
[[tool.shockharness.rules.property_contracts.sinks]]
language = "python"
callee = "app.services.agent.ai_send.send_structured:4"
requires = ["cloud_disclosable"]
```

Every call `send_structured(inference, ..., messages=messages, ...)` is PROP001 *unknown*:
"a keyword argument to a library callee cannot be matched to a position". The callee is a
project function (`config validate` resolves it), so its parameters are known and P1a
says keyword arguments are mapped for project callees. The same function with
`requires(messages, "cloud_disclosable")` in its body is matched by keyword and checked.
MetaList uses the `requires` form, and loses VERIFY003's protection of the sink (a test
checks the `requires` lines instead).

## Limitation: receivers decide coverage, and MetaList's AI calls all go through one

All five calls that send to the AI were adapter methods on an injected object
(`inference.infer_structured(...)`, `self._inference.stream_text(...)`): none resolves,
so a catalog sink on those methods would check nothing, silently. MetaList now sends only
through module functions (`app/services/agent/ai_send.py`), and a unit test fails when any
other module calls an adapter's send methods, which makes the check complete.

## First P4 measurement (declared, Python)

| Path | Result |
| --- | --- |
| Export and print title suggestion | verified end to end: route, request builder (producer), message builder (`preserves`), send |
| Suggest Tags with AI (note, or note and children) | verified end to end, after two nested closures over the request became module functions (a closure's free `request` was "not a local value of this unit", unknown) |
| Bulk tagging, chat agent turns, chat summaries, chat final answer | not followed (still with 0.11.0's exact-receiver resolution: the builder is an injected attribute): the messages are built by an injected builder object (`self._context_builder.build_agent_messages(...)`) from a snapshot stored on objects (`TaggingRun.snapshot`), so each send has `{}` |

Declarations so far: 2 `produces` (the snapshot freeze is a catalog producer but not
declared yet), 13 `requires`, 4 `preserves`; unknown findings 0, violations 4 (the four
object-held paths). A removed producer is reported at its first
consumer (checked in a copy).

The object-held paths are where MetaList's privacy bugs actually were (gap 2, bulk tagging
reading live notes, was inside `tagging_trees(snapshot)`). Receivers typed by their
constructor arguments or annotations (`self._context_builder: AgentContextBuilder`), and
attributes assigned once in `__init__` from a parameter that `requires` a property, would
cover them without restructuring.
