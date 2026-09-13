// The single owner of client application records. Scope snapshots are immutable;
// controller property accessors and collection operations route through strict
// setters. Backing records never escape. DOM/promise resources remain opaque.
export function immutableSnapshot(value) {
    if (value instanceof Map || value instanceof Set) {
        const copy = value instanceof Map
            ? new Map(Array.from(value, ([key, entry]) => [key, immutableSnapshot(entry)]))
            : new Set(Array.from(value, immutableSnapshot));
        Object.freeze(copy);
        const proxy = new Proxy(copy, {
            get(target, key) {
                if (['set', 'add', 'delete', 'clear'].includes(key)) return () => { throw new Error('Snapshot collections are immutable'); };
                if (key === 'forEach') return callback => target.forEach((entry, entryKey) => callback(entry, entryKey, proxy));
                if (key === 'valueOf') return () => proxy;
                const member = Reflect.get(target, key, target);
                return typeof member === 'function' ? member.bind(target) : member;
            },
        });
        return proxy;
    }
    if (Array.isArray(value)) {
        return Object.freeze(value.map(immutableSnapshot));
    }
    if (value !== null && typeof value === 'object'
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        const copy = {};
        for (const [key, entry] of Object.entries(value)) {
            Object.defineProperty(copy, key, {
                value: immutableSnapshot(entry), enumerable: true,
            });
        }
        return Object.freeze(copy);
    }
    return value;
}

export function stateValuesEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    if (left instanceof Map && right instanceof Map) {
        return left.size === right.size && Array.from(left).every(([key, value]) => right.has(key) && stateValuesEqual(value, right.get(key)));
    }
    if (left instanceof Set && right instanceof Set) {
        return left.size === right.size && Array.from(left).every(value => right.has(value));
    }
    const isRecord = value => Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
        && keys.every(key => Object.hasOwn(right, key) && stateValuesEqual(left[key], right[key]));
}

function ownedCopy(value) {
    if (Array.isArray(value)) return value.map(ownedCopy);
    if (value instanceof Map) return new Map(Array.from(value, ([key, entry]) => [key, ownedCopy(entry)]));
    if (value instanceof Set) return new Set(value);
    if (value !== null && typeof value === 'object'
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        const copy = {};
        for (const [key, entry] of Object.entries(value)) {
            Object.defineProperty(copy, key, { value: ownedCopy(entry), enumerable: true, writable: true, configurable: true });
        }
        return copy;
    }
    return value;
}

function controlledRecord(record, label) {
    const proxies = new WeakMap();
    const arrays = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
    function changed(before, after, key) {
        if (stateValuesEqual(before, after)) throw new Error(`Redundant state change: ${label}.${String(key)}`);
    }
    function wrap(value) {
        if (value === null || typeof value !== 'object') return value;
        const prototype = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set) && !(value instanceof WeakMap) && !(value instanceof WeakSet)
            && prototype !== Object.prototype && prototype !== null) return value;
        if (proxies.has(value)) return proxies.get(value);
        const proxy = new Proxy(value, {
            get(target, key, receiver) {
                if (target instanceof Map || target instanceof Set || target instanceof WeakMap || target instanceof WeakSet) {
                    if (key === 'size') return target.size;
                    if (key === 'has') return entry => target.has(entry);
                    if (key === 'get' && (target instanceof Map || target instanceof WeakMap)) return entry => wrap(target.get(entry));
                    if (key === 'set' && (target instanceof Map || target instanceof WeakMap)) return (entry, next) => {
                        if (target.has(entry)) changed(target.get(entry), next, entry);
                        target.set(entry, ownedCopy(next));
                        return proxy;
                    };
                    if (key === 'add' && (target instanceof Set || target instanceof WeakSet)) return entry => {
                        if (target.has(entry)) throw new Error(`Redundant state change: ${label}.add`);
                        target.add(entry);
                        return proxy;
                    };
                    if (key === 'delete') return entry => {
                        if (!target.has(entry)) throw new Error(`Redundant state change: ${label}.delete`);
                        return target.delete(entry);
                    };
                    if (key === 'clear') return () => {
                        if (target.size === 0) throw new Error(`Redundant state change: ${label}.clear`);
                        target.clear();
                    };
                    if (key === 'forEach') return callback => target.forEach((entry, entryKey) => callback(wrap(entry), entryKey, proxy));
                    if (key === 'keys') return () => target.keys();
                    if (key === Symbol.iterator || key === 'entries' || key === 'values') {
                        return function* () {
                            const iterator = key === Symbol.iterator ? target[Symbol.iterator]() : target[key]();
                            for (const entry of iterator) {
                                if (key === 'entries' || (target instanceof Map && key === Symbol.iterator)) yield [entry[0], wrap(entry[1])];
                                else yield wrap(entry);
                            }
                        };
                    }
                    return Reflect.get(target, key, target);
                }
                if (Array.isArray(target) && arrays.has(key)) return (...args) => {
                    const next = target.slice();
                    const returned = Array.prototype[key].apply(next, args.map(ownedCopy));
                    changed(target, next, key);
                    target.length = next.length;
                    for (let index = 0; index < next.length; index += 1) target[index] = next[index];
                    return returned === next ? proxy : wrap(returned);
                };
                return wrap(Reflect.get(target, key, receiver));
            },
            set(target, key, next) {
                if (Object.hasOwn(target, key)) changed(target[key], next, key);
                if (Array.isArray(target) && key === 'length') {
                    target.length = next;
                } else {
                    Object.defineProperty(target, key, { value: ownedCopy(next), enumerable: true, writable: true, configurable: true });
                }
                return true;
            },
            deleteProperty(target, key) {
                if (!Object.hasOwn(target, key)) throw new Error(`Redundant state change: ${label}.${String(key)} absent`);
                return Reflect.deleteProperty(target, key);
            },
            defineProperty() { throw new Error('State properties must use their setters'); },
            setPrototypeOf() { throw new Error('State prototypes cannot change'); },
        });
        proxies.set(value, proxy);
        return proxy;
    }
    return wrap(record);
}

class ApplicationStateStore {
    #records = new Map();
    #sequence = 0;
    #owners = new WeakMap();

    own(owner, label, seal) {
        if (!this.#owners.has(owner)) {
            const record = {};
            this.#owners.set(owner, controlledRecord(record, label));
        }
        const state = this.#owners.get(owner);
        for (const key of Object.keys(owner)) {
            const descriptor = Object.getOwnPropertyDescriptor(owner, key);
            if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function') continue;
            state[key] = descriptor.value;
            Object.defineProperty(owner, key, {
                enumerable: descriptor.enumerable,
                configurable: false,
                get: () => state[key],
                set: value => { state[key] = value; },
            });
        }
        if (seal) {
            // Method overrides are behavior (and useful test seams), not new
            // state fields. Declare their slots before sealing the state schema.
            let prototype = Object.getPrototypeOf(owner);
            while (prototype !== null && prototype !== Object.prototype) {
                for (const key of Object.getOwnPropertyNames(prototype)) {
                    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
                    if (key !== 'constructor' && typeof descriptor.value === 'function' && !Object.hasOwn(owner, key)) {
                        Object.defineProperty(owner, key, { value: descriptor.value, writable: true });
                    }
                }
                prototype = Object.getPrototypeOf(prototype);
            }
            Object.preventExtensions(owner);
        }
        return owner;
    }

    receiveOwnerSnapshot(owner, snapshot) {
        if (!this.#owners.has(owner)) throw new Error('Snapshot requires a registered state owner');
        const state = this.#owners.get(owner);
        const entries = Object.entries(snapshot);
        for (const [key] of entries) {
            if (!Object.hasOwn(state, key)) throw new Error(`Unknown snapshot field: ${key}`);
        }
        for (const [key, value] of entries) {
            if (!stateValuesEqual(state[key], value)) state[key] = value;
        }
    }

    createWeakCollection(label, kind) {
        if (kind !== 'map' && kind !== 'set') throw new Error('Weak collection requires map or set kind');
        const collection = kind === 'map' ? new WeakMap() : new WeakSet();
        this.#records.set(`${label}:${this.#sequence++}`, collection);
        return controlledRecord(collection, label);
    }

    createFields(label, initial) {
        return this.own(ownedCopy(initial), label, true);
    }

    createScope(label, initial) {
        if (typeof label !== 'string' || label.length === 0) throw new Error('State scope requires label');
        const id = `${label}:${this.#sequence++}`;
        this.#records.set(id, immutableSnapshot(initial));
        return Object.freeze({
            get: () => this.#get(id),
            set: next => this.#set(id, next),
            // Receiving a server snapshot is not a requested transition. Compare
            // the whole authoritative snapshot before publishing actual changes.
            receive: next => {
                if (stateValuesEqual(this.#get(id), next)) return false;
                this.#set(id, next);
                return true;
            },
            dispose: () => {
                this.#get(id);
                this.#records.delete(id);
            },
        });
    }

    #get(id) {
        if (!this.#records.has(id)) throw new Error(`State scope is not initialized: ${id}`);
        return this.#records.get(id);
    }

    #set(id, next) {
        if (stateValuesEqual(this.#get(id), next)) throw new Error(`Redundant state change: ${id}`);
        this.#records.set(id, immutableSnapshot(next));
    }
}

export const ApplicationState = Object.freeze(new ApplicationStateStore());
