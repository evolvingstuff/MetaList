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

test('createBackup configures a longer CommandGate watchdog timeout', () => {
    const source = readFileSync(CONTROLLER_PATH, 'utf8');
    const match = source.match(
        /async createBackup\(\) \{[\s\S]*?CommandGate\.run\('commandPalette\.createBackup', async \(\) => \{[\s\S]*?\},\s*\{\s*timeoutMs:\s*LONG_COMMAND_TIMEOUT_SECONDS \* MS_PER_SECOND,\s*\}\s*\)/,
    );

    assert.ok(match, 'createBackup should pass explicit timeoutMs to CommandGate.run');
    const seconds = source.match(/^const LONG_COMMAND_TIMEOUT_SECONDS = (\d+);$/m);
    assert.ok(seconds, 'the long command timeout is a named number of seconds');
    assert.equal(Number(seconds[1]), 120);

    const waitIndex = source.indexOf('await waitForCommandAvailability({', source.indexOf('async createBackup()'));
    const runIndex = source.indexOf("CommandGate.run('commandPalette.createBackup'", source.indexOf('async createBackup()'));
    assert.ok(waitIndex >= 0, 'createBackup should wait for browser command availability');
    assert.ok(waitIndex < runIndex, 'createBackup should wait before entering CommandGate');
    assert.match(
        source.slice(runIndex, source.indexOf('async logout()', runIndex)),
        /if \(backupResult === null\) \{\s*throw new Error\(/,
        'createBackup must not silently discard a dropped command',
    );
    assert.match(
        source.slice(runIndex, source.indexOf('async logout()', runIndex)),
        /_authRequest\(CONFIG\.API\.BACKUP\.RUN, 'POST', backupSettings\)/,
        'createBackup must submit the validated settings in the backup-creation request',
    );
});
