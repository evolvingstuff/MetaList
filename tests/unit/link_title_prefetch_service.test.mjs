import { ApplicationState } from '../../app/static/js/modules/application-state.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL(
    '../../app/static/js/modules/mode-manager/services/link-title-prefetch-service.js', import.meta.url,
), 'utf8').replace(/^import .*;\n/gm, '').replace('export async function', 'async function');

function harness() {
    let now = 0;
    let content = '<p>https://example.com/article</p>';
    let busy = false;
    const calls = [];
    const mode = { isEditing: true, isConnected: true, currentNoteId: 'note-1' };
    const tick = new Function('ApplicationState', 'ModeContext', 'DOMUtils', 'NotesAPI', 'getTagBarValue', 'CommandGate', 'Date',
        `${source}\nreturn prefetchEditingLinkTitles;`).bind(null, ApplicationState)(
        mode,
        { getNoteById: () => ({}), getNoteContentHTML: () => content },
        { _apiCall: async (url, options) => calls.push({ url, ...JSON.parse(options.body) }) },
        () => '', { isBusy: () => busy }, { now: () => now },
    );
    return { calls, mode, tick, advance(ms) { now += ms; }, setContent(value) { content = value; },
        setBusy(value) { busy = value; } };
}

test('prefetch waits for a pause, submits the latest unsaved draft, and deduplicates ticks', async () => {
    const h = harness();
    await h.tick();
    h.advance(500);
    h.setContent('<p>https://example.com/new</p>');
    await h.tick();
    h.advance(500);
    await h.tick();
    assert.equal(h.calls.length, 0);
    h.advance(500);
    await h.tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].content, '<p>https://example.com/new</p>');
    assert.equal(h.mode.isEditing, true);
    h.advance(5000);
    await h.tick();
    assert.equal(h.calls.length, 1);
});

test('prefetch defers while busy and cancels a draft when editing ends', async () => {
    const h = harness();
    await h.tick();
    h.advance(1000);
    h.setBusy(true);
    await h.tick();
    assert.equal(h.calls.length, 0);
    h.setBusy(false);
    h.mode.isEditing = false;
    await h.tick();
    assert.equal(h.calls.length, 0);
    h.mode.isEditing = true;
    await h.tick();
    h.advance(1000);
    await h.tick();
    assert.equal(h.calls.length, 1);
});

test('ordinary text and disconnected drafts make no requests', async () => {
    const h = harness();
    h.setContent('<p>ordinary text</p>');
    await h.tick();
    h.advance(1000);
    await h.tick();
    h.setContent('https://example.com');
    h.mode.isConnected = false;
    await h.tick();
    h.advance(1000);
    await h.tick();
    assert.equal(h.calls.length, 0);
});
