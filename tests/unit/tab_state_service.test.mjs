import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApplicationState } from '../../app/static/js/modules/application-state.js';

async function harness() {
    const source = readFileSync(new URL(
        '../../app/static/js/modules/mode-manager/services/tab-state-service.js', import.meta.url,
    ), 'utf8').replace(/^import[\s\S]*?from '[^']+';\s*/gm, '').replace(/^export /gm, '');
    const requests = [];
    const polls = [];
    let serverVersion = 1;
    const payload = {
        activeTabId: 'first', tabOrder: ['first', 'second'], version: 1,
        tabs: { first: { scrollY: 0, scrollAnchor: null }, second: { scrollY: 0, scrollAnchor: null } },
    };
    const context = {
        activeTabId: 'first', tabStateVersion: 0, isLoading: false,
        hydrateTabState() {}, setTabStateUpdateHook() {},
        setTabStateVersion(version) { this.tabStateVersion = version; payload.version = version; },
        getTabStatePayload: () => structuredClone(payload),
        shouldIgnoreScrollEvents: () => false,
        getTabScrollPosition: id => payload.tabs[id].scrollY,
        updateActiveTabScroll(y) { payload.tabs[this.activeTabId].scrollY = y; },
        getTabScrollAnchor: id => payload.tabs[id].scrollAnchor,
        updateActiveTabScrollAnchor(anchor) { payload.tabs[this.activeTabId].scrollAnchor = anchor; },
    };
    const window = {
        scrollY: 0, addEventListener() {},
        setInterval(callback) { polls.push(callback); return polls.length; },
    };
    const dependencies = {
        ApplicationState, ModeContext: context, window, document: { hidden: false },
        CONFIG: { API: { NOTES: { TAB_STATE: '/tabs' } } },
        CommandGate: { isBusy: () => false }, buildSessionHeaders: () => ({}),
        computeScrollAnchor: () => null, areScrollAnchorsEqual: (a, b) => a === b,
        ErrorHandler: { handleApiError() {} }, HttpRequestError: Error,
        fetch: async (_endpoint, options) => {
            if (options.method === 'GET') return { ok: true, json: async () => structuredClone(payload) };
            const sent = JSON.parse(options.body);
            return await new Promise((resolve, reject) => requests.push({
                sent, reject,
                complete: () => resolve({ ok: true, json: async () => ({ ...sent, version: ++serverVersion }) }),
            }));
        },
    };
    const service = new Function(...Object.keys(dependencies), `${source}
        return { initializeTabStateService, persistTabStateSnapshot };`)(...Object.values(dependencies));
    await service.initializeTabStateService();
    assert.equal(polls.length, 1);
    return { service, requests, context, payload, window, poll: polls[0] };
}

test('scroll polls cannot overlap a slow save and write the same tab position twice', async () => {
    const h = await harness();
    h.window.scrollY = 100;
    const first = h.poll();
    const second = h.poll();
    // Observe both promises even on the old implementation, which rejects the second save.
    const settled = Promise.allSettled([first, second]);
    const requestCount = h.requests.length;
    for (const request of h.requests) request.complete();
    const results = await settled;
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
    assert.equal(requestCount, 1);
    await h.poll();
    assert.equal(h.requests.length, 1);
});

test('scroll changed during a slow save is persisted by the following poll', async () => {
    const h = await harness();
    h.window.scrollY = 100;
    const first = h.poll();
    h.window.scrollY = 250;
    const skipped = h.poll();
    const settled = Promise.allSettled([first, skipped]);
    for (const request of h.requests) request.complete();
    await settled;
    assert.equal(h.requests.length, 1);
    const next = h.poll();
    assert.equal(h.requests[1].sent.tabs.first.scrollY, 250);
    h.requests[1].complete();
    await next;
});

test('a failed scroll save surfaces its error and releases the next poll', async () => {
    const h = await harness();
    h.window.scrollY = 100;
    const first = h.poll();
    const failure = new Error('Connection reset');
    const rejected = assert.rejects(first, error => error === failure);
    h.requests[0].reject(failure);
    await rejected;
    const next = h.poll();
    assert.equal(h.requests.length, 2);
    h.requests[1].complete();
    await next;
});

test('a tab switch during a pending scroll save preserves each tabs position', async () => {
    const h = await harness();
    h.window.scrollY = 100;
    const first = h.poll();
    h.context.activeTabId = 'second';
    h.payload.activeTabId = 'second';
    h.window.scrollY = 300;
    h.requests[0].complete();
    await first;
    const second = h.poll();
    assert.equal(h.requests[1].sent.activeTabId, 'second');
    assert.equal(h.requests[1].sent.tabs.first.scrollY, 100);
    assert.equal(h.requests[1].sent.tabs.second.scrollY, 300);
    h.requests[1].complete();
    await second;
});

test('snapshot persistence waits for an active scroll save and avoids a duplicate request', async () => {
    const h = await harness();
    h.window.scrollY = 100;
    const poll = h.poll();
    const explicitSave = h.service.persistTabStateSnapshot();
    const requestCount = h.requests.length;
    const settled = Promise.allSettled([poll, explicitSave]);
    for (const request of h.requests) request.complete();
    const results = await settled;
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
    assert.equal(requestCount, 1);
});

test('a waiting snapshot save reads fresh state after the previous response', async () => {
    const h = await harness();
    h.payload.tabs.first.scrollY = 100;
    const first = h.service.persistTabStateSnapshot();
    h.payload.tabs.first.searchQuery = 'updated search';
    const next = h.service.persistTabStateSnapshot();
    const initialCount = h.requests.length;
    h.requests[0].complete();
    await first;
    await new Promise(setImmediate);
    assert.equal(h.requests.length, 2);
    h.requests[1].complete();
    await next;
    assert.equal(initialCount, 1);
    assert.equal(h.requests[1].sent.tabs.first.searchQuery, 'updated search');
    assert.equal(h.requests[1].sent.version, 2);
});
