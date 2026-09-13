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
import { refreshBacklinksPanel } from '../services/backlinks-panel-service.js';
import { rebuildRootDateSeparators } from '../services/root-date-separator-service.js';
import { updateRootSortIndicator } from '../services/root-sort-indicator-service.js';
import { updateUntaggedViewIndicator } from '../services/untagged-view-indicator-service.js';
import { resetInfiniteScrollState } from '../services/infinite-scroll-service.js';

const moduleState = ApplicationState.createFields('ui-actions', {
    viewRequestInFlight: false,
    lastPerfOverlayPayload: null,
});


function updatePerfOverlay(roundtripMs, renderMs, totalMs, totalNotes,
                           rootNotesKnown, rootNotesSeen, updatedNotes,
                           context, vdom_ops) {
    moduleState.lastPerfOverlayPayload = {
        roundtripMs,
        renderMs,
        totalMs,
        totalNotes,
        rootNotesKnown,
        rootNotesSeen,
        updatedNotes,
        context,
        vdom_ops,
    };
    const shouldShow = document.body.classList.contains('pref-show-perf-overlay');
    let overlay = document.getElementById('perf-overlay');
    if (!shouldShow) {
        if (overlay) {
            overlay.remove();
        }
        return;
    }
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'perf-overlay';
        overlay.style.position = 'fixed';
        overlay.style.bottom = '8px';
        overlay.style.right = '8px';
        overlay.style.padding = '4px 8px';
        overlay.style.borderRadius = '4px';
        overlay.style.background = 'rgba(0, 0, 0, 0.7)';
        overlay.style.color = '#fff';
        overlay.style.fontSize = '12px';
        overlay.style.fontFamily = 'monospace';
        overlay.style.zIndex = '9999';
        document.body.appendChild(overlay);
    }

    const roundtrip = Number(roundtripMs.toFixed(2));
    const render = Number(renderMs.toFixed(2));
    const total = Number(totalMs.toFixed(2));
    const notesCount = Number.isInteger(totalNotes) && totalNotes >= 0 ? totalNotes : 0;
    const rootsKnown = Number.isInteger(rootNotesKnown) && rootNotesKnown >= 0 ? rootNotesKnown : 0;
    const rootsSeen = Number.isInteger(rootNotesSeen) && rootNotesSeen >= 0 ? rootNotesSeen : 0;
    const updatedCount = Number.isInteger(updatedNotes) && updatedNotes >= 0 ? updatedNotes : 0;

    const rowStyle = 'padding-top: 2px; padding-bottom: 2px;';
    const labelStyle = 'padding: 0 14px 0 6px; white-space: nowrap;';
    const valueStyle = 'text-align: right; min-width: 70px; padding: 0 14px;';
    const dividerColor = 'rgba(255, 255, 255, 0.25)';
    const labelCellBaseStyle = `${labelStyle} ${rowStyle} border-right: 1px solid ${dividerColor};`;
    const valueCellBaseStyle = `${valueStyle} ${rowStyle};`;
    const bottomBorderStyle = `border-bottom: 1px solid ${dividerColor};`;

    overlay.innerHTML = `
        <table style="border-collapse: collapse;">
            <tbody>
                <tr>
                    <td style="${labelCellBaseStyle} ${bottomBorderStyle}">context</td>
                    <td style="${valueCellBaseStyle} ${bottomBorderStyle}">${context}</td>
                </tr>
                <tr>
                    <td style="${labelCellBaseStyle} ${bottomBorderStyle}">all notes known</td>
                    <td style="${valueCellBaseStyle} ${bottomBorderStyle}">${notesCount}</td>
                </tr>
                <tr>
                    <td style="${labelCellBaseStyle} ${bottomBorderStyle}">all notes updated</td>
                    <td style="${valueCellBaseStyle} ${bottomBorderStyle}">${updatedCount}</td>
                </tr>
                <tr>
                    <td style="${labelCellBaseStyle} ${bottomBorderStyle}">root notes known</td>
                    <td style="${valueCellBaseStyle} ${bottomBorderStyle}">${rootsKnown}</td>
                </tr>
                <tr>
                    <td style="${labelCellBaseStyle} ${bottomBorderStyle}">root notes seen</td>
                    <td style="${valueCellBaseStyle} ${bottomBorderStyle}">${rootsSeen}</td>
                </tr>
                <tr>
                    <td style="${labelCellBaseStyle} ${bottomBorderStyle}">server trip</td>
                    <td style="${valueCellBaseStyle} ${bottomBorderStyle}">${roundtrip}ms</td>
                </tr>
                <tr>
                    <td style="${labelCellBaseStyle} ${bottomBorderStyle}">client render</td>
                    <td style="${valueCellBaseStyle} ${bottomBorderStyle}">${render}ms</td>
                </tr>
                <tr>
                    <td style="${labelCellBaseStyle} ${bottomBorderStyle}">vdom ops</td>
                    <td style="${valueCellBaseStyle} ${bottomBorderStyle}">${vdom_ops}</td>
                </tr>
                <tr>
                    <td style="${labelCellBaseStyle}">total</td>
                    <td style="${valueCellBaseStyle}">${total}ms</td>
                </tr>
            </tbody>
        </table>
    `;
}

export function showPerfOverlayFromCache() {
    if (!moduleState.lastPerfOverlayPayload) {
        return false;
    }
    updatePerfOverlay(
        moduleState.lastPerfOverlayPayload.roundtripMs,
        moduleState.lastPerfOverlayPayload.renderMs,
        moduleState.lastPerfOverlayPayload.totalMs,
        moduleState.lastPerfOverlayPayload.totalNotes,
        moduleState.lastPerfOverlayPayload.rootNotesKnown,
        moduleState.lastPerfOverlayPayload.rootNotesSeen,
        moduleState.lastPerfOverlayPayload.updatedNotes,
        moduleState.lastPerfOverlayPayload.context,
        moduleState.lastPerfOverlayPayload.vdom_ops
    );
    return true;
}

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
    const animateNoteChanges = options.animateNoteChanges !== false;

    if (moduleState.viewRequestInFlight) {
        if (!requireExecution) {
            Logger.logNoop('notes.view ignored while view request in-flight', {
                activeTabId: ModeContext.activeTabId,
                context: options.context || 'refresh'
            });
            return null;
        }

        const waitStartedAt = performance.now();
        while (moduleState.viewRequestInFlight) {
            const waitedMs = performance.now() - waitStartedAt;
            if (waitedMs > 5000) {
                throw new Error('notes.view blocked >5s waiting for in-flight request');
            }
            await new Promise((resolve) => {
                window.setTimeout(resolve, 25);
            });
        }
    }

    if (resetViewCacheBeforeFetch) {
        ModeContext.resetTabDiffCache(requestTabId, { preserveRootAnchor: false });
        resetInfiniteScrollState();
    }

    moduleState.viewRequestInFlight = true;
    return await (async () => {
        const requestStartedAt = performance.now();
        const forcedAnchorId = typeof options.visibleRootAnchorId === 'string' && options.visibleRootAnchorId.length > 0
            ? options.visibleRootAnchorId
            : null;
        let anchorId = forcedAnchorId;
        if (!anchorId) {
            anchorId = ModeContext.getRootAnchorId();
        }
        if (!anchorId) {
            anchorId = ModeContext.getLastKnownRootId();
        }
        const viewResponse = await NotesAPI.fetchView(noteId, requestSearchQuery, requestTabId, anchorId);
        if (!viewResponse || typeof viewResponse.snapshot !== 'object') {
            throw new Error('notes.view response missing snapshot payload');
        }
        if (ModeContext.activeTabId !== requestTabId) {
            Logger.logDebug('Discarding snapshot for inactive tab', {
                requestTabId,
                activeTabId: ModeContext.activeTabId,
            });
            return null;
        }
        const { snapshot } = viewResponse;
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
        const rootNotesKnown = ModeContext.knownRootCount;
        const rootNotesSeen = ModeContext.seenRootCount;
        const updatedNotesCount = snapshot.notes && typeof snapshot.notes === 'object'
            ? Object.keys(snapshot.notes).length
            : 0;
        const roundtripMs = performance.now() - requestStartedAt;
        console.log(' [PERF] notes.view roundtrip:', {
            ms: Number(roundtripMs.toFixed(2))
        });

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
        const diffResult = applyDifferentialView(snapshot, { previousHashes, animateNoteChanges });
        const notesContainer = diffResult.notesContainer;
        if (!notesContainer) {
            throw new Error('Notes container not found after diff application');
        }
        rebuildRootDateSeparators(snapshot);

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

                if (CONFIG.EDITOR.DEFAULT_CURSOR_POSITION === 'START') {
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
        const metricsStartedAt = typeof options.startedAt === 'number' ? options.startedAt : requestStartedAt;
        const totalMs = renderEndedAt - metricsStartedAt;
        const context = options.context ? options.context : 'refresh';

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
                ms: Number(renderMs.toFixed(2))
            });
        }
        const totalNotesCount = ModeContext.noteCount;
        updatePerfOverlay(roundtripMs, renderMs, totalMs, totalNotesCount,
            rootNotesKnown, rootNotesSeen, updatedNotesCount, context, vdom_ops);

        await refreshBacklinksPanel({});
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
