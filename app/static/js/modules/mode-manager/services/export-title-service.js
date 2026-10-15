import { NotesAPI } from '../../api-client.js';
import { loadExportTitleAvailability, requestExportTitle } from '../../ai-chat/ai-chat-api.js';
import { rethrowUnexpectedError } from '../../expected-errors.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { actionSaveNote } from '../actions/content-actions.js';

// What the Export and Print dialog needs (docs/ui/controls.md), shared by both:
// the title it starts with, how many passwords and usernames go out, and whether Suggest with
// AI can ask, with a way to ask.

// The AI's title, or why it gave none ({ title, failure }, one of them empty).
// Stopped (signal aborted), it is neither: the dialog has moved on.
async function askAiForTitle({ noteId, aiSettings, scope, previousTitles, signal }) {
    let title = '';
    let failure = '';
    try {
        title = await requestExportTitle({
            provider: aiSettings.provider, model: aiSettings.model, thinkingLevel: aiSettings.thinkingLevel,
            scope, noteId, previousTitles, signal,
        });
    } catch (error) {
        // Stopped, or the AI could not answer (an AiApiError says why).
        rethrowUnexpectedError(error);
        if (!signal.aborted) {
            failure = error.message;
        }
    }
    return { title, failure };
}

// Run inside the caller's command gate: the note being edited is saved first
// (it stays in edit mode), so what goes out is what the user sees. noteId is a
// note with its children, or null for the view; aiSettings the AI the user
// chose ({ provider, model, thinkingLevel }).
export async function prepareExportDialog(noteId, aiSettings) {
    if (noteId !== null && (typeof noteId !== 'string' || noteId === '')) {
        throw new Error('prepareExportDialog requires a note id or null for the view');
    }
    if (!aiSettings || typeof aiSettings.provider !== 'string' || typeof aiSettings.model !== 'string') {
        throw new Error('prepareExportDialog requires the AI settings');
    }
    if (ModeContext.isEditing) {
        await actionSaveNote(ModeContext.currentNoteId);
    }
    const scope = NotesAPI.viewScope();
    const [summary, availability] = await Promise.all([
        NotesAPI.fetchExportSummary(noteId),
        loadExportTitleAvailability({ provider: aiSettings.provider, scope, noteId }),
    ]);
    return {
        defaultTitle: summary.title,
        passwordCount: summary.passwordCount,
        usernameCount: summary.usernameCount,
        aiTitle: {
            availability,
            suggest: (previousTitles, signal) => askAiForTitle({ noteId, aiSettings, scope, previousTitles, signal }),
        },
    };
}
