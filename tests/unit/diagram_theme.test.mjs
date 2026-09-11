import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { emptyDiagram, upgradeDocument, DiagramHistory } from '../../app/static/js/modules/embedded-documents/diagram-document.js';
import { diagramTheme, sketchPath, shapePath, inkOutline } from '../../app/static/js/modules/embedded-documents/diagram-theme.js';
const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/diagram-v3.json', import.meta.url), 'utf8'));

test('new diagrams use hand-drawn, legacy diagrams explicitly upgrade to clean without mutation', () => {
    assert.equal(emptyDiagram().version, 4); assert.equal(emptyDiagram().source.theme, 'hand-drawn');
    const original = fixture(), upgraded = upgradeDocument(original);
    assert.equal(upgraded.version, 4); assert.equal(upgraded.source.theme, 'clean');
    assert.equal(Object.hasOwn(original.source, 'theme'), false); assert.equal(diagramTheme(original.source).name, 'clean');
    assert.notEqual(diagramTheme(emptyDiagram().source).font, diagramTheme(original.source).font);
    assert.throws(() => diagramTheme({ theme: 'invalid' }), /Unknown diagram theme/);
});

test('theme changes undo without modifying colors, positions, groups, or connections', () => {
    const state = { draft: upgradeDocument(fixture()) }, history = new DiagramHistory(state);
    const before = structuredClone(state.draft); state.draft.source.theme = 'hand-drawn'; history.commit(before);
    assert.deepEqual(state.draft.source.shapes, before.source.shapes); assert.deepEqual(state.draft.source.arrows, before.source.arrows);
    history.undo(); assert.deepEqual(state.draft, before); history.redo(); assert.equal(state.draft.source.theme, 'hand-drawn');
});

test('pen strokes are repeatable, preserve endpoints and rounded bends, and vary between passes', () => {
    const path = 'M 0 0 L 120 0 Q 130 0 130 10 L 130 90';
    const first = sketchPath(path, 'sample', 0);
    assert.equal(sketchPath(path, 'sample', 0), first); assert.notEqual(sketchPath(path, 'sample', 1), first);
    assert.ok(first.startsWith('M 0 0 C ')); assert.match(first, / Q 130 0 130 10 C /); assert.ok(first.endsWith('130 90'));
    assert.notEqual(sketchPath(path, 'other', 0), first);
});

test('all supported shapes get closed vector outlines without mutating geometry', () => {
    const box = fixture().source.shapes[0]; const before = structuredClone(box);
    for (const type of ['rectangle', 'rounded', 'ellipse', 'diamond']) {
        const path = shapePath({ ...box, type }); assert.ok(path.endsWith('Z'));
        assert.match(sketchPath(path, box.id, 0), / C /);
    }
    assert.deepEqual(box, before);
});

test('long pen strokes use one broad bow without repeated oscillation', () => {
    const path = sketchPath('M 0 0 L 600 0', 'long-arrow', 0);
    const curves = [...path.matchAll(/C ([^CMQZ]+)/g)].map(match => match[1].trim().split(/\s+/).map(Number));
    assert.equal(curves.length, 1, 'An edge should be drawn with one continuous gesture');
    assert.ok(curves[0][1] * curves[0][3] > 0, 'Both controls should bow to the same side');
    assert.ok(Math.abs(curves[0][1]) > 1.5 && Math.abs(curves[0][1]) <= 7);
    assert.ok(path.endsWith('600 0'), 'The connection point stays exact');
});

test('ink pressure visibly varies along a stroke without changing its centerline', () => {
    const path = 'M 0 0 C 200 0 400 0 600 0';
    const outline = inkOutline(path, 'pressure', 2);
    assert.equal(inkOutline(path, 'pressure', 2), outline);
    assert.ok(outline.endsWith(' Z'));
    const vertices = outline.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi).map(Number);
    const radii = vertices.filter((_, index) => index % 2 === 1).map(Math.abs);
    assert.ok(Math.max(...radii) > Math.min(...radii) * 1.1, 'Ink weight should vary gently');
    assert.ok(Math.max(...radii) < Math.min(...radii) * 1.5, 'Ink weight should not swell into blobs');
    assert.equal(inkOutline('M 0 0', 'empty', 2), '');
});
