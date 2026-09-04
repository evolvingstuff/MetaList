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
import { clearActiveSortModeForSearchInput } from '../services/root-sort-indicator-service.js';
import {
    dismissReferenceSourceModeForActiveTab,
    isViewingReferenceSource,
} from '../services/reference-source-navigation-service.js';

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
    let viewOverridesClearPromise = null;
    if (isFreshSearchInput) {
        if (previousSearchQuery !== analysis.normalizedText) {
            ModeContext.setSearchQuery(analysis.normalizedText);
        }
        if (wasUntaggedView) {
            ModeContext.setUntaggedView(false);
        }
        const hasPersistedViewOverride = ModeContext.activeTabSortMode !== 'normal';
        if (hasPersistedViewOverride) {
            const intendedSearchQuery = analysis.normalizedText;
            viewOverridesClearPromise = (async () => {
                await clearActiveSortModeForSearchInput();
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
            if (waitedMs > 5000) {
                throw new Error('Search execution delayed >5s waiting for CommandGate');
            }
            scheduleDebouncedSearchExecution(50, executeSearchWhenIdle);
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
                ModeContext.updateActiveTabScrollAnchor(null, true);
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

export async function initializeSearchEvents() {
    const startedAt = performance.now();
    const searchInput = document.getElementById('search-input');

    if (!searchInput || typeof searchInput.addEventListener !== 'function') {
        throw new Error('Search input element not found');
    }

    // Add input event listener
    searchInput.addEventListener('input', handleSearchInput);
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

    // Always sync the input field to the active tab query.
    const analysis = syncSearchInputValue(searchInput, activeTabQuery);
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
