import assert from 'node:assert/strict';
import test from 'node:test';

import {
    writeRenderedNotePromiseToSystemClipboard,
    writeRenderedNoteToSystemClipboard,
} from '../../app/static/js/modules/mode-manager/services/note-clipboard-write-service.js';

class FakeBlob {
    constructor(parts, options) {
        this.parts = parts;
        this.type = options.type;
    }
}

class FakeClipboardItem {
    constructor(payload) {
        this.payload = payload;
    }
}

function createCopyEventDocument() {
    const listeners = [];
    const clipboardEntries = [];
    return {
        listeners,
        clipboardEntries,
        body: {
            appendChild() {},
            removeChild() {},
        },
        addEventListener(eventName, handler) {
            assert.equal(eventName, 'copy');
            listeners.push(handler);
        },
        removeEventListener(eventName, handler) {
            assert.equal(eventName, 'copy');
            const index = listeners.indexOf(handler);
            assert.notEqual(index, -1);
            listeners.splice(index, 1);
        },
        execCommand(command) {
            assert.equal(command, 'copy');
            assert.equal(listeners.length, 1);
            listeners[0]({
                clipboardData: {
                    setData(format, value) {
                        clipboardEntries.push([format, value]);
                    },
                },
                preventDefault() {
                    clipboardEntries.push(['preventDefault', true]);
                },
            });
            return true;
        },
        createElement() {
            return {
                style: {},
                value: '',
                select() {},
            };
        },
    };
}

test('writes rendered note HTML and plain text with async clipboard API', async () => {
    const writtenItems = [];
    const didWrite = await writeRenderedNoteToSystemClipboard({
        renderedHtml: '<div class="note-content">Hello</div>',
        renderedPlainText: 'Hello',
        clipboardApi: {
            async write(items) {
                writtenItems.push(...items);
            },
        },
        clipboardItemClass: FakeClipboardItem,
        blobClass: FakeBlob,
    });

    assert.equal(didWrite, true);
    assert.equal(writtenItems.length, 1);
    assert.deepEqual(Object.keys(writtenItems[0].payload), ['text/html', 'text/plain']);
    assert.equal(writtenItems[0].payload['text/html'].type, 'text/html');
    assert.equal(writtenItems[0].payload['text/plain'].parts[0], 'Hello');
});

test('falls through to rich copy-event fallback when async HTML write fails', async () => {
    let writeTextCalled = false;
    const documentRef = createCopyEventDocument();

    const didWrite = await writeRenderedNoteToSystemClipboard({
        renderedHtml: '<div class="note-content"><strong>Hello</strong></div>',
        renderedPlainText: 'Hello',
        clipboardApi: {
            async write() {
                throw new DOMException('Clipboard permission denied', 'NotAllowedError');
            },
            async writeText() {
                writeTextCalled = true;
            },
        },
        documentRef,
        clipboardItemClass: FakeClipboardItem,
        blobClass: FakeBlob,
    });

    assert.equal(didWrite, true);
    assert.equal(writeTextCalled, false);
    assert.deepEqual(documentRef.clipboardEntries, [
        ['text/html', '<div class="note-content"><strong>Hello</strong></div>'],
        ['text/plain', 'Hello'],
        ['preventDefault', true],
    ]);
    assert.equal(documentRef.listeners.length, 0);
});

test('falls back to writeText when rich clipboard paths are unavailable', async () => {
    let writtenText = null;
    const didWrite = await writeRenderedNoteToSystemClipboard({
        renderedHtml: '<div class="note-content">Hello</div>',
        renderedPlainText: 'Hello',
        clipboardApi: {
            async writeText(value) {
                writtenText = value;
            },
        },
        clipboardItemClass: null,
        blobClass: FakeBlob,
    });

    assert.equal(didWrite, true);
    assert.equal(writtenText, 'Hello');
});

test('starts async rich clipboard write before rendered note promise resolves', async () => {
    let resolveRenderedNote;
    const renderedNotePromise = new Promise((resolve) => {
        resolveRenderedNote = resolve;
    });
    const writtenItems = [];
    let writeCalled = false;

    const resultPromise = writeRenderedNotePromiseToSystemClipboard({
        renderedNotePromise,
        clipboardApi: {
            async write(items) {
                writeCalled = true;
                writtenItems.push(...items);
            },
        },
        clipboardItemClass: FakeClipboardItem,
        blobClass: FakeBlob,
    });

    assert.equal(writeCalled, true);
    assert.equal(writtenItems.length, 1);
    assert.equal(writtenItems[0].payload['text/html'] instanceof Promise, true);
    assert.equal(writtenItems[0].payload['text/plain'] instanceof Promise, true);

    resolveRenderedNote({
        html: '<div class="note-content"><strong>Hello</strong></div>',
        plain_text: 'Hello',
    });
    const result = await resultPromise;
    const htmlBlob = await writtenItems[0].payload['text/html'];
    const plainTextBlob = await writtenItems[0].payload['text/plain'];

    assert.equal(result.didWrite, true);
    assert.deepEqual(result.renderedNote, {
        html: '<div class="note-content"><strong>Hello</strong></div>',
        plain_text: 'Hello',
    });
    assert.equal(htmlBlob.type, 'text/html');
    assert.equal(htmlBlob.parts[0], '<div class="note-content"><strong>Hello</strong></div>');
    assert.equal(plainTextBlob.parts[0], 'Hello');
});
