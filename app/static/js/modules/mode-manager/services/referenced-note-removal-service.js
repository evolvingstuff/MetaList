import { NotesAPI } from '../../api-client.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { CommandGate } from './command-gate-service.js';
import { actionDeselectNote } from '../actions/selection-actions.js';
import { ConfirmationModal } from '../../modals/confirmation-modal.js';
import { deleteNote, deleteNoteOutsideEdit } from '../actions/note-actions.js';

// Deleting or cutting a note breaks the references other notes have to it or
// to a note under it (docs/ui/references.md). When there are any, the user
// confirms first. The dialog is modal: a note being edited is saved and left
// before it shows (interaction principle 6).
//
// Resolves to 'unreferenced' (go ahead as before), 'confirmed' (go ahead; edit
// mode, if any, was left for the dialog), 'cancelled', or null when another
// command was running.
const VERBS = Object.freeze({ delete: 'Delete', cut: 'Cut' });

export async function confirmRemovingReferencedNote(noteId, action) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('confirmRemovingReferencedNote requires noteId');
    }
    if (!Object.hasOwn(VERBS, action)) {
        throw new Error(`Unknown note removal: ${action}`);
    }
    const count = await CommandGate.run(`${action}.count_references`, async () => {
        return await NotesAPI.getOutsideReferrerCount(noteId);
    });
    if (count === null) {
        return null;
    }
    if (count === 0) {
        return 'unreferenced';
    }
    if (ModeContext.isEditing) {
        const left = await CommandGate.run(`${action}.exit_editing_for_warning`, async () => {
            await actionDeselectNote();
        });
        if (left === null) {
            return null;
        }
    }
    const confirmed = await new ConfirmationModal().openForConfirmation(warningFor(count, VERBS[action]));
    if (confirmed) {
        return 'confirmed';
    }
    return 'cancelled';
}

function warningFor(count, verb) {
    let referring = `${count} other notes reference`;
    if (count === 1) {
        referring = '1 other note references';
    }
    return {
        eyebrow: `${verb} note`,
        title: `${referring} this note`,
        description: `${verb} it anyway? Their references will show as missing.`,
        confirmLabel: verb,
        isDangerous: true,
    };
}

// ⌘⌫ and the trash can: delete the note being edited, asking first when
// other notes reference it.
export async function deleteEditedNoteAskingIfReferenced(noteId, commandName) {
    const decision = await confirmRemovingReferencedNote(noteId, 'delete');
    if (decision === 'unreferenced') {
        await CommandGate.run(commandName, async () => {
            await deleteNote(noteId);
        });
        return;
    }
    if (decision === 'confirmed') {
        await CommandGate.run(commandName, async () => {
            await deleteNoteOutsideEdit(noteId);
        });
    }
}
