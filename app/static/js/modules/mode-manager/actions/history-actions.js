import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { stateValuesEqual } from '../../application-state.js';
import * as Logger from '../mode-logger.js';
import { ErrorHandler } from '../../error-handler.js';
import { NotesAPI } from '../../api-client.js';
import { actionSaveNote } from './content-actions.js';
import { actionRefreshAndMaybeSelect } from './ui-actions.js';
import { CONFIG } from '../../config.js';
import { DOMUtils } from '../../dom-utils.js';
import { scrollNoteIntoView } from '../services/scroll-restoration-service.js';
import { detachEditorSurface } from '../../editor-toolbar.js';
import { clearTagBar } from '../services/tag-bar-service.js';
import { resolveHistoryEditingState } from '../services/history-selection-policy-service.js';

function applyScrollRestore(scrollRestore, contextLabel) {
    if (!scrollRestore || typeof scrollRestore !== 'object') {
        throw new Error(`${contextLabel} response missing scrollRestore object`);
    }

    const scrollY = scrollRestore.scrollY;
    if (typeof scrollY !== 'number' || scrollY < 0) {
        throw new Error(`${contextLabel} scrollRestore.scrollY must be a non-negative number`);
    }

    const scrollAnchor = scrollRestore.scrollAnchor;
    if (scrollAnchor !== null && typeof scrollAnchor !== 'object') {
        throw new Error(`${contextLabel} scrollRestore.scrollAnchor must be an object or null`);
    }

    // History navigation can restore to the same scroll position already held by the active tab.
    if (ModeContext.getTabScrollPosition(ModeContext.activeTabId) !== scrollY) {
        ModeContext.updateActiveTabScroll(scrollY);
    }
    // The server's history snapshot can also preserve the current anchor.
    // Compare after updating Y, since that transition clears the old anchor.
    if (!stateValuesEqual(ModeContext.getTabScrollAnchor(ModeContext.activeTabId), scrollAnchor)) {
        ModeContext.updateActiveTabScrollAnchor(scrollAnchor, true);
    }

    const viewAnchorRootId = typeof scrollRestore.viewAnchorRootId === 'string' && scrollRestore.viewAnchorRootId.length > 0
        ? scrollRestore.viewAnchorRootId
        : null;

    const focusNoteId = typeof scrollRestore.focusNoteId === 'string'
        ? scrollRestore.focusNoteId
        : '';

    const opType = scrollRestore.opType;
    if (typeof opType !== 'string' || opType.length === 0) {
        throw new Error(`${contextLabel} scrollRestore.opType must be a non-empty string`);
    }

    const anchorId = scrollAnchor && typeof scrollAnchor.anchorId === 'string' && scrollAnchor.anchorId.length > 0
        ? scrollAnchor.anchorId
        : null;

    return {
        visibleRootAnchorId: viewAnchorRootId || anchorId,
        focusNoteId,
        opType,
    };
}

function _applyHistorySelectionState({
    shouldEdit,
    noteId,
    priorEditingNoteId,
}) {
    if (shouldEdit) {
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('History selection state requires a non-empty noteId when shouldEdit is true');
        }
        const noteChanged = ModeContext.currentNoteId !== noteId;

        if (noteChanged) {
            ModeContext.setCurrentNoteId(noteId);
        }

        if (!ModeContext.isEditing) {
            ModeContext.setEditing(true);
        }
        if (noteChanged) {
            ModeContext.resetEditSessionState({ startedCollapsed: false });
        }

        // Undo/redo can keep editing the same visible note while only content changes.
        if (ModeContext.isCaretHidden) {
            ModeContext.markCaretVisible();
        }
        return;
    }

    if (ModeContext.currentContent !== null) {
        ModeContext.setCurrentContent(null);
    }

    let cleanupTarget = null;
    if (typeof priorEditingNoteId === 'string' && priorEditingNoteId.length > 0) {
        cleanupTarget = document.querySelector(`[data-note-id="${priorEditingNoteId}"]`);
    }

    if (!cleanupTarget) {
        cleanupTarget = document.querySelector(`.${CONFIG.CLASSES.NOTE}.${CONFIG.CLASSES.EDITING}`);
    }

    if (cleanupTarget) {
        DOMUtils.setNoteEditable(cleanupTarget, false);
        DOMUtils.revealCaret(cleanupTarget);
    }

    detachEditorSurface();
    clearTagBar();

    if (ModeContext.isEditing) {
        ModeContext.setEditing(false);
    }

    if (ModeContext.currentNoteId !== null) {
        ModeContext.setCurrentNoteId(null);
    }
}

export async function actionUndo() {
    let startedAt = performance.now();
    let visibleRootAnchorId = null;
    let focusNoteId = '';
    const restoreEditing = ModeContext.isEditing;
    const restoreEditingNoteId = ModeContext.currentNoteId;
    Logger.logAction('undo', {
        currentNoteId: ModeContext.currentNoteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty,
        isSearching: ModeContext.isSearching
    });

    if (ModeContext.isDirty && ModeContext.currentNoteId) {
        await actionSaveNote(ModeContext.currentNoteId);
    }

    if (ModeContext.isSearching) {
        ModeContext.setSearching(false);
    }

    Logger.logAction('undo_api_call_start', { timestamp: Date.now() });
    const result = await NotesAPI.undo();
    Logger.logDebug('Undo API response', result, Logger.LogCategory.DEBUG);

    if (result.status === 'noop') {
        Logger.logAction('undo_noop', { message: result.message });
        ErrorHandler.showInfoBanner(result.message, 5000);
        return; 
    }

    if (result.status === 'success') {
        Logger.logAction('undo_success', { message: result.message });

        const restored = applyScrollRestore(result.scrollRestore, 'Undo');
        visibleRootAnchorId = restored.visibleRootAnchorId;
        focusNoteId = restored.focusNoteId;
        const opType = restored.opType;

        if (ModeContext.isDirty) {
            ModeContext.setDirty(false);
        }

        let opDeletesEditingTarget = false;
        if (opType === 'create_note') {
            opDeletesEditingTarget = true;
        } else if (opType === 'paste_subtree') {
            opDeletesEditingTarget = true;
        }

        // focusNoteId is scroll guidance only. Saved-history navigation must not
        // create a new selection when it started in view mode.
        const editingState = resolveHistoryEditingState({
            wasEditing: restoreEditing,
            editingNoteId: restoreEditingNoteId,
            removesEditingTarget: opDeletesEditingTarget,
        });
        _applyHistorySelectionState({
            ...editingState,
            priorEditingNoteId: restoreEditingNoteId,
        });
    } else {
        
        throw new Error(`Undo failed: ${result.message || 'Unknown error'}`);
    }

    const newContent = await actionRefreshAndMaybeSelect({ startedAt, context: 'actionUndo', visibleRootAnchorId });

    ModeContext.restoreScrollForActiveTab();
    if (focusNoteId) {
		window.setTimeout(() => {
			scrollNoteIntoView(focusNoteId, {});
		}, 300);
	}

    if (ModeContext.currentContent !== newContent && newContent !== null) {
        ModeContext.setCurrentContent(newContent);
    }

    ModeContext.validate();
}

export async function actionRedo() {
    let startedAt = performance.now();
    let visibleRootAnchorId = null;
    let focusNoteId = '';
    const restoreEditing = ModeContext.isEditing;
    const restoreEditingNoteId = ModeContext.currentNoteId;
    Logger.logAction('redo', {
        currentNoteId: ModeContext.currentNoteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty,
        isSearching: ModeContext.isSearching
    });

    if (ModeContext.isDirty && ModeContext.currentNoteId) {
        await actionSaveNote(ModeContext.currentNoteId);
    }

    if (ModeContext.isSearching) {
        ModeContext.setSearching(false);
    }

    Logger.logAction('redo_api_call_start', { timestamp: Date.now() });
    const result = await NotesAPI.redo();
    Logger.logDebug('Redo API response', result, Logger.LogCategory.DEBUG);

    if (result.status === 'noop') {
        Logger.logAction('redo_noop', { message: result.message });
        return; 
    }

    if (result.status === 'success') {
        Logger.logAction('redo_success', { message: result.message });

        const restored = applyScrollRestore(result.scrollRestore, 'Redo');
        visibleRootAnchorId = restored.visibleRootAnchorId;
        focusNoteId = restored.focusNoteId;
        const opType = restored.opType;

        if (ModeContext.isDirty) {
            ModeContext.setDirty(false);
        }

        const opDeletesEditingTarget = opType === 'delete_subtree';
        // focusNoteId is scroll guidance only. Saved-history navigation must not
        // create a new selection when it started in view mode.
        const editingState = resolveHistoryEditingState({
            wasEditing: restoreEditing,
            editingNoteId: restoreEditingNoteId,
            removesEditingTarget: opDeletesEditingTarget,
        });
        _applyHistorySelectionState({
            ...editingState,
            priorEditingNoteId: restoreEditingNoteId,
        });
    } else {
        
        throw new Error(`Redo failed: ${result.message || 'Unknown error'}`);
    }

    const newContent = await actionRefreshAndMaybeSelect({ startedAt, context: 'actionRedo', visibleRootAnchorId });

    ModeContext.restoreScrollForActiveTab();
    if (focusNoteId) {
		window.setTimeout(() => {
			scrollNoteIntoView(focusNoteId, {});
		}, 300);
	}

    if (ModeContext.currentContent !== newContent && newContent !== null) {
        ModeContext.setCurrentContent(newContent);
    }

    ModeContext.validate();
}
