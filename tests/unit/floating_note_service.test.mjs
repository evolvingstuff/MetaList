import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {ApplicationState, stateValuesEqual} from '../../app/static/js/modules/application-state.js';
import {constrainFloatingNoteRect, moveFloatingNoteRect} from '../../app/static/js/modules/mode-manager/services/floating-note-layout.js';

const source = await readFile(new URL('../../app/static/js/modules/mode-manager/services/floating-note-service.js', import.meta.url), 'utf8');

function harness() {
    class Element {
        constructor() { this.style = {}; this.dataset = {}; this.isConnected = false; this.scrollTop = 0; this.htmlWrites = 0; }
        appendChild(child) { child.isConnected = true; }
        setAttribute() {}
        focus() {}
        remove() { this.isConnected = false; }
        querySelectorAll() { return []; }
        set innerHTML(value) { this.html = value; this.htmlWrites++; }
    }
    const requests = [];
    const elements = [];
    const intervals = new Set();
    let sequence = 0;
    const window = {
        innerWidth: 1000, innerHeight: 800,
        addEventListener() {}, removeEventListener() {},
        setInterval() { const id = ++sequence; intervals.add(id); return id; },
        clearInterval(id) { intervals.delete(id); },
    };
    const dependencies = {
        ApplicationState, stateValuesEqual, constrainFloatingNoteRect, moveFloatingNoteRect,
        window, document: {getElementById: () => new Element()}, HTMLElement: Element,
        crypto: {randomUUID: () => String(++sequence)},
        NotesAPI: {getFloatingNote: (noteId, revision) => new Promise((resolve, reject) => requests.push({noteId, revision, resolve, reject}))},
        CommandGate: {isBusy: () => false},
        rethrowUnexpectedError: error => { throw error; },
        createFloatingNoteElements() {
            const entry = Object.fromEntries(['element', 'tree', 'title', 'status', 'scroll'].map(key => [key, new Element()]));
            elements.push(entry);
            return entry;
        },
        getFloatingNoteTitle: () => 'Root',
        applyFloatingNoteRect() {}, hydrateImageFilePreviews() {}, ensureAnchorsOpenInNewTabs() {},
        hydrateRemoteImageProxies() {}, queueMermaidDiagramRendering: async () => {},
    };
    const build = new Function(...Object.keys(dependencies), source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
        + '\nreturn {openFloatingNote, closeFloatingNote, closeAllFloatingNotes, refreshFloatingNotes};');
    return {service: build(...Object.values(dependencies)), requests, elements, intervals};
}

test('closing all windows discards in-flight plaintext and releases the refresh timer', async () => {
    const h = harness();
    const pending = h.service.openFloatingNote('root');
    assert.equal(h.intervals.size, 1);
    h.service.closeAllFloatingNotes();
    h.service.closeAllFloatingNotes();
    h.requests[0].resolve({revision: 'a', status: 'ready', html: '<p>Do not republish</p>'});
    await pending;
    assert.equal(h.elements[0].tree.htmlWrites, 0);
    assert.equal(h.elements[0].element.isConnected, false);
    assert.equal(h.intervals.size, 0);
});

test('unchanged windows retain their DOM and deletion/restore refreshes the same window', async () => {
    const h = harness();
    const opened = h.service.openFloatingNote('root');
    h.requests.shift().resolve({revision: 'a', status: 'ready', html: '<p>Root</p>'});
    await opened;
    for (const snapshot of [
        {revision: 'a', status: 'unchanged', html: ''},
        {revision: 'b', status: 'ready', html: '<p>Root</p>'},
    ]) {
        const pending = h.service.refreshFloatingNotes();
        h.requests.shift().resolve(snapshot);
        await pending;
    }
    assert.equal(h.elements[0].tree.htmlWrites, 1);
    const deleted = h.service.refreshFloatingNotes();
    h.requests.shift().resolve({revision: 'c', status: 'deleted', html: ''});
    await deleted;
    assert.equal(h.elements[0].tree.html, '');
    assert.equal(h.elements[0].status.textContent, 'This note was deleted.');
    const restored = h.service.refreshFloatingNotes();
    h.requests.shift().resolve({revision: 'd', status: 'ready', html: '<p>Restored</p>'});
    await restored;
    assert.equal(h.elements[0].tree.html, '<p>Restored</p>');
    h.service.closeAllFloatingNotes();
});

test('refresh calls cannot overlap and a closed window cannot overwrite a reopened one', async () => {
    const h = harness();
    const opening = h.service.openFloatingNote('root');
    h.requests.shift().resolve({revision: 'a', status: 'ready', html: '<p>First</p>'});
    const id = await opening;
    const refreshing = h.service.refreshFloatingNotes();
    await h.service.refreshFloatingNotes();
    assert.equal(h.requests.length, 1);
    h.service.closeFloatingNote(id);
    const reopening = h.service.openFloatingNote('root');
    h.requests[1].resolve({revision: 'c', status: 'ready', html: '<p>New window</p>'});
    await reopening;
    h.requests[0].resolve({revision: 'b', status: 'ready', html: '<p>Old response</p>'});
    await refreshing;
    assert.equal(h.elements[1].tree.html, '<p>New window</p>');
    h.service.closeAllFloatingNotes();
});

test('malformed responses and internal failures still throw', async () => {
    const h = harness();
    const pending = h.service.openFloatingNote('root');
    h.requests.shift().resolve({revision: 'a', status: 'ready', html: ''});
    await assert.rejects(pending, /markup/);
    const refreshing = h.service.refreshFloatingNotes();
    h.requests.shift().reject(new Error('Internal bug'));
    await assert.rejects(refreshing, /Internal bug/);
    h.service.closeAllFloatingNotes();
});
