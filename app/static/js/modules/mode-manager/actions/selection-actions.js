import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { DOMUtils } from '../../dom-utils.js';
import { detachEditorSurface } from '../../editor-toolbar.js';
import { actionSaveNote } from './content-actions.js';
import { NotesAPI } from '../../api-client.js';
import { actionRefreshAndMaybeSelect } from './ui-actions.js';
import { clearTagBar } from '../services/tag-bar-service.js';
import { restoreCollapsedStateLocallyIfNeeded } from '../services/edit-session-collapse-service.js';
import { clearSelectionStateForDeselect } from '../services/deselect-selection-state-service.js';
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
        // Entering edit mode starts visible, but collapsed-note editing intentionally hides it.
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

    ModeContext.setCurrentNoteId(noteId);

    ModeContext.setEditing(true);

    applyInitialCaretVisibility(initialCaretVisibility);

    if (shouldRecordEditInteraction) {
        await recordNoteInteractionIfNew(noteId, 'edit');
    }

    const newContent = await actionRefreshAndMaybeSelect({startedAt: startedAt});

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
    if (noteElement !== null) {
        await actionSaveNote(noteId);
        restoreCollapsedStateLocallyIfNeeded(noteElement);
    } else {
        Logger.logDebug('Deselecting after note disappeared from DOM', { noteId });
        if (ModeContext.isDirty) {
            ModeContext.setDirty(false);
        }
    }

    clearSelectionStateForDeselect(ModeContext);

    await actionRefreshAndMaybeSelect({startedAt: startedAt, requireExecution: true});

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

        await actionSaveNote(currentNoteId);
        await recordNoteInteractionIfNew(newNoteId, 'edit');

    const currentNoteElement = currentNoteId ? DOMUtils.getNoteById(currentNoteId) : null;

    if (currentNoteElement) {
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

    const newContent = await actionRefreshAndMaybeSelect({startedAt: startedAt});
    
    ModeContext.setCurrentContent(newContent);
  
    ModeContext.validate();
}
