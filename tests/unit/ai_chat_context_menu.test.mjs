import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildContextMenuItems } from '../../app/static/js/modules/context-menu/context-menu-registry.js';

const CONTEXT_MENU_SERVICE_URL = new URL(
    '../../app/static/js/modules/context-menu/context-menu-service.js',
    import.meta.url,
);
const CSS_URL = new URL('../../app/static/css/main.css', import.meta.url);


test('view context menu shows the chat toggle with an icon as its first option', () => {
    const toggles = [];
    const items = buildContextMenuItems(
        {
            kind: 'view',
            sortMode: "normal",
            areTabsVisible: false,
            isAiChatVisible: false,
            areNoteTagsVisible: false,
            canAddNoteAtTop: true,
        },
        {
            onSetSortMode: () => {},
            onToggleTabs: () => {},
            onToggleAiChat: (nextValue) => toggles.push(nextValue),
            onToggleNoteTags: () => {},
            onAddNoteAtTop: () => {},
            onExportViewHtml: () => {},
        },
    );

    const chatItem = items.find((item) => item.id === 'toggle-ai-chat');
    assert.ok(chatItem);
    assert.equal(items[0], chatItem);
    assert.equal(chatItem.label, 'Show Chat');
    assert.equal(chatItem.icon, 'chat');
    assert.equal(chatItem.emphasized, undefined);
    chatItem.onSelect();
    assert.deepEqual(toggles, [true]);
});


test('context menu renderer provides the shared chat bubble icon without emphasis styling', () => {
    const serviceSource = readFileSync(CONTEXT_MENU_SERVICE_URL, 'utf8');
    const cssSource = readFileSync(CSS_URL, 'utf8');

    assert.match(serviceSource, /chat:\s*\[\s*'M4 5h16v11H9l-5 4z'/);
    assert.doesNotMatch(serviceSource, /item\.emphasized|is-emphasized/);
    assert.doesNotMatch(cssSource, /is-emphasized/);
});


test('view context menu labels an open AI chat as hide', () => {
    const items = buildContextMenuItems(
        {
            kind: 'view',
            sortMode: "normal",
            areTabsVisible: false,
            isAiChatVisible: true,
            areNoteTagsVisible: false,
            canAddNoteAtTop: false,
        },
        {
            onSetSortMode: () => {},
            onToggleTabs: () => {},
            onToggleAiChat: () => {},
            onToggleNoteTags: () => {},
            onExportViewHtml: () => {},
        },
    );

    assert.equal(
        items.find((item) => item.id === 'toggle-ai-chat').label,
        'Hide Chat',
    );
});
