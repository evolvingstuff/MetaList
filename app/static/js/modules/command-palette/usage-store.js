import { rethrowUnexpectedError } from '../expected-errors.js';
import { persistCommandPaletteUsage } from '../client-state-api.js';
import { ApplicationState } from '../application-state.js';

function parseUsageState(raw) {
    if (raw === null) {
        return {};
    }
    if (typeof raw !== 'string' && (typeof raw !== 'object' || Array.isArray(raw))) {
        throw new Error('Usage state must be a string, object, or null');
    }

    let parsed;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            rethrowUnexpectedError(err);
            throw new Error(`Usage state JSON parse failed: ${err}`);
        }
    } else {
        parsed = raw;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Usage state must be an object');
    }
    return parsed;
}

function serializeUsageState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new Error('Usage state must be an object');
    }
    return JSON.stringify(state);
}

export class UsageStore {
    #scope;
    constructor() {
        this.#scope = ApplicationState.createScope('commandUsage', {});

        ApplicationState.own(this, 'UsageStore', new.target === UsageStore);
    }

    replaceAll(rawUsageState) {
        this.#scope.receive(parseUsageState(rawUsageState));
    }

    getUsageSnapshot() {
        return parseUsageState(serializeUsageState(this.#scope.get()));
    }

    async recordUse(endpointId, queryTokens) {
        if (typeof endpointId !== 'string' || endpointId.length === 0) {
            throw new Error('UsageStore.recordUse requires endpointId string');
        }
        if (!Array.isArray(queryTokens)) {
            throw new Error('UsageStore.recordUse requires queryTokens array');
        }
        for (const token of queryTokens) {
            if (typeof token !== 'string') {
                throw new Error('UsageStore.recordUse queryTokens must be strings');
            }
        }

        const now = Date.now();
        const state = this.getUsageSnapshot();
        const previous = Object.prototype.hasOwnProperty.call(state, endpointId) ? state[endpointId] : null;
        const nextCount = previous && typeof previous.count === 'number' ? previous.count + 1 : 1;
        state[endpointId] = {
            count: nextCount,
            lastUsedAt: now,
            lastQueryTokens: queryTokens,
        };
        this.#scope.set(state);
        await persistCommandPaletteUsage(this.getUsageSnapshot());
    }
}
