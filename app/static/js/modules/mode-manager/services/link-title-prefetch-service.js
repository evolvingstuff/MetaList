import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { DOMUtils } from '../../dom-utils.js';
import { NotesAPI } from '../../api-client.js';
import { getTagBarValue } from './tag-bar-service.js';
import { CommandGate } from './command-gate-service.js';

const PREFETCH_IDLE_MS = 600;
const moduleState = ApplicationState.createFields('link-title-prefetch-service', {
    observation: null,
    requestedDraft: null,
    requestInFlight: false,
});


export async function prefetchEditingLinkTitles() {
    if (!ModeContext.isEditing) {
        // Periodic ticks continue outside editing; clear only an existing draft episode.
        if (moduleState.observation !== null) moduleState.observation = null;
        if (moduleState.requestedDraft !== null) moduleState.requestedDraft = null;
        return;
    }
    if (!ModeContext.isConnected || CommandGate.isBusy() || moduleState.requestInFlight) {
        return;
    }
    const note = DOMUtils.getNoteById(ModeContext.currentNoteId);
    const content = DOMUtils.getNoteContentHTML(note);
    const tags = getTagBarValue(note);
    const draft = JSON.stringify([ModeContext.currentNoteId, content, tags]);
    if (moduleState.observation === null || draft !== moduleState.observation.draft) {
        moduleState.observation = { draft, at: Date.now() };
        return;
    }
    if (draft === moduleState.requestedDraft || Date.now() - moduleState.observation.at < PREFETCH_IDLE_MS) {
        return;
    }
    if (!/https?:\/\//i.test(content)) {
        return;
    }
    moduleState.requestedDraft = draft;
    moduleState.requestInFlight = true;
    await NotesAPI._apiCall('/api2/notes/link-titles/prefetch', {
        method: 'POST',
        body: JSON.stringify({ content, tags }),
    }).finally(() => {
        moduleState.requestInFlight = false;
    });
}
