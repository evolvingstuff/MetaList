import { ApplicationState } from '../../application-state.js';
import { rethrowUnexpectedError } from '../../expected-errors.js';
import { NotesAPI } from '../../api-client.js';
import { DOMUtils } from '../../dom-utils.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { parseTagBarSuggestionContext } from './tag-syntax-service.js';

const SUGGESTION_DEBOUNCE_MS = 50;
const MAX_SUGGESTION_HEIGHT = 240;
const MIN_SUGGESTION_HEIGHT = 80;
const MIN_SPACE_FOR_DOWN = 160;
const POSITION_MARGIN = 12;

const moduleState = ApplicationState.createFields('tag-suggestions-service', {
    pendingTimer: null,
    requestSerial: 0,
    selectedIndex: -1,
    activeContainer: null,
    activeInput: null,
    initialized: false,
    activeRequestController: null,
});


function abortActiveRequest() {
    if (moduleState.activeRequestController) {
        moduleState.activeRequestController.abort();
        moduleState.activeRequestController = null;
    }
}

function cancelPendingRequests() {
    if (moduleState.pendingTimer) {
        clearTimeout(moduleState.pendingTimer);
        moduleState.pendingTimer = null;
    }
    moduleState.requestSerial += 1;
    abortActiveRequest();
}

function getTagSuggestionsContainer(tagBarInput) {
    if (!tagBarInput) {
        throw new Error('getTagSuggestionsContainer requires tagBarInput');
    }
    const tagBar = tagBarInput.closest('.note-tag-bar');
    if (!tagBar) {
        throw new Error('Tag bar missing for suggestions');
    }
    const container = tagBar.querySelector('.note-tag-suggestions');
    if (!container) {
        throw new Error('Tag suggestions container missing');
    }
    return { tagBar, container };
}

function hideSuggestions(container) {
    if (!container) {
        return;
    }
    container.hidden = true;
    container.style.display = 'none';
    container.innerHTML = '';
    // Rendering or dismissing an empty result list can observe no selection.
        if (moduleState.selectedIndex !== -1) moduleState.selectedIndex = -1;
    if (moduleState.activeContainer === container) {
        moduleState.activeContainer = null;
        moduleState.activeInput = null;
    }
}

function positionSuggestions(tagBar, container) {
    const rect = tagBar.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - POSITION_MARGIN;
    const spaceAbove = rect.top - POSITION_MARGIN;

    let placement = 'down';
    if (spaceBelow < MIN_SPACE_FOR_DOWN && spaceAbove > spaceBelow) {
        placement = 'up';
    }

    container.classList.toggle('is-up', placement === 'up');

    let available = placement === 'up' ? spaceAbove : spaceBelow;
    if (available > MAX_SUGGESTION_HEIGHT) {
        available = MAX_SUGGESTION_HEIGHT;
    }
    if (available < MIN_SUGGESTION_HEIGHT) {
        available = MIN_SUGGESTION_HEIGHT;
    }
    container.style.maxHeight = `${Math.floor(available)}px`;

    return placement;
}

function updateSelectedSuggestion(container) {
    const items = Array.from(container.querySelectorAll('.note-tag-suggestion'));
    if (items.length === 0) {
        // Rendering or dismissing an empty result list can observe no selection.
        if (moduleState.selectedIndex !== -1) moduleState.selectedIndex = -1;
        return;
    }
    if (moduleState.selectedIndex < 0 || moduleState.selectedIndex >= items.length) {
        // A new result snapshot can retain the first-item selection index.
    if (moduleState.selectedIndex !== 0) moduleState.selectedIndex = 0;
    }
    items.forEach((item, index) => {
        item.classList.toggle('is-selected', index === moduleState.selectedIndex);
    });
}

function applySuggestion(tagBarInput, suggestion) {
    if (!tagBarInput || typeof tagBarInput.value !== 'string') {
        throw new Error('applySuggestion requires tagBarInput element');
    }
    if (typeof suggestion !== 'string' || suggestion.length === 0) {
        throw new Error('applySuggestion requires suggestion string');
    }

    const rawValue = tagBarInput.value;
    if (!Number.isInteger(tagBarInput.selectionStart)) {
        throw new Error('tagBarInput.selectionStart missing');
    }
    const cursorIndex = tagBarInput.selectionStart;
    const context = parseTagBarSuggestionContext(rawValue, cursorIndex);
    if (!context) {
        return;
    }

    const before = rawValue.slice(0, context.replaceStart);
    const after = rawValue.slice(context.replaceEnd);
    const nextValue = `${before}${suggestion}${after}`;

    tagBarInput.value = nextValue;

    const nextCursor = before.length + suggestion.length;
    if (typeof tagBarInput.setSelectionRange === 'function') {
        tagBarInput.setSelectionRange(nextCursor, nextCursor);
    }

    tagBarInput.dispatchEvent(new Event('input', { bubbles: true }));
    tagBarInput.focus();

    const { container } = getTagSuggestionsContainer(tagBarInput);
    hideSuggestions(container);
}

function renderSuggestions(tagBarInput, suggestions) {
    const { tagBar, container } = getTagSuggestionsContainer(tagBarInput);
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
        hideSuggestions(container);
        return;
    }

    positionSuggestions(tagBar, container);

    container.innerHTML = '';
    for (const tag of suggestions) {
        if (typeof tag !== 'string' || tag.length === 0) {
            throw new Error('Tag suggestions must be non-empty strings');
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'note-tag-suggestion';
        button.dataset.tag = tag;
        button.textContent = tag;
        button.addEventListener('mousedown', (event) => {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            applySuggestion(tagBarInput, tag);
        });
        container.appendChild(button);
    }

    container.hidden = false;
    container.style.display = 'flex';
    container.scrollTop = 0;
    // A new result snapshot can retain the first-item selection index.
    if (moduleState.selectedIndex !== 0) moduleState.selectedIndex = 0;
    updateSelectedSuggestion(container);

    // New responses for the same editor reuse its DOM anchor; publish only
    // anchor changes observed with this suggestion snapshot.
    ApplicationState.receiveOwnerSnapshot(moduleState, { activeContainer: container, activeInput: tagBarInput });
}

export function updateTagSuggestions(tagBarInput) {
    if (!tagBarInput || typeof tagBarInput.value !== 'string') {
        throw new Error('updateTagSuggestions requires tagBarInput element');
    }
    if (document.activeElement !== tagBarInput) {
        cancelPendingRequests();
        const { container } = getTagSuggestionsContainer(tagBarInput);
        hideSuggestions(container);
        return;
    }

    if (!Number.isInteger(tagBarInput.selectionStart)) {
        throw new Error('tagBarInput.selectionStart missing');
    }

    const rawValue = tagBarInput.value;
    const cursorIndex = tagBarInput.selectionStart;
    const context = parseTagBarSuggestionContext(rawValue, cursorIndex);
    if (!context) {
        cancelPendingRequests();
        const { container } = getTagSuggestionsContainer(tagBarInput);
        hideSuggestions(container);
        return;
    }

    if (moduleState.pendingTimer) {
        clearTimeout(moduleState.pendingTimer);
    }
    abortActiveRequest();

    const requestId = ++moduleState.requestSerial;
    moduleState.pendingTimer = setTimeout(async () => {
        moduleState.pendingTimer = null;

        const noteElement = tagBarInput.closest('.note');
        if (!noteElement) {
            throw new Error('Tag bar input missing parent note element');
        }
        const noteId = noteElement.dataset.noteId;
        if (!noteId) {
            throw new Error('Tag bar note element missing data-note-id');
        }
        if (!ModeContext.isEditing || ModeContext.currentNoteId !== noteId) {
            const { container } = getTagSuggestionsContainer(tagBarInput);
            hideSuggestions(container);
            return;
        }

        const contentHtml = DOMUtils.getNoteContentHTML(noteElement);
        const requestController = new AbortController();
        moduleState.activeRequestController = requestController;
        const response = await NotesAPI.fetchTagSuggestions(
            noteId,
            context.anchors,
            context.explicitTags,
            context.prefix,
            contentHtml,
            requestController.signal
        ).catch((error) => {
            rethrowUnexpectedError(error);
            if (error && error.name === 'AbortError') {
                return null;
            }
            throw error;
        });
        if (moduleState.activeRequestController === requestController) {
            moduleState.activeRequestController = null;
        }
        if (response === null) {
            return;
        }
        if (!response || typeof response !== 'object') {
            throw new Error('Tag suggestions response missing');
        }
        if (!Array.isArray(response.suggestions)) {
            throw new Error('Tag suggestions response requires suggestions array');
        }
        if (requestId !== moduleState.requestSerial) {
            return;
        }
        renderSuggestions(tagBarInput, response.suggestions);
    }, SUGGESTION_DEBOUNCE_MS);
}

function handleDocumentMouseDown(event) {
    if (!event) {
        return;
    }
    if (!moduleState.activeContainer || moduleState.activeContainer.hidden) {
        return;
    }
    const target = event.target;
    if (target && typeof target.closest === 'function') {
        if (target.closest('.note-tag-bar')) {
            return;
        }
    }
    cancelPendingRequests();
    hideSuggestions(moduleState.activeContainer);
}

function handleFocusIn(event) {
    if (!event) {
        return;
    }
    const target = event.target;
    if (!target || typeof target.closest !== 'function') {
        return;
    }
    const tagBarInput = target.closest('.note-tag-bar-input');
    if (!tagBarInput) {
        return;
    }
    updateTagSuggestions(tagBarInput);
}

function handleFocusOut(event) {
    if (!event) {
        return;
    }
    const target = event.target;
    if (!target || typeof target.closest !== 'function') {
        return;
    }
    const tagBarInput = target.closest('.note-tag-bar-input');
    if (!tagBarInput) {
        return;
    }
    const { container } = getTagSuggestionsContainer(tagBarInput);
    cancelPendingRequests();
    hideSuggestions(container);
}

function handleKeyDown(event) {
    const target = event.target;
    if (!target || !(target instanceof HTMLElement)) {
        return;
    }
    if (!target.classList.contains('note-tag-bar-input')) {
        return;
    }

    const { container } = getTagSuggestionsContainer(target);
    if (container.hidden) {
        return;
    }

    const items = Array.from(container.querySelectorAll('.note-tag-suggestion'));
    if (items.length === 0) {
        return;
    }

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (moduleState.selectedIndex < items.length - 1) moduleState.selectedIndex += 1;
        updateSelectedSuggestion(container);
        return;
    }
    if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (moduleState.selectedIndex > 0) moduleState.selectedIndex -= 1;
        updateSelectedSuggestion(container);
        return;
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
            event.stopImmediatePropagation();
        }
        let button = items[moduleState.selectedIndex];
        if (!button) {
            button = items[0];
        }
        const tag = button.dataset.tag;
        if (typeof tag !== 'string' || tag.length === 0) {
            throw new Error('Suggestion tag missing from dataset');
        }
        applySuggestion(target, tag);
    }
}

function handleViewportChange() {
    if (!moduleState.activeContainer || moduleState.activeContainer.hidden || !moduleState.activeInput) {
        return;
    }
    const { tagBar, container } = getTagSuggestionsContainer(moduleState.activeInput);
    positionSuggestions(tagBar, container);
}

export function initializeTagSuggestions() {
    if (moduleState.initialized) {
        return;
    }
    moduleState.initialized = true;

    document.addEventListener('mousedown', handleDocumentMouseDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', handleFocusOut, true);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleViewportChange, true);
    window.addEventListener('resize', handleViewportChange);
}
