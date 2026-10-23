import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { openAgentMenu, executeAgentMenuRequest } from '../../app/static/js/modules/ai-chat/agent-menu-actions.js';
import { HttpRequestError } from '../../app/static/js/modules/expected-errors.js';

const catalog = JSON.parse(readFileSync(new URL('../../app/static/config/agent-menu-actions.json', import.meta.url)));

async function withCatalog(callback) {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(catalog));
    try { return await callback(); } finally { globalThis.fetch = original; }
}

for (const target of catalog) {
    test(`menu destination ${target.id} opens only its declared presentation`, async () => withCatalog(async () => {
        const executed = [];
        const selected = [];
        const result = await openAgentMenu({
            menuId: target.id,
            endpoints: catalog.map(entry => ({ id: entry.id, execute: async () => executed.push(entry.id) })),
            isCurrent: () => true, hasOpenModal: () => false,
            queryElement: selector => {
                assert.equal(selector, target.selector);
                return { getClientRects: () => [1] };
            },
            showMenuEntry: async id => selected.push(id), signal: new AbortController().signal,
        });
        assert.equal(result.status, 'opened');
        assert.deepEqual(executed, target.presentation === 'dialog' ? [target.id] : []);
        assert.deepEqual(selected, target.presentation === 'palette' ? [target.id] : []);
    }));
}

for (const blocked of ['stale', 'modal', 'cancelled', 'hidden']) {
    test(`menu execution handles ${blocked} without claiming success`, async () => withCatalog(async () => {
        let calls = 0;
        const controller = new AbortController();
        if (blocked === 'cancelled') controller.abort();
        const result = await openAgentMenu({ menuId: 'form.ai_agent_settings',
            endpoints: [{ id: 'form.ai_agent_settings', execute: async () => { calls++; } }],
            isCurrent: () => blocked !== 'stale', hasOpenModal: () => blocked === 'modal',
            queryElement: () => null, showMenuEntry: async () => assert.fail(), signal: controller.signal });
        assert.notEqual(result.status, 'opened');
        assert.equal(calls, blocked === 'hidden' ? 1 : 0);
    }));
}

test('unknown commands cannot call an endpoint even when the registry contains it', async () => withCatalog(async () => {
    await assert.rejects(openAgentMenu({ menuId: 'run_arbitrary_code',
        endpoints: [{ id: 'run_arbitrary_code', execute: async () => assert.fail() }],
        signal: new AbortController().signal }), /Unsupported agent menu/);
}));

test('browser acknowledgement follows opening, reports external failure and propagates internal bugs', async () => {
    const events = [];
    const options = { event: {request_id: 'request', menu_id: 'form.ai_agent_settings', scope: {}},
        signal: new AbortController().signal,
        acknowledge: async result => events.push(result),
        openMenu: async () => { events.push('opened'); return {status: 'opened', detail: 'Visible'}; } };
    await executeAgentMenuRequest(options);
    assert.deepEqual(events, ['opened', { request_id: 'request', status: 'opened', detail: 'Visible' }]);
    events.length = 0;
    await executeAgentMenuRequest({...options, openMenu: async () => { throw new HttpRequestError('offline'); }});
    assert.equal(events[0].status, 'unavailable');
    events.length = 0;
    await assert.rejects(executeAgentMenuRequest({...options, openMenu: async () => { throw new Error('bug'); }}), /bug/);
    assert.deepEqual(events, []);
});

test('cancellation during opening sends no stale acknowledgement', async () => {
    const controller = new AbortController();
    await executeAgentMenuRequest({event: {request_id: 'x', menu_id: 'form.ai_agent_settings', scope: {}},
        signal: controller.signal, openMenu: async () => { controller.abort(); return {status: 'opened', detail: ''}; },
        acknowledge: async () => assert.fail('Cancelled operation acknowledged')});
});

test('opening a namespace with no other one reports the Create namespace dialog it opened', async () => withCatalog(async () => {
    // With no other namespace, Open/Switch namespace opens Create namespace instead.
    const shown = new Set(['#create-namespace-modal']);
    const result = await openAgentMenu({
        menuId: 'form.open_namespace',
        endpoints: catalog.map(entry => ({ id: entry.id, execute: async () => {} })),
        isCurrent: () => true, hasOpenModal: () => false,
        queryElement: selector => ({ getClientRects: () => (shown.has(selector) ? [1] : []) }),
        showMenuEntry: async () => {}, signal: new AbortController().signal,
    });
    assert.deepEqual(result, { status: 'opened', detail: 'Create vault' });
}));

test('a dialog that opened neither of its forms is reported as not opened', async () => withCatalog(async () => {
    const result = await openAgentMenu({
        menuId: 'form.open_namespace',
        endpoints: catalog.map(entry => ({ id: entry.id, execute: async () => {} })),
        isCurrent: () => true, hasOpenModal: () => false,
        queryElement: () => ({ getClientRects: () => [] }),
        showMenuEntry: async () => {}, signal: new AbortController().signal,
    });
    assert.equal(result.status, 'unavailable');
}));
