import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { ErrorHandler } from '../../error-handler.js';
import { rootNoteCreationBlockMessage } from './root-sort-service.js';
import { MS_PER_SECOND } from '../../time-units.js';

const BLOCKED_REASON_BANNER_SECONDS = 6;

// Sorted tabs limit where new root notes may go (rootNoteCreationBlockMessage).
// Shows the reason and returns true when this one is blocked. Flows that do
// work before creating the note (uploading a file, reading the clipboard) call
// this first and stop; creating the note checks again.
export function blockRootNoteCreation(placement, contextLabel) {
    if (typeof contextLabel !== 'string' || contextLabel.length === 0) {
        throw new Error('blockRootNoteCreation requires a context label');
    }
    const message = rootNoteCreationBlockMessage(ModeContext.activeTabSortMode, placement);
    if (message === null) {
        return false;
    }
    Logger.logNoop('Root note creation blocked by active sort mode', {
        placement,
        context: contextLabel,
        sortMode: ModeContext.activeTabSortMode,
    });
    ErrorHandler.showInfoBanner(message, BLOCKED_REASON_BANNER_SECONDS * MS_PER_SECOND);
    return true;
}

// For callers that already checked blockRootNoteCreation: a null note id from
// createNote/createNoteAtTop then means the check was skipped, a bug.
export function requireCreatedNoteId(noteId, contextLabel) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error(`${contextLabel}: new root note was blocked after the sort-order check passed`);
    }
    return noteId;
}
