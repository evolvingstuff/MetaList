import assert from 'node:assert/strict';
import test from 'node:test';

import {
    executeEditorRedo,
    shouldExecuteEditorRedo,
    shouldUseApplicationHistory,
} from '../../app/static/js/modules/mode-manager/services/history-shortcut-policy-service.js';

test('undo and redo use saved application history when the active editor has no local edits', () => {
    assert.equal(shouldUseApplicationHistory({
        isEditing: true,
        isDirty: false,
        editSessionHasEdits: false,
    }), true);
});

test('undo and redo stay native when the active editor has local edit history', () => {
    assert.equal(shouldUseApplicationHistory({
        isEditing: true,
        isDirty: true,
        editSessionHasEdits: false,
    }), false);
    assert.equal(shouldUseApplicationHistory({
        isEditing: true,
        isDirty: false,
        editSessionHasEdits: true,
    }), false);
});

test('undo and redo use saved application history outside note editing', () => {
    assert.equal(shouldUseApplicationHistory({
        isEditing: false,
        isDirty: false,
        editSessionHasEdits: false,
    }), true);
});

test('history shortcut policy rejects non-boolean state', () => {
    assert.throws(
        () => shouldUseApplicationHistory({
            isEditing: null,
            isDirty: false,
            editSessionHasEdits: false,
        }),
        /isEditing must be a boolean/,
    );
    assert.throws(
        () => shouldUseApplicationHistory({
            isEditing: true,
            isDirty: null,
            editSessionHasEdits: false,
        }),
        /isDirty must be a boolean/,
    );
    assert.throws(
        () => shouldUseApplicationHistory({
            isEditing: true,
            isDirty: false,
            editSessionHasEdits: null,
        }),
        /editSessionHasEdits must be a boolean/,
    );
});

test('Cmd/Ctrl+Y maps to local editor redo while editing', () => {
    assert.equal(shouldExecuteEditorRedo({ isEditing: true, key: 'y' }), true);
    assert.equal(shouldExecuteEditorRedo({ isEditing: true, key: 'z' }), false);
    assert.equal(shouldExecuteEditorRedo({ isEditing: false, key: 'y' }), false);
});

test('local editor redo invokes the active document undo manager', () => {
    const calls = [];
    const documentObject = {
        execCommand(command) {
            calls.push(command);
            return true;
        },
    };

    assert.equal(executeEditorRedo(documentObject), true);
    assert.deepEqual(calls, ['redo']);
});
