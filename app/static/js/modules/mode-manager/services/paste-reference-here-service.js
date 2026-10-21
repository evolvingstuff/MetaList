import { ApplicationState, stateValuesEqual } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { caretPositionAt } from './viewport-hold-service.js';

// Paste Reference Into Note (docs/ui/references.md): the reference goes where the
// right-click was in the text of the note being edited, or replaces the text
// selected before the right-click. "Before" matters: on macOS the browser
// selects the word under the pointer as the right button goes down, and a word
// selected that way is not the user's selection.

// The edited note's selection when the right button went down, as each end's
// place in its content: the child positions from the content down to the node,
// and the offset there (a Range would not survive comparison by value). Not as
// text positions: a selection of images has no text, so it had none to find
// again, and right-clicking selected images threw.
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

function placeOfPoint(content, node, offset) {
    const path = [];
    let current = node;
    while (current !== content) {
        const parent = current.parentNode;
        if (parent === null) {
            throw new Error('A selection end is outside the edited note');
        }
        path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
        current = parent;
    }
    return { path, offset };
}

// The node at a place's path, or null once the content no longer has it.
function nodeAtPlace(content, place) {
    let node = content;
    for (const index of place.path) {
        if (index >= node.childNodes.length) return null;
        node = node.childNodes[index];
    }
    return node;
}

function selectionIn(content) {
    const selection = window.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    if (!content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) return null;
    const range = selection.getRangeAt(0);
    return {
        start: placeOfPoint(content, range.startContainer, range.startOffset),
        end: placeOfPoint(content, range.endContainer, range.endOffset),
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
        // The right-press and the menu are one gesture: nothing redraws the note between them.
        const startNode = nodeAtPlace(content, selection.start);
        const endNode = nodeAtPlace(content, selection.end);
        if (startNode === null || endNode === null) {
            throw new Error('The selection made before the right-click is no longer in the note');
        }
        range.setStart(startNode, selection.start.offset);
        range.setEnd(endNode, selection.end.offset);
        if (range.isPointInRange(point.node, point.offset)) {
            return range;
        }
    }
    range.setStart(point.node, point.offset);
    range.collapse(true);
    return range;
}
