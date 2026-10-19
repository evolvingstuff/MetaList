import { persistClientPreferences } from '../client-state-api.js';
import { ApplicationState, stateValuesEqual } from '../application-state.js';

export class PreferencesStore {
    #scope;
    // The preferences as last asked for: the saved ones plus every change still on
    // its way to the server. Reads and the next change start from here, so a quick
    // second click (a toggle pressed twice) works from the first click's value.
    #latest = {};
    // Changes are saved one at a time, in order, each with every earlier change.
    #pending = Promise.resolve(null);
    constructor() {
        this.#scope = ApplicationState.createScope('preferences', {});

        ApplicationState.own(this, 'PreferencesStore', new.target === PreferencesStore);
    }

    replaceAll(rawPreferences) {
        if (!rawPreferences || typeof rawPreferences !== 'object' || Array.isArray(rawPreferences)) {
            throw new Error('PreferencesStore.replaceAll requires preferences object');
        }

        const nextState = {};
        for (const [key, value] of Object.entries(rawPreferences)) {
            if (typeof key !== 'string' || key.length === 0) {
                throw new Error('PreferencesStore.replaceAll requires non-empty string keys');
            }
            if (typeof value !== 'string') {
                throw new Error('PreferencesStore.replaceAll requires string values');
            }
            nextState[key] = value;
        }
        this.#scope.receive(nextState);
        this.#latest = { ...nextState };
    }

    // Asks for `nextState` now and saves it after the changes before it.
    #change(nextState, redundantMessage) {
        if (stateValuesEqual(this.#latest, nextState)) throw new Error(redundantMessage);
        this.#latest = nextState;
        const run = this.#pending.then(async () => {
            const persisted = await persistClientPreferences(nextState);
            // Another tab may already have delivered the same preferences.
            if (!stateValuesEqual(this.#scope.get(), nextState)) this.#scope.set(nextState);
            return persisted;
        });
        // The next change waits for this one. If this save fails (already a fatal
        // error), the changes after it fail with the same error instead of running.
        this.#pending = run;
        return run;
    }

    _snapshot() {
        return { ...this.#latest };
    }

    getRaw(key) {
        if (typeof key !== 'string' || key.length === 0) {
            throw new Error('PreferencesStore.getRaw requires non-empty key');
        }
        if (!Object.prototype.hasOwnProperty.call(this.#latest, key)) {
            return null;
        }
        return this.#latest[key];
    }

    async setRaw(key, value) {
        if (typeof key !== 'string' || key.length === 0) {
            throw new Error('PreferencesStore.setRaw requires non-empty key');
        }
        if (typeof value !== 'string') {
            throw new Error('PreferencesStore.setRaw requires string value');
        }
        if (stateValuesEqual(this.getRaw(key), value)) throw new Error(`Redundant state change: preference ${key}`);
        await this.#change({ ...this.#latest, [key]: value }, `Redundant state change: preference ${key}`);
    }

    async setMany(updates) {
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            throw new Error('PreferencesStore.setMany requires updates object');
        }
        const entries = Object.entries(updates);
        if (entries.length === 0) {
            throw new Error('PreferencesStore.setMany requires at least one update');
        }
        for (const [key, value] of entries) {
            if (typeof key !== 'string' || key.length === 0) {
                throw new Error('PreferencesStore.setMany requires non-empty keys');
            }
            if (typeof value !== 'string') {
                throw new Error('PreferencesStore.setMany requires string values');
            }
        }
        await this.#change({ ...this.#latest, ...updates }, 'Redundant state change: preferences');
    }

    async remove(key) {
        if (typeof key !== 'string' || key.length === 0) {
            throw new Error('PreferencesStore.remove requires non-empty key');
        }
        if (!Object.hasOwn(this.#latest, key)) throw new Error(`Redundant state change: preference ${key} is absent`);
        const nextState = this._snapshot();
        delete nextState[key];
        await this.#change(nextState, `Redundant state change: preference ${key} is absent`);
    }

    async clearAll() {
        await this.#change({}, 'Redundant state change: preferences already empty');
    }
}
