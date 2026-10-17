import { ApplicationState, stateValuesEqual } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { captureEditingFocus } from './viewport-hold-service.js';

// Where the user was working in the note being edited when the right button went
// down. A right-click moves the caret in some browsers (Firefox puts it at the
// pointer), so an action chosen from the menu puts it back from here
// (interaction principle 1: only the user's action changes the screen).

// As text positions (DOM nodes would not survive comparison by value).
const pressState = ApplicationState.createFields('right-press-focus', { focus: null });

// MouseEvent.button values.
const MAIN_BUTTON = 0;
const SECONDARY_BUTTON = 2;

function isRightPress(event) {
    if (event.button === SECONDARY_BUTTON) return true;
    // Control-click is the right-click on a Mac.
    return event.button === MAIN_BUTTON && event.ctrlKey;
}

function asPositions(focus) {
    if (focus.kind === 'tag-bar') {
        return { kind: 'tag-bar', start: focus.start, end: focus.end, direction: focus.direction };
    }
    return { kind: 'content', anchorPosition: focus.anchorPosition, focusPosition: focus.focusPosition };
}

export function rememberEditingFocusAtRightPress(event) {
    if (!isRightPress(event)) return;
    let next = null;
    const noteId = ModeContext.currentNoteId;
    if (ModeContext.isEditing && typeof noteId === 'string' && noteId.length > 0) {
        const noteElement = document.querySelector(`.note[data-note-id="${noteId}"]`);
        if (!(noteElement instanceof HTMLElement)) {
            throw new Error(`Edited note element missing at a right press: ${noteId}`);
        }
        const focus = captureEditingFocus(noteElement);
        if (focus !== null) {
            next = { noteId, ...asPositions(focus) };
        }
    }
    if (!stateValuesEqual(pressState.focus, next)) pressState.focus = next;
}

// The edited note's focus at the last right press, for restoreEditingFocus; null
// when that press was elsewhere or focus was outside the note.
export function editingFocusAtRightPress(noteId) {
    const focus = pressState.focus;
    if (focus === null || focus.noteId !== noteId) return null;
    if (focus.kind === 'tag-bar') {
        return { kind: 'tag-bar', start: focus.start, end: focus.end, direction: focus.direction };
    }
    return {
        kind: 'content',
        anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0,
        anchorPosition: focus.anchorPosition, focusPosition: focus.focusPosition,
    };
}
