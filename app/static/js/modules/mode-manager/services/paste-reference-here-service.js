import { ApplicationState, stateValuesEqual } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { caretPositionAt, textOffsetOfPoint, textPositionToNodePoint } from './viewport-hold-service.js';

// Paste Reference Into Note (docs/ui/references.md): the reference goes where the
// right-click was in the text of the note being edited, or replaces the text
// selected before the right-click. "Before" matters: on macOS the browser
// selects the word under the pointer as the right button goes down, and a word
// selected that way is not the user's selection.

// The edited note's selection when the right button went down, as text
// positions in its content (a Range would not survive comparison by value).
const pressState = ApplicationState.createFields('paste-reference-here', { selection: null });

// MouseEvent.button values.
const MAIN_BUTTON = 0;
const SECONDARY_BUTTON = 2;

function isRightPress(event) {
    if (event.button === SECONDARY_BUTTON) return true;
    // Control-click is the right-click on a Mac.
    return event.button === MAIN_BUTTON && event.ctrlKey;
}

function editedNoteContent(noteId) {
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    if (!(content instanceof HTMLElement)) {
        throw new Error(`Edited note content missing: ${noteId}`);
    }
    return content;
}

function selectionIn(content) {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    if (!content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) return null;
    const range = selection.getRangeAt(0);
    return {
        start: textOffsetOfPoint(content, range.startContainer, range.startOffset),
        end: textOffsetOfPoint(content, range.endContainer, range.endOffset),
    };
}

export function rememberSelectionAtRightPress(event) {
    if (!isRightPress(event)) return;
    let next = null;
    const noteId = ModeContext.currentNoteId;
    if (ModeContext.isEditing && typeof noteId === 'string' && noteId.length > 0) {
        const selection = selectionIn(editedNoteContent(noteId));
        if (selection !== null) {
            next = { noteId, ...selection };
        }
    }
    if (!stateValuesEqual(pressState.selection, next)) pressState.selection = next;
}

// Where Paste Reference Into Note puts the reference for a right-click on
// `target` at (x, y) in `noteElement`: the selection made before the
// right-click when the click was inside it, else the point clicked. null when
// the click was not in the text of the note being edited.
export function pasteReferenceHereRange(noteElement, target, x, y) {
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error('pasteReferenceHereRange requires the note element');
    }
    const noteId = noteElement.dataset.noteId;
    if (!ModeContext.isEditingNote(noteId)) return null;
    const content = editedNoteContent(noteId);
    if (!(target instanceof Node) || !content.contains(target)) return null;
    const point = caretPositionAt(x, y);
    if (point === null || !content.contains(point.node)) return null;

    const range = document.createRange();
    const selection = pressState.selection;
    if (selection !== null && selection.noteId === noteId) {
        const clicked = textOffsetOfPoint(content, point.node, point.offset);
        if (clicked >= selection.start && clicked <= selection.end) {
            const start = textPositionToNodePoint(content, selection.start, 'forward');
            const end = textPositionToNodePoint(content, selection.end, 'backward');
            if (start === null || end === null) {
                throw new Error('The selection made before the right-click is no longer in the note');
            }
            range.setStart(start.node, start.offset);
            range.setEnd(end.node, end.offset);
            return range;
        }
    }
    range.setStart(point.node, point.offset);
    range.collapse(true);
    return range;
}
