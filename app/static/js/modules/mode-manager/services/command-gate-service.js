import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { CONFIG } from '../../config.js';

const WATCHDOG_TIMEOUT_MS = 15000;

const moduleState = ApplicationState.createFields('command-gate-service', {
    busy: false,
    busyName: null,
    busyStartedAt: null,
    watchdogId: null,
});


function clearWatchdog() {
    if (moduleState.watchdogId === null) {
        return;
    }
    clearTimeout(moduleState.watchdogId);
    moduleState.watchdogId = null;
}

function armWatchdog(timeoutMs) {
    clearWatchdog();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return;
    }
    moduleState.watchdogId = setTimeout(() => {
        if (!moduleState.busy) {
            return;
        }
        const elapsedMs = moduleState.busyStartedAt === null ? null : performance.now() - moduleState.busyStartedAt;
        throw new Error(
            `CommandGate watchdog: command stuck busy name=${moduleState.busyName} elapsedMs=${elapsedMs}`
        );
    }, timeoutMs);
}

export const CommandGate = {
    isBusy() {
        return moduleState.busy;
    },

    run(name, asyncFn, options) {
        if (typeof name !== 'string' || name.length === 0) {
            throw new Error('CommandGate.run requires non-empty name');
        }
        if (typeof asyncFn !== 'function') {
            throw new Error('CommandGate.run requires async function');
        }

        let resolvedOptions = null;
        if (options !== undefined) {
            resolvedOptions = options;
        }

        if (
            resolvedOptions !== null
            && (typeof resolvedOptions !== 'object' || Array.isArray(resolvedOptions))
        ) {
            throw new Error('CommandGate.run options must be an object or null');
        }

        if (moduleState.busy) {
            Logger.logNoop('Command dropped while busy', {
                requested: name,
                busyName: moduleState.busyName,
            });
            return Promise.resolve(null);
        }
        if (ModeContext.isLoading) {
            throw new Error(`CommandGate.run called while ModeContext.isLoading (name=${name})`);
        }

        ModeContext.setLoading(true);
        if (resolvedOptions !== null && resolvedOptions.showLoadingImmediately === true) {
            document.body.classList.add(CONFIG.CLASSES.LOADING);
        }
        moduleState.busy = true;
        moduleState.busyName = name;
        moduleState.busyStartedAt = performance.now();
        let watchdogTimeoutMs = WATCHDOG_TIMEOUT_MS;
        if (resolvedOptions !== null && resolvedOptions.disableWatchdog === true) {
            watchdogTimeoutMs = 0;
        } else if (resolvedOptions !== null && Number.isFinite(resolvedOptions.timeoutMs)) {
            watchdogTimeoutMs = resolvedOptions.timeoutMs;
        }
        armWatchdog(watchdogTimeoutMs);

        Logger.logAction('command_gate.start', { name });

        return Promise.resolve()
            .then(() => asyncFn())
            .finally(() => {
                Logger.logAction('command_gate.finish', { name });
                moduleState.busy = false;
                moduleState.busyName = null;
                moduleState.busyStartedAt = null;
                        clearWatchdog();
                ModeContext.setLoading(false);
            });
    },
};
