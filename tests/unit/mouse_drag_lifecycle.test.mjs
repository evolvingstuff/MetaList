import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApplicationState } from '../../app/static/js/modules/application-state.js';
import { half } from '../../app/static/js/modules/half.js';
import { resolveVerticalSiblingDropDestination, updateMoveDragGestureState } from '../../app/static/js/modules/mode-manager/services/note-drag-service.js';
import { selectTagOnDoubleClick } from '../../app/static/js/modules/mode-manager/services/tag-input-selection-service.js';
import { unlessDiagramEditorOpen } from '../../app/static/js/modules/excalidraw/excalidraw-editor-state.js';

const source = readFileSync(new URL(
    '../../app/static/js/modules/mode-manager/events/mouse-events.js', import.meta.url,
), 'utf8').replace(/^import[\s\S]*?from '[^']+';\s*/gm, '').replace(/^export /gm, '');

function harness() {
    // All drag-visual preferences are on by default.
    const classes = new Set(['pref-drag-ghost', 'pref-drop-indicator', 'pref-drag-direction-icon']);
    const listeners = new Map();
    const register = (type, handler) => listeners.set(type, [...(listeners.get(type) || []), handler]);  // shockharness: ignore[DEF003] reason="the fake answers like the real API: null or empty when absent"
    const actions = [];
    const indicators = [];
    let now = 100;
    class FakeElement {}
    const noteLike = (id, rect) => Object.assign(new FakeElement(), {
        dataset: { noteId: id },
        classList: { contains: name => name === 'note' },
        getBoundingClientRect: () => rect,
        querySelector: () => null,
        previousElementSibling: null,
        nextElementSibling: null,
    });
    // A root note with one sibling below it and nothing above it.
    const noteElement = noteLike('note-1', { left: 100, top: 200, width: 600, height: 40, bottom: 240 });
    const below = noteLike('note-2', { left: 100, top: 244, width: 600, height: 40, bottom: 284 });
    noteElement.nextElementSibling = below;
    below.previousElementSibling = noteElement;
    noteElement.closest = selector => (selector === '#notes-container > .note' ? noteElement : null);
    below.closest = selector => (selector === '#notes-container > .note' ? below : null);
    noteElement.parentElement = { children: [noteElement, below] };
    below.parentElement = noteElement.parentElement;
    const dependencies = {
        DOMUtils: { getNoteById: id => (id === 'note-2' ? below : noteElement), getNoteId: element => element.dataset.noteId },
        renderNoteDragIndicators: description => indicators.push(description),
        hideNoteDragIndicators: () => indicators.push('hidden'),
        isRootReorderLocked: () => false,
        // Records any move a release would start.
        CommandGate: { run: name => actions.push(name) },
        HTMLElement: FakeElement,
        ApplicationState, resolveVerticalSiblingDropDestination, updateMoveDragGestureState, selectTagOnDoubleClick,
        document: {
            addEventListener: register,
            // A detached probe resolving the child indentation (32px).
            createElement: () => ({ style: {}, getBoundingClientRect: () => ({ width: 32 }), remove() {} }),
            body: { appendChild() {}, classList: {
            toggle: (name, active) => active ? classes.add(name) : classes.delete(name),
            contains: name => classes.has(name),
        } } },
        window: {
            getSelection: () => null, addEventListener: register,
            getComputedStyle: () => ({ borderLeftWidth: '1px', paddingLeft: '4px' }),
        },
        ModeContext: { isEditing: false, isConnected: true, activeTabSortMode: 'normal' },
        performance: { now: () => now },
        Node: Object,
        Element: Object,
        Logger: { logNoop() {}, logInit() {} },
        half,
        recordCollapse: () => actions.push('collapse'),
        unlessDiagramEditorOpen, resolveDiagramTarget: () => null, openDiagramEditor: () => {},
    };
    const handlers = new Function(...Object.keys(dependencies), `${source}
        handleImmediateMouseDown = () => {};
        handleMoveDragMouseDown = () => {};
        handleSelectionDragMouseDown = () => {};
        handleCollapseToggleInteraction = recordCollapse;
        initMouseEvents();
        return {
        move: handleMoveDragMouseMove, up: handleMoveDragMouseUp, state: moduleState,
        consumeMouseDownClick: consumeClickAfterMouseDownAction,
    };`)(...Object.values(dependencies));
    return { ...handlers, actions, classes, indicators, setTime: value => { now = value; },
        dispatch: (type, mouseEvent) => (listeners.get(type) || []).forEach(handler => handler(mouseEvent)),  // shockharness: ignore[DEF003] reason="the fake answers like the real API: null or empty when absent"
    };
}

function dragContext(overrides = {}) {
    return {
        noteId: 'note-1', startX: 10, startY: 10, dragActive: false, hasCrossedActivationThreshold: false,
        ghostRect: null, lastX: 10, lastY: 10, ...overrides,
    };
}

function event(clientX = 10, clientY = 10) {
    return { button: 0, type: 'mouseup', clientX, clientY, preventDefault() {}, stopPropagation() {} };
}

test('ordinary mouse-up without a drag does not clear absent drag state', () => {
    const h = harness();
    h.up(event());
    h.up(event());
    assert.equal(h.state.moveDragContext, null);
    assert.throws(() => { h.state.moveDragContext = null; }, /Redundant/);
});

test('a short gesture is released once and subsequent mouse-up has no drag to clear', () => {
    const h = harness();
    h.state.moveDragContext = dragContext();
    h.up(event());
    assert.equal(h.state.moveDragContext, null);
    h.up(event());
});

test('drag threshold records the first crossing across repeated movement and return to origin', () => {
    const h = harness();
    h.state.moveDragContext = dragContext();
    h.move(event(11, 11));
    h.move(event(11, 11));
    assert.equal(h.state.moveDragContext.hasCrossedActivationThreshold, false);
    h.move(event(10, 20));
    h.move(event(10, 21));
    assert.equal(h.state.moveDragContext.dragActive, true);
    assert.equal(h.state.moveDragContext.hasCrossedActivationThreshold, true);
    h.move(event());
    assert.equal(h.state.moveDragContext.dragActive, false);
    assert.equal(h.state.moveDragContext.hasCrossedActivationThreshold, true);
    h.up(event());
    assert.equal(h.state.moveDragContext, null);
    assert.equal(h.state.ignoreClickAfterMoveDrag.ignoreUntil, 600);
});

test('a collapse mousedown with no subsequent click cannot poison the next gesture', () => {
    const h = harness();
    class Toggle {
        closest(selector) { return ['.note-collapse-toggle', '.note'].includes(selector) ? this : null; }
    }
    const toggle = new Toggle();
    for (let count = 0; count < 2; count += 1) {
        h.dispatch('mousedown', { ...event(), type: 'mousedown', target: toggle });
    }
    assert.equal(h.actions.length, 2);
    h.setTime(5000);
    assert.equal(h.consumeMouseDownClick({ ...event(), target: toggle }), true);
    assert.equal(h.state.ignoreClickAfterMouseDownAction, null);
    assert.equal(h.consumeMouseDownClick({ ...event(), target: toggle }), false);
});

test('blur cancels an interrupted drag and pending clicks, including repeated blur', () => {
    const h = harness();
    h.state.moveDragContext = { dragActive: true };
    h.state.selectionDragContext = { noteId: 'note-1' };
    h.state.ignoreClickAfterMoveDrag = { ignoreUntil: 600 };
    h.state.ignoreClickAfterSelectionDrag = { noteId: 'note-1', ignoreUntil: 600 };
    h.state.ignoreClickAfterMouseDownAction = { target: null, reason: 'test' };
    h.classes.add('note-drag-active');
    h.dispatch('blur', {});
    h.dispatch('blur', {});
    assert.equal(h.classes.has('note-drag-active'), false);
    assert(Object.values(h.state).every(value => value === null));
});

test('unrelated and keyboard clicks discard stale suppression without being consumed', () => {
    const h = harness();
    class Target { contains() { return false; } }
    const target = new Target();
    for (const click of [{ target: new Target(), detail: 1 }, { target, detail: 0 }]) {
        h.state.ignoreClickAfterMouseDownAction = { target, reason: 'collapse_toggle' };
        assert.equal(h.consumeMouseDownClick({ ...event(), ...click }), false);
        assert.equal(h.state.ignoreClickAfterMouseDownAction, null);
    }
});

test('releasing another mouse button does not end a left-button drag', () => {
    const h = harness();
    h.state.moveDragContext = { noteId: 'note-1', startX: 10, startY: 10, dragActive: false, hasCrossedActivationThreshold: false };
    h.up({ ...event(), button: 2 });
    assert.equal(h.state.moveDragContext.noteId, 'note-1');
    h.up(event());
    assert.equal(h.state.moveDragContext, null);
});

test('the drag ghost stays on the drag axis and indicators clear when the drag ends', () => {
    const h = harness();
    h.state.moveDragContext = dragContext();
    h.move(event(14, 40));  // mostly vertical: reorder axis
    h.move(event(60, 45));  // mostly horizontal: indent axis
    const [vertical, horizontal] = h.indicators;
    assert.equal(vertical.drop, null);
    // Down to the bottom of the last sibling; no sideways travel for a root
    // note with nothing above it to nest under.
    const rect = { left: 100, top: 200, width: 600, height: 40, minOffsetX: 0, maxOffsetX: 0, minOffsetY: 0, maxOffsetY: 44 };
    assert.deepEqual(vertical.ghost, { rect, offsetX: 0, offsetY: 30 });
    assert.deepEqual(horizontal.ghost, { rect, offsetX: 0, offsetY: 0 });
    // Indent with no note above it changes nothing, so no drop is indicated.
    assert.equal(horizontal.drop, null);
    h.move(event());  // back to the origin: the drag deactivates
    assert.equal(h.indicators.at(-1), 'hidden');
    h.state.moveDragContext = dragContext();
    h.move(event(10, 40));
    h.dispatch('blur', event());
    assert.equal(h.indicators.at(-1), 'hidden');
    assert.equal(h.state.moveDragContext, null);
});

test('a root note ghost cannot be dragged left past the root column', () => {
    const h = harness();
    h.state.moveDragContext = dragContext();
    h.move(event(-70, 14));  // a clear outdent drag of a root note
    assert.equal(h.indicators.at(-1).ghost.offsetX, 0);
    assert.equal(h.indicators.at(-1).drop, null);
});

test('the ghost cannot be dragged below the lowest sibling or above the first', () => {
    const h = harness();
    h.state.moveDragContext = dragContext();
    h.move(event(12, 400));  // far below the last sibling
    assert.equal(h.indicators.at(-1).ghost.offsetY, 44);
    h.move(event(12, -300));  // far above the first sibling
    assert.equal(h.indicators.at(-1).ghost.offsetY, 0);
});

test('with all drag visuals turned off, a drag renders nothing', () => {
    const h = harness();
    h.classes.delete('pref-drag-ghost');
    h.classes.delete('pref-drop-indicator');
    h.classes.delete('pref-drag-direction-icon');
    h.state.moveDragContext = dragContext();
    h.move(event(12, 40));
    assert.equal(h.state.moveDragContext.dragActive, true);
    assert.deepEqual(h.indicators, []);
});

test('the cursor names only moves a release could make', () => {
    // The first root note: nothing above it to move past or nest under, no parent.
    const first = harness();
    first.state.moveDragContext = dragContext();
    const firstCursors = [];
    for (const [x, y] of [[12, -20], [60, 12], [-40, 12], [12, 280]]) {
        first.move(event(x, y));
        firstCursors.push(first.indicators.at(-1).cursor);
    }
    // Up, indent and outdent are impossible; down past the next sibling is not.
    assert.deepEqual(firstCursors, [null, null, null, 'down']);

    // The second root note can move above the first, or nest under it.
    const second = harness();
    second.state.moveDragContext = dragContext({ noteId: 'note-2', startY: 300, lastY: 300 });
    second.move(event(12, 210));
    assert.equal(second.indicators.at(-1).cursor, 'up');
    second.move(event(70, 300));
    assert.equal(second.indicators.at(-1).cursor, 'indent');
});

test('overshooting the sibling block moves the note to that end of its siblings', () => {
    // note-1 is first of two; far below the block means "move to the end".
    const h = harness();
    h.state.moveDragContext = dragContext();
    h.move(event(12, 400));
    assert.equal(h.indicators.at(-1).cursor, 'down');
    assert.notEqual(h.indicators.at(-1).drop, null);
    h.up({ ...event(12, 400), target: undefined });
    assert.deepEqual(h.actions, ['mouse.drag_reorder_down']);

    // note-2 is last; far above the block means "move to the start".
    const second = harness();
    second.state.moveDragContext = dragContext({ noteId: 'note-2', startY: 300, lastY: 300 });
    second.move(event(12, 150));
    assert.equal(second.indicators.at(-1).cursor, 'up');

    // Already last: overshooting below changes nothing, so no icon and no move.
    const last = harness();
    last.state.moveDragContext = dragContext({ noteId: 'note-2', startY: 300, lastY: 300 });
    last.move(event(12, 500));
    assert.equal(last.indicators.at(-1).cursor, null);
    last.up({ ...event(12, 500), target: undefined });
    assert.deepEqual(last.actions, []);
});
