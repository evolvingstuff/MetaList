import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildContextMenuItems } from '../../app/static/js/modules/context-menu/context-menu-registry.js';

const CONTEXT_MENU_SERVICE_URL = new URL(
    '../../app/static/js/modules/context-menu/context-menu-service.js',
    import.meta.url,
);
const CSS_URL = new URL('../../app/static/css/main.css', import.meta.url);


function chatToggle(isAiChatVisible, toggles) {
    const noop = () => {};
    const items = buildContextMenuItems(
        {
            kind: 'view', isMac: true, isEditing: false, canPasteNoteAtTop: false, canGoToTop: false, canGoToBottom: false,
            isUntaggedView: false, theme: 'system', sortMode: 'normal', dateRangeKind: 'none', dateRangeField: 'updated',
            areTabsVisible: false, isAiChatVisible, areNoteTagsVisible: false,
        },
        {
            onAddNoteAtTop: noop, onUndo: noop, onRedo: noop, onFullyExpandAll: noop, onFullyCollapseAll: noop,
            onSetUntaggedView: noop, onSetSortMode: noop, onToggleTabs: noop, onToggleNoteTags: noop,
            onSetDateRangeField: noop, onSetDateRangePreset: noop, onOpenCustomDateRange: noop,
            onToggleAiChat: (nextValue) => toggles.push(nextValue),
            onSetTheme: noop, onNewTab: noop, onOpenNamespace: noop, onOpenReminders: noop,
            onExportViewHtml: noop, onPrintView: noop, onLogOut: noop,
        },
    );
    return items.find((item) => item.id === 'show').submenu.find((item) => item.id === 'show-chat');
}


test('the background menu shows the chat toggle with an icon under Show', () => {
    const toggles = [];
    const chatItem = chatToggle(false, toggles);
    assert.equal(chatItem.label, 'Chat');
    assert.equal(chatItem.icon, 'chat');
    assert.equal(chatItem.checked, false);
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


test('an open AI chat is ticked and selecting it hides the chat', () => {
    const toggles = [];
    const chatItem = chatToggle(true, toggles);
    assert.equal(chatItem.checked, true);
    chatItem.onSelect();
    assert.deepEqual(toggles, [false]);
});
