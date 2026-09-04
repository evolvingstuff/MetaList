import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { NotesAPI } from '../../api-client.js';
import { DOMUtils } from '../../dom-utils.js';
import { CONFIG } from '../../config.js';
import { detachEditorSurface } from '../../editor-toolbar.js';
import { ErrorHandler } from '../../error-handler.js';
import { clearTagBar, getTagBarValue, setTagBarValue } from '../services/tag-bar-service.js';
import { scrollWindowToYFastAnimated } from '../services/animated-scroll-service.js';
import { isRootReorderLocked } from '../services/root-sort-service.js';
import { selectSplitSegmentHtmls } from '../services/note-split-service.js';
import { sanitizeNoteHtmlForStorage } from '../../note-html-sanitizer.js';
import { scrollNoteIntoView, scheduleScrollNoteIntoView } from '../services/scroll-restoration-service.js';
import { exitEditingBeforeTodoToggle } from '../services/todo-toggle-editing-service.js';
import { shouldExitEditingBeforeCollapseToggle } from '../services/collapse-editing-policy-service.js';
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
import { actionSaveAndExitEditingWithoutRefreshing, actionSwitchNotes, actionSelectNote } from './selection-actions.js';
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

    const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
    if (!noteElement) {
        ModeContext.removeNoteHash(noteId);
        return;
    }

    ModeContext.removeNoteHash(noteId);
    const descendantElements = noteElement.querySelectorAll('[data-note-id]');
    descendantElements.forEach((element) => {
        const descendantId = element.dataset.noteId;
        if (typeof descendantId !== 'string' || descendantId.length === 0) {
            throw new Error('Deleted subtree descendant missing note id');
        }
        ModeContext.removeNoteHash(descendantId);
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
        const firstVisibleNote = document.querySelector('.note');
        const firstVisibleNoteId = firstVisibleNote ? firstVisibleNote.dataset.noteId : '';

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

export async function moveNoteToSiblingPosition(noteId, siblingId, position, newParentId) {
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
    if ((newParentId === null || typeof newParentId === 'undefined') && shouldBlockRootReorder(noteId, 'moveNoteToSiblingPosition')) {
        return;
    }

    if (ModeContext.editSessionHasEdits && noteId === ModeContext.currentNoteId) {
        await actionSaveNote(noteId);
    }

    const moveResponse = await NotesAPI.moveNote(noteId, siblingId, normalizedPosition, newParentId);
    await recordStructuralNoteInteractionIfMoved(noteId, 'move', moveResponse);

    if (ModeContext.isEditing) {
        hideCaretAfterProgrammaticEdit();
    }

    const newContent = await actionRefreshAndMaybeSelect({
        startedAt,
        context: 'moveNoteToSiblingPosition',
    });

    if (ModeContext.currentContent !== newContent) {
        ModeContext.setCurrentContent(newContent);
    }

    scheduleMovedNoteIntoView(noteId);
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
    });

    if (shouldExitEditing) {
        const editingNoteId = ModeContext.currentNoteId;
        if (!editingNoteId) {
            throw new Error('Invariant violation: isEditing is true but currentNoteId is null');
        }

        Logger.logDebug('Collapse toggle clicked outside current edit subtree; exiting edit mode first', {
            editingNoteId,
            targetNoteId: noteId,
            collapsed
        }, Logger.LogCategory.EVENT);

        if (ModeContext.editSessionHasEdits) {
            await actionSaveNote(editingNoteId);
        }

        const editingNoteElement = DOMUtils.getNoteById(editingNoteId);
        DOMUtils.setNoteEditable(editingNoteElement, false);
        DOMUtils.revealCaret(editingNoteElement);
        detachEditorSurface();
        clearTagBar();

        ModeContext.setEditing(false);
        ModeContext.setCurrentNoteId(null);
        if (ModeContext.currentContent !== null) {
            ModeContext.setCurrentContent(null);
        }
    }

    if (collapsed) {
        await NotesAPI.collapseNote(noteId);
    } else {
        await NotesAPI.expandNote(noteId);
        await recordNoteInteractionIfNew(noteId, 'expand');
        if (ModeContext.isEditing && ModeContext.currentNoteId === noteId) {
            ModeContext.markEditSessionExpandedPersisted();
        }
    }
    await actionRefreshAndMaybeSelect({ startedAt: startedAt, context: 'setNoteCollapse' });
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

    ModeContext._requestStartedAt = performance.now();

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

    ModeContext.markEditSessionHasEdits();
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
    const activeSelection = selectedTextRange === null
        ? resolveActiveFormattingRemovalRange(noteContent)
        : selectedTextRange;
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
        ModeContext.markEditSessionHasEdits();
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

    ModeContext.markEditSessionHasEdits();

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

export async function actionPasteNoteSibling() {
    const currentNoteId = ModeContext.currentNoteId;

    Logger.logAction('actionPasteNoteSibling', {
        currentNoteId,
        isEditing: ModeContext.isEditing
    });

    if (!ModeContext.isEditing || !currentNoteId) {
        throw new Error('Cannot paste sibling: no note selected');
    }

    if (ModeContext.editSessionHasEdits) {
        await actionSaveNote(currentNoteId);
    }

	    const response = await NotesAPI.pasteNoteSibling(currentNoteId);

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
        ModeContext.markEditSessionHasEdits();
        const startedAt = performance.now();
        const newContent = await actionRefreshAndMaybeSelect({ startedAt, context: 'pasteNoteSiblingInto' });
        if (ModeContext.currentContent !== newContent && newContent !== null) {
            ModeContext.setCurrentContent(newContent);
        }
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

export async function actionPasteNoteChild() {
    const currentNoteId = ModeContext.currentNoteId;
    
    Logger.logAction('actionPasteNoteChild', { 
        currentNoteId,
        isEditing: ModeContext.isEditing
    });

    if (!ModeContext.isEditing || !currentNoteId) {
        throw new Error('Cannot paste child: no note selected');
    }

    if (ModeContext.editSessionHasEdits) {
        await actionSaveNote(currentNoteId);
    }

	    const response = await NotesAPI.pasteNoteChild(currentNoteId);

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
