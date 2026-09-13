import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { actionSelectNote } from '../actions/selection-actions.js';
import { DOMUtils } from '../../dom-utils.js';
import { enforceTagBarInputElement, validateAndRenderTagBar } from '../services/tag-bar-service.js';
import { scrollWindowToYFastAnimated } from '../services/animated-scroll-service.js';
import { initializeTagSuggestions, updateTagSuggestions } from '../services/tag-suggestions-service.js';

const moduleState = ApplicationState.createFields('input-events', {
    lastKeyPressed: null,
});

function scrollViewportToCenterRect(rect) {
    if (!rect || typeof rect.top !== 'number' || typeof rect.height !== 'number') {
        throw new Error('scrollViewportToCenterRect requires a DOMRect-like object');
    }

    const centerY = rect.top + rect.height / 2;
    const targetScrollY = Math.max(0, window.scrollY + centerY - window.innerHeight / 2);
    scrollWindowToYFastAnimated(Math.round(targetScrollY));
}

function getCaretRectWithin(element) {
    if (!element) {
        throw new Error('getCaretRectWithin requires an element');
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const containerElement = container && container.nodeType === Node.ELEMENT_NODE
        ? container
        : container?.parentElement;

    if (!containerElement || !element.contains(containerElement)) {
        return null;
    }

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.top === 0 && rect.bottom === 0 && rect.height === 0)) {
        return null;
    }
    return rect;
}

function ensureEditingCaretVisible(noteContentElement) {
    const caretRect = getCaretRectWithin(noteContentElement);

    let targetRect = caretRect;
    if (!targetRect) {
        targetRect = noteContentElement.getBoundingClientRect();
    }

    if (!targetRect || typeof targetRect.top !== 'number' || typeof targetRect.bottom !== 'number') {
        throw new Error('ensureEditingCaretVisible requires a measurable target rect');
    }

    const margin = 40;
    if (targetRect.bottom >= margin && targetRect.top <= window.innerHeight - margin) {
        return;
    }

    Logger.logDebug('Auto-scrolling to keep editing caret visible', {
        noteId: ModeContext.currentNoteId,
        hasCaretRect: Boolean(caretRect),
        rectTop: Math.round(targetRect.top),
        rectBottom: Math.round(targetRect.bottom),
    }, Logger.LogCategory.EVENT);

    scrollViewportToCenterRect(targetRect);
}

export function initInputEvents() {
        
    document.addEventListener('input', handleInput, { capture: true });
    initializeTagSuggestions();
        
    Logger.logInit('Input events handler');
}

function handleInput(event) {
    if (!event) {
        throw new Error('handleInput called without an event object');
    }
        
    if (!event.target) {
        throw new Error('Input event missing target element');
    }

    console.log('[InputEvents] Input event fired, last key:', ModeContext.lastKeyPressed, 
        'inputType:', event.inputType, 'data:', event.data);

    if (ModeContext.isLoading) {
        Logger.logNoop('Input event ignored while system is loading', {
            targetElement: event.target.tagName,
            targetValue: event.target.value?.length,
            isLoading: true
        });
        event.preventDefault();
        return;
    }
        
    const tagBarInput = event.target.closest('.note-tag-bar-input');
    if (tagBarInput) {
        if (event.isComposing) {
            return;
        }

        const noteElement = tagBarInput.closest('.note');
        if (!noteElement) {
            throw new Error('Found .note-tag-bar-input without parent .note element in input handler');
        }

        const noteId = noteElement.dataset.noteId;
        if (!noteId) {
            throw new Error('Tag bar note element missing data-note-id attribute in input handler');
        }

        if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
            throw new Error(`Tag bar input fired while not editing note ${noteId}`);
        }

        if (!ModeContext.editSessionHasEdits) ModeContext.markEditSessionHasEdits();
        enforceTagBarInputElement(tagBarInput);
        ensureEditingCaretVisible(tagBarInput);
        validateAndRenderTagBar(noteElement);
        updateTagSuggestions(tagBarInput);
        return;
    }

    const noteContent = event.target.closest('.note-content');
        
    if (noteContent) {
        const noteElement = noteContent.closest('.note');
        if (!noteElement) {
            throw new Error('Found .note-content without parent .note element in input handler');
        }
                
        const noteId = noteElement.dataset.noteId;
        if (!noteId) {
            throw new Error('Note element missing data-note-id attribute in input handler');
        }

		if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
			actionSelectNote(noteId, { initialCaretVisibility: 'hidden' });
			return; 
		}

        if (!ModeContext.editSessionHasEdits) ModeContext.markEditSessionHasEdits();

        ensureEditingCaretVisible(noteContent);

        // The first input after selecting a collapsed note reveals the caret; later inputs keep it visible.
        if (ModeContext.isCaretHidden) {
            DOMUtils.revealCaret(noteElement);
            ModeContext.markCaretVisible();
        }

        const currentHtmlContent = DOMUtils.getNoteContentHTML(noteElement);

        if (currentHtmlContent !== ModeContext.currentContent) {
                        
            ModeContext.setCurrentContent(currentHtmlContent);

            if (!ModeContext.isDirty) {
                ModeContext.setDirty(true);
                Logger.logDebug('Content marked as dirty due to typing', { 
                    key: event.data, 
                    noteId 
                }, Logger.LogCategory.STATE);
            }
                        
            Logger.logDebug('Note content changed', { 
                noteId,
                contentLength: currentHtmlContent.length
            }, Logger.LogCategory.EVENT);
        }
    } 
    // Search input handling is now done by search-events.js
}
