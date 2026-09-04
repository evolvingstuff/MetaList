import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveClipboardTrackingAfterPasteEvent,
    resolveNotePasteResponse,
    shouldAllowBrowserPasteForShortcut,
    shouldCreateTopNoteForPaste,
} from '../../app/static/js/modules/mode-manager/services/clipboard-shortcut-policy-service.js';

test('intercepts paste shortcut when note clipboard is trusted and a note is active', () => {
    const allowBrowserPaste = shouldAllowBrowserPasteForShortcut({
        clipboardMode: 'note',
        noteClipboardRequiresBrowserValidation: false,
        isEditing: true,
        currentNoteId: 'note-123',
    });

    assert.equal(allowBrowserPaste, false);
});

test('allows browser paste when note clipboard must be revalidated after app blur', () => {
    const allowBrowserPaste = shouldAllowBrowserPasteForShortcut({
        clipboardMode: 'note',
        noteClipboardRequiresBrowserValidation: true,
        isEditing: true,
        currentNoteId: 'note-123',
    });

    assert.equal(allowBrowserPaste, true);
});

test('demotes stale note clipboard tracking when actual paste contents are external', () => {
    const resolved = resolveClipboardTrackingAfterPasteEvent({
        clipboardMode: 'note',
        noteClipboardRequiresBrowserValidation: true,
        clipboardHtml: '',
    });

    assert.deepEqual(resolved, {
        clipboardMode: 'system',
        noteClipboardRequiresBrowserValidation: false,
        hasNoteClipboardHtml: false,
    });
});

test('does not mistake ordinary copied note content for an explicit copied note', () => {
    const resolved = resolveClipboardTrackingAfterPasteEvent({
        clipboardMode: 'system',
        noteClipboardRequiresBrowserValidation: false,
        clipboardHtml: '<div class="note-content"><a href="https://example.com">Example</a></div>',
    });

    assert.deepEqual(resolved, {
        clipboardMode: 'system',
        noteClipboardRequiresBrowserValidation: false,
        hasNoteClipboardHtml: false,
    });
});

test('keeps note clipboard tracking when actual paste contents still contain a MetaList note', () => {
    const resolved = resolveClipboardTrackingAfterPasteEvent({
        clipboardMode: 'note',
        noteClipboardRequiresBrowserValidation: true,
        clipboardHtml: '<div data-metalist-note-clipboard="true"><div class="note-content">Copied note</div></div>',
    });

    assert.deepEqual(resolved, {
        clipboardMode: 'note',
        noteClipboardRequiresBrowserValidation: false,
        hasNoteClipboardHtml: true,
    });
});

test('creates a top note when clipboard content is pasted with no active note', () => {
    const shouldCreate = shouldCreateTopNoteForPaste({
        isEditing: false,
        currentNoteId: null,
        hasNativePasteTarget: false,
        hasClipboardPayload: true,
        isModalOpen: false,
    });

    assert.equal(shouldCreate, true);
});

test('does not create a top note when a note is already active', () => {
    const shouldCreate = shouldCreateTopNoteForPaste({
        isEditing: true,
        currentNoteId: 'note-123',
        hasNativePasteTarget: false,
        hasClipboardPayload: true,
        isModalOpen: false,
    });

    assert.equal(shouldCreate, false);
});

test('preserves native paste behavior for text inputs when no note is active', () => {
    const shouldCreate = shouldCreateTopNoteForPaste({
        isEditing: false,
        currentNoteId: null,
        hasNativePasteTarget: true,
        hasClipboardPayload: true,
        isModalOpen: false,
    });

    assert.equal(shouldCreate, false);
});

test('does not create a top note behind an open modal', () => {
    const shouldCreate = shouldCreateTopNoteForPaste({
        isEditing: false,
        currentNoteId: null,
        hasNativePasteTarget: false,
        hasClipboardPayload: true,
        isModalOpen: true,
    });

    assert.equal(shouldCreate, false);
});

test('does not create an empty top note for a clipboard with no usable payload', () => {
    const shouldCreate = shouldCreateTopNoteForPaste({
        isEditing: false,
        currentNoteId: null,
        hasNativePasteTarget: false,
        hasClipboardPayload: false,
        isModalOpen: false,
    });

    assert.equal(shouldCreate, false);
});

test('resolves an expired server clipboard as a normal empty paste result', () => {
    assert.equal(resolveNotePasteResponse({ status: 'clipboard_empty' }), null);
});

test('resolves a completed note paste to its note id', () => {
    assert.equal(resolveNotePasteResponse({ status: 'pasted', id: 'note-123' }), 'note-123');
});
