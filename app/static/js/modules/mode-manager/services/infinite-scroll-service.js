import { ApplicationState, stateValuesEqual } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { CommandGate } from './command-gate-service.js';

const POLL_INTERVAL_MS = 800;

const moduleState = ApplicationState.createFields('infinite-scroll-service', {
    tabPollState: {},

    pollTimer: null,
});


const ROOT_PARENT_SENTINELS = new Set(['', 'null', 'undefined', 'none']);

export function selectInfiniteScrollRootTotal(viewContext) {
    if (!viewContext || typeof viewContext !== 'object') {
        throw new Error('selectInfiniteScrollRootTotal requires view context');
    }
    const {
        searchQuery,
        isUntaggedView,
        rootCountTotal,
        searchRootCountTotal,
    } = viewContext;
    if (typeof searchQuery !== 'string') {
        throw new Error('searchQuery must be a string');
    }
    if (typeof isUntaggedView !== 'boolean') {
        throw new Error('isUntaggedView must be a boolean');
    }
    if (!Number.isInteger(rootCountTotal) || rootCountTotal < 0) {
        throw new Error('rootCountTotal must be a non-negative integer');
    }
    if (!Number.isInteger(searchRootCountTotal) || searchRootCountTotal < 0) {
        throw new Error('searchRootCountTotal must be a non-negative integer');
    }
    let isFilteredView = searchQuery.trim().length > 0;
    if (isUntaggedView) {
        isFilteredView = true;
    }
    return isFilteredView ? searchRootCountTotal : rootCountTotal;
}

function getActiveTabState() {
    let tabId = ModeContext.activeTabId;
    if (!tabId) {
        tabId = '0';
    }
    const searchKey = ModeContext.searchQuery;
    const key = `${tabId}::${searchKey}`;
    if (!moduleState.tabPollState[key]) {
        moduleState.tabPollState[key] = {
            pendingFetch: false,
            lastFetchTime: 0,
        };
    }
    return moduleState.tabPollState[key];
}

export function startInfiniteScrollMonitor() {
    if (moduleState.pollTimer) {
        return;
    }
    moduleState.pollTimer = setInterval(handlePoll, POLL_INTERVAL_MS);
    Logger.logInit('Infinite scroll poller started');
}

export function stopInfiniteScrollMonitor() {
    if (moduleState.pollTimer) {
        clearInterval(moduleState.pollTimer);
        moduleState.pollTimer = null;
        Logger.logDebug('Infinite scroll poller stopped');
    }
}

// A reset starts a fresh polling episode; unchanged cache observations are not
// setter requests. Replace only the changed per-context snapshot.
function receivePollReset(resetFetchTime) {
    const current = getActiveTabState();
    const next = { ...current, pendingFetch: false };
    if (resetFetchTime) next.lastFetchTime = 0;
    if (!stateValuesEqual(current, next)) {
        const key = `${ModeContext.activeTabId}::${ModeContext.searchQuery}`;
        moduleState.tabPollState[key] = next;
    }
}

export function resetInfiniteScrollState() {
    receivePollReset(true);
}

export function handleTabSwitch() {
    receivePollReset(false);
}

function collectRootVisibility() {
    // Root notes are direct children of the container; scanning every nested
    // note each tick only to discard children made the poll scale with the
    // whole rendered tree. The parent-id check below still guards roots.
    const rootElements = document.querySelectorAll('#notes-container > .note');
    const viewportHeight = window.innerHeight;
    const visible = [];
    const past = [];

    for (const element of rootElements) {
        const noteId = element.dataset.noteId;
        if (!noteId) continue;

        const rawParent = element.getAttribute('data-parent-id');
        const normalized = (typeof rawParent === 'string' ? rawParent : '').trim().toLowerCase();
        const isRoot = ROOT_PARENT_SENTINELS.has(normalized);
        if (!isRoot) continue;

        const rect = element.getBoundingClientRect();
        if (rect.bottom < 0) {
            past.push(noteId);
        } else if (rect.top <= viewportHeight) {
            visible.push(noteId);
        }
    }

    return { visible, past };
}

async function handlePoll() {
    if (document.hidden) return;
    if (CommandGate.isBusy()) return;
    if (ModeContext.isLoading) return;

    const searchQuery = ModeContext.searchQuery;
    const executedSearchQuery = ModeContext.getExecutedSearchQuery();
    if (searchQuery !== executedSearchQuery) {
        // Search context has changed but hasn't been executed yet.
        return;
    }

    const state = getActiveTabState();
    const { visible, past } = collectRootVisibility();
    if (visible.length > 0) {
        ModeContext.setVisibleRootRange(visible[0], visible[visible.length - 1]);
    }
    ModeContext.markRootsAsSeen([...visible, ...past]);
    if (ModeContext.knownRootCount === 0 || visible.length === 0) return;

    // The loaded roots are a band around the viewport. Ask the server to move
    // a band edge once the viewport is within the refetch distance of it and
    // more roots exist beyond that edge.
    const totalRoots = currentTotalRoots();
    // Strictly closer than the server's keep distance, so every request moves an edge.
    const distance = ModeContext.getRootBandRefetchDistance() - 1;
    const needsRootsBelow = ModeContext.isAnchorNearEnd(visible[visible.length - 1], distance)
        && ModeContext.hasRootsBelowWindow(totalRoots);
    const needsRootsAbove = ModeContext.isAnchorNearStart(visible[0], distance)
        && ModeContext.hasRootsAboveWindow();
    if (needsRootsBelow || needsRootsAbove) {
        await maybeMoveBand(state, { needsRootsAbove, needsRootsBelow });
    }
}

function currentTotalRoots() {
    return selectInfiniteScrollRootTotal({
        searchQuery: ModeContext.searchQuery,
        isUntaggedView: ModeContext.isUntaggedView,
        rootCountTotal: ModeContext.rootCountTotal,
        searchRootCountTotal: ModeContext.searchRootCountTotal,
    });
}

// Roots of this view exist after the loaded band.
export function hasRootsBelowLoadedWindow() {
    return ModeContext.hasRootsBelowWindow(currentTotalRoots());
}

async function maybeMoveBand(state, { needsRootsAbove, needsRootsBelow }) {
    if (state.pendingFetch) return;

    const now = Date.now();
    if (now - state.lastFetchTime < POLL_INTERVAL_MS) return;

    state.pendingFetch = true;
    state.lastFetchTime = now;

    const startedAt = performance.now();
    const tabOrder = ModeContext.tabOrder;
    if (!Array.isArray(tabOrder) || tabOrder.length === 0) {
        throw new Error('ModeContext.tabOrder must be a non-empty array');
    }
    const activeIndex = tabOrder.indexOf(ModeContext.activeTabId);
    if (activeIndex === -1) {
        throw new Error(`activeTabId not present in ModeContext.tabOrder: ${ModeContext.activeTabId}`);
    }
    const context = `infiniteScroll tab#${activeIndex + 1}`;
    const startBefore = ModeContext.getRootWindowStart();
    const endBefore = startBefore + ModeContext.knownRootCount;

    const { actionRefreshAndMaybeSelect } = await import('../actions/ui-actions.js');
    // Band shifts add and drop roots at the edges; animating those removals
    // would shrink content above the viewport over several frames.
    await actionRefreshAndMaybeSelect({ startedAt, context, animateNoteChanges: false });
    const startAfter = ModeContext.getRootWindowStart();
    const endAfter = startAfter + ModeContext.knownRootCount;
    if (needsRootsAbove && !(startAfter < startBefore) && ModeContext.hasRootsAboveWindow()) {
        throw new Error('Infinite scroll blocked: near the band start but the server loaded no roots above');
    }
    if (needsRootsBelow && !(endAfter > endBefore) && ModeContext.hasRootsBelowWindow(currentTotalRoots())) {
        throw new Error('Infinite scroll blocked: near the band end but the server loaded no roots below');
    }
    state.pendingFetch = false;
}
