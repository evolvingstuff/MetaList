import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApplicationState } from '../../app/static/js/modules/application-state.js';
import { updateMoveDragGestureState } from '../../app/static/js/modules/mode-manager/services/note-drag-service.js';
import { selectTagOnDoubleClick } from '../../app/static/js/modules/mode-manager/services/tag-input-selection-service.js';

const source = readFileSync(new URL(
    '../../app/static/js/modules/mode-manager/events/mouse-events.js', import.meta.url,
), 'utf8').replace(/^import[\s\S]*?from '[^']+';\s*/gm, '').replace(/^export /gm, '');

function harness() {
    const classes = new Set();
    const listeners = new Map();
    const register = (type, handler) => listeners.set(type, [...(listeners.get(type) || []), handler]);
    const actions = [];
    let now = 100;
    const dependencies = {
        ApplicationState, updateMoveDragGestureState, selectTagOnDoubleClick,
        document: { addEventListener: register, body: { classList: {
            toggle: (name, active) => active ? classes.add(name) : classes.delete(name),
        } } },
        window: { getSelection: () => null, addEventListener: register },
        ModeContext: { isEditing: false, isConnected: true },
        performance: { now: () => now },
        Node: Object,
        Element: Object,
        Logger: { logNoop() {}, logInit() {} },
        recordCollapse: () => actions.push('collapse'),
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
    return { ...handlers, actions, classes, setTime: value => { now = value; },
        dispatch: (type, mouseEvent) => (listeners.get(type) || []).forEach(handler => handler(mouseEvent)),
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
    h.state.moveDragContext = { noteId: 'note-1', startX: 10, startY: 10, dragActive: false, hasCrossedActivationThreshold: false };
    h.up(event());
    assert.equal(h.state.moveDragContext, null);
    h.up(event());
});

test('drag threshold records the first crossing across repeated movement and return to origin', () => {
    const h = harness();
    h.state.moveDragContext = { noteId: 'note-1', startX: 10, startY: 10, dragActive: false, hasCrossedActivationThreshold: false };
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
