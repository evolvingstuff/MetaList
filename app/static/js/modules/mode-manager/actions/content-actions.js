import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { NotesAPI } from '../../api-client.js';
import { DOMUtils } from '../../dom-utils.js';
import { getTagBarValue, markTagBarSaved, setTagBarValue } from '../services/tag-bar-service.js';
import { sanitizeNoteHtmlForStorage } from '../../note-html-sanitizer.js';

function getNoteElementIfPresent(noteId) {
    if (!noteId) {
        throw new Error('noteId is required');
    }
    return document.querySelector(`[data-note-id="${noteId}"]`);
}

function reconcileContentBeforeSave(noteElement) {
    const rawHTML = DOMUtils.getNoteContentHTML(noteElement);
    const contentHTML = sanitizeNoteHtmlForStorage(rawHTML);
    if (typeof ModeContext.currentContent !== 'string') {
        throw new Error('Saving an active editor requires its current content snapshot');
    }
    // External writing tools can change the DOM without dispatching input.
    // Observe the actual editor at the save boundary; compare stored HTML so
    // transient rendering attributes do not turn an untouched note into an edit.
    if (rawHTML !== ModeContext.currentContent
        && contentHTML !== sanitizeNoteHtmlForStorage(ModeContext.currentContent)) {
        ModeContext.setCurrentContent(rawHTML);
        if (!ModeContext.isDirty) ModeContext.setDirty(true);
        if (!ModeContext.editSessionHasEdits) ModeContext.markEditSessionHasEdits();
    }
    return contentHTML;
}

export async function actionSaveNote(noteId) {
    Logger.logAction('saveNote', { noteId });

    if (!noteId) {
        throw new Error('Cannot save note: noteId is required');
    }

    if (ModeContext.currentNoteId !== noteId) {
        throw new Error(`Cannot save note ${noteId} - not the current note being edited (${ModeContext.currentNoteId})`);
    }

    const noteElement = getNoteElementIfPresent(noteId);
    if (noteElement === null) {
        Logger.logDebug('Skipping save for missing note element', { noteId });
        return Promise.resolve();
    }
    const contentHTML = reconcileContentBeforeSave(noteElement);
    const tags = getTagBarValue(noteElement);
    const previousTags = typeof noteElement.dataset.noteTags === 'string' ? noteElement.dataset.noteTags : '';
    const tagsChanged = tags !== previousTags;

    if (!ModeContext.isDirty && !tagsChanged) {
        Logger.logDebug('Note not dirty, skipping save', { 
            noteId,
            contentLength: contentHTML.length,
            tagsChanged,
        }, Logger.LogCategory.DEBUG);
        return Promise.resolve(); 
    }

    const response = await NotesAPI.saveNote(noteId, contentHTML, tags);

    if (ModeContext.isDirty) {
        // A save can be triggered for tag-only changes after content was already captured.
        if (ModeContext.lastSavedContent !== contentHTML) {
            ModeContext.setLastSavedContent(contentHTML);
        }
        ModeContext.setDirty(false);
    }
    if (tagsChanged) {
        setTagBarValue(noteElement, tags);
    }
    markTagBarSaved(noteElement, tags);

    return response;
}

export async function actionSaveNoteOnIdle(noteId) {
    Logger.logAction('saveNoteOnIdle', { 
        noteId,
        idle: !ModeContext.isActive
    });

    if (!noteId) {
        throw new Error('Cannot save note on idle: noteId is required');
    }

    if (ModeContext.currentNoteId !== noteId) {
        throw new Error(`Cannot save note ${noteId} on idle - not the current note being edited (${ModeContext.currentNoteId})`);
    }

    const noteElement = getNoteElementIfPresent(noteId);
    if (noteElement === null) {
        Logger.logDebug('Skipping idle save for missing note element', { noteId });
        return Promise.resolve();
    }
    const contentHTML = reconcileContentBeforeSave(noteElement);

    if (!ModeContext.isDirty) {
        Logger.logDebug('Note not dirty, skipping idle save', { 
            noteId,
            isActive: ModeContext.isActive
        }, Logger.LogCategory.DEBUG);
        return Promise.resolve(); 
    }

    const tags = getTagBarValue(noteElement);
    
    Logger.logDebug('Auto-saving note during idle period', {
        noteId,
        contentLength: contentHTML.length,
        tagsLength: tags.length,
    }, Logger.LogCategory.STATE);

    const response = await NotesAPI.saveNote(noteId, contentHTML, tags);

    // Idle autosave can race with a manual save that already stored this content.
    if (ModeContext.lastSavedContent !== contentHTML) {
        ModeContext.setLastSavedContent(contentHTML);
    }
    ModeContext.setDirty(false);
    setTagBarValue(noteElement, tags);
    markTagBarSaved(noteElement, tags);

    Logger.logDebug('Idle save completed successfully', {
        noteId,
        response: response ? 'success' : 'error'
    }, Logger.LogCategory.STATE);
    return response;

}
