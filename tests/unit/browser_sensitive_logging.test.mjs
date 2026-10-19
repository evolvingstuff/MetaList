import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { CONFIG } from '../../app/static/js/modules/config.js';
import * as Logger from '../../app/static/js/modules/mode-manager/mode-logger.js';


test('browser API payload logging is disabled by default', () => {
    assert.equal(CONFIG.DEBUG.LOG_API_CALLS, false);
    assert.equal(CONFIG.DEBUG.LOG_STATE_CHANGES, false);
});


test('mode logger never serializes caller-provided values', (t) => {
    const originalLog = console.log;
    const originalError = console.error;
    const calls = [];
    console.log = (...args) => calls.push(args);
    console.error = (...args) => calls.push(args);
    t.after(() => {
        console.log = originalLog;
        console.error = originalError;
    });

    Logger.logDebug('debug event', { value: 'private debug value' });
    Logger.logAction('private action value', { value: 'private action data' });
    Logger.logState('currentContent', 'private new content', 'private old content');
    Logger.logError('private error message', new Error('private exception value'));

    const rendered = JSON.stringify(calls);
    assert.doesNotMatch(rendered, /private debug value/);
    assert.doesNotMatch(rendered, /private action data/);
    assert.doesNotMatch(rendered, /private new content/);
    assert.doesNotMatch(rendered, /private old content/);
    assert.doesNotMatch(rendered, /private exception value/);
});


test('known direct console calls do not emit decrypted values', async () => {
    const paths = [
        'app/static/js/modules/api-client.js',
        'app/static/js/modules/dom-utils.js',
        'app/static/js/modules/mode-manager/mode-context.js',
    ];
    const forbidden = [
        'body: bodySummary',
        "console.log('[API] Final headers:'",
        'data: responseSummary',
        'Selected text:',
        "console.log('Setting search query from tab', tabId, 'query:', newQuery)",
        "console.log('Note element:', noteElement)",
    ];

    for (const path of paths) {
        const source = await readFile(path, 'utf8');
        for (const fragment of forbidden) {
            assert.equal(source.includes(fragment), false, `${path} contains ${fragment}`);
        }
    }
});


async function javascriptPaths(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = [];
    for (const entry of entries) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
            if (entry.name !== 'vendor') {
                paths.push(...await javascriptPaths(path));
            }
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            paths.push(path);
        }
    }
    return paths;
}


test('browser console calls never serialize raw Error objects', async () => {
    const paths = await javascriptPaths('app/static/js');
    const rawErrorArgument = /console\.(?:log|warn|error)\([^;\n]*,\s*error(?:\s*,|\s*\))/;

    for (const path of paths) {
        const source = await readFile(path, 'utf8');
        assert.doesNotMatch(source, rawErrorArgument, path);
    }
});


test('browser password submission code never passes password values to console calls', async () => {
    const paths = [
        'app/static/js/modules/auth.js',
        'app/static/js/modules/modals/password-modal.js',
    ];
    const sensitiveIdentifiers = /\b(?:password|currentPassword|newPassword|confirmPassword|formData|body)\b/i;
    const consoleCall = /console\.(?:log|warn|error)\(([\s\S]*?)\);/g;
    const quotedLiteral = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;

    for (const path of paths) {
        const source = await readFile(path, 'utf8');
        for (const match of source.matchAll(consoleCall)) {
            const executableArguments = match[1].replaceAll(quotedLiteral, '');
            assert.doesNotMatch(executableArguments, sensitiveIdentifiers, `${path}: ${match[0]}`);
        }
    }
});
