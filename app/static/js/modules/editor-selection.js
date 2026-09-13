import { ApplicationState } from './application-state.js';
const moduleState = ApplicationState.createFields('editor-selection', {
    activeEditableElement: null,
    activeNoteId: null,
    savedRange: null,
    trackingInitialized: false,
});


function isNodeInsideActiveEditable(node) {
    if (!node || !moduleState.activeEditableElement) {
        return false;
    }
    return moduleState.activeEditableElement.contains(node);
}

function handleSelectionChange() {
    if (!moduleState.activeEditableElement) {
        if (moduleState.savedRange !== null) moduleState.savedRange = null;
        return;
    }

    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
        if (moduleState.savedRange !== null) moduleState.savedRange = null;
        return;
    }

    const range = selection.getRangeAt(0);
    if (isNodeInsideActiveEditable(range.startContainer)) {
        moduleState.savedRange = range.cloneRange();
    }
}

function createCollapsedRangeAtEnd() {
    if (!moduleState.activeEditableElement) {
        return null;
    }
    const range = document.createRange();
    range.selectNodeContents(moduleState.activeEditableElement);
    range.collapse(false);
    return range;
}

export function initSelectionTracking() {
    if (moduleState.trackingInitialized) {
        return;
    }
    document.addEventListener('selectionchange', handleSelectionChange, true);
    moduleState.trackingInitialized = true;
}

export function setActiveEditable(noteId, element) {
    if (typeof element === 'undefined') {
        throw new Error('setActiveEditable requires element (use null to clear)');
    }
    if (element && !(element instanceof HTMLElement)) {
        throw new Error('Active editable element must be an HTMLElement');
    }
    const nextNoteId = element ? noteId : null;
    if (moduleState.activeEditableElement === element && moduleState.activeNoteId === nextNoteId) {
        throw new Error('Redundant state change: active editable');
    }
    if (moduleState.activeEditableElement !== element) moduleState.activeEditableElement = element;
    if (moduleState.activeNoteId !== nextNoteId) moduleState.activeNoteId = nextNoteId;
    if (moduleState.savedRange !== null) moduleState.savedRange = null;
}

export function clearActiveEditable() {
    moduleState.activeEditableElement = null;
    moduleState.activeNoteId = null;
    if (moduleState.savedRange !== null) moduleState.savedRange = null;
}

export function getActiveEditable() {
    return moduleState.activeEditableElement;
}

export function getActiveNoteId() {
    return moduleState.activeNoteId;
}

export function restoreSelection() {
    if (!moduleState.activeEditableElement) {
        return false;
    }
    const selection = document.getSelection();
    if (!selection) {
        return false;
    }
    selection.removeAllRanges();
    const rangeToRestore = moduleState.savedRange ? moduleState.savedRange.cloneRange() : createCollapsedRangeAtEnd();
    if (!rangeToRestore) {
        return false;
    }
    selection.addRange(rangeToRestore);
    return Boolean(moduleState.savedRange);
}

export function captureSelectionSnapshot() {
    handleSelectionChange();
}

export function getSavedRangeClone() {
    return moduleState.savedRange ? moduleState.savedRange.cloneRange() : null;
}

export function selectionInsideActiveEditable() {
    if (!moduleState.activeEditableElement) {
        return false;
    }
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return false;
    }
    const range = selection.getRangeAt(0);
    return isNodeInsideActiveEditable(range.startContainer);
}
