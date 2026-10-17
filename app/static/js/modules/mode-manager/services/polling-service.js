import { parseDecimalInteger } from '../../decimal-integer.js';
import { ApplicationState } from '../../application-state.js';
import { rethrowUnexpectedError } from '../../expected-errors.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { ErrorHandler } from '../../error-handler.js';
import { CONFIG } from '../../config.js';
import { buildSessionHeaders } from '../../session-auth.js';
import { CommandGate } from './command-gate-service.js';

const moduleState = ApplicationState.createFields('polling-service', {
    pollingInterval: null,
    lastTokenRefreshAt: 0,
    lastLinkTitleRevision: 0,
    linkTitleRefreshTimer: null,
    visibilityListener: null,
    connectivityCheck: null,
});


const TOKEN_REFRESH_INTERVAL_MS = 60_000; // minimum time between auth refresh calls
const LINK_TITLE_REFRESH_DEBOUNCE_MS = 1_200;
const RESTORE_TRANSITION_UNTIL_KEY = 'metalist_restore_transition_until_ms';


function _isRestoreTransitionActive() {
    const rawValue = sessionStorage.getItem(RESTORE_TRANSITION_UNTIL_KEY);
    if (rawValue === null) {
        return false;
    }
    if (!/^[0-9]+$/.test(rawValue)) {
        sessionStorage.removeItem(RESTORE_TRANSITION_UNTIL_KEY);
        return false;
    }
    const untilMs = parseDecimalInteger(rawValue);
    if (!Number.isInteger(untilMs)) {
        sessionStorage.removeItem(RESTORE_TRANSITION_UNTIL_KEY);
        return false;
    }
    if (Date.now() >= untilMs) {
        sessionStorage.removeItem(RESTORE_TRANSITION_UNTIL_KEY);
        return false;
    }
    return true;
}

function runConnectivityCheck() {
    checkConnectivityAndUpdates().catch((error) => {
        rethrowUnexpectedError(error);
        ErrorHandler.handleApiError(error, null);
        Logger.logError('Sync polling error', error);
    });
}

function handleVisibilityChange() {
    // Hidden tabs skip polls; check at once on return so session and
    // connectivity changes surface as soon as the user can see them.
    if (!document.hidden) runConnectivityCheck();
}

export function startPolling() {
    // Unified polling: check connectivity and updates. Status polls do not
    // extend sessions, so pausing them in hidden tabs changes no timeouts.
    moduleState.pollingInterval = setInterval(() => {
        if (document.hidden) return;
        runConnectivityCheck();
    }, CONFIG.SYNC.POLL_INTERVAL_MS);
    if (moduleState.visibilityListener === null) {
        moduleState.visibilityListener = handleVisibilityChange;
        document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    Logger.logInit('Unified polling started (connectivity + updates)');
}

export function stopPolling() {
    if (moduleState.pollingInterval) {
        clearInterval(moduleState.pollingInterval);
        moduleState.pollingInterval = null;
        Logger.logDebug('Unified polling stopped');
    }
    if (moduleState.linkTitleRefreshTimer !== null) {
        window.clearTimeout(moduleState.linkTitleRefreshTimer);
        moduleState.linkTitleRefreshTimer = null;
    }
    if (moduleState.visibilityListener !== null) {
        document.removeEventListener('visibilitychange', moduleState.visibilityListener);
        moduleState.visibilityListener = null;
    }
}

async function refreshTokenOnActivity() {
    const response = await fetch(CONFIG.API.AUTH.SESSIONS, {
        method: 'GET',
        headers: buildSessionHeaders(false),
    });

    if (response.ok) {
        moduleState.lastTokenRefreshAt = Date.now();
        Logger.logDebug('Token refreshed due to user activity');
        return;
    }

    Logger.logError('Token refresh request failed', response.statusText);
    ErrorHandler.handleApiError(null, response);
}

// One check at a time: a tab returning to view checks at once, and that
// check can overlap an interval tick. Overlapping checks would each clear the
// user-activity flag after the token refresh. A check arriving mid-flight is
// skipped; the one in flight already covers it.
async function checkConnectivityAndUpdates() {
    if (moduleState.connectivityCheck !== null) {
        return;
    }
    moduleState.connectivityCheck = performConnectivityCheck().finally(() => {
        moduleState.connectivityCheck = null;
    });
    await moduleState.connectivityCheck;
}

async function performConnectivityCheck() {
    if (_isRestoreTransitionActive()) {
        return;
    }
    if (CommandGate.isBusy()) {
        return;
    }
    if (ModeContext.userActivity) {
        const now = Date.now();
        if (now - moduleState.lastTokenRefreshAt >= TOKEN_REFRESH_INTERVAL_MS) {
            await refreshTokenOnActivity().finally(() => {
                ModeContext.setUserActivity(false);
            });
        } else {
            Logger.logDebug('User activity detected but token refresh throttled', {
                timeSinceLastRefresh: now - moduleState.lastTokenRefreshAt
            });
            ModeContext.setUserActivity(false);
        }
    }

    await pingAuthStatus();
}

async function pingAuthStatus() {
    const response = await fetch(CONFIG.API.AUTH.STATUS, {
        method: 'GET',
        headers: buildSessionHeaders(false),
    });

    if (response.ok) {
        const status = await response.json();
        handleLinkTitleRevision(status);
        ErrorHandler.handleConnectionRestored();
        return;
    }

    // Use centralized handler for HTTP errors
    ErrorHandler.handleApiError(null, response);
}

function handleLinkTitleRevision(status) {
    if (status === null || typeof status !== 'object') {
        throw new Error('auth status response must be an object');
    }
    if (status.authenticated !== true) {
        // Repeated locked-status responses have no revision to invalidate.
        if (moduleState.lastLinkTitleRevision !== 0) moduleState.lastLinkTitleRevision = 0;
        if (moduleState.linkTitleRefreshTimer !== null) {
            window.clearTimeout(moduleState.linkTitleRefreshTimer);
            moduleState.linkTitleRefreshTimer = null;
        }
        return;
    }
    const revision = status.link_title_revision;
    if (!Number.isInteger(revision) || revision < 0) {
        throw new Error('auth status link_title_revision must be a non-negative integer');
    }
    if (revision === moduleState.lastLinkTitleRevision) {
        return;
    }
    moduleState.lastLinkTitleRevision = revision;
    scheduleLinkTitleRefresh();
}

function scheduleLinkTitleRefresh() {
    if (moduleState.linkTitleRefreshTimer !== null) {
        window.clearTimeout(moduleState.linkTitleRefreshTimer);
    }
    moduleState.linkTitleRefreshTimer = window.setTimeout(() => {
        moduleState.linkTitleRefreshTimer = null;
        void refreshForLinkTitleChanges();
    }, LINK_TITLE_REFRESH_DEBOUNCE_MS);
}

async function refreshForLinkTitleChanges() {
    if (CommandGate.isBusy() || ModeContext.isEditing) {
        scheduleLinkTitleRefresh();
        return;
    }
    const { actionRefreshAndMaybeSelect } = await import('../actions/ui-actions.js');
    await actionRefreshAndMaybeSelect({ context: 'link-title-refresh', requireExecution: true });
}
