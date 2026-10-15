import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { ApplicationState } from '../../application-state.js';
import { DOMUtils } from '../../dom-utils.js';
import { getSearchSuggestionWindowDays } from '../services/search-suggestion-windows-service.js';
import * as Logger from '../mode-logger.js';
import { actionExitSearchMode } from '../actions/search-actions.js';
import {
    actionDeselectNote,
    actionSaveAndExitEditingWithoutRefreshing,
    actionSelectNote,
    actionSwitchNotes,
} from '../actions/selection-actions.js';
import { actionSaveNote } from '../actions/content-actions.js';
import { actionRefreshAndMaybeSelect } from '../actions/ui-actions.js';
import {
    actionCopyNoteById,
    addSelectedTextAsTag,
    actionPasteNoteChild,
    actionPasteNoteSibling,
    createChildNote,
    createNote,
    createNoteAtTop,
    deleteNote,
    deleteNoteOutsideEdit,
    indentNote,
    moveNoteDown,
    moveNoteToBottom,
    moveNoteToTop,
    moveNoteUp,
    outdentNote,
    unformatCurrentNoteContent,
    actionPasteReferenceSibling,
    actionPasteReferenceChild,
} from '../actions/note-actions.js';
import { CommandGate } from '../services/command-gate-service.js';
import {
    prepareDeleteNoteContextAction,
    prepareOutlineMoveContextAction,
} from '../services/note-context-menu-action-service.js';
import { writeRenderedNoteToSystemClipboard } from '../services/note-clipboard-write-service.js';
import { downloadFileReference, insertReferenceTokenAtRange } from '../services/file-reference-service.js';
import { pasteReferenceHereRange, rememberSelectionAtRightPress } from '../services/paste-reference-here-service.js';
import { confirmRemovingReferencedNote } from '../services/referenced-note-removal-service.js';
import {
    copyImageFromContext,
    openImageInNewTabFromContext,
    resolveImageContextFromElement,
    saveImageFromContext,
    zoomImageFromContext,
} from '../services/image-context-menu-action-service.js';
import {
    copyLinkToClipboard,
    openLinkInNewTabFromContext,
    resolveLinkContextFromElement,
} from '../services/link-context-menu-action-service.js';
import {
    resolvePriorityContextMenuTarget,
    resolveReferenceContextFromElement,
} from '../services/context-menu-target-service.js';
import { OntologyModal } from '../../modals/ontology-modal.js';
import { findTagAtIndexInTagBar } from '../services/tag-syntax-service.js';
import { findSearchTagAtIndex } from '../services/search-syntax-service.js';
import { getInputCaretIndexFromPoint, isInputPointPastText } from '../../context-menu/input-caret-service.js';
import { buildContextMenuItems } from '../../context-menu/context-menu-registry.js';
import { initContextMenuService, showContextMenu } from '../../context-menu/context-menu-service.js';
import { CommandPalette } from '../../command-palette/command-palette-controller.js';
import { NotesAPI } from '../../api-client.js';
import { normalizeSelectedTextForTagAction } from '../services/selected-text-tag-service.js';
import {
    ADD_STYLE_OPTIONS,
    appendStyleTagToken,
    buildStyleApplicationPlan,
} from '../services/add-style-service.js';
import { getTagBarValue, markTagBarSaved, setTagBarValue } from '../services/tag-bar-service.js';
import { isAskingAiForTags, setAiTagSuggestionStatus } from '../services/tag-proposal-service.js';
import { AiApiError, loadNoteTagSuggestionAvailability, requestNoteTagSuggestions } from '../../ai-chat/ai-chat-api.js';
import { ErrorHandler } from '../../error-handler.js';
import { printNotes } from '../services/print-service.js';
import { exportNotes } from '../services/export-service.js';
import { openNoteFullscreen } from '../services/note-fullscreen-service.js';
import { openFloatingNote } from '../services/floating-note-service.js';
import { createBlankSearchContextFromHover, openReferenceInNewTab, pasteCopiedNoteIntoNewTopNote } from './keyboard-events.js';
import { actionRedo, actionUndo } from '../actions/history-actions.js';
import { hasRootsBelowLoadedWindow } from '../services/infinite-scroll-service.js';
import { isRootReorderLocked } from '../services/root-sort-service.js';
import { addDiagramToNote, openDiagramEditor } from '../../excalidraw/excalidraw-actions.js';
import { unlessDiagramEditorOpen } from '../../excalidraw/excalidraw-editor-state.js';

const ontologyModal = new OntologyModal();
// Entered tags are described when right-clicked; a later right-click wins over a slower lookup.
const tagDetailsState = ApplicationState.createFields('tag-details-menu', { requestSerial: 0 });
// The edited note's menu waits for the Suggest Tags with AI check; only the latest right-click opens.
const noteMenuState = ApplicationState.createFields('note-context-menu', { requestSerial: 0 });
const ABOUT_THIS_TAG = 'About this tag';
const WHY_SUGGESTED = 'Why suggested';

async function resizeImageFromContext(imageContext, action) {
    if (imageContext === null || typeof imageContext !== 'object') {
        throw new Error('resizeImageFromContext requires imageContext object');
    }
    if (action !== 'bigger' && action !== 'smaller' && action !== 'reset') {
        throw new Error('resizeImageFromContext requires a supported action');
    }
    const hostNoteId = imageContext.hostNoteId;
    const occurrenceIndex = imageContext.occurrenceIndex;
    if (typeof hostNoteId !== 'string' || hostNoteId.length === 0) {
        throw new Error('Image resize context requires hostNoteId');
    }
    if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
        throw new Error('Image resize context requires non-negative occurrenceIndex');
    }

    if (ModeContext.isEditing && ModeContext.currentNoteId === hostNoteId) {
        await actionSaveNote(hostNoteId);
    }
    const response = await NotesAPI.resizeImage(
        hostNoteId,
        imageContext.sourceKind,
        occurrenceIndex,
        action,
    );
    if (response === null || typeof response !== 'object') {
        throw new Error('Image resize response must be an object');
    }
    if (typeof response.content !== 'string' || typeof response.tags !== 'string') {
        throw new Error('Image resize response must include content and tags');
    }
    if (ModeContext.isEditing && ModeContext.currentNoteId === hostNoteId) {
        const noteElement = document.querySelector(`.note[data-note-id="${hostNoteId}"]`);
        if (!(noteElement instanceof HTMLElement)) {
            throw new Error(`Editing note element missing after image resize: ${hostNoteId}`);
        }
        const noteContent = noteElement.querySelector('.note-content');
        if (!(noteContent instanceof HTMLElement)) {
            throw new Error(`Editing note content missing after image resize: ${hostNoteId}`);
        }
        noteContent.innerHTML = response.content;
        setTagBarValue(noteElement, response.tags);
        markTagBarSaved(noteElement, response.tags);
        if (ModeContext.currentContent !== response.content) {
            ModeContext.setCurrentContent(response.content);
        }
        if (ModeContext.lastSavedContent !== response.content) {
            ModeContext.setLastSavedContent(response.content);
        }
        if (ModeContext.isDirty) {
            ModeContext.setDirty(false);
        }
        if (!ModeContext.editSessionHasEdits) ModeContext.markEditSessionHasEdits();
        return;
    }
    await actionRefreshAndMaybeSelect({
        startedAt: performance.now(),
        context: `resizeImage.${action}`,
    });
}

// The HTML element a right-click acts on: the clicked element, or for text, math
// (MathML) and drawings (SVG, such as Mermaid diagrams) the nearest HTML element
// around it, so the note's menu opens instead of the browser's.
function resolveEventElement(target) {
    let node = target;
    if (node && node.nodeType === 3) {
        node = node.parentElement;
    }
    while (node instanceof Element && !(node instanceof HTMLElement)) {
        node = node.parentElement;
    }
    if (node instanceof HTMLElement) {
        return node;
    }
    return null;
}

function resolveTagFromSelection(rawValue, selectionStart, selectionEnd, findTagAtIndex) {
    if (!Number.isInteger(selectionStart) || !Number.isInteger(selectionEnd)) {
        return null;
    }
    if (selectionEnd <= selectionStart) {
        return null;
    }
    const selectionTag = findTagAtIndex(rawValue, selectionStart);
    if (!selectionTag) {
        return null;
    }
    if (selectionEnd <= selectionTag.end) {
        return selectionTag;
    }
    return null;
}

function resolveTagFromInput(event, input, findTagAtIndex) {
    if (!event) {
        throw new Error('resolveTagFromInput called without event');
    }
    if (!(input instanceof HTMLInputElement)) {
        throw new Error('resolveTagFromInput requires input element');
    }
    if (typeof findTagAtIndex !== 'function') {
        throw new Error('resolveTagFromInput requires findTagAtIndex function');
    }

    const rawValue = input.value;
    if (typeof rawValue !== 'string') {
        throw new Error('Input value must be string');
    }

    const selectionStart = input.selectionStart;
    const selectionEnd = input.selectionEnd;
    const selectionTag = resolveTagFromSelection(rawValue, selectionStart, selectionEnd, findTagAtIndex);
    if (selectionTag) {
        return selectionTag;
    }

    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
        throw new Error('Context menu event missing coordinates');
    }
    const clickIndex = getInputCaretIndexFromPoint(input, event.clientX);
    const clickTag = findTagAtIndex(rawValue, clickIndex);
    if (clickTag) {
        return clickTag;
    }

    if (Number.isInteger(selectionStart)) {
        return findTagAtIndex(rawValue, selectionStart);
    }

    return null;
}

async function openOntologyModalWithFocus(tag) {
    if (typeof tag !== 'string' || tag.trim() === '') {
        throw new Error('openOntologyModalWithFocus requires non-empty tag');
    }

    if (ModeContext.isLoading) {
        return;
    }

    if (Array.isArray(ModeContext.modalStack) && ModeContext.modalStack.length > 0) {
        const topModal = ModeContext.topModal;
        if (topModal !== 'ontologyModal') {
            return;
        }
    }

    if (ModeContext.isSearching) {
        actionExitSearchMode();
    }

    if (ModeContext.isEditing) {
        const result = await CommandGate.run('contextMenu.ontology.exit_editing', async () => {
            await actionDeselectNote();
        });
        if (result === null) {
            return;
        }
    }

    if (ontologyModal.isOpen) {
        await ontologyModal.setFocusTag(tag);
        return;
    }

    ontologyModal.suppressSearchFocusOnce();
    ontologyModal.suppressSearchResultsOnce();
    ontologyModal.open();
    await ontologyModal.setFocusTag(tag);
}

function showTagContextMenu(event, tag, source, explanation) {
    if (typeof tag !== 'string' || tag.trim() === '') {
        return;
    }
    if (!event) {
        throw new Error('showTagContextMenu called without event');
    }
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
        throw new Error('Context menu event missing coordinates');
    }
    event.preventDefault();
    event.stopPropagation();
    openTagContextMenu({ x: event.clientX, y: event.clientY }, tag, source, explanation);
}

// A tag already in the tag bar or the search box: its facts are looked up, then the menu opens complete.
function showEnteredTagContextMenu(event, tag, source, fetchDetails) {
    if (typeof tag !== 'string' || tag.trim() === '') {
        return;
    }
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
        throw new Error('Context menu event missing coordinates');
    }
    event.preventDefault();
    event.stopPropagation();
    const position = { x: event.clientX, y: event.clientY };
    const requestSerial = tagDetailsState.requestSerial + 1;
    tagDetailsState.requestSerial = requestSerial;
    void fetchDetails().then((response) => {
        if (requestSerial !== tagDetailsState.requestSerial) {
            return;
        }
        if (!response || !Array.isArray(response.lines) || response.lines.length === 0) {
            throw new Error('Tag details response requires lines');
        }
        openTagContextMenu(position, tag, source, { heading: ABOUT_THIS_TAG, lines: response.lines });
    });
}

function openTagContextMenu(position, tag, source, explanation) {
    if (typeof source !== 'string' || source.trim() === '') {
        throw new Error('openTagContextMenu requires source string');
    }
    const context = { kind: 'tag', tag, source, explanation };
    const items = buildContextMenuItems(context, {
        onEditTagRelationships: (focusTag) => {
            void openOntologyModalWithFocus(focusTag);
        },
    });
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error('Tag context menu has no items');
    }
    showContextMenu({
        items,
        position,
        onClose: null,
    });
}

function showViewRailContextMenu(event) {
    showViewContextMenu(event);
}

function showTabsRailContextMenu(event) {
    showViewContextMenu(event);
}

function readCssPixelVariable(name) {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('readCssPixelVariable requires name');
    }
    const rawValue = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const parsed = Number.parseFloat(rawValue);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`CSS variable ${name} must be a non-negative pixel value`);
    }
    return parsed;
}

function isInRightRail(event) {
    if (typeof event.clientX !== 'number') {
        throw new Error('Context menu event missing clientX');
    }
    const edge = readCssPixelVariable('--side-rail-edge');
    const width = readCssPixelVariable('--side-rail-width');
    return event.clientX >= window.innerWidth - edge - width;
}

function isInLeftTabRail(event) {
    if (typeof event.clientX !== 'number') {
        throw new Error('Context menu event missing clientX');
    }
    const edge = readCssPixelVariable('--side-rail-edge');
    const width = readCssPixelVariable('--side-rail-width');
    return event.clientX <= edge + width;
}

function resolveContextNoteElement(element) {
    if (!(element instanceof HTMLElement)) {
        return null;
    }

    const noteElement = element.closest('.note');
    if (!(noteElement instanceof HTMLElement)) {
        return null;
    }
    if (noteElement.classList.contains('locked')) {
        return null;
    }
    if (noteElement.classList.contains('search-redacted')) {
        return null;
    }
    const noteId = noteElement.dataset.noteId;
    if (typeof noteId !== 'string' || noteId.trim() === '') {
        throw new Error('Context-menu note element missing data-note-id');
    }
    return noteElement;
}

async function focusNoteForContextAction(noteId) {
    if (typeof noteId !== 'string' || noteId.trim() === '') {
        throw new Error('focusNoteForContextAction requires noteId');
    }

    if (ModeContext.isSearching) {
        actionExitSearchMode();
    }

    if (ModeContext.isEditing) {
        if (ModeContext.currentNoteId === noteId) {
            return;
        }
        await actionSwitchNotes(noteId, { initialCaretVisibility: 'hidden' });
        return;
    }

    await actionSelectNote(noteId, { initialCaretVisibility: 'hidden' });
}

function resolveSelectedTextRangeForNote(noteElement) {
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error('resolveSelectedTextRangeForNote requires note element');
    }

    const noteContent = noteElement.querySelector('.note-content');
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('Context-menu note missing content element');
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }
    if (selection.toString().length === 0) {
        return null;
    }
    if (!noteContent.contains(selection.anchorNode) || !noteContent.contains(selection.focusNode)) {
        return null;
    }

    return selection.getRangeAt(0).cloneRange();
}

async function copySelectedTextRange(selectedTextRange) {
    if (!(selectedTextRange instanceof Range)) {
        throw new Error('copySelectedTextRange requires Range');
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable');
    }
    selection.removeAllRanges();
    selection.addRange(selectedTextRange.cloneRange());

    const copied = document.execCommand('copy');
    if (copied) {
        if (ModeContext.clipboardMode !== 'system') {
            ModeContext.setClipboardMode('system');
        }
        return;
    }

    const selectedText = selectedTextRange.toString();
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new Error('Unable to copy selected text: Clipboard API unavailable');
    }
    await clipboard.writeText(selectedText);
    if (ModeContext.clipboardMode !== 'system') {
        ModeContext.setClipboardMode('system');
    }
}

function insertStyleScopeAroundRange(noteContent, selectedTextRange, plan) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('insertStyleScopeAroundRange requires note content element');
    }
    if (!(selectedTextRange instanceof Range) || selectedTextRange.collapsed) {
        throw new Error('insertStyleScopeAroundRange requires a non-collapsed Range');
    }
    if (!noteContent.contains(selectedTextRange.startContainer) || !noteContent.contains(selectedTextRange.endContainer)) {
        throw new Error('Add Style selection must remain inside the editing note');
    }
    if (!plan || typeof plan !== 'object') {
        throw new Error('insertStyleScopeAroundRange requires style plan');
    }
    if (typeof plan.openToken !== 'string' || plan.openToken.length === 0) {
        throw new Error('Scoped style plan missing openToken');
    }
    if (typeof plan.closeToken !== 'string' || plan.closeToken.length === 0) {
        throw new Error('Scoped style plan missing closeToken');
    }

    const startBoundary = selectedTextRange.cloneRange();
    startBoundary.collapse(true);
    const endBoundary = selectedTextRange.cloneRange();
    endBoundary.collapse(false);

    const closeNode = document.createTextNode(plan.closeToken);
    endBoundary.insertNode(closeNode);
    const openNode = document.createTextNode(plan.openToken);
    startBoundary.insertNode(openNode);

    const styledRange = document.createRange();
    styledRange.setStartAfter(openNode);
    styledRange.setEndBefore(closeNode);
    return styledRange;
}

function restoreStyleSelection(noteContent, styledRange) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('restoreStyleSelection requires note content element');
    }
    if (styledRange !== null && !(styledRange instanceof Range)) {
        throw new Error('restoreStyleSelection requires Range or null');
    }
    noteContent.focus();
    if (styledRange === null) {
        return;
    }
    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable after Add Style');
    }
    selection.removeAllRanges();
    selection.addRange(styledRange);
}

async function addStyleFromContextMenu(noteId, styleTag, selectedTextRange) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('addStyleFromContextMenu requires noteId');
    }
    if (typeof styleTag !== 'string' || styleTag.length === 0) {
        throw new Error('addStyleFromContextMenu requires styleTag');
    }
    if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
        throw new Error('Add Style requires the target note to be actively edited');
    }
    if (selectedTextRange !== null && !(selectedTextRange instanceof Range)) {
        throw new Error('Add Style selection must be Range or null');
    }

    const noteElement = document.querySelector(`.note[data-note-id="${noteId}"]`);
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error(`Add Style note element missing: ${noteId}`);
    }
    const noteContent = noteElement.querySelector('.note-content');
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error(`Add Style note content missing: ${noteId}`);
    }

    const tagBarText = getTagBarValue(noteElement);
    const contentText = typeof noteContent.textContent === 'string' ? noteContent.textContent : '';
    const hasSelection = selectedTextRange instanceof Range && !selectedTextRange.collapsed;
    const plan = buildStyleApplicationPlan({
        styleTag,
        contentText,
        tagBarText,
        hasSelection,
    });
    const nextTags = appendStyleTagToken(tagBarText, plan.tagToken);
    if (!hasSelection && nextTags === tagBarText) {
        restoreStyleSelection(noteContent, null);
        return;
    }

    let styledRange = null;
    if (hasSelection) {
        styledRange = insertStyleScopeAroundRange(noteContent, selectedTextRange, plan);
    }
    setTagBarValue(noteElement, nextTags);

    const nextContent = noteContent.innerHTML;
    if (nextContent !== ModeContext.currentContent) {
        ModeContext.setCurrentContent(nextContent);
    }
    if (!ModeContext.isDirty) {
        ModeContext.setDirty(true);
    }
    restoreStyleSelection(noteContent, styledRange);
    await actionSaveNote(noteId);
    restoreStyleSelection(noteContent, styledRange);
}

function markContextMenuNoteClipboard(noteId) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('markContextMenuNoteClipboard requires noteId');
    }
    if (ModeContext.clipboardMode !== 'note') {
        ModeContext.setClipboardMode('note');
    }
    if (ModeContext.clipboardNoteId !== noteId) {
        ModeContext.setClipboardNoteId(noteId);
    }
}

async function copyNoteFromContextMenu(noteId) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('copyNoteFromContextMenu requires noteId');
    }

    const copyResult = await actionCopyNoteById(noteId);
    const renderedHtml = copyResult?.html;
    const renderedPlainText = copyResult?.plain_text;
    if (renderedHtml || renderedPlainText) {
        await writeRenderedNoteToSystemClipboard({
            renderedHtml,
            renderedPlainText,
            logger: Logger,
        });
    }

    const copiedNoteId = copyResult?.note_id;
    markContextMenuNoteClipboard(
        typeof copiedNoteId === 'string' && copiedNoteId.length > 0 ? copiedNoteId : noteId,
    );
}

async function pasteReferenceFromContextMenu(noteId) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('pasteReferenceFromContextMenu requires noteId');
    }

    const referenceNoteId = ModeContext.clipboardNoteId;
    if (typeof referenceNoteId !== 'string' || referenceNoteId.length === 0) {
        throw new Error('Cannot paste reference: no copied note UUID available');
    }

    await focusNoteForContextAction(noteId);
    await actionPasteReferenceSibling(referenceNoteId);
}

async function pasteReferenceAsChildFromContextMenu(noteId) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('pasteReferenceAsChildFromContextMenu requires noteId');
    }

    const referenceNoteId = ModeContext.clipboardNoteId;
    if (typeof referenceNoteId !== 'string' || referenceNoteId.length === 0) {
        throw new Error('Cannot paste reference as child: no copied note UUID available');
    }

    await focusNoteForContextAction(noteId);
    await actionPasteReferenceChild(referenceNoteId);
}

async function addNoteAtTopFromContextMenu() {
    if (ModeContext.isEditing) {
        throw new Error('Add Note at Top context action requires non-editing mode');
    }
    if (ModeContext.isSearching) {
        actionExitSearchMode();
    }
    await createNoteAtTop();
}

async function setNoteSubtreeCollapsedFromContextMenu(noteId, collapsed) {
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('Recursive note collapse requires noteId');
    }
    if (typeof collapsed !== 'boolean') {
        throw new Error('Recursive note collapse requires collapsed boolean');
    }
    if (ModeContext.isEditing) {
        await actionSaveAndExitEditingWithoutRefreshing();
    }
    await NotesAPI.setCollapsedSubtree(noteId, collapsed);
    await actionRefreshAndMaybeSelect({ animateNoteChanges: false });
}

function isMacPlatform() {
    return navigator.platform.toUpperCase().includes('MAC');
}

function adjacentNoteElement(noteElement, direction) {
    let sibling = direction === 'previous' ? noteElement.previousElementSibling : noteElement.nextElementSibling;
    while (sibling !== null && !sibling.classList.contains('note')) {
        sibling = direction === 'previous' ? sibling.previousElementSibling : sibling.nextElementSibling;
    }
    return sibling;
}

// Which outline moves can happen from this note: the same ones its keyboard
// shortcuts would make (docs/ui/controls.md).
function describeOutlinePosition(noteElement) {
    const hasChildrenFlag = noteElement.dataset.hasChildren;
    if (hasChildrenFlag !== 'true' && hasChildrenFlag !== 'false') {
        throw new Error('Context menu note missing hasChildren flag');
    }
    const parentId = typeof noteElement.dataset.parentId === 'string' ? noteElement.dataset.parentId : '';
    const isRoot = parentId.length === 0;
    const hasPrevious = adjacentNoteElement(noteElement, 'previous') !== null;
    const hasNext = adjacentNoteElement(noteElement, 'next') !== null;
    const isReorderLocked = isRoot && isRootReorderLocked(ModeContext.activeTabSortMode);
    const canMoveUp = !isReorderLocked && (hasPrevious || (isRoot && ModeContext.hasRootsAboveWindow()));
    const canMoveDown = !isReorderLocked && (hasNext || (isRoot && hasRootsBelowLoadedWindow()));
    return {
        hasChildren: hasChildrenFlag === 'true',
        canMoveToTop: canMoveUp,
        canMoveToBottom: canMoveDown,
        canMoveUp,
        canMoveDown,
        canIndent: hasPrevious,
        canOutdent: !isRoot,
    };
}

// The menu's moves act on the clicked note like its shortcuts do on the
// edited one; another note being edited is saved first.
function runOutlineMove(commandName, targetNoteId, moveFn) {
    void CommandGate.run(`contextMenu.note.${commandName}`, async () => {
        await prepareOutlineMoveContextAction({
            targetNoteId,
            modeContext: ModeContext,
            exitSearchModeFn: actionExitSearchMode,
            saveActiveNoteFn: actionSaveNote,
        });
        await moveFn(targetNoteId);
    });
}

// Suggest Tags with AI applies while editing the note, when an AI is set up and
// may see the note as edited (unsaved tags and text included), and no request
// for it is still running.
async function canSuggestTagsWithAi(noteElement, noteId) {
    if (isAskingAiForTags(noteId)) {
        return false;
    }
    return loadNoteTagSuggestionAvailability({
        noteId,
        provider: CommandPalette.getAiSettings().provider,
        tags: getTagBarValue(noteElement),
        contentHtml: DOMUtils.getNoteContentHTML(noteElement),
    });
}

function isEditingNote(noteId) {
    return ModeContext.isEditing && ModeContext.currentNoteId === noteId;
}

// The note may have left the page (scrolled far away) while the AI worked.
function showAiTagStatus(noteId, status, detail) {
    const noteElement = DOMUtils.getNoteById(noteId);
    setAiTagSuggestionStatus({
        noteId,
        status,
        detail,
        noteElement: noteElement instanceof HTMLElement ? noteElement : null,
        isEditing: isEditingNote(noteId),
    });
}

// "2 of 3" while batches are asked for a note with children; nothing for one batch.
function batchProgress(completed, total) {
    return total > 1 ? `${Math.min(completed + 1, total)} of ${total}` : '';
}

// Suggest Tags with AI (docs/ui/tag-bar.md): save, ask the AI outside the
// command gate (typing and other commands go on meanwhile), then add what it
// proposes as undoable proposals. "Asking the AI…" holds the row's place.
async function suggestTagsWithAi(noteId, includeChildren) {
    if (typeof includeChildren !== 'boolean') {
        throw new Error('suggestTagsWithAi requires includeChildren boolean');
    }
    await CommandGate.runWhenFree('contextMenu.suggestTagsWithAi.save', async () => {
        // Text and tags typed so far (it skips when nothing changed): the AI sees them.
        await actionSaveNote(noteId);
        showAiTagStatus(noteId, 'asking', '');
    });
    const settings = CommandPalette.getAiSettings();
    const request = {
        noteId, includeChildren, scope: NotesAPI.viewScope(),
        provider: settings.provider, model: settings.model, thinkingLevel: settings.thinkingLevel,
        onProgress: (completed, total) => showAiTagStatus(noteId, 'asking', batchProgress(completed, total)),
    };
    let tags = null;
    try {
        tags = await requestNoteTagSuggestions(request);
    } catch (error) {
        if (!(error instanceof AiApiError)) {
            throw error;
        }
        showAiTagStatus(noteId, '', '');
        ErrorHandler.showInfoBanner(`The AI couldn't suggest tags: ${error.message}`, 8000);
    }
    if (tags === null) {
        return;
    }
    // The answer may arrive while another command runs: it waits, it is never dropped.
    await CommandGate.runWhenFree('contextMenu.suggestTagsWithAi.add', async () => {
        let addedCount = 0;
        if (Object.keys(tags).length > 0) {
            // What was typed while the AI worked is saved first, as accepting a proposal does,
            // so the refresh that shows the proposals keeps it.
            if (isEditingNote(noteId)) {
                await actionSaveNote(noteId);
            }
            const response = await NotesAPI.addTagProposals(noteId, tags);
            if (!response || !Number.isInteger(response.addedCount)) {
                throw new Error('Adding tag proposals must answer how many were added');
            }
            addedCount = response.addedCount;
        }
        if (addedCount > 0) {
            await actionRefreshAndMaybeSelect({
                startedAt: performance.now(),
                context: 'contextMenu.suggestTagsWithAi',
                requireExecution: true,
                keepEditingFocus: true,
            });
        }
        showAiTagStatus(noteId, addedCount > 0 ? '' : 'nothing-new', '');
    });
}

// Right-click past the tags in the edited note's tag bar: Suggest Tags with AI,
// once the server says the AI may be used; otherwise nothing opens. The tag
// bar keeps its text, caret and focus.
function showTagBarContextMenu(event, input) {
    const noteElement = input.closest('.note');
    if (!(noteElement instanceof HTMLElement) || typeof noteElement.dataset.noteId !== 'string') {
        throw new Error('Tag bar input missing its note');
    }
    const noteId = noteElement.dataset.noteId;
    event.preventDefault();
    event.stopPropagation();
    if (!isEditingNote(noteId)) {
        return;
    }
    const position = { x: event.clientX, y: event.clientY };
    const requestSerial = noteMenuState.requestSerial + 1;
    noteMenuState.requestSerial = requestSerial;
    void canSuggestTagsWithAi(noteElement, noteId).then((canSuggest) => {
        if (!canSuggest || requestSerial !== noteMenuState.requestSerial || !isEditingNote(noteId)) {
            return;
        }
        const items = buildContextMenuItems({ kind: 'tag-bar', noteId, hasChildren: noteElement.dataset.hasChildren === 'true' }, {
            onSuggestTagsWithAi: (targetNoteId, includeChildren) => {
                void suggestTagsWithAi(targetNoteId, includeChildren);
            },
        });
        showContextMenu({ items, position, onClose: null });
    });
}

// Accept or reject every proposal a robot count covers: the note's own, and
// while it shows collapsed, those of its hidden children the view shows. One
// undo step; a note being edited is saved first and keeps its caret.
async function resolveAllTagProposals(noteId, action, includesHiddenChildren) {
    await CommandGate.runWhenFree(`contextMenu.tagProposals.${action}All`, async () => {
        if (ModeContext.isEditing) {
            await actionSaveNote(ModeContext.currentNoteId);
        }
        const response = await NotesAPI.resolveRobotProposals(noteId, action, includesHiddenChildren);
        if (response.status === 'unchanged') {
            return;
        }
        await actionRefreshAndMaybeSelect({
            startedAt: performance.now(),
            context: `contextMenu.tagProposals.${action}All`,
            requireExecution: true,
            keepEditingFocus: true,
        });
    });
}

function showTagProposalsContextMenu(event, robot) {
    const noteElement = robot.closest('.note');
    if (!(noteElement instanceof HTMLElement) || typeof noteElement.dataset.noteId !== 'string') {
        throw new Error('Robot count missing its note');
    }
    // What the robot counted when it was right-clicked.
    const includesHiddenChildren = noteElement.classList.contains('collapsed');
    event.preventDefault();
    event.stopPropagation();
    const items = buildContextMenuItems({ kind: 'tag-proposals', noteId: noteElement.dataset.noteId }, {
        onResolveAllTagProposals: (targetNoteId, action) => {
            void resolveAllTagProposals(targetNoteId, action, includesHiddenChildren);
        },
    });
    showContextMenu({ items, position: { x: event.clientX, y: event.clientY }, onClose: null });
}

function showNoteContextMenu(event, noteId, imageContext, selectedTextRange, referenceContext) {
    if (typeof noteId !== 'string' || noteId.trim() === '') {
        return;
    }
    if (!event) {
        throw new Error('showNoteContextMenu called without event');
    }
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
        throw new Error('Context menu event missing coordinates');
    }
    const noteElement = document.querySelector(`.note[data-note-id="${noteId}"]`);
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error(`Context menu note element missing: ${noteId}`);
    }
    const createdTimestamp = noteElement.dataset.noteCreatedDisplay;
    const updatedTimestamp = noteElement.dataset.noteUpdatedDisplay;
    if (typeof createdTimestamp !== 'string' || createdTimestamp.length === 0) {
        throw new Error(`Context menu note missing created timestamp: ${noteId}`);
    }
    if (typeof updatedTimestamp !== 'string' || updatedTimestamp.length === 0) {
        throw new Error(`Context menu note missing updated timestamp: ${noteId}`);
    }

    const hasSelectedText = selectedTextRange instanceof Range;
    const selectedTextForTag = hasSelectedText
        ? normalizeSelectedTextForTagAction(selectedTextRange.toString())
        : null;
    const hasNoteClipboard = ModeContext.clipboardMode === 'note';
    const hasReferenceClipboard = (
        hasNoteClipboard
        && typeof ModeContext.clipboardNoteId === 'string'
        && ModeContext.clipboardNoteId.length > 0
    );
    // Where Paste Reference Into Note would put the reference: in the edited note's
    // text, at the right-click (or the text selected before it).
    let pasteHereRange = null;
    if (hasReferenceClipboard) {
        pasteHereRange = pasteReferenceHereRange(noteElement, event.target, event.clientX, event.clientY);
    }
    const outline = describeOutlinePosition(noteElement);
    const context = {
        kind: 'note',
        noteId,
        isMac: isMacPlatform(),
        ...outline,
        noteTimestamps: {
            created: createdTimestamp,
            updated: updatedTimestamp,
        },
        imageContext,
        hasSelectedText,
        hasNoteClipboard,
        hasReferenceClipboard,
        canPasteReferenceHere: pasteHereRange !== null,
        canResizeImage: !ModeContext.isEditing,
        canAddStyle: ModeContext.isEditing && ModeContext.currentNoteId === noteId,
        canRemoveFormatting: ModeContext.isEditing && ModeContext.currentNoteId === noteId,
        canAddDiagram: ModeContext.isEditing && ModeContext.currentNoteId === noteId,
        canEditDiagram: true,
        canAddNoteAtTop: !ModeContext.isEditing,
        canViewFullscreen: true,
        canOpenFloatingNote: true,
    };
    if (referenceContext !== null) {
        if (typeof referenceContext !== 'object') {
            throw new Error('Reference context must be an object or null');
        }
        context.referenceNoteId = referenceContext.referenceNoteId;
    }
    if (context.canAddStyle) {
        context.styleOptions = ADD_STYLE_OPTIONS.filter(
            (option) => !option.selectionOnly || (selectedTextRange !== null && !selectedTextRange.collapsed),
        );
    }
    if (selectedTextForTag !== null) {
        context.selectedTextForTag = selectedTextForTag;
    }
    // Builds the menu from the context; false when the note has no items (the browser's menu shows).
    const presentMenu = (position) => {
        const items = buildContextMenuItems(context, {
            onCopySelection: () => {
                void CommandGate.run('contextMenu.selection.copy', async () => {
                    await copySelectedTextRange(selectedTextRange);
                });
            },
            onAddSelectionAsTag: (targetNoteId, selectedText) => {
                void CommandGate.run('contextMenu.selection.add_as_tag', async () => {
                    await addSelectedTextAsTag(targetNoteId, selectedText);
                });
            },
            onAddStyle: (targetNoteId, styleTag) => {
                void CommandGate.run('contextMenu.note.add_style', async () => {
                    await addStyleFromContextMenu(targetNoteId, styleTag, selectedTextRange);
                });
            },
            onRemoveFormatting: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.remove_formatting', async () => {
                    if (!ModeContext.isEditing || ModeContext.currentNoteId !== targetNoteId) {
                        throw new Error('Remove Formatting requires the target note to be actively edited');
                    }
                    await unformatCurrentNoteContent(selectedTextRange);
                });
            },
            onCopyNote: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.copy', async () => {
                    await copyNoteFromContextMenu(targetNoteId);
                });
            },
            onPasteNote: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.paste', async () => {
                    await focusNoteForContextAction(targetNoteId);
                    await actionPasteNoteSibling();
                });
            },
            onPasteNoteChild: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.paste_child', async () => {
                    await focusNoteForContextAction(targetNoteId);
                    await actionPasteNoteChild();
                });
            },
            onPasteReference: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.paste_reference', async () => {
                    await pasteReferenceFromContextMenu(targetNoteId);
                });
            },
            onPasteReferenceChild: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.paste_reference_child', async () => {
                    await pasteReferenceAsChildFromContextMenu(targetNoteId);
                });
            },
            onPasteReferenceHere: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.paste_reference_here', async () => {
                    if (ModeContext.currentNoteId !== targetNoteId || pasteHereRange === null) {
                        throw new Error('Paste Reference Into Note requires the right-clicked note to be edited');
                    }
                    insertReferenceTokenAtRange(`![[${ModeContext.clipboardNoteId}]]`, pasteHereRange);
                });
            },
            onOpenReferenceSource: (referenceNoteId) => {
                void CommandGate.run('contextMenu.reference.open_source', async () => {
                    await openReferenceInNewTab(referenceNoteId);
                });
            },
            onCopyImage: (targetImageContext) => {
                void CommandGate.run('contextMenu.image.copy', async () => {
                    await copyImageFromContext(targetImageContext);
                });
            },
            onMakeImageBigger: (targetImageContext) => {
                void CommandGate.run('contextMenu.image.make_bigger', async () => {
                    await resizeImageFromContext(targetImageContext, 'bigger');
                });
            },
            onMakeImageSmaller: (targetImageContext) => {
                void CommandGate.run('contextMenu.image.make_smaller', async () => {
                    await resizeImageFromContext(targetImageContext, 'smaller');
                });
            },
            onResetImageSize: (targetImageContext) => {
                void CommandGate.run('contextMenu.image.reset_size', async () => {
                    await resizeImageFromContext(targetImageContext, 'reset');
                });
            },
            onSaveImage: (targetImageContext) => {
                void CommandGate.run('contextMenu.image.save', async () => {
                    await saveImageFromContext(targetImageContext);
                });
            },
            onZoomImage: (targetImageContext) => {
                void CommandGate.run('contextMenu.image.zoom', async () => {
                    await zoomImageFromContext(targetImageContext);
                });
            },
            onAddDiagram: (targetNoteId) => {
                void addDiagramToNote(targetNoteId);
            },
            onSuggestTagsWithAi: (targetNoteId, includeChildren) => {
                void suggestTagsWithAi(targetNoteId, includeChildren);
            },
            onEditDiagram: (targetImageContext) => {
                void openDiagramEditor(targetImageContext.fileId, targetImageContext.hostNoteId);
            },
            onSaveDiagram: (targetImageContext) => {
                void CommandGate.run('contextMenu.diagram.save', async () => {
                    await downloadFileReference(targetImageContext.fileId);
                });
            },
            onOpenImageInNewTab: (targetImageContext) => {
                void CommandGate.run('contextMenu.image.open_new_tab', async () => {
                    await openImageInNewTabFromContext(targetImageContext);
                });
            },
            onExportNoteHtml: (targetNoteId) => {
                void exportNotes(targetNoteId, CommandPalette.getAiSettings());
            },
            onExportViewHtml: () => {
                void exportNotes(null, CommandPalette.getAiSettings());
            },
            onPrintNote: (targetNoteId) => {
                void printNotes(targetNoteId, CommandPalette.getAiSettings());
            },
            onPrintView: () => {
                void printNotes(null, CommandPalette.getAiSettings());
            },
            onViewNoteFullscreen: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.view_fullscreen', async () => {
                    // Leaving edit mode as Escape does (saved, place kept): closing
                    // full screen returns to the note's normal view.
                    if (ModeContext.isEditing) await actionDeselectNote();
                    await openNoteFullscreen(targetNoteId);
                });
            },
            onOpenFloatingNote: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.floating', async () => {
                    if (ModeContext.isEditing) await actionSaveNote(ModeContext.currentNoteId);
                    await openFloatingNote(targetNoteId);
                });
            },
            onFullyExpandNote: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.fully_expand', async () => {
                    await setNoteSubtreeCollapsedFromContextMenu(targetNoteId, false);
                });
            },
            onFullyCollapseNote: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.fully_collapse', async () => {
                    await setNoteSubtreeCollapsedFromContextMenu(targetNoteId, true);
                });
            },
            onAddSiblingNote: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.add_sibling', async () => {
                    await focusNoteForContextAction(targetNoteId);
                    await createNote();
                });
            },
            onAddChildNote: (targetNoteId) => {
                void CommandGate.run('contextMenu.note.add_child', async () => {
                    await focusNoteForContextAction(targetNoteId);
                    await createChildNote();
                });
            },
            onAddNoteAtTop: () => {
                void CommandGate.run('contextMenu.note.add_at_top', async () => {
                    await addNoteAtTopFromContextMenu();
                });
            },
            onDeleteNote: (targetNoteId) => {
                // Other notes referencing it: asked first; the dialog leaves edit mode.
                void confirmRemovingReferencedNote(targetNoteId, 'delete').then((decision) => {
                    if (decision === null || decision === 'cancelled') {
                        return;
                    }
                    void CommandGate.run('contextMenu.note.delete', async () => {
                        const deleteMode = await prepareDeleteNoteContextAction({
                            targetNoteId,
                            modeContext: ModeContext,
                            exitSearchModeFn: actionExitSearchMode,
                            saveAndExitEditingFn: actionSaveAndExitEditingWithoutRefreshing,
                        });
                        if (deleteMode === 'selected-edit') {
                            await deleteNote(targetNoteId);
                            return;
                        }
                        if (deleteMode !== 'outside-edit') {
                            throw new Error(`Unknown context-menu delete mode: ${deleteMode}`);
                        }
                        await deleteNoteOutsideEdit(targetNoteId);
                    });
                });
            },
            onMoveNoteToTop: (targetNoteId) => runOutlineMove('move_to_top', targetNoteId, moveNoteToTop),
            onMoveNoteToBottom: (targetNoteId) => runOutlineMove('move_to_bottom', targetNoteId, moveNoteToBottom),
            onMoveNoteUp: (targetNoteId) => runOutlineMove('move_up', targetNoteId, moveNoteUp),
            onMoveNoteDown: (targetNoteId) => runOutlineMove('move_down', targetNoteId, moveNoteDown),
            onIndentNote: (targetNoteId) => runOutlineMove('indent', targetNoteId, indentNote),
            onOutdentNote: (targetNoteId) => runOutlineMove('outdent', targetNoteId, outdentNote),
        });
        if (!Array.isArray(items) || items.length === 0) {
            return false;
        }
        showContextMenu({ items, position, onClose: null });
        return true;
    };

    const position = { x: event.clientX, y: event.clientY };
    if (isEditingNote(noteId)) {
        // Whether Suggest Tags with AI applies needs the server (an AI set up, the
        // privacy settings), so the menu opens once it answers.
        event.preventDefault();
        event.stopPropagation();
        const requestSerial = noteMenuState.requestSerial + 1;
        noteMenuState.requestSerial = requestSerial;
        void canSuggestTagsWithAi(noteElement, noteId).then((canSuggest) => {
            if (requestSerial !== noteMenuState.requestSerial || !isEditingNote(noteId)) {
                return;
            }
            context.canSuggestTagsWithAi = canSuggest;
            if (!presentMenu(position)) {
                throw new Error('The edited note context menu has no items');
            }
        });
        return;
    }
    context.canSuggestTagsWithAi = false;
    if (presentMenu(position)) {
        event.preventDefault();
        event.stopPropagation();
    }
}

function showLinkContextMenu(event, linkContext, referenceContext) {
    if (!event) {
        throw new Error('showLinkContextMenu called without event');
    }
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
        throw new Error('Context menu event missing coordinates');
    }
    if (linkContext === null || typeof linkContext !== 'object') {
        throw new Error('showLinkContextMenu requires linkContext object');
    }

    const context = { kind: 'link', linkContext };
    if (referenceContext !== null) {
        if (typeof referenceContext !== 'object') {
            throw new Error('Reference context must be an object or null');
        }
        context.referenceNoteId = referenceContext.referenceNoteId;
    }
    const items = buildContextMenuItems(context, {
        onOpenReferenceSource: (referenceNoteId) => {
            void CommandGate.run('contextMenu.reference.open_source', async () => {
                await openReferenceInNewTab(referenceNoteId);
            });
        },
        onCopyLink: (targetLinkContext) => {
            void CommandGate.run('contextMenu.link.copy', async () => {
                await copyLinkToClipboard(targetLinkContext);
            });
        },
        onOpenLinkInNewTab: (targetLinkContext) => {
            void CommandGate.run('contextMenu.link.open_new_tab', async () => {
                await openLinkInNewTabFromContext(targetLinkContext);
            });
        },
    });

    if (!Array.isArray(items) || items.length === 0) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    showContextMenu({
        items,
        position: { x: event.clientX, y: event.clientY },
        onClose: null,
    });
}

function showViewContextMenu(event) {
    if (!event) {
        throw new Error('showViewContextMenu called without event');
    }
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
        throw new Error('Context menu event missing coordinates');
    }

    const scrollToTopButton = document.getElementById('scroll-to-top-button');
    const scrollToBottomButton = document.getElementById('scroll-to-bottom-button');
    if (!(scrollToTopButton instanceof HTMLButtonElement) || !(scrollToBottomButton instanceof HTMLButtonElement)) {
        throw new Error('scroll-to-top or scroll-to-bottom button missing');
    }
    const themeAttribute = document.documentElement.getAttribute('data-theme');
    const context = {
        kind: 'view',
        isMac: isMacPlatform(),
        isEditing: ModeContext.isEditing,
        canPasteNoteAtTop: ModeContext.clipboardMode === 'note',
        // Go to Top and Bottom are offered when the arrow could act (not at that end already).
        canGoToTop: !scrollToTopButton.disabled,
        canGoToBottom: !scrollToBottomButton.disabled,
        isUntaggedView: ModeContext.isUntaggedView === true,
        theme: themeAttribute === 'light' || themeAttribute === 'dark' ? themeAttribute : 'system',
        areTabsVisible: document.body.classList.contains('pref-show-tab-ui'),
        isAiChatVisible: document.body.classList.contains('pref-show-ai-chat'),
        areNoteTagsVisible: document.body.classList.contains('pref-show-note-tags'),
        sortMode: ModeContext.activeTabSortMode,
    };
    const items = buildContextMenuItems(context, {
        onPasteNoteAtTop: () => {
            void pasteCopiedNoteIntoNewTopNote();
        },
        onUndo: () => {
            void CommandGate.run('contextMenu.view.undo', async () => {
                await actionUndo();
            });
        },
        onRedo: () => {
            void CommandGate.run('contextMenu.view.redo', async () => {
                await actionRedo();
            });
        },
        // The up arrow's own behaviour (loading the start of the list if needed).
        onGoToTop: () => {
            scrollToTopButton.click();
        },
        onGoToBottom: () => {
            scrollToBottomButton.click();
        },
        onFullyExpandAll: () => {
            void CommandPalette.fullyExpandAll();
        },
        onFullyCollapseAll: () => {
            void CommandPalette.fullyCollapseAll();
        },
        onSetUntaggedView: (isUntaggedView) => {
            void CommandGate.run('contextMenu.view.untagged', async () => {
                await CommandPalette.setIsUntaggedView(isUntaggedView);
            });
        },
        onSetTheme: (theme) => {
            void CommandPalette.applyPreference('pref.theme', theme);
        },
        onNewTab: () => {
            void CommandGate.run('contextMenu.view.new_tab', async () => {
                await createBlankSearchContextFromHover();
            });
        },
        onOpenNamespace: () => {
            void CommandPalette.openOpenNamespace();
        },
        onOpenReminders: () => {
            void CommandPalette.openReminders({ search: '' });
        },
        onLogOut: () => {
            void CommandPalette.logout();
        },
        onToggleTabs: (nextValue) => {
            void CommandPalette.applyPreference('pref.show_tab_ui', nextValue);
        },
        onToggleAiChat: (nextValue) => {
            void CommandPalette.applyPreference('pref.show_ai_chat', nextValue);
        },
        onToggleNoteTags: (nextValue) => {
            void CommandPalette.applyPreference('pref.show_note_tags', nextValue);
        },
        onSetSortMode: (sortMode) => {
            void CommandGate.run('contextMenu.view.sort_mode', async () => {
                await CommandPalette.setSortMode(sortMode);
            });
        },
        onAddNoteAtTop: () => {
            void CommandGate.run('contextMenu.view.add_at_top', async () => {
                await addNoteAtTopFromContextMenu();
            });
        },
        onExportViewHtml: () => {
            void exportNotes(null, CommandPalette.getAiSettings());
        },
        onPrintView: () => {
            void printNotes(null, CommandPalette.getAiSettings());
        },
    });

    if (!Array.isArray(items) || items.length === 0) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    showContextMenu({
        items,
        position: { x: event.clientX, y: event.clientY },
        onClose: null,
    });
}

function handleContextMenu(event) {
    if (!event) {
        throw new Error('handleContextMenu called without event');
    }
    if (ModeContext.isLoading) {
        return;
    }

    const element = resolveEventElement(event.target);
    if (!element) {
        return;
    }
    if (element.closest('.note-fullscreen-overlay')) {
        return;
    }
    // Let the chat controller own the entire response bubble, including padding
    // that overlaps the coordinate-based side rail and links inside the response.
    if (element.closest('.ai-chat-message-assistant[data-message-id]')) {
        return;
    }
    if (element.closest('#ai-chat-panel')) return;

    const priorityTarget = resolvePriorityContextMenuTarget(element, {
        isInLeftRail: isInLeftTabRail(event),
        isInRightRail: isInRightRail(event),
    });

    const robot = element.closest('.note-proposal-indicator');
    if (robot !== null) {
        showTagProposalsContextMenu(event, robot);
        return;
    }

    if (priorityTarget?.kind === 'tag-suggestion') {
        showTagContextMenu(event, priorityTarget.tag, priorityTarget.source, {
            heading: WHY_SUGGESTED, lines: priorityTarget.reasons,
        });
        return;
    }

    if (priorityTarget?.kind === 'tag-bar-input') {
        const input = priorityTarget.element;
        // Past the tags (or an empty bar), with nothing selected: the tag bar's own menu.
        if (input.selectionStart === input.selectionEnd && isInputPointPastText(input, event.clientX)) {
            showTagBarContextMenu(event, input);
            return;
        }
        const tagInfo = resolveTagFromInput(
            event,
            priorityTarget.element,
            findTagAtIndexInTagBar,
        );
        if (tagInfo && typeof tagInfo.text === 'string') {
            const input = priorityTarget.element;
            const noteElement = input.closest('.note');
            if (!noteElement || typeof noteElement.dataset.noteId !== 'string') {
                throw new Error('Tag bar input missing its note');
            }
            showEnteredTagContextMenu(event, tagInfo.text, 'tag-bar', () => NotesAPI.fetchTagDetails(
                noteElement.dataset.noteId, tagInfo.text, input.value, DOMUtils.getNoteContentHTML(noteElement),
            ));
        }
        return;
    }

    if (priorityTarget?.kind === 'search-input') {
        const tagInfo = resolveTagFromInput(
            event,
            priorityTarget.element,
            findSearchTagAtIndex,
        );
        if (tagInfo && typeof tagInfo.tag === 'string') {
            const query = priorityTarget.element.value;
            showEnteredTagContextMenu(event, tagInfo.tag, 'search', () => NotesAPI.fetchSearchTagDetails(
                query, tagInfo, getSearchSuggestionWindowDays(),
            ));
        }
        return;
    }

    if (priorityTarget?.kind === 'view-rail') {
        showViewRailContextMenu(event);
        return;
    }

    if (priorityTarget?.kind === 'tabs-rail') {
        showTabsRailContextMenu(event);
        return;
    }

    const noteElement = resolveContextNoteElement(element);
    const referenceContext = resolveReferenceContextFromElement(element);
    if (noteElement) {
        const selectedTextRange = resolveSelectedTextRangeForNote(noteElement);
        if (selectedTextRange) {
            const imageContext = resolveImageContextFromElement(element);
            showNoteContextMenu(
                event,
                noteElement.dataset.noteId,
                imageContext,
                selectedTextRange,
                referenceContext,
            );
            return;
        }
    }

    const linkContext = resolveLinkContextFromElement(element);
    if (linkContext) {
        showLinkContextMenu(event, linkContext, referenceContext);
        return;
    }

    if (noteElement) {
        const imageContext = resolveImageContextFromElement(element);
        showNoteContextMenu(
            event,
            noteElement.dataset.noteId,
            imageContext,
            null,
            referenceContext,
        );
        return;
    }

    const notesContainer = element.closest('#notes-container');
    if (notesContainer) {
        showViewContextMenu(event);
    }
}

export function initContextMenuEvents() {
    initContextMenuService();
    // Before the browser may select the word under the pointer (macOS).
    document.addEventListener('mousedown', rememberSelectionAtRightPress, { capture: true });
    document.addEventListener('contextmenu', unlessDiagramEditorOpen(handleContextMenu), { capture: true });
    // Right-click never shows the browser's own menu anywhere in MetaList (inputs,
    // the chat panel and overlays included): where MetaList has no menu, nothing opens.
    window.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });
    Logger.logInit('Context menu events handler');
}
