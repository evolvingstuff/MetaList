import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyDiagram, upgradeDiagram, createShape, edgePoint, arrowGeometry, resizeShape,
    removeSelection, duplicateSelection, DiagramHistory, wrapLabel } from '../../app/static/js/modules/embedded-documents/diagram-model.js';

const style = { fill: '#dbeafe', stroke: '#334155', font_size: 18, stroke_width: 2 };
const shape = (id, x, y) => createShape('rectangle', x, y, style, id);
const source = () => ({ shapes: [shape('a', 0, 0), shape('b', 400, 0), shape('c', 400, 200)],
    arrows: [{ id: 'ab', from_id: 'a', to_id: 'b', stroke: '#334155', stroke_width: 2 },
        { id: 'bc', from_id: 'b', to_id: 'c', stroke: '#334155', stroke_width: 2 }] });

test('legacy rectangles upgrade in the draft without changing their identities or source', () => {
    const old = { kind: 'diagram', version: 1, source: { rectangles: [{ id: 'one', x: 45, y: 65, label: 'old' }] } };
    const copy = structuredClone(old);
    const upgraded = upgradeDiagram(old);
    assert.equal(upgraded.version, 2);
    assert.deepEqual(upgraded.source.shapes[0], { id: 'one', type: 'rounded', x: 45, y: 65, width: 160, height: 80,
        label: 'old', fill: '#dbeafe', stroke: '#2563eb', font_size: 16, stroke_width: 2 });
    upgraded.source.shapes[0].label = 'edited';
    assert.deepEqual(old, copy);
    assert.throws(() => upgradeDiagram({ version: 999 }), /Unsupported/);
});

test('connectors follow moved shapes and attach to their perimeter', () => {
    const first = shape('a', 0, 0), second = shape('b', 400, 0);
    assert.deepEqual(arrowGeometry(first, second, 2).start, { x: 160, y: 45 });
    assert.deepEqual(arrowGeometry(first, second, 2).end, { x: 400, y: 45 });
    second.x = 0; second.y = 300;
    assert.deepEqual(arrowGeometry(first, second, 2).start, { x: 80, y: 90 });
    assert.deepEqual(arrowGeometry(first, second, 2).end, { x: 80, y: 300 });
    first.height = 150;
    assert.equal(arrowGeometry(first, second, 2).start.y, 150);
});

test('ellipse and diamond connectors intersect their actual outline', () => {
    const ellipse = { ...shape('e', 0, 0), type: 'ellipse', width: 100, height: 100 };
    const point = edgePoint(ellipse, { x: 150, y: 150 });
    assert.ok(Math.abs(point.x - (50 + 50 / Math.sqrt(2))) < 1e-8);
    const diamond = { ...ellipse, type: 'diamond' };
    assert.deepEqual(edgePoint(diamond, { x: 150, y: 150 }), { x: 75, y: 75 });
    assert.deepEqual(edgePoint(diamond, { x: 50, y: 50 }), { x: 50, y: 50 });
});

test('resizing a northwest handle keeps the opposite corner fixed and clamps minimum size', () => {
    const original = shape('a', 100, 100);
    const resized = resizeShape(original, 'nw', 500, 500, false);
    assert.equal(resized.width, 40);
    assert.equal(resized.height, 40);
    assert.equal(resized.x + resized.width, original.x + original.width);
    assert.equal(resized.y + resized.height, original.y + original.height);
    assert.equal(resizeShape(original, 'se', 17, 9, true).width, 180);
    assert.equal(original.width, 160);
});

test('deleting a shape deletes incident arrows and preserves unrelated shapes', () => {
    const original = source();
    const next = removeSelection(original, new Set(['a']));
    assert.deepEqual(next.shapes.map(item => item.id), ['b', 'c']);
    assert.deepEqual(next.arrows.map(item => item.id), ['bc']);
    assert.equal(original.shapes.length, 3);
    assert.equal(removeSelection(original, new Set(['ab'])).shapes.length, 3);
});

test('duplicating a selection rewires internal arrows and excludes external connections', () => {
    let counter = 0;
    const next = duplicateSelection(source(), new Set(['a', 'b']), () => `copy-${++counter}`);
    const copies = next.source.shapes.filter(item => next.selected.has(item.id));
    assert.equal(copies.length, 2);
    assert.equal(next.source.arrows.length, 3);
    assert.deepEqual(next.source.arrows[2], { id: 'copy-3', from_id: 'copy-1', to_id: 'copy-2', stroke: '#334155', stroke_width: 2 });
    assert.equal(copies[0].x, 24);
});

test('a drag is one undo step, no-op gestures preserve redo, and a new edit branches history', () => {
    const state = { draft: emptyDiagram() };
    state.draft.source = source();
    const history = new DiagramHistory(state);
    const before = structuredClone(state.draft);
    for (let x = 0; x < 50; x++) state.draft.source.shapes[0].x = x;
    history.commit(before);
    assert.equal(history.past.length, 1);
    history.undo();
    assert.equal(state.draft.source.shapes[0].x, 0);
    history.commit(structuredClone(state.draft));
    assert.equal(history.future.length, 1);
    history.redo();
    assert.equal(state.draft.source.shapes[0].x, 49);
    history.undo();
    const branch = structuredClone(state.draft);
    state.draft.source.shapes[0].label = 'branch';
    history.commit(branch);
    assert.equal(history.future.length, 0);
});

test('labels retain deliberate line breaks and indicate overflow', () => {
    const item = { ...shape('a', 0, 0), label: 'first\nsecond' };
    assert.deepEqual(wrapLabel(item), ['first', 'second']);
    item.height = 40;
    assert.deepEqual(wrapLabel(item), ['firs…']);
});
