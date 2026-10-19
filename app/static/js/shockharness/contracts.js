// ShockHarness property contracts: the JavaScript runtime (one ES module, no dependencies).
//
// Copy it into a project with `shockharness contracts install --language javascript
// --dest <path>` (contracts.d.ts is written beside it) and list the path under
// rules.property_contracts.runtime_module. The project then owns the file;
// `shockharness contracts install --check` reports an edited or stale copy.
//
// Declarations, each returning its first argument unchanged:
//
//   requires(value, property, ...)
//   produces(value, property, ...)
//   preserves(result, source)
//   preserves_except(result, source, property, ...)
//
// The static analysis reads them from the source. At run time the module is
// identity-only until test code calls enable("check", staticProperties) once, before
// any declaration has run. In a browser, where the page's modules evaluate before a
// harness could call it, the harness may instead set
// globalThis.__shockharnessContracts = { mode: "check", static: [...] } before any page
// script runs (an init script). The module reads that object once, at load, treats it
// exactly as a call to enable, and deletes it. Production never does either.
//
// In check mode, produces records the properties on the value, preserves copies the
// source's recorded properties to the result, and requires throws ContractError when a
// property is not recorded on the value. A property listed in staticProperties (the
// catalog's runtime = "static": strings, numbers, anything that cannot carry a runtime
// property) is never recorded or checked; each skip is counted and report() returns the
// counts. A property not listed there that reaches a primitive (a string, number,
// boolean, bigint, symbol, null or undefined) throws, because that is a catalog mistake
// rather than a program state (in check mode). Objects are tracked in a WeakMap, so a
// collected value is forgotten.
//
// Verify mode (enable("verify", staticProperties)) does what check mode does and also runs
// each property's predicate, registered once at startup with register(name, predicate,
// description): produces runs it before recording, requires after the presence check. A
// primitive is checked by its predicate alone. A non-static property with no registered
// predicate throws in verify mode.

const MODE_OFF = "off";
const MODE_CHECK = "check";
const MODE_VERIFY = "verify";
const PRELOAD = "__shockharnessContracts";

export class ContractError extends Error {
  constructor(message, property) {
    super(message);
    this.name = "ContractError";
    this.property = property;
    this.function = null; // not determined: a stack walk on every check is not cheap
  }
}

function isPrimitive(value) {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

function typeName(value) {
  if (value === null) {
    return "null";
  }
  return typeof value;
}

class Registry {
  constructor() {
    this.mode = MODE_OFF;
    this.declarations = 0;
    this.statics = new Set();
    this.skips = new Map();
    this.records = new WeakMap();
    this.predicates = new Map();
  }

  recorded(value) {
    let found = new Set();
    if (!isPrimitive(value) && this.records.has(value)) {
      found = this.records.get(value);
    }
    return found;
  }

  record(value, properties) {
    if (isPrimitive(value) || properties.length === 0) {
      return; // verify mode: a primitive is checked by its predicates, never recorded
    }
    this.records.set(value, new Set(properties));
  }

  tracked(properties, value) {
    const checked = [];
    for (const name of properties) {
      if (this.statics.has(name)) {
        if (!this.skips.has(name)) {
          this.skips.set(name, 0);
        }
        this.skips.set(name, this.skips.get(name) + 1);
        continue;
      }
      if (isPrimitive(value) && this.mode === MODE_CHECK) {
        throw new ContractError(
          `'${name}' is a check-level property but ${typeName(value)} values cannot carry ` +
            'runtime properties; mark it runtime = "static" or "verify"',
          name,
        );
      }
      checked.push(name);
    }
    return checked;
  }

  verified(properties, value) {
    if (this.mode !== MODE_VERIFY) {
      return;
    }
    for (const name of [...properties].sort()) {
      if (!this.predicates.has(name)) {
        throw new ContractError(`no predicate registered for '${name}'`, name);
      }
      const entry = this.predicates.get(name);
      if (!entry.predicate(value)) {
        throw new ContractError(
          `'${name}' does not hold for this value: ${entry.description}`,
          name,
        );
      }
    }
  }
}

const REGISTRY = new Registry();

function isListOfStrings(value) {
  return Array.isArray(value) && value.every((name) => typeof name === "string");
}

export function enable(mode, staticProperties) {
  if (!isListOfStrings(staticProperties)) {
    throw new ContractError(
      "enable takes the catalog's static properties as an array of strings",
      null,
    );
  }
  if (mode !== MODE_CHECK && mode !== MODE_VERIFY) {
    throw new ContractError(
      `enable takes '${MODE_CHECK}' or '${MODE_VERIFY}', not '${String(mode)}'`,
      null,
    );
  }
  if (REGISTRY.mode !== MODE_OFF) {
    throw new ContractError("enable was already called; it is called once per page", null);
  }
  if (REGISTRY.declarations > 0) {
    throw new ContractError(
      `enable was called after ${REGISTRY.declarations} declaration(s) had run; call it ` +
        "before the application's modules are imported",
      null,
    );
  }
  REGISTRY.statics = new Set(staticProperties);
  REGISTRY.mode = mode;
}

// The predicate verify mode runs for a property; registered once, at startup. The
// predicate must be pure and must not change the value.
export function register(name, predicate, description) {
  if (typeof name !== "string" || typeof description !== "string") {
    throw new ContractError("register takes a name, a predicate and a description", null);
  }
  if (typeof predicate !== "function") {
    throw new ContractError("register takes a name, a predicate and a description", null);
  }
  if (REGISTRY.predicates.has(name)) {
    throw new ContractError(`a predicate for '${name}' is already registered`, name);
  }
  REGISTRY.predicates.set(name, { predicate, description });
}

export function report() {
  const skips = {};
  for (const name of [...REGISTRY.skips.keys()].sort()) {
    skips[name] = REGISTRY.skips.get(name);
  }
  return { mode: REGISTRY.mode, declarations: REGISTRY.declarations, static_skips: skips };
}

function checking() {
  REGISTRY.declarations += 1;
  return REGISTRY.mode !== MODE_OFF;
}

export function requires(value, ...properties) {
  if (!checking()) {
    return value;
  }
  const recorded = REGISTRY.recorded(value);
  const required = REGISTRY.tracked(properties, value);
  const missing = isPrimitive(value) ? [] : required.filter((name) => !recorded.has(name));
  if (missing.length > 0) {
    const names = missing.sort().map((name) => `'${name}'`).join(", ");
    throw new ContractError(`the value does not carry ${names}`, missing[0]);
  }
  REGISTRY.verified(required, value);
  return value;
}

export function produces(value, ...properties) {
  if (!checking()) {
    return value;
  }
  const added = REGISTRY.tracked(properties, value);
  REGISTRY.verified(added, value);
  REGISTRY.record(value, [...REGISTRY.recorded(value), ...added]);
  return value;
}

function carry(result, properties) {
  if (properties.length === 0) {
    return;
  }
  const carried = REGISTRY.tracked(properties, result);
  REGISTRY.record(result, [...REGISTRY.recorded(result), ...carried]);
}

export function preserves(result, source) {
  if (!checking()) {
    return result;
  }
  carry(result, [...REGISTRY.recorded(source)]);
  return result;
}

export function preserves_except(result, source, ...properties) {
  if (!checking()) {
    return result;
  }
  const removed = new Set(properties);
  carry(result, [...REGISTRY.recorded(source)].filter((name) => !removed.has(name)));
  return result;
}

// The browser pre-load: a pending enable set by the harness before the page loaded.
if (PRELOAD in globalThis) {
  const pending = globalThis[PRELOAD];
  delete globalThis[PRELOAD];
  if (isPrimitive(pending)) {
    throw new ContractError(`globalThis.${PRELOAD} must be { mode, static }`, null);
  }
  enable(pending.mode, pending.static);
}
