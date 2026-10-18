import { ApplicationState } from '../../application-state.js';
import { NotesAPI } from '../../api-client.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { getTagBarValue } from './tag-bar-service.js';

// Images in the note being edited show at their size (docs/ui/content-formatting.md):
// the editor shows the raw text, where a size is only a tag and braces, so the
// server says what each image's size is and the editor sets it as the image's
// --editing-image-size (main.css scales it, as a fraction of the size that fits).
// Saving drops it (it is not an allowed note style), so it is display only.
// Sizes follow typing once it pauses, and a resize at once.

// Typing pauses this long before the sizes are asked again.
const TYPING_PAUSE_MS = 500;
// An image at full size has no size property.
const FULL_SIZE = 1;
const SIZE_PROPERTY = '--editing-image-size';

const moduleState = ApplicationState.createFields('editing-image-size-service', {
    pendingTimer: null,
    requestSerial: 0,
});

function editedContent(noteId) {
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    if (!(content instanceof HTMLElement)) {
        throw new Error(`Edited note content missing: ${noteId}`);
    }
    return content;
}

// Show each image in `content` at its size; `factors` is in image order.
export function applyEditingImageSizes(content, factors) {
    if (!(content instanceof HTMLElement) || !Array.isArray(factors)) {
        throw new Error('applyEditingImageSizes requires content and factors');
    }
    const images = content.querySelectorAll('img');
    if (images.length !== factors.length) {
        throw new Error(`Editing image sizes: ${factors.length} sizes for ${images.length} images`);
    }
    images.forEach((image, index) => {
        const factor = factors[index];
        if (typeof factor !== 'number' || !(factor > 0)) {
            throw new Error(`Editing image size must be a positive number: ${factor}`);
        }
        if (factor === FULL_SIZE) {
            image.style.removeProperty(SIZE_PROPERTY);
            if (image.getAttribute('style') === '') image.removeAttribute('style');
            return;
        }
        image.style.setProperty(SIZE_PROPERTY, String(factor));
    });
}

// The edited text as the server needs it to size images: image sources are left
// out (a pasted image's data can be megabytes; only the structure matters).
function contentWithoutImageSources(content) {
    const copy = content.cloneNode(true);
    for (const image of copy.querySelectorAll('img')) {
        image.setAttribute('src', '');
    }
    return copy.innerHTML;
}

export async function refreshEditingImageSizes(noteId) {
    if (!ModeContext.isEditingNote(noteId)) return;
    const content = editedContent(noteId);
    if (content.querySelector('img') === null) return;
    const noteElement = content.closest('.note');
    moduleState.requestSerial += 1;
    const serial = moduleState.requestSerial;
    const factors = await NotesAPI.fetchEditingImageSizes(
        noteId, contentWithoutImageSources(content), getTagBarValue(noteElement),
    );
    // A later edit asked again, or the edit ended: this answer is out of date.
    if (serial !== moduleState.requestSerial) return;
    if (!ModeContext.isEditingNote(noteId)) return;
    applyEditingImageSizes(content, factors);
}

// After typing in the edited note's text or tag bar: once typing pauses.
function handleEditingInput(event) {
    if (!ModeContext.isEditing) return;
    const noteId = ModeContext.currentNoteId;
    if (typeof noteId !== 'string' || !(event.target instanceof Element)) return;
    const noteElement = event.target.closest('.note');
    if (noteElement === null || noteElement.dataset.noteId !== noteId) return;
    clearTimeout(moduleState.pendingTimer);
    moduleState.pendingTimer = setTimeout(() => {
        moduleState.pendingTimer = null;
        void refreshEditingImageSizes(noteId);
    }, TYPING_PAUSE_MS);
}

export function initEditingImageSizes() {
    document.addEventListener('input', handleEditingInput, { capture: true });
}
