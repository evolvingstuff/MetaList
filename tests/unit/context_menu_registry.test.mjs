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
        onMakePseudoSuggestions: (noteId) => calls.push(['makePseudoSuggestions', noteId]),
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
        onViewNoteFullscreen: (noteId) => calls.push(['viewNoteFullscreen', noteId]),
        onFullyExpandNote: (noteId) => calls.push(['fullyExpandNote', noteId]),
        onFullyCollapseNote: (noteId) => calls.push(['fullyCollapseNote', noteId]),
        onAddNoteAtTop: () => calls.push(['addNoteAtTop']),
        onAddSiblingNote: (noteId) => calls.push(['addSibling', noteId]),
        onAddChildNote: (noteId) => calls.push(['addChild', noteId]),
        onDeleteNote: (noteId) => calls.push(['delete', noteId]),
        onMoveNoteToTop: (noteId) => calls.push(['moveToTop', noteId]),
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

test('buildContextMenuItems returns note actions for note context', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext(),
        buildNoteHandlers(calls),
    );
    const actionItems = items.filter((item) => item.kind !== 'info');

    assert.deepEqual(
        actionItems.map((item) => ({ id: item.id, label: item.label, enabled: item.enabled })),
        [
            { id: 'copy-note', label: 'Copy Note', enabled: true },
            { id: 'add-sibling-note', label: 'Add Sibling Note', enabled: true },
            { id: 'add-child-note', label: 'Add Child Note', enabled: true },
            { id: 'delete-note', label: 'Delete Note', enabled: true },
            { id: 'move-note-to-top', label: 'Move Note to Top', enabled: true },
            { id: 'fully-expand-note', label: 'Fully Expand Note', enabled: true },
            { id: 'fully-collapse-note', label: 'Fully Collapse Note', enabled: true },
            { id: 'export-note-html', label: 'Export Note as HTML', enabled: true },
            { id: 'export-view-html', label: 'Export View as HTML', enabled: true },
        ],
    );
    assert.equal(items[0].separated, undefined);
    assert.equal(items[5].separated, true);

    for (const item of actionItems) {
        item.onSelect();
    }

    assert.deepEqual(calls, [
        ['copyNote', 'note-123'],
        ['addSibling', 'note-123'],
        ['addChild', 'note-123'],
        ['delete', 'note-123'],
        ['moveToTop', 'note-123'],
        ['fullyExpandNote', 'note-123'],
        ['fullyCollapseNote', 'note-123'],
        ['exportNoteHtml', 'note-123'],
        ['exportViewHtml'],
    ]);
});

test('buildContextMenuItems exposes pseudo suggestions only for the active editing note', () => {
    const calls = [];
    const editingItems = buildContextMenuItems(
        buildNoteContext({ canMakePseudoSuggestions: true }),
        buildNoteHandlers(calls),
    );
    const pseudoItem = editingItems.find((item) => item.id === 'make-pseudo-suggestions');
    assert.ok(pseudoItem);
    assert.equal(pseudoItem.label, 'Make pseudo-suggestions');
    pseudoItem.onSelect();
    assert.deepEqual(calls, [['makePseudoSuggestions', 'note-123']]);

    const viewItems = buildContextMenuItems(
        buildNoteContext({ canMakePseudoSuggestions: false }),
        buildNoteHandlers([]),
    );
    assert.equal(viewItems.some((item) => item.id === 'make-pseudo-suggestions'), false);
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

    const actionItems = items.filter((item) => item.kind !== 'info');
    assert.deepEqual(
        actionItems.map((item) => ({ id: item.id, label: item.label, enabled: item.enabled })),
        [
            { id: 'make-image-bigger', label: 'Make Bigger', enabled: true },
            { id: 'make-image-smaller', label: 'Make Smaller', enabled: true },
            { id: 'reset-image-size', label: 'Reset Size', enabled: true },
            { id: 'copy-image', label: 'Copy Image', enabled: true },
            { id: 'save-image', label: 'Save Image', enabled: true },
            { id: 'zoom-image', label: 'Zoom Image', enabled: true },
            { id: 'open-image-new-tab', label: 'Open Image in New Tab', enabled: true },
            { id: 'copy-note', label: 'Copy Note', enabled: true },
            { id: 'add-sibling-note', label: 'Add Sibling Note', enabled: true },
            { id: 'add-child-note', label: 'Add Child Note', enabled: true },
            { id: 'delete-note', label: 'Delete Note', enabled: true },
            { id: 'move-note-to-top', label: 'Move Note to Top', enabled: true },
            { id: 'fully-expand-note', label: 'Fully Expand Note', enabled: true },
            { id: 'fully-collapse-note', label: 'Fully Collapse Note', enabled: true },
            { id: 'export-note-html', label: 'Export Note as HTML', enabled: true },
            { id: 'export-view-html', label: 'Export View as HTML', enabled: true },
        ],
    );
    assert.equal(items[3].separated, true);
    assert.equal(items[7].separated, true);
    assert.equal(items[8].separated, undefined);
    assert.equal(items[12].separated, true);

    for (const item of actionItems) {
        if (typeof item.icon === 'string') {
            assert.equal(isContextMenuIconSupported(item.icon), true, `unsupported icon: ${item.icon}`);
        }
    }

    items[0].onSelect();
    items[1].onSelect();
    items[2].onSelect();
    items[3].onSelect();
    items[4].onSelect();
    items[5].onSelect();
    items[6].onSelect();

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

test('buildContextMenuItems adds a connected Add Style submenu only for the editing note', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({
            canAddStyle: true,
            styleOptions: [
                { id: 'red', label: 'Red', tag: '@red' },
                { id: 'markdown', label: 'Markdown', tag: '@markdown' },
            ],
        }),
        buildNoteHandlers(calls),
    );

    const addStyle = items.find((item) => item.id === 'add-style');
    assert.ok(addStyle);
    assert.equal(items[0].id, 'add-style');
    assert.equal(addStyle.onSelect, undefined);
    assert.deepEqual(
        addStyle.submenu.map((item) => ({ id: item.id, label: item.label })),
        [
            { id: 'add-style-red', label: 'Red' },
            { id: 'add-style-markdown', label: 'Markdown' },
        ],
    );
    addStyle.submenu[0].onSelect();
    assert.deepEqual(calls, [['addStyle', 'note-123', '@red']]);

    const viewItems = buildContextMenuItems(
        buildNoteContext(),
        buildNoteHandlers([]),
    );
    assert.equal(viewItems.some((item) => item.id === 'add-style'), false);
});

test('buildContextMenuItems places Remove Formatting directly beneath Add Style while editing', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({
            canAddStyle: true,
            canRemoveFormatting: true,
            styleOptions: [
                { id: 'red', label: 'Red', tag: '@red' },
            ],
        }),
        buildNoteHandlers(calls),
    );

    assert.deepEqual(items.slice(0, 2).map((item) => item.id), [
        'add-style',
        'remove-formatting',
    ]);
    items[1].onSelect();
    assert.deepEqual(calls, [['removeFormatting', 'note-123']]);
});

test('buildContextMenuItems shows paste actions when note clipboard is available', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({
            hasNoteClipboard: true,
            hasReferenceClipboard: true,
        }),
        buildNoteHandlers(calls),
    );

    assert.deepEqual(
        items.slice(0, 5).map((item) => ({ id: item.id, label: item.label })),
        [
            { id: 'copy-note', label: 'Copy Note' },
            { id: 'paste-note', label: 'Paste Sibling Note' },
            { id: 'paste-note-child', label: 'Paste Child Note' },
            { id: 'paste-reference', label: 'Paste Sibling Reference' },
            { id: 'paste-reference-child', label: 'Paste Child Reference' },
        ],
    );
    assert.deepEqual(
        items.filter((item) => item.kind !== 'info').slice(-2).map((item) => ({ id: item.id, label: item.label })),
        [
            { id: 'export-note-html', label: 'Export Note as HTML' },
            { id: 'export-view-html', label: 'Export View as HTML' },
        ],
    );

    items[1].onSelect();
    items[2].onSelect();
    items[3].onSelect();
    items[4].onSelect();
    assert.deepEqual(calls, [
        ['pasteNote', 'note-123'],
        ['pasteNoteChild', 'note-123'],
        ['pasteReference', 'note-123'],
        ['pasteReferenceChild', 'note-123'],
    ]);
});

test('synthetic note clipboard hides reference paste actions', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({
            hasNoteClipboard: true,
            hasReferenceClipboard: false,
        }),
        buildNoteHandlers(calls),
    );
    const actionIds = items.filter((item) => item.kind !== 'info').map((item) => item.id);

    assert.equal(actionIds.includes('paste-note'), true);
    assert.equal(actionIds.includes('paste-note-child'), true);
    assert.equal(actionIds.includes('paste-reference'), false);
    assert.equal(actionIds.includes('paste-reference-child'), false);
});

test('buildContextMenuItems adds a top note action to non-editing note context', () => {
    const calls = [];
    const items = buildContextMenuItems(
        buildNoteContext({ canAddNoteAtTop: true }),
        buildNoteHandlers(calls),
    );

    const addNoteAtTop = items.find((item) => item.id === 'add-note-at-top');
    assert.ok(addNoteAtTop);
    assert.equal(addNoteAtTop.label, 'Add Note at Top');
    assert.equal(addNoteAtTop.icon, 'add_top');
    addNoteAtTop.onSelect();
    assert.deepEqual(calls, [['addNoteAtTop']]);
});

function buildViewContext(overrides) {
    return {
        kind: 'view', isMac: true, isEditing: false, canPasteNoteAtTop: false, canGoToTop: false,
        isUntaggedView: false, theme: 'system', sortMode: 'normal',
        areTabsVisible: false, isAiChatVisible: false, areNoteTagsVisible: false,
        ...overrides,
    };
}

const VIEW_HANDLER_NAMES = [
    'onAddNoteAtTop', 'onPasteNoteAtTop', 'onUndo', 'onRedo', 'onGoToTop', 'onFullyExpandAll',
    'onFullyCollapseAll', 'onSetUntaggedView', 'onSetSortMode', 'onToggleAiChat', 'onToggleTabs',
    'onToggleNoteTags', 'onSetTheme', 'onNewTab', 'onOpenNamespace', 'onOpenReminders',
    'onExportViewHtml', 'onLogOut',
];

function buildViewHandlers(calls) {
    return Object.fromEntries(VIEW_HANDLER_NAMES.map((name) => [name, (...args) => calls.push([name, ...args])]));
}

function describeMenu(items) {
    return items.map((item) => [item.separated === true ? '— ' : '', item.label, item.shortcut === undefined ? '' : ` ${item.shortcut}`].join(''));
}

test('the background menu groups adding, history, the list, the view, opening, export and log out', () => {
    const items = buildContextMenuItems(buildViewContext({ canPasteNoteAtTop: true, canGoToTop: true }), buildViewHandlers([]));
    assert.deepEqual(describeMenu(items), [
        'Add Note at Top ↩',
        'Paste Note at Top ⌘V',
        '— Undo ⌘Z',
        'Redo ⇧⌘Z',
        '— Go to Top',
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
        '— Log Out',
    ]);
});

test('background items that do not apply are hidden, not greyed', () => {
    const atTop = buildContextMenuItems(buildViewContext({}), buildViewHandlers([]));
    const ids = atTop.map((item) => item.id);
    assert.ok(!ids.includes('paste-note-at-top'));
    assert.ok(!ids.includes('go-to-top'));
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
    const items = buildContextMenuItems(buildViewContext({ canPasteNoteAtTop: true, canGoToTop: true }), buildViewHandlers(calls));
    for (const item of items.filter((item) => item.submenu === undefined)) {
        item.onSelect();
    }
    assert.deepEqual(calls.map((call) => call[0]), [
        'onAddNoteAtTop', 'onPasteNoteAtTop', 'onUndo', 'onRedo', 'onGoToTop', 'onFullyExpandAll',
        'onFullyCollapseAll', 'onNewTab', 'onOpenNamespace', 'onOpenReminders', 'onExportViewHtml', 'onLogOut',
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
        { kind: 'tag', tag: 'project-alpha', source: 'tag-bar' },
        {
            onEditTagRelationships: (tag) => calls.push(tag),
        },
    );

    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Edit Tag Relationships');

    items[0].onSelect();
    assert.deepEqual(calls, ['project-alpha']);
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
