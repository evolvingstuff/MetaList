import assert from 'node:assert/strict';
import test from 'node:test';

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


test('PreferencesStore.removeMany persists one snapshot without the selected keys', async () => {
    const originalFetch = globalThis.fetch;
    const originalSessionStorage = globalThis.sessionStorage;
    const persistedBodies = [];
    globalThis.sessionStorage = {
        getItem: (key) => key === 'metalist_tab_id' ? 'test-tab' : null,
    };
    globalThis.fetch = async (_url, options) => {
        persistedBodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ preferences: options.body }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const store = new PreferencesStore();
        store.replaceAll({ keep: 'yes', removeA: 'a', removeB: 'b' });

        await store.removeMany(['removeA', 'removeB']);

        assert.equal(store.getRaw('keep'), 'yes');
        assert.equal(store.getRaw('removeA'), null);
        assert.equal(store.getRaw('removeB'), null);
        assert.deepEqual(persistedBodies, [{ preferences: { keep: 'yes' } }]);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.sessionStorage = originalSessionStorage;
    }
});


test('PreferencesStore.removeMany rejects empty, duplicate, and invalid keys', async () => {
    const store = new PreferencesStore();

    await assert.rejects(store.removeMany([]), /non-empty keys array/);
    await assert.rejects(store.removeMany(['same', 'same']), /unique keys/);
    await assert.rejects(store.removeMany(['valid', '']), /non-empty string keys/);
});


test('PreferencesStore updates new prompt keys and removes superseded keys atomically', async () => {
    const originalFetch = globalThis.fetch;
    const originalSessionStorage = globalThis.sessionStorage;
    const persistedBodies = [];
    globalThis.sessionStorage = {
        getItem: (key) => key === 'metalist_tab_id' ? 'test-tab' : null,
    };
    globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        persistedBodies.push(body);
        return new Response(JSON.stringify({ preferences: body.preferences }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const store = new PreferencesStore();
        store.replaceAll({ oldSkill: 'old', keep: 'yes' });

        await store.setManyAndRemove({ newSkill: 'new' }, ['oldSkill']);

        assert.equal(store.getRaw('oldSkill'), null);
        assert.equal(store.getRaw('newSkill'), 'new');
        assert.equal(store.getRaw('keep'), 'yes');
        assert.deepEqual(persistedBodies, [{
            preferences: { keep: 'yes', newSkill: 'new' },
        }]);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.sessionStorage = originalSessionStorage;
    }
});
