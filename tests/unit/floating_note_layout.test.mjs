import assert from 'node:assert/strict';
import test from 'node:test';
import {constrainFloatingNoteRect, moveFloatingNoteRect} from '../../app/static/js/modules/mode-manager/services/floating-note-layout.js';

test('floating note movement remains inside viewport without resizing the window', () => {
    const gesture = {kind: 'move', x: 100, y: 100, rect: {x: 30, y: 50, width: 300, height: 200}};
    assert.deepEqual(moveFloatingNoteRect(gesture, 900, 900, {width: 800, height: 600}), {
        x: 500, y: 400, width: 300, height: 200,
    });
    assert.deepEqual(moveFloatingNoteRect(gesture, -100, -100, {width: 800, height: 600}), {
        x: 0, y: 0, width: 300, height: 200,
    });
});

test('floating notes resize with minimum dimensions and fit small viewports', () => {
    const gesture = {kind: 'resize', x: 300, y: 200, rect: {x: 30, y: 50, width: 300, height: 200}};
    assert.deepEqual(moveFloatingNoteRect(gesture, 380, 250, {width: 800, height: 600}), {
        x: 30, y: 50, width: 380, height: 250,
    });
    assert.deepEqual(moveFloatingNoteRect(gesture, 0, 0, {width: 800, height: 600}), {
        x: 30, y: 50, width: 260, height: 160,
    });
    assert.deepEqual(constrainFloatingNoteRect(gesture.rect, {width: 240, height: 120}), {
        x: 0, y: 0, width: 240, height: 120,
    });
});

test('stationary pointer observations preserve geometry and invalid geometry fails', () => {
    const rect = {x: 20, y: 30, width: 400, height: 300};
    assert.deepEqual(moveFloatingNoteRect({kind: 'move', x: 40, y: 50, rect}, 40, 50, {width: 800, height: 600}), rect);
    assert.throws(() => constrainFloatingNoteRect({...rect, x: NaN}, {width: 800, height: 600}));
});
