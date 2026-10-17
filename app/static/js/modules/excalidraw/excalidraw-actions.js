// Entry points into the diagram editor: double-click or "Edit Diagram" on a rendered diagram,
// and "Add Excalidraw Diagram" from the note context menu or the command palette.
import { settleResult } from '../async-result.js';
import { ErrorHandler } from '../error-handler.js';
import { UserInputRejected } from '../expected-errors.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { actionDeselectNote } from '../mode-manager/actions/selection-actions.js';
import { CommandGate } from '../mode-manager/services/command-gate-service.js';
import { attachPickedFileToCurrentNote } from '../mode-manager/services/file-reference-service.js';
import { blockRootNoteCreation } from '../mode-manager/services/root-note-creation-service.js';
import { MS_PER_SECOND } from '../time-units.js';
import { openExcalidrawEditor } from './excalidraw-editor-service.js';
import { EXCALIDRAW_FILENAME, EXCALIDRAW_MIME_TYPE, buildEmptySceneJson } from './excalidraw-scene.js';

const OPEN_TIMEOUT_MS = 60000;
const BUSY_BANNER_SECONDS = 8;
const FAILURE_BANNER_SECONDS = 10;

// After Done, leave edit mode on the note that holds the diagram so its rendering is visible.
function showDiagramInHostNote(closed) {
    if (ModeContext.isEditing && ModeContext.currentNoteId === closed.hostNoteId) {
        void CommandGate.run('excalidraw.show_diagram', async () => {
            await actionDeselectNote();
        });
    }
}

function reportBusy(action) {
    ErrorHandler.showErrorBanner(`${action} did not start because another command is still running.`, 'error', BUSY_BANNER_SECONDS * MS_PER_SECOND, { closable: true });
}

function reportFailure(action, error) {
    const message = error instanceof UserInputRejected ? error.message : `${action} failed: ${error.message}`;
    ErrorHandler.showErrorBanner(message, 'error', FAILURE_BANNER_SECONDS * MS_PER_SECOND, { closable: true });
}

export async function openDiagramEditor(fileId, hostNoteId) {
    const settled = await settleResult(() => CommandGate.run('excalidraw.open_editor', async () => {
        await openExcalidrawEditor({ fileId, hostNoteId, isNewDiagram: false, onClosed: showDiagramInHostNote });
        return true;
    }, { timeoutMs: OPEN_TIMEOUT_MS }));
    if (!settled.ok) {
        reportFailure('Opening the diagram', settled.error);
        return;
    }
    if (settled.value === null) {
        reportBusy('Opening the diagram');
    }
}

// Creates an empty .excalidraw file, inserts its reference into the note, and opens the editor.
export async function addDiagramToNote(preferredNoteId) {
    if (preferredNoteId !== null && (typeof preferredNoteId !== 'string' || preferredNoteId.length === 0)) {
        throw new Error('addDiagramToNote requires a note id or null');
    }
    // Outside edit mode the diagram goes into a new top note, which the sort order may not allow.
    if (preferredNoteId === null && !ModeContext.isEditing && blockRootNoteCreation('top', 'addDiagram')) {
        return;
    }
    const file = new File([buildEmptySceneJson()], EXCALIDRAW_FILENAME, { type: EXCALIDRAW_MIME_TYPE });
    const settled = await settleResult(() => CommandGate.run('excalidraw.add_diagram', async () => {
        const payload = await attachPickedFileToCurrentNote(file, preferredNoteId);
        const hostNoteId = ModeContext.currentNoteId;
        if (typeof hostNoteId !== 'string' || hostNoteId.length === 0) {
            throw new Error('Adding a diagram left no current note');
        }
        await openExcalidrawEditor({ fileId: payload.file_id, hostNoteId, isNewDiagram: true, onClosed: showDiagramInHostNote });
        return true;
    }, { timeoutMs: OPEN_TIMEOUT_MS }));
    if (!settled.ok) {
        reportFailure('Adding a diagram', settled.error);
        return;
    }
    if (settled.value === null) {
        reportBusy('Adding a diagram');
    }
}

// The rendered diagram under a pointer event, with the note that references it.
export function resolveDiagramTarget(eventTarget) {
    if (!(eventTarget instanceof Element)) {
        return null;
    }
    const embed = eventTarget.closest('.note-file-excalidraw-embed[data-file-ref-id]');
    if (!(embed instanceof HTMLElement) || embed.classList.contains('note-file-excalidraw-static')) {
        return null;
    }
    // A thumbnail inside a compact reference belongs to the link, which opens the source note.
    if (embed.classList.contains('note-reference-link-thumbnail')) {
        return null;
    }
    const referenceBlock = embed.closest('.note-reference-block[data-ref-host-note-id]');
    if (!(referenceBlock instanceof HTMLElement)) {
        throw new Error('Rendered diagram is missing its reference block');
    }
    const hostNoteId = referenceBlock.dataset.refHostNoteId;
    if (typeof hostNoteId !== 'string' || hostNoteId.length === 0) {
        throw new Error('Rendered diagram is missing its host note id');
    }
    return { fileId: embed.dataset.fileRefId, hostNoteId };
}
