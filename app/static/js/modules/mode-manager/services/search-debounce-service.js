import { ApplicationState } from '../../application-state.js';
const moduleState = ApplicationState.createFields('search-debounce-service', {
    timeoutId: null,
});

export function cancelDebouncedSearchExecution() {
    if (moduleState.timeoutId === null) {
        return;
    }
    clearTimeout(moduleState.timeoutId);
    moduleState.timeoutId = null;
}

export function scheduleDebouncedSearchExecution(delayMs, execute) {
    if (!Number.isInteger(delayMs) || delayMs < 0) {
        throw new Error('scheduleDebouncedSearchExecution requires non-negative integer delayMs');
    }
    if (typeof execute !== 'function') {
        throw new Error('scheduleDebouncedSearchExecution requires execute function');
    }

    cancelDebouncedSearchExecution();
    moduleState.timeoutId = setTimeout(() => {
        moduleState.timeoutId = null;
        execute();
    }, delayMs);
}

