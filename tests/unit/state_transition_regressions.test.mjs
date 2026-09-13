import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApplicationState, stateValuesEqual } from '../../app/static/js/modules/application-state.js';

function moduleSource(path) {
    return readFileSync(new URL(`../../app/static/js/modules/${path}`, import.meta.url), 'utf8')
        .replace(/^import[\s\S]*?from '[^']+';\s*/gm, '').replace(/^export /gm, '');
}

function bulkHarness() {
    let refreshes = 0;
    let epochs = 0;
    const source = moduleSource('ai-chat/bulk-proposal-ui.js');
    const dependencies = {
        ApplicationState, CONFIG: { API: { AI: { CHAT: '/chat' } } },
        ModeContext: { bumpUndoContextEpoch: () => { epochs += 1; } },
        actionRefreshAndMaybeSelect: async () => { refreshes += 1; },
    };
    return {
        ...new Function(...Object.keys(dependencies), `${source}\nreturn {event: handleBulkEvent, close: closeBulkProgress};`)(...Object.values(dependencies)),
        counts: () => ({ refreshes, epochs }),
    };
}

test('ordinary chat cleanup and unchanged bulk completion have no pending refresh to clear', async () => {
    const h = bulkHarness();
    await h.close();
    await h.close();
    for (let count = 0; count < 2; count += 1) {
        h.event({ type: 'bulk_complete', changed: false });
        await h.close();
    }
    assert.deepEqual(h.counts(), { refreshes: 0, epochs: 0 });
});

test('changed bulk completion refreshes exactly once when consumed', async () => {
    const h = bulkHarness();
    h.event({ type: 'bulk_complete', changed: true });
    await h.close();
    await h.close();
    assert.deepEqual(h.counts(), { refreshes: 1, epochs: 1 });
});

function chatHarness(events) {
    let nextTimer = 0;
    const timers = new Set();
    class Input { value = 'Test request'; focus() {} }
    const bulk = bulkHarness();
    const dependencies = {
        ApplicationState, stateValuesEqual,
        window: {
            setInterval: () => { const id = ++nextTimer; timers.add(id); return id; },
            clearInterval: id => timers.delete(id),
        },
        AgentDebugView: { refreshIfOpen: async () => {} },
        rethrowUnexpectedError: error => { throw error; },
        streamAiChat: async ({ onEvent }) => { for (const event of events) onEvent(event); },
        clearAiChatSession: async () => {},
        closeBulkProgress: bulk.close, handleBulkEvent: bulk.event,
    };
    const panel = new Function(...Object.keys(dependencies), `${moduleSource('ai-chat/ai-chat-panel-controller.js')}
        captureActiveAgentScope = () => ({}); return AiChatPanel;`)(...Object.values(dependencies));
    panel._getSettings = () => ({ provider: 'ollama', model: 'test-model' });
    panel._models = ['test-model'];
    panel._elements = { input: new Input() };
    panel._render = () => {};
    panel._loadSession = async () => {};
    panel._syncComposerControlsDisabled = () => {};
    return { panel, timers };
}

test('streamed chat deltas and matching final snapshot complete and clean up exactly once', async () => {
    const h = chatHarness([
        { type: 'content_delta', text: 'Hello', rendered_text: '<p>Hello</p>' },
        { type: 'content_delta', text: ' world', rendered_text: '<p>Hello world</p>' },
        { type: 'done', content: 'Hello world', rendered_content: '<p>Hello world</p>' },
    ]);
    await h.panel._submitMessage();
    const answer = h.panel._messages.at(-1);
    assert.equal(answer.content, 'Hello world');
    assert.equal(answer.status, 'complete');
    assert.equal(h.panel._isBusy, false);
    assert.equal(h.panel._activeChatCompletion, null);
    assert.equal(h.timers.size, 0);
});

test('a final-only chat answer and repeated empty session clearing preserve strict state', async () => {
    const h = chatHarness([{ type: 'done', content: 'Answer', rendered_content: '<p>Answer</p>' }]);
    await h.panel._submitMessage();
    await h.panel._clearSession();
    await h.panel._clearSession();
    assert.equal(h.panel._messages.length, 0);
    assert.equal(h.timers.size, 0);
    assert.throws(() => { h.panel._isBusy = false; }, /Redundant/);
});

test('streamed whitespace can leave rendered HTML unchanged while accumulating text', async () => {
    const h = chatHarness([
        { type: 'thinking_delta', text: ' ', rendered_text: '' },
        { type: 'thinking_delta', text: ' ', rendered_text: '' },
        { type: 'content_delta', text: 'Hello', rendered_text: '<p>Hello</p>' },
        { type: 'content_delta', text: ' ', rendered_text: '<p>Hello</p>' },
        { type: 'done', content: 'Hello ', rendered_content: '<p>Hello</p>' },
    ]);
    await h.panel._submitMessage();
    assert.equal(h.panel._messages.at(-1).content, 'Hello ');
    assert.equal(h.panel._messages.at(-1).thinking, '  ');
});

test('repeated unauthenticated polling cancels only a pending revision refresh', () => {
    const source = moduleSource('mode-manager/services/polling-service.js');
    const timers = new Set();
    let nextTimer = 0;
    const window = {
        setTimeout: () => { const id = ++nextTimer; timers.add(id); return id; },
        clearTimeout: id => timers.delete(id),
    };
    const receive = new Function('ApplicationState', 'window', `${source}\nreturn handleLinkTitleRevision;`)(ApplicationState, window);
    receive({ authenticated: false });
    receive({ authenticated: false });
    receive({ authenticated: true, link_title_revision: 3 });
    receive({ authenticated: true, link_title_revision: 3 });
    assert.equal(timers.size, 1);
    receive({ authenticated: false });
    receive({ authenticated: false });
    assert.equal(timers.size, 0);
});

for (const kind of ['file', 'remote']) {
    test(`${kind} preview completion after page cleanup cannot repopulate caches`, async () => {
        let complete;
        let cleanup;
        let createdUrls = 0;
        const response = new Promise(resolve => { complete = resolve; });
        const dependencies = {
            ApplicationState,
            window: { addEventListener: (name, callback) => { cleanup = callback; } },
            URL: { createObjectURL: () => { createdUrls += 1; return 'blob:test'; }, revokeObjectURL() {} },
            FilesAPI: { downloadFile: () => response },
            fetch: () => response, buildSessionHeaders: () => ({}),
        };
        const path = kind === 'file' ? 'file-image-preview-service.js' : 'remote-image-proxy-service.js';
        const fetchName = kind === 'file' ? 'fetchPreviewObjectUrl' : 'fetchObjectUrl';
        const start = new Function(...Object.keys(dependencies), `${moduleSource(`mode-manager/services/${path}`)}\nreturn ${fetchName};`)(...Object.values(dependencies));
        const pending = start(kind === 'file' ? 'file-id' : '/api2/remote-images/test-id');
        cleanup();
        cleanup();
        const blob = new Blob(['image'], {type:'image/png'});
        complete(kind === 'file' ? {blob} : {ok:true, blob:async () => blob});
        await assert.rejects(pending, {name:'AbortError'});
        assert.equal(createdUrls, 0);
    });
}

test('palette opens and closes repeatedly when focus belongs to a non-HTML element', async () => {
    const source = moduleSource('command-palette/command-palette-controller.js');
    const methods = source.slice(source.indexOf('    async open() {'), source.indexOf('    _handleClick(event) {'));
    class Element {
        style = {};
        value = '';
        focus() {}
        addEventListener() {}
        removeEventListener() {}
    }
    const dependencies = {
        HTMLElement: Element,
        document: {activeElement:{}, addEventListener() {}, removeEventListener() {}},
        window: {scrollY:0, scrollTo() {}},
        ModeContext: {isLoading:false, modalStack:[], pushModal() {}, removeModal() {}},
        cancelDebouncedSearchExecution() {},
    };
    const controller = new Function(...Object.keys(dependencies), `return new (class {${methods}})();`)(...Object.values(dependencies));
    const receiver = {
        _initialized:true, _isOpen:false,
        _previousSelection:null, _previousFocus:null,
        _elements:{modal:new Element(), input:new Element()},
        _render() {},
    };
    ApplicationState.own(receiver, 'palette-test', false);
    for (let count = 0; count < 2; count += 1) {
        await controller.open.call(receiver);
        controller.close.call(receiver);
    }
    assert.equal(receiver._isOpen, false);
});
