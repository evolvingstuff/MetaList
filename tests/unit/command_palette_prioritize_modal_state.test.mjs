import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CONTROLLER_PATH = resolve(
    TEST_DIR,
    '../../app/static/js/modules/command-palette/command-palette-controller.js',
);

function findContainingAsyncMethodStart(source, position) {
    const prefix = source.slice(0, position);
    const matches = Array.from(prefix.matchAll(/\n    async [A-Za-z0-9_]+\([^)]*\) \{/g));
    assert.ok(matches.length > 0, 'modal open should be inside an async controller method');
    const lastMatch = matches[matches.length - 1];
    assert.notEqual(lastMatch.index, undefined, 'method match should have index');
    return lastMatch.index;
}

test('command palette modal preparation saves, deselects, and refreshes note editing', () => {
    const source = readFileSync(CONTROLLER_PATH, 'utf8');
    const helperStart = source.indexOf('async _prepareForModalOpen(commandName) {');
    assert.notEqual(helperStart, -1, '_prepareForModalOpen helper should exist');

    const helperEnd = source.indexOf('\n    async ', helperStart + 1);
    assert.notEqual(helperEnd, -1, '_prepareForModalOpen should be followed by another method');

    const helperSource = source.slice(helperStart, helperEnd);
    assert.match(helperSource, /CommandGate\.run\(`\$\{commandName\}\.exitEditing`, async \(\) => \{/);
    assert.match(helperSource, /await actionDeselectNote\(\);/);
    assert.match(helperSource, /ModeContext\.setSearching\(false\);/);
    assert.match(helperSource, /this\.close\(\);/);
});

test('command palette modal opens are guarded by shared modal preparation', () => {
    const source = readFileSync(CONTROLLER_PATH, 'utf8');
    const modalOpenPattern = /(?:this\._[A-Za-z0-9]+Modal|passwordModal)\.(?:open|openFor[A-Za-z0-9]+|openWith[A-Za-z0-9]+)\(/g;
    const modalOpens = Array.from(source.matchAll(modalOpenPattern));

    assert.ok(modalOpens.length > 0, 'controller should have modal opens to guard');

    for (const modalOpen of modalOpens) {
        assert.notEqual(modalOpen.index, undefined, 'modal open match should have index');
        const methodStart = findContainingAsyncMethodStart(source, modalOpen.index);
        const beforeModalOpen = source.slice(methodStart, modalOpen.index);
        assert.match(
            beforeModalOpen,
            /await this\._prepareForModalOpen\(/,
            `${modalOpen[0]} must be preceded by _prepareForModalOpen in its method`,
        );
    }
});

test('openReminders updates an already-open reminder modal search', () => {
    const source = readFileSync(CONTROLLER_PATH, 'utf8');
    const methodStart = source.indexOf('async openReminders(options) {');
    assert.notEqual(methodStart, -1, 'openReminders should exist');

    const methodEnd = source.indexOf('\n    async ', methodStart + 1);
    const end = methodEnd === -1 ? source.indexOf('\n}', methodStart + 1) : methodEnd;
    assert.notEqual(end, -1, 'openReminders method end should be found');

    const methodSource = source.slice(methodStart, end);
    const updateIndex = methodSource.indexOf('this._reminderModal.setSearchQuery(search);');
    const openIndex = methodSource.indexOf('this._reminderModal.open({ search });');

    assert.notEqual(updateIndex, -1, 'openReminders should update search on an already-open modal');
    assert.notEqual(openIndex, -1, 'openReminders should still open the modal when closed');
    assert.ok(updateIndex < openIndex, 'already-open search update must happen before modal open');
    assert.match(methodSource, /this\._reminderModal !== null && this\._reminderModal\.isOpen/);
});
