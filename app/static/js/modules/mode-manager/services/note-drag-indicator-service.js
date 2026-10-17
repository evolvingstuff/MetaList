// Visual feedback for note move drags, drawn entirely as page overlays so the
// dragged and target notes themselves never change:
// - a ghost outline of the dragged note's row, locked to the drag's axis
//   (vertical for reordering, horizontal for indent/outdent);
// - an outline over the note the drop is relative to, plus an insertion line
//   showing where (and at what depth) the note will land.
// All overlays ignore the pointer, so hit-testing still sees the notes below.
import { ApplicationState } from '../../application-state.js';

const moduleState = ApplicationState.createFields('note-drag-indicator-service', {
    overlays: null,
});

// While dragging, the cursor itself names the action (see main.css): the
// Move Note to Top arrow for up, its mirror for down, and indent/outdent icons.
const DIRECTION_CURSOR_CLASSES = {
    up: 'note-drag-cursor-up',
    down: 'note-drag-cursor-down',
    indent: 'note-drag-cursor-indent',
    outdent: 'note-drag-cursor-outdent',
};
// The insertion line is this thick, drawn from 1px above the drop position.
const DROP_LINE_THICKNESS_PX = 2;
// Only a move a release would make gets an icon; otherwise the cursor stays
// the plain grabbing hand.
function applyDirectionCursor(kind) {
    if (kind !== null && !Object.hasOwn(DIRECTION_CURSOR_CLASSES, kind)) {
        throw new Error(`Unknown drag direction cursor: ${kind}`);
    }
    const classes = document.body.classList;
    for (const [name, className] of Object.entries(DIRECTION_CURSOR_CLASSES)) {
        classes.toggle(className, name === kind);
    }
}

function ensureOverlays() {
    if (moduleState.overlays !== null) {
        return moduleState.overlays;
    }
    const body = document.body;
    if (!body) {
        throw new Error('Document body missing while creating drag indicators');
    }
    const make = (className) => {
        const element = document.createElement('div');
        element.className = className;
        element.hidden = true;
        element.setAttribute('aria-hidden', 'true');
        body.appendChild(element);
        return element;
    };
    moduleState.overlays = {
        ghost: make('note-drag-ghost'),
        target: make('note-drop-target'),
        line: make('note-drop-line'),
    };
    return moduleState.overlays;
}

function placeOverlay(element, { left, top, width, height }) {
    for (const [name, value] of [['left', left], ['top', top], ['width', width], ['height', height]]) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(`Drag indicator ${name} must be a finite number`);
        }
    }
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    if (element.hidden) element.hidden = false;
}

function hideOverlay(element) {
    if (!element.hidden) element.hidden = true;
}

// ghost: { rect, offsetX, offsetY } where rect is the dragged row's starting
// viewport rect and the offsets are the axis-locked pointer movement.
// drop: null, or { targetRect, line: { left, top, width } } in viewport pixels.
// cursor: up|down|indent|outdent for the move a release would make, or null.
export function renderNoteDragIndicators({ ghost, drop, cursor }) {
    if (!ghost || typeof ghost !== 'object' || !ghost.rect) {
        throw new Error('renderNoteDragIndicators requires a ghost description');
    }
    const overlays = ensureOverlays();
    placeOverlay(overlays.ghost, {
        left: ghost.rect.left + ghost.offsetX,
        top: ghost.rect.top + ghost.offsetY,
        width: ghost.rect.width,
        height: ghost.rect.height,
    });
    // A release that would change nothing greys the ghost out; the caller
    // passes no cursor for it, since that move is not possible from here.
    overlays.ghost.classList.toggle('is-noop', drop === null);
    if (drop === null && cursor !== null) {
        throw new Error('A drag with no possible drop must not show a direction cursor');
    }
    applyDirectionCursor(cursor);
    if (drop === null) {
        hideOverlay(overlays.target);
        hideOverlay(overlays.line);
        return;
    }
    if (typeof drop !== 'object' || !drop.targetRect || !drop.line) {
        throw new Error('renderNoteDragIndicators drop must be null or describe a target and line');
    }
    placeOverlay(overlays.target, drop.targetRect);
    placeOverlay(overlays.line, { left: drop.line.left, top: drop.line.top - 1, width: drop.line.width, height: DROP_LINE_THICKNESS_PX });
}

export function hideNoteDragIndicators() {
    applyDirectionCursor(null);
    if (moduleState.overlays === null) {
        return;
    }
    for (const element of Object.values(moduleState.overlays)) {
        hideOverlay(element);
    }
}
