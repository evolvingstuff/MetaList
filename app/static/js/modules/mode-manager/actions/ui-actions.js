import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { NotesAPI } from '../../api-client.js';
import { DOMUtils } from '../../dom-utils.js';
import { CONFIG } from '../../config.js';
import { applyDifferentialView } from '../services/differential-view-service.js';
import { clearTagBar, syncTagBar } from '../services/tag-bar-service.js';
import { initializeEditSessionCollapseStateFromNoteElement } from '../services/edit-session-collapse-service.js';
import { clearEditingStateForHiddenFilteredNote } from '../services/filtered-refresh-selection-service.js';
import { attachEditorSurface, detachEditorSurface } from '../../editor-toolbar.js';
import { rebuildRootDateSeparators } from '../services/root-date-separator-service.js';
import { updateRootSortIndicator } from '../services/root-sort-indicator-service.js';
import { updateUntaggedViewIndicator } from '../services/untagged-view-indicator-service.js';
import { hasRootsBelowLoadedWindow, resetInfiniteScrollState } from '../services/infinite-scroll-service.js';
import {
    captureEditingFocus, captureViewportRoot, holdViewportRoot, placeCaretAtClickAnchor, restoreEditingFocus,
} from '../services/viewport-hold-service.js';
import { MS_PER_SECOND } from '../../time-units.js';
import { setSearchHighlightPhrases } from '../services/search-highlight-service.js';

const PERF_LOG_MS_DECIMALS = 2;
// waitForViewRequestIdle fails loudly once a notes.view request has blocked this long.
const VIEW_REQUEST_IDLE_TIMEOUT_SECONDS = 5;
const VIEW_REQUEST_IDLE_TIMEOUT_MS = VIEW_REQUEST_IDLE_TIMEOUT_SECONDS * MS_PER_SECOND;
const VIEW_REQUEST_IDLE_POLL_MS = 25;

const moduleState = ApplicationState.createFields('ui-actions', {
    viewRequestInFlight: false,
});


function updateSearchResultsCount(snapshot, tabId) {
    if (!snapshot || typeof snapshot !== 'object') {
        throw new Error('updateSearchResultsCount requires snapshot object');
    }

    const el = document.getElementById('search-results-count');
    if (!el) {
        throw new Error('search-results-count element missing from DOM');
    }

    const rootCountTotal = snapshot.rootCountTotal;
    if (!Number.isInteger(rootCountTotal) || rootCountTotal < 0) {
        throw new Error('snapshot.rootCountTotal must be a non-negative integer');
    }

    const searchRootCountTotal = snapshot.searchRootCountTotal;
    if (!Number.isInteger(searchRootCountTotal) || searchRootCountTotal < 0) {
        throw new Error('snapshot.searchRootCountTotal must be a non-negative integer');
    }

    const searchQuery = snapshot.searchQuery;
    if (searchQuery === null) {
        throw new Error('snapshot.searchQuery must be a string (empty when not searching)');
    }
    if (typeof searchQuery !== 'string') {
        throw new Error('snapshot.searchQuery must be a string');
    }

    const hasUntaggedView = snapshot.isUntaggedView === true;
    const isSearching = searchQuery.trim().length > 0;
    const total = isSearching || hasUntaggedView ? searchRootCountTotal : rootCountTotal;
    el.textContent = total.toLocaleString('en-US');
}

// Resolves once no notes.view request is in flight, i.e. its response has been
// applied. Anything that changes the active tab must await this first.
export async function waitForViewRequestIdle() {
    const waitStartedAt = performance.now();
    while (moduleState.viewRequestInFlight) {
        const waitedMs = performance.now() - waitStartedAt;
        if (waitedMs > VIEW_REQUEST_IDLE_TIMEOUT_MS) {
            throw new Error(`notes.view blocked >${VIEW_REQUEST_IDLE_TIMEOUT_SECONDS}s waiting for in-flight request`);
        }
        await new Promise((resolve) => {
            window.setTimeout(resolve, VIEW_REQUEST_IDLE_POLL_MS);
        });
    }
}

export async function actionRefreshAndMaybeSelect(options) {
    if (options === null || typeof options !== 'object') {
        throw new Error('actionRefreshAndMaybeSelect requires options object');
    }
    Logger.logAction('refresh_and_maybe_select', { 
        noteId: ModeContext.currentNoteId,
        isEditing: ModeContext.isEditing
    });

    let noteId = null;
    if (ModeContext.isEditing) {
        noteId = ModeContext.currentNoteId;
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('Invariant violation: ModeContext.isEditing is true but currentNoteId is missing');
        }
    }
    const requestTabId = ModeContext.activeTabId;
    const requestSearchQuery = ModeContext.getExecutedSearchQuery(requestTabId);
    if (typeof requestSearchQuery !== 'string') {
        throw new Error('ModeContext.getExecutedSearchQuery() must return a string');
    }
    const requireExecution = options.requireExecution === true;
    const resetViewCacheBeforeFetch = options.resetViewCacheBeforeFetch === true;
    const scrollToTopAfterRender = options.scrollToTopAfterRender === true;
    const startAtListEnd = options.startAtListEnd === true;
    if (startAtListEnd && (scrollToTopAfterRender || options.startAtListTop === true)) {
        throw new Error('actionRefreshAndMaybeSelect cannot start at both ends of the list');
    }
    // A caller that knows which note the user is looking at (e.g. the note
    // just left in edit mode) holds that note instead of the top visible root.
    let viewportHold = null;
    if (Object.prototype.hasOwnProperty.call(options, 'viewportHold')) {
        viewportHold = options.viewportHold;
        if (viewportHold === null || typeof viewportHold !== 'object') {
            throw new Error('actionRefreshAndMaybeSelect viewportHold must be a viewport hold reference');
        }
        if (scrollToTopAfterRender || startAtListEnd) {
            throw new Error('actionRefreshAndMaybeSelect cannot both hold a note and jump to an end of the list');
        }
    }
    // A click that entered edit mode: the caret goes where the user clicked.
    let clickAnchor = null;
    if (Object.prototype.hasOwnProperty.call(options, 'clickAnchor')) {
        clickAnchor = options.clickAnchor;
        if (clickAnchor === null || typeof clickAnchor !== 'object' || clickAnchor !== viewportHold) {
            throw new Error('actionRefreshAndMaybeSelect clickAnchor must also be the viewportHold');
        }
    }
    const animateNoteChanges = options.animateNoteChanges !== false;
    // The edited note's focus and caret (its text's or its tag bar's) stay where
    // they are, instead of the caret going to the note's start or end.
    const keepEditingFocus = options.keepEditingFocus === true;
    // What asked for this view, for logs: the caller's name for it, or a refresh.
    let requestContext = 'refresh';
    if (options.context !== undefined) {
        if (typeof options.context !== 'string' || options.context === '') {
            throw new Error('A view request context must be a non-empty string');
        }
        requestContext = options.context;
    }

    if (moduleState.viewRequestInFlight) {
        if (!requireExecution) {
            Logger.logNoop('notes.view ignored while view request in-flight', {
                activeTabId: ModeContext.activeTabId,
                context: requestContext,
            });
            return null;
        }

        await waitForViewRequestIdle();
    }

    if (resetViewCacheBeforeFetch) {
        ModeContext.resetTabDiffCache(requestTabId, { preserveRootAnchor: false });
        resetInfiniteScrollState();
    }

    moduleState.viewRequestInFlight = true;
    return await (async () => {
        const requestStartedAt = performance.now();
        const visibleRootRange = resolveVisibleRootRange(options, requestTabId);
        const viewResponse = await NotesAPI.fetchView(noteId, requestSearchQuery, requestTabId, visibleRootRange, startAtListEnd);
        if (!viewResponse || typeof viewResponse.snapshot !== 'object') {
            throw new Error('notes.view response missing snapshot payload');
        }
        // The server has already recorded this response as the tab's warm view,
        // so it must be applied. Tab changes wait for in-flight view requests.
        if (ModeContext.activeTabId !== requestTabId) {
            throw new Error(
                `notes.view response for tab ${requestTabId} arrived after the active tab changed to ${ModeContext.activeTabId}`,
            );
        }
        const { snapshot } = viewResponse;
        ModeContext.setRootWindow(requestTabId, snapshot.rootWindowStart, snapshot.rootBandMargin);
        setSearchHighlightPhrases(snapshot.searchHighlightPhrases);
        const hasDiffOps = Array.isArray(snapshot.diffOps);
        const previousHashes = ModeContext.getNoteHashPayload();
        if (!hasDiffOps) {
            ModeContext.syncNoteHashesFromSnapshot(snapshot);
            if (!Array.isArray(snapshot.structure)) {
                throw new Error('notes.view snapshot missing structure array');
            }
        } else if (Array.isArray(snapshot.rootIds)) {
            ModeContext.syncRootIds(snapshot.rootIds);
        }

        updateSearchResultsCount(snapshot, requestTabId);
        updateRootSortIndicator(snapshot);
        updateUntaggedViewIndicator(snapshot);
        const previousRootCountTotals = ModeContext.getRootCountTotals(requestTabId);
        // Incremental notes.view refreshes can return the same totals when only note content changed.
        if (
            previousRootCountTotals.rootCountTotal !== snapshot.rootCountTotal
            || previousRootCountTotals.searchRootCountTotal !== snapshot.searchRootCountTotal
        ) {
            ModeContext.setRootCountTotals(snapshot.rootCountTotal, snapshot.searchRootCountTotal, requestTabId);
        }
        const updatedNotesCount = snapshot.notes && typeof snapshot.notes === 'object'
            ? Object.keys(snapshot.notes).length
            : 0;
        const roundtripMs = performance.now() - requestStartedAt;
        if (CONFIG.DEBUG.LOG_API_CALLS) {
            console.log(' [PERF] notes.view roundtrip:', {
                ms: Number(roundtripMs.toFixed(PERF_LOG_MS_DECIMALS))
            });
        }

        if (CONFIG.DEBUG.LOG_API_CALLS) {
            console.log(' [SNAPSHOT] notes.view summary:', {
                treeHash: snapshot.treeHash,
                structureCount: Array.isArray(snapshot.structure) ? snapshot.structure.length : 0,
                notesCount: snapshot.notes && typeof snapshot.notes === 'object' ? Object.keys(snapshot.notes).length : 0,
                locksCount: snapshot.locks && typeof snapshot.locks === 'object' ? Object.keys(snapshot.locks).length : 0,
                editingNoteId: snapshot.editingNoteId
            });
        }

        const renderStartedAt = performance.now();
        // Roots entering or leaving the band above the viewport must not move
        // what the user is reading. A render that ends at the top needs no hold.
        let viewportRoot = null;
        if (viewportHold !== null) {
            viewportRoot = viewportHold;
        } else if (!scrollToTopAfterRender && !startAtListEnd) {
            viewportRoot = captureViewportRoot();
        }
        let editingFocus = null;
        if (keepEditingFocus && noteId !== null && ModeContext.isEditing) {
            const editedNote = document.querySelector(`[data-note-id="${noteId}"]`);
            if (editedNote instanceof HTMLElement) {
                editingFocus = captureEditingFocus(editedNote);
            }
        }
        const diffResult = applyDifferentialView(snapshot, { previousHashes, animateNoteChanges });
        const notesContainer = diffResult.notesContainer;
        if (!notesContainer) {
            throw new Error('Notes container not found after diff application');
        }
        rebuildRootDateSeparators(snapshot);
        holdViewportRoot(viewportRoot);

        // Removal animations retain DOM nodes after the diff removes their view membership.
        const editingNoteElement = noteId && ModeContext.hasNoteHash(noteId)
            ? document.querySelector(`[data-note-id="${noteId}"]`)
            : null;
        syncTagBar(editingNoteElement);

        // If this is initial page load, fade in the entire app
        if (ModeContext.isInitialPageLoad) {
            const appContainer = document.getElementById('app');
            if (appContainer) {
                appContainer.classList.add('loaded');
            }
            ModeContext.markInitialPageLoadComplete();
        }

        let contentHtml = null;
        let result = null;

        if (noteId) {
            const noteElement = editingNoteElement;
            if (!noteElement) {
                Logger.logAction('refresh_hidden_filtered_editing_note', {
                    noteId,
                    searchQuery: requestSearchQuery,
                    tabId: requestTabId,
                });
                clearEditingStateForHiddenFilteredNote({
                    modeContext: ModeContext,
                    detachEditorSurfaceFn: detachEditorSurface,
                    clearTagBarFn: clearTagBar,
                });
                return null;
            }
            contentHtml = DOMUtils.getNoteContentHTML(noteElement);
            const noteContentElement = DOMUtils.getNoteContent(noteElement);

            if (ModeContext.isEditing) {
                initializeEditSessionCollapseStateFromNoteElement(noteElement);
                DOMUtils.setNoteEditable(noteElement, true);
                syncTagBar(noteElement);

                if (ModeContext.isCaretHidden) {
                    DOMUtils.hideCaret(noteElement);
                } else {
                    DOMUtils.revealCaret(noteElement);
                }

                if (clickAnchor !== null && clickAnchor.noteId === noteId) {
                    placeCaretAtClickAnchor(noteElement, clickAnchor);
                } else if (editingFocus !== null) {
                    restoreEditingFocus(noteElement, editingFocus);
                } else if (CONFIG.EDITOR.DEFAULT_CURSOR_POSITION === 'START') {
                    DOMUtils.focusNoteEdge(noteElement, 'start');
                } else {
                    DOMUtils.focusNoteEdge(noteElement, 'end');
                }

                attachEditorSurface(noteId, noteContentElement);
            } else {
                detachEditorSurface();
                clearTagBar();
            }

            result = contentHtml;
        } else {
            detachEditorSurface();
            clearTagBar();
            result = null;
        }

        const renderEndedAt = performance.now();
        const renderMs = renderEndedAt - renderStartedAt;
        const context = requestContext;

        const vdom_ops = Number.isInteger(diffResult.vdomOperations) ? diffResult.vdomOperations : 0;

        if (typeof options.expectedUpdatedNotesMax === 'number' && updatedNotesCount > options.expectedUpdatedNotesMax) {
            throw new Error(
                `Invariant violation: expected <=${options.expectedUpdatedNotesMax} updated notes but got ${updatedNotesCount} (context=${context})`
            );
        }
        if (typeof options.expectedVdomOpsMax === 'number' && vdom_ops > options.expectedVdomOpsMax) {
            throw new Error(
                `Invariant violation: expected <=${options.expectedVdomOpsMax} vdom ops but got ${vdom_ops} (context=${context})`
            );
        }

        if (options.startedAt) {  // otherwise called by background polling or palette actions
            console.log(' [PERF] notes.view render:', {
                ms: Number(renderMs.toFixed(PERF_LOG_MS_DECIMALS))
            });
        }

        if (startAtListEnd) {
            scrollWindowToListBottom();
        }
        if (scrollToTopAfterRender) {
            window.scrollTo(0, 0);
            // Callers can request top scroll while the active tab is already at top.
            if (ModeContext.getTabScrollPosition(ModeContext.activeTabId) !== 0) {
                ModeContext.updateActiveTabScroll(0);
            }
        }

        return result;
    })().finally(() => {
        moduleState.viewRequestInFlight = false;
    });
}

// Roots the browser can see; the server builds the band of loaded roots
// around them. The page's first view has no live viewport yet, so it opens
// the band at the tab's saved anchor root; resets (search, sort, jump to
// top) send no roots and start at the first root.
function resolveVisibleRootRange(options, tabId) {
    if (options.startAtListTop === true || options.startAtListEnd === true) {
        return { topRootId: null, bottomRootId: null };
    }
    if (typeof options.visibleRootAnchorId === 'string' && options.visibleRootAnchorId.length > 0) {
        return { topRootId: options.visibleRootAnchorId, bottomRootId: options.visibleRootAnchorId };
    }
    const live = ModeContext.getVisibleRootRange();
    if (live.topRootId !== null || live.bottomRootId !== null) {
        return live;
    }
    if (ModeContext.isInitialPageLoad) {
        const savedAnchorRootId = ModeContext.tabs[tabId].anchorRootId;
        if (typeof savedAnchorRootId === 'string' && savedAnchorRootId.length > 0) {
            return { topRootId: savedAnchorRootId, bottomRootId: savedAnchorRootId };
        }
    }
    return { topRootId: null, bottomRootId: null };
}

// Returns to the first root. With roots unloaded above the band, scrolling to
// pixel 0 would only reach the band start, so the tab's view is rebuilt from
// the first root instead.
// The bottom of the page: the last note's bottom at the bottom of the window.
function scrollWindowToListBottom() {
    const bottomY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, bottomY);
    if (ModeContext.getTabScrollPosition(ModeContext.activeTabId) !== window.scrollY) {
        ModeContext.updateActiveTabScroll(window.scrollY);
    }
}

// Goes to the last root. With roots unloaded below the band, the tab's view is
// rebuilt from the band that ends at the last root instead of scrolling
// through everything in between.
export async function actionJumpToListBottom(context) {
    if (!hasRootsBelowLoadedWindow()) {
        return false;
    }
    ModeContext.resetTabDiffCache(ModeContext.activeTabId, { preserveRootAnchor: false });
    await actionRefreshAndMaybeSelect({ context, requireExecution: true, startAtListEnd: true });
    return true;
}

export async function actionJumpToListTop(context) {
    if (!ModeContext.hasRootsAboveWindow()) {
        return false;
    }
    ModeContext.resetTabDiffCache(ModeContext.activeTabId, { preserveRootAnchor: false });
    await actionRefreshAndMaybeSelect({
        context, requireExecution: true, startAtListTop: true, scrollToTopAfterRender: true,
    });
    return true;
}
