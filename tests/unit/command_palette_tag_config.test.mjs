import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCommandPaletteEndpoints } from '../../app/static/js/modules/command-palette/endpoint-registry.js';
import {
    loadCommandPaletteTagMap,
    validateCommandPaletteTagMappings,
} from '../../app/static/js/modules/command-palette/tag-config-loader.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const TAG_CONFIG_PATH = resolve(
    TEST_DIR,
    '../../app/static/config/command_palette_tags.json',
);

function buildRealEndpoints() {
    return buildCommandPaletteEndpoints({
        preferencesStore: { getRaw: () => null },
        actions: new Proxy({}, {
            get: (_target, key) => () => {
                throw new Error(`Registry construction must not execute action: ${String(key)}`);
            },
        }),
    });
}

async function loadRealTagMap(t) {
    const payload = JSON.parse(readFileSync(TAG_CONFIG_PATH, 'utf8'));
    t.mock.method(globalThis, 'fetch', async (url) => {
        assert.equal(url, '/static/config/command_palette_tags.json');
        return { ok: true, json: async () => payload };
    });
    return loadCommandPaletteTagMap();
}

test('every shipped tag config row matches the complete runtime endpoint registry', async (t) => {
    const endpoints = buildRealEndpoints();
    const tagMap = await loadRealTagMap(t);

    validateCommandPaletteTagMappings(endpoints, tagMap);
    assert.deepEqual(
        [...tagMap.keys()].sort(),
        endpoints.map((endpoint) => endpoint.id).sort(),
    );
});

test('runtime tag validation rejects an unknown endpoint anywhere in the config', async (t) => {
    const tagMap = await loadRealTagMap(t);
    tagMap.set('action.unregistered', new Set(['unknown']));

    assert.throws(
        () => validateCommandPaletteTagMappings(buildRealEndpoints(), tagMap),
        { message: 'Tag config references unknown endpoint id: action.unregistered' },
    );
});

test('runtime tag validation rejects a registry endpoint with no config row', async (t) => {
    const endpoints = buildRealEndpoints();
    const tagMap = await loadRealTagMap(t);
    const missingEndpointId = endpoints.at(-1).id;
    tagMap.delete(missingEndpointId);

    assert.throws(
        () => validateCommandPaletteTagMappings(endpoints, tagMap),
        { message: `Endpoint ${missingEndpointId} has no tag mapping in config` },
    );
});

test('runtime tag validation rejects duplicate registry endpoint ids', async (t) => {
    const endpoints = buildRealEndpoints();
    const tagMap = await loadRealTagMap(t);
    endpoints.push(endpoints[0]);

    assert.throws(
        () => validateCommandPaletteTagMappings(endpoints, tagMap),
        { message: `Duplicate command palette endpoint id: ${endpoints[0].id}` },
    );
});

test('runtime tag loader rejects duplicate config rows before merging', async (t) => {
    const payload = JSON.parse(readFileSync(TAG_CONFIG_PATH, 'utf8'));
    payload.endpoints.push(payload.endpoints[0]);
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => payload }));

    await assert.rejects(
        loadCommandPaletteTagMap(),
        { message: `Command palette tag config has duplicate id: ${payload.endpoints[0].id}` },
    );
});

test('create backup action matches backup and create queries', () => {
    const source = readFileSync(TAG_CONFIG_PATH, 'utf8');
    const payload = JSON.parse(source);
    const createBackup = payload.endpoints.find((endpoint) => endpoint.id === 'action.create_backup');

    assert.ok(createBackup, 'expected action.create_backup endpoint in command palette tag config');
    assert.equal(createBackup.tags.includes('backups'), true);
    assert.equal(createBackup.tags.includes('create'), true);
});

test('reminders action matches notification queries', () => {
    const source = readFileSync(TAG_CONFIG_PATH, 'utf8');
    const payload = JSON.parse(source);
    const reminders = payload.endpoints.find((endpoint) => endpoint.id === 'form.reminders');

    assert.ok(reminders, 'expected form.reminders endpoint in command palette tag config');
    assert.equal(reminders.tags.includes('notification'), true);
    assert.equal(reminders.tags.includes('notifications'), true);
});

test('animated transitions preference matches motion queries', () => {
    const source = readFileSync(TAG_CONFIG_PATH, 'utf8');
    const payload = JSON.parse(source);
    const animatedTransitions = payload.endpoints.find((endpoint) => endpoint.id === 'pref.animated_transitions');

    assert.ok(animatedTransitions, 'expected pref.animated_transitions endpoint in command palette tag config');
    assert.equal(animatedTransitions.tags.includes('animated'), true);
    assert.equal(animatedTransitions.tags.includes('motion'), true);
    assert.equal(animatedTransitions.tags.includes('disable'), true);
});

test('search result count preference matches count queries', () => {
    const source = readFileSync(TAG_CONFIG_PATH, 'utf8');
    const payload = JSON.parse(source);
    const resultCount = payload.endpoints.find(
        (endpoint) => endpoint.id === 'pref.show_search_results_count',
    );

    assert.ok(resultCount, 'expected pref.show_search_results_count endpoint');
    assert.equal(resultCount.tags.includes('count'), true);
    assert.equal(resultCount.tags.includes('number'), true);
});

test('note timestamp preference is removed from command palette tags', () => {
    const source = readFileSync(TAG_CONFIG_PATH, 'utf8');
    const payload = JSON.parse(source);
    assert.equal(
        payload.endpoints.some((endpoint) => endpoint.id === 'pref.show_note_timestamps'),
        false,
    );
});

test('keyboard shortcuts action matches cheatsheet queries', () => {
    const source = readFileSync(TAG_CONFIG_PATH, 'utf8');
    const payload = JSON.parse(source);
    const shortcuts = payload.endpoints.find(
        (endpoint) => endpoint.id === 'action.open_keyboard_shortcuts_help',
    );

    assert.ok(shortcuts, 'expected keyboard shortcuts endpoint in command palette tag config');
    assert.equal(shortcuts.tags.includes('cheatsheet'), true);
});


test('note layout action matches appearance and hierarchy queries', () => {
    const source = readFileSync(TAG_CONFIG_PATH, 'utf8');
    const payload = JSON.parse(source);
    const noteLayout = payload.endpoints.find(
        (endpoint) => endpoint.id === 'form.note_layout_appearance',
    );

    assert.ok(noteLayout, 'expected note layout endpoint in command palette tag config');
    assert.equal(noteLayout.tags.includes('layout'), true);
    assert.equal(noteLayout.tags.includes('appearance'), true);
    assert.equal(noteLayout.tags.includes('hierarchy'), true);
});


test('content volume sort matches character count query', () => {
    const source = readFileSync(TAG_CONFIG_PATH, 'utf8');
    const payload = JSON.parse(source);
    const contentVolume = payload.endpoints.find(
        (endpoint) => endpoint.id === 'view.sort_mode.content_volume',
    );

    assert.ok(contentVolume, 'expected content-volume sort endpoint in command palette tag config');
    assert.equal(contentVolume.tags.includes('character'), true);
    assert.equal(contentVolume.tags.includes('count'), true);
});

test('combined search suggestion stats and settings form matches all related queries', () => {
    const source = readFileSync(TAG_CONFIG_PATH, 'utf8');
    const payload = JSON.parse(source);
    const statistics = payload.endpoints.find(
        (endpoint) => endpoint.id === 'form.search_suggestion_statistics',
    );

    assert.ok(statistics, 'expected combined search suggestion form');
    for (const tag of [
        'statistics',
        'collected',
        'slots',
        'order',
        'suppress',
        'deduplicate',
        'reset',
    ]) {
        assert.equal(statistics.tags.includes(tag), true, `expected ${tag} tag`);
    }
});
