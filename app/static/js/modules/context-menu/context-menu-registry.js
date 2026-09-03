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

    return [
        {
            id: 'edit-tag-relationships',
            label: 'Edit Tag Relationships',
            icon: 'link',
            enabled: true,
            onSelect: () => onEditTagRelationships(tag),
        },
    ];
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
    const onMakePseudoSuggestions = handlers.onMakePseudoSuggestions;
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
    if (typeof onExportNoteHtml !== 'function') {
        throw new Error('Note context missing onExportNoteHtml handler');
    }
    if (typeof onExportViewHtml !== 'function') {
        throw new Error('Note context missing onExportViewHtml handler');
    }

    const items = [];
    const referenceNoteId = context.referenceNoteId;
    if (referenceNoteId !== undefined) {
        items.push(buildReferenceSourceItem(referenceNoteId, onOpenReferenceSource));
    }
    if (context.canMakePseudoSuggestions === true) {
        if (typeof onMakePseudoSuggestions !== 'function') {
            throw new Error('Editing note context missing onMakePseudoSuggestions handler');
        }
        items.push({
            id: 'make-pseudo-suggestions',
            label: 'Make pseudo-suggestions',
            enabled: true,
            onSelect: () => onMakePseudoSuggestions(noteId),
        });
    }
    const imageContext = context.imageContext;
    if (imageContext !== null && typeof imageContext === 'object') {
        const canResizeImage = context.canResizeImage;
        if (typeof canResizeImage !== 'boolean') {
            throw new Error('Image note context missing canResizeImage boolean');
        }
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
        if (canResizeImage) {
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
        }

        const copyImageItem = {
            id: 'copy-image',
            label: 'Copy Image',
            icon: 'image',
            enabled: true,
            onSelect: () => onCopyImage(imageContext),
        };
        if (canResizeImage) {
            copyImageItem.separated = true;
        }
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
    const copyItem = {
        id: hasSelectedText ? 'copy-selection' : 'copy-note',
        label: hasSelectedText ? 'Copy' : 'Copy Note',
        icon: 'copy',
        enabled: true,
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

    if (context.canViewFullscreen === true) {
        if (typeof onViewNoteFullscreen !== 'function') {
            throw new Error('Non-editing note context missing onViewNoteFullscreen handler');
        }
        items.push({
            id: 'view-note-fullscreen',
            label: 'View Full Screen',
            icon: 'zoom',
            enabled: true,
            onSelect: () => onViewNoteFullscreen(noteId),
        });
    }

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

    if (context.canRemoveFormatting === true) {
        if (typeof onRemoveFormatting !== 'function') {
            throw new Error('Editing note context missing onRemoveFormatting handler');
        }
        items.unshift({
            id: 'remove-formatting',
            label: 'Remove Formatting',
            icon: 'clear_formatting',
            enabled: true,
            onSelect: () => onRemoveFormatting(noteId),
        });
    }

    if (context.canAddStyle === true) {
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
                enabled: true,
                onSelect: () => onAddStyle(noteId, tag),
            };
        });
        items.unshift({
            id: 'add-style',
            label: 'Add Style',
            icon: 'style',
            enabled: true,
            submenu,
        });
    }

    if (hasNoteClipboard) {
        items.push(
            {
                id: 'paste-note',
                label: 'Paste Sibling Note',
                icon: 'paste',
                enabled: true,
                onSelect: () => onPasteNote(noteId),
            },
            {
                id: 'paste-note-child',
                label: 'Paste Child Note',
                icon: 'paste_child',
                enabled: true,
                onSelect: () => onPasteNoteChild(noteId),
            },
        );
    }

    if (hasReferenceClipboard) {
        items.push(
            {
                id: 'paste-reference',
                label: 'Paste Sibling Reference',
                icon: 'link',
                enabled: true,
                onSelect: () => onPasteReference(noteId),
            },
            {
                id: 'paste-reference-child',
                label: 'Paste Child Reference',
                icon: 'link_child',
                enabled: true,
                onSelect: () => onPasteReferenceChild(noteId),
            },
        );
    }

    const addSiblingItem = {
        id: 'add-sibling-note',
        label: 'Add Sibling Note',
        icon: 'add_sibling',
        enabled: true,
        onSelect: () => onAddSiblingNote(noteId),
    };
    if (context.canAddNoteAtTop === true) {
        if (typeof onAddNoteAtTop !== 'function') {
            throw new Error('Non-editing note context missing onAddNoteAtTop handler');
        }
        items.push({
            id: 'add-note-at-top',
            label: 'Add Note at Top',
            enabled: true,
            onSelect: () => onAddNoteAtTop(),
        });
    }
    items.push(
        addSiblingItem,
        {
            id: 'add-child-note',
            label: 'Add Child Note',
            icon: 'add_child',
            enabled: true,
            onSelect: () => onAddChildNote(noteId),
        },
        {
            id: 'delete-note',
            label: 'Delete Note',
            icon: 'trash',
            enabled: true,
            onSelect: () => onDeleteNote(noteId),
        },
        {
            id: 'move-note-to-top',
            label: 'Move Note to Top',
            icon: 'arrow_top',
            enabled: true,
            onSelect: () => onMoveNoteToTop(noteId),
        },
    );
    items.push(
        {
            id: 'export-note-html',
            label: 'Export Note as HTML',
            icon: 'download',
            enabled: true,
            separated: true,
            onSelect: () => onExportNoteHtml(noteId),
        },
        {
            id: 'export-view-html',
            label: 'Export View as HTML',
            icon: 'download',
            enabled: true,
            onSelect: () => onExportViewHtml(),
        },
    );
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

function buildViewContextItems(context, handlers) {
    if (!context || typeof context !== 'object') {
        throw new Error('buildViewContextItems requires context object');
    }
    if (!handlers || typeof handlers !== 'object') {
        throw new Error('buildViewContextItems requires handlers object');
    }

    const onExportViewHtml = handlers.onExportViewHtml;
    const onAddNoteAtTop = handlers.onAddNoteAtTop;
    const onToggleTabs = handlers.onToggleTabs;
    const onToggleCalendar = handlers.onToggleCalendar;
    const onToggleAiChat = handlers.onToggleAiChat;
    const onToggleNoteTags = handlers.onToggleNoteTags;
    if (typeof onExportViewHtml !== 'function') {
        throw new Error('View context missing onExportViewHtml handler');
    }
    if (typeof onToggleTabs !== 'function') {
        throw new Error('View context missing onToggleTabs handler');
    }
    if (typeof onToggleCalendar !== 'function') {
        throw new Error('View context missing onToggleCalendar handler');
    }
    if (typeof onToggleAiChat !== 'function') {
        throw new Error('View context missing onToggleAiChat handler');
    }
    if (typeof onToggleNoteTags !== 'function') {
        throw new Error('View context missing onToggleNoteTags handler');
    }
    if (typeof context.areTabsVisible !== 'boolean') {
        throw new Error('View context missing areTabsVisible boolean');
    }
    if (typeof context.isCalendarVisible !== 'boolean') {
        throw new Error('View context missing isCalendarVisible boolean');
    }
    if (typeof context.isAiChatVisible !== 'boolean') {
        throw new Error('View context missing isAiChatVisible boolean');
    }
    if (typeof context.areNoteTagsVisible !== 'boolean') {
        throw new Error('View context missing areNoteTagsVisible boolean');
    }

    const items = [
        {
            id: 'toggle-ai-chat',
            label: context.isAiChatVisible ? 'Hide Chat' : 'Show Chat',
            icon: 'chat',
            enabled: true,
            onSelect: () => onToggleAiChat(!context.isAiChatVisible),
        },
        {
            id: 'toggle-tabs',
            label: context.areTabsVisible ? 'Hide Tabs' : 'Show Tabs',
            enabled: true,
            onSelect: () => onToggleTabs(!context.areTabsVisible),
        },
        {
            id: 'toggle-calendar-view',
            label: context.isCalendarVisible ? 'Hide Calendar View' : 'Show Calendar View',
            enabled: true,
            onSelect: () => onToggleCalendar(!context.isCalendarVisible),
        },
        {
            id: 'toggle-note-tags',
            label: context.areNoteTagsVisible ? 'Hide Tags in List' : 'Show Tags in List',
            enabled: true,
            onSelect: () => onToggleNoteTags(!context.areNoteTagsVisible),
        },
        {
            id: 'export-view-html',
            label: 'Export View as HTML',
            icon: 'download',
            enabled: true,
            separated: true,
            onSelect: () => onExportViewHtml(),
        },
    ];
    if (context.canAddNoteAtTop === true) {
        if (typeof onAddNoteAtTop !== 'function') {
            throw new Error('Non-editing view context missing onAddNoteAtTop handler');
        }
        items.splice(1, 0, {
            id: 'add-note-at-top',
            label: 'Add Note at Top',
            enabled: true,
            onSelect: () => onAddNoteAtTop(),
        });
    }
    return items;
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
