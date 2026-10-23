import { ApplicationState } from '../../application-state.js';
import { HttpRequestError } from '../../expected-errors.js';
import { CONFIG } from '../../config.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { ErrorHandler } from '../../error-handler.js';
import { areScrollAnchorsEqual, computeScrollAnchor } from './scroll-anchor-service.js';
import { CommandGate } from './command-gate-service.js';
import { buildSessionHeaders } from '../../session-auth.js';
import { AuthenticationRequiredError } from '../../client-state-api.js';
import { getReferenceViewsPayload, restoreReferenceNavigation } from './reference-source-navigation-service.js';
import { recordDateFiltersFromServer } from './date-range-filter-service.js';

const HTTP_UNAUTHORIZED = 401;
const TAB_STATE_ENDPOINT = CONFIG.API.NOTES.TAB_STATE;
const TAB_STATE_NEW_TAB_ENDPOINT = CONFIG.API.NOTES.TAB_STATE_NEW_TAB;
const TAB_STATE_DELETE_TAB_ENDPOINT = CONFIG.API.NOTES.TAB_STATE_DELETE_TAB;
const TAB_STATE_SORT_MODE_ENDPOINT = CONFIG.API.NOTES.TAB_STATE_SORT_MODE;
const TAB_STATE_DATE_FILTER_ENDPOINT = CONFIG.API.NOTES.TAB_STATE_DATE_FILTER;
const SCROLL_POLL_INTERVAL_MS = 1000;
const TAB_STATE_PERSIST_DEBOUNCE_MS = 300;

const moduleState = ApplicationState.createFields('tab-state-service', {
    lastPersistedScrollByTab: Object.create(null),

    lastSignature: null,
    scrollListenerAttached: false,
    pendingScrollFrame: null,
    lastScrollY: null,
    pendingTabId: null,
    scrollPollId: null,
    pendingPersistTimeout: null,
    pendingPersistRequest: null,
    isScrollPersisting: false,
});


function setTabStateVersionFromServer(version) {
    const normalizedVersion = typeof version === 'number' ? version : 0;
    // The server can echo an unchanged tab-state version for no-op persistence responses.
    if (ModeContext.tabStateVersion !== normalizedVersion) {
        ModeContext.setTabStateVersion(normalizedVersion);
    }
}

export async function initializeTabStateService() {
    const serverState = await fetchTabState();
    ModeContext.hydrateTabState(serverState, { emitUpdate: false });
    restoreReferenceNavigation(serverState);
    setTabStateVersionFromServer(serverState.version);
    recordServerSignature(serverState);
    ModeContext.setTabStateUpdateHook(handleTabStateMutation);
    startScrollWatcher();
    startScrollPolling();
    return serverState;
}

export async function persistTabStateSnapshot() {
    // Search, tab actions, and scroll polling share one snapshot writer. Read the
    // current payload only after the preceding response has updated its version.
    while (moduleState.pendingPersistRequest !== null) {
        await moduleState.pendingPersistRequest;
    }
    // Which tabs are reference views goes with the tabs (docs/ui/references.md).
    const snapshot = { ...ModeContext.getTabStatePayload(), referenceViews: getReferenceViewsPayload() };
    const signature = serializeState(canonicalizeState(snapshot));
    if (signature === moduleState.lastSignature) {
        return;
    }
    moduleState.pendingPersistRequest = callTabStateApi('POST', snapshot).then(response => {
        setTabStateVersionFromServer(response.version);
        recordServerSignature(response);
    }).finally(() => {
        moduleState.pendingPersistRequest = null;
    });
    await moduleState.pendingPersistRequest;
}

function canonicalizeState(state) {
    if (!state || typeof state !== 'object') {
        throw new Error('tab-state payload must be an object');
    }
    return {
        activeTabId: state.activeTabId,
        tabs: state.tabs,
        tabOrder: state.tabOrder,
        referenceViews: state.referenceViews,
        version: state.version,
    };
}

function handleTabStateMutation(event) {
    if (!event || typeof event !== 'object') {
        throw new Error('tab-state mutation hook requires event object');
    }
    const reason = event.reason;
    if (reason !== 'searchQuery') {
        return;
    }
    scheduleTabStatePersist();
}

function scheduleTabStatePersist() {
    if (moduleState.pendingPersistTimeout !== null) {
        window.clearTimeout(moduleState.pendingPersistTimeout);
    }
    moduleState.pendingPersistTimeout = window.setTimeout(() => {
        moduleState.pendingPersistTimeout = null;
        void persistTabStateSnapshot();
    }, TAB_STATE_PERSIST_DEBOUNCE_MS);
}

function captureServerSignature(state) {
    if (!state || typeof state !== 'object') {
        throw new Error('tab-state response missing payload');
    }
    setTabStateVersionFromServer(state.version);
    recordServerSignature(state);
}

// The server answers a post that changes nothing (e.g. one differing only in
// what it normalises away) with the state and version it already had, so its
// signature can equal the recorded one. Every answer also carries the tabs' date
// range filters, which only the server changes.
function recordServerSignature(state) {
    recordDateFiltersFromServer(state);
    const signature = serializeState(canonicalizeState(state));
    if (moduleState.lastSignature !== signature) {
        moduleState.lastSignature = signature;
    }
}

async function fetchTabState() {
    return await callTabStateApi('GET', null);
}

async function callTabStateApi(method, body) {
    if (typeof body === 'undefined') {
        throw new Error('callTabStateApi requires body (use null)');
    }
    return await callTabStateApiAt(TAB_STATE_ENDPOINT, method, body);
}

async function callTabStateApiAt(endpoint, method, body) {
    if (typeof body === 'undefined') {
        throw new Error('callTabStateApiAt requires body (use null)');
    }
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
        throw new Error('tab-state endpoint must be a non-empty string');
    }
    const response = await fetch(endpoint, {
        method,
        headers: buildSessionHeaders(true),
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
        ErrorHandler.handleApiError(null, response);
        // The session ended: handleApiError has shown the login screen.
        if (response.status === HTTP_UNAUTHORIZED) {
            throw new AuthenticationRequiredError(`tab-state ${method}: the session has ended`);
        }
        throw new HttpRequestError(`tab-state ${method} failed with status ${response.status}`);
    }
    return await response.json();
}

export async function createTabOnServer(copyFromTabId) {
    if (typeof copyFromTabId !== 'string' || copyFromTabId.length === 0) {
        throw new Error('copyFromTabId must be a non-empty string');
    }
    const response = await callTabStateApiAt(TAB_STATE_NEW_TAB_ENDPOINT, 'POST', {
        copyFromTabId,
        clientId: ModeContext.clientId,
    });
    captureServerSignature(response);
    return response;
}

export async function deleteTabOnServer(tabId) {
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('tabId must be a non-empty string');
    }
    const response = await callTabStateApiAt(TAB_STATE_DELETE_TAB_ENDPOINT, 'POST', { tabId });
    captureServerSignature(response);
    return response;
}

function captureUndoContext() {
    const tabId = ModeContext.activeTabId;
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('ModeContext.activeTabId must be a non-empty string');
    }
    const epoch = ModeContext.undoContextEpoch;
    if (!Number.isInteger(epoch) || epoch < 0) {
        throw new Error('ModeContext.undoContextEpoch must be a non-negative integer');
    }
    const searchQuery = ModeContext.searchQuery;
    if (searchQuery !== null && typeof searchQuery !== 'string') {
        throw new Error('ModeContext.searchQuery must be a string or null');
    }
    if (searchQuery === null) {
        return `tab:${tabId}|search:|epoch:${epoch}`;
    }
    return `tab:${tabId}|search:${searchQuery}|epoch:${epoch}`;
}

export async function setTabSortModeOnServer(tabId, sortMode) {
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('tabId must be a non-empty string');
    }
    if (typeof sortMode !== 'string' || sortMode.length === 0) {
        throw new Error('sortMode must be a non-empty string');
    }
    const response = await callTabStateApiAt(TAB_STATE_SORT_MODE_ENDPOINT, 'POST', {
        tabId,
        sortMode,
        clientId: ModeContext.clientId,
        undoContext: captureUndoContext(),
    });
    captureServerSignature(response);
    return response;
}

/** Set a tab's date range filter ({ field, rangeKind, fromDate, toDate }; rangeKind 'none' clears it). */
export async function setTabDateFilterOnServer(tabId, filter) {
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('tabId must be a non-empty string');
    }
    if (!filter || typeof filter !== 'object') {
        throw new Error('setTabDateFilterOnServer requires a filter object');
    }
    const response = await callTabStateApiAt(TAB_STATE_DATE_FILTER_ENDPOINT, 'POST', {
        tabId,
        field: filter.field,
        rangeKind: filter.rangeKind,
        fromDate: filter.fromDate,
        toDate: filter.toDate,
        clientId: ModeContext.clientId,
        undoContext: captureUndoContext(),
    });
    captureServerSignature(response);
    return response;
}

function startScrollWatcher() {
    if (moduleState.scrollListenerAttached) {
        return;
    }
    moduleState.lastScrollY = getCurrentScrollY();
    window.addEventListener('scroll', handleScrollEvent, { passive: true });
    moduleState.scrollListenerAttached = true;
}

function handleScrollEvent() {
    if (ModeContext.shouldIgnoreScrollEvents()) {
        return;
    }
    if (ModeContext.isLoading) {
        return;
    }
    if (moduleState.pendingScrollFrame !== null) {
        return;
    }
    const sourceTabId = ModeContext.activeTabId;
    moduleState.pendingTabId = sourceTabId;
    moduleState.pendingScrollFrame = window.requestAnimationFrame(() => {
        moduleState.pendingScrollFrame = null;
        const current = getCurrentScrollY();
        if (current !== moduleState.lastScrollY) {
            moduleState.lastScrollY = current;
            const effectiveTabId = moduleState.pendingTabId === null ? ModeContext.activeTabId : moduleState.pendingTabId;  // shockharness: ignore[DEF002] reason="null means no tab switch is pending"
            // A programmatic restore can update ModeContext before the browser scroll event lands.
            if (ModeContext.getTabScrollPosition(effectiveTabId) !== current) {
                ModeContext.updateTabScroll(effectiveTabId, current, { emit: true });
            }
        }
        moduleState.pendingTabId = null;
    });
}

function startScrollPolling() {
    if (moduleState.scrollPollId !== null) {
        return;
    }
    moduleState.scrollPollId = window.setInterval(pollPersistScroll, SCROLL_POLL_INTERVAL_MS);
}

async function pollPersistScroll() {
    if (moduleState.isScrollPersisting) {
        return;
    }
    if (document.hidden) {
        return;
    }
    if (CommandGate.isBusy()) {
        return;
    }
    if (ModeContext.shouldIgnoreScrollEvents()) {
        return;
    }
    if (ModeContext.isLoading) {
        return;
    }
    moduleState.isScrollPersisting = true;
    // The session can end while a save is in flight (it expired, a backup
    // restore or a password change ended it): the login screen already shows,
    // and the last moment's scroll is not saved. Every other failure surfaces.
    await persistCurrentScroll().catch((error) => { // shockharness: ignore[EXC002] reason="a session that ended is shown as the login screen; the last moment's scroll is dropped on purpose"
        if (!(error instanceof AuthenticationRequiredError)) {
            throw error;
        }
    }).finally(() => {
        moduleState.isScrollPersisting = false;
    });
}

async function persistCurrentScroll() {
    const tabId = ModeContext.activeTabId;
    const current = getCurrentScrollY();
    const previous = moduleState.lastPersistedScrollByTab[tabId];
    if (typeof previous === 'number' && previous === current) {
        return;
    }
    // Scroll polling can hit the same Y after another scroll listener already stored it.
    if (ModeContext.getTabScrollPosition(tabId) !== current) {
        ModeContext.updateActiveTabScroll(current);
    }
    const nextScrollAnchor = computeScrollAnchor({ anchorBias: 'auto' });
    // Polling can run when the view has no root notes, so computed and stored anchors are both null.
    if (!areScrollAnchorsEqual(ModeContext.getTabScrollAnchor(tabId), nextScrollAnchor)) {
        ModeContext.updateActiveTabScrollAnchor(nextScrollAnchor);
    }
    await persistTabStateSnapshot();
    moduleState.lastPersistedScrollByTab[tabId] = current;
}

function getCurrentScrollY() {
    return Math.max(0, Math.round(window.scrollY));
}

function serializeState(state) {
    if (!state) {
        return '';
    }
    return JSON.stringify(state);
}
