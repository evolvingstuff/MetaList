import { ApplicationState, immutableSnapshot } from './application-state.js';
import { RemindersAPI } from './api-client.js';

function validateReminderSnapshot(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Reminder snapshot response missing payload');
    }
    if (!Array.isArray(payload.reminders)) {
        throw new Error('Reminder snapshot response missing reminders');
    }
    if (!Array.isArray(payload.missed)) {
        throw new Error('Reminder snapshot response missing missed');
    }
}

class ReminderStoreService {
    constructor() {
        this._snapshot = {
            reminders: [],
            missed: [],
        };
        this._listeners = new Set();
        this._refreshPromise = null;
        this._refreshAgain = false;
        this._mutationPromise = null;

        ApplicationState.own(this, 'ReminderStoreService', new.target === ReminderStoreService);
    }

    snapshot() {
        return immutableSnapshot(this._snapshot);
    }

    subscribe(listener) {
        if (typeof listener !== 'function') {
            throw new Error('ReminderStore.subscribe requires listener');
        }
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    async refresh() {
        await this._waitForMutationQueue();
        return await this._refreshSnapshot();
    }

    async create(payload) {
        await this._enqueueMutation(async () => {
            await RemindersAPI.create(payload);
        });
        return await this.refresh();
    }

    async update(reminderId, payload) {
        await this._enqueueMutation(async () => {
            await RemindersAPI.update(reminderId, payload);
        });
        return await this.refresh();
    }

    async delete(reminderId) {
        await this._enqueueMutation(async () => {
            await RemindersAPI.delete(reminderId);
        });
        return await this.refresh();
    }

    async action(reminderId, actionName, actionPayload) {
        if (!actionPayload || typeof actionPayload !== 'object') {
            throw new Error('ReminderStore.action requires actionPayload');
        }
        await this._enqueueMutation(async () => {
            await RemindersAPI.action(reminderId, actionName, actionPayload);
        });
        return await this.refresh();
    }

    async _enqueueMutation(mutation) {
        if (typeof mutation !== 'function') {
            throw new Error('ReminderStore mutation requires function');
        }
        const previousMutation = this._mutationPromise;
        const currentMutation = (async () => {
            if (previousMutation !== null) {
                await previousMutation;
            }
            await mutation();
        })();
        this._mutationPromise = currentMutation;
        await currentMutation.finally(() => {
            if (this._mutationPromise === currentMutation) {
                this._mutationPromise = null;
            }
        });
    }

    async _waitForMutationQueue() {
        if (this._mutationPromise === null) {
            return;
        }
        await this._mutationPromise;
    }

    async _refreshSnapshot() {
        if (this._refreshPromise !== null) {
            // Coalesce any number of refresh requests into one follow-up fetch.
            if (!this._refreshAgain) this._refreshAgain = true;
            await this._refreshPromise;
            return this.snapshot();
        }
        this._refreshAgain = true;
        const refreshPromise = this._refreshLoop();
        this._refreshPromise = refreshPromise;
        await refreshPromise.finally(() => {
            if (this._refreshPromise === refreshPromise) {
                this._refreshPromise = null;
            }
        });
        return this.snapshot();
    }

    async _refreshLoop() {
        while (this._refreshAgain) {
            this._refreshAgain = false;
            const payload = await RemindersAPI.list();
            validateReminderSnapshot(payload);
            ApplicationState.receiveOwnerSnapshot(this, {
                _snapshot: {reminders: payload.reminders, missed: payload.missed},
            });
            this._emit();
        }
    }

    _emit() {
        const snapshot = this.snapshot();
        for (const listener of this._listeners) {
            listener(snapshot);
        }
    }
}

export const ReminderStore = new ReminderStoreService();
