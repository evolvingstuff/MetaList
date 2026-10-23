import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { CONFIG } from '../../config.js';
import { actionRefreshAndMaybeSelect } from '../actions/ui-actions.js';
import { updateSearchContextsList } from './keyboard-events.js';
import { initializeTabStateService } from '../services/tab-state-service.js';
import { analyzeSearchQueryInput } from '../services/search-syntax-service.js';
import { enforceSearchInputElement, setSearchValidationState, syncSearchInputValue } from '../services/search-input-service.js';
import { CommandGate } from '../services/command-gate-service.js';
import { scheduleDebouncedSearchExecution } from '../services/search-debounce-service.js';
import { primeActiveSearchInteractionState } from '../services/search-interaction-service.js';
import { initializeSearchSuggestions, updateSearchSuggestions } from '../services/search-suggestions-service.js';
import { clearActiveNotesDom, clearCachedNotesDomForTab } from '../services/tab-dom-cache-service.js';
import { clearActiveDateFilterForSearchInput, clearActiveSortModeForSearchInput } from '../services/root-sort-indicator-service.js';
import { getActiveDateFilter } from '../services/date-range-filter-service.js';
import {
    dismissReferenceSourceModeForActiveTab,
    isShowingNewSearchInReferenceView,
    isViewingReferenceSource,
    restoreReferenceChipAfterEmptySearch,
} from '../services/reference-source-navigation-service.js';
import { handleDictationPasteEvent, isDictationRawInsertInProgress } from '../services/dictation-paste-service.js';
import { MS_PER_SECOND } from '../../time-units.js';

// A search waits for a busy CommandGate, rechecking this often, and fails loudly
// if the gate stays busy past the limit.
const SEARCH_COMMAND_GATE_RECHECK_MS = 50;
const SEARCH_COMMAND_GATE_MAX_WAIT_SECONDS = 5;

export function resetActiveTabForSearchExecution(searchQuery, options) {
    if (typeof searchQuery !== 'string') {
        throw new Error('resetActiveTabForSearchExecution requires searchQuery string');
    }
    if (options === null || typeof options !== 'object') {
        throw new Error('resetActiveTabForSearchExecution requires options object');
    }
    const isFreshSearchInput = options.isFreshSearchInput === true;
    ModeContext.clearActiveTabDiffCacheForSearchExecution(searchQuery, {
        forceClear: isFreshSearchInput,
    });
    if (isFreshSearchInput) {
        clearActiveNotesDom();
        clearCachedNotesDomForTab(ModeContext.activeTabId);
    }
}

export function handleSearchInput(event) {
    // A dictated paste is inserted as is, then replaced by its cleaned text;
    // only the cleaned text is enforced and searched.
    if (isDictationRawInsertInProgress()) {
        return;
    }
    if (ModeContext.isLoading) {
        let currentValue = '';
        if (event && event.target && typeof event.target.value === 'string') {
            currentValue = event.target.value;
        }

        Logger.logDebug('Search input changed while request in-flight; scheduling follow-up execution', {
            value: currentValue,
            activeTab: ModeContext.activeTabId,
        }, Logger.LogCategory.EVENT);
    }

    const searchInput = event.target;
    if (!searchInput || typeof searchInput.value !== 'string') {
        throw new Error('Search input handler requires event.target input element');
    }

    if (isViewingReferenceSource()) {
        dismissReferenceSourceModeForActiveTab();
    }

    const enforcedValue = enforceSearchInputElement(searchInput);
    const analysis = analyzeSearchQueryInput(enforcedValue);
    setSearchValidationState(searchInput, analysis);
    updateSearchSuggestions(searchInput, { source: 'input' });

    Logger.logDebug('Search input changed', {
        searchQuery: analysis.normalizedText,
        length: analysis.normalizedText.length,
        isComplete: analysis.isComplete,
    }, Logger.LogCategory.EVENT);

    const previousSearchQuery = ModeContext.searchQuery;
    const wasUntaggedView = ModeContext.isUntaggedView;
    let isFreshSearchInput = previousSearchQuery !== analysis.normalizedText;
    if (wasUntaggedView) {
        isFreshSearchInput = true;
    }

    // Browser input events can re-fire with the same normalized value during autofill/composition.
    // A new search ends the sort order, the date range and the Untagged view: their chips leave.
    let viewOverridesClearPromise = null;
    if (isFreshSearchInput) {
        if (previousSearchQuery !== analysis.normalizedText) {
            ModeContext.setSearchQuery(analysis.normalizedText);
        }
        if (wasUntaggedView) {
            ModeContext.setUntaggedView(false);
        }
        const isSorted = ModeContext.activeTabSortMode !== 'normal';
        const hasDateRange = getActiveDateFilter() !== null;
        if (isSorted || hasDateRange) {
            const intendedSearchQuery = analysis.normalizedText;
            viewOverridesClearPromise = (async () => {
                await clearActiveSortModeForSearchInput();
                await clearActiveDateFilterForSearchInput();
                if (ModeContext.searchQuery !== intendedSearchQuery) {
                    ModeContext.setSearchQuery(intendedSearchQuery);
                }
            })();
        }
    }

    // Update search contexts list display
    updateSearchContextsList();

    const searchRequestedAt = performance.now();

    const executeSearchWhenIdle = () => {
        const waitedMs = performance.now() - searchRequestedAt;
        if (CommandGate.isBusy()) {
            if (waitedMs > SEARCH_COMMAND_GATE_MAX_WAIT_SECONDS * MS_PER_SECOND) {
                throw new Error(`Search execution delayed >${SEARCH_COMMAND_GATE_MAX_WAIT_SECONDS}s waiting for CommandGate`);
            }
            scheduleDebouncedSearchExecution(SEARCH_COMMAND_GATE_RECHECK_MS, executeSearchWhenIdle);
            return;
        }

        const currentSearch = ModeContext.searchQuery;
        const currentAnalysis = analyzeSearchQueryInput(currentSearch);

        if (!currentAnalysis.isComplete) {
            Logger.logNoop('Search execution skipped: incomplete query', {
                searchQuery: currentSearch,
                warningMessage: currentAnalysis.warningMessage,
            });
            return;
        }

        void CommandGate.run('search.execute', async () => {
            Logger.logAction('executeSearch', { searchQuery: currentSearch });
            if (viewOverridesClearPromise !== null) {
                await viewOverridesClearPromise;
            }
            resetActiveTabForSearchExecution(currentSearch, { isFreshSearchInput });
            ModeContext.resetRootTracking({ clear: true });
            window.scrollTo(0, 0);
            // A fresh search can start while the tab is already at the top.
            if (ModeContext.getTabScrollPosition(ModeContext.activeTabId) !== 0) {
                ModeContext.updateActiveTabScroll(0);
            }
            // updateActiveTabScroll clears the scroll anchor; repeated top searches leave it null.
            if (ModeContext.getTabScrollAnchor(ModeContext.activeTabId) !== null) {
                ModeContext.updateActiveTabScrollAnchor(null);
            }
            // resetRootTracking clears the root anchor before the new search renders.
            if (ModeContext.getRootAnchorId() !== null) {
                ModeContext.setRootAnchorId(null);
            }
            // Refresh the view with the search query (let errors crash)
            await actionRefreshAndMaybeSelect({ context: 'search' });
            primeActiveSearchInteractionState();
        });
    };

    scheduleDebouncedSearchExecution(CONFIG.SEARCH.DEBOUNCE_MS, executeSearchWhenIdle);
}

// The magnifier brought the empty input out over a reference view; leaving it
// without typing brings the chip back.
function handleSearchInputBlur(event) {
    if (!isShowingNewSearchInReferenceView()) {
        return;
    }
    if (event.target.value !== '') {
        return;
    }
    restoreReferenceChipAfterEmptySearch();
}

export async function initializeSearchEvents() {
    const startedAt = performance.now();
    const searchInput = document.getElementById('search-input');

    if (!searchInput || typeof searchInput.addEventListener !== 'function') {
        throw new Error('Search input element not found');
    }

    // Add input event listener
    searchInput.addEventListener('input', handleSearchInput);
    searchInput.addEventListener('paste', (event) => handleDictationPasteEvent(event, 'search'));
    searchInput.addEventListener('blur', handleSearchInputBlur);
    initializeSearchSuggestions();

    await initializeTabStateService();

    const activeTabQuery = ModeContext.searchQuery;
    if (typeof activeTabQuery !== 'string') {
        throw new Error('ModeContext.searchQuery must be a string');
    }

    // Update tab indicator on page load
    const tabIndicator = document.getElementById('tab-indicator');
    if (tabIndicator) {
        tabIndicator.textContent = ModeContext.activeTabId;
    }

    // Initialize search contexts list
    updateSearchContextsList();

    // Always sync the input field to the active tab query, except a reference view's
    // hidden note-ID search, which runs the view but never shows in the input.
    let analysis = null;
    if (isViewingReferenceSource()) {
        syncSearchInputValue(searchInput, '');
        analysis = analyzeSearchQueryInput(activeTabQuery);
    } else {
        analysis = syncSearchInputValue(searchInput, activeTabQuery);
    }
    // Tab-state hydration already seeds ModeContext.searchQuery for the active tab.
    if (ModeContext.searchQuery !== analysis.normalizedText) {
        ModeContext.setSearchQuery(analysis.normalizedText);
    }

    const initialQueryLogValue = analysis.normalizedText.length > 0 ? analysis.normalizedText : 'none';
    Logger.logAction('initialPageLoad', { searchQuery: initialQueryLogValue });

    const initialExecutableQuery = analysis.isComplete ? analysis.normalizedText : analysis.sanitizedText;
    // The default executed query is empty, so initial empty searches do not need a setter call.
    if (ModeContext.getExecutedSearchQuery() !== initialExecutableQuery) {
        ModeContext.setExecutedSearchQuery(initialExecutableQuery);
    }
    const initResult = await CommandGate.run('search.init_view', async () => {
        await actionRefreshAndMaybeSelect({ startedAt: startedAt, context: 'init search' });
        ModeContext.restoreScrollForActiveTab();
    });
    if (initResult === null) {
        throw new Error('Initialization should not be blocked by CommandGate');
    }

    Logger.logDebug('Search events initialized', {
        activeTab: ModeContext.activeTabId,
        restoredQuery: analysis.normalizedText,
    }, Logger.LogCategory.INIT);
}
