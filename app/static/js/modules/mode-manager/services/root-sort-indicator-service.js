import {
    ROOT_SORT_MODES,
    getRootSortModeChipLabel,
    getRootSortModeIndicatorLabel,
    normalizeRootSortMode,
} from './root-sort-service.js';
import { showSearchInputChip } from './search-input-chip-service.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { setTabDateFilterOnServer, setTabSortModeOnServer } from './tab-state-service.js';
import { DATE_RANGE_KINDS, OPEN_DATE, getActiveDateFilter, getTabDateFilter } from './date-range-filter-service.js';

// A date range filter ends as a sort order does: rangeKind 'none' shows every date.
function noDateFilter(field) {
    return { field, rangeKind: DATE_RANGE_KINDS.NONE, fromDate: OPEN_DATE, toDate: OPEN_DATE };
}

export function updateRootSortIndicator(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
        throw new Error('updateRootSortIndicator requires snapshot object');
    }

    const indicator = document.getElementById('root-sort-indicator');
    if (!(indicator instanceof HTMLElement)) {
        throw new Error('root-sort-indicator element missing');
    }
    const label = document.getElementById('root-sort-indicator-label');
    if (!(label instanceof HTMLElement)) {
        throw new Error('root-sort-indicator-label element missing');
    }

    const sortMode = normalizeRootSortMode(snapshot.sortMode);
    indicator.dataset.sortMode = sortMode;
    if (sortMode === ROOT_SORT_MODES.NORMAL) {
        // The label stays while the chip shrinks out.
        showSearchInputChip(indicator, { isShown: false });
        return;
    }

    label.textContent = getRootSortModeChipLabel(sortMode);
    label.title = getRootSortModeIndicatorLabel(sortMode);
    showSearchInputChip(indicator, { isShown: true });
}

export async function clearActiveSortModeForSearchInput() {
    if (ModeContext.activeTabSortMode === ROOT_SORT_MODES.NORMAL) {
        return;
    }
    const activeTabId = ModeContext.activeTabId;
    if (typeof activeTabId !== 'string' || activeTabId.length === 0) {
        throw new Error('ModeContext.activeTabId must be a non-empty string');
    }
    ModeContext.bumpUndoContextEpoch('sortMode.searchInput');
    const response = await setTabSortModeOnServer(activeTabId, ROOT_SORT_MODES.NORMAL);
    ModeContext.hydrateTabState(response, { emitUpdate: false });
    ModeContext.clearTabRevealedRedactions(activeTabId);
    ModeContext.resetTabDiffCache(activeTabId, { preserveRootAnchor: false });
}

/** A new search ends the active tab's date range, as it ends its sort order. */
export async function clearActiveDateFilterForSearchInput() {
    const filter = getActiveDateFilter();
    if (filter === null) {
        return;
    }
    const activeTabId = ModeContext.activeTabId;
    ModeContext.bumpUndoContextEpoch('dateFilter.searchInput');
    const response = await setTabDateFilterOnServer(activeTabId, noDateFilter(filter.field));
    ModeContext.hydrateTabState(response, { emitUpdate: false });
    ModeContext.clearTabRevealedRedactions(activeTabId);
    ModeContext.resetTabDiffCache(activeTabId, { preserveRootAnchor: false });
}

/** The date range of a tab the user left; the answer is the server's tab state, or null with none to end. */
export async function endDateFilterOfLeftTab(tabId) {
    const filter = getTabDateFilter(tabId);
    if (filter === null) {
        return null;
    }
    ModeContext.bumpUndoContextEpoch('dateFilter.tabLeft');
    return await setTabDateFilterOnServer(tabId, noDateFilter(filter.field));
}
