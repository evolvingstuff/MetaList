import { NOT_FOUND } from '../../not-found.js';
import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';

// The kinds of temporary view a note can open: its source, or the notes referencing it.
const REFERENCE_VIEW_KINDS = new Set(['source', 'backlinks']);

// Reference tabs are ordinary server tabs whose search is a hidden note-ID query.
// The navigation stack that hides that query is kept per browser tab in
// sessionStorage so a reload keeps the "Reference source" label instead of
// exposing raw IDs in the search field.
const REFERENCE_NAVIGATION_STORAGE_KEY = 'metalist_reference_navigation_stack';

const moduleState = ApplicationState.createFields('reference-source-navigation-service', {
    referenceNavigationStack: [],
    hasRestoredFromSession: false,
});


function copyOriginScope(originScope) {
    if (!originScope || typeof originScope !== 'object' || Array.isArray(originScope)) {
        throw new Error('Reference navigation requires originScope');
    }
    for (const key of ['scopeTabId', 'sortMode']) {
        if (typeof originScope[key] !== 'string' || originScope[key].length === 0) {
            throw new Error(`Reference origin scope missing ${key}`);
        }
    }
    if (typeof originScope.searchQuery !== 'string') {
        throw new Error('Reference origin scope missing searchQuery');
    }
    if (typeof originScope.isUntaggedView !== 'boolean') {
        throw new Error('Reference origin scope missing isUntaggedView');
    }
    return {
        scopeTabId: originScope.scopeTabId,
        searchQuery: originScope.searchQuery,
        sortMode: originScope.sortMode,
        isUntaggedView: originScope.isUntaggedView,
    };
}

function copyReferenceNavigationEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Reference navigation stack entry must be an object');
    }
    for (const key of ['fromTabId', 'toTabId', 'referenceQuery']) {
        if (typeof entry[key] !== 'string' || entry[key].length === 0) {
            throw new Error(`Reference navigation stack entry missing ${key}`);
        }
    }
    if (entry.viewKind !== 'source' && entry.viewKind !== 'backlinks') {
        throw new Error('Reference navigation stack entry requires source or backlinks viewKind');
    }
    return {
        fromTabId: entry.fromTabId,
        toTabId: entry.toTabId,
        referenceQuery: entry.referenceQuery,
        originScope: copyOriginScope(entry.originScope),
        viewKind: entry.viewKind,
    };
}

function persistReferenceNavigationStack() {
    sessionStorage.setItem(
        REFERENCE_NAVIGATION_STORAGE_KEY,
        JSON.stringify(moduleState.referenceNavigationStack),
    );
}

export function parseStoredReferenceNavigationStack(rawValue) {
    if (rawValue === null) {
        return [];
    }
    if (typeof rawValue !== 'string') {
        throw new Error('Stored reference navigation must be a string');
    }
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
        throw new Error('Stored reference navigation must be a list');
    }
    // Only kinds of view this version knows are restored; others (e.g. the removed
    // similar-notes view, docs/design/similar-notes-learnings.md) are dropped, leaving
    // their tab as an ordinary tab.
    return parsed
        .filter((entry) => entry && typeof entry === 'object' && REFERENCE_VIEW_KINDS.has(entry.viewKind))
        .map(copyReferenceNavigationEntry);
}

/**
 * Restore this browser tab's reference navigation after the server tab state loads.
 *
 * Keeps only entries whose tabs still exist and whose reference tab still runs the
 * exact hidden query; any other search means the user already left that view.
 */
export function restoreReferenceNavigationFromSession(serverTabs) {
    if (moduleState.hasRestoredFromSession) {
        throw new Error('Reference navigation can be restored only once per page load');
    }
    if (!serverTabs || typeof serverTabs !== 'object' || Array.isArray(serverTabs)) {
        throw new Error('Reference navigation restore requires server tabs');
    }
    if (moduleState.referenceNavigationStack.length !== 0) {
        throw new Error('Reference navigation restore requires an empty in-memory stack');
    }
    moduleState.hasRestoredFromSession = true;
    const storedEntries = parseStoredReferenceNavigationStack(
        sessionStorage.getItem(REFERENCE_NAVIGATION_STORAGE_KEY),
    );
    for (const entry of storedEntries) {
        const fromTab = serverTabs[entry.fromTabId];
        const toTab = serverTabs[entry.toTabId];
        if (fromTab === undefined || toTab === undefined) continue;
        if (toTab.searchQuery !== entry.referenceQuery) continue;
        moduleState.referenceNavigationStack.push(entry);
    }
    persistReferenceNavigationStack();
    updateReferenceSourceIndicator();
}

function pruneReferenceNavigationStackToExistingTabs() {
    const tabOrder = ModeContext.tabOrder;
    if (!Array.isArray(tabOrder)) {
        throw new Error('ModeContext.tabOrder must be an array');
    }
    const existingTabIds = new Set(tabOrder);
    let writeIndex = 0;
    for (let i = 0; i < moduleState.referenceNavigationStack.length; i += 1) {
        const entry = moduleState.referenceNavigationStack[i];
        if (!entry || typeof entry !== 'object') {
            throw new Error('Reference navigation stack entry must be an object');
        }
        if (typeof entry.fromTabId !== 'string' || entry.fromTabId.length === 0) {
            throw new Error('Reference navigation stack entry missing fromTabId');
        }
        if (typeof entry.toTabId !== 'string' || entry.toTabId.length === 0) {
            throw new Error('Reference navigation stack entry missing toTabId');
        }
        if (!existingTabIds.has(entry.fromTabId) || !existingTabIds.has(entry.toTabId)) {
            continue;
        }
        if (writeIndex !== i) moduleState.referenceNavigationStack[writeIndex] = entry;
        writeIndex += 1;
    }
    if (writeIndex < moduleState.referenceNavigationStack.length) {
        moduleState.referenceNavigationStack.length = writeIndex;
        persistReferenceNavigationStack();
    }
}

function findReferenceNavigationEntryIndexForActiveTab() {
    return findReferenceNavigationEntryIndexForTab(ModeContext.activeTabId);
}


function findReferenceNavigationEntryIndexForTab(tabId) {
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('Reference navigation lookup requires tabId');
    }
    for (let i = moduleState.referenceNavigationStack.length - 1; i >= 0; i -= 1) {
        if (moduleState.referenceNavigationStack[i].toTabId === tabId) {
            return i;
        }
    }
    return NOT_FOUND;
}

export function isViewingReferenceSource() {
    pruneReferenceNavigationStackToExistingTabs();
    return findReferenceNavigationEntryIndexForActiveTab() !== NOT_FOUND;
}


/**
 * Return the temporary view label for a server tab, or an empty string for an
 * ordinary user search. Internal exact-note queries must never become tab labels
 * or search-history entries.
 */
export function getReferenceNavigationLabelForTab(tabId) {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForTab(tabId);
    if (entryIndex === NOT_FOUND) return '';
    return moduleState.referenceNavigationStack[entryIndex].viewKind === 'backlinks'
        ? 'Referenced by' : 'Reference source';
}

export function getActiveReferenceSourceQuery() {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === NOT_FOUND) {
        return '';
    }
    const entry = moduleState.referenceNavigationStack[entryIndex];
    if (typeof entry.referenceQuery !== 'string' || entry.referenceQuery.length === 0) {
        throw new Error('Reference navigation entry missing referenceQuery');
    }
    return entry.referenceQuery;
}

export function getActiveReferenceOriginScope() {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === NOT_FOUND) {
        throw new Error('Active tab is not a reference source');
    }
    return copyOriginScope(moduleState.referenceNavigationStack[entryIndex].originScope);
}

export function captureReferenceOriginScopeForActiveTab() {
    if (isViewingReferenceSource()) {
        return getActiveReferenceOriginScope();
    }
    const scopeTabId = ModeContext.activeTabId;
    if (typeof scopeTabId !== 'string' || scopeTabId.length === 0) {
        throw new Error('Reference origin requires active tab id');
    }
    return copyOriginScope({
        scopeTabId,
        searchQuery: ModeContext.getExecutedSearchQuery(scopeTabId),
        sortMode: ModeContext.getTabSortMode(scopeTabId),
        isUntaggedView: ModeContext.isUntaggedView,
    });
}

export function updateReferenceSourceIndicator() {
    const indicator = document.getElementById('reference-source-indicator');
    if (!(indicator instanceof HTMLElement)) {
        throw new Error('reference-source-indicator element missing');
    }
    indicator.hidden = !isViewingReferenceSource();
    const label = document.getElementById('reference-source-indicator-label');
    if (!(label instanceof HTMLElement)) {
        throw new Error('reference-source-indicator-label element missing');
    }
    const referenceLabel = getReferenceNavigationLabelForTab(ModeContext.activeTabId);
    label.textContent = referenceLabel === '' ? 'Reference source' : referenceLabel;
}

export function pushReferenceNavigationEntry(
    fromTabId,
    toTabId,
    referenceQuery,
    originScope,
    viewKind,
) {
    if (viewKind !== 'source' && viewKind !== 'backlinks') {
        throw new Error('Reference navigation requires source or backlinks viewKind');
    }
    if (typeof fromTabId !== 'string' || fromTabId.length === 0) {
        throw new Error('pushReferenceNavigationEntry requires fromTabId');
    }
    if (typeof toTabId !== 'string' || toTabId.length === 0) {
        throw new Error('pushReferenceNavigationEntry requires toTabId');
    }
    if (typeof referenceQuery !== 'string' || referenceQuery.length === 0) {
        throw new Error('pushReferenceNavigationEntry requires referenceQuery');
    }
    moduleState.referenceNavigationStack.push({
        fromTabId,
        toTabId,
        referenceQuery,
        originScope: copyOriginScope(originScope),
        viewKind,
    });
    persistReferenceNavigationStack();
    updateReferenceSourceIndicator();
}

export function replaceActiveReferenceNavigationQuery(referenceQuery, viewKind) {
    if (viewKind !== 'source' && viewKind !== 'backlinks') {
        throw new Error('Reference navigation requires source or backlinks viewKind');
    }
    if (typeof referenceQuery !== 'string' || referenceQuery.length === 0) {
        throw new Error('replaceActiveReferenceNavigationQuery requires referenceQuery');
    }
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === NOT_FOUND) {
        throw new Error('Cannot replace reference query outside reference source mode');
    }
    const entry = moduleState.referenceNavigationStack[entryIndex];
    moduleState.referenceNavigationStack[entryIndex] = {
        ...entry,
        referenceQuery,
        viewKind,
    };
    persistReferenceNavigationStack();
    updateReferenceSourceIndicator();
}

export function popReferenceNavigationEntryForActiveTab() {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === NOT_FOUND) {
        updateReferenceSourceIndicator();
        return null;
    }
    const [entry] = moduleState.referenceNavigationStack.splice(entryIndex, 1);
    if (!entry || typeof entry !== 'object') {
        throw new Error('Reference navigation stack entry must be an object');
    }
    persistReferenceNavigationStack();
    updateReferenceSourceIndicator();
    return entry;
}

export function dismissReferenceSourceModeForActiveTab() {
    return popReferenceNavigationEntryForActiveTab() !== null;
}
