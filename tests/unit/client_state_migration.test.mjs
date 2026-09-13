import assert from 'node:assert/strict';
import test from 'node:test';


function createStorage(initialEntries = {}) {
    const entries = new Map(Object.entries(initialEntries));
    return {
        getItem(key) {
            return entries.has(key) ? entries.get(key) : null;
        },
        setItem(key, value) {
            entries.set(key, String(value));
        },
        removeItem(key) {
            entries.delete(key);
        },
        clear() {
            entries.clear();
        },
    };
}


function installBrowserStorage() {
    const originalSessionStorage = globalThis.sessionStorage;
    const originalLocalStorage = globalThis.localStorage;
    const originalFetch = globalThis.fetch;

    globalThis.sessionStorage = createStorage();
    globalThis.localStorage = createStorage();
    globalThis.fetch = originalFetch;

    return () => {
        globalThis.sessionStorage = originalSessionStorage;
        globalThis.localStorage = originalLocalStorage;
        globalThis.fetch = originalFetch;
    };
}

test('legacy storage containing only the retired performance overlay is cleared without a write request', async (t) => {
    t.after(installBrowserStorage());
    globalThis.localStorage.setItem('metalist.command_palette.pref.pref.show_perf_overlay', 'true');
    globalThis.localStorage.setItem('metalist.command_palette.usage.v1', JSON.stringify({
        'pref.show_perf_overlay': {count: 1, lastUsedAt: 42, lastQueryTokens: ['perf']},
    }));
    const {migrateLegacyClientState} = await import('../../app/static/js/modules/client-state-migration.js');
    const migrated = await migrateLegacyClientState({
        clientState: {preferences: {}, command_palette_usage: {}},
        persistClientPreferencesFn: async () => assert.fail('No active preferences to migrate'),
        persistCommandPaletteUsageFn: async () => assert.fail('No active usage to migrate'),
    });
    assert.deepEqual(migrated, {preferences: {}, command_palette_usage: {}});
    assert.equal(globalThis.localStorage.getItem('metalist.command_palette.pref.pref.show_perf_overlay'), null);
    assert.equal(globalThis.localStorage.getItem('metalist.command_palette.usage.v1'), null);
});


test('buildSessionHeaders includes the tab id and optional content type', async () => {
    const restoreGlobals = installBrowserStorage();
    globalThis.sessionStorage.setItem('metalist_tab_id', 'tab-123');

    const { buildSessionHeaders } = await import('../../app/static/js/modules/session-auth.js');

    assert.deepEqual(buildSessionHeaders(true), {
        'Content-Type': 'application/json',
        'X-Metalist-Tab-Id': 'tab-123',
    });
    assert.deepEqual(buildSessionHeaders(false), {
        'X-Metalist-Tab-Id': 'tab-123',
    });

    restoreGlobals();
});


test('client-state API helpers call the database-backed auth endpoints', async () => {
    const restoreGlobals = installBrowserStorage();
    globalThis.sessionStorage.setItem('metalist_tab_id', 'tab-456');

    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return new Response(
            JSON.stringify({
                preferences: { 'pref.theme': 'dark' },
                command_palette_usage: {},
            }),
            {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                },
            },
        );
    };

    const {
        loadClientState,
        persistClientPreferences,
        persistCommandPaletteUsage,
    } = await import('../../app/static/js/modules/client-state-api.js');

    const loaded = await loadClientState();
    assert.deepEqual(loaded, {
        preferences: { 'pref.theme': 'dark' },
        command_palette_usage: {},
    });

    await persistClientPreferences({ 'pref.theme': 'dark' });
    await persistCommandPaletteUsage({
        'command.logout': {
            count: 1,
            lastUsedAt: 42,
            lastQueryTokens: ['logout'],
        },
    });

    assert.equal(requests[0].url, '/api2/auth/client-state');
    assert.equal(requests[0].options.method, 'GET');
    assert.deepEqual(requests[0].options.headers, {
        'X-Metalist-Tab-Id': 'tab-456',
    });

    assert.equal(requests[1].url, '/api2/auth/client-state/preferences');
    assert.equal(requests[1].options.method, 'PUT');
    assert.deepEqual(requests[1].options.headers, {
        'Content-Type': 'application/json',
        'X-Metalist-Tab-Id': 'tab-456',
    });
    assert.equal(
        requests[1].options.body,
        JSON.stringify({ preferences: { 'pref.theme': 'dark' } }),
    );

    assert.equal(requests[2].url, '/api2/auth/client-state/command-palette-usage');
    assert.equal(requests[2].options.method, 'PUT');
    assert.deepEqual(requests[2].options.headers, {
        'Content-Type': 'application/json',
        'X-Metalist-Tab-Id': 'tab-456',
    });
    assert.equal(
        requests[2].options.body,
        JSON.stringify({
            command_palette_usage: {
                'command.logout': {
                    count: 1,
                    lastUsedAt: 42,
                    lastQueryTokens: ['logout'],
                },
            },
        }),
    );

    restoreGlobals();
});


test('client-state API reports a server failure without parsing an HTML error page as JSON', async () => {
    const restoreGlobals = installBrowserStorage();
    globalThis.sessionStorage.setItem('metalist_tab_id', 'tab-500');
    globalThis.fetch = async () => new Response('<html>Server error</html>', {
        status: 500,
        headers: {
            'content-type': 'text/html; charset=utf-8',
        },
    });

    const { loadClientState } = await import('../../app/static/js/modules/client-state-api.js');

    await assert.rejects(
        loadClientState(),
        /Failed to load client state \(500\)/,
    );
    restoreGlobals();
});


test('client-state API identifies an expired authenticated session', async () => {
    const restoreGlobals = installBrowserStorage();
    globalThis.sessionStorage.setItem('metalist_tab_id', 'tab-expired');
    globalThis.fetch = async () => new Response(
        JSON.stringify({ detail: 'Authentication required' }),
        {
            status: 401,
            headers: {
                'content-type': 'application/json',
            },
        },
    );

    const {
        AuthenticationRequiredError,
        persistCommandPaletteUsage,
    } = await import('../../app/static/js/modules/client-state-api.js');

    await assert.rejects(
        persistCommandPaletteUsage({ 'command.generate_random_password': { count: 1 } }),
        (error) => {
            assert.ok(error instanceof AuthenticationRequiredError);
            assert.match(error.message, /Authentication required/);
            return true;
        },
    );
    restoreGlobals();
});


test('migrateLegacyClientState persists merged legacy localStorage data and clears it', async () => {
    const restoreGlobals = installBrowserStorage();
    globalThis.localStorage.setItem('metalist.command_palette.pref.pref.theme', 'dark');
    globalThis.localStorage.setItem('metalist.command_palette.pref.pref.show_note_tags', 'true');
    globalThis.localStorage.setItem('metalist.command_palette.pref.pref.show_rhs_panel', 'true');
    globalThis.localStorage.setItem('metalist.command_palette.pref.pref.show_perf_overlay', 'true');
    globalThis.localStorage.setItem(
        'metalist.command_palette.usage.v1',
        JSON.stringify({
            'pref.show_perf_overlay': {count: 2, lastUsedAt: 90, lastQueryTokens: ['perf']},
            'command.logout': {
                count: 3,
                lastUsedAt: 100,
                lastQueryTokens: ['logout'],
            },
        }),
    );

    const persistedPreferences = [];
    const persistedUsage = [];

    const {
        migrateLegacyClientState,
        resolveStoredThemePreference,
    } = await import('../../app/static/js/modules/client-state-migration.js');

    assert.equal(resolveStoredThemePreference({}), 'dark');

    const migrated = await migrateLegacyClientState({
        clientState: {
            preferences: {
                'pref.show_backlinks': 'false',
                'pref.show_perf_overlay': 'true',
            },
            command_palette_usage: {
                'pref.show_perf_overlay': {count: 1, lastUsedAt: 80, lastQueryTokens: ['overlay']},
                'command.logout': {
                    count: 1,
                    lastUsedAt: 50,
                    lastQueryTokens: ['old'],
                },
                'command.palette': {
                    count: 2,
                    lastUsedAt: 75,
                    lastQueryTokens: ['palette'],
                },
            },
        },
        persistClientPreferencesFn: async (preferences) => {
            persistedPreferences.push(preferences);
        },
        persistCommandPaletteUsageFn: async (usageState) => {
            persistedUsage.push(usageState);
        },
    });

    assert.deepEqual(migrated, {
        preferences: {
            'pref.show_backlinks': 'false',
            'pref.show_note_tags': 'true',
            'pref.theme': 'dark',
        },
        command_palette_usage: {
            'command.logout': {
                count: 3,
                lastUsedAt: 100,
                lastQueryTokens: ['logout'],
            },
            'command.palette': {
                count: 2,
                lastUsedAt: 75,
                lastQueryTokens: ['palette'],
            },
        },
    });
    assert.deepEqual(persistedPreferences, [migrated.preferences]);
    assert.deepEqual(persistedUsage, [migrated.command_palette_usage]);
    assert.equal(globalThis.localStorage.getItem('metalist.command_palette.pref.pref.theme'), null);
    assert.equal(globalThis.localStorage.getItem('metalist.command_palette.pref.pref.show_note_tags'), null);
    assert.equal(globalThis.localStorage.getItem('metalist.command_palette.pref.pref.show_rhs_panel'), null);
    assert.equal(globalThis.localStorage.getItem('metalist.command_palette.pref.pref.show_perf_overlay'), null);
    assert.equal(globalThis.localStorage.getItem('metalist.command_palette.usage.v1'), null);

    restoreGlobals();
});
