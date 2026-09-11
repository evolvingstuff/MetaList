import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBacklinksQuery } from '../../app/static/js/modules/mode-manager/services/backlinks-navigation-service.js';

const sourceId = '11111111-1111-1111-1111-111111111111';
const firstId = '22222222-2222-2222-2222-222222222222';
const secondId = '33333333-3333-3333-3333-333333333333';

test('backlinks view includes each referring note once, preserving source order', () => {
    assert.equal(buildBacklinksQuery({
        targetNoteId: sourceId,
        backlinks: [{ id: firstId }, { id: firstId }, { id: secondId }],
    }, sourceId), `${firstId} OR ${secondId}`);
});

test('a source losing its last backlink cannot accidentally open the entire namespace', () => {
    assert.equal(buildBacklinksQuery({ targetNoteId: sourceId, backlinks: [] }, sourceId), '');
});

test('backlink responses require the requested source and valid note identifiers', () => {
    assert.throws(() => buildBacklinksQuery({ targetNoteId: firstId, backlinks: [] }, sourceId));
    assert.throws(() => buildBacklinksQuery({ targetNoteId: sourceId, backlinks: [{ id: 'foo OR bar' }] }, sourceId));
});
