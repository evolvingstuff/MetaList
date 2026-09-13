import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const SERVICE_URL = new URL(
    '../../app/static/js/modules/mode-manager/services/note-fullscreen-service.js',
    import.meta.url,
);
const CONTEXT_EVENTS_URL = new URL(
    '../../app/static/js/modules/mode-manager/events/context-menu-events.js',
    import.meta.url,
);
const MAIN_CSS_URL = new URL('../../app/static/css/main.css', import.meta.url);

test('note full screen service provides explicit X and Escape exits', async () => {
    const source = await readFile(SERVICE_URL, 'utf8');

    assert.match(source, /closeButton\.textContent = '×'/);
    assert.match(source, /event\.key !== 'Escape'/);
    assert.match(source, /closeButton\.addEventListener\('click'/);
    assert.match(source, /document\.addEventListener\('keydown', handleFullscreenKeydown/);
    assert.match(source, /tree\.innerHTML = markup/);
});

test('note context menus ignore the rendered full screen subtree', async () => {
    const source = await readFile(CONTEXT_EVENTS_URL, 'utf8');
    assert.match(source, /element\.closest\('\.note-fullscreen-overlay'\)/);
});

test('note full screen close control is anchored in the upper right', async () => {
    const css = await readFile(MAIN_CSS_URL, 'utf8');
    const closeRule = css.match(/\.note-fullscreen-close\s*\{(?<declarations>[^}]*)\}/s);
    assert.ok(closeRule);
    assert.match(closeRule.groups.declarations, /top:\s*18px/);
    assert.match(closeRule.groups.declarations, /right:\s*18px/);
    assert.doesNotMatch(closeRule.groups.declarations, /left:/);
});

test('note full screen hides all global controls', async () => {
    const css = await readFile(MAIN_CSS_URL, 'utf8');
    assert.match(
        css,
        /body\.note-fullscreen-open \.menu-button,\s*body\.note-fullscreen-open \.chat-toggle-button,\s*body\.note-fullscreen-open \.scroll-to-top-button\s*\{[^}]*display:\s*none/s,
    );
});

test('note full screen uses full width without forcing empty space between flex rows', async () => {
    const css = await readFile(MAIN_CSS_URL, 'utf8');
    const scrollRule = css.match(/\.note-fullscreen-scroll\s*\{(?<declarations>[^}]*)\}/s);
    const treeRule = css.match(/\.note-fullscreen-tree\s*\{(?<declarations>[^}]*)\}/s);
    const rootRule = css.match(/\.note-fullscreen-tree\s*>\s*\.note\s*\{(?<declarations>[^}]*)\}/s);
    assert.ok(scrollRule);
    assert.ok(treeRule);
    assert.ok(rootRule);
    assert.match(scrollRule.groups.declarations, /padding:\s*0/);
    assert.match(treeRule.groups.declarations, /width:\s*100%/);
    assert.match(treeRule.groups.declarations, /margin:\s*0/);
    assert.doesNotMatch(rootRule.groups.declarations, /min-height:\s*100vh/);
    assert.match(rootRule.groups.declarations, /align-content:\s*flex-start/);
    assert.match(rootRule.groups.declarations, /border:\s*0/);
});
