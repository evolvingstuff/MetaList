import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const TEMPLATE_URL = new URL('../../app/templates/index.html', import.meta.url);
const CSS_URL = new URL('../../app/static/css/main.css', import.meta.url);
const MOUSE_EVENTS_URL = new URL(
    '../../app/static/js/modules/mode-manager/events/mouse-events.js',
    import.meta.url,
);
const KEYBOARD_EVENTS_URL = new URL(
    '../../app/static/js/modules/mode-manager/events/keyboard-events.js',
    import.meta.url,
);

test('reference source navigation uses a dismissible mode indicator instead of a back arrow', async () => {
    const [template, css, mouseEvents] = await Promise.all([
        readFile(TEMPLATE_URL, 'utf8'),
        readFile(CSS_URL, 'utf8'),
        readFile(MOUSE_EVENTS_URL, 'utf8'),
    ]);

    assert.doesNotMatch(template, /id="reference-back-button"/);
    assert.match(template, /id="reference-source-indicator"[^>]*hidden/);
    assert.match(template, /class="reference-source-indicator-label">Reference source</);
    assert.match(template, /id="reference-source-indicator-clear"/);
    assert.match(css, /\.controls \.reference-source-indicator/);
    assert.match(css, /\.controls \.reference-source-indicator-clear/);
    assert.match(
        mouseEvents,
        /event\.target\.closest\('#reference-source-indicator-clear'\)/,
    );
    assert.match(mouseEvents, /await navigateBackFromReferenceContext\(\)/);
});

test('AI reference collections open a combined OR search in a new tab', async () => {
    const [mouseEvents, keyboardEvents] = await Promise.all([
        readFile(MOUSE_EVENTS_URL, 'utf8'),
        readFile(KEYBOARD_EVENTS_URL, 'utf8'),
    ]);

    assert.match(mouseEvents, /\.ai-chat-open-all-references/);
    assert.match(mouseEvents, /openReferenceQueryInNewTab\(referenceQuery\)/);
    assert.match(keyboardEvents, /export async function openReferenceQueryInNewTab/);
    assert.match(keyboardEvents, /runReferenceSearchInActiveTab\(referenceQuery/);
    assert.match(
        keyboardEvents,
        /'reference\.collection_open_tab',\s*true,/,
    );
    assert.match(
        keyboardEvents,
        /replaceActiveReference && isViewingReferenceSource\(\)/,
    );

    const mouseDownExclusion = mouseEvents.match(
        /function isMouseDownOutsideEditExclusion[\s\S]*?function handleSearchFieldMouseDown/,
    );
    assert.ok(mouseDownExclusion);
    assert.match(mouseDownExclusion[0], /\.ai-chat-open-all-references/);
});

test('AI reference links prefer their exact evidence query over the displayed root', async () => {
    const mouseEvents = await readFile(MOUSE_EVENTS_URL, 'utf8');

    assert.match(mouseEvents, /closest\('\[data-ref-query\]'\)/);
    assert.match(mouseEvents, /openReferenceQueryInNewTab\(referenceQuery\)/);
});

test('copied AI response references save and exit editing before navigation', async () => {
    const mouseEvents = await readFile(MOUSE_EVENTS_URL, 'utf8');
    const collectionHandler = mouseEvents.match(
        /function handleAiChatOpenAllReferencesClick[\s\S]*?function handleReferenceLinkClick/,
    );
    const referenceHandler = mouseEvents.match(
        /function handleReferenceLinkClick[\s\S]*?function handleFileReferenceClick/,
    );

    assert.ok(collectionHandler);
    assert.ok(referenceHandler);
    for (const handler of [collectionHandler[0], referenceHandler[0]]) {
        assert.match(
            handler,
            /\.ai-chat-message-content\[data-markdown-rendered="true"\]/,
        );
        const deselectIndex = handler.indexOf('await actionDeselectNote();');
        const navigateIndex = handler.indexOf('await openReferenceQueryInNewTab(referenceQuery);');
        assert.ok(deselectIndex >= 0);
        assert.ok(navigateIndex > deselectIndex);
    }
});

test('ordinary note references retain stacked navigation behavior', async () => {
    const keyboardEvents = await readFile(KEYBOARD_EVENTS_URL, 'utf8');

    assert.match(
        keyboardEvents,
        /'reference\.link_open_tab',\s*false,/,
    );
});
