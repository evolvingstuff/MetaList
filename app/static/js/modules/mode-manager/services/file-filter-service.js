import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { showSearchInputChip } from './search-input-chip-service.js';
import { FILE_FILTER_KINDS } from './file-filter-kinds.js';

export { FILE_FILTER_CHOICES, FILE_FILTER_KINDS } from './file-filter-kinds.js';

// Files filter (app/services/file_kinds.py): a tab shows only the notes with an
// attached file, or one of a kind, with the notes above them. The server keeps each
// tab's filter with the tab state (fileFilters) and filters the view; this keeps
// the filters it last sent, for the menus and the chip in the search input.

const CHIP_LABELS = Object.freeze({
    [FILE_FILTER_KINDS.ANY]: 'With files',
    [FILE_FILTER_KINDS.IMAGE]: 'With images',
    [FILE_FILTER_KINDS.PDF]: 'With PDFs',
    [FILE_FILTER_KINDS.MARKDOWN]: 'With Markdown files',
});
const CHIP_TOOLTIPS = Object.freeze({
    [FILE_FILTER_KINDS.ANY]: 'Notes with an attached file',
    [FILE_FILTER_KINDS.IMAGE]: 'Notes with an image',
    [FILE_FILTER_KINDS.PDF]: 'Notes with a PDF',
    [FILE_FILTER_KINDS.MARKDOWN]: 'Notes with a Markdown file',
});

const moduleState = ApplicationState.createFields('file-filter-service', {
    // Each tab's filter kind as the server last sent it, by tab id; a tab without one shows every note.
    filtersByTabId: Object.freeze({}),
});

function requireKind(kind) {
    if (!Object.hasOwn(CHIP_LABELS, kind)) {
        throw new Error(`Unknown Files filter: ${kind}`);
    }
    return kind;
}

/** Take the filters from a tab-state response (every one carries fileFilters). */
export function recordFileFiltersFromServer(serverState) {
    if (!serverState || typeof serverState !== 'object') {
        throw new Error('recordFileFiltersFromServer requires the server tab state');
    }
    const filters = serverState.fileFilters;
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
        throw new Error('Tab state response missing fileFilters');
    }
    const next = {};
    for (const [tabId, kind] of Object.entries(filters)) {
        next[tabId] = requireKind(kind);
    }
    if (JSON.stringify(next) !== JSON.stringify(moduleState.filtersByTabId)) {
        moduleState.filtersByTabId = Object.freeze(next);
    }
}

/** The active tab's filter kind, or none when it shows every note. */
export function getActiveFileFilterKind() {
    const tabId = ModeContext.activeTabId;
    if (typeof tabId !== 'string' || tabId.length === 0) {
        throw new Error('getActiveFileFilterKind requires an active tab');
    }
    if (!Object.hasOwn(moduleState.filtersByTabId, tabId)) {
        return FILE_FILTER_KINDS.NONE;
    }
    return moduleState.filtersByTabId[tabId];
}

/** The chip inside the search input: shown while the active tab has a Files filter. */
export function updateFileFilterIndicator() {
    const indicator = document.getElementById('file-filter-indicator');
    if (!(indicator instanceof HTMLElement)) {
        throw new Error('file-filter-indicator element missing');
    }
    const label = document.getElementById('file-filter-indicator-label');
    if (!(label instanceof HTMLElement)) {
        throw new Error('file-filter-indicator-label element missing');
    }
    const kind = getActiveFileFilterKind();
    if (kind === FILE_FILTER_KINDS.NONE) {
        // The label stays while the chip shrinks out.
        showSearchInputChip(indicator, { isShown: false });
        return;
    }
    label.textContent = CHIP_LABELS[kind];
    label.title = CHIP_TOOLTIPS[kind];
    showSearchInputChip(indicator, { isShown: true });
}
