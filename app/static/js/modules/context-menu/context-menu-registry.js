import { normalizeRootSortMode, ROOT_SORT_MODES } from '../mode-manager/services/root-sort-service.js';

function buildTagContextItems(context, handlers) {
    if (!context || typeof context !== 'object') {
        throw new Error('buildTagContextItems requires context object');
    }
    if (!handlers || typeof handlers !== 'object') {
        throw new Error('buildTagContextItems requires handlers object');
    }

    const tag = context.tag;
    if (typeof tag !== 'string' || tag.trim() === '') {
        throw new Error('Tag context missing tag');
    }
    const onEditTagRelationships = handlers.onEditTagRelationships;
    if (typeof onEditTagRelationships !== 'function') {
        throw new Error('Tag context missing onEditTagRelationships handler');
    }
    const explanation = context.explanation;
    if (!explanation || typeof explanation.heading !== 'string' || !Array.isArray(explanation.lines)) {
        throw new Error('Tag context missing explanation { heading, lines }');
    }

    const editTagRelationships = {
        id: 'edit-tag-relationships',
        label: 'Edit Tag Relationships',
        icon: 'link',
        enabled: true,
        onSelect: () => onEditTagRelationships(tag),
    };
    // A suggestion says why it is suggested, an entered tag what MetaList knows about it, below its
    // actions: the explanation's length varies, so the actions stay at a fixed place under the pointer.
    if (explanation.lines.length === 0) {
        return [editTagRelationships];
    }
    return [
        editTagRelationships,
        { kind: 'explanation', id: 'tag-explanation', label: explanation.heading, lines: explanation.lines },
    ];
}

// Right-clicking a rendered Excalidraw diagram: edit it, resize it, zoom it, or save the .excalidraw file.
function buildDiagramItems(context, imageContext, handlers) {
    for (const [name, handler] of Object.entries(handlers)) {
        if (typeof handler !== 'function') {
            throw new Error(`Diagram context missing ${name} handler`);
        }
    }
    const items = [{
        id: 'edit-diagram',
        label: 'Edit Diagram',
        icon: 'diagram',
        enabled: context.canEditDiagram === true,
        onSelect: () => handlers.onEditDiagram(imageContext),
    }];
    items.push({
        id: 'make-image-bigger',
        label: 'Make Bigger',
        icon: 'zoom_in',
        enabled: true,
        onSelect: () => handlers.onMakeImageBigger(imageContext),
    }, {
        id: 'make-image-smaller',
        label: 'Make Smaller',
        icon: 'zoom_out',
        enabled: true,
        onSelect: () => handlers.onMakeImageSmaller(imageContext),
    }, {
        id: 'reset-image-size',
        label: 'Reset Size',
        icon: 'restart_alt',
        enabled: true,
        onSelect: () => handlers.onResetImageSize(imageContext),
    });
    items.push({
        id: 'zoom-diagram',
        label: 'Zoom Diagram',
        icon: 'zoom',
        enabled: true,
        separated: true,
        onSelect: () => handlers.onZoomImage(imageContext),
    }, {
        id: 'save-diagram',
        label: 'Save Diagram File',
        icon: 'download',
        enabled: true,
        onSelect: () => handlers.onSaveDiagram(imageContext),
    });
    return items;
}

function buildReferenceSourceItem(referenceNoteId, onOpenReferenceSource) {
    if (typeof referenceNoteId !== 'string' || referenceNoteId.trim() === '') {
        throw new Error('Reference context requires non-empty referenceNoteId');
    }
    if (typeof onOpenReferenceSource !== 'function') {
        throw new Error('Reference context missing onOpenReferenceSource handler');
    }
    return {
        id: 'open-reference-source',
        label: 'Go to Source',
        icon: 'external',
        enabled: true,
        onSelect: () => onOpenReferenceSource(referenceNoteId),
    };
}

function buildNoteContextItems(context, handlers) {
    if (!context || typeof context !== 'object') {
        throw new Error('buildNoteContextItems requires context object');
    }
    if (!handlers || typeof handlers !== 'object') {
        throw new Error('buildNoteContextItems requires handlers object');
    }

    const noteId = context.noteId;
    if (typeof noteId !== 'string' || noteId.trim() === '') {
        throw new Error('Note context missing noteId');
    }
    const noteTimestamps = context.noteTimestamps;
    if (!noteTimestamps || typeof noteTimestamps !== 'object' || Array.isArray(noteTimestamps)) {
        throw new Error('Note context missing noteTimestamps object');
    }
    if (typeof noteTimestamps.created !== 'string' || noteTimestamps.created.length === 0) {
        throw new Error('Note context missing created timestamp');
    }
    if (typeof noteTimestamps.updated !== 'string' || noteTimestamps.updated.length === 0) {
        throw new Error('Note context missing updated timestamp');
    }
    const onAddSiblingNote = handlers.onAddSiblingNote;
    const onAddChildNote = handlers.onAddChildNote;
    const onAddNoteAtTop = handlers.onAddNoteAtTop;
    const onDeleteNote = handlers.onDeleteNote;
    const onMoveNoteToTop = handlers.onMoveNoteToTop;
    const onCopySelection = handlers.onCopySelection;
    const onAddSelectionAsTag = handlers.onAddSelectionAsTag;
    const onAddStyle = handlers.onAddStyle;
    const onRemoveFormatting = handlers.onRemoveFormatting;
    const onCopyNote = handlers.onCopyNote;
    const onPasteNote = handlers.onPasteNote;
    const onPasteNoteChild = handlers.onPasteNoteChild;
    const onPasteReference = handlers.onPasteReference;
    const onPasteReferenceChild = handlers.onPasteReferenceChild;
    const onPasteReferenceHere = handlers.onPasteReferenceHere;
    const onOpenReferenceSource = handlers.onOpenReferenceSource;
    const onCopyImage = handlers.onCopyImage;
    const onMakeImageBigger = handlers.onMakeImageBigger;
    const onMakeImageSmaller = handlers.onMakeImageSmaller;
    const onResetImageSize = handlers.onResetImageSize;
    const onSaveImage = handlers.onSaveImage;
    const onZoomImage = handlers.onZoomImage;
    const onOpenImageInNewTab = handlers.onOpenImageInNewTab;
    const onExportNoteHtml = handlers.onExportNoteHtml;
    const onExportViewHtml = handlers.onExportViewHtml;
    const onViewNoteFullscreen = handlers.onViewNoteFullscreen;
    const onFullyExpandNote = handlers.onFullyExpandNote;
    const onFullyCollapseNote = handlers.onFullyCollapseNote;
    const onAddDiagram = handlers.onAddDiagram;
    const onEditDiagram = handlers.onEditDiagram;
    const onSaveDiagram = handlers.onSaveDiagram;
    if (typeof onAddSiblingNote !== 'function') {
        throw new Error('Note context missing onAddSiblingNote handler');
    }
    if (typeof onAddChildNote !== 'function') {
        throw new Error('Note context missing onAddChildNote handler');
    }
    if (typeof onDeleteNote !== 'function') {
        throw new Error('Note context missing onDeleteNote handler');
    }
    if (typeof onMoveNoteToTop !== 'function') {
        throw new Error('Note context missing onMoveNoteToTop handler');
    }
    if (typeof onCopySelection !== 'function') {
        throw new Error('Note context missing onCopySelection handler');
    }
    if (typeof onAddSelectionAsTag !== 'function') {
        throw new Error('Note context missing onAddSelectionAsTag handler');
    }
    if (typeof onCopyNote !== 'function') {
        throw new Error('Note context missing onCopyNote handler');
    }
    if (typeof onPasteNote !== 'function') {
        throw new Error('Note context missing onPasteNote handler');
    }
    if (typeof onPasteNoteChild !== 'function') {
        throw new Error('Note context missing onPasteNoteChild handler');
    }
    if (typeof onPasteReference !== 'function') {
        throw new Error('Note context missing onPasteReference handler');
    }
    if (typeof onPasteReferenceChild !== 'function') {
        throw new Error('Note context missing onPasteReferenceChild handler');
    }
    if (typeof onPasteReferenceHere !== 'function') {
        throw new Error('Note context missing onPasteReferenceHere handler');
    }
    if (typeof onExportNoteHtml !== 'function') {
        throw new Error('Note context missing onExportNoteHtml handler');
    }
    if (typeof onExportViewHtml !== 'function') {
        throw new Error('Note context missing onExportViewHtml handler');
    }
    if (typeof onFullyExpandNote !== 'function') {
        throw new Error('Note context missing onFullyExpandNote handler');
    }
    if (typeof onFullyCollapseNote !== 'function') {
        throw new Error('Note context missing onFullyCollapseNote handler');
    }

    const items = [];
    const referenceNoteId = context.referenceNoteId;
    if (referenceNoteId !== undefined) {
        items.push(buildReferenceSourceItem(referenceNoteId, onOpenReferenceSource));
    }
    const imageContext = context.imageContext;
    const isDiagram = imageContext !== null && typeof imageContext === 'object' && imageContext.fileKind === 'excalidraw';
    if (isDiagram) {
        items.push(...buildDiagramItems(context, imageContext, {
            onEditDiagram, onSaveDiagram, onZoomImage, onMakeImageBigger, onMakeImageSmaller, onResetImageSize,
        }));
    }
    // An image's size changes in view and edit mode alike (in the edited note, the
    // tag bar and the braces around it update).
    if (!isDiagram && imageContext !== null && typeof imageContext === 'object') {
        if (typeof onCopyImage !== 'function') {
            throw new Error('Image note context missing onCopyImage handler');
        }
        if (typeof onSaveImage !== 'function') {
            throw new Error('Image note context missing onSaveImage handler');
        }
        if (typeof onZoomImage !== 'function') {
            throw new Error('Image note context missing onZoomImage handler');
        }
        if (typeof onOpenImageInNewTab !== 'function') {
            throw new Error('Image note context missing onOpenImageInNewTab handler');
        }
        if (typeof onMakeImageBigger !== 'function') {
            throw new Error('Image note context missing onMakeImageBigger handler');
        }
        if (typeof onMakeImageSmaller !== 'function') {
            throw new Error('Image note context missing onMakeImageSmaller handler');
        }
        if (typeof onResetImageSize !== 'function') {
            throw new Error('Image note context missing onResetImageSize handler');
        }
        items.push({
            id: 'make-image-bigger',
            label: 'Make Bigger',
            icon: 'zoom_in',
            enabled: true,
            onSelect: () => onMakeImageBigger(imageContext),
        }, {
            id: 'make-image-smaller',
            label: 'Make Smaller',
            icon: 'zoom_out',
            enabled: true,
            onSelect: () => onMakeImageSmaller(imageContext),
        }, {
            id: 'reset-image-size',
            label: 'Reset Size',
            icon: 'restart_alt',
            enabled: true,
            onSelect: () => onResetImageSize(imageContext),
        });

        const copyImageItem = {
            id: 'copy-image',
            label: 'Copy Image',
            icon: 'image',
            enabled: true,
            separated: true,
            onSelect: () => onCopyImage(imageContext),
        };
        items.push(
            copyImageItem,
            {
                id: 'save-image',
                label: 'Save Image',
                icon: 'download',
                enabled: true,
                onSelect: () => onSaveImage(imageContext),
            },
            {
                id: 'zoom-image',
                label: 'Zoom Image',
                icon: 'zoom',
                enabled: true,
                onSelect: () => onZoomImage(imageContext),
            },
            {
                id: 'open-image-new-tab',
                label: 'Open Image in New Tab',
                icon: 'external',
                enabled: true,
                onSelect: () => onOpenImageInNewTab(imageContext),
            },
        );
    }

    const hasSelectedText = context.hasSelectedText === true;
    const hasNoteClipboard = context.hasNoteClipboard === true;
    const hasReferenceClipboard = context.hasReferenceClipboard === true;
    // A right-click in the text of the note being edited, with a note copied.
    const canPasteReferenceHere = hasReferenceClipboard && context.canPasteReferenceHere === true;
    const isMac = requireNoteFlag(context, 'isMac');
    // A menu item's shortcut: the key alone, with ⌘ (Ctrl), or with ⌘⇧ (Ctrl+Shift).
    const plainKey = (key) => formatMenuShortcut({ isMac, mod: false, shift: false, key });
    const commandKey = (key) => formatMenuShortcut({ isMac, mod: true, shift: false, key });
    const commandShiftKey = (key) => formatMenuShortcut({ isMac, mod: true, shift: true, key });

    // What you clicked: the selection or the note.
    const copyItem = {
        id: hasSelectedText ? 'copy-selection' : 'copy-note',
        label: hasSelectedText ? 'Copy' : 'Copy Note',
        icon: 'copy',
        enabled: true,
        shortcut: commandKey('C'),
        onSelect: () => {
            if (hasSelectedText) {
                onCopySelection(noteId);
                return;
            }
            onCopyNote(noteId);
        },
    };
    if (items.length > 0) {
        copyItem.separated = true;
    }
    items.push(copyItem);

    const selectedTextForTag = context.selectedTextForTag;
    if (selectedTextForTag !== undefined) {
        if (typeof selectedTextForTag !== 'string' || selectedTextForTag.length === 0) {
            throw new Error('Note context selectedTextForTag must be a non-empty string when provided');
        }
        if (!hasSelectedText) {
            throw new Error('Note context cannot add selected text as tag without selected text');
        }
        items.push({
            id: 'add-selection-as-tag',
            label: 'Add as Tag',
            icon: 'tag',
            enabled: true,
            onSelect: () => onAddSelectionAsTag(noteId, selectedTextForTag),
        });
    }

    const pasteEntries = [];
    if (hasNoteClipboard) {
        pasteEntries.push(
            { id: 'paste-note', label: 'Paste Sibling Note', icon: 'paste', enabled: true, shortcut: commandKey('V'), onSelect: () => onPasteNote(noteId) },
            { id: 'paste-note-child', label: 'Paste Child Note', icon: 'paste_child', enabled: true, shortcut: commandShiftKey('V'), onSelect: () => onPasteNoteChild(noteId) },
        );
    }
    if (hasReferenceClipboard) {
        pasteEntries.push(
            { id: 'paste-reference', label: 'Paste Sibling Reference', icon: 'link', enabled: true, shortcut: commandKey('R'), onSelect: () => onPasteReference(noteId) },
            { id: 'paste-reference-child', label: 'Paste Child Reference', icon: 'link_child', enabled: true, shortcut: commandShiftKey('R'), onSelect: () => onPasteReferenceChild(noteId) },
        );
    }
    // With the other references: less common than pasting notes.
    if (canPasteReferenceHere) {
        pasteEntries.push(
            { id: 'paste-reference-into-note', label: 'Paste Reference Into Note', icon: 'link', enabled: true, onSelect: () => onPasteReferenceHere(noteId) },
        );
    }
    pushGroup(items, { id: 'paste', label: 'Paste', icon: 'paste', separated: false }, pasteEntries);

    const addEntries = [
        { id: 'add-sibling-note', label: 'Add Sibling Note', icon: 'add_sibling', enabled: true, shortcut: commandKey('Enter'), onSelect: () => onAddSiblingNote(noteId) },
        { id: 'add-child-note', label: 'Add Child Note', icon: 'add_child', enabled: true, shortcut: commandShiftKey('Enter'), onSelect: () => onAddChildNote(noteId) },
    ];
    if (context.canAddNoteAtTop === true) {
        if (typeof onAddNoteAtTop !== 'function') {
            throw new Error('Non-editing note context missing onAddNoteAtTop handler');
        }
        addEntries.push({ id: 'add-note-at-top', label: 'Add Note at Top', icon: 'add_top', enabled: true, shortcut: plainKey('Enter'), onSelect: () => onAddNoteAtTop() });
    }
    pushGroup(items, { id: 'add', label: 'Add', icon: 'add_sibling', separated: true }, addEntries);

    const focusEntries = [];
    if (context.canViewFullscreen === true) {
        if (typeof onViewNoteFullscreen !== 'function') {
            throw new Error('Non-editing note context missing onViewNoteFullscreen handler');
        }
        focusEntries.push({ id: 'view-note-fullscreen', label: 'Full Screen', inlineLabel: 'View Full Screen', icon: 'fullscreen', enabled: true, onSelect: () => onViewNoteFullscreen(noteId) });
    }
    if (context.canOpenFloatingNote === true) {
        if (typeof handlers.onOpenFloatingNote !== 'function') {
            throw new Error('Note context missing onOpenFloatingNote handler');
        }
        focusEntries.push({ id: 'open-floating-note', label: 'Floating Window', inlineLabel: 'Open in Floating Window', icon: 'floating_window', enabled: true, onSelect: () => handlers.onOpenFloatingNote(noteId) });
    }

    pushGroup(items, { id: 'move', label: 'Move', icon: 'arrow_up', separated: false }, buildMoveEntries(context, handlers, { commandKey, commandShiftKey }));
    pushGroup(items, { id: 'outline', label: 'Outline', icon: 'outline', separated: false }, buildOutlineEntries(context, handlers, { commandKey }));

    pushGroup(items, { id: 'focus', label: 'Focus', icon: 'fullscreen', separated: false }, focusEntries);

    items.push({
        id: 'export',
        label: 'Export',
        icon: 'download',
        enabled: true,
        submenu: [
            { id: 'export-note-html', label: 'Note as HTML', icon: 'download', enabled: true, onSelect: () => onExportNoteHtml(noteId) },
            { id: 'export-view-html', label: 'View as HTML', icon: 'download', enabled: true, onSelect: () => onExportViewHtml() },
        ],
    });
    // Print: the browser's print dialog (Save as PDF too), after a title step.
    if (typeof handlers.onPrintNote !== 'function' || typeof handlers.onPrintView !== 'function') {
        throw new Error('Note context missing onPrintNote or onPrintView handler');
    }
    items.push({
        id: 'print',
        label: 'Print',
        icon: 'print',
        enabled: true,
        submenu: [
            { id: 'print-note', label: 'Note', icon: 'print', enabled: true, onSelect: () => handlers.onPrintNote(noteId) },
            { id: 'print-view', label: 'View', icon: 'print', enabled: true, onSelect: () => handlers.onPrintView() },
        ],
    });

    // Editing the note: style, formatting, a drawing.
    const editingItems = [];
    if (context.canAddStyle === true) {
        editingItems.push(buildAddStyleItem(context, noteId, onAddStyle));
    }
    if (context.canRemoveFormatting === true) {
        if (typeof onRemoveFormatting !== 'function') {
            throw new Error('Editing note context missing onRemoveFormatting handler');
        }
        editingItems.push({ id: 'remove-formatting', label: 'Remove Formatting', icon: 'clear_formatting', enabled: true, shortcut: commandKey('U'), onSelect: () => onRemoveFormatting(noteId) });
    }
    if (context.canAddDiagram === true) {
        if (typeof onAddDiagram !== 'function') {
            throw new Error('Editing note context missing onAddDiagram handler');
        }
        editingItems.push({ id: 'add-excalidraw-diagram', label: 'Add Excalidraw Diagram', icon: 'diagram', enabled: true, onSelect: () => onAddDiagram(noteId) });
    }
    // Only when an AI is set up and may see the note (docs/ui/tag-bar.md, "Suggest Tags with AI").
    if (context.canSuggestTagsWithAi === true) {
        editingItems.push(buildSuggestTagsWithAiItem(noteId, context.hasChildren, handlers));
    }
    if (editingItems.length > 0) {
        editingItems[0].separated = true;
        items.push(...editingItems);
    }

    items.push({
        id: 'delete-note',
        label: 'Delete Note',
        icon: 'trash',
        enabled: true,
        separated: true,
        shortcut: commandKey('Backspace'),
        onSelect: () => onDeleteNote(noteId),
    });
    items.push({
        id: 'note-timestamps',
        kind: 'info',
        label: 'Note timestamps',
        rows: [
            { label: 'Created', value: noteTimestamps.created },
            { label: 'Updated', value: noteTimestamps.updated },
        ],
    });
    return items;
}

function requireNoteFlag(context, name) {
    if (typeof context[name] !== 'boolean') {
        throw new Error(`Note context missing ${name} boolean`);
    }
    return context[name];
}

// A submenu of related actions; a single action is shown in place instead (with
// its inlineLabel, when its submenu label leans on the group's name), and an
// empty group not at all.
function pushGroup(items, { id, label, icon, separated }, entries) {
    if (entries.length === 0) {
        return;
    }
    const withoutInlineLabel = ({ inlineLabel, ...entry }) => entry;
    if (entries.length === 1) {
        const entry = withoutInlineLabel(entries[0]);
        if (entries[0].inlineLabel !== undefined) {
            entry.label = entries[0].inlineLabel;
        }
        items.push({ ...entry, separated });
        return;
    }
    items.push({ id, label, icon, enabled: true, separated, submenu: entries.map(withoutInlineLabel) });
}

function buildFlaggedEntries(context, handlers, specs) {
    const noteId = context.noteId;
    const entries = [];
    for (const [flag, id, label, icon, handlerName, shortcut] of specs) {
        if (!requireNoteFlag(context, flag)) {
            continue;
        }
        const handler = handlers[handlerName];
        if (typeof handler !== 'function') {
            throw new Error(`Note context missing ${handlerName} handler`);
        }
        const entry = { id, label, icon, enabled: true, onSelect: () => handler(noteId) };
        if (shortcut !== null) {
            entry.shortcut = shortcut;
        }
        entries.push(entry);
    }
    return entries;
}

// The note's place in the list. Moves that cannot happen from here are hidden
// (no siblings that way, a root while a sort order is active).
function buildMoveEntries(context, handlers, { commandKey, commandShiftKey }) {
    return buildFlaggedEntries(context, handlers, [
        ['canMoveToTop', 'move-note-to-top', 'Move to Top', 'arrow_top', 'onMoveNoteToTop', commandShiftKey('↑')],
        ['canMoveUp', 'move-note-up', 'Move Up', 'arrow_up', 'onMoveNoteUp', commandKey('↑')],
        ['canMoveDown', 'move-note-down', 'Move Down', 'arrow_down', 'onMoveNoteDown', commandKey('↓')],
        ['canMoveToBottom', 'move-note-to-bottom', 'Move to Bottom', 'arrow_bottom', 'onMoveNoteToBottom', commandShiftKey('↓')],
    ]);
}

// The note's level in the outline: expanding its subtree, indenting, outdenting.
function buildOutlineEntries(context, handlers, { commandKey }) {
    const expandEntries = buildFlaggedEntries(context, handlers, [
        ['hasChildren', 'fully-expand-note', 'Fully Expand', 'expand_all', 'onFullyExpandNote', null],
        ['hasChildren', 'fully-collapse-note', 'Fully Collapse', 'collapse_all', 'onFullyCollapseNote', null],
    ]);
    const levelEntries = buildFlaggedEntries(context, handlers, [
        ['canIndent', 'indent-note', 'Indent', 'indent', 'onIndentNote', commandKey('→')],
        ['canOutdent', 'outdent-note', 'Outdent', 'outdent', 'onOutdentNote', commandKey('←')],
    ]);
    if (expandEntries.length > 0 && levelEntries.length > 0) {
        levelEntries[0].separated = true;
    }
    return [...expandEntries, ...levelEntries];
}

function buildAddStyleItem(context, noteId, onAddStyle) {
    if (typeof onAddStyle !== 'function') {
        throw new Error('Editing note context missing onAddStyle handler');
    }
    const styleOptions = context.styleOptions;
    if (!Array.isArray(styleOptions) || styleOptions.length === 0) {
        throw new Error('Editing note context requires styleOptions');
    }
    const submenu = styleOptions.map((styleOption) => {
        if (!styleOption || typeof styleOption !== 'object') {
            throw new Error('Add Style option must be an object');
        }
        const { id, label, tag } = styleOption;
        if (typeof id !== 'string' || id.length === 0) {
            throw new Error('Add Style option missing id');
        }
        if (typeof label !== 'string' || label.length === 0) {
            throw new Error('Add Style option missing label');
        }
        if (typeof tag !== 'string' || !tag.startsWith('@')) {
            throw new Error('Add Style option missing meta tag');
        }
        return {
            id: `add-style-${id}`,
            label,
            icon: 'style',
            enabled: true,
            onSelect: () => onAddStyle(noteId, tag),
        };
    });
    return { id: 'add-style', label: 'Add Style', icon: 'style', enabled: true, submenu };
}

function buildLinkContextItems(context, handlers) {
    if (!context || typeof context !== 'object') {
        throw new Error('buildLinkContextItems requires context object');
    }
    if (!handlers || typeof handlers !== 'object') {
        throw new Error('buildLinkContextItems requires handlers object');
    }

    const linkContext = context.linkContext;
    if (linkContext === null || typeof linkContext !== 'object') {
        throw new Error('Link context missing linkContext');
    }
    const href = linkContext.href;
    if (typeof href !== 'string' || href.trim() === '') {
        throw new Error('Link context missing href');
    }

    const onCopyLink = handlers.onCopyLink;
    const onOpenLinkInNewTab = handlers.onOpenLinkInNewTab;
    if (typeof onCopyLink !== 'function') {
        throw new Error('Link context missing onCopyLink handler');
    }
    if (typeof onOpenLinkInNewTab !== 'function') {
        throw new Error('Link context missing onOpenLinkInNewTab handler');
    }

    const items = [];
    if (context.referenceNoteId !== undefined) {
        items.push(buildReferenceSourceItem(
            context.referenceNoteId,
            handlers.onOpenReferenceSource,
        ));
    }
    const copyLinkItem = {
        id: 'copy-link',
        label: 'Copy Link',
        icon: 'copy',
        enabled: true,
        onSelect: () => onCopyLink(linkContext),
    };
    if (items.length > 0) {
        copyLinkItem.separated = true;
    }
    items.push(
        copyLinkItem,
        {
            id: 'open-link-new-tab',
            label: 'Open Link in New Tab',
            icon: 'external',
            enabled: true,
            onSelect: () => onOpenLinkInNewTab(linkContext),
        },
    );
    return items;
}

function buildSortModeItem(sortMode, onSetSortMode) {
    const currentMode = normalizeRootSortMode(sortMode);
    if (typeof onSetSortMode !== 'function') {
        throw new Error('View context missing onSetSortMode handler');
    }
    const options = [
        [ROOT_SORT_MODES.NORMAL, 'Normal', 'manual_order'],
        [ROOT_SORT_MODES.CREATED, 'Datetime created', 'calendar'],
        [ROOT_SORT_MODES.UPDATED, 'Datetime last updated', 'clock'],
        [ROOT_SORT_MODES.ALPHABETICAL, 'Alphabetical', 'alphabetical'],
        [ROOT_SORT_MODES.CONTENT_VOLUME, 'Content volume (largest first)', 'volume'],
    ];
    return {
        id: 'sort-by',
        label: 'Sort by',
        icon: 'sort',
        enabled: true,
        submenu: options.map(([mode, label, icon]) => ({
            id: `sort-by-${mode}`,
            label,
            icon,
            checked: mode === currentMode,
            enabled: mode !== currentMode,
            onSelect: () => onSetSortMode(mode),
        })),
    };
}

const MAC_KEY_SYMBOLS = Object.freeze({ Enter: '↩', Backspace: '⌫' });

// A keyboard shortcut as the platform writes it: ⇧⌘Z on a Mac, Ctrl+Shift+Z elsewhere.
export function formatMenuShortcut({ isMac, mod, shift, key }) {
    if (typeof isMac !== 'boolean' || typeof mod !== 'boolean' || typeof shift !== 'boolean') {
        throw new Error('formatMenuShortcut requires isMac, mod and shift booleans');
    }
    if (typeof key !== 'string' || key.length === 0) {
        throw new Error('formatMenuShortcut requires key');
    }
    if (isMac) {
        // Keys with a Mac symbol (Enter ↩, arrows) show it; letters show themselves.
        let macKey = key;
        if (Object.hasOwn(MAC_KEY_SYMBOLS, key)) macKey = MAC_KEY_SYMBOLS[key];
        return `${shift ? '⇧' : ''}${mod ? '⌘' : ''}${macKey}`;
    }
    return [mod ? 'Ctrl' : '', shift ? 'Shift' : '', key].filter((part) => part !== '').join('+');
}

function requireViewHandler(handlers, name) {
    const handler = handlers[name];
    if (typeof handler !== 'function') {
        throw new Error(`View context missing ${name} handler`);
    }
    return handler;
}

function requireViewFlag(context, name) {
    if (typeof context[name] !== 'boolean') {
        throw new Error(`View context missing ${name} boolean`);
    }
    return context[name];
}

// The menu outside any note: actions about this view and workspace
// (docs/ui/controls.md), grouped: adding, history, moving around the
// list, how the view looks, opening things, export, and logging out.
function buildViewContextItems(context, handlers) {
    if (!context || typeof context !== 'object') {
        throw new Error('buildViewContextItems requires context object');
    }
    if (!handlers || typeof handlers !== 'object') {
        throw new Error('buildViewContextItems requires handlers object');
    }
    const isMac = requireViewFlag(context, 'isMac');
    const isEditing = requireViewFlag(context, 'isEditing');
    const canPasteNoteAtTop = requireViewFlag(context, 'canPasteNoteAtTop');
    const canGoToTop = requireViewFlag(context, 'canGoToTop');
    const canGoToBottom = requireViewFlag(context, 'canGoToBottom');
    const isUntaggedView = requireViewFlag(context, 'isUntaggedView');
    const areTabsVisible = requireViewFlag(context, 'areTabsVisible');
    const isAiChatVisible = requireViewFlag(context, 'isAiChatVisible');
    const areNoteTagsVisible = requireViewFlag(context, 'areNoteTagsVisible');
    if (!['system', 'light', 'dark'].includes(context.theme)) {
        throw new Error('View context theme must be system, light or dark');
    }
    // A menu item's shortcut: the key alone, with ⌘ (Ctrl), or with ⌘⇧ (Ctrl+Shift).
    const plainKey = (key) => formatMenuShortcut({ isMac, mod: false, shift: false, key });
    const commandKey = (key) => formatMenuShortcut({ isMac, mod: true, shift: false, key });
    const commandShiftKey = (key) => formatMenuShortcut({ isMac, mod: true, shift: true, key });

    const items = [];
    if (!isEditing) {
        const onAddNoteAtTop = requireViewHandler(handlers, 'onAddNoteAtTop');
        items.push({
            id: 'add-note-at-top', label: 'Add Note at Top', icon: 'add_top', enabled: true,
            shortcut: plainKey('Enter'), onSelect: () => onAddNoteAtTop(),
        });
        if (canPasteNoteAtTop) {
            const onPasteNoteAtTop = requireViewHandler(handlers, 'onPasteNoteAtTop');
            items.push({
                id: 'paste-note-at-top', label: 'Paste Note at Top', icon: 'paste', enabled: true,
                shortcut: commandKey('V'), onSelect: () => onPasteNoteAtTop(),
            });
        }
        // While a note is edited, its own editor undoes typing (⌘Z).
        const onUndo = requireViewHandler(handlers, 'onUndo');
        const onRedo = requireViewHandler(handlers, 'onRedo');
        items.push(
            {
                id: 'undo', label: 'Undo', icon: 'undo', enabled: true, separated: true,
                shortcut: commandKey('Z'), onSelect: () => onUndo(),
            },
            {
                id: 'redo', label: 'Redo', icon: 'redo', enabled: true,
                shortcut: commandShiftKey('Z'), onSelect: () => onRedo(),
            },
        );
    }
    const goToItems = [];
    if (canGoToTop) {
        const onGoToTop = requireViewHandler(handlers, 'onGoToTop');
        goToItems.push({ id: 'go-to-top', label: 'Go to Top', icon: 'arrow_top', enabled: true, onSelect: () => onGoToTop() });
    }
    if (canGoToBottom) {
        const onGoToBottom = requireViewHandler(handlers, 'onGoToBottom');
        goToItems.push({ id: 'go-to-bottom', label: 'Go to Bottom', icon: 'arrow_bottom', enabled: true, onSelect: () => onGoToBottom() });
    }
    if (goToItems.length > 0) {
        goToItems[0].separated = true;
        items.push(...goToItems);
    }
    const onFullyExpandAll = requireViewHandler(handlers, 'onFullyExpandAll');
    const onFullyCollapseAll = requireViewHandler(handlers, 'onFullyCollapseAll');
    items.push(
        { id: 'fully-expand-all', label: 'Fully Expand All', icon: 'expand_all', enabled: true, separated: goToItems.length === 0, onSelect: () => onFullyExpandAll() },
        { id: 'fully-collapse-all', label: 'Fully Collapse All', icon: 'collapse_all', enabled: true, onSelect: () => onFullyCollapseAll() },
    );

    const onSetUntaggedView = requireViewHandler(handlers, 'onSetUntaggedView');
    const onToggleAiChat = requireViewHandler(handlers, 'onToggleAiChat');
    const onToggleTabs = requireViewHandler(handlers, 'onToggleTabs');
    const onToggleNoteTags = requireViewHandler(handlers, 'onToggleNoteTags');
    const onSetTheme = requireViewHandler(handlers, 'onSetTheme');
    items.push(
        {
            id: 'view', label: 'View', icon: 'view', enabled: true, separated: true,
            submenu: [
                { id: 'view-all-notes', label: 'All notes', checked: !isUntaggedView, enabled: isUntaggedView, onSelect: () => onSetUntaggedView(false) },
                { id: 'view-untagged-notes', label: 'Untagged notes', checked: isUntaggedView, enabled: !isUntaggedView, onSelect: () => onSetUntaggedView(true) },
            ],
        },
        buildSortModeItem(context.sortMode, handlers.onSetSortMode),
        {
            id: 'show', label: 'Show', icon: 'show', enabled: true,
            submenu: [
                { id: 'show-chat', label: 'Chat', icon: 'chat', checked: isAiChatVisible, enabled: true, onSelect: () => onToggleAiChat(!isAiChatVisible) },
                { id: 'show-tabs', label: 'Tabs', icon: 'tabs', checked: areTabsVisible, enabled: true, onSelect: () => onToggleTabs(!areTabsVisible) },
                { id: 'show-note-tags', label: 'Tags in List', icon: 'tag', checked: areNoteTagsVisible, enabled: true, onSelect: () => onToggleNoteTags(!areNoteTagsVisible) },
            ],
        },
        {
            id: 'theme', label: 'Theme', icon: 'theme', enabled: true,
            submenu: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) => ({
                id: `theme-${value}`, label, checked: context.theme === value, enabled: context.theme !== value,
                onSelect: () => onSetTheme(value),
            })),
        },
    );

    const onNewTab = requireViewHandler(handlers, 'onNewTab');
    const onOpenNamespace = requireViewHandler(handlers, 'onOpenNamespace');
    const onOpenReminders = requireViewHandler(handlers, 'onOpenReminders');
    const onExportViewHtml = requireViewHandler(handlers, 'onExportViewHtml');
    const onPrintView = requireViewHandler(handlers, 'onPrintView');
    const onLogOut = requireViewHandler(handlers, 'onLogOut');
    items.push(
        { id: 'new-tab', label: 'New Tab', icon: 'tabs', enabled: true, separated: true, onSelect: () => onNewTab() },
        { id: 'open-namespace', label: 'Open/Switch Vault…', icon: 'namespace', enabled: true, onSelect: () => onOpenNamespace() },
        { id: 'reminders', label: 'Reminders…', icon: 'reminder', enabled: true, onSelect: () => onOpenReminders() },
        { id: 'export-view-html', label: 'Export View as HTML', icon: 'download', enabled: true, separated: true, onSelect: () => onExportViewHtml() },
        { id: 'print-view', label: 'Print View', icon: 'print', enabled: true, onSelect: () => onPrintView() },
        { id: 'log-out', label: 'Log Out', icon: 'log_out', enabled: true, separated: true, onSelect: () => onLogOut() },
    );
    return items;
}

// Suggest Tags with AI: for a note with children, a submenu choosing the note
// alone or with the notes below it; otherwise the item itself.
function buildSuggestTagsWithAiItem(noteId, hasChildren, handlers) {
    if (typeof handlers.onSuggestTagsWithAi !== 'function') {
        throw new Error('Suggest Tags with AI missing onSuggestTagsWithAi handler');
    }
    if (typeof hasChildren !== 'boolean') {
        throw new Error('Suggest Tags with AI requires hasChildren boolean');
    }
    const item = { id: 'suggest-tags-with-ai', label: 'Suggest Tags with AI', icon: 'robot', enabled: true };
    if (!hasChildren) {
        return { ...item, onSelect: () => handlers.onSuggestTagsWithAi(noteId, false) };
    }
    return { ...item, submenu: [
        { id: 'suggest-tags-this-note', label: 'This Note', enabled: true,
            onSelect: () => handlers.onSuggestTagsWithAi(noteId, false) },
        { id: 'suggest-tags-with-children', label: 'This Note and Its Children', enabled: true,
            onSelect: () => handlers.onSuggestTagsWithAi(noteId, true) },
    ] };
}

// Right-click past the tags in the edited note's tag bar (docs/ui/tag-bar.md):
// only shown when the AI may be used, so it always has the one item.
function buildTagBarContextItems(context, handlers) {
    if (typeof context.noteId !== 'string' || context.noteId === '') {
        throw new Error('Tag bar context requires noteId');
    }
    return [buildSuggestTagsWithAiItem(context.noteId, context.hasChildren, handlers)];
}

// Right-click a note's robot count (🤖 N): all the proposals it counts at once.
function buildTagProposalsContextItems(context, handlers) {
    if (typeof context.noteId !== 'string' || context.noteId === '') {
        throw new Error('Tag proposals context requires noteId');
    }
    if (typeof handlers.onResolveAllTagProposals !== 'function') {
        throw new Error('Tag proposals context missing onResolveAllTagProposals handler');
    }
    return [
        { id: 'accept-all-suggested-tags', label: 'Accept All Suggested Tags', icon: 'robot', enabled: true,
            onSelect: () => handlers.onResolveAllTagProposals(context.noteId, 'accept') },
        { id: 'reject-all-suggested-tags', label: 'Reject All Suggested Tags', icon: 'robot', enabled: true,
            onSelect: () => handlers.onResolveAllTagProposals(context.noteId, 'reject') },
    ];
}

export function buildContextMenuItems(context, handlers) {
    if (!context || typeof context !== 'object') {
        throw new Error('buildContextMenuItems requires context object');
    }
    const kind = context.kind;
    if (typeof kind !== 'string' || kind.trim() === '') {
        throw new Error('buildContextMenuItems requires context.kind string');
    }

    if (kind === 'tag') {
        return buildTagContextItems(context, handlers);
    }
    if (kind === 'tag-bar') {
        return buildTagBarContextItems(context, handlers);
    }
    if (kind === 'tag-proposals') {
        return buildTagProposalsContextItems(context, handlers);
    }
    if (kind === 'note') {
        return buildNoteContextItems(context, handlers);
    }
    if (kind === 'link') {
        return buildLinkContextItems(context, handlers);
    }
    if (kind === 'view') {
        return buildViewContextItems(context, handlers);
    }

    return [];
}
