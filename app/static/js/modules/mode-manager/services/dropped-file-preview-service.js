import { NotesAPI } from '../../api-client.js';
import { ErrorHandler } from '../../error-handler.js';
import { MS_PER_SECOND } from '../../time-units.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { actionRefreshAndMaybeSelect } from '../actions/ui-actions.js';

// A dropped .txt, .md, .csv or .json file also gets its text as a child note of the
// note holding its pill (app/services/file_text_preview.py decides which files).

const SKIPPED_PREVIEW_REASONS = {
    too_large: 'is too large to preview',
    not_text: 'is not UTF-8 text, so it has no preview',
};
const SKIPPED_PREVIEWS_BANNER_SECONDS = 6;

/**
 * Adds the preview child notes for files a drop attached, in drop order.
 * @param {Array<{noteId: string, fileId: string, filename: string}>} attachedFiles
 */
export async function addDroppedFilePreviews(attachedFiles) {
    if (!Array.isArray(attachedFiles)) {
        throw new Error('addDroppedFilePreviews requires an array');
    }
    const startedAt = performance.now();
    let createdCount = 0;
    const skippedMessages = [];
    for (const attached of attachedFiles) {
        if (typeof attached.noteId !== 'string' || attached.noteId.length === 0
            || typeof attached.fileId !== 'string' || attached.fileId.length === 0
            || typeof attached.filename !== 'string' || attached.filename.length === 0) {
            throw new Error('addDroppedFilePreviews requires noteId, fileId and filename');
        }
        const response = await NotesAPI.createFilePreviewChild(attached.noteId, attached.fileId,
            ModeContext.searchQuery);
        if (response.status === 'created') {
            createdCount += 1;
        } else if (Object.prototype.hasOwnProperty.call(SKIPPED_PREVIEW_REASONS, response.status)) {
            skippedMessages.push(`${attached.filename} ${SKIPPED_PREVIEW_REASONS[response.status]}.`);
        } else if (response.status !== 'not_previewable') {
            throw new Error(`Unexpected file preview status: ${response.status}`);
        }
    }
    if (createdCount > 0) {
        await actionRefreshAndMaybeSelect({ startedAt, context: 'droppedFilePreviews' });
    }
    if (skippedMessages.length > 0) {
        ErrorHandler.showErrorBanner(skippedMessages.join(' '), 'info', SKIPPED_PREVIEWS_BANNER_SECONDS * MS_PER_SECOND, true);
    }
}
