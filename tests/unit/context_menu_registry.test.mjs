import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildContextMenuItems, formatMenuShortcut } from '../../app/static/js/modules/context-menu/context-menu-registry.js';
import { isContextMenuIconSupported } from '../../app/static/js/modules/context-menu/context-menu-service.js';

const CONTEXT_MENU_EVENTS_URL = new URL(
    '../../app/static/js/modules/mode-manager/events/context-menu-events.js',
    import.meta.url,
);

function buildNoteHandlers(calls) {
    return {
        onCopySelection: (noteId) => calls.push(['copySelection', noteId]),
        onAddSelectionAsTag: (noteId, selectedText) => calls.push(['addSelectionAsTag', noteId, selectedText]),
        onAddStyle: (noteId, styleTag) => calls.push(['addStyle', noteId, styleTag]),
        onRemoveFormatting: (noteId) => calls.push(['removeFormatting', noteId]),
        onCopyNote: (noteId) => calls.push(['copyNote', noteId]),
        onPasteNote: (noteId) => calls.push(['pasteNote', noteId]),
        onPasteNoteChild: (noteId) => calls.push(['pasteNoteChild', noteId]),
        onPasteReference: (noteId) => calls.push(['pasteReference', noteId]),
        onPasteReferenceChild: (noteId) => calls.push(['pasteReferenceChild', noteId]),
        onOpenReferenceSource: (referenceNoteId) => calls.push(['openReferenceSource', referenceNoteId]),
        onMakeImageBigger: (context) => calls.push(['makeImageBigger', context]),
        onMakeImageSmaller: (context) => calls.push(['makeImageSmaller', context]),
        onResetImageSize: (context) => calls.push(['resetImageSize', context]),
        onExportNoteHtml: (noteId) => calls.push(['exportNoteHtml', noteId]),
        onExportViewHtml: () => calls.push(['exportViewHtml']),
        onPrintNote: (noteId) => calls.push(['printNote', noteId]),
        onPrintView: () => calls.push(['printView']),
        onViewNoteFullscreen: (noteId) => calls.push(['viewNoteFullscreen', noteId]),
        onFullyExpandNote: (noteId) => calls.push(['fullyExpandNote', noteId]),
        onFullyCollapseNote: (noteId) => calls.push(['fullyCollapseNote', noteId]),
        onAddNoteAtTop: () => calls.push(['addNoteAtTop']),
        onAddSiblingNote: (noteId) => calls.push(['addSibling', noteId]),
        onAddChildNote: (noteId) => calls.push(['addChild', noteId]),
        onDeleteNote: (noteId) => calls.push(['delete', noteId]),
        onMoveNoteToTop: (noteId) => calls.push(['moveToTop', noteId]),
        onMoveNoteToBottom: (noteId) => calls.push(['moveToBottom', noteId]),
        onMoveNoteUp: (noteId) => calls.push(['moveUp', noteId]),
        onMoveNoteDown: (noteId) => calls.push(['moveDown', noteId]),
        onIndentNote: (noteId) => calls.push(['indent', noteId]),
        onOutdentNote: (noteId) => calls.push(['outdent', noteId]),
    };
}

function buildNoteContext(overrides = {}) {
    return {
        kind: 'note',
        noteId: 'note-123',
        noteTimestamps: {
            created: 'Aug 17, 2026, 11:00 AM',
            updated: 'Aug 17, 2026, 12:45 PM',
        },
        isMac: true,
        hasChildren: true,
        canMoveToTop: true,
        canMoveToBottom: true,
        canMoveUp: true,
        canMoveDown: true,
        canIndent: true,
        canOutdent: true,
        ...overrides,
    };
}

test('buildContextMenuItems prepends source action for a reference context', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({
            noteId: 'host-note-123',
            referenceNoteId: 'source-note-456',
        }),
        buildNoteHandlers(calls),
    );

    assert.deepEqual(
        {
            id: items[0].id,
            label: items[0].label,
            icon: items[0].icon,
            enabled: items[0].enabled,
        },
        {
            id: 'open-reference-source',
            label: 'Go to Source',
            icon: 'external',
            enabled: true,
        },
    );
    assert.equal(items[1].separated, true);

    items[0].onSelect();
    assert.deepEqual(calls, [['openReferenceSource', 'source-note-456']]);
});

// The menu as text: "— " marks a separator, submenus are listed in brackets.
function menuOutline(items) {
    return items.filter((item) => item.kind !== 'info').map((item) => {
        const text = `${item.separated === true ? '— ' : ''}${item.label}${item.shortcut === undefined ? '' : ` ${item.shortcut}`}`;
        return item.submenu === undefined ? text : [text, menuOutline(item.submenu)];
    });
}

function findMenuItem(items, id) {
    for (const item of items) {
        if (item.id === id) return item;
        if (item.submenu !== undefined) {
            const found = findMenuItem(item.submenu, id);
            if (found !== null) return found;
        }
    }
    return null;
}

test('the note menu groups copy, add, move, outline, focus, export, and delete last', () => {
    const calls = [];
    const items = buildContextMenuItems(buildNoteContext({ canOpenFloatingNote: true, canViewFullscreen: true }), { ...buildNoteHandlers(calls), onOpenFloatingNote: (noteId) => calls.push(['floating', noteId]) });
    assert.deepEqual(menuOutline(items), [
        'Copy Note ⌘C',
        ['— Add', ['Add Sibling Note ⌘↩', 'Add Child Note ⇧⌘↩']],
        ['Move', ['Move to Top ⇧⌘↑', 'Move Up ⌘↑', 'Move Down ⌘↓', 'Move to Bottom ⇧⌘↓']],
        ['Outline', ['Fully Expand', 'Fully Collapse', '— Indent ⌘→', 'Outdent ⌘←']],
        ['Focus', ['Full Screen', 'Floating Window']],
        // A note always comes with its children.
        ['Export', ['Note as HTML', 'View as HTML']],
        ['Print', ['Note', 'View']],
        '— Delete Note ⌘⌫',
    ]);
    assert.equal(items[items.length - 1].kind, 'info');
});

test('note menu actions call their handlers with the clicked note', () => {
    const calls = [];
    const items = buildContextMenuItems(buildNoteContext({}), buildNoteHandlers(calls));
    const leaves = items.filter((item) => item.kind !== 'info').flatMap((item) => (item.submenu === undefined ? [item] : item.submenu));
    for (const item of leaves) item.onSelect();
    assert.deepEqual(calls, [
        ['copyNote', 'note-123'],
        ['addSibling', 'note-123'],
        ['addChild', 'note-123'],
        ['moveToTop', 'note-123'],
        ['moveUp', 'note-123'],
        ['moveDown', 'note-123'],
        ['moveToBottom', 'note-123'],
        ['fullyExpandNote', 'note-123'],
        ['fullyCollapseNote', 'note-123'],
        ['indent', 'note-123'],
        ['outdent', 'note-123'],
        ['exportNoteHtml', 'note-123'],
        ['exportViewHtml'],
        ['printNote', 'note-123'],
        ['printView'],
        ['delete', 'note-123'],
    ]);
});

// The labels a group shows: its submenu, a single action in place, or null.
function groupLabels(items, groupId, memberIds) {
    const item = items.find((entry) => entry.id === groupId || memberIds.includes(entry.id));
    if (item === undefined) return null;
    return item.submenu === undefined ? [item.label] : item.submenu.map((entry) => entry.label);
}

const MOVE_IDS = ['move-note-to-top', 'move-note-up', 'move-note-down', 'move-note-to-bottom'];
const OUTLINE_IDS = ['fully-expand-note', 'fully-collapse-note', 'indent-note', 'outdent-note'];

test('a Focus group with one action shows it in place with its full name', () => {
    const items = buildContextMenuItems(buildNoteContext({ canOpenFloatingNote: true, canViewFullscreen: false }), { ...buildNoteHandlers([]), onOpenFloatingNote: () => {} });
    const floating = items.find((item) => item.id === 'open-floating-note');
    assert.equal(floating.label, 'Open in Floating Window');
    assert.equal(floating.inlineLabel, undefined);
    assert.equal(items.find((item) => item.id === 'focus'), undefined);
    const both = buildContextMenuItems(buildNoteContext({ canOpenFloatingNote: true, canViewFullscreen: true }), { ...buildNoteHandlers([]), onOpenFloatingNote: () => {} });
    assert.ok(both.find((item) => item.id === 'focus').submenu.every((item) => item.inlineLabel === undefined));
});

test('Move and Outline hide what cannot happen from this note', () => {
    const menu = (overrides) => buildContextMenuItems(buildNoteContext(overrides), buildNoteHandlers([]));
    const move = (overrides) => groupLabels(menu(overrides), 'move', MOVE_IDS);
    const outline = (overrides) => groupLabels(menu(overrides), 'outline', OUTLINE_IDS);

    // First of its siblings: nothing upward.
    assert.deepEqual(move({ canMoveToTop: false, canMoveUp: false }), ['Move Down', 'Move to Bottom']);
    // Last of its siblings: nothing downward.
    assert.deepEqual(move({ canMoveDown: false, canMoveToBottom: false }), ['Move to Top', 'Move Up']);
    // A root while a sort order is active: no Move group at all.
    assert.equal(move({ canMoveToTop: false, canMoveUp: false, canMoveDown: false, canMoveToBottom: false }), null);

    // No children: nothing to expand or collapse, and no separator before Indent.
    assert.deepEqual(outline({ hasChildren: false }), ['Indent', 'Outdent']);
    assert.equal(menu({ hasChildren: false }).find((item) => item.id === 'outline').submenu[0].separated, undefined);
    // First of its siblings and a root: only Fully Expand/Collapse.
    assert.deepEqual(outline({ canIndent: false, canOutdent: false }), ['Fully Expand', 'Fully Collapse']);
    // A single possible action is shown in place, not as a one-item submenu.
    assert.deepEqual(outline({ hasChildren: false, canIndent: false }), ['Outdent']);
    assert.equal(menu({ hasChildren: false, canIndent: false }).find((item) => item.id === 'outdent-note').shortcut, '⌘←');
    assert.equal(outline({ hasChildren: false, canIndent: false, canOutdent: false }), null);
});

test('the note menu fails loudly on missing outline state', () => {
    const context = buildNoteContext({});
    delete context.canMoveDown;
    assert.throws(() => buildContextMenuItems(context, buildNoteHandlers([])), /canMoveDown/);
    const handlers = buildNoteHandlers([]);
    delete handlers.onIndentNote;
    assert.throws(() => buildContextMenuItems(buildNoteContext({}), handlers), /onIndentNote/);
});

test('note shortcuts are written the Windows and Linux way off a Mac', () => {
    const items = buildContextMenuItems(buildNoteContext({ isMac: false, hasNoteClipboard: true, hasReferenceClipboard: true }), buildNoteHandlers([]));
    const shortcutOf = (id) => findMenuItem(items, id).shortcut;
    assert.equal(shortcutOf('paste-note-child'), 'Ctrl+Shift+V');
    assert.equal(shortcutOf('add-sibling-note'), 'Ctrl+Enter');
    assert.equal(shortcutOf('move-note-to-top'), 'Ctrl+Shift+↑');
    assert.equal(shortcutOf('move-note-to-bottom'), 'Ctrl+Shift+↓');
    assert.equal(shortcutOf('delete-note'), 'Ctrl+Backspace');
});

test('the note menu offers no made-up tag proposals, even while editing', () => {
    const editingItems = buildContextMenuItems(buildNoteContext({}), buildNoteHandlers([]));
    assert.equal(editingItems.some((item) => item.id === 'make-pseudo-suggestions'), false);
});

test('buildContextMenuItems appends created and updated timestamps to note menus', () => {
    const items = buildContextMenuItems(
        buildNoteContext({
            noteTimestamps: {
                created: 'Aug 17, 2026, 11:00 AM',
                updated: 'Aug 17, 2026, 12:45 PM',
            },
        }),
        buildNoteHandlers([]),
    );

    assert.deepEqual(items.at(-1), {
        id: 'note-timestamps',
        kind: 'info',
        label: 'Note timestamps',
        rows: [
            { label: 'Created', value: 'Aug 17, 2026, 11:00 AM' },
            { label: 'Updated', value: 'Aug 17, 2026, 12:45 PM' },
        ],
    });
});

test('buildContextMenuItems keeps Updated when it equals Created', () => {
    const items = buildContextMenuItems(
        buildNoteContext({
            noteTimestamps: {
                created: 'Aug 17, 2026, 11:00 AM',
                updated: 'Aug 17, 2026, 11:00 AM',
            },
        }),
        buildNoteHandlers([]),
    );

    assert.deepEqual(items.at(-1).rows, [
        { label: 'Created', value: 'Aug 17, 2026, 11:00 AM' },
        { label: 'Updated', value: 'Aug 17, 2026, 11:00 AM' },
    ]);
});

test('note context menu reads the rendered note timestamp dataset', async () => {
    const source = await readFile(CONTEXT_MENU_EVENTS_URL, 'utf8');
    const noteMenuStart = source.indexOf('function showNoteContextMenu(');
    const noteMenuEnd = source.indexOf('function showLinkContextMenu(', noteMenuStart);

    assert.ok(noteMenuStart >= 0);
    assert.ok(noteMenuEnd > noteMenuStart);
    const noteMenuSource = source.slice(noteMenuStart, noteMenuEnd);
    assert.match(noteMenuSource, /noteElement\.dataset\.noteCreatedDisplay/);
    assert.match(noteMenuSource, /noteElement\.dataset\.noteUpdatedDisplay/);
    assert.match(
        noteMenuSource,
        /noteTimestamps:\s*\{\s*created:\s*createdTimestamp,\s*updated:\s*updatedTimestamp,/,
    );
});

test('note context requires complete rendered timestamps', () => {
    assert.throws(
        () => buildContextMenuItems(
            { kind: 'note', noteId: 'note-123' },
            buildNoteHandlers([]),
        ),
        /noteTimestamps/,
    );
    assert.throws(
        () => buildContextMenuItems(
            buildNoteContext({ noteTimestamps: { created: 'Created value' } }),
            buildNoteHandlers([]),
        ),
        /updated timestamp/,
    );
});

test('buildContextMenuItems exposes full screen only for an eligible view-mode note', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({ canViewFullscreen: true }),
        buildNoteHandlers(calls),
    );

    const fullscreenItem = items.find((item) => item.id === 'view-note-fullscreen');
    assert.ok(fullscreenItem);
    assert.equal(fullscreenItem.label, 'View Full Screen');
    assert.equal(isContextMenuIconSupported(fullscreenItem.icon), true);
    fullscreenItem.onSelect();
    assert.deepEqual(calls, [['viewNoteFullscreen', 'note-123']]);

    const editingItems = buildContextMenuItems(
        buildNoteContext({ canViewFullscreen: false }),
        buildNoteHandlers([]),
    );
    assert.equal(editingItems.some((item) => item.id === 'view-note-fullscreen'), false);
});

test('buildContextMenuItems prepends image actions for note image context', () => {
    const calls = [];
    const imageContext = {
        sourceKind: 'inline',
        fileId: null,
        hostNoteId: 'note-123',
        occurrenceIndex: 0,
        src: 'data:image/png;base64,AAAA',
        alt: 'Diagram',
        filename: null,
    };
    const items = buildContextMenuItems(
        buildNoteContext({ imageContext, canResizeImage: true }),
        {
            ...buildNoteHandlers(calls),
            onCopyImage: (context) => calls.push(['copyImage', context]),
            onSaveImage: (context) => calls.push(['saveImage', context]),
            onZoomImage: (context) => calls.push(['zoomImage', context]),
            onOpenImageInNewTab: (context) => calls.push(['openImage', context]),
        },
    );

    assert.deepEqual(menuOutline(items).slice(0, 8), [
        'Make Bigger',
        'Make Smaller',
        'Reset Size',
        '— Copy Image',
        'Save Image',
        'Zoom Image',
        'Open Image in New Tab',
        '— Copy Note ⌘C',
    ]);

    const checkIcons = (entries) => {
        for (const item of entries) {
            if (typeof item.icon === 'string') {
                assert.equal(isContextMenuIconSupported(item.icon), true, `unsupported icon: ${item.icon}`);
            }
            if (item.submenu !== undefined) checkIcons(item.submenu);
        }
    };
    checkIcons(items.filter((item) => item.kind !== 'info'));

    for (const item of items.slice(0, 7)) item.onSelect();
    assert.deepEqual(calls, [
        ['makeImageBigger', imageContext],
        ['makeImageSmaller', imageContext],
        ['resetImageSize', imageContext],
        ['copyImage', imageContext],
        ['saveImage', imageContext],
        ['zoomImage', imageContext],
        ['openImage', imageContext],
    ]);
});

test('buildContextMenuItems hides image sizing actions while editing', () => {
    const calls = [];
    const imageContext = {
        sourceKind: 'inline',
        fileId: null,
        hostNoteId: 'note-123',
        occurrenceIndex: 0,
        src: 'data:image/png;base64,AAAA',
        alt: 'Diagram',
        filename: null,
    };
    const items = buildContextMenuItems(
        buildNoteContext({ imageContext, canResizeImage: false }),
        {
            ...buildNoteHandlers(calls),
            onCopyImage: (context) => calls.push(['copyImage', context]),
            onSaveImage: (context) => calls.push(['saveImage', context]),
            onZoomImage: (context) => calls.push(['zoomImage', context]),
            onOpenImageInNewTab: (context) => calls.push(['openImage', context]),
        },
    );

    assert.equal(items.some((item) => item.id === 'make-image-bigger'), false);
    assert.equal(items.some((item) => item.id === 'make-image-smaller'), false);
    assert.equal(items.some((item) => item.id === 'reset-image-size'), false);
    assert.deepEqual(items.slice(0, 4).map((item) => item.id), [
        'copy-image',
        'save-image',
        'zoom-image',
        'open-image-new-tab',
    ]);
    assert.equal(items[0].separated, undefined);
});

test('buildContextMenuItems shows text copy when selected text is present', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({ hasSelectedText: true }),
        buildNoteHandlers(calls),
    );

    assert.equal(items[0].id, 'copy-selection');
    assert.equal(items[0].label, 'Copy');
    items[0].onSelect();
    assert.deepEqual(calls, [['copySelection', 'note-123']]);
});

test('buildContextMenuItems shows add-as-tag for an eligible text selection', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({
            hasSelectedText: true,
            selectedTextForTag: 'Neural Networks',
        }),
        buildNoteHandlers(calls),
    );

    assert.deepEqual(
        items.slice(0, 2).map((item) => ({ id: item.id, label: item.label })),
        [
            { id: 'copy-selection', label: 'Copy' },
            { id: 'add-selection-as-tag', label: 'Add as Tag' },
        ],
    );
    items[1].onSelect();
    assert.deepEqual(calls, [['addSelectionAsTag', 'note-123', 'Neural Networks']]);
});

test('while editing, Add Style, Remove Formatting and Add Excalidraw Diagram follow Export', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({
            canAddStyle: true,
            canRemoveFormatting: true,
            canAddDiagram: true,
            styleOptions: [
                { id: 'red', label: 'Red', tag: '@red' },
                { id: 'markdown', label: 'Markdown', tag: '@markdown' },
            ],
        }),
        { ...buildNoteHandlers(calls), onAddDiagram: (noteId) => calls.push(['addDiagram', noteId]) },
    );
    const ids = items.map((item) => item.id);
    // Print follows Export; the editing items follow Print.
    assert.equal(ids.indexOf('print'), ids.indexOf('export') + 1);
    const exportIndex = ids.indexOf('print');
    assert.deepEqual(ids.slice(exportIndex, exportIndex + 5), ['print', 'add-style', 'remove-formatting', 'add-excalidraw-diagram', 'delete-note']);
    const addStyle = items[exportIndex + 1];
    assert.equal(addStyle.separated, true);
    assert.equal(addStyle.onSelect, undefined);
    assert.deepEqual(addStyle.submenu.map((item) => [item.id, item.label]), [['add-style-red', 'Red'], ['add-style-markdown', 'Markdown']]);
    assert.equal(items[exportIndex + 2].shortcut, '⌘U');
    addStyle.submenu[0].onSelect();
    items[exportIndex + 2].onSelect();
    items[exportIndex + 3].onSelect();
    assert.deepEqual(calls, [['addStyle', 'note-123', '@red'], ['removeFormatting', 'note-123'], ['addDiagram', 'note-123']]);

    const viewItems = buildContextMenuItems(buildNoteContext(), buildNoteHandlers([]));
    assert.equal(viewItems.some((item) => item.id === 'add-style'), false);
});

test('Paste groups the sibling and child pastes once a note is copied', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({ hasNoteClipboard: true, hasReferenceClipboard: true }),
        buildNoteHandlers(calls),
    );
    assert.deepEqual(menuOutline(items).slice(0, 2), [
        'Copy Note ⌘C',
        ['Paste', ['Paste Sibling Note ⌘V', 'Paste Child Note ⇧⌘V', 'Paste Sibling Reference ⌘R', 'Paste Child Reference ⇧⌘R']],
    ]);
    for (const item of items[1].submenu) item.onSelect();
    assert.deepEqual(calls, [
        ['pasteNote', 'note-123'],
        ['pasteNoteChild', 'note-123'],
        ['pasteReference', 'note-123'],
        ['pasteReferenceChild', 'note-123'],
    ]);
    const nothingCopied = buildContextMenuItems(buildNoteContext({}), buildNoteHandlers([]));
    assert.equal(findMenuItem(nothingCopied, 'paste'), null);
    assert.equal(findMenuItem(nothingCopied, 'paste-note'), null);
});

test('synthetic note clipboard hides reference paste actions', () => {
    const items = buildContextMenuItems(
        buildNoteContext({ hasNoteClipboard: true, hasReferenceClipboard: false }),
        buildNoteHandlers([]),
    );
    assert.deepEqual(findMenuItem(items, 'paste').submenu.map((item) => item.id), ['paste-note', 'paste-note-child']);
    assert.equal(findMenuItem(items, 'paste-reference'), null);
});

test('buildContextMenuItems adds a top note action to non-editing note context', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({ canAddNoteAtTop: true }),
        buildNoteHandlers(calls),
    );
    const add = items.find((item) => item.id === 'add');
    assert.deepEqual(add.submenu.map((item) => item.id), ['add-sibling-note', 'add-child-note', 'add-note-at-top']);
    const addNoteAtTop = add.submenu[2];
    assert.equal(addNoteAtTop.label, 'Add Note at Top');
    assert.equal(addNoteAtTop.icon, 'add_top');
    assert.equal(addNoteAtTop.shortcut, '↩');
    addNoteAtTop.onSelect();
    assert.deepEqual(calls, [['addNoteAtTop']]);
});

function buildViewContext(overrides) {
    return {
        kind: 'view', isMac: true, isEditing: false, canPasteNoteAtTop: false, canGoToTop: false, canGoToBottom: false,
        isUntaggedView: false, theme: 'system', sortMode: 'normal',
        areTabsVisible: false, isAiChatVisible: false, areNoteTagsVisible: false,
        ...overrides,
    };
}

const VIEW_HANDLER_NAMES = [
    'onAddNoteAtTop', 'onPasteNoteAtTop', 'onUndo', 'onRedo', 'onGoToTop', 'onGoToBottom', 'onFullyExpandAll',
    'onFullyCollapseAll', 'onSetUntaggedView', 'onSetSortMode', 'onToggleAiChat', 'onToggleTabs',
    'onToggleNoteTags', 'onSetTheme', 'onNewTab', 'onOpenNamespace', 'onOpenReminders',
    'onExportViewHtml', 'onPrintView', 'onLogOut',
];

function buildViewHandlers(calls) {
    return Object.fromEntries(VIEW_HANDLER_NAMES.map((name) => [name, (...args) => calls.push([name, ...args])]));
}

function describeMenu(items) {
    return items.map((item) => [item.separated === true ? '— ' : '', item.label, item.shortcut === undefined ? '' : ` ${item.shortcut}`].join(''));
}

test('the background menu groups adding, history, the list, the view, opening, export and log out', () => {
    const items = buildContextMenuItems(buildViewContext({ canPasteNoteAtTop: true, canGoToTop: true, canGoToBottom: true }), buildViewHandlers([]));
    assert.deepEqual(describeMenu(items), [
        'Add Note at Top ↩',
        'Paste Note at Top ⌘V',
        '— Undo ⌘Z',
        'Redo ⇧⌘Z',
        '— Go to Top',
        'Go to Bottom',
        'Fully Expand All',
        'Fully Collapse All',
        '— View',
        'Sort by',
        'Show',
        'Theme',
        '— New Tab',
        'Open/Switch Namespace…',
        'Reminders…',
        '— Export View as HTML',
        'Print View',
        '— Log Out',
    ]);
});

test('background items that do not apply are hidden, not greyed', () => {
    const atTop = buildContextMenuItems(buildViewContext({}), buildViewHandlers([]));
    const ids = atTop.map((item) => item.id);
    assert.ok(!ids.includes('paste-note-at-top'));
    assert.ok(!ids.includes('go-to-top'));
    assert.ok(!ids.includes('go-to-bottom'));
    assert.equal(atTop.find((item) => item.id === 'fully-expand-all').separated, true);
    assert.ok(atTop.every((item) => item.enabled));

    // While a note is edited, Enter, ⌘V and ⌘Z belong to the editor.
    const editing = buildContextMenuItems(buildViewContext({ isEditing: true, canPasteNoteAtTop: true }), buildViewHandlers([]));
    const editingIds = editing.map((item) => item.id);
    for (const id of ['add-note-at-top', 'paste-note-at-top', 'undo', 'redo']) {
        assert.ok(!editingIds.includes(id), id);
    }
    assert.equal(editing[0].id, 'fully-expand-all');
});

test('at the bottom only Go to Top is offered, and at the top only Go to Bottom', () => {
    const ids = (overrides) => buildContextMenuItems(buildViewContext(overrides), buildViewHandlers([])).map((item) => item.id);
    assert.deepEqual(ids({ canGoToTop: true }).filter((id) => id.startsWith('go-to-')), ['go-to-top']);
    assert.deepEqual(ids({ canGoToBottom: true }).filter((id) => id.startsWith('go-to-')), ['go-to-bottom']);
    const atTop = buildContextMenuItems(buildViewContext({ canGoToBottom: true }), buildViewHandlers([]));
    assert.equal(atTop.find((item) => item.id === 'go-to-bottom').separated, true);
});

test('background shortcuts are written the Windows and Linux way off a Mac', () => {
    const items = buildContextMenuItems(buildViewContext({ isMac: false, canPasteNoteAtTop: true }), buildViewHandlers([]));
    const shortcuts = Object.fromEntries(items.filter((item) => item.shortcut !== undefined).map((item) => [item.id, item.shortcut]));
    assert.deepEqual(shortcuts, {
        'add-note-at-top': 'Enter',
        'paste-note-at-top': 'Ctrl+V',
        undo: 'Ctrl+Z',
        redo: 'Ctrl+Shift+Z',
    });
});

test('formatMenuShortcut writes modifiers in platform order', () => {
    assert.equal(formatMenuShortcut({ isMac: true, mod: true, shift: true, key: 'Z' }), '⇧⌘Z');
    assert.equal(formatMenuShortcut({ isMac: true, mod: false, shift: false, key: 'Enter' }), '↩');
    assert.equal(formatMenuShortcut({ isMac: false, mod: true, shift: true, key: 'Z' }), 'Ctrl+Shift+Z');
    assert.throws(() => formatMenuShortcut({ isMac: true, mod: true, shift: false, key: '' }));
});

test('background actions call their handlers', () => {
    const calls = [];
    const items = buildContextMenuItems(buildViewContext({ canPasteNoteAtTop: true, canGoToTop: true, canGoToBottom: true }), buildViewHandlers(calls));
    for (const item of items.filter((item) => item.submenu === undefined)) {
        item.onSelect();
    }
    assert.deepEqual(calls.map((call) => call[0]), [
        'onAddNoteAtTop', 'onPasteNoteAtTop', 'onUndo', 'onRedo', 'onGoToTop', 'onGoToBottom', 'onFullyExpandAll',
        'onFullyCollapseAll', 'onNewTab', 'onOpenNamespace', 'onOpenReminders', 'onExportViewHtml', 'onPrintView', 'onLogOut',
    ]);
});

test('View, Show and Theme tick the current state', () => {
    const calls = [];
    const items = buildContextMenuItems(buildViewContext({
        isUntaggedView: true, theme: 'dark', isAiChatVisible: true, areTabsVisible: false, areNoteTagsVisible: true,
    }), buildViewHandlers(calls));
    const submenu = (id) => items.find((item) => item.id === id).submenu;
    const ticks = (id) => submenu(id).map((item) => [item.label, item.checked, item.enabled]);

    assert.deepEqual(ticks('view'), [['All notes', false, true], ['Untagged notes', true, false]]);
    assert.deepEqual(ticks('show'), [['Chat', true, true], ['Tabs', false, true], ['Tags in List', true, true]]);
    assert.deepEqual(ticks('theme'), [['System', false, true], ['Light', false, true], ['Dark', true, false]]);

    submenu('view')[0].onSelect();
    for (const item of submenu('show')) item.onSelect();
    submenu('theme')[1].onSelect();
    assert.deepEqual(calls, [
        ['onSetUntaggedView', false],
        ['onToggleAiChat', false],
        ['onToggleTabs', true],
        ['onToggleNoteTags', false],
        ['onSetTheme', 'light'],
    ]);
});

test('the background menu fails loudly on missing state', () => {
    const context = buildViewContext({});
    delete context.isEditing;
    assert.throws(() => buildContextMenuItems(context, buildViewHandlers([])), /isEditing/);
    assert.throws(() => buildContextMenuItems(buildViewContext({ theme: 'sepia' }), buildViewHandlers([])), /theme/);
});

test('view context menu no longer exposes the note timestamp visibility preference', async () => {
    const source = await readFile(CONTEXT_MENU_EVENTS_URL, 'utf8');
    const viewMenuStart = source.indexOf('function showViewContextMenu(event)');
    const viewMenuEnd = source.indexOf('function handleContextMenu(event)', viewMenuStart);

    assert.ok(viewMenuStart >= 0);
    assert.ok(viewMenuEnd > viewMenuStart);
    const viewMenuSource = source.slice(viewMenuStart, viewMenuEnd);
    assert.doesNotMatch(
        viewMenuSource,
        /areNoteTimestampsVisible|pref-show-note-timestamps/,
    );
    assert.doesNotMatch(
        viewMenuSource,
        /onToggleNoteTimestamps|pref\.show_note_timestamps/,
    );
});

test('background sorting offers all modes and ticks only the current mode', () => {
    const modes = ['normal', 'created', 'updated', 'alphabetical', 'content-volume'];
    for (const currentMode of modes) {
        const calls = [];
        const items = buildContextMenuItems(buildViewContext({ sortMode: currentMode }), buildViewHandlers(calls));
        const submenu = items.find((item) => item.id === 'sort-by').submenu;
        assert.deepEqual(submenu.map((item) => item.id), modes.map((mode) => `sort-by-${mode}`));
        assert.deepEqual(submenu.filter((item) => item.checked).map((item) => item.id), [`sort-by-${currentMode}`]);
        assert.deepEqual(submenu.filter((item) => !item.enabled).map((item) => item.id), [`sort-by-${currentMode}`]);
        assert.ok(submenu.every((item) => !item.label.includes('(current)')));
        for (const item of submenu.filter((item) => item.enabled)) item.onSelect();
        assert.deepEqual(calls.map((call) => call[1]), modes.filter((mode) => mode !== currentMode));
    }
});

test('buildContextMenuItems returns only link actions for link context', () => {
    const calls = [];
    const linkContext = { href: 'https://example.com/docs' };
    const items = buildContextMenuItems(
        { kind: 'link', linkContext },
        {
            onCopyLink: (context) => calls.push(['copyLink', context]),
            onOpenLinkInNewTab: (context) => calls.push(['openLink', context]),
        },
    );

    assert.deepEqual(
        items.map((item) => ({ id: item.id, label: item.label, enabled: item.enabled })),
        [
            { id: 'copy-link', label: 'Copy Link', enabled: true },
            { id: 'open-link-new-tab', label: 'Open Link in New Tab', enabled: true },
        ],
    );

    items[0].onSelect();
    items[1].onSelect();
    assert.deepEqual(calls, [
        ['copyLink', linkContext],
        ['openLink', linkContext],
    ]);
});

test('buildContextMenuItems includes source action for a link inside a reference', () => {
    const calls = [];
    const linkContext = { href: 'https://example.com/docs' };
    const items = buildContextMenuItems(
        {
            kind: 'link',
            linkContext,
            referenceNoteId: 'source-note-456',
        },
        {
            onOpenReferenceSource: (referenceNoteId) => calls.push(['source', referenceNoteId]),
            onCopyLink: (context) => calls.push(['copyLink', context]),
            onOpenLinkInNewTab: (context) => calls.push(['openLink', context]),
        },
    );

    assert.deepEqual(items.map((item) => item.id), [
        'open-reference-source',
        'copy-link',
        'open-link-new-tab',
    ]);
    assert.equal(items[1].separated, true);
    items[0].onSelect();
    assert.deepEqual(calls, [['source', 'source-note-456']]);
});

test('buildContextMenuItems preserves tag menu behavior', () => {
    const calls = [];
    const items = buildContextMenuItems(
        { kind: 'tag', tag: 'project-alpha', source: 'tag-bar', explanation: { heading: 'About this tag', lines: [] } },
        {
            onEditTagRelationships: (tag) => calls.push(tag),
        },
    );

    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Edit Tag Relationships');

    items[0].onSelect();
    assert.deepEqual(calls, ['project-alpha']);
});

test('a tag menu says why a suggestion is suggested, or about an entered tag, below its actions', () => {
    for (const heading of ['Why suggested', 'About this tag']) {
        const calls = [];
        const lines = ['Named in this note: "project alpha"', "You've tagged 12 notes with it"];
        const items = buildContextMenuItems(
            { kind: 'tag', tag: 'project-alpha', source: 'tag-bar', explanation: { heading, lines } },
            { onEditTagRelationships: (tag) => calls.push(tag) },
        );

        // The action first, at a fixed place under the pointer; the explanation's length varies.
        assert.equal(items[0].label, 'Edit Tag Relationships');
        assert.deepEqual(items[1], { kind: 'explanation', id: 'tag-explanation', label: heading, lines });
        items[0].onSelect();
        assert.deepEqual(calls, ['project-alpha']);
    }
});

test('buildContextMenuItems gives a rendered diagram edit, size, zoom, and save actions', () => {
    const calls = [];
    const diagramContext = {
        sourceKind: 'file',
        fileId: 'file-1',
        fileKind: 'excalidraw',
        hostNoteId: 'note-123',
        occurrenceIndex: 0,
        src: 'blob:light-preview',
        alt: 'Diagram',
        filename: 'Diagram.excalidraw',
    };
    const handlers = {
        ...buildNoteHandlers(calls),
        onEditDiagram: (context) => calls.push(['editDiagram', context]),
        onSaveDiagram: (context) => calls.push(['saveDiagram', context]),
        onZoomImage: (context) => calls.push(['zoomImage', context]),
    };
    const items = buildContextMenuItems(
        buildNoteContext({ imageContext: diagramContext, canResizeImage: true, canEditDiagram: true }),
        handlers,
    );

    assert.deepEqual(items.slice(0, 6).map((item) => ({ id: item.id, label: item.label, enabled: item.enabled })), [
        { id: 'edit-diagram', label: 'Edit Diagram', enabled: true },
        { id: 'make-image-bigger', label: 'Make Bigger', enabled: true },
        { id: 'make-image-smaller', label: 'Make Smaller', enabled: true },
        { id: 'reset-image-size', label: 'Reset Size', enabled: true },
        { id: 'zoom-diagram', label: 'Zoom Diagram', enabled: true },
        { id: 'save-diagram', label: 'Save Diagram File', enabled: true },
    ]);
    assert.equal(items.some((item) => item.id === 'copy-image' || item.id === 'open-image-new-tab'), false);
    assert.equal(items[4].separated, true);
    for (const item of items.slice(0, 6)) {
        assert.equal(isContextMenuIconSupported(item.icon), true, `unsupported icon: ${item.icon}`);
    }
    for (const item of items.slice(0, 6)) {
        item.onSelect();
    }
    assert.deepEqual(calls.map(([name]) => name), [
        'editDiagram', 'makeImageBigger', 'makeImageSmaller', 'resetImageSize', 'zoomImage', 'saveDiagram',
    ]);
    assert.ok(calls.every(([, context]) => context === diagramContext));

    const whileEditing = buildContextMenuItems(
        buildNoteContext({ imageContext: diagramContext, canResizeImage: false, canEditDiagram: false }),
        handlers,
    );
    assert.deepEqual(whileEditing.slice(0, 3).map((item) => ({ id: item.id, enabled: item.enabled })), [
        { id: 'edit-diagram', enabled: false },
        { id: 'zoom-diagram', enabled: true },
        { id: 'save-diagram', enabled: true },
    ]);
    assert.equal(whileEditing[1].separated, false);
});

test('buildContextMenuItems offers Add Excalidraw Diagram only to the editing note', () => {
    const calls = [];
    const handlers = { ...buildNoteHandlers(calls), onAddDiagram: (noteId) => calls.push(['addDiagram', noteId]) };
    const items = buildContextMenuItems(buildNoteContext({ canAddDiagram: true }), handlers);
    const addDiagram = items.find((item) => item.id === 'add-excalidraw-diagram');
    assert.ok(addDiagram);
    assert.equal(addDiagram.label, 'Add Excalidraw Diagram');
    assert.equal(isContextMenuIconSupported(addDiagram.icon), true);
    addDiagram.onSelect();
    assert.deepEqual(calls, [['addDiagram', 'note-123']]);

    const viewItems = buildContextMenuItems(buildNoteContext(), buildNoteHandlers([]));
    assert.equal(viewItems.some((item) => item.id === 'add-excalidraw-diagram'), false);
    assert.throws(
        () => buildContextMenuItems(buildNoteContext({ canAddDiagram: true }), buildNoteHandlers([])),
        /onAddDiagram/,
    );
});

test('the right-click menu closes once the pointer is 28px outside it and any open submenu', async () => {
    const { isPointerNearMenu } = await import('../../app/static/js/modules/context-menu/context-menu-service.js');
    const menu = { left: 100, right: 300, top: 100, bottom: 400 };
    const submenu = { left: 300, right: 480, top: 250, bottom: 350 };
    assert.equal(isPointerNearMenu([menu], 200, 200), true);
    // Small movements just past the edge keep it open.
    assert.equal(isPointerNearMenu([menu], 328, 200), true);
    assert.equal(isPointerNearMenu([menu], 72, 428), true);
    assert.equal(isPointerNearMenu([menu], 329, 200), false);
    assert.equal(isPointerNearMenu([menu], 200, 429), false);
    // Over an open submenu (beyond the main menu's buffer) it stays open.
    assert.equal(isPointerNearMenu([menu, submenu], 470, 300), true);
    assert.equal(isPointerNearMenu([menu, submenu], 509, 300), false);
    assert.throws(() => isPointerNearMenu([], 0, 0));
});

test('Suggest Tags with AI follows Add Excalidraw Diagram, with the robot icon, only when the AI may be used', () => {
    const calls = [];
    const handlers = {
        ...buildNoteHandlers(calls),
        onAddDiagram: (noteId) => calls.push(['addDiagram', noteId]),
        onSuggestTagsWithAi: (noteId, includeChildren) => calls.push(['suggestTagsWithAi', noteId, includeChildren]),
    };
    // With children: a submenu, this note alone or with its children.
    const items = buildContextMenuItems(buildNoteContext({ canAddDiagram: true, canSuggestTagsWithAi: true, hasChildren: true }), handlers);
    const ids = items.map((item) => item.id);
    assert.equal(ids.indexOf('suggest-tags-with-ai'), ids.indexOf('add-excalidraw-diagram') + 1);
    const suggest = items.find((item) => item.id === 'suggest-tags-with-ai');
    assert.equal(suggest.label, 'Suggest Tags with AI');
    assert.equal(suggest.icon, 'robot');
    assert.equal(isContextMenuIconSupported('robot'), true);
    assert.deepEqual(suggest.submenu.map((entry) => entry.label), ['This Note', 'This Note and Its Children']);
    suggest.submenu[0].onSelect();
    suggest.submenu[1].onSelect();
    assert.deepEqual(calls, [['suggestTagsWithAi', 'note-123', false], ['suggestTagsWithAi', 'note-123', true]]);

    // Without children: the item itself.
    const alone = buildContextMenuItems(buildNoteContext({ canSuggestTagsWithAi: true, hasChildren: false }), handlers)
        .find((item) => item.id === 'suggest-tags-with-ai');
    assert.equal(alone.submenu, undefined);
    alone.onSelect();
    assert.deepEqual(calls.at(-1), ['suggestTagsWithAi', 'note-123', false]);

    // The tag bar's menu offers the same.
    const tagBar = buildContextMenuItems({ kind: 'tag-bar', noteId: 'note-123', hasChildren: true }, handlers);
    assert.deepEqual(tagBar.map((item) => item.submenu.map((entry) => entry.id)), [['suggest-tags-this-note', 'suggest-tags-with-children']]);

    for (const canSuggestTagsWithAi of [false, undefined]) {
        const without = buildContextMenuItems(buildNoteContext({ canAddDiagram: true, canSuggestTagsWithAi }), handlers);
        assert.equal(without.some((item) => item.id === 'suggest-tags-with-ai'), false);
    }
});
