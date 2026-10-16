// Saves an Excalidraw scene after the drawing has been idle for a delay, one save at a time.
// Pure logic with injected timers and save function so it can be tested without a browser.
import { ApplicationState } from '../application-state.js';

export const AUTOSAVE_STATUS = Object.freeze({
    SAVED: 'saved',
    UNSAVED: 'unsaved',
    SAVING: 'saving',
    ERROR: 'error',
    CONFLICT: 'conflict',
});

function requireFunction(value, name) {
    if (typeof value !== 'function') {
        throw new Error(`createAutosaveController requires ${name} function`);
    }
}

// save() resolves to { ok: true } or { ok: false, conflict: boolean }.
export function createAutosaveController(options) {
    if (options === null || typeof options !== 'object') {
        throw new Error('createAutosaveController requires options');
    }
    const { delayMs, save, schedule, cancel, onStatus } = options;
    if (!Number.isInteger(delayMs) || delayMs < 0) {
        throw new Error('createAutosaveController requires a non-negative integer delayMs');
    }
    requireFunction(save, 'save');
    requireFunction(schedule, 'schedule');
    requireFunction(cancel, 'cancel');
    requireFunction(onStatus, 'onStatus');

    const state = ApplicationState.createFields('excalidraw-autosave', {
        dirty: false,
        stopped: false,
        timer: null,
        inFlight: null,
        status: AUTOSAVE_STATUS.SAVED,
    });

    // ApplicationState rejects redundant assignments, so only transition real changes.
    function markDirty() {
        if (!state.dirty) {
            state.dirty = true;
        }
    }

    function stopSaving() {
        if (!state.stopped) {
            state.stopped = true;
        }
        clearTimer();
    }

    function setStatus(status) {
        if (state.status !== status) {
            state.status = status;
            onStatus(status);
        }
    }

    function clearTimer() {
        if (state.timer !== null) {
            cancel(state.timer);
            state.timer = null;
        }
    }

    function scheduleSave() {
        clearTimer();
        // A save that finishes after stop() must not queue another one.
        if (state.stopped) {
            return;
        }
        state.timer = schedule(() => {
            state.timer = null;
            void runSave();
        }, delayMs);
    }

    async function runSave() {
        if (state.inFlight !== null) {
            return await state.inFlight;
        }
        if (state.stopped || !state.dirty) {
            return undefined;
        }
        state.dirty = false;
        setStatus(AUTOSAVE_STATUS.SAVING);
        state.inFlight = Promise.resolve().then(save).then((result) => { // shockharness: ignore[EXC001] reason="the handler only resets state, then rethrows the error unchanged"
            if (result === null || typeof result !== 'object' || typeof result.ok !== 'boolean') {
                throw new Error('Autosave save() must resolve to { ok: boolean }');
            }
            state.inFlight = null;
            if (!result.ok) {
                markDirty();
                if (result.conflict === true) {
                    stopSaving();
                    setStatus(AUTOSAVE_STATUS.CONFLICT);
                    return undefined;
                }
                setStatus(AUTOSAVE_STATUS.ERROR);
                scheduleSave();
                return undefined;
            }
            if (state.dirty) {
                setStatus(AUTOSAVE_STATUS.UNSAVED);
                scheduleSave();
                return undefined;
            }
            setStatus(AUTOSAVE_STATUS.SAVED);
            return undefined;
        }, (error) => {
            state.inFlight = null;
            throw error;
        });
        return await state.inFlight;
    }

    return Object.freeze({
        noteChange() {
            if (state.stopped) {
                return;
            }
            markDirty();
            if (state.inFlight === null) {
                setStatus(AUTOSAVE_STATUS.UNSAVED);
            }
            scheduleSave();
        },
        // Save now (used by Done). Resolves once nothing is left unsaved, or after a failure.
        async flush() {
            clearTimer();
            if (state.inFlight !== null) {
                await state.inFlight;
            }
            if (state.dirty && !state.stopped) {
                clearTimer();
                await runSave();
            }
            return state.status;
        },
        stop() {
            stopSaving();
        },
        // Wait for a save that is already under way (used before discarding changes).
        async waitForIdle() {
            if (state.inFlight !== null) {
                await state.inFlight;
            }
        },
        get status() {
            return state.status;
        },
        get isDirty() {
            return state.dirty;
        },
    });
}
