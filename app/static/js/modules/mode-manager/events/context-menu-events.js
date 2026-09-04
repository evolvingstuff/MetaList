import { ModeContextInstance as ModeContext } from '../mode-context.js';
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
    moveNoteToTop,
    unformatCurrentNoteContent,
} from '../actions/note-actions.js';
import { CommandGate } from '../services/command-gate-service.js';
import {
    prepareDeleteNoteContextAction,
    prepareMoveNoteToTopContextAction,
} from '../services/note-context-menu-action-service.js';
import { writeRenderedNoteToSystemClipboard } from '../services/note-clipboard-write-service.js';
import { insertReferenceTokenIntoActiveEditor } from '../services/file-reference-service.js';
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
import { getInputCaretIndexFromPoint } from '../../context-menu/input-caret-service.js';
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
import { getTagBarValue, setTagBarValue } from '../services/tag-bar-service.js';
import { openNoteFullscreen } from '../services/note-fullscreen-service.js';
import { openReferenceInNewTab } from './keyboard-events.js';

const ontologyModal = new OntologyModal();

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
        if (ModeContext.currentContent !== response.content) {
            ModeContext.setCurrentContent(response.content);
        }
        if (ModeContext.lastSavedContent !== response.content) {
            ModeContext.setLastSavedContent(response.content);
        }
        if (ModeContext.isDirty) {
            ModeContext.setDirty(false);
        }
        ModeContext.markEditSessionHasEdits();
        return;
    }
    await actionRefreshAndMaybeSelect({
        startedAt: performance.now(),
        context: `resizeImage.${action}`,
    });
}

function resolveEffectiveTheme() {
    const explicitTheme = document.documentElement.getAttribute('data-theme');
    if (explicitTheme === 'dark' || explicitTheme === 'light') {
        return explicitTheme;
    }
    if (
        typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
        return 'dark';
    }
    return 'light';
}

function resolveEventElement(target) {
    if (target instanceof HTMLElement) {
        return target;
    }
    if (target && target.nodeType === 3 && target.parentElement instanceof HTMLElement) {
        return target.parentElement;
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

function showTagContextMenu(event, tag, source) {
    if (typeof tag !== 'string' || tag.trim() === '') {
        return;
    }
    if (typeof source !== 'string' || source.trim() === '') {
        throw new Error('showTagContextMenu requires source string');
    }
    if (!event) {
        throw new Error('showTagContextMenu called without event');
    }
    if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') {
        throw new Error('Context menu event missing coordinates');
    }

    const context = { kind: 'tag', tag, source };
    const items = buildContextMenuItems(context, {
        onEditTagRelationships: (focusTag) => {
            void openOntologyModalWithFocus(focusTag);
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

async function saveActiveEditSessionForExport() {
    if (!ModeContext.isEditing) {
        return;
    }

    const currentNoteId = ModeContext.currentNoteId;
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        throw new Error('Cannot export while editing without current note id');
    }
    await actionSaveNote(currentNoteId);
}

function downloadHtmlExportPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('HTML export response missing body');
    }
    if (!(payload.blob instanceof Blob)) {
        throw new Error('HTML export response missing blob');
    }
    if (typeof payload.filename !== 'string' || payload.filename.length === 0) {
        throw new Error('HTML export response missing filename');
    }

    const objectUrl = URL.createObjectURL(payload.blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = payload.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 0);
}

async function exportHtmlFromContextMenu(noteId) {
    if (noteId !== null && (typeof noteId !== 'string' || noteId.length === 0)) {
        throw new Error('exportHtmlFromContextMenu requires noteId string or null');
    }

    await saveActiveEditSessionForExport();
    const payload = await NotesAPI.exportCurrentViewAsHtml(
        resolveEffectiveTheme(),
        noteId === null ? {} : { noteId },
    );
    downloadHtmlExportPayload(payload);
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
    insertReferenceTokenIntoActiveEditor(`![[${referenceNoteId}]]`);
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
    await createChildNote();
    insertReferenceTokenIntoActiveEditor(`![[${referenceNoteId}]]`);
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

async function makePseudoSuggestionsFromContextMenu(noteId) {
    if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
        throw new Error('Make pseudo-suggestions requires the target note to be actively edited');
    }
    if (ModeContext.editSessionHasEdits) {
        await actionSaveNote(noteId);
    }
    await NotesAPI.makePseudoTagProposals(noteId);
    await actionRefreshAndMaybeSelect({
        startedAt: performance.now(),
        context: 'makePseudoSuggestions',
        requireExecution: true,
    });
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
    const context = {
        kind: 'note',
        noteId,
        noteTimestamps: {
            created: createdTimestamp,
            updated: updatedTimestamp,
        },
        imageContext,
        hasSelectedText,
        hasNoteClipboard,
        hasReferenceClipboard,
        canResizeImage: !ModeContext.isEditing,
        canAddStyle: ModeContext.isEditing && ModeContext.currentNoteId === noteId,
        canRemoveFormatting: ModeContext.isEditing && ModeContext.currentNoteId === noteId,
        canMakePseudoSuggestions: ModeContext.isEditing && ModeContext.currentNoteId === noteId,
        canAddNoteAtTop: !ModeContext.isEditing,
        canViewFullscreen: !ModeContext.isEditing,
    };
    if (referenceContext !== null) {
        if (typeof referenceContext !== 'object') {
            throw new Error('Reference context must be an object or null');
        }
        context.referenceNoteId = referenceContext.referenceNoteId;
    }
    if (context.canAddStyle) {
        context.styleOptions = ADD_STYLE_OPTIONS;
    }
    if (selectedTextForTag !== null) {
        context.selectedTextForTag = selectedTextForTag;
    }
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
        onMakePseudoSuggestions: (targetNoteId) => {
            void CommandGate.run('contextMenu.note.make_pseudo_suggestions', async () => {
                await makePseudoSuggestionsFromContextMenu(targetNoteId);
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
        onOpenImageInNewTab: (targetImageContext) => {
            void CommandGate.run('contextMenu.image.open_new_tab', async () => {
                await openImageInNewTabFromContext(targetImageContext);
            });
        },
        onExportNoteHtml: (targetNoteId) => {
            void CommandGate.run('contextMenu.note.export_html', async () => {
                await exportHtmlFromContextMenu(targetNoteId);
            }, {
                timeoutMs: 120000,
            });
        },
        onExportViewHtml: () => {
            void CommandGate.run('contextMenu.view.export_html', async () => {
                await exportHtmlFromContextMenu(null);
            }, {
                timeoutMs: 120000,
            });
        },
        onViewNoteFullscreen: (targetNoteId) => {
            void CommandGate.run('contextMenu.note.view_fullscreen', async () => {
                if (ModeContext.isEditing) {
                    throw new Error('View Full Screen requires non-editing mode');
                }
                await openNoteFullscreen(targetNoteId);
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
        },
        onMoveNoteToTop: (targetNoteId) => {
            void CommandGate.run('contextMenu.note.move_to_top', async () => {
                await prepareMoveNoteToTopContextAction({
                    targetNoteId,
                    modeContext: ModeContext,
                    exitSearchModeFn: actionExitSearchMode,
                    saveActiveNoteFn: actionSaveNote,
                });
                await moveNoteToTop(targetNoteId);
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

    const context = {
        kind: 'view',
        areTabsVisible: document.body.classList.contains('pref-show-tab-ui'),
        isAiChatVisible: document.body.classList.contains('pref-show-ai-chat'),
        areNoteTagsVisible: document.body.classList.contains('pref-show-note-tags'),
        canAddNoteAtTop: !ModeContext.isEditing,
    };
    const items = buildContextMenuItems(context, {
        onToggleTabs: (nextValue) => {
            void CommandPalette.applyPreference('pref.show_tab_ui', nextValue);
        },
        onToggleAiChat: (nextValue) => {
            void CommandPalette.applyPreference('pref.show_ai_chat', nextValue);
        },
        onToggleNoteTags: (nextValue) => {
            void CommandPalette.applyPreference('pref.show_note_tags', nextValue);
        },
        onAddNoteAtTop: () => {
            void CommandGate.run('contextMenu.view.add_at_top', async () => {
                await addNoteAtTopFromContextMenu();
            });
        },
        onExportViewHtml: () => {
            void CommandGate.run('contextMenu.view.export_html', async () => {
                await exportHtmlFromContextMenu(null);
            }, {
                timeoutMs: 120000,
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

    const priorityTarget = resolvePriorityContextMenuTarget(element, {
        isInLeftRail: isInLeftTabRail(event),
        isInRightRail: isInRightRail(event),
    });

    if (priorityTarget?.kind === 'tag-suggestion') {
        showTagContextMenu(event, priorityTarget.tag, priorityTarget.source);
        return;
    }

    if (priorityTarget?.kind === 'tag-bar-input') {
        const tagInfo = resolveTagFromInput(
            event,
            priorityTarget.element,
            findTagAtIndexInTagBar,
        );
        if (tagInfo && typeof tagInfo.text === 'string') {
            showTagContextMenu(event, tagInfo.text, 'tag-bar');
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
            showTagContextMenu(event, tagInfo.tag, 'search');
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
    document.addEventListener('contextmenu', handleContextMenu, { capture: true });
    Logger.logInit('Context menu events handler');
}
