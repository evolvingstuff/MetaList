import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { DOMUtils } from '../../dom-utils.js';
import { detachEditorSurface } from '../../editor-toolbar.js';
import { actionSaveNote } from './content-actions.js';
import { NotesAPI } from '../../api-client.js';
import { actionRefreshAndMaybeSelect } from './ui-actions.js';
import { clearTagBar } from '../services/tag-bar-service.js';
import { persistExpandedEditSessionIfNeeded, restoreCollapsedStateLocallyIfNeeded } from '../services/edit-session-collapse-service.js';
import { clearSelectionStateForDeselect } from '../services/deselect-selection-state-service.js';
import { captureNoteAnchor, captureSortedExitAnchor, holdViewportRoot } from '../services/viewport-hold-service.js';
import { isRootReorderLocked } from '../services/root-sort-service.js';
import {
    recordNoteInteractionIfNew,
} from '../services/search-interaction-service.js';

function getNoteElementIfPresent(noteId) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('getNoteElementIfPresent requires noteId');
    }
    return document.querySelector(`[data-note-id="${noteId}"]`);
}

function applyInitialCaretVisibility(initialCaretVisibility) {
    if (initialCaretVisibility === 'hidden') {
        // Entering edit mode starts visible; a note selected without a click spot (a paste, a robot press) hides it.
        if (!ModeContext.isCaretHidden) {
            ModeContext.markCaretHidden();
        }
        return;
    }
    // Selecting an ordinary note usually keeps the default visible caret from setEditing(true).
    if (ModeContext.isCaretHidden) {
        ModeContext.markCaretVisible();
    }
}

// A click that enters edit mode passes `clickAnchor` (captureClickAnchor, taken
// before anything changes) so the clicked spot stays under the pointer and
// the caret lands there; other ways of entering edit mode pass none.
function clickAnchorOption(options, noteId) {
    if (!Object.prototype.hasOwnProperty.call(options, 'clickAnchor')) {
        return null;
    }
    const clickAnchor = options.clickAnchor;
    if (clickAnchor === null || typeof clickAnchor !== 'object' || clickAnchor.noteId !== noteId) {
        throw new Error('clickAnchor must be a click anchor for the note being entered');
    }
    return clickAnchor;
}

export async function actionSelectNote(noteId, options) {
    if (options === null || typeof options !== 'object') {
        throw new Error('actionSelectNote requires options object');
    }
    if (!Object.prototype.hasOwnProperty.call(options, 'initialCaretVisibility')) {
        throw new Error('actionSelectNote requires options.initialCaretVisibility');
    }
    const initialCaretVisibility = options.initialCaretVisibility;
    if (
        Object.prototype.hasOwnProperty.call(options, 'recordEditInteraction')
        && typeof options.recordEditInteraction !== 'boolean'
    ) {
        throw new Error('actionSelectNote options.recordEditInteraction must be boolean when provided');
    }
    const shouldRecordEditInteraction = options.recordEditInteraction !== false;
    const startedAt = performance.now();
    Logger.logAction('selectNote', { 
        noteId, 
        currentNoteId: ModeContext.currentNoteId 
    });

    if (!noteId) {
        throw new Error('Cannot select note: noteId is required');
    }

    if (ModeContext.isEditing) {
        if (ModeContext.currentNoteId === noteId) {
            Logger.logDebug('Note already selected, skipping', { noteId });
            return; 
        }

        await actionDeselectNote();
    }

    const clickAnchor = clickAnchorOption(options, noteId);
    if (clickAnchor !== null) {
        holdViewportRoot(clickAnchor);
    }

    ModeContext.setCurrentNoteId(noteId);

    ModeContext.setEditing(true);

    applyInitialCaretVisibility(initialCaretVisibility);

    if (shouldRecordEditInteraction) {
        await recordNoteInteractionIfNew(noteId, 'edit');
    }

    const refreshOptions = {startedAt: startedAt};
    if (clickAnchor !== null) {
        refreshOptions.viewportHold = clickAnchor;
        refreshOptions.clickAnchor = clickAnchor;
    }
    const newContent = await actionRefreshAndMaybeSelect(refreshOptions);

    if (ModeContext.currentContent !== newContent) {
        ModeContext.setCurrentContent(newContent);
    }

    ModeContext.validate();
}

export async function actionDeselectNote() {
    let startedAt = performance.now();
    Logger.logAction('deselectNote', { 
        currentNoteId: ModeContext.currentNoteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty
    });

    const noteId = ModeContext.currentNoteId;

    if (!ModeContext.isEditing) {
        throw new Error('Cannot deselect note: not currently editing');
    }

    const noteElement = getNoteElementIfPresent(noteId);
    let viewportHold = null;
    if (noteElement !== null) {
        // Keep the user's place (the caret, or the line being read) through
        // everything leaving edit mode changes: re-collapsing, the tag bar
        // closing, and the note re-rendering for viewing.
        // In a sorted tab the note may then move to its sorted place; the
        // surrounding notes stay on screen instead (docs/ui/controls.md).
        if (isRootReorderLocked(ModeContext.activeTabSortMode)) {
            viewportHold = captureSortedExitAnchor(noteElement);
        } else {
            viewportHold = captureNoteAnchor(noteElement);
        }
        holdViewportRoot(viewportHold);
        await actionSaveNote(noteId);
        await persistExpandedEditSessionIfNeeded(noteElement);
        restoreCollapsedStateLocallyIfNeeded(noteElement);
    } else {
        Logger.logDebug('Deselecting after note disappeared from DOM', { noteId });
        if (ModeContext.isDirty) {
            ModeContext.setDirty(false);
        }
    }

    clearSelectionStateForDeselect(ModeContext);

    const refreshOptions = {startedAt: startedAt, requireExecution: true};
    if (viewportHold !== null) {
        refreshOptions.viewportHold = viewportHold;
    }
    await actionRefreshAndMaybeSelect(refreshOptions);

    ModeContext.validate();
}

export async function actionSaveAndExitEditingWithoutRefreshing() {
    Logger.logAction('save_and_exit_editing_without_refresh', {
        currentNoteId: ModeContext.currentNoteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty,
    });

    if (!ModeContext.isEditing) {
        throw new Error('Cannot save and exit editing locally: not currently editing');
    }

    const noteId = ModeContext.currentNoteId;
    if (!noteId) {
        throw new Error('Cannot save and exit editing locally: currentNoteId is missing');
    }

    await actionSaveNote(noteId);
    const noteElement = getNoteElementIfPresent(noteId);
    if (noteElement !== null) {
        await persistExpandedEditSessionIfNeeded(noteElement);
        restoreCollapsedStateLocallyIfNeeded(noteElement);
    }

    actionExitEditingWithoutSavingOrRefreshing();
}

export function actionExitEditingWithoutSavingOrRefreshing() {
    Logger.logAction('exit_editing_without_saving_or_refreshing', {
        currentNoteId: ModeContext.currentNoteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty
    });

    if (!ModeContext.isEditing) {
        throw new Error('Cannot exit editing locally: not currently editing');
    }
    if (ModeContext.isDirty) {
        throw new Error('Cannot exit editing locally while dirty');
    }

    const noteId = ModeContext.currentNoteId;
    if (!noteId) {
        throw new Error('Cannot exit editing locally: currentNoteId is missing');
    }

    const noteElement = getNoteElementIfPresent(noteId);
    if (noteElement !== null) {
        DOMUtils.setNoteEditable(noteElement, false);
    }
    detachEditorSurface();
    clearTagBar();

    ModeContext.setEditing(false);
    ModeContext.setCurrentNoteId(null);

    if (ModeContext.currentContent !== null) {
        ModeContext.setCurrentContent(null);
    }

    ModeContext.validate();
}

export async function actionSwitchNotes(newNoteId, options) {
	if (options === null || typeof options !== 'object') {
		throw new Error('actionSwitchNotes requires options object');
	}
	if (!Object.prototype.hasOwnProperty.call(options, 'initialCaretVisibility')) {
		throw new Error('actionSwitchNotes requires options.initialCaretVisibility');
	}
	const initialCaretVisibility = options.initialCaretVisibility;
	let startedAt = performance.now();
    Logger.logAction('switchNotes', { 
        currentNoteId: ModeContext.currentNoteId,
        newNoteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty
    });

	    if (!newNoteId) {
	        throw new Error('Cannot switch notes: newNoteId is required');
	    }
	        
	    const currentNoteId = ModeContext.currentNoteId;
	    if (!ModeContext.isEditing) {
	        throw new Error('Cannot switch notes: not currently editing');
	    }
	    if (!currentNoteId) {
	        throw new Error('Cannot switch notes: currentNoteId is missing');
	    }

    if (currentNoteId === newNoteId) {
        Logger.logDebug('Already on this note, not switching', { noteId: newNoteId });
        return;
	    }

    // Keep the clicked note (and so the clicked text) under the pointer while
    // the note being left saves, closes its tag bar, and re-renders above it.
    const clickAnchor = clickAnchorOption(options, newNoteId);
    const clickedNoteElement = getNoteElementIfPresent(newNoteId);
    let viewportHold = null;
    if (clickAnchor !== null) {
        viewportHold = clickAnchor;
        holdViewportRoot(viewportHold);
    } else if (clickedNoteElement !== null) {
        viewportHold = {
            kind: 'top', noteId: newNoteId, top: clickedNoteElement.getBoundingClientRect().top, keepVisible: false,
        };
        holdViewportRoot(viewportHold);
    }

        await actionSaveNote(currentNoteId);
        await recordNoteInteractionIfNew(newNoteId, 'edit');

    const currentNoteElement = currentNoteId ? DOMUtils.getNoteById(currentNoteId) : null;

    if (currentNoteElement) {
        await persistExpandedEditSessionIfNeeded(currentNoteElement);
        restoreCollapsedStateLocallyIfNeeded(currentNoteElement);
        DOMUtils.setNoteEditable(currentNoteElement, false);
        clearTagBar();
    }

    if (ModeContext.currentContent === null) {
        throw new Error(`Programming error: Switching from note ${currentNoteId} but currentContent is null`);
    }

    ModeContext.setCurrentContent(null);

    ModeContext.setCurrentNoteId(newNoteId);
    ModeContext.resetEditSessionState({ startedCollapsed: false });

    applyInitialCaretVisibility(initialCaretVisibility);

    const refreshOptions = {startedAt: startedAt};
    if (viewportHold !== null) {
        refreshOptions.viewportHold = viewportHold;
    }
    if (clickAnchor !== null) {
        refreshOptions.clickAnchor = clickAnchor;
    }
    const newContent = await actionRefreshAndMaybeSelect(refreshOptions);
    
    ModeContext.setCurrentContent(newContent);
  
    ModeContext.validate();
}
