import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { NotesAPI } from '../../api-client.js';
import { DOMUtils } from '../../dom-utils.js';
import { CONFIG } from '../../config.js';
import { ErrorHandler } from '../../error-handler.js';
import { getTagBarValue, markTagBarSaved, setTagBarValue } from '../services/tag-bar-service.js';
import { scrollWindowToYFastAnimated } from '../services/animated-scroll-service.js';
import { isRootReorderLocked } from '../services/root-sort-service.js';
import { blockRootNoteCreation } from '../services/root-note-creation-service.js';
import { selectSplitSegmentHtmls } from '../services/note-split-service.js';
import { sanitizeNoteHtmlForStorage } from '../../note-html-sanitizer.js';
import { scrollNoteIntoView, scheduleScrollNoteIntoView } from '../services/scroll-restoration-service.js';
import { captureViewportRoot } from '../services/viewport-hold-service.js';
import { exitEditingBeforeTodoToggle } from '../services/todo-toggle-editing-service.js';
import { shouldExitEditingBeforeCollapseToggle } from '../services/collapse-editing-policy-service.js';
import { shouldMarkExpandedEditSession } from '../services/edit-session-collapse-policy-service.js';
import { resolveNotePasteResponse } from '../services/clipboard-shortcut-policy-service.js';
import {
    recordNoteInteractionIfNew,
    recordStructuralNoteInteractionIfMoved,
} from '../services/search-interaction-service.js';
import {
    removeFormattingFromSelectedRange,
    resolveActiveFormattingRemovalRange,
    restoreFormattingRemovalSelection,
} from '../services/selected-formatting-removal-service.js';
import { actionSaveNote } from './content-actions.js';
import { actionDeselectNote, actionSaveAndExitEditingWithoutRefreshing, actionSwitchNotes, actionSelectNote } from './selection-actions.js';
import { actionRefreshAndMaybeSelect } from './ui-actions.js';

function hideCaretAfterProgrammaticEdit() {
    // Repeated structural commands can run while the caret is already hidden from the first command.
    if (!ModeContext.isCaretHidden) {
        ModeContext.markCaretHidden();
    }
}

function getFirstTextNode(fragment) {
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT, null);
    return walker.nextNode();
}

function getLastTextNode(fragment) {
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT, null);
    let lastNode = null;
    let currentNode = walker.nextNode();
    while (currentNode) {
        lastNode = currentNode;
        currentNode = walker.nextNode();
    }
    return lastNode;
}

function isWhitespaceOnlyTextNode(node) {
    if (!(node instanceof Text)) {
        return false;
    }
    const normalized = node.data.replace(/\u00A0/g, ' ');
    return normalized.trim().length === 0;
}

function hasNonTextRenderableContent(element) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }
    return Boolean(
        element.querySelector('img,video,audio,iframe,svg,math,canvas,input,textarea,button,table,hr')
    );
}

function isVisuallyEmptyElement(node) {
    if (!(node instanceof HTMLElement)) {
        return false;
    }
    const tagName = node.tagName.toLowerCase();
    if (tagName === 'br') {
        return true;
    }
    if (hasNonTextRenderableContent(node)) {
        return false;
    }
    const normalizedText = node.textContent ? node.textContent.replace(/\u00A0/g, ' ') : '';
    return normalizedText.trim().length === 0;
}

function scheduleMovedNoteIntoView(noteId) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('scheduleMovedNoteIntoView requires a non-empty noteId');
    }
    scheduleScrollNoteIntoView(noteId, {
        scrollOptions: {
            align: 'nearest',
        },
    });
}

function removeCachedHashesForDomSubtree(noteId) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('removeCachedHashesForDomSubtree requires noteId string');
    }

    // The cache holds only what the last view rendered, so a note on screen may
    // have no entry (the differential view forgets entries the same way).
    const forgetCachedHash = (id) => {
        if (ModeContext.hasNoteHash(id)) {
            ModeContext.removeNoteHash(id);
        }
    };
    const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
    if (!noteElement) {
        forgetCachedHash(noteId);
        return;
    }

    forgetCachedHash(noteId);
    const descendantElements = noteElement.querySelectorAll('[data-note-id]');
    descendantElements.forEach((element) => {
        const descendantId = element.dataset.noteId;
        if (typeof descendantId !== 'string' || descendantId.length === 0) {
            throw new Error('Deleted subtree descendant missing note id');
        }
        forgetCachedHash(descendantId);
    });
}

function shouldBlockRootReorder(noteId, contextLabel) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('shouldBlockRootReorder requires noteId string');
    }

    if (!isRootReorderLocked(ModeContext.activeTabSortMode)) {
        return false;
    }

    const noteElement = DOMUtils.getNoteById(noteId);
    const parentId = typeof noteElement.dataset.parentId === 'string' ? noteElement.dataset.parentId : '';
    if (parentId.length > 0) {
        return false;
    }

    Logger.logNoop('Root reorder blocked by active sort mode', {
        noteId,
        context: contextLabel,
        sortMode: ModeContext.activeTabSortMode,
    });
    ErrorHandler.showInfoBanner(
        'Root-note reordering is disabled while a sort order is active.',
        5000,
    );
    return true;
}

function isRootNoteId(noteId) {
    const noteElement = DOMUtils.getNoteById(noteId);
    return !(typeof noteElement.dataset.parentId === 'string' && noteElement.dataset.parentId.length > 0);
}

function stripEdgeEmptyNodes(fragment) {
    while (fragment.firstChild) {
        const firstChild = fragment.firstChild;
        if (isWhitespaceOnlyTextNode(firstChild) || isVisuallyEmptyElement(firstChild)) {
            fragment.removeChild(firstChild);
            continue;
        }
        break;
    }

    while (fragment.lastChild) {
        const lastChild = fragment.lastChild;
        if (isWhitespaceOnlyTextNode(lastChild) || isVisuallyEmptyElement(lastChild)) {
            fragment.removeChild(lastChild);
            continue;
        }
        break;
    }
}

function trimLeadingWhitespaceFromFragment(fragment) {
    while (true) {
        const firstTextNode = getFirstTextNode(fragment);
        if (!firstTextNode) {
            return;
        }
        const trimmed = firstTextNode.data.replace(/^\s+/, '');
        if (trimmed.length === 0) {
            const parentNode = firstTextNode.parentNode;
            if (!parentNode) {
                throw new Error('Text node missing parent during leading-trim');
            }
            parentNode.removeChild(firstTextNode);
            continue;
        }
        firstTextNode.data = trimmed;
        return;
    }
}

function trimTrailingWhitespaceFromFragment(fragment) {
    while (true) {
        const lastTextNode = getLastTextNode(fragment);
        if (!lastTextNode) {
            return;
        }
        const trimmed = lastTextNode.data.replace(/\s+$/, '');
        if (trimmed.length === 0) {
            const parentNode = lastTextNode.parentNode;
            if (!parentNode) {
                throw new Error('Text node missing parent during trailing-trim');
            }
            parentNode.removeChild(lastTextNode);
            continue;
        }
        lastTextNode.data = trimmed;
        return;
    }
}

function fragmentToHtml(fragment) {
    const container = document.createElement('div');
    container.appendChild(fragment);
    return container.innerHTML;
}

function normalizeRangeToSplitSegment(range) {
    if (!(range instanceof Range)) {
        throw new Error('normalizeRangeToSplitSegment requires Range');
    }

    const fragment = range.cloneContents();
    stripEdgeEmptyNodes(fragment);
    trimLeadingWhitespaceFromFragment(fragment);
    trimTrailingWhitespaceFromFragment(fragment);

    const text = typeof fragment.textContent === 'string' ? fragment.textContent : '';
    const html = fragmentToHtml(fragment);
    return {
        html,
        hasText: text.trim().length > 0,
    };
}

function buildSplitSegmentsFromSelection(contentElement) {
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('buildSplitSegmentsFromSelection requires content element');
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable while splitting note');
    }
    if (selection.rangeCount === 0) {
        return [];
    }

    const range = selection.getRangeAt(0);
    if (!contentElement.contains(range.startContainer) || !contentElement.contains(range.endContainer)) {
        return [];
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(contentElement);
    beforeRange.setEnd(range.startContainer, range.startOffset);

    const afterRange = document.createRange();
    afterRange.selectNodeContents(contentElement);
    afterRange.setStart(range.endContainer, range.endOffset);

    const candidateRanges = range.collapsed
        ? [beforeRange, afterRange]
        : [beforeRange, range.cloneRange(), afterRange];

    const normalizedSegments = [];
    for (const candidateRange of candidateRanges) {
        normalizedSegments.push(normalizeRangeToSplitSegment(candidateRange));
    }

    return selectSplitSegmentHtmls(normalizedSegments, range.collapsed);
}

export async function toggleTodoDone(noteId) {
    const startedAt = performance.now();
    Logger.logAction('toggleTodoDone', {
        noteId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        isLoading: ModeContext.isLoading
    });

    if (!noteId) {
        throw new Error('Cannot toggle todo/done: noteId is required');
    }

    await exitEditingBeforeTodoToggle({
        modeContext: ModeContext,
        noteId,
        saveAndExitEditingFn: actionSaveAndExitEditingWithoutRefreshing,
        logDebugFn: Logger.logDebug,
    });

    await NotesAPI.toggleTodo(noteId);
    await recordNoteInteractionIfNew(noteId, 'command');
    await actionRefreshAndMaybeSelect({ startedAt, context: 'toggleTodoDone' });
}

export async function addSelectedTextAsTag(noteId, selectedText) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('addSelectedTextAsTag requires noteId string');
    }
    if (typeof selectedText !== 'string' || selectedText.length === 0) {
        throw new Error('addSelectedTextAsTag requires selectedText string');
    }

    const isEditingTarget = ModeContext.isEditing && ModeContext.currentNoteId === noteId;
    if (isEditingTarget) {
        await actionSaveNote(noteId);
    }

    const response = await NotesAPI.addSelectedTextTag(noteId, selectedText);
    if (!response || typeof response !== 'object') {
        throw new Error('Add-selected-text-tag response missing body');
    }
    if (response.status !== 'added' && response.status !== 'exists') {
        throw new Error(`Unknown add-selected-text-tag status: ${response.status}`);
    }
    if (typeof response.tag !== 'string' || response.tag.length === 0) {
        throw new Error('Add-selected-text-tag response missing resolved tag');
    }
    if (typeof response.tags !== 'string') {
        throw new Error('Add-selected-text-tag response missing note tags');
    }

    if (isEditingTarget) {
        const noteElement = DOMUtils.getNoteById(noteId);
        setTagBarValue(noteElement, response.tags);
        markTagBarSaved(noteElement, response.tags);
    }

    await actionRefreshAndMaybeSelect({
        startedAt: performance.now(),
        context: 'addSelectedTextAsTag',
    });
    return response;
}

export async function runShellNote(noteId, timeoutSeconds) {
    Logger.logAction('runShellNote', {
        noteId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        isLoading: ModeContext.isLoading
    });

    if (!noteId) {
        throw new Error('Cannot run shell: noteId is required');
    }

    if (ModeContext.isEditing) {
        throw new Error(`runShellNote called while editing note ${ModeContext.currentNoteId}`);
    }

    const response = await NotesAPI.runShell(noteId, timeoutSeconds);
    await recordNoteInteractionIfNew(noteId, 'command');
    return response;
}

export async function getShellRun(noteId, runId) {
    if (!noteId) {
        throw new Error('Cannot get shell run: noteId is required');
    }
    if (!runId) {
        throw new Error('Cannot get shell run: runId is required');
    }

    return NotesAPI.getShellRun(noteId, runId);
}

export async function deleteNote(noteId) {
    const startedAt = performance.now();

    Logger.logAction('deleteNote', {
        noteId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId
    });

    if (!noteId) {
        throw new Error('Cannot delete note: noteId is required');
    }

    if (ModeContext.currentNoteId !== noteId) {
        throw new Error(`Programming error: Deleting note ${noteId}, but currentNoteId is ${ModeContext.currentNoteId}`);
    }

    if (!ModeContext.isEditing) {
        throw new Error(`Programming error: Deleting current note ${noteId}, but isEditing is false`);
    }

    ModeContext.setEditing(false);
    ModeContext.setCurrentNoteId(null);

    if (ModeContext.currentContent !== null) {
        ModeContext.setCurrentContent(null);
    }

    if (ModeContext.isDirty) {
        ModeContext.setDirty(false);
    }

    await NotesAPI.deleteNote(noteId);
    removeCachedHashesForDomSubtree(noteId);

    await actionRefreshAndMaybeSelect({ startedAt, context: 'deleteNote' });
}

export async function deleteNoteOutsideEdit(noteId) {
    const startedAt = performance.now();

    Logger.logAction('deleteNoteOutsideEdit', {
        noteId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        isLoading: ModeContext.isLoading
    });

    if (!noteId) {
        throw new Error('Cannot delete note: noteId is required');
    }

    if (ModeContext.isEditing) {
        throw new Error(`Programming error: deleteNoteOutsideEdit called while editing note ${ModeContext.currentNoteId}`);
    }

    await NotesAPI.deleteNote(noteId);
    removeCachedHashesForDomSubtree(noteId);

    if (ModeContext.currentNoteId === noteId) {
        ModeContext.setCurrentNoteId(null);
    }

    if (ModeContext.currentContent !== null) {
        ModeContext.setCurrentContent(null);
    }

    await actionRefreshAndMaybeSelect({ startedAt, context: 'deleteNoteOutsideEdit' });
}

export async function createNote() {
    const currentNoteId = ModeContext.isEditing ? ModeContext.currentNoteId : null;
    return await createNoteWithPlacement(currentNoteId === null);
}

export async function createNoteAtTop() {
    return await createNoteWithPlacement(true);
}

async function createNoteWithPlacement(placeAtTop) {
    if (typeof placeAtTop !== 'boolean') {
        throw new Error('createNoteWithPlacement requires boolean placeAtTop');
    }

    Logger.logAction('createNote', {
        currentNoteId: ModeContext.currentNoteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty,
        placeAtTop,
    });

    const currentNoteId = ModeContext.isEditing ? ModeContext.currentNoteId : null;

    // A sibling of a child note is not a root note, so the sort does not limit it.
    if (!placeAtTop && currentNoteId) {
        if (isRootNoteId(currentNoteId) && blockRootNoteCreation('below', 'createNote')) {
            return null;
        }
    } else if (blockRootNoteCreation('top', 'createNote')) {
        return null;
    }

    if (ModeContext.isEditing && ModeContext.editSessionHasEdits && currentNoteId) {
        await actionSaveNote(currentNoteId);
    }

    let data;
    if (!placeAtTop && currentNoteId) {
        Logger.logDebug('Creating new sibling note after note', {
            currentNoteId,
            searchQuery: ModeContext.searchQuery,
        }, Logger.LogCategory.DEBUG);
        data = await NotesAPI.createSibling(currentNoteId, ModeContext.searchQuery);
    } else {
        // The first loaded note is the list's first root only when the band of
        // loaded roots starts there; otherwise ask the server for the true top.
        // Editing the new note then centres the band on it.
        const firstVisibleNote = document.querySelector('.note');
        const firstVisibleNoteId = firstVisibleNote && !ModeContext.hasRootsAboveWindow()
            ? firstVisibleNote.dataset.noteId
            : '';

        Logger.logDebug('Creating new note at top of list', {
            firstVisibleNoteId,
            searchQuery: ModeContext.searchQuery,
        }, Logger.LogCategory.DEBUG);
        data = await NotesAPI.createNote(firstVisibleNoteId, ModeContext.searchQuery);
    }

    const newNoteId = data.id;
    const caretOptions = { initialCaretVisibility: 'visible' };
    if (ModeContext.isEditing) {
        await actionSwitchNotes(newNoteId, caretOptions);
    } else {
        await actionSelectNote(newNoteId, {
            ...caretOptions,
            recordEditInteraction: false,
        });
    }

    if (placeAtTop) {
        scrollWindowToYFastAnimated(0);
    }

    return newNoteId;
}

export async function createChildNote() {
    let startedAt = performance.now();

    Logger.logAction('createChildNote', {
        currentNoteId: ModeContext.currentNoteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty
    });

    const currentNoteId = ModeContext.currentNoteId;

    if (!currentNoteId) {
        Logger.logDebug('Cannot create child note: no parent note selected', {}, Logger.LogCategory.DEBUG);
        return await createNote();
    }

    if (ModeContext.isEditing && ModeContext.editSessionHasEdits && currentNoteId) {
        await actionSaveNote(currentNoteId);
    }

	    Logger.logDebug('Creating new child note under parent', { 
        parentNoteId: currentNoteId 
    }, Logger.LogCategory.DEBUG);
    
    const data = await NotesAPI.createChild(currentNoteId, ModeContext.searchQuery);
    const newNoteId = data.id;

	    const caretOptions = { initialCaretVisibility: 'visible' };
    if (ModeContext.isEditing) {
        return await actionSwitchNotes(newNoteId, caretOptions);
    } else {
        return await actionSelectNote(newNoteId, {
            ...caretOptions,
            recordEditInteraction: false,
        });
    }
}

export async function moveNoteUp(noteId) {
    let startedAt = performance.now();

    Logger.logAction('moveNoteUp', {
        noteId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        isDirty: ModeContext.isDirty
    });

    if (!noteId) {
        throw new Error('Cannot move note: noteId is required');
    }
    if (shouldBlockRootReorder(noteId, 'moveNoteUp')) {
        return;
    }

    if (ModeContext.editSessionHasEdits && noteId === ModeContext.currentNoteId) {
        await actionSaveNote(noteId);
    }

    const moveResponse = await NotesAPI.moveNoteUp(noteId);
    await recordStructuralNoteInteractionIfMoved(noteId, 'move', moveResponse);

    if (ModeContext.isEditing) {
        hideCaretAfterProgrammaticEdit();
    }

    const newContent = await actionRefreshAndMaybeSelect({startedAt: startedAt, context: 'moveNoteUp'});

    if (ModeContext.currentContent !== newContent) {
        ModeContext.setCurrentContent(newContent);
    }

    scheduleMovedNoteIntoView(noteId);
}

export async function moveNoteDown(noteId) {
    let startedAt = performance.now();

    Logger.logAction('moveNoteDown', {
        noteId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        isDirty: ModeContext.isDirty
    });

    if (!noteId) {
        throw new Error('Cannot move note: noteId is required');
    }
    if (shouldBlockRootReorder(noteId, 'moveNoteDown')) {
        return;
    }

    if (ModeContext.editSessionHasEdits && noteId === ModeContext.currentNoteId) {
        await actionSaveNote(noteId);
    }

    const moveResponse = await NotesAPI.moveNoteDown(noteId);
    await recordStructuralNoteInteractionIfMoved(noteId, 'move', moveResponse);

    if (ModeContext.isEditing) {
        hideCaretAfterProgrammaticEdit();
    }

    const newContent = await actionRefreshAndMaybeSelect({startedAt: startedAt, context: 'moveNoteDown'});

    if (ModeContext.currentContent !== newContent) {
        ModeContext.setCurrentContent(newContent);
    }

    scheduleMovedNoteIntoView(noteId);
}

export async function moveNoteToTop(noteId) {
    const startedAt = performance.now();

    Logger.logAction('moveNoteToTop', {
        noteId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        isDirty: ModeContext.isDirty,
        searchQuery: ModeContext.searchQuery,
    });

    if (!noteId) {
        throw new Error('Cannot move note to top: noteId is required');
    }
    if (shouldBlockRootReorder(noteId, 'moveNoteToTop')) {
        return;
    }

    if (ModeContext.editSessionHasEdits && noteId === ModeContext.currentNoteId) {
        await actionSaveNote(noteId);
    }

    const moveResponse = await NotesAPI.moveNoteToTop(noteId, ModeContext.searchQuery);
    await recordStructuralNoteInteractionIfMoved(noteId, 'move', moveResponse);

    if (ModeContext.isEditing) {
        hideCaretAfterProgrammaticEdit();
    }

    const newContent = await actionRefreshAndMaybeSelect({
        startedAt,
        context: 'moveNoteToTop',
    });

    if (ModeContext.currentContent !== newContent) {
        ModeContext.setCurrentContent(newContent);
    }

    scheduleMovedNoteIntoView(noteId);
}

function adjacentRootElement(rootElement, direction) {
    let sibling = direction === 'previous' ? rootElement.previousElementSibling : rootElement.nextElementSibling;
    while (sibling !== null && !sibling.classList.contains(CONFIG.CLASSES.NOTE)) {
        sibling = direction === 'previous' ? sibling.previousElementSibling : sibling.nextElementSibling;
    }
    return sibling;
}

// Move to Bottom keeps the view still (docs/ui/interaction-principles.md): the
// notes above stay where they are and the ones below close the gap. The top
// visible root normally holds still; when that root is the one leaving, the
// root above it holds instead, or, with none loaded above, the next root takes
// the leaving note's place. Null: the usual hold applies.
function moveToBottomHold(noteId) {
    const viewportRoot = captureViewportRoot();
    if (viewportRoot === null || viewportRoot.noteId !== noteId) {
        return null;
    }
    const leavingElement = DOMUtils.getNoteById(noteId);
    const previous = adjacentRootElement(leavingElement, 'previous');
    if (previous !== null) {
        return { kind: 'top', noteId: DOMUtils.getNoteId(previous), top: previous.getBoundingClientRect().top, keepVisible: false };
    }
    const next = adjacentRootElement(leavingElement, 'next');
    if (next !== null) {
        return { kind: 'top', noteId: DOMUtils.getNoteId(next), top: viewportRoot.top, keepVisible: false };
    }
    return null;
}

// After its last sibling, or after the last root the view shows. The view does
// not follow it: in a short list it is seen landing, otherwise it leaves sight.
export async function moveNoteToBottom(noteId) {
    const startedAt = performance.now();

    Logger.logAction('moveNoteToBottom', {
        noteId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        isDirty: ModeContext.isDirty,
        searchQuery: ModeContext.searchQuery,
    });

    if (!noteId) {
        throw new Error('Cannot move note to bottom: noteId is required');
    }
    if (shouldBlockRootReorder(noteId, 'moveNoteToBottom')) {
        return;
    }

    // Not left editing a note that may now be out of sight.
    if (ModeContext.isEditing && ModeContext.currentNoteId === noteId) {
        await actionSaveAndExitEditingWithoutRefreshing();
    }

    const hold = moveToBottomHold(noteId);
    const moveResponse = await NotesAPI.moveNoteToBottom(noteId, ModeContext.searchQuery);
    await recordStructuralNoteInteractionIfMoved(noteId, 'move', moveResponse);

    const refreshOptions = { startedAt, context: 'moveNoteToBottom' };
    if (hold !== null) {
        refreshOptions.viewportHold = hold;
    }
    const newContent = await actionRefreshAndMaybeSelect(refreshOptions);

    if (ModeContext.currentContent !== newContent) {
        ModeContext.setCurrentContent(newContent);
    }
}

// The screen position a dropped note lands at, as a viewport hold: the edge at
// the drop line stays on it, its top when moved up and its bottom when moved
// down (the drop line marks the sibling's top for BEFORE, its bottom for AFTER,
// with the usual gap between notes on the far side).
function dropLandingHold(noteId, siblingId, position, dragDirection) {
    const noteElement = DOMUtils.getNoteById(noteId);
    const noteRect = noteElement.getBoundingClientRect();
    const siblingRect = DOMUtils.getNoteById(siblingId).getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(noteElement).marginTop);
    if (Number.isNaN(gap)) {
        throw new Error('dropLandingHold: note margin-top is not a number');
    }
    let top;
    if (dragDirection === 'up') {
        top = position === 'BEFORE' ? siblingRect.top : siblingRect.bottom + gap;
    } else {
        const bottom = position === 'AFTER' ? siblingRect.bottom : siblingRect.top - gap;
        top = bottom - noteRect.height;
    }
    return { kind: 'top', noteId, top, keepVisible: false };
}

export async function moveNoteToSiblingPosition(noteId, siblingId, position, newParentId, dragDirection) {
    const startedAt = performance.now();

    Logger.logAction('moveNoteToSiblingPosition', {
        noteId,
        siblingId,
        position,
        newParentId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        isDirty: ModeContext.isDirty,
    });

    if (!noteId) {
        throw new Error('Cannot move note: noteId is required');
    }
    if (!siblingId) {
        throw new Error('Cannot move note: siblingId is required');
    }

    const normalizedPosition = typeof position === 'string' ? position.toUpperCase() : '';
    if (normalizedPosition !== 'BEFORE' && normalizedPosition !== 'AFTER') {
        throw new Error('Cannot move note: position must be BEFORE or AFTER');
    }

    if (newParentId !== null && newParentId !== undefined && typeof newParentId !== 'string') {
        throw new Error('Cannot move note: newParentId must be a string, null, or undefined');
    }
    if (dragDirection !== 'up' && dragDirection !== 'down') {
        throw new Error('Cannot move note: dragDirection must be up or down');
    }
    if ((newParentId === null || typeof newParentId === 'undefined') && shouldBlockRootReorder(noteId, 'moveNoteToSiblingPosition')) {
        return;
    }

    if (ModeContext.editSessionHasEdits && noteId === ModeContext.currentNoteId) {
        await actionSaveNote(noteId);
    }

    // Where the user dropped it (docs/ui/interaction-principles.md): taken before
    // the move, held through the re-render so the page does not follow the note.
    const landingHold = dropLandingHold(noteId, siblingId, normalizedPosition, dragDirection);

    const moveResponse = await NotesAPI.moveNote(noteId, siblingId, normalizedPosition, newParentId);
    await recordStructuralNoteInteractionIfMoved(noteId, 'move', moveResponse);

    if (ModeContext.isEditing) {
        hideCaretAfterProgrammaticEdit();
    }

    const newContent = await actionRefreshAndMaybeSelect({
        startedAt,
        context: 'moveNoteToSiblingPosition',
        viewportHold: landingHold,
    });

    if (ModeContext.currentContent !== newContent) {
        ModeContext.setCurrentContent(newContent);
    }

    // The note lands where it was dropped: its top at the drop line when moved
    // up, its bottom when moved down. Scroll only if that edge is hidden.
    scheduleScrollNoteIntoView(noteId, { scrollOptions: { dropEdge: dragDirection === 'up' ? 'top' : 'bottom' } });
}

export async function indentNote(noteId) {
    let startedAt = performance.now();

    Logger.logAction('indentNote', {
        noteId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        isDirty: ModeContext.isDirty
    });

    if (!noteId) {
        throw new Error('Cannot indent note: noteId is required');
    }

    const noteElement = DOMUtils.getNoteById(noteId);
    let prevElement = noteElement.previousElementSibling;
    while (prevElement && !prevElement.classList.contains(CONFIG.CLASSES.NOTE)) {
        prevElement = prevElement.previousElementSibling;
    }
    if (!prevElement) {
        Logger.logNoop('Indent shortcut ignored: no visible sibling above', {
            noteId,
            isEditing: ModeContext.isEditing
        });
        return;
    }
    const visiblePrevId = DOMUtils.getNoteId(prevElement);
    if (typeof visiblePrevId !== 'string' || visiblePrevId.length === 0) {
        throw new Error('Visible previous sibling missing note id');
    }

    if (ModeContext.editSessionHasEdits && noteId === ModeContext.currentNoteId) {
        await actionSaveNote(noteId);
    }

    const indentResponse = await NotesAPI.indentNote(noteId, visiblePrevId);
    await recordStructuralNoteInteractionIfMoved(noteId, 'indent', indentResponse);

    if (ModeContext.isEditing) {
        hideCaretAfterProgrammaticEdit();
    }

    const newContent = await actionRefreshAndMaybeSelect({startedAt: startedAt, context: 'indentNote'});

    if (ModeContext.currentContent !== newContent) {
        ModeContext.setCurrentContent(newContent);
    }
}

export async function outdentNote(noteId) {
    let startedAt = performance.now();

    Logger.logAction('outdentNote', {
        noteId,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        isDirty: ModeContext.isDirty
    });

    if (!noteId) {
        throw new Error('Cannot outdent note: noteId is required');
    }

    if (ModeContext.editSessionHasEdits && noteId === ModeContext.currentNoteId) {
        await actionSaveNote(noteId);
    }

    const outdentResponse = await NotesAPI.outdentNote(noteId, ModeContext.searchQuery);
    await recordStructuralNoteInteractionIfMoved(noteId, 'outdent', outdentResponse);

    if (ModeContext.isEditing) {
        hideCaretAfterProgrammaticEdit();
    }

    const newContent = await actionRefreshAndMaybeSelect({startedAt: startedAt, context: 'outdentNote'});

    if (ModeContext.currentContent !== newContent) {
        ModeContext.setCurrentContent(newContent);
    }
}

async function setNoteCollapse(noteId, collapsed) {
    let startedAt = performance.now();

    Logger.logAction('setNoteCollapse', {
        noteId,
        collapsed,
        isEditing: ModeContext.isEditing,
        hoveredNoteId: ModeContext.hoveredNoteId
    });

    if (!noteId) {
        throw new Error('Cannot change collapse state: noteId is required');
    }

    let isTargetInsideCurrentEditSubtree = false;
    if (ModeContext.isEditing) {
        const editingNoteId = ModeContext.currentNoteId;
        if (typeof editingNoteId !== 'string' || editingNoteId.length === 0) {
            throw new Error('Invariant violation: isEditing is true but currentNoteId is missing');
        }
        const editingNoteElement = DOMUtils.getNoteById(editingNoteId);
        const targetNoteElement = DOMUtils.getNoteById(noteId);
        isTargetInsideCurrentEditSubtree = editingNoteElement.contains(targetNoteElement);
    }

    const shouldExitEditing = shouldExitEditingBeforeCollapseToggle({
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
        targetNoteId: noteId,
        isTargetInsideCurrentEditSubtree,
        collapsed,
    });

    if (shouldExitEditing) {
        const editingNoteId = ModeContext.currentNoteId;
        if (!editingNoteId) {
            throw new Error('Invariant violation: isEditing is true but currentNoteId is null');
        }

        Logger.logDebug('Collapse toggle requires exiting edit mode first', {
            editingNoteId,
            targetNoteId: noteId,
            collapsed
        }, Logger.LogCategory.EVENT);

        await actionSaveAndExitEditingWithoutRefreshing();
    }

    if (collapsed) {
        await NotesAPI.collapseNote(noteId);
    } else {
        await NotesAPI.expandNote(noteId);
        await recordNoteInteractionIfNew(noteId, 'expand');
        if (shouldMarkExpandedEditSession({
            isEditing: ModeContext.isEditing,
            currentNoteId: ModeContext.currentNoteId,
            targetNoteId: noteId,
            expandedPersisted: ModeContext.editSessionExpandedPersisted,
        })) {
            ModeContext.markEditSessionExpandedPersisted();
        }
    }
    await actionRefreshAndMaybeSelect({ startedAt: startedAt, context: 'setNoteCollapse' });
}

// An arrow inside an embed (![[UUID]]): collapse is shared, so it collapses or
// expands that note everywhere. A note being edited is saved and left first,
// as for any arrow outside the edited note.
export async function setEmbeddedNoteCollapse(noteId, collapsed) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('setEmbeddedNoteCollapse requires noteId');
    }
    if (typeof collapsed !== 'boolean') {
        throw new Error('setEmbeddedNoteCollapse requires collapsed boolean');
    }
    const startedAt = performance.now();
    Logger.logAction('setEmbeddedNoteCollapse', { noteId, collapsed, isEditing: ModeContext.isEditing });
    if (ModeContext.isEditing) {
        await actionDeselectNote();
    }
    if (collapsed) {
        await NotesAPI.collapseNote(noteId);
    } else {
        await NotesAPI.expandNote(noteId);
    }
    await actionRefreshAndMaybeSelect({ startedAt, context: 'setEmbeddedNoteCollapse' });
}

export async function collapseNote(noteId) {
    await setNoteCollapse(noteId, true);
}

export async function expandNote(noteId) {
    await setNoteCollapse(noteId, false);
}

export async function actionCopyNoteById(noteId) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('Cannot copy note: noteId is required');
    }

    Logger.logAction('actionCopyNote', { 
        currentNoteId: ModeContext.currentNoteId,
        targetNoteId: noteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty
    });

    if (ModeContext.currentNoteId === noteId && ModeContext.editSessionHasEdits) {
        await actionSaveNote(noteId);
    }

    const response = await NotesAPI.copyNote(noteId);

    return response;
}

export async function actionCopyNote() {
    const currentNoteId = ModeContext.currentNoteId;
    if (!currentNoteId) {
        throw new Error('Cannot copy note: no note selected');
    }

    return await actionCopyNoteById(currentNoteId);
}

export async function splitCurrentNoteFromSelection() {
    const currentNoteId = ModeContext.currentNoteId;
    Logger.logAction('splitCurrentNoteFromSelection', {
        currentNoteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty,
    });

    if (!ModeContext.isEditing) {
        Logger.logNoop('Split shortcut ignored: not editing');
        return false;
    }
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        Logger.logNoop('Split shortcut ignored: no active note');
        return false;
    }

    const noteElement = DOMUtils.getNoteById(currentNoteId);
    const contentElement = DOMUtils.getNoteContent(noteElement);
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('Current note missing editable content element for split');
    }

    const splitSegments = buildSplitSegmentsFromSelection(contentElement)
        .map(segment => sanitizeNoteHtmlForStorage(segment));
    if (splitSegments.length <= 1) {
        Logger.logNoop('Split shortcut ignored: selection/caret produced no split', {
            segmentCount: splitSegments.length,
        });
        return false;
    }
    if (isRootNoteId(currentNoteId) && blockRootNoteCreation('below', 'splitNote')) {
        return false;
    }

    if (!ModeContext.editSessionHasEdits) ModeContext.markEditSessionHasEdits();
    const tags = getTagBarValue(noteElement);
    await NotesAPI.splitNote(currentNoteId, splitSegments, tags);

    const startedAt = performance.now();
    const refreshedContent = await actionRefreshAndMaybeSelect({
        startedAt,
        context: 'splitCurrentNoteFromSelection',
    });
    if (typeof refreshedContent === 'string' && ModeContext.currentContent !== refreshedContent) {
        ModeContext.setCurrentContent(refreshedContent);
    }

    if (ModeContext.isDirty) {
        ModeContext.setDirty(false);
    }
    // Split refresh can leave the first segment equal to the content already marked saved.
    if (ModeContext.lastSavedContent !== splitSegments[0]) {
        ModeContext.setLastSavedContent(splitSegments[0]);
    }

    return true;
}

// The range to unformat: the one the menu was opened on, else the note's active selection.
function selectionToUnformat(selectedTextRange, noteContent) {
    if (selectedTextRange === null) {
        return resolveActiveFormattingRemovalRange(noteContent);
    }
    return selectedTextRange;
}

export async function unformatCurrentNoteContent(selectedTextRange) {
    if (selectedTextRange !== null && !(selectedTextRange instanceof Range)) {
        throw new Error('unformatCurrentNoteContent selection must be Range or null');
    }
    const currentNoteId = ModeContext.currentNoteId;
    Logger.logAction('unformatCurrentNoteContent', {
        currentNoteId,
        isEditing: ModeContext.isEditing,
        isDirty: ModeContext.isDirty,
    });

    if (!ModeContext.isEditing) {
        Logger.logNoop('Unformat shortcut ignored: not editing');
        return false;
    }
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        Logger.logNoop('Unformat shortcut ignored: no active note');
        return false;
    }

    if (ModeContext.editSessionHasEdits) {
        await actionSaveNote(currentNoteId);
    }

    const noteElement = DOMUtils.getNoteById(currentNoteId);
    const noteContent = noteElement.querySelector('.note-content');
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error(`Unformat note content element missing: ${currentNoteId}`);
    }
    const activeSelection = selectionToUnformat(selectedTextRange, noteContent);
    if (activeSelection instanceof Range && !activeSelection.collapsed) {
        const selectedResult = removeFormattingFromSelectedRange(
            noteElement,
            noteContent,
            activeSelection,
        );
        if (!selectedResult.changed) {
            Logger.logNoop('Remove Formatting selection already has no removable formatting');
            return false;
        }

        const updatedContent = noteContent.innerHTML;
        if (updatedContent !== ModeContext.currentContent) {
            ModeContext.setCurrentContent(updatedContent);
        }
        if (!ModeContext.editSessionHasEdits) ModeContext.markEditSessionHasEdits();
        if (!ModeContext.isDirty) {
            ModeContext.setDirty(true);
        }
        await actionSaveNote(currentNoteId);
        restoreFormattingRemovalSelection(
            noteContent,
            selectedResult.selectionStart,
            selectedResult.selectionEnd,
        );
        return true;
    }

    const response = await NotesAPI.unformatNote(currentNoteId);
    if (response && response.status === 'noop') {
        Logger.logNoop('Remove Formatting ignored: note already has no removable formatting');
        return false;
    }

    if (!ModeContext.editSessionHasEdits) ModeContext.markEditSessionHasEdits();

    const startedAt = performance.now();
    const refreshedContent = await actionRefreshAndMaybeSelect({
        startedAt,
        context: 'unformatCurrentNoteContent',
    });
    if (typeof refreshedContent === 'string' && ModeContext.currentContent !== refreshedContent) {
        ModeContext.setCurrentContent(refreshedContent);
        // Unformat refresh can return content already saved by a pre-operation save.
        if (ModeContext.lastSavedContent !== refreshedContent) {
            ModeContext.setLastSavedContent(refreshedContent);
        }
    }

    if (ModeContext.isDirty) {
        ModeContext.setDirty(false);
    }

    return true;
}

export async function toggleReferenceModeForNote(hostNoteId, referenceNoteId, occurrenceIndex, mode) {
    const startedAt = performance.now();
    Logger.logAction('toggleReferenceModeForNote', {
        hostNoteId,
        referenceNoteId,
        occurrenceIndex,
        mode,
        isEditing: ModeContext.isEditing,
        currentNoteId: ModeContext.currentNoteId,
    });

    if (typeof hostNoteId !== 'string' || hostNoteId.length === 0) {
        throw new Error('Cannot toggle reference mode: hostNoteId is required');
    }
    if (typeof referenceNoteId !== 'string' || referenceNoteId.length === 0) {
        throw new Error('Cannot toggle reference mode: referenceNoteId is required');
    }
    if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
        throw new Error('Cannot toggle reference mode: occurrenceIndex must be a non-negative integer');
    }
    if (mode !== 'embed' && mode !== 'link') {
        throw new Error('Cannot toggle reference mode: mode must be embed|link');
    }
    if (ModeContext.isEditing) {
        throw new Error('toggleReferenceModeForNote must not run while editing');
    }

    await NotesAPI.toggleReferenceMode(hostNoteId, referenceNoteId, occurrenceIndex, mode);
    const refreshedContent = await actionRefreshAndMaybeSelect({
        startedAt,
        context: 'toggleReferenceModeForNote',
    });
    if (typeof refreshedContent === 'string' && ModeContext.currentContent !== refreshedContent) {
        ModeContext.setCurrentContent(refreshedContent);
    }
}

// Pastes below the edited note (or into it, when it is empty with no children)
// what requestPaste(targetNoteId) puts there: the copied note, or its reference.
async function pasteAsSibling(actionName, requestPaste) {
    const currentNoteId = ModeContext.currentNoteId;

    Logger.logAction(actionName, {
        currentNoteId,
        isEditing: ModeContext.isEditing
    });

    if (!ModeContext.isEditing || !currentNoteId) {
        throw new Error('Cannot paste sibling: no note selected');
    }
    // Pasting onto an empty note without children fills it instead (the server
    // rule), which adds no root note.
    const targetElement = DOMUtils.getNoteById(currentNoteId);
    const targetIsEmpty = DOMUtils.getNoteContent(targetElement).textContent.trim() === ''
        && targetElement.querySelector('.note') === null;
    if (!targetIsEmpty && isRootNoteId(currentNoteId) && blockRootNoteCreation('below', 'pasteNoteSibling')) {
        return false;
    }

    if (ModeContext.editSessionHasEdits) {
        await actionSaveNote(currentNoteId);
    }

	    const response = await requestPaste(currentNoteId);

    const newNoteId = resolveNotePasteResponse(response);
    if (newNoteId === null) {
        ErrorHandler.showErrorBanner(
            'The copied note is no longer available. Copy it again, then paste.',
            'error',
            6000,
            true,
        );
        return false;
    }

    if (newNoteId === currentNoteId) {
        const startedAt = performance.now();
        const newContent = await actionRefreshAndMaybeSelect({ startedAt, context: 'pasteNoteSiblingInto' });
        if (ModeContext.currentContent !== newContent && newContent !== null) {
            ModeContext.setCurrentContent(newContent);
        }
        // The server recorded this paste; the refreshed editor has no local edits.
        ModeContext.resetEditSessionState({ startedCollapsed: false });
        window.requestAnimationFrame(() => {
            scrollNoteIntoView(newNoteId, {});
        });
        return true;
    }

    await actionSwitchNotes(newNoteId, { initialCaretVisibility: 'hidden' });
    window.requestAnimationFrame(() => {
        scrollNoteIntoView(newNoteId, {});
    });
    return true;
}


// Pastes as the edited note's first child what requestPaste(targetNoteId) puts there.
async function pasteAsChild(actionName, requestPaste) {
    const currentNoteId = ModeContext.currentNoteId;
    
    Logger.logAction(actionName, { 
        currentNoteId,
        isEditing: ModeContext.isEditing
    });

    if (!ModeContext.isEditing || !currentNoteId) {
        throw new Error('Cannot paste child: no note selected');
    }

    if (ModeContext.editSessionHasEdits) {
        await actionSaveNote(currentNoteId);
    }

	    const response = await requestPaste(currentNoteId);

    const newNoteId = resolveNotePasteResponse(response);
    if (newNoteId === null) {
        ErrorHandler.showErrorBanner(
            'The copied note is no longer available. Copy it again, then paste.',
            'error',
            6000,
            true,
        );
        return false;
    }

    await actionSwitchNotes(newNoteId, { initialCaretVisibility: 'hidden' });
    window.requestAnimationFrame(() => {
        scrollNoteIntoView(newNoteId, {});
    });
    return true;
}

export async function actionPasteNoteSibling() {
    return pasteAsSibling('actionPasteNoteSibling', (targetNoteId) => NotesAPI.pasteNoteSibling(targetNoteId));
}

export async function actionPasteNoteChild() {
    return pasteAsChild('actionPasteNoteChild', (targetNoteId) => NotesAPI.pasteNoteChild(targetNoteId));
}

// ⌘R / Paste Sibling Reference: the copied note's reference, where ⌘V puts the note.
export async function actionPasteReferenceSibling(referenceNoteId) {
    return pasteAsSibling('actionPasteReferenceSibling',
        (targetNoteId) => NotesAPI.pasteReferenceSibling(targetNoteId, referenceNoteId));
}

// ⇧⌘R / Paste Child Reference: the copied note's reference, where ⇧⌘V puts the note.
export async function actionPasteReferenceChild(referenceNoteId) {
    return pasteAsChild('actionPasteReferenceChild',
        (targetNoteId) => NotesAPI.pasteReferenceChild(targetNoteId, referenceNoteId));
}
