import { ApplicationState } from '../../application-state.js';
import { HttpRequestError } from '../../expected-errors.js';
import { CONFIG } from '../../config.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { ErrorHandler } from '../../error-handler.js';
import { areScrollAnchorsEqual, computeScrollAnchor } from './scroll-anchor-service.js';
import { CommandGate } from './command-gate-service.js';
import { buildSessionHeaders } from '../../session-auth.js';

const TAB_STATE_ENDPOINT = CONFIG.API.NOTES.TAB_STATE;
const TAB_STATE_NEW_TAB_ENDPOINT = CONFIG.API.NOTES.TAB_STATE_NEW_TAB;
const TAB_STATE_DELETE_TAB_ENDPOINT = CONFIG.API.NOTES.TAB_STATE_DELETE_TAB;
const TAB_STATE_SORT_MODE_ENDPOINT = CONFIG.API.NOTES.TAB_STATE_SORT_MODE;
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
    setTabStateVersionFromServer(serverState.version);
    moduleState.lastSignature = serializeState(canonicalizeState(serverState));
    ModeContext.setTabStateUpdateHook(handleTabStateMutation);
    startScrollWatcher();
    startScrollPolling();
    return serverState;
}

export async function persistTabStateSnapshot() {
    const snapshot = ModeContext.getTabStatePayload();
    const signature = serializeState(canonicalizeState(snapshot));
    if (signature === moduleState.lastSignature) {
        return;
    }
    const response = await callTabStateApi('POST', snapshot);
    setTabStateVersionFromServer(response.version);
    moduleState.lastSignature = serializeState(canonicalizeState(response));
}

function canonicalizeState(state) {
    if (!state || typeof state !== 'object') {
        throw new Error('tab-state payload must be an object');
    }
    return {
        activeTabId: state.activeTabId,
        tabs: state.tabs,
        tabOrder: state.tabOrder,
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
    moduleState.lastSignature = serializeState(canonicalizeState(state));
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
        throw new HttpRequestError(`tab-state ${method} failed with status ${response.status}`);
    }
    return await response.json();
}

export async function createTabOnServer(copyFromTabId) {
    if (typeof copyFromTabId !== 'string' || copyFromTabId.length === 0) {
        throw new Error('copyFromTabId must be a non-empty string');
    }
    const response = await callTabStateApiAt(TAB_STATE_NEW_TAB_ENDPOINT, 'POST', { copyFromTabId });
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
    const normalizedSearch = searchQuery === null ? '' : searchQuery;
    return `tab:${tabId}|search:${normalizedSearch}|epoch:${epoch}`;
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
            const effectiveTabId = moduleState.pendingTabId ? moduleState.pendingTabId : ModeContext.activeTabId;
            // A programmatic restore can update ModeContext before the browser scroll event lands.
            if (ModeContext.getTabScrollPosition(effectiveTabId) !== current) {
                ModeContext.updateTabScroll(effectiveTabId, current, true);
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
        ModeContext.updateActiveTabScrollAnchor(nextScrollAnchor, true);
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
