import { ModeContextInstance as ModeContext } from '../mode-context.js';
import * as Logger from '../mode-logger.js';
import { sanitizeTags, validateAndRenderTagBar } from '../services/tag-bar-service.js';
import { hideSearchContextsOverlay } from '../services/search-contexts-overlay-service.js';
import { unlessDiagramEditorOpen } from '../../excalidraw/excalidraw-editor-state.js';

export function initFocusEvents() {
        
    document.addEventListener('focusin', unlessDiagramEditorOpen(handleFocus), { capture: true });
    document.addEventListener('focusout', unlessDiagramEditorOpen(handleBlur), { capture: true });
        
    Logger.logInit('Focus events handler (search only)');
}

function handleFocus(event) {
    if (!event) {
        throw new Error('handleFocus called without an event object');
    }
        
    if (!event.target) {
        throw new Error('Focus event missing target element');
    }

    if (ModeContext.isLoading) {
        Logger.logNoop('Focus event ignored while system is loading', {
            targetElement: event.target.tagName,
            isLoading: true
        });
        return;
    }
        
    const searchField = event.target.closest('#search-input');
        
    if (searchField) {
        hideSearchContextsOverlay();

        Logger.logDebug('Search field focused (no state change)');
    }
}

function handleBlur(event) {
    if (!event) {
        throw new Error('handleBlur called without an event object');
    }
        
    if (!event.target) {
        throw new Error('Blur event missing target element');
    }

    if (ModeContext.isLoading) {
        Logger.logNoop('Blur event ignored while system is loading', {
            targetElement: event.target.tagName,
            isLoading: true
        });
        return;
    }
        
    const searchField = event.target.closest('#search-input');
    const tagBarInput = event.target.closest('.note-tag-bar-input');
        
    if (searchField) {

        Logger.logDebug('Search field blurred (no state change)');
    }

    if (tagBarInput) {
        const noteElement = tagBarInput.closest('.note');
        if (!noteElement) {
            throw new Error('Found tag bar input without parent note element');
        }

        const noteId = noteElement.dataset?.noteId;
        if (!noteId) {
            throw new Error('Tag bar note element missing data-note-id');
        }

        if (!ModeContext.isEditingNote(noteId)) {
            return;
        }

		const rawTags = tagBarInput.value;
		if (typeof rawTags !== 'string') {
			throw new Error('Tag bar input value must be string');
		}
		const sanitized = sanitizeTags(rawTags);
		// Important: do NOT write sanitized tags into `noteElement.dataset.noteTags` here.
		// That dataset value represents the last server-saved tags; overwriting it on blur
		// would cause `actionSaveNote` to think tags were already persisted.
		if (sanitized != rawTags) {
			tagBarInput.value = sanitized;
		}
		validateAndRenderTagBar(noteElement);
	}
}
