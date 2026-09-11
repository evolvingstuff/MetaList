import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { DOMUtils } from '../../dom-utils.js';
import { NotesAPI } from '../../api-client.js';
import { getTagBarValue } from './tag-bar-service.js';
import { CommandGate } from './command-gate-service.js';

const PREFETCH_IDLE_MS = 600;
let observedDraft = null;
let observedAt = 0;
let requestedDraft = null;
let requestInFlight = false;

export async function prefetchEditingLinkTitles() {
    if (!ModeContext.isEditing) {
        observedDraft = null;
        requestedDraft = null;
        return;
    }
    if (!ModeContext.isConnected || CommandGate.isBusy() || requestInFlight) {
        return;
    }
    const note = DOMUtils.getNoteById(ModeContext.currentNoteId);
    const content = DOMUtils.getNoteContentHTML(note);
    const tags = getTagBarValue(note);
    const draft = JSON.stringify([ModeContext.currentNoteId, content, tags]);
    if (draft !== observedDraft) {
        observedDraft = draft;
        observedAt = Date.now();
        return;
    }
    if (draft === requestedDraft || Date.now() - observedAt < PREFETCH_IDLE_MS) {
        return;
    }
    if (!/https?:\/\//i.test(content)) {
        return;
    }
    requestedDraft = draft;
    requestInFlight = true;
    await NotesAPI._apiCall('/api2/notes/link-titles/prefetch', {
        method: 'POST',
        body: JSON.stringify({ content, tags }),
    }).finally(() => {
        requestInFlight = false;
    });
}
