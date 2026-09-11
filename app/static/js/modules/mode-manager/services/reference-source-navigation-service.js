import { ModeContextInstance as ModeContext } from '../mode-context.js';

const referenceNavigationStack = [];

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

function pruneReferenceNavigationStackToExistingTabs() {
    const tabOrder = ModeContext.tabOrder;
    if (!Array.isArray(tabOrder)) {
        throw new Error('ModeContext.tabOrder must be an array');
    }
    const existingTabIds = new Set(tabOrder);
    let writeIndex = 0;
    for (let i = 0; i < referenceNavigationStack.length; i += 1) {
        const entry = referenceNavigationStack[i];
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
        referenceNavigationStack[writeIndex] = entry;
        writeIndex += 1;
    }
    referenceNavigationStack.length = writeIndex;
}

function findReferenceNavigationEntryIndexForActiveTab() {
    const activeTabId = ModeContext.activeTabId;
    for (let i = referenceNavigationStack.length - 1; i >= 0; i -= 1) {
        if (referenceNavigationStack[i].toTabId === activeTabId) {
            return i;
        }
    }
    return -1;
}

export function isViewingReferenceSource() {
    pruneReferenceNavigationStackToExistingTabs();
    return findReferenceNavigationEntryIndexForActiveTab() !== -1;
}

export function getActiveReferenceSourceQuery() {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === -1) {
        return '';
    }
    const entry = referenceNavigationStack[entryIndex];
    if (typeof entry.referenceQuery !== 'string' || entry.referenceQuery.length === 0) {
        throw new Error('Reference navigation entry missing referenceQuery');
    }
    return entry.referenceQuery;
}

export function getActiveReferenceOriginScope() {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === -1) {
        throw new Error('Active tab is not a reference source');
    }
    return copyOriginScope(referenceNavigationStack[entryIndex].originScope);
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
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    label.textContent = entryIndex !== -1 && referenceNavigationStack[entryIndex].viewKind === 'backlinks'
        ? 'Referenced by' : 'Reference source';
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
    referenceNavigationStack.push({
        fromTabId,
        toTabId,
        referenceQuery,
        originScope: copyOriginScope(originScope),
        viewKind,
    });
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
    if (entryIndex === -1) {
        throw new Error('Cannot replace reference query outside reference source mode');
    }
    const entry = referenceNavigationStack[entryIndex];
    referenceNavigationStack[entryIndex] = {
        ...entry,
        referenceQuery,
        viewKind,
    };
    updateReferenceSourceIndicator();
}

export function popReferenceNavigationEntryForActiveTab() {
    pruneReferenceNavigationStackToExistingTabs();
    const entryIndex = findReferenceNavigationEntryIndexForActiveTab();
    if (entryIndex === -1) {
        updateReferenceSourceIndicator();
        return null;
    }
    const [entry] = referenceNavigationStack.splice(entryIndex, 1);
    if (!entry || typeof entry !== 'object') {
        throw new Error('Reference navigation stack entry must be an object');
    }
    updateReferenceSourceIndicator();
    return entry;
}

export function dismissReferenceSourceModeForActiveTab() {
    return popReferenceNavigationEntryForActiveTab() !== null;
}
