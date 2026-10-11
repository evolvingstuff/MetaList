import assert from 'node:assert/strict';
import test from 'node:test';

import {
    prepareDeleteNoteContextAction,
    prepareOutlineMoveContextAction,
} from '../../app/static/js/modules/mode-manager/services/note-context-menu-action-service.js';

test('prepareOutlineMoveContextAction saves the currently edited different note and keeps target unselected', async () => {
    const saved = [];
    let exitSearchCalls = 0;

    await prepareOutlineMoveContextAction({
        targetNoteId: 'note-b',
        modeContext: {
            isSearching: false,
            isEditing: true,
            currentNoteId: 'note-a',
            editSessionHasEdits: true,
        },
        exitSearchModeFn() {
            exitSearchCalls += 1;
        },
        saveActiveNoteFn(noteId) {
            saved.push(noteId);
            return Promise.resolve();
        },
    });

    assert.equal(exitSearchCalls, 0);
    assert.deepEqual(saved, ['note-a']);
});

test('prepareOutlineMoveContextAction does not save when target note is already selected', async () => {
    const saved = [];
    let exitSearchCalls = 0;

    await prepareOutlineMoveContextAction({
        targetNoteId: 'note-a',
        modeContext: {
            isSearching: true,
            isEditing: true,
            currentNoteId: 'note-a',
            editSessionHasEdits: true,
        },
        exitSearchModeFn() {
            exitSearchCalls += 1;
        },
        saveActiveNoteFn(noteId) {
            saved.push(noteId);
            return Promise.resolve();
        },
    });

    assert.equal(exitSearchCalls, 1);
    assert.deepEqual(saved, []);
});

test('prepareOutlineMoveContextAction is a no-op for non-editing state', async () => {
    const saved = [];
    let exitSearchCalls = 0;

    await prepareOutlineMoveContextAction({
        targetNoteId: 'note-b',
        modeContext: {
            isSearching: false,
            isEditing: false,
            currentNoteId: null,
            editSessionHasEdits: false,
        },
        exitSearchModeFn() {
            exitSearchCalls += 1;
        },
        saveActiveNoteFn(noteId) {
            saved.push(noteId);
            return Promise.resolve();
        },
    });

    assert.equal(exitSearchCalls, 0);
    assert.deepEqual(saved, []);
});

test('prepareDeleteNoteContextAction deletes unselected note without selecting it first', async () => {
    let exitSearchCalls = 0;
    let saveAndExitCalls = 0;

    const deleteMode = await prepareDeleteNoteContextAction({
        targetNoteId: 'note-b',
        modeContext: {
            isSearching: false,
            isEditing: false,
            currentNoteId: null,
        },
        exitSearchModeFn() {
            exitSearchCalls += 1;
        },
        saveAndExitEditingFn() {
            saveAndExitCalls += 1;
            return Promise.resolve();
        },
    });

    assert.equal(deleteMode, 'outside-edit');
    assert.equal(exitSearchCalls, 0);
    assert.equal(saveAndExitCalls, 0);
});

test('prepareDeleteNoteContextAction uses selected delete path for current edited note', async () => {
    let saveAndExitCalls = 0;

    const deleteMode = await prepareDeleteNoteContextAction({
        targetNoteId: 'note-a',
        modeContext: {
            isSearching: false,
            isEditing: true,
            currentNoteId: 'note-a',
        },
        exitSearchModeFn() {},
        saveAndExitEditingFn() {
            saveAndExitCalls += 1;
            return Promise.resolve();
        },
    });

    assert.equal(deleteMode, 'selected-edit');
    assert.equal(saveAndExitCalls, 0);
});

test('prepareDeleteNoteContextAction exits current edit before deleting another note', async () => {
    let exitSearchCalls = 0;
    let saveAndExitCalls = 0;

    const deleteMode = await prepareDeleteNoteContextAction({
        targetNoteId: 'note-b',
        modeContext: {
            isSearching: true,
            isEditing: true,
            currentNoteId: 'note-a',
        },
        exitSearchModeFn() {
            exitSearchCalls += 1;
        },
        saveAndExitEditingFn() {
            saveAndExitCalls += 1;
            return Promise.resolve();
        },
    });

    assert.equal(deleteMode, 'outside-edit');
    assert.equal(exitSearchCalls, 1);
    assert.equal(saveAndExitCalls, 1);
});
