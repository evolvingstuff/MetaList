import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeSessionIdentity } from '../../app/static/js/modules/session-auth.js';

import { PreferencesStore } from '../../app/static/js/modules/command-palette/preferences-store.js';
import { UsageStore } from '../../app/static/js/modules/command-palette/usage-store.js';

test('preference setters reject unchanged values before persistence', async () => {
    const store = new PreferencesStore();
    store.replaceAll({ theme: 'dark' });
    await assert.rejects(store.setRaw('theme', 'dark'), /Redundant state change/);
    await assert.rejects(store.setMany({ theme: 'dark' }), /Redundant state change/);
});

test('usage hydration owns its input records', () => {
    const store = new UsageStore();
    const input = { action: { count: 1 } };
    store.replaceAll(input);
    input.action.count = 99;
    assert.equal(store.getUsageSnapshot().action.count, 1);
});


// A click that lands while the previous click's save is still on its way to the
// server (the FATAL "Redundant state change: preferences" on 0.13.0).
function slowPreferenceServer() {
    const persisted = [];
    const originalFetch = globalThis.fetch;
    const originalSessionStorage = globalThis.sessionStorage;
    globalThis.sessionStorage = { getItem: (key) => (key === 'metalist_tab_id' ? 'test-tab' : null) };
    initializeSessionIdentity();
    globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        await new Promise((resolve) => setTimeout(resolve, 20));
        persisted.push(body.preferences);
        return new Response(JSON.stringify({ preferences: body.preferences }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
    return {
        persisted,
        restore() {
            globalThis.fetch = originalFetch;
            globalThis.sessionStorage = originalSessionStorage;
        },
    };
}

test('a second change while the first is still saving is saved after it, not lost or refused', async () => {
    const server = slowPreferenceServer();
    try {
        const store = new PreferencesStore();
        store.replaceAll({ 'pref.ai.show_spend': 'false' });

        // Double click: show, then hide again, without waiting for the first save.
        const first = store.setRaw('pref.ai.show_spend', 'true');
        const second = store.setRaw('pref.ai.show_spend', 'false');
        await Promise.all([first, second]);

        assert.equal(store.getRaw('pref.ai.show_spend'), 'false');
        assert.deepEqual(server.persisted, [{ 'pref.ai.show_spend': 'true' }, { 'pref.ai.show_spend': 'false' }]);
    } finally {
        server.restore();
    }
});

test('two different preferences changed at once are both kept', async () => {
    const server = slowPreferenceServer();
    try {
        const store = new PreferencesStore();
        store.replaceAll({ a: '1', b: '1' });

        await Promise.all([store.setRaw('a', '2'), store.setRaw('b', '2')]);

        assert.equal(store.getRaw('a'), '2');
        assert.equal(store.getRaw('b'), '2');
        // The second save includes the first change rather than overwriting it.
        assert.deepEqual(server.persisted.at(-1), { a: '2', b: '2' });
    } finally {
        server.restore();
    }
});

test('asking twice for the same value is still refused as a mistake', async () => {
    const server = slowPreferenceServer();
    try {
        const store = new PreferencesStore();
        store.replaceAll({ theme: 'light' });
        const first = store.setRaw('theme', 'dark');
        // Refused at once: 'dark' is already what was asked for.
        await assert.rejects(store.setRaw('theme', 'dark'), /Redundant state change/);
        await first;
        assert.equal(store.getRaw('theme'), 'dark');
        assert.deepEqual(server.persisted, [{ theme: 'dark' }]);
    } finally {
        server.restore();
    }
});


test('a toggle pressed twice quickly turns back off, reading the value the first press asked for', async () => {
    const server = slowPreferenceServer();
    try {
        const store = new PreferencesStore();
        store.replaceAll({ 'pref.show_note_tags': 'false' });
        const toggle = () => store.setRaw('pref.show_note_tags', store.getRaw('pref.show_note_tags') === 'true' ? 'false' : 'true');

        await Promise.all([toggle(), toggle()]);

        assert.equal(store.getRaw('pref.show_note_tags'), 'false');
        assert.deepEqual(server.persisted, [{ 'pref.show_note_tags': 'true' }, { 'pref.show_note_tags': 'false' }]);
    } finally {
        server.restore();
    }
});


test('when a save fails, the changes queued after it fail loudly too instead of running', async () => {
    const originalFetch = globalThis.fetch;
    const originalSessionStorage = globalThis.sessionStorage;
    globalThis.sessionStorage = { getItem: (key) => (key === 'metalist_tab_id' ? 'test-tab' : null) };
    initializeSessionIdentity();
    const sent = [];
    globalThis.fetch = async (_url, options) => {
        sent.push(JSON.parse(options.body).preferences);
        return new Response(JSON.stringify({ detail: 'disk full' }), { status: 500, headers: { 'content-type': 'application/json' } });
    };
    try {
        const store = new PreferencesStore();
        store.replaceAll({ a: '1' });
        const first = store.setRaw('a', '2');
        const second = store.setRaw('a', '3');
        await assert.rejects(first);
        await assert.rejects(second);
        assert.equal(sent.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.sessionStorage = originalSessionStorage;
    }
});
