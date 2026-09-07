import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { emptyDiagram, newArrow, free, routePoints, DiagramHistory } from '../../app/static/js/modules/embedded-documents/diagram-document.js';
import { createTextEditor } from '../../app/static/js/modules/embedded-documents/diagram-text-editor.js';
const sourceCode = readFileSync(new URL('../../app/static/js/modules/embedded-documents/diagram-editor.js', import.meta.url), 'utf8');
function functionSource(startName, endName) {
    const start = sourceCode.indexOf(startName), end = sourceCode.indexOf(endName, start);
    assert.ok(start >= 0 && end > start); return sourceCode.slice(start, end);
}

test('finishing the actual route gesture records one undoable free arrow', () => {
    const state = { draft: emptyDiagram() }, history = new DiagramHistory(state);
    const dependencies = { state, history, newArrow, routePoints, crypto: { randomUUID: () => 'arrow' },
        pending: { start: free({ x: 0, y: 0 }), end: free({ x: 300, y: 100 }), points: [{ x: 100, y: 0 }, { x: 100, y: 100 }] },
        source: () => state.draft.source, snapshot: () => structuredClone(state.draft), commit: before => history.commit(before), render() {} };
    const run = new Function(...Object.keys(dependencies), `let selected, hover, tool, lastFinish; ${functionSource('    function finishArrow()', '    function fit()')} return finishArrow;`)(...Object.values(dependencies));
    run(); run(); // A repeated finishing event must not add another arrow/history entry.
    assert.equal(state.draft.source.arrows.length, 1); assert.equal(history.past.length, 1);
    const arrow = state.draft.source.arrows[0]; assert.equal(arrow.end_head, true); assert.equal(arrow.end.kind, 'free');
    history.undo(); assert.equal(state.draft.source.arrows.length, 0); history.redo(); assert.equal(state.draft.source.arrows[0].id, 'arrow');
});

test('canceling the actual drag restores source without adding history or destroying redo', () => {
    const state = { draft: emptyDiagram() }, history = new DiagramHistory(state), original = structuredClone(state.draft);
    state.draft.source.grid.size = 20; history.commit(original); history.undo();
    state.draft.source.grid.size = 50;
    const dependencies = { state, history, drag: { kind: 'move', before: original, pointerId: 1 }, canvas: { hasPointerCapture() { return true; }, releasePointerCapture() {} }, render() {} };
    const run = new Function(...Object.keys(dependencies), `let hover, tool; ${functionSource('    function finishDrag(cancel)', "    canvas.addEventListener('pointerup'")} return finishDrag;`)(...Object.values(dependencies));
    run(true); assert.deepEqual(state.draft, original); assert.equal(history.past.length, 0); assert.equal(history.future.length, 1);
});

test('formatting restores the selected text range after a properties control takes focus', () => {
    const previousDocument = globalThis.document, previousWindow = globalThis.window, events = new Map(), commands = [];
    const range = { cloneRange() { return this; } }, textNode = {}, unrelated = {};
    const selection = { rangeCount: 1, anchorNode: textNode, focusNode: textNode, getRangeAt: () => range,
        removeAllRanges() { this.rangeCount = 0; }, addRange(next) { this.rangeCount = 1; this.range = next; } };
    const editor = { addEventListener() {}, contains: node => node === textNode, focus() {} };
    let changes = 0;
    globalThis.window = { getSelection: () => selection };
    globalThis.document = { addEventListener(name, callback) { events.set(name, callback); }, removeEventListener(name) { events.delete(name); },
        execCommand(command, _showUi, value) { commands.push({ command, value, range: selection.range }); } };
    try {
        const control = createTextEditor(editor, () => changes++);
        events.get('selectionchange')();
        selection.anchorNode = unrelated; selection.focusNode = unrelated; events.get('selectionchange')();
        control.format('color', '#ff0000');
        assert.deepEqual(commands, [{ command: 'foreColor', value: '#ff0000', range }]); assert.equal(changes, 1);
        control.destroy(); assert.equal(events.size, 0);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; }
});

test('the global context menu yields to the diagram before inspecting underlying rails', () => {
    const code = readFileSync(new URL('../../app/static/js/modules/mode-manager/events/context-menu-events.js', import.meta.url), 'utf8');
    const start = code.indexOf('function handleContextMenu(event)'), end = code.indexOf('export function initContextMenuEvents()', start);
    assert.ok(start >= 0 && end > start);
    const handler = new Function('ModeContext', 'resolveEventElement', `${code.slice(start, end)} return handleContextMenu;`)(
        { isLoading: false }, () => ({ closest(selector) { assert.equal(selector, '.embedded-document-editor'); return {}; } }));
    handler({ target: {} });
});
