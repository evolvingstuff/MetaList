import { ApplicationState } from '../../application-state.js';
import { rethrowUnexpectedError } from '../../expected-errors.js';
import { navigateToFootnoteWithExpansion } from '../services/footnote-navigation-service.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { createNote, deleteNote, collapseNote, expandNote, getShellRun, moveNoteToSiblingPosition, indentNote, outdentNote, toggleTodoDone, runShellNote } from '../actions/note-actions.js';
import { actionSelectNote, actionDeselectNote, actionSwitchNotes } from '../actions/selection-actions.js';
import { actionEnterSearchMode, actionExitSearchMode } from '../actions/search-actions.js';
import { DOMUtils } from '../../dom-utils.js'; 
import { normalizeTagBarForNewTag } from '../services/tag-bar-service.js';
import { updateTagSuggestions } from '../services/tag-suggestions-service.js';
import {
    hideSearchSuggestionsForSearchContextHover,
    hideSearchSuggestionsForSearchContextPointerMove,
} from '../services/search-suggestions-service.js';
import {
    hideSearchContextsOverlay,
    hideSearchContextsOverlayForPointerMove,
} from '../services/search-contexts-overlay-service.js';
import { CommandGate } from '../services/command-gate-service.js';
import { CommandPalette } from '../../command-palette/command-palette-controller.js';
import { NotesAPI } from '../../api-client.js';
import { isContextMenuInteractionTarget } from '../../context-menu/context-menu-target-service.js';
import { downloadFileReference } from '../services/file-reference-service.js';
import { revealRedactedNoteWithScrollPreservation } from '../services/search-redaction-reveal-service.js';
import { resolveVerticalSiblingDropDestination, updateMoveDragGestureState } from '../services/note-drag-service.js';
import { isViewModeNoteLink, resolveNonContentNoteSelectionTarget } from '../services/note-click-target-service.js';
import {
    SHELL_CLOSE_SELECTOR,
    SHELL_RUNNING_CLASS,
    SHELL_SELECTOR,
    ensureShellOutputElement,
    ensureShellOutputStructure,
    renderShellError,
    renderShellSnapshot,
} from '../services/shell-output-service.js';
import {
    navigateBackFromReferenceContext,
    openReferenceInCurrentTab,
    openReferenceInNewTab,
    openReferenceQueryInNewTab,
    openBacklinksInNewTab,
} from './keyboard-events.js';


const moduleState = ApplicationState.createFields('mouse-events', {
    selectionDragContext: null,
    ignoreClickAfterSelectionDrag: null,
    moveDragContext: null,
    ignoreClickAfterMoveDrag: null,
    ignoreClickAfterMouseDownAction: null,
});


const MOVE_DRAG_COMMIT_THRESHOLD_PX = 20;
const MOVE_DRAG_COMMIT_THRESHOLD_SQ = MOVE_DRAG_COMMIT_THRESHOLD_PX * MOVE_DRAG_COMMIT_THRESHOLD_PX;
const CREDENTIAL_VALUE_SELECTOR = '.meta-credential-value';
const EMAIL_VALUE_SELECTOR = '.meta-email-value';
const STATUS_TOGGLE_SELECTOR = '.meta-status-toggle';
const CREDENTIAL_COPY_CLASS = 'meta-credential-copied';
const COPYABLE_SELECTOR = '.meta-copyable';
const COPYABLE_COPY_CLASS = 'meta-copyable-copied';
const COLLAPSED_CHILDREN_INDICATOR_SELECTOR = '.note-collapsed-children-indicator';
const TAG_PROPOSAL_ACTION_SELECTOR = '.note-tag-proposal-action';
const SHELL_RUN_TIMEOUT_SECONDS = 0;
const SHELL_POLL_INTERVAL_MS = 250;
const copyFeedbackTimers = ApplicationState.createWeakCollection('copyFeedbackTimers', 'map');

export function initMouseEvents() {
    document.addEventListener('mousedown', beginMouseGesture, { capture: true });
    document.addEventListener('pointercancel', cancelMouseGesture, { capture: true });
    window.addEventListener('blur', cancelMouseGesture);
    document.addEventListener('mousedown', handleCollapseToggleMouseDown, { capture: true });
    document.addEventListener('mousedown', handleImmediateMouseDown, { capture: true });
    document.addEventListener('mousedown', handleMoveDragMouseDown, { capture: true });
    document.addEventListener('mousemove', handleMoveDragMouseMove, { capture: true });
    document.addEventListener('mousemove', handleSearchSuggestionsPointerMove, { capture: true, passive: true });
    document.addEventListener('mousemove', handleSearchContextsPointerMove, { capture: true, passive: true });
    document.addEventListener('mouseup', handleMoveDragMouseUp, { capture: true });
    document.addEventListener('mousedown', handleSelectionDragMouseDown, { capture: true });
    document.addEventListener('mouseup', handleSelectionDragMouseUp, { capture: true });
    document.addEventListener('click', handleClick, { capture: true });
    document.addEventListener('mouseover', handleMouseOver, { capture: true });
    document.addEventListener('mouseout', handleMouseOut, { capture: true });

    Logger.logInit('Mouse events handler');
}

function beginMouseGesture(event) {
    if (event.button !== 0) return;
    // A new press ends the previous gesture even if DOM replacement, release
    // elsewhere, or leaving the window prevented its click from arriving.
    cancelMouseGesture();
}

function cancelMouseGesture() {
    if (moduleState.moveDragContext?.dragActive) setMoveDragCursorActive(false);
    for (const field of [
        'moveDragContext', 'selectionDragContext', 'ignoreClickAfterMoveDrag',
        'ignoreClickAfterSelectionDrag', 'ignoreClickAfterMouseDownAction',
    ]) {
        if (moduleState[field] !== null) moduleState[field] = null;
    }
}

function isShellInteractiveTarget(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    return target.closest(SHELL_CLOSE_SELECTOR) !== null;
}

function stopImmediatePropagationIfAvailable(event) {
    if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
        return;
    }
    event.stopPropagation();
}

function rememberMouseDownHandledClick(target, reason) {
    if (!(target instanceof Node)) {
        throw new Error('rememberMouseDownHandledClick requires target node');
    }
    if (typeof reason !== 'string' || reason.length === 0) {
        throw new Error('rememberMouseDownHandledClick requires reason');
    }
    moduleState.ignoreClickAfterMouseDownAction = {
        target,
        reason,
    };
}

function isRelatedToMouseDownTarget(clickTarget, mouseDownTarget) {
    if (!(clickTarget instanceof Node) || !(mouseDownTarget instanceof Node)) {
        return false;
    }
    if (clickTarget === mouseDownTarget) {
        return true;
    }
    if (clickTarget.contains(mouseDownTarget)) {
        return true;
    }
    if (mouseDownTarget.contains(clickTarget)) {
        return true;
    }
    return false;
}

function consumeClickAfterMouseDownAction(event) {
    const pendingClick = moduleState.ignoreClickAfterMouseDownAction;
    if (!pendingClick) return false;
    moduleState.ignoreClickAfterMouseDownAction = null;
    // Keyboard/programmatic activation is a new action, not a mouse release.
    if (event.detail === 0) return false;
    if (!isRelatedToMouseDownTarget(event.target, pendingClick.target)) {
        return false;
    }

    Logger.logNoop('Click ignored after mousedown action', {
        reason: pendingClick.reason,
    });
    event.preventDefault();
    event.stopPropagation();
    return true;
}

function isMouseDownOutsideEditExclusion(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    if (isContextMenuInteractionTarget(target)) {
        return true;
    }
    return target.closest(
        [
            '.modal',
            '#rich-text-toolbar',
            '#file-reference-input',
            '.note-tag-bar',
            '#search-contexts-list',
            '#backlinks-panel',
            '#reference-source-indicator',
            '#root-sort-indicator',
            '#menu-button',
            '#chat-toggle-button',
            '.add-note',
            '#trash-can',
            '.note-collapse-toggle',
            COLLAPSED_CHILDREN_INDICATOR_SELECTOR,
            '.note-reference-link',
            '.note-backlinks-link',
            '.ai-chat-open-all-references',
            '.note-file-reference-link',
            '.note-file-image-download-link',
            '.backlink-item',
            CREDENTIAL_VALUE_SELECTOR,
            EMAIL_VALUE_SELECTOR,
            COPYABLE_SELECTOR,
            SHELL_SELECTOR,
            SHELL_CLOSE_SELECTOR,
        ].join(',')
    ) !== null;
}

function handleSearchFieldMouseDown(event, searchField) {
    if (!searchField) {
        return false;
    }
    hideSearchContextsOverlay();

    let shouldEnterSearch = false;
    if (ModeContext.isEditing) {
        shouldEnterSearch = true;
    }
    if (!ModeContext.isSearching) {
        shouldEnterSearch = true;
    }
    if (!shouldEnterSearch) {
        return false;
    }

    void CommandGate.run('mouse.enter_search_mode', async () => {
        await actionEnterSearchMode();
    });

    rememberMouseDownHandledClick(searchField, 'search_field');
    Logger.logDebug('Mouse down in search field', {}, Logger.LogCategory.EVENT);
    return true;
}

function handleNoteShellMouseDown(event, noteElement) {
    if (!noteElement) {
        return false;
    }

    if (!ModeContext.isConnected) {
        return false;
    }
    if (ModeContext.isLoading) {
        return false;
    }

    if (noteElement.classList.contains('locked')) {
        Logger.logNoop('Mousedown on locked note shell ignored', {
            noteId: noteElement.dataset.noteId,
            reason: 'note_locked',
        });
        event.preventDefault();
        event.stopPropagation();
        return true;
    }

    const noteId = noteElement.dataset.noteId;
    if (!noteId) {
        throw new Error('Note shell mousedown target missing data-note-id attribute');
    }

    if (noteElement.classList.contains('search-redacted')) {
        const revealResult = revealRedactedNoteWithScrollPreservation(noteId);
        Logger.logAction('reveal search-redacted note', {
            noteId,
            result: revealResult.reason,
            revealedCount: revealResult.revealedCount,
            scopeNoteId: revealResult.scopeNoteId,
        });
        rememberMouseDownHandledClick(noteElement, 'redacted_note_shell');
        event.preventDefault();
        event.stopPropagation();
        return true;
    }

    if (ModeContext.isSearching) {
        actionExitSearchMode();
    }

    if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
        if (ModeContext.currentNoteId) {
            void CommandGate.run('mouse.switch_note', async () => {
                await actionSwitchNotes(noteId, { initialCaretVisibility: 'hidden' });
            });
        } else {
            void CommandGate.run('mouse.select_note', async () => {
                await actionSelectNote(noteId, { initialCaretVisibility: 'hidden' });
            });
        }

        Logger.logDebug('Mouse down in note shell - selecting note', {
            noteId,
            isEditing: true,
        }, Logger.LogCategory.EVENT);
    } else if (ModeContext.isCaretHidden && ModeContext.currentNoteId === noteId) {
        DOMUtils.revealCaret(noteElement);
        ModeContext.markCaretVisible();
    }

    rememberMouseDownHandledClick(noteElement, 'note_shell');
    event.preventDefault();
    event.stopPropagation();
    return true;
}

function handleOutsideMouseDown(event) {
    if (event.target.closest('.note-content') || resolveNonContentNoteSelectionTarget(event.target)) {
        return false;
    }
    if (isMouseDownOutsideEditExclusion(event.target)) {
        return false;
    }

    let handled = false;
    if (ModeContext.isEditing) {
        void CommandGate.run('mouse.deselect', async () => {
            await actionDeselectNote();
        });
        Logger.logDebug('Mouse down outside any note - exiting edit mode', {
            isEditing: false,
            currentNoteId: null,
        }, Logger.LogCategory.EVENT);
        handled = true;
    }

    if (ModeContext.isSearching) {
        actionExitSearchMode();
        handled = true;
    }

    if (handled) {
        rememberMouseDownHandledClick(event.target, 'outside_note');
    }
    return handled;
}

function handleImmediateMouseDown(event) {
    if (!event) {
        throw new Error('handleImmediateMouseDown called without an event object');
    }
    if (typeof event.button !== 'number') {
        throw new Error(`Invalid MouseEvent: missing button (type: ${event.type})`);
    }
    if (event.button !== 0) {
        return;
    }
    if (!event.target) {
        throw new Error('Immediate mousedown missing target element');
    }
    if (!(event.target instanceof Element)) {
        return;
    }

    if (isViewModeNoteLink(event.target)) {
        return;
    }

    if (event.target.closest('.modal') || isContextMenuInteractionTarget(event.target) || isShellInteractiveTarget(event.target)) {
        return;
    }

    if (event.target.closest(COLLAPSED_CHILDREN_INDICATOR_SELECTOR)) {
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    if (event.target.closest('.meta-footnote-link, .note-backlinks-link, .note-source-arrow')) {
        return;
    }

    if (event.target.closest(TAG_PROPOSAL_ACTION_SELECTOR)) {
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    if (ModeContext.isLoading) {
        return;
    }

    const todoToggle = event.target.closest(STATUS_TOGGLE_SELECTOR);
    if (todoToggle && handleTodoToggleClick(event)) {
        rememberMouseDownHandledClick(todoToggle, 'todo_toggle');
        stopImmediatePropagationIfAvailable(event);
        return;
    }

    const searchField = event.target.closest('#search-input');
    if (handleSearchFieldMouseDown(event, searchField)) {
        return;
    }
    if (searchField) {
        return;
    }

    const noteShellSelectionTarget = resolveNonContentNoteSelectionTarget(event.target);
    if (handleNoteShellMouseDown(event, noteShellSelectionTarget)) {
        return;
    }

    handleOutsideMouseDown(event);
}

function handleSelectionDragMouseDown(event) {
    if (!event) {
        throw new Error('handleSelectionDragMouseDown called without an event object');
    }
    if (typeof event.button !== 'number') {
        throw new Error(`Invalid MouseEvent: missing button (type: ${event.type})`);
    }
    if (event.button !== 0) {
        return;
    }
    if (!event.target) {
        throw new Error('Selection drag mousedown missing target element');
    }

    if (!ModeContext.isEditing || !ModeContext.currentNoteId) {
        if (moduleState.selectionDragContext !== null) moduleState.selectionDragContext = null;
        return;
    }

    const noteContent = event.target.closest('.note-content');
    if (!noteContent) {
        if (moduleState.selectionDragContext !== null) moduleState.selectionDragContext = null;
        return;
    }

    const noteElement = noteContent.closest('.note');
    if (!noteElement) {
        throw new Error('Found .note-content without parent .note element in selection drag handler');
    }

    const noteId = noteElement.dataset.noteId;
    if (!noteId) {
        throw new Error('Note element missing data-note-id attribute in selection drag handler');
    }

    if (noteId !== ModeContext.currentNoteId) {
        if (moduleState.selectionDragContext !== null) moduleState.selectionDragContext = null;
        return;
    }

    moduleState.selectionDragContext = {
        noteId,
        noteContent,
        startedAt: performance.now(),
    };
}

function setMoveDragCursorActive(isActive) {
    const body = document.body;
    if (!body) {
        throw new Error('Document body missing while toggling drag cursor');
    }
    body.classList.toggle('note-drag-active', Boolean(isActive));
}

function handleMoveDragMouseDown(event) {
    if (!event) {
        throw new Error('handleMoveDragMouseDown called without an event object');
    }
    if (typeof event.button !== 'number') {
        throw new Error(`Invalid MouseEvent: missing button (type: ${event.type})`);
    }
    if (event.button !== 0) {
        return;
    }
    if (!event.target) {
        throw new Error('Move drag mousedown missing target element');
    }
    if (isViewModeNoteLink(event.target)) {
        return;
    }
    if (event.target instanceof Element && event.target.closest(SHELL_SELECTOR)) {
        return;
    }
    if (isShellInteractiveTarget(event.target)) {
        return;
    }
    if (event.target instanceof Element && event.target.closest(`${STATUS_TOGGLE_SELECTOR}, .meta-footnote-link, .note-backlinks-link, .note-source-arrow`)) {
        return;
    }

    if (ModeContext.isLoading) {
        return;
    }

    if (ModeContext.isEditing) {
        return;
    }

    const noteContent = event.target.closest('.note-content');
    if (!noteContent) {
        return;
    }

    const noteElement = noteContent.closest('.note');
    if (!noteElement) {
        throw new Error('Found .note-content without parent .note element in move drag handler');
    }

    if (noteElement.classList.contains('locked') || noteElement.classList.contains('search-redacted')) {
        return;
    }

    const noteId = noteElement.dataset.noteId;
    if (!noteId) {
        throw new Error('Note element missing data-note-id attribute in move drag handler');
    }

    if (event.clientX === undefined || event.clientY === undefined) {
        throw new Error(`Invalid MouseEvent: missing coordinates (type: ${event.type})`);
    }

    moduleState.moveDragContext = {
        noteId,
        startX: event.clientX,
        startY: event.clientY,
        dragActive: false,
        hasCrossedActivationThreshold: false,
    };
}

function handleMoveDragMouseMove(event) {
    const context = moduleState.moveDragContext;
    if (!context) {
        return;
    }
    if (!event) {
        throw new Error('handleMoveDragMouseMove called without an event object');
    }
    if (event.clientX === undefined || event.clientY === undefined) {
        throw new Error(`Invalid MouseEvent: missing coordinates (type: ${event.type})`);
    }

    const dx = event.clientX - context.startX;
    const dy = event.clientY - context.startY;
    const nextGestureState = updateMoveDragGestureState(
        {
            dragActive: context.dragActive,
            hasCrossedActivationThreshold: context.hasCrossedActivationThreshold,
        },
        { dx, dy },
    );
    const shouldBeActive = nextGestureState.dragActive;
    // Crossing is recorded once per gesture, even if later movements stay past
    // the threshold or return to the origin.
    if (!context.hasCrossedActivationThreshold && nextGestureState.hasCrossedActivationThreshold) {
        context.hasCrossedActivationThreshold = true;
    }

    if (shouldBeActive && !context.dragActive) {
        context.dragActive = true;
        setMoveDragCursorActive(true);
    }
    if (!shouldBeActive && context.dragActive) {
        context.dragActive = false;
        setMoveDragCursorActive(false);
    }

    if (context.dragActive) {
        event.preventDefault();
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
            selection.removeAllRanges();
        }
    }
}

function resolveDragDirection(dx, dy) {
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX > absY) {
        return dx > 0 ? 'right' : 'left';
    }
    return dy > 0 ? 'down' : 'up';
}

function getDirectSiblingNotes(noteElement) {
    const container = noteElement.parentElement;
    if (!container) {
        throw new Error('Dragged note is missing its sibling container');
    }
    return Array.from(container.children).filter((child) => (
        child instanceof HTMLElement && child.classList.contains('note')
    ));
}

function getAdjacentSiblingNoteId(noteElement, direction) {
    if (direction !== 'previous' && direction !== 'next') {
        throw new Error('getAdjacentSiblingNoteId direction must be previous or next');
    }

    let cursor = direction === 'previous' ? noteElement.previousElementSibling : noteElement.nextElementSibling;
    while (cursor && !cursor.classList.contains('note')) {
        cursor = direction === 'previous' ? cursor.previousElementSibling : cursor.nextElementSibling;
    }

    if (!cursor) {
        return null;
    }
    return DOMUtils.getNoteId(cursor);
}

function getNormalizedParentId(noteElement) {
    const rawParentId = noteElement.dataset.parentId;
    if (typeof rawParentId !== 'string' || rawParentId.length === 0) {
        return null;
    }
    return rawParentId;
}

function getHoveredDirectSiblingNoteId(noteElement, eventTarget) {
    if (!(eventTarget instanceof Node)) {
        return null;
    }

    const siblingNotes = getDirectSiblingNotes(noteElement);
    for (const siblingNote of siblingNotes) {
        if (siblingNote === noteElement) {
            continue;
        }
        if (siblingNote.contains(eventTarget)) {
            return DOMUtils.getNoteId(siblingNote);
        }
    }

    return null;
}

function resolveVerticalMoveDestination(noteId, dropY, dragDirection, eventTarget) {
    if (!noteId) {
        throw new Error('resolveVerticalMoveDestination requires noteId');
    }
    if (typeof dropY !== 'number' || Number.isNaN(dropY)) {
        throw new Error('resolveVerticalMoveDestination requires numeric dropY');
    }
    if (dragDirection !== 'up' && dragDirection !== 'down') {
        throw new Error('resolveVerticalMoveDestination requires dragDirection up|down');
    }

    const noteElement = DOMUtils.getNoteById(noteId);
    const siblingPlacements = getDirectSiblingNotes(noteElement)
        .filter((element) => element !== noteElement)
        .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
                id: DOMUtils.getNoteId(element),
                midY: rect.top + (rect.height / 2),
            };
        });

    return resolveVerticalSiblingDropDestination({
        siblingPlacements,
        dropY,
        currentPrevId: getAdjacentSiblingNoteId(noteElement, 'previous'),
        currentNextId: getAdjacentSiblingNoteId(noteElement, 'next'),
        parentId: getNormalizedParentId(noteElement),
        hoveredSiblingId: getHoveredDirectSiblingNoteId(noteElement, eventTarget),
        dragDirection,
    });
}

function handleMoveDragMouseUp(event) {
    const context = moduleState.moveDragContext;
    if (!context) {
        return;
    }
    if (!event) {
        throw new Error('handleMoveDragMouseUp called without an event object');
    }
    if (typeof event.button !== 'number') {
        throw new Error(`Invalid MouseEvent: missing button (type: ${event.type})`);
    }
    if (event.button !== 0) {
        return;
    }
    if (event.clientX === undefined || event.clientY === undefined) {
        throw new Error(`Invalid MouseEvent: missing coordinates (type: ${event.type})`);
    }

    moduleState.moveDragContext = null;
    if (context.dragActive) {
        setMoveDragCursorActive(false);
    }

    const dx = event.clientX - context.startX;
    const dy = event.clientY - context.startY;
    const distanceSq = dx * dx + dy * dy;
    if (context.hasCrossedActivationThreshold) {
        moduleState.ignoreClickAfterMoveDrag = {
            ignoreUntil: performance.now() + 500,
        };
        event.preventDefault();
        event.stopPropagation();
    }

    if (distanceSq < MOVE_DRAG_COMMIT_THRESHOLD_SQ) {
        return;
    }

    if (ModeContext.isEditing) {
        return;
    }

    const direction = resolveDragDirection(dx, dy);

    if (!ModeContext.isConnected) {
        Logger.logNoop('Move drag ignored while disconnected from server', {
            noteId: context.noteId,
            direction,
            isConnected: false,
        });
        return;
    }

    if (!context.noteId) {
        throw new Error('Move drag context missing noteId on mouseup');
    }

    if (direction === 'up' || direction === 'down') {
        const destination = resolveVerticalMoveDestination(context.noteId, event.clientY, direction, event.target);
        if (!destination) {
            return;
        }
        void CommandGate.run(`mouse.drag_reorder_${direction}`, async () => {
            await moveNoteToSiblingPosition(
                context.noteId,
                destination.siblingId,
                destination.position,
                destination.newParentId,
            );
        });
        return;
    }
    if (direction === 'right') {
        void CommandGate.run('mouse.drag_indent', async () => {
            await indentNote(context.noteId);
        });
        return;
    }
    if (direction === 'left') {
        void CommandGate.run('mouse.drag_outdent', async () => {
            await outdentNote(context.noteId);
        });
        return;
    }

    Logger.logNoop('Move drag resolved to unknown direction', {
        noteId: context.noteId,
        dx,
        dy,
    });
}

function handleSelectionDragMouseUp(event) {
    if (!event) {
        throw new Error('handleSelectionDragMouseUp called without an event object');
    }
    if (typeof event.button !== 'number') {
        throw new Error(`Invalid MouseEvent: missing button (type: ${event.type})`);
    }
    if (event.button !== 0) {
        return;
    }
    if (!event.target) {
        throw new Error('Selection drag mouseup missing target element');
    }

    const context = moduleState.selectionDragContext;
    if (!context) return;
    moduleState.selectionDragContext = null;

    if (!ModeContext.isEditing || ModeContext.currentNoteId !== context.noteId) {
        return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return;
    }

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode) {
        throw new Error('Selection missing anchorNode/focusNode after selection drag');
    }

    if (!context.noteContent.contains(anchorNode) || !context.noteContent.contains(focusNode)) {
        return;
    }

    const releasedOutsideContent = !event.target.closest('.note-content');
    if (!releasedOutsideContent) {
        return;
    }

    moduleState.ignoreClickAfterSelectionDrag = {
        noteId: context.noteId,
        ignoreUntil: performance.now() + 500,
    };
}

function handleCollapseToggleMouseDown(event) {
    if (!event) {
        throw new Error('handleCollapseToggleMouseDown called without an event object');
    }

    if (!event.target) {
        throw new Error('Collapse toggle mousedown missing target element');
    }

    if (typeof event.button !== 'number') {
        throw new Error(`Invalid MouseEvent: missing button (type: ${event.type})`);
    }

    if (event.button !== 0) {
        return;
    }

    const collapseToggle = event.target.closest('.note-collapse-toggle');
    if (!collapseToggle) {
        return;
    }

    const noteElement = collapseToggle.closest('.note');
    if (!noteElement) {
        throw new Error('Collapse toggle mousedown missing parent note element');
    }

    if (ModeContext.isLoading) {
        Logger.logNoop('Collapse toggle mousedown ignored while system is loading', {
            eventType: event.type,
            isLoading: true
        });
        return;
    }

    if (!ModeContext.isConnected) {
        Logger.logNoop('Collapse toggle mousedown ignored while disconnected from server', {
            eventType: event.type,
            targetElement: collapseToggle.tagName,
            isConnected: false
        });
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    rememberMouseDownHandledClick(noteElement, 'collapse_toggle');
    handleCollapseToggleInteraction(event, collapseToggle, 'mousedown');
}

function handleClick(event) {
    if (!event) {
        throw new Error('handleClick called without an event object');
    }
        
    if (event.clientX === undefined || event.clientY === undefined) {
        throw new Error(`Invalid MouseEvent: missing coordinates (type: ${event.type})`);
    }
        
    if (!event.target) {
        throw new Error('Click event missing target element');
    }

    // Consume the gesture before any target-specific early return. Holding the
    // mouse button does not expire an action already performed on mousedown.
    if (consumeClickAfterMouseDownAction(event)) return;

    if (event.target instanceof Element && event.target.closest('.modal')) {
        return;
    }

    if (isContextMenuInteractionTarget(event.target)) {
        return;
    }
    if (isShellInteractiveTarget(event.target)) {
        return;
    }

    const footnoteButton = event.target instanceof Element
        ? event.target.closest('.meta-footnote-link')
        : null;
    if (footnoteButton) {
        event.preventDefault();
        event.stopPropagation();
        void CommandGate.run('mouse.footnote', async () => {
            await navigateToFootnoteWithExpansion(footnoteButton, expandNote, (id) => DOMUtils.getNoteById(id));
        });
        return;
    }

    const proposalAction = event.target instanceof Element
        ? event.target.closest(TAG_PROPOSAL_ACTION_SELECTOR)
        : null;
    if (proposalAction) {
        const noteId = proposalAction.dataset.noteId;
        const proposal = proposalAction.dataset.proposal;
        const action = proposalAction.dataset.proposalAction;
        if (typeof noteId !== 'string' || noteId.length === 0) {
            throw new Error('Tag proposal action missing note id');
        }
        if (typeof proposal !== 'string' || proposal.length === 0) {
            throw new Error('Tag proposal action missing proposal');
        }
        if (action !== 'accept' && action !== 'reject') {
            throw new Error('Tag proposal action must be accept or reject');
        }
        if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
            throw new Error('Tag proposal action requires the target note to be actively edited');
        }
        event.preventDefault();
        event.stopPropagation();
        void CommandGate.run(`tagProposal.${action}`, async () => {
            if (ModeContext.editSessionHasEdits) {
                await actionSaveNote(noteId);
            }
            if (action === 'accept') {
                await NotesAPI.acceptTagProposal(noteId, proposal);
            } else {
                await NotesAPI.rejectTagProposal(noteId, proposal);
            }
            const { actionRefreshAndMaybeSelect } = await import('../actions/ui-actions.js');
            await actionRefreshAndMaybeSelect({
                startedAt: performance.now(),
                context: `tagProposal.${action}`,
                requireExecution: true,
            });
        });
        return;
    }

    if (ModeContext.isLoading) {
        Logger.logNoop('Click event ignored while system is loading', {
            eventType: event.type,
            targetElement: event.target.tagName,
            isLoading: true
        });
        return; 
    }

    if (moduleState.ignoreClickAfterMoveDrag && performance.now() > moduleState.ignoreClickAfterMoveDrag.ignoreUntil) {
        moduleState.ignoreClickAfterMoveDrag = null;
    }
    if (moduleState.ignoreClickAfterMoveDrag) {
        moduleState.ignoreClickAfterMoveDrag = null;
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    if (
        moduleState.ignoreClickAfterSelectionDrag &&
        moduleState.ignoreClickAfterSelectionDrag.noteId === ModeContext.currentNoteId &&
        performance.now() <= moduleState.ignoreClickAfterSelectionDrag.ignoreUntil
    ) {
        if (moduleState.ignoreClickAfterSelectionDrag !== null) moduleState.ignoreClickAfterSelectionDrag = null;
        event.preventDefault();
        event.stopPropagation();
        return;
    }

    if (handleReferenceSourceIndicatorClick(event)) {
        return;
    }

    if (handleAiChatOpenAllReferencesClick(event)) {
        return;
    }

    if (handleFileReferenceClick(event)) {
        return;
    }

    if (handleBacklinksLinkClick(event)) {
        return;
    }

    if (handleReferenceLinkClick(event)) {
        return;
    }

    if (handleBacklinkItemClick(event)) {
        return;
    }

    if (event.target.closest('#backlinks-panel')) {
        return;
    }

    if (handleTodoToggleClick(event)) {
        return;
    }

    if (handleCredentialCopyClick(event)) {
        return;
    }

    if (handleEmailClick(event)) {
        return;
    }

    if (handleCopyableClick(event)) {
        return;
    }

    if (handleShellRunClick(event)) {
        return;
    }

    // Specific in-app link actions above keep their behavior. Ordinary anchors
    // use browser navigation without also selecting their host note for editing.
    if (isViewModeNoteLink(event.target)) {
        return;
    }

    const rootSortIndicator = event.target.closest('#root-sort-indicator');
    if (rootSortIndicator) {
        event.preventDefault();
        event.stopPropagation();
        const clearButton = event.target.closest('#root-sort-indicator-clear');
        if (clearButton) {
            void CommandPalette.setSortMode('normal');
        }
        return;
    }

    const untaggedViewIndicator = event.target.closest('#untagged-view-indicator');
    if (untaggedViewIndicator) {
        event.preventDefault();
        event.stopPropagation();
        const clearButton = event.target.closest('#untagged-view-indicator-clear');
        if (clearButton) {
            void CommandPalette.setIsUntaggedView(false);
        }
        return;
    }

    const menuButton = event.target.closest('#menu-button');
    if (menuButton) {
        event.preventDefault();
        event.stopPropagation();
        void CommandPalette.toggle();
        return;
    }

    if (moduleState.ignoreClickAfterSelectionDrag !== null) moduleState.ignoreClickAfterSelectionDrag = null;

    const toolbarElement = event.target.closest('#rich-text-toolbar');
    if (toolbarElement) {
        Logger.logDebug('Click inside rich text toolbar', {
            eventType: event.type
        }, Logger.LogCategory.EVENT);
        return;
    }

    const fileReferenceInputElement = event.target.closest('#file-reference-input');
    if (fileReferenceInputElement) {
        Logger.logDebug('Click on hidden file reference input ignored', {
            eventType: event.type,
        }, Logger.LogCategory.EVENT);
        return;
    }

    const tagBarElement = event.target.closest('.note-tag-bar');
    if (tagBarElement) {
        const tagBarInput = event.target.closest('.note-tag-bar-input');
        if (tagBarInput && event.detail === 1) {
            const noteElement = tagBarInput.closest('.note');
            const noteId = noteElement?.dataset?.noteId;
            if (noteElement && noteId && ModeContext.isEditing && ModeContext.currentNoteId === noteId) {
                window.setTimeout(() => {
                    if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
                        return;
                    }
                    if (document.activeElement !== tagBarInput) {
                        return;
                    }

                    const value = typeof tagBarInput.value === 'string' ? tagBarInput.value : '';
                    const end = value.length;
                    const selectionStart = tagBarInput.selectionStart;
                    const selectionEnd = tagBarInput.selectionEnd;
                    if (selectionStart !== end || selectionEnd !== end) {
                        return;
                    }

                    normalizeTagBarForNewTag(noteElement, tagBarInput);
                    updateTagSuggestions(tagBarInput);
                }, 0);
            }
        }

        Logger.logDebug('Click inside tag bar', {
            eventType: event.type
        }, Logger.LogCategory.EVENT);
        return;
    }

    const tabContextsElement = event.target.closest('#search-contexts-list');
    if (tabContextsElement) {
        return;
    }
    
    // Check if we're disconnected from server
    if (!ModeContext.isConnected) {
        const noteContent = event.target.closest('.note-content');
        const searchField = event.target.closest('#search-input');
        const createButton = event.target.closest('.add-note');
        const collapseToggle = event.target.closest('.note-collapse-toggle');
        const collapsedChildrenIndicator = event.target.closest(COLLAPSED_CHILDREN_INDICATOR_SELECTOR);
        
        // Only allow certain actions when disconnected
        if (noteContent || createButton || collapseToggle || collapsedChildrenIndicator) {
            Logger.logNoop('Click event ignored while disconnected from server', {
                eventType: event.type,
                targetElement: event.target.tagName,
                isConnected: false
            });
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        // Allow clicking on search field even when disconnected
    }

    const coordinates = {
        x: event.clientX,
        y: event.clientY
    };

    const collapseToggle = event.target.closest('.note-collapse-toggle');
    if (collapseToggle) {
        handleCollapseToggleInteraction(event, collapseToggle, 'click');
        return;
    }

    const collapsedChildrenIndicator = event.target.closest(COLLAPSED_CHILDREN_INDICATOR_SELECTOR);
    if (collapsedChildrenIndicator) {
        handleCollapsedChildrenIndicatorClick(event, collapsedChildrenIndicator);
        return;
    }

    const noteContent = event.target.closest('.note-content');
    const noteShellSelectionTarget = resolveNonContentNoteSelectionTarget(event.target);
    const searchField = event.target.closest('#search-input');
    const createButton = event.target.closest('.add-note');
    const deleteButton = event.target.closest('#trash-can');

    if (deleteButton) {
                
        if (ModeContext.isSearching) {
            actionExitSearchMode();
        }

        const noteId = ModeContext.currentNoteId;
                
        if (noteId) {
            Logger.logDebug('Delete button clicked for current note', { 
                noteId,
                coordinates 
            }, Logger.LogCategory.EVENT);

            void CommandGate.run('mouse.delete', async () => {
                await deleteNote(noteId);
            });
        } else {
                        
            Logger.logNoop('Delete button clicked but no note is selected', { 
                coordinates 
            });
        }
    } else if (noteContent) {
        const noteElement = noteContent.closest('.note');
        if (!noteElement) {
            throw new Error('Found .note-content without parent .note element');
        }
        
        // Check if note is locked - don't allow interaction
        if (noteElement.classList.contains('locked')) {
            Logger.logNoop('Click on locked note ignored', {
                noteId: noteElement.dataset.noteId,
                reason: 'note_locked'
            });
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        const noteId = noteElement.dataset.noteId;
        if (!noteId) {
            throw new Error('Note element missing data-note-id attribute');
        }

        if (noteElement.classList.contains('search-redacted')) {
            const revealResult = revealRedactedNoteWithScrollPreservation(noteId);
            Logger.logAction('reveal search-redacted note', {
                noteId,
                result: revealResult.reason,
                revealedCount: revealResult.revealedCount,
                scopeNoteId: revealResult.scopeNoteId,
            });
            event.preventDefault();
            event.stopPropagation();
            return;
        }
                
        const rect = noteContent.getBoundingClientRect();
        if (!rect || typeof rect.left !== 'number' || typeof rect.right !== 'number' || 
                typeof rect.top !== 'number' || typeof rect.bottom !== 'number') {
            throw new Error(`Invalid bounding rect for note content: ${JSON.stringify(rect)}`);
        }
                
        const isWithinBounds = (
            coordinates.x >= rect.left &&
            coordinates.x <= rect.right &&
            coordinates.y >= rect.top &&
            coordinates.y <= rect.bottom
        );
                
        if (isWithinBounds) {
            if (ModeContext.isSearching) {
                console.log('DEBUG: About to call exitSearchMode', {
                    isSearching: ModeContext.isSearching,
                    where: 'click in note'
                });
                actionExitSearchMode();
            } else {
                console.log('DEBUG: Search mode already inactive', {
                    isSearching: ModeContext.isSearching,
                    where: 'click in note'
                });
            }

            if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
                // Don't calculate or save cursor position when entering edit mode
                // The click position on rendered content (e.g., LaTeX) doesn't map meaningfully
                // to cursor position in source text

                if (ModeContext.currentNoteId) {
                    void CommandGate.run('mouse.switch_note', async () => {
                        await actionSwitchNotes(noteId, { initialCaretVisibility: 'hidden' });
                    });
                } else {
                    void CommandGate.run('mouse.select_note', async () => {
                        await actionSelectNote(noteId, { initialCaretVisibility: 'hidden' });
                    });
                }

                Logger.logDebug('Click in note content - selecting note', {
                    noteId,
                    coordinates,
                    isEditing: true
                }, Logger.LogCategory.EVENT);
            } else {
                // Clicking again in the selected note should only reveal the caret once.
                if (ModeContext.isCaretHidden && ModeContext.currentNoteId === noteId) {
                    DOMUtils.revealCaret(noteElement);
                    ModeContext.markCaretVisible();
                }

                Logger.logNoop('Click in already selected note - no action needed', {
                    noteId,
                    coordinates,
                    isEditing: true
                });
            }
        } else {
			            
			if (ModeContext.isEditing) {
				void CommandGate.run('mouse.deselect', async () => {
					await actionDeselectNote();
				});
			}
                        
            Logger.logDebug('Click near note but outside content bounds', {
                noteId,
                coordinates,
                elementBounds: {
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom
                },
                isEditing: false
            }, Logger.LogCategory.EVENT);
        }
	} else if (noteShellSelectionTarget) {
        const noteElement = noteShellSelectionTarget;

        if (noteElement.classList.contains('locked')) {
            Logger.logNoop('Click on locked note ignored', {
                noteId: noteElement.dataset.noteId,
                reason: 'note_locked'
            });
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        const noteId = noteElement.dataset.noteId;
        if (!noteId) {
            throw new Error('Note shell selection target missing data-note-id attribute');
        }

        if (noteElement.classList.contains('search-redacted')) {
            const revealResult = revealRedactedNoteWithScrollPreservation(noteId);
            Logger.logAction('reveal search-redacted note', {
                noteId,
                result: revealResult.reason,
                revealedCount: revealResult.revealedCount,
                scopeNoteId: revealResult.scopeNoteId,
            });
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        if (ModeContext.isSearching) {
            console.log('DEBUG: About to call exitSearchMode', {
                isSearching: ModeContext.isSearching,
                where: 'click in note shell'
            });
            actionExitSearchMode();
        } else {
            console.log('DEBUG: Search mode already inactive', {
                isSearching: ModeContext.isSearching,
                where: 'click in note shell'
            });
        }

        if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
            if (ModeContext.currentNoteId) {
                void CommandGate.run('mouse.switch_note', async () => {
                    await actionSwitchNotes(noteId, { initialCaretVisibility: 'hidden' });
                });
            } else {
                void CommandGate.run('mouse.select_note', async () => {
                    await actionSelectNote(noteId, { initialCaretVisibility: 'hidden' });
                });
            }

            Logger.logDebug('Click in note shell - selecting note', {
                noteId,
                coordinates,
                isEditing: true
            }, Logger.LogCategory.EVENT);
        } else {
            // Clicking again in the selected note shell should only reveal the caret once.
            if (ModeContext.isCaretHidden && ModeContext.currentNoteId === noteId) {
                DOMUtils.revealCaret(noteElement);
                ModeContext.markCaretVisible();
            }

            Logger.logNoop('Click in already selected note shell - no action needed', {
                noteId,
                coordinates,
                isEditing: true
            });
        }
	} else if (searchField) {
		void CommandGate.run('mouse.enter_search_mode', async () => {
			await actionEnterSearchMode();
		});
	                
		Logger.logDebug('Click in search field', { coordinates }, Logger.LogCategory.EVENT);
	} else if (createButton) {
        
        if (ModeContext.isLoading) {
            Logger.logNoop('Create button clicked while system is loading - ignoring', {
                coordinates,
                isLoading: true
            });
            return; 
        }
                
        if (ModeContext.isSearching) {
            console.log('DEBUG: About to call exitSearchMode', { 
                isSearching: ModeContext.isSearching, 
                where: 'create note button' 
            });
            actionExitSearchMode();
        } else {
            console.log('DEBUG: Search mode already inactive', { 
                isSearching: ModeContext.isSearching, 
                where: 'create note button' 
            });
        }
                
        Logger.logDebug('Create note button clicked', { coordinates }, Logger.LogCategory.EVENT);
		void CommandGate.run('mouse.create_note', async () => {
			await createNote();
		});
	} else {

		if (ModeContext.isEditing) {
			void CommandGate.run('mouse.deselect', async () => {
				await actionDeselectNote();
			});
			            
			Logger.logDebug('Click outside any note - exiting edit mode', {
				coordinates,
                isEditing: false,
                currentNoteId: null
            }, Logger.LogCategory.EVENT);
        }

        if (ModeContext.isSearching) {
            console.log('DEBUG: About to call exitSearchMode', { 
                isSearching: ModeContext.isSearching, 
                where: 'click outside handler' 
            });
            actionExitSearchMode();
        } else {
            console.log('DEBUG: Search mode already inactive', { 
                isSearching: ModeContext.isSearching, 
                where: 'click outside handler' 
            });
        }
    }
}

function handleAiChatOpenAllReferencesClick(event) {
    if (!event.target) {
        throw new Error('AI reference collection click missing target element');
    }
    const link = event.target.closest('.ai-chat-open-all-references');
    if (!link) {
        return false;
    }

    event.preventDefault();
    event.stopPropagation();

    const isCopiedAiResponse = link.closest(
        '.ai-chat-message-content[data-markdown-rendered="true"]',
    ) !== null;
    if (ModeContext.isEditing && !isCopiedAiResponse) {
        return true;
    }
    if (!ModeContext.isConnected) {
        Logger.logNoop('AI reference collection click ignored while disconnected', {
            isConnected: false,
        });
        return true;
    }

    const referenceQuery = link.dataset.refQuery;
    if (typeof referenceQuery !== 'string' || referenceQuery.length === 0) {
        throw new Error('AI reference collection link missing reference query');
    }

    void CommandGate.run('mouse.open_reference_collection_in_new_tab', async () => {
        if (ModeContext.isEditing) {
            await actionDeselectNote();
        }
        await openReferenceQueryInNewTab(referenceQuery);
    });
    return true;
}

function handleBacklinksLinkClick(event) {
    const link = event.target.closest('.note-backlinks-link');
    if (!link) {
        return false;
    }
    event.preventDefault();
    event.stopPropagation();
    if (ModeContext.isEditing || !ModeContext.isConnected) {
        return true;
    }
    const sourceNoteId = link.dataset.sourceNoteId;
    if (typeof sourceNoteId !== 'string' || sourceNoteId.length === 0) {
        throw new Error('Backlinks arrow missing source note id');
    }
    void CommandGate.run('mouse.open_backlinks', async () => {
        await openBacklinksInNewTab(sourceNoteId);
    });
    return true;
}

function handleReferenceLinkClick(event) {
    if (!event.target) {
        throw new Error('Reference interaction missing target element');
    }
    const link = event.target.closest('.note-reference-link');
    if (!link) {
        return false;
    }

    event.preventDefault();
    event.stopPropagation();

    const isCopiedAiResponse = link.closest(
        '.ai-chat-message-content[data-markdown-rendered="true"]',
    ) !== null;
    if (ModeContext.isEditing && !isCopiedAiResponse) {
        return true;
    }
    if (!ModeContext.isConnected) {
        Logger.logNoop('Reference link click ignored while disconnected', {
            isConnected: false,
        });
        return true;
    }

    const referenceQueryElement = link.closest('[data-ref-query]');
    if (referenceQueryElement) {
        const referenceQuery = referenceQueryElement.dataset.refQuery;
        if (typeof referenceQuery !== 'string' || referenceQuery.length === 0) {
            throw new Error('AI reference link missing exact evidence query');
        }
        void CommandGate.run('mouse.open_ai_reference_in_new_tab', async () => {
            if (ModeContext.isEditing) {
                await actionDeselectNote();
            }
            await openReferenceQueryInNewTab(referenceQuery);
        });
        return true;
    }

    const container = link.closest('.note-reference-block');
    if (!container) {
        throw new Error('Reference interaction missing .note-reference-block container');
    }
    const referenceNoteId = container.dataset.refNoteId;
    if (typeof referenceNoteId !== 'string' || referenceNoteId.length === 0) {
        throw new Error('Reference link missing target note id');
    }

    void CommandGate.run('mouse.open_reference_in_new_tab', async () => {
        await openReferenceInNewTab(referenceNoteId);
    });
    return true;
}

function handleFileReferenceClick(event) {
    if (!event.target) {
        throw new Error('File reference click missing target element');
    }

    const button = event.target.closest('.note-file-reference-link, .note-file-image-download-link');
    if (!button) {
        return false;
    }

    event.preventDefault();
    event.stopPropagation();

    if (ModeContext.isEditing) {
        return true;
    }
    if (!ModeContext.isConnected) {
        Logger.logNoop('File reference click ignored while disconnected', {
            isConnected: false,
        });
        return true;
    }

    const fileId = button.dataset.fileRefId;
    if (typeof fileId !== 'string' || fileId.length === 0) {
        throw new Error('File reference click missing file id');
    }

    void CommandGate.run('mouse.download_file_reference', async () => {
        await downloadFileReference(fileId);
    });
    return true;
}

function handleReferenceSourceIndicatorClick(event) {
    if (!event.target) {
        throw new Error('Reference source indicator click missing target element');
    }

    const indicator = event.target.closest('#reference-source-indicator');
    if (!indicator) {
        return false;
    }

    event.preventDefault();
    event.stopPropagation();

    const clearButton = event.target.closest('#reference-source-indicator-clear');
    if (!clearButton) {
        return true;
    }

    if (!ModeContext.isConnected) {
        Logger.logNoop('Reference source indicator close ignored while disconnected', {
            isConnected: false,
        });
        return true;
    }

    void CommandGate.run('mouse.reference_source_close', async () => {
        await navigateBackFromReferenceContext();
    });
    return true;
}

function handleBacklinkItemClick(event) {
    if (!event.target) {
        throw new Error('Backlink click missing target element');
    }

    const backlinkItem = event.target.closest('.backlink-item');
    if (!backlinkItem) {
        return false;
    }

    event.preventDefault();
    event.stopPropagation();

    if (!ModeContext.isConnected) {
        Logger.logNoop('Backlink click ignored while disconnected', {
            isConnected: false,
        });
        return true;
    }

    const noteId = backlinkItem.dataset.backlinkNoteId;
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('Backlink click missing data-backlink-note-id');
    }

    void CommandGate.run('mouse.open_backlink_in_new_tab', async () => {
        await openReferenceInCurrentTab(noteId);
    });
    return true;
}

function handleTodoToggleClick(event) {
    if (!event) {
        throw new Error('handleTodoToggleClick called without an event object');
    }
    if (!event.target) {
        throw new Error('Todo toggle click missing target element');
    }

    const toggleElement = event.target.closest(STATUS_TOGGLE_SELECTOR);
    if (!toggleElement) {
        return false;
    }

    if (!ModeContext.isConnected) {
        return false;
    }

    const noteElement = toggleElement.closest('.note');
    if (!noteElement) {
        throw new Error('Todo toggle missing parent note element');
    }
    if (noteElement.classList.contains('locked') || noteElement.classList.contains('search-redacted')) {
        return false;
    }

    const noteId = noteElement.dataset.noteId;
    if (!noteId) {
        throw new Error('Todo toggle note missing data-note-id attribute');
    }

    event.preventDefault();
    event.stopPropagation();

    void CommandGate.run('mouse.toggle_todo', async () => {
        await toggleTodoDone(noteId);
    });

    return true;
}

function handleCredentialCopyClick(event) {
    if (!event) {
        throw new Error('handleCredentialCopyClick called without an event object');
    }
    if (!event.target) {
        throw new Error('Credential copy click missing target element');
    }

    const valueElement = event.target.closest(CREDENTIAL_VALUE_SELECTOR);
    if (!valueElement) {
        return false;
    }

    const copyValue = valueElement.dataset.copyValue;
    if (typeof copyValue !== 'string') {
        throw new Error('Credential value missing data-copy-value attribute');
    }

    event.preventDefault();
    event.stopPropagation();

    triggerCopyFeedback(valueElement, CREDENTIAL_COPY_CLASS);
    void copyTextToClipboard(copyValue, valueElement, CREDENTIAL_COPY_CLASS);
    Logger.logAction('credential.copy', { valueLength: copyValue.length });
    return true;
}

function handleEmailClick(event) {
    if (!event) {
        throw new Error('handleEmailClick called without an event object');
    }
    if (!event.target) {
        throw new Error('Email click missing target element');
    }

    const emailElement = event.target.closest(EMAIL_VALUE_SELECTOR);
    if (!emailElement) {
        return false;
    }

    if (ModeContext.isEditing) {
        return false;
    }

    event.stopPropagation();
    return true;
}

function handleCopyableClick(event) {
    if (!event) {
        throw new Error('handleCopyableClick called without an event object');
    }
    if (!event.target) {
        throw new Error('Copyable click missing target element');
    }

    const copyableElement = event.target.closest(COPYABLE_SELECTOR);
    if (!copyableElement) {
        return false;
    }

    if (ModeContext.isEditing) {
        return false;
    }

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
        return false;
    }

    if (event.target.closest('a')) {
        return false;
    }

    let copyValue = '';
    if (typeof copyableElement.dataset.copyValue === 'string') {
        copyValue = copyableElement.dataset.copyValue;
    } else if (copyableElement.textContent !== null) {
        copyValue = copyableElement.textContent;
    }

    copyValue = normalizeCopyableText(copyValue);
    if (copyValue === '') {
        return false;
    }

    event.preventDefault();
    event.stopPropagation();

    void copyTextToClipboard(copyValue, copyableElement, COPYABLE_COPY_CLASS);
    Logger.logAction('copyable.copy', { valueLength: copyValue.length });
    return true;
}

function normalizeCopyableText(text) {
    if (typeof text !== 'string') {
        return '';
    }
    const normalized = text.replace(/\u00a0/g, ' ');
    if (!normalized.includes('\n')) {
        return normalized.trimStart();
    }
    const lines = normalized.split('\n');
    const nonEmpty = lines.filter((line) => line.trim() !== '');
    if (nonEmpty.length === 0) {
        return normalized;
    }
    const indents = nonEmpty.map((line) => line.match(/^[ \\t]*/)[0].length);
    const minIndent = Math.min(...indents);
    if (minIndent <= 0) {
        return normalized;
    }
    return lines
        .map((line) => (line.startsWith(' '.repeat(minIndent)) ? line.slice(minIndent) : line))
        .join('\n');
}

function delayShellPoll() {
    return new Promise((resolve) => {
        window.setTimeout(resolve, SHELL_POLL_INTERVAL_MS);
    });
}

async function runShellSession(shellElement, outputElement, noteId) {
    if (!(shellElement instanceof HTMLElement)) {
        throw new Error('runShellSession requires shellElement');
    }
    if (!(outputElement instanceof HTMLElement)) {
        throw new Error('runShellSession requires outputElement');
    }
    if (typeof noteId !== 'string' || noteId === '') {
        throw new Error('runShellSession requires noteId');
    }

    let snapshot = await runShellNote(noteId, SHELL_RUN_TIMEOUT_SECONDS);
    ensureShellOutputStructure(outputElement, noteId);
    renderShellSnapshot(outputElement, shellElement, snapshot);
    const runId = snapshot.runId;
    if (typeof runId !== 'string' || runId === '') {
        return;
    }

    while (snapshot.status === 'running') {
        await delayShellPoll();
        snapshot = await getShellRun(noteId, runId);
        renderShellSnapshot(outputElement, shellElement, snapshot);
    }
}

function handleShellRunClick(event) {
    if (!event) {
        throw new Error('handleShellRunClick called without an event object');
    }
    if (!event.target) {
        throw new Error('Shell run click missing target element');
    }
    const scriptElement = event.target.closest('.meta-shell-script');
    if (!scriptElement) {
        return false;
    }
    const shellElement = scriptElement.closest(SHELL_SELECTOR);
    if (!shellElement) {
        return false;
    }

    if (ModeContext.isEditing) {
        return false;
    }

    if (!ModeContext.isConnected) {
        return false;
    }

    if (shellElement.classList.contains(SHELL_RUNNING_CLASS)) {
        return true;
    }

    const noteElement = shellElement.closest('.note');
    if (!noteElement) {
        throw new Error('Shell click missing parent note element');
    }
    if (noteElement.classList.contains('locked') || noteElement.classList.contains('search-redacted')) {
        return false;
    }
    const noteId = noteElement.dataset.noteId;
    if (!noteId) {
        throw new Error('Shell click note missing data-note-id attribute');
    }

    event.preventDefault();
    event.stopPropagation();

    const outputElement = ensureShellOutputElement(shellElement);
    ensureShellOutputStructure(outputElement, noteId);
    renderShellSnapshot(outputElement, shellElement, {
        runId: '',
        status: 'running',
        exitCode: -1,
        stdout: '',
        stderr: '',
        durationMs: 0,
        errorMessage: '',
    });

    void runShellSession(shellElement, outputElement, noteId).catch((error) => {
            rethrowUnexpectedError(error);
        renderShellError(outputElement, shellElement, error);
        shellElement.classList.remove(SHELL_RUNNING_CLASS);
    });

    return true;
}

async function copyTextToClipboard(text, valueElement, feedbackClass) {
    if (typeof text !== 'string') {
        throw new Error('copyTextToClipboard requires a string');
    }
    if (typeof feedbackClass !== 'string' || feedbackClass === '') {
        throw new Error('copyTextToClipboard requires feedbackClass string');
    }

    const clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
        const writePromise = clipboard.writeText(text);
        if (writePromise && typeof writePromise.then === 'function') {
            const writeSucceeded = await writePromise
                .then(() => true)
                .catch((error) => {
            rethrowUnexpectedError(error);
                    let errorMessage = String(error);
                    if (error && typeof error.message === 'string') {
                        errorMessage = error.message;
                    }
                    Logger.logDebug('Clipboard writeText failed', {
                        error: errorMessage
                    }, Logger.LogCategory.EVENT);
                    return false;
                });

            if (writeSucceeded) {
                triggerCopyFeedback(valueElement, feedbackClass);
                return;
            }
        }
    }

    const body = document.body;
    if (!body) {
        throw new Error('Document body missing during clipboard fallback');
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';

    body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const execPromise = Promise.resolve().then(() => document.execCommand('copy'));
    const success = await execPromise
        .catch((error) => {
            rethrowUnexpectedError(error);
            let errorMessage = String(error);
            if (error && typeof error.message === 'string') {
                errorMessage = error.message;
            }
            Logger.logDebug('Clipboard fallback threw an error', {
                error: errorMessage
            }, Logger.LogCategory.EVENT);
            return false;
        })
        .finally(() => {
            body.removeChild(textarea);
        });

    if (!success) {
        Logger.logDebug('Clipboard fallback copy failed', {
            valueLength: text.length
        }, Logger.LogCategory.EVENT);
        return;
    }

    triggerCopyFeedback(valueElement, feedbackClass);
}

function triggerCopyFeedback(valueElement, feedbackClass) {
    if (!valueElement || !valueElement.classList) {
        return;
    }
    if (typeof feedbackClass !== 'string' || feedbackClass === '') {
        return;
    }

    if (!document.body.contains(valueElement)) {
        return;
    }

    const existingTimer = copyFeedbackTimers.get(valueElement);
    if (existingTimer) {
        window.clearTimeout(existingTimer);
    }

    const alreadyAnimating = valueElement.classList.contains(feedbackClass);
    if (!alreadyAnimating) {
        valueElement.classList.remove(feedbackClass);
        void valueElement.offsetWidth;
        valueElement.classList.add(feedbackClass);
    }

    const timer = window.setTimeout(() => {
        valueElement.classList.remove(feedbackClass);
    }, 700);
    copyFeedbackTimers.set(valueElement, timer);
}

function handleCollapseToggleInteraction(event, collapseToggle, interactionSource) {
    if (!collapseToggle) {
        throw new Error('handleCollapseToggleInteraction called without target collapse toggle');
    }

    if (event.clientX === undefined || event.clientY === undefined) {
        throw new Error(`Invalid MouseEvent: missing coordinates (type: ${event.type})`);
    }

    const noteElement = collapseToggle.closest('.note');
    if (!noteElement) {
        throw new Error('Collapse toggle activated without parent .note element');
    }

    const noteId = noteElement.dataset?.noteId;
    if (!noteId) {
        throw new Error('Collapse toggle activated without a parent note id');
    }

    const coordinates = {
        x: event.clientX,
        y: event.clientY
    };

    const isCurrentlyCollapsed = noteElement.dataset.isCollapsed === 'true';
    const canCollapse = noteElement.dataset.canCollapse !== 'false';

    Logger.logDebug(
        interactionSource === 'mousedown' ? 'Collapse toggle pressed' : 'Collapse toggle clicked',
        {
            noteId,
            isCurrentlyCollapsed,
            canCollapse,
            coordinates
        },
        Logger.LogCategory.EVENT
    );

    const searchInput = document.getElementById('search-input');
    if (searchInput && typeof searchInput.blur === 'function') {
        searchInput.blur();
    }
    if (ModeContext.isSearching) {
        actionExitSearchMode();
    }

    event.preventDefault();
    event.stopPropagation();

	if (isCurrentlyCollapsed) {
		void CommandGate.run('mouse.expand_note', async () => {
			await expandNote(noteId);
		});
		return;
	}

	if (canCollapse) {
		void CommandGate.run('mouse.collapse_note', async () => {
			await collapseNote(noteId);
		});
		return;
	}

    Logger.logNoop('Collapse toggle ignored: note cannot collapse', {
        noteId
    });
}

function handleCollapsedChildrenIndicatorClick(event, indicator) {
    if (!indicator) {
        throw new Error('handleCollapsedChildrenIndicatorClick called without indicator');
    }
    if (event.clientX === undefined || event.clientY === undefined) {
        throw new Error(`Invalid MouseEvent: missing coordinates (type: ${event.type})`);
    }

    const noteElement = indicator.closest('.note');
    if (!noteElement) {
        throw new Error('Collapsed children indicator activated without parent .note element');
    }

    const noteId = noteElement.dataset?.noteId;
    if (!noteId) {
        throw new Error('Collapsed children indicator activated without a parent note id');
    }

    event.preventDefault();
    event.stopPropagation();

    const searchInput = document.getElementById('search-input');
    if (searchInput && typeof searchInput.blur === 'function') {
        searchInput.blur();
    }
    if (ModeContext.isSearching) {
        actionExitSearchMode();
    }

    const isCurrentlyCollapsed = noteElement.dataset.isCollapsed === 'true';
    if (!isCurrentlyCollapsed) {
        Logger.logNoop('Collapsed children indicator ignored: note is already expanded', {
            noteId,
        });
        return;
    }

    Logger.logDebug('Collapsed children indicator clicked', {
        noteId,
        coordinates: {
            x: event.clientX,
            y: event.clientY,
        },
    }, Logger.LogCategory.EVENT);

    void CommandGate.run('mouse.expand_note', async () => {
        await expandNote(noteId);
    });
}

function handleMouseOver(event) {
    if (!event) {
        throw new Error('handleMouseOver called without an event object');
    }

    const target = event.target;
    if (!target) {
        throw new Error('Mouseover event missing target element');
    }

    if (target instanceof Element && target.closest('#search-input')) {
        hideSearchContextsOverlay();
        return;
    }

    const noteElement = target.closest('.note');
    if (!noteElement) {
        return;
    }

    const noteId = noteElement.dataset.noteId;
    if (!noteId) {
        throw new Error('Note element missing data-note-id attribute in handleMouseOver');
    }

    if (ModeContext.hoveredNoteId === noteId) {
        return;
    }

    ModeContext.setHoveredNoteId(noteId);
    const didHideSearchSuggestions = hideSearchSuggestionsForSearchContextHover({
        isSearching: ModeContext.isSearching,
        noteId,
        pointerClientY: event.clientY,
    });

    Logger.logDebug('Pointer entered note', {
        noteId,
        isEditing: ModeContext.isEditing,
        didHideSearchSuggestions,
    }, Logger.LogCategory.EVENT);
}

function handleSearchSuggestionsPointerMove(event) {
    if (!event) {
        throw new Error('handleSearchSuggestionsPointerMove called without an event object');
    }

    const didHideSearchSuggestions = hideSearchSuggestionsForSearchContextPointerMove({
        isSearching: ModeContext.isSearching,
        pointerClientX: event.clientX,
        pointerClientY: event.clientY,
    });

    if (!didHideSearchSuggestions) {
        return;
    }

    Logger.logDebug('Search suggestions hidden after pointer left search context', {
        pointerClientX: Math.round(event.clientX),
        pointerClientY: Math.round(event.clientY),
    }, Logger.LogCategory.EVENT);
}

function handleSearchContextsPointerMove(event) {
    if (!event) {
        throw new Error('handleSearchContextsPointerMove called without an event object');
    }

    const didHideSearchContexts = hideSearchContextsOverlayForPointerMove({
        pointerClientX: event.clientX,
        pointerClientY: event.clientY,
    });

    if (!didHideSearchContexts) {
        return;
    }

    Logger.logDebug('Search contexts hidden after pointer left hover bounds', {
        pointerClientX: Math.round(event.clientX),
        pointerClientY: Math.round(event.clientY),
    }, Logger.LogCategory.EVENT);
}

function handleMouseOut(event) {
    if (!event) {
        throw new Error('handleMouseOut called without an event object');
    }

    const target = event.target;
    if (!target) {
        throw new Error('Mouseout event missing target element');
    }

    const noteElement = target.closest('.note');
    if (!noteElement) {
        return;
    }

    const noteId = noteElement.dataset.noteId;
    if (!noteId) {
        throw new Error('Note element missing data-note-id attribute in handleMouseOut');
    }

    const relatedTarget = event.relatedTarget;
    if (relatedTarget && noteElement.contains(relatedTarget)) {
        return;
    }

    if (ModeContext.hoveredNoteId !== noteId) {
        return;
    }

    ModeContext.setHoveredNoteId(null);

    Logger.logDebug('Pointer left note', {
        noteId
    }, Logger.LogCategory.EVENT);
}
