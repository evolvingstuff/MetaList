import { ApplicationState } from './application-state.js';
import {
    initSelectionTracking,
    setActiveEditable,
    clearActiveEditable,
    selectionInsideActiveEditable,
    getSavedRangeClone,
    getActiveEditable,
} from './editor-selection.js';
import {
    toggleBold,
    toggleItalic,
    toggleUnderline,
    toggleInlineCode,
    toggleBlockQuote,
    toggleHeading,
    toggleBulletList,
    toggleOrderedList,
    getActiveBlockTag,
} from './editor-commands.js';

const moduleState = ApplicationState.createFields('editor-toolbar', {
    toolbarElement: null,
    isVisible: false,
    initialized: false,
});


const COMMAND_HANDLERS = {
    bold: () => toggleBold(),
    italic: () => toggleItalic(),
    underline: () => toggleUnderline(),
    'inline-code': () => toggleInlineCode(),
    blockquote: () => toggleBlockQuote(),
    heading: (value) => {
        if (typeof value !== 'string' || value.length === 0) {
            throw new Error('heading command requires a value');
        }
        toggleHeading(value);
    },
    'bullet-list': () => toggleBulletList(),
    'ordered-list': () => toggleOrderedList(),
};

function findAncestorMatching(node, predicate, stopNode) {
    let current = node instanceof Node ? node : null;
    while (current && current !== stopNode) {
        if (predicate(current)) {
            return current;
        }
        current = current.parentNode;
    }
    return null;
}

function isInlineCodeActive() {
    const editable = getActiveEditable();
    if (!editable) {
        return false;
    }
    const savedRange = getSavedRangeClone();
    const selection = document.getSelection();
    let range = savedRange;
    if (!range) {
        range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    }
    if (!range) {
        return false;
    }
    const codeNode = findAncestorMatching(
        range.startContainer,
        (node) => node.nodeName === 'CODE',
        editable.parentElement
    );
    return Boolean(codeNode);
}

function queryCommandStateSafe(command) {
    return document.queryCommandState(command);
}

function updateButtonStates() {
    if (!moduleState.toolbarElement || !moduleState.isVisible) {
        return;
    }

    const blockTag = getActiveBlockTag();

    moduleState.toolbarElement.querySelectorAll('button[data-command]').forEach((button) => {
        const command = button.dataset.command;
        const value = button.dataset.value;
        let active = false;

        switch (command) {
            case 'bold':
                active = queryCommandStateSafe('bold');
                break;
            case 'italic':
                active = queryCommandStateSafe('italic');
                break;
            case 'underline':
                active = queryCommandStateSafe('underline');
                break;
            case 'inline-code':
                active = isInlineCodeActive();
                break;
            case 'blockquote':
                active = blockTag === 'BLOCKQUOTE';
                break;
            case 'heading':
                active = blockTag === String(value).toUpperCase();
                break;
            case 'bullet-list':
                active = queryCommandStateSafe('insertUnorderedList');
                break;
            case 'ordered-list':
                active = queryCommandStateSafe('insertOrderedList');
                break;
            default:
                active = false;
        }

        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.dataset.active = active ? 'true' : 'false';
    });
}

function handleToolbarClick(event) {
    const button = event.target.closest('button[data-command]');
    if (!button) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const command = button.dataset.command;
    const value = typeof button.dataset.value === 'string' ? button.dataset.value : null;
    const handler = COMMAND_HANDLERS[command];
    if (!handler) {
        console.warn('Unknown toolbar command', command);
        return;
    }
    handler(value);
    updateButtonStates();
}

function handleSelectionChange() {
    if (!moduleState.isVisible || !moduleState.toolbarElement) {
        return;
    }
    if (selectionInsideActiveEditable()) {
        updateButtonStates();
    }
}

export function initEditorToolbar() {
    if (moduleState.initialized) {
        return;
    }
    // The current template deliberately omits the optional rich-text toolbar.
    const toolbar = document.getElementById('rich-text-toolbar');
    if (toolbar === null) return;
    moduleState.toolbarElement = toolbar;
    initSelectionTracking();
    moduleState.toolbarElement.addEventListener('mousedown', (event) => {
        event.preventDefault();
    });
    moduleState.toolbarElement.addEventListener('touchstart', (event) => {
        event.preventDefault();
    }, { passive: false });
    moduleState.toolbarElement.addEventListener('click', handleToolbarClick);
    document.addEventListener('selectionchange', handleSelectionChange, true);
    moduleState.toolbarElement.setAttribute('aria-hidden', 'true');
    moduleState.toolbarElement.style.pointerEvents = 'none';
    moduleState.initialized = true;
}

export function setToolbarVisible(visible) {
    if (!moduleState.toolbarElement) {
        return;
    }
    moduleState.isVisible = Boolean(visible);
    moduleState.toolbarElement.classList.toggle('visible', moduleState.isVisible);
    moduleState.toolbarElement.setAttribute('aria-hidden', moduleState.isVisible ? 'false' : 'true');
    moduleState.toolbarElement.style.pointerEvents = moduleState.isVisible ? 'auto' : 'none';
    if (moduleState.isVisible) {
        updateButtonStates();
    }
}

export function attachEditorSurface(noteId, editableElement) {
    if (!editableElement) {
        throw new Error('Editable element is required for toolbar attach');
    }
    if (getActiveEditable() !== editableElement) setActiveEditable(noteId, editableElement);
    if (moduleState.isVisible) {
        updateButtonStates();
    }
}

export function detachEditorSurface() {
    if (getActiveEditable() === null) return;
    clearActiveEditable();
}

export function refreshToolbarState() {
    updateButtonStates();
}
