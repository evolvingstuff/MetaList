import {
    ROOT_SORT_MODES,
    getRootSortModeChipLabel,
    getRootSortModeIndicatorLabel,
    normalizeRootSortMode,
} from './root-sort-service.js';
import { showSearchInputChip } from './search-input-chip-service.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { setTabSortModeOnServer } from './tab-state-service.js';

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
