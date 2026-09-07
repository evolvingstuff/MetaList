import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { emptyDiagram, upgradeDocument, newShape, newArrow, free, getObject, routePoints, roundedPath, headPoints,
    labelLines, growShape, documentBounds, snapPoint, connectionAt, endpointPosition, groupObjects, ungroupObjects,
    moveObjects, expandSelection, copyObjects, removeObjects, reorder, DiagramHistory } from '../../app/static/js/modules/embedded-documents/diagram-document.js';
import { mergeRuns } from '../../app/static/js/modules/embedded-documents/diagram-text-editor.js';
const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/diagram-v3.json', import.meta.url), 'utf8'));
const ids = () => { let count = 0; return () => `copy-${count++}`; };

test('legacy upgrades are draft-only and preserve straight floating connections', () => {
    const old = { kind: 'diagram', version: 1, source: { rectangles: [{ id: 'a', x: 50, y: 40, label: 'old' }] } };
    const original = structuredClone(old), next = upgradeDocument(old);
    assert.equal(next.version, 3); assert.equal(next.source.shapes[0].runs[0].text, 'old');
    next.source.shapes[0].runs[0].text = 'new'; assert.deepEqual(old, original);
    const v2 = { kind: 'diagram', version: 2, source: { shapes: fixture().source.shapes.map(({ runs, ...shape }) => ({ ...shape, label: 'old' })), arrows: [{ id: 'ab', from_id: 'a', to_id: 'b', stroke: '#000000', stroke_width: 2 }] } };
    const converted = upgradeDocument(v2); assert.equal(converted.source.arrows[0].routing, 'straight');
    assert.equal(converted.source.arrows[0].start.kind, 'floating'); assert.equal(routePoints(converted.source, converted.source.arrows[0]).length, 2);
});
test('new shapes always use default styling, independently of prior objects', () => {
    const first = newShape('rectangle', { x: 0, y: 0 }, 'a'); first.fill = '#ff0000'; first.font_size = 40;
    const second = newShape('rounded', { x: 10, y: 10 }, 'b'); assert.equal(second.fill, '#dbeafe'); assert.equal(second.font_size, 18);
});
test('placed bends survive movement of one endpoint and preserve orthogonal segments', () => {
    const source = fixture().source, before = structuredClone(source);
    const moved = moveObjects(source, new Set(['a']), 20, 50), arrow = moved.arrows[0];
    assert.deepEqual(arrow.points, before.arrows[0].points);
    assert.deepEqual(routePoints(source, source.arrows[0]), [{ x: 160, y: 45 }, { x: 250, y: 45 }, { x: 250, y: 245 }, { x: 400, y: 245 }]);
    const points = routePoints(moved, arrow);
    for (let i = 1; i < points.length; i++) assert.ok(points[i].x === points[i - 1].x || points[i].y === points[i - 1].y);
    assert.deepEqual(source, before); assert.match(roundedPath(points), / Q /);
});
test('free endpoints retain arrowheads, routes and Fit bounds with no shapes', () => {
    const source = emptyDiagram().source;
    const arrow = newArrow(free({ x: -600, y: 0 }), free({ x: 0, y: 800 }), [{ x: -600, y: 800 }], 'free');
    source.arrows.push(arrow); source.order.push('free');
    const points = routePoints(source, arrow); assert.equal(arrow.end_head, true);
    assert.equal(headPoints(points.at(-1), points.at(-2), 2).length, 3);
    assert.deepEqual(documentBounds(source), { x: -600, y: 0, width: 600, height: 800 });
    arrow.points.push({ x: -600, y: 800 }); assert.equal(routePoints(source, arrow).length, 3);
});
test('connection points snap and follow box resize; grid bypass is independent', () => {
    const source = fixture().source, end = connectionAt(source, { x: 159, y: 44 }, 10);
    assert.deepEqual(end, { kind: 'attached', shape_id: 'a', u: 1, v: .5 });
    source.shapes[0].width = 300; assert.deepEqual(endpointPosition(source, end, { x: 0, y: 0 }), { x: 300, y: 45 });
    assert.deepEqual(snapPoint({ x: 24, y: -17 }, source.grid, false), { x: 20, y: -20 });
    assert.deepEqual(snapPoint({ x: 24, y: -17 }, source.grid, true), { x: 24, y: -17 });
    source.grid.visible = false; assert.equal(snapPoint({ x: 24, y: 0 }, source.grid, false).x, 20);
});
test('invisible groups include internal connections and move without changing style', () => {
    const source = groupObjects(fixture().source, new Set(['a', 'b']), 'group');
    assert.deepEqual(new Set(source.groups[0].members), new Set(['a', 'b', 'ab']));
    const moved = moveObjects(source, new Set(['a']), 20, -10);
    assert.equal(moved.shapes[1].x, 420); assert.deepEqual(moved.arrows[0].points[0], { x: 270, y: 35 });
    assert.deepEqual(moved.shapes[0].runs, source.shapes[0].runs);
    assert.deepEqual(ungroupObjects(moved, new Set(['b'])).groups, []);
    assert.deepEqual(source.order, fixture().source.order);
});
test('group movement preserves external connector route and fixed outside endpoint', () => {
    let source = fixture().source; source.shapes.push(newShape('rectangle', { x: 0, y: 400 }, 'c')); source.order.push('c');
    source = groupObjects(source, new Set(['a', 'c']), 'g'); const moved = moveObjects(source, new Set(['c']), 30, 30);
    assert.equal(moved.shapes[1].x, 400); assert.deepEqual(moved.arrows[0], source.arrows[0]);
});
test('copies preserve styles, groups and internal connections with fresh IDs', () => {
    const source = groupObjects(fixture().source, new Set(['a', 'b']), 'group'), copy = copyObjects(source, new Set(['a']), ids());
    assert.equal(copy.shapes.length, 2); assert.equal(copy.arrows.length, 1); assert.equal(copy.groups.length, 1);
    assert.equal(copy.arrows[0].start.shape_id, copy.shapes[0].id); assert.equal(copy.arrows[0].end.shape_id, copy.shapes[1].id);
    assert.deepEqual(copy.shapes[0].runs, source.shapes[0].runs); assert.notEqual(copy.groups[0].id, 'group');
    assert.equal(expandSelection(copy, new Set([copy.shapes[0].id])).size, 3);
});
test('an explicitly copied external connection detaches instead of referencing an original', () => {
    const source = fixture().source, copy = copyObjects(source, new Set(['a', 'ab']), ids());
    assert.equal(copy.arrows[0].start.shape_id, copy.shapes[0].id);
    assert.deepEqual(copy.arrows[0].end, { kind: 'free', x: 400, y: 245 });
});
test('stacking moves selected objects as a block and deletion cleans groups and connections', () => {
    const source = fixture().source; assert.deepEqual(reorder(source, new Set(['ab', 'a']), true).order, ['b', 'ab', 'a']);
    assert.deepEqual(reorder(source, new Set(['b']), false).order, ['b', 'ab', 'a']);
    const removed = removeObjects(source, new Set(['a'])); assert.deepEqual(removed.order, ['b']); assert.equal(removed.arrows.length, 0);
});
test('formatted labels wrap consistently, retain styles and grow without shrinking', () => {
    const shape = fixture().source.shapes[0];
    const lines = labelLines(shape, shape.width - 24);
    assert.deepEqual(lines.map(line => line.map(c => c.text).join('')), ['Hello world!', 'MW 中文']);
    const widths = lines.map(line => line.reduce((sum, char) => sum + char.advance, 0));
    assert.ok(Math.abs(widths[0] - 110.550528) < 1e-9); assert.ok(Math.abs(widths[1] - 82.495584) < 1e-9);
    assert.equal(lines[0].at(-1).color, '#ff0000'); assert.equal(lines[0].at(-1).bold, true);
    shape.width = 45; growShape(shape); assert.ok(shape.height > 90);
    const height = shape.height; shape.runs = []; growShape(shape); assert.equal(shape.height, height);
});
test('a gesture is one draft undo step; cancellation does not consume redo', () => {
    const state = { draft: fixture() }, history = new DiagramHistory(state), before = structuredClone(state.draft);
    for (let i = 0; i < 25; i++) state.draft.source = moveObjects(before.source, new Set(['a']), i, i);
    history.commit(before); assert.equal(history.past.length, 1); history.undo(); assert.deepEqual(state.draft, before);
    const canceled = structuredClone(state.draft); state.draft.source = moveObjects(state.draft.source, new Set(['a']), 30, 30); state.draft = canceled;
    assert.equal(history.commit(canceled), false); assert.equal(history.future.length, 1); history.redo(); assert.equal(state.draft.source.shapes[0].x, 24);
});
test('adjacent rich text runs merge only with identical formatting', () => {
    const base = { text: 'a', bold: false, italic: false, color: '#334155' };
    assert.deepEqual(mergeRuns([base, { ...base, text: 'b' }, { ...base, text: 'c', bold: true }]), [{ ...base, text: 'ab' }, { ...base, text: 'c', bold: true }]);
});
test('missing references fail rather than silently attaching to a different object', () => {
    assert.throws(() => getObject(fixture().source, 'unknown'), /Missing diagram object/);
});

test('dragging a terminal segment preserves endpoints and adds an explicit detour', async () => {
    const { draggedArrow } = await import('../../app/static/js/modules/embedded-documents/diagram-document.js');
    const source = fixture().source, original = structuredClone(source);
    const next = draggedArrow(source, 'ab', 'segment', 0, { x: 200, y: 10 }, free({ x: 200, y: 10 }));
    assert.deepEqual(next.start, source.arrows[0].start); assert.deepEqual(next.end, source.arrows[0].end);
    assert.deepEqual(next.points.slice(0, 2), [{ x: 160, y: 10 }, { x: 250, y: 10 }]);
    assert.deepEqual(source, original);
    const detached = draggedArrow(source, 'ab', 'endpoint', 0, { x: -50, y: 50 }, free({ x: -50, y: 50 }));
    assert.deepEqual(detached.start, { kind: 'free', x: -50, y: 50 }); assert.deepEqual(detached.points, original.arrows[0].points);
});
