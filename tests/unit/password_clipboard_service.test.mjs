import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addPasswordTag,
    clearRememberedGeneratedPasswordCopy,
    rememberGeneratedPasswordCopy,
    shouldAutoTagGeneratedPasswordPaste,
    tagBarHasPasswordTag,
} from '../../app/static/js/modules/mode-manager/services/password-clipboard-service.js';

test('shouldAutoTagGeneratedPasswordPaste matches remembered generated password for empty notes', () => {
    rememberGeneratedPasswordCopy('A8$Zr19!');

    const shouldAutoTag = shouldAutoTagGeneratedPasswordPaste({
        clipboardPlainText: 'A8$Zr19!',
        existingTags: 'project',
        noteIsEmpty: true,
    });

    assert.equal(shouldAutoTag, true);
});

test('shouldAutoTagGeneratedPasswordPaste skips non-empty notes and existing @password tags', () => {
    clearRememberedGeneratedPasswordCopy();
    rememberGeneratedPasswordCopy('A8$Zr19!');

    assert.equal(shouldAutoTagGeneratedPasswordPaste({
        clipboardPlainText: 'A8$Zr19!',
        existingTags: '',
        noteIsEmpty: false,
    }), false);

    assert.equal(shouldAutoTagGeneratedPasswordPaste({
        clipboardPlainText: 'A8$Zr19!',
        existingTags: '@password project',
        noteIsEmpty: true,
    }), false);
});

test('mismatched paste clears stale remembered generated password', () => {
    clearRememberedGeneratedPasswordCopy();
    rememberGeneratedPasswordCopy('A8$Zr19!');

    assert.equal(shouldAutoTagGeneratedPasswordPaste({
        clipboardPlainText: 'different-value',
        existingTags: '',
        noteIsEmpty: true,
    }), false);

    assert.equal(shouldAutoTagGeneratedPasswordPaste({
        clipboardPlainText: 'A8$Zr19!',
        existingTags: '',
        noteIsEmpty: true,
    }), false);
});

test('addPasswordTag appends @password once and normalizes spacing', () => {

    assert.equal(addPasswordTag(' project   secrets '), 'project secrets @password');
    assert.equal(addPasswordTag('project @password'), 'project @password');
    assert.equal(tagBarHasPasswordTag('project @password'), true);
});
