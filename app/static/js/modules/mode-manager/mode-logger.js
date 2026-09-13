export const LogCategory = Object.freeze({
    ACTION: 'ACTION',
    STATE: 'STATE',
    EVENT: 'EVENT',
    INIT: 'INIT',
    ERROR: 'ERROR',
    NOOP: 'NOOP',  
    DEBUG: 'DEBUG'  
});

export function logDebug(message, data, category, modes) {
    if (typeof category === 'undefined') {
        category = LogCategory.EVENT;
    }
    if (typeof data === 'undefined' || data === null) {
        data = {};
    }
    if (typeof modes === 'undefined') {
        modes = null;
    }

    console.log(`[${category}]: ${message}`);
}

export function logAction(actionName, data) {
    if (typeof data === 'undefined' || data === null) {
        data = {};
    }
    console.log(`[${LogCategory.ACTION}]: ${actionName}`);
}

export function logState(property, newValue, oldValue) {
    console.log(`[${LogCategory.STATE}]: ${property} changed`);
}

export function logFullState(stateObj) {
    console.log(`[${LogCategory.STATE}]: Current State requested`);
}

export function logInit(componentName) {
    console.log(`[${LogCategory.INIT}]: ${componentName} initialized`);
}

export function logError(message, error) {
    if (typeof error === 'undefined' || error === null) {
        error = {};
    }
    const errorName = error instanceof Error ? error.name : typeof error;
    console.error(`[${LogCategory.ERROR}]: ${message}`, { errorName });
}

export function logNoop(message, data) {
    if (typeof data === 'undefined' || data === null) {
        data = {};
    }
    console.log(`[${LogCategory.NOOP}]: ${message}`);
}
