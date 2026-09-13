import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApplicationState } from '../../app/static/js/modules/application-state.js';
import { resolveClipboardTrackingAfterPasteEvent } from '../../app/static/js/modules/mode-manager/services/clipboard-shortcut-policy-service.js';

const source = readFileSync(new URL('../../app/static/js/modules/mode-manager/events/keyboard-events.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function markSystemClipboardAsTrusted('), source.indexOf('function handleKeyDown('));

function harness() {
    const state = ApplicationState.createFields('clipboard-test', { clipboardMode: 'system', noteClipboardRequiresBrowserValidation: false });
    const context = { get clipboardMode() { return state.clipboardMode; }, setClipboardMode(mode) { state.clipboardMode = mode; } };
    const handlers = new Function('moduleState', 'ModeContext', 'resolveClipboardTrackingAfterPasteEvent', `${helpers}\nreturn {
        system: markSystemClipboardAsTrusted, note: markNoteClipboardAsTrusted,
        invalidate: invalidateTrustedNoteClipboard, paste: syncClipboardTrackingFromPasteEventHtml,
    };`)(state, context, resolveClipboardTrackingAfterPasteEvent);
    return {state, ...handlers};
}

test('repeated external pastes and successful clipboard writes preserve already trusted state', () => {
    const h = harness();
    assert.equal(h.paste('<h1>Title</h1>'), false);
    assert.equal(h.paste('<p>Another paste</p>'), false);
    h.system();
    h.system();
    h.note();
    h.note();
    assert.equal(h.state.clipboardMode, 'note');
    assert.equal(h.state.noteClipboardRequiresBrowserValidation, false);
    assert.throws(() => { h.state.noteClipboardRequiresBrowserValidation = false; }, /Redundant/);
});

test('blur plus visibility loss invalidate once and browser paste revalidates internal or external contents', () => {
    const h = harness();
    h.state.clipboardMode = 'note';
    h.invalidate();
    h.invalidate();
    assert.equal(h.state.noteClipboardRequiresBrowserValidation, true);
    assert.equal(h.paste('<div data-metalist-note-clipboard="true">Internal</div>'), true);
    assert.equal(h.state.noteClipboardRequiresBrowserValidation, false);
    h.invalidate();
    assert.equal(h.paste('<p>External</p>'), false);
    assert.equal(h.state.clipboardMode, 'system');
    assert.equal(h.state.noteClipboardRequiresBrowserValidation, false);
});
