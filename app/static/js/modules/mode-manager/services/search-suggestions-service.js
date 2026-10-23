import { NO_SELECTION } from '../../list-selection.js';
import { ApplicationState } from '../../application-state.js';
import { isContextMenuOpen, isMacControlClick } from '../../context-menu/context-menu-service.js';
import { NotesAPI } from '../../api-client.js';
import { analyzeSearchQueryInput } from './search-syntax-service.js';
import { syncSearchInputValue } from './search-input-service.js';
import {
    getSearchSuggestionWindowDays,
    getShowSearchSuggestionWindowLabels,
} from './search-suggestion-windows-service.js';
import {
    buildSearchSuggestionPresentation,
} from './search-suggestion-window-labels-service.js';
import { escapeHtml } from '../../html-escape.js';

const SUGGESTION_DEBOUNCE_MS = 50;
const HOVER_DISMISS_BOTTOM_BUFFER_PX = 25;
// A backslash and the character it escapes.
const ESCAPE_SEQUENCE_LENGTH = 2;
const moduleState = ApplicationState.createFields('search-suggestions-service', {
    pendingTimer: null,
    requestSerial: 0,
    selectedIndex: NO_SELECTION,
    suppressSuggestionsUntilInputInteraction: false,
    // The search text the list on screen was built for. Once the text changes,
    // the list is for older text until the new one arrives.
    listBuiltForText: '',
});


function getSearchSuggestionsContainer() {
    const container = document.getElementById('search-suggestions');
    if (!container) {
        throw new Error('search-suggestions element missing from DOM');
    }
    return container;
}

function parseSuggestionContext(rawValue, cursorIndex) {
    if (typeof rawValue !== 'string') {
        throw new Error('parseSuggestionContext requires rawValue string');
    }
    if (!Number.isInteger(cursorIndex)) {
        throw new Error('parseSuggestionContext requires cursorIndex integer');
    }
    if (cursorIndex < 0 || cursorIndex > rawValue.length) {
        throw new Error('parseSuggestionContext cursorIndex out of bounds');
    }

    let quoteChar = null;
    let index = 0;
    while (index < cursorIndex) {
        const char = rawValue[index];
        if (char === '\\' && index + 1 < cursorIndex) {
            const nextChar = rawValue[index + 1];
            if (quoteChar && (nextChar === quoteChar || nextChar === '\\')) {
                index += ESCAPE_SEQUENCE_LENGTH;
                continue;
            }
        }
        if (quoteChar) {
            if (char === quoteChar) {
                quoteChar = null;
            }
            index += 1;
            continue;
        }
        if (char === '"' || char === "'") {
            quoteChar = char;
            index += 1;
            continue;
        }
        index += 1;
    }

    if (quoteChar) {
        return null;
    }

    let start = cursorIndex;
    while (start > 0 && !/\s/.test(rawValue[start - 1])) {
        start -= 1;
    }

    const token = rawValue.slice(start, cursorIndex);
    if (!token) {
        return {
            partialPrefix: '',
            prefixModifier: '',
            replaceStart: cursorIndex,
            replaceEnd: cursorIndex,
        };
    }

    // The modifier typed before the term (such as -), or none.
    let prefixModifier = '';
    let prefixValue = token;
    if (prefixValue[0] === '+' || prefixValue[0] === '-') {
        prefixModifier = prefixValue[0];
        prefixValue = prefixValue.slice(1);
    }

    if (!prefixValue) {
        return null;
    }

    return {
        partialPrefix: prefixValue,
        prefixModifier,
        replaceStart: start,
        replaceEnd: cursorIndex,
    };
}

function clearPendingSuggestionRequest() {
    if (moduleState.pendingTimer) {
        clearTimeout(moduleState.pendingTimer);
        moduleState.pendingTimer = null;
    }
    moduleState.requestSerial += 1;
}

function hideSuggestions(options) {
    let normalizedOptions = options;
    if (normalizedOptions === undefined) {
        normalizedOptions = {};
    }
    if (normalizedOptions === null || typeof normalizedOptions !== 'object') {
        throw new Error('hideSuggestions options must be an object');
    }
    if (normalizedOptions.suppressUntilInputInteraction === true) {
        // Repeated pointer moves while outside keep the same suppression episode.
        if (!moduleState.suppressSuggestionsUntilInputInteraction) moduleState.suppressSuggestionsUntilInputInteraction = true;
    }
    if (normalizedOptions.invalidateRequests === true) {
        clearPendingSuggestionRequest();
    }

    const container = getSearchSuggestionsContainer();
    container.hidden = true;
    container.style.display = 'none';
    container.innerHTML = '';
    // Rendering or dismissing an empty result list can observe no selection.
        if (moduleState.selectedIndex !== NO_SELECTION) moduleState.selectedIndex = NO_SELECTION;
}

function shouldHideForVerticalPointerPosition(container, pointerClientY) {
    if (!Number.isFinite(pointerClientY)) {
        throw new Error('pointerClientY must be finite');
    }
    if (typeof container.getBoundingClientRect !== 'function') {
        throw new Error('search-suggestions must support getBoundingClientRect()');
    }

    const suggestionsRect = container.getBoundingClientRect();
    if (!suggestionsRect || typeof suggestionsRect.bottom !== 'number') {
        throw new Error('search-suggestions rect missing bottom');
    }
    return pointerClientY > suggestionsRect.bottom + HOVER_DISMISS_BOTTOM_BUFFER_PX;
}

function shouldHideForHorizontalPointerPosition(pointerClientX) {
    if (!Number.isFinite(pointerClientX)) {
        throw new Error('pointerClientX must be finite');
    }

    const notesContainer = document.getElementById('notes-container');
    if (!notesContainer) {
        throw new Error('notes-container element missing from DOM');
    }
    if (typeof notesContainer.getBoundingClientRect !== 'function') {
        throw new Error('notes-container must support getBoundingClientRect()');
    }

    const notesRect = notesContainer.getBoundingClientRect();
    if (!notesRect || typeof notesRect.left !== 'number' || typeof notesRect.right !== 'number') {
        throw new Error('notes-container rect missing horizontal bounds');
    }
    if (pointerClientX < notesRect.left) {
        return true;
    }
    if (pointerClientX > notesRect.right) {
        return true;
    }
    return false;
}

export function hideSearchSuggestionsForSearchContextHover(options) {
    if (!options || typeof options !== 'object') {
        throw new Error('hideSearchSuggestionsForSearchContextHover requires options');
    }
    const { isSearching, noteId, pointerClientY } = options;
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('hideSearchSuggestionsForSearchContextHover requires noteId');
    }
    if (!Number.isFinite(pointerClientY)) {
        throw new Error('hideSearchSuggestionsForSearchContextHover requires pointerClientY');
    }
    if (!isSearching) {
        return false;
    }
    // While a suggestion's right-click menu is open, the pointer belongs to the menu.
    if (isContextMenuOpen()) {
        return false;
    }

    const container = getSearchSuggestionsContainer();
    if (container.hidden) {
        return false;
    }
    if (!shouldHideForVerticalPointerPosition(container, pointerClientY)) {
        return false;
    }

    hideSuggestions({
        invalidateRequests: true,
        suppressUntilInputInteraction: true,
    });
    return true;
}

export function hideSearchSuggestionsForSearchContextPointerMove(options) {
    if (!options || typeof options !== 'object') {
        throw new Error('hideSearchSuggestionsForSearchContextPointerMove requires options');
    }
    const { isSearching, pointerClientX, pointerClientY } = options;
    if (!Number.isFinite(pointerClientX)) {
        throw new Error('hideSearchSuggestionsForSearchContextPointerMove requires pointerClientX');
    }
    if (!Number.isFinite(pointerClientY)) {
        throw new Error('hideSearchSuggestionsForSearchContextPointerMove requires pointerClientY');
    }
    if (!isSearching) {
        return false;
    }
    // While a suggestion's right-click menu is open, the pointer belongs to the menu.
    if (isContextMenuOpen()) {
        return false;
    }

    const container = getSearchSuggestionsContainer();
    if (container.hidden) {
        return false;
    }

    let shouldHide = shouldHideForVerticalPointerPosition(container, pointerClientY);
    if (!shouldHide) {
        shouldHide = shouldHideForHorizontalPointerPosition(pointerClientX);
    }
    if (!shouldHide) {
        return false;
    }

    hideSuggestions({
        invalidateRequests: true,
        suppressUntilInputInteraction: true,
    });
    return true;
}

export async function applySearchSuggestion(searchInput, suggestion) {
    if (!searchInput || typeof searchInput.value !== 'string') {
        throw new Error('applySuggestion requires searchInput element');
    }
    if (typeof suggestion !== 'string' || suggestion.length === 0) {
        throw new Error('applySuggestion requires suggestion string');
    }

    const rawValue = searchInput.value;
    if (!Number.isInteger(searchInput.selectionStart)) {
        throw new Error('searchInput.selectionStart missing');
    }
    const cursorIndex = searchInput.selectionStart;
    const context = parseSuggestionContext(rawValue, cursorIndex);
    if (!context) {
        return;
    }

    const prefixText = context.prefixModifier;
    const before = rawValue.slice(0, context.replaceStart);
    const after = rawValue.slice(context.replaceEnd);
    const replacement = `${prefixText}${suggestion}`;
    const nextValue = `${before}${replacement}${after}`;

    syncSearchInputValue(searchInput, nextValue);

    const nextCursor = before.length + replacement.length;
    if (typeof searchInput.setSelectionRange === 'function') {
        searchInput.setSelectionRange(nextCursor, nextCursor);
    }

    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.focus();
    hideSuggestions({ invalidateRequests: true });
    // Picking a property's name or unit credits no tag (docs/design/tag-properties.md).
    if (/[:<>]/.test(suggestion)) {
        return;
    }
    const response = await NotesAPI.recordSearchSuggestionSelection(suggestion);
    if (!response || response.credited !== true) {
        throw new Error('Search suggestion selection was not credited');
    }
}

function updateSelectedSuggestion(container) {
    const items = Array.from(container.querySelectorAll('.search-suggestion'));
    if (items.length === 0) {
        // Rendering or dismissing an empty result list can observe no selection.
        if (moduleState.selectedIndex !== NO_SELECTION) moduleState.selectedIndex = NO_SELECTION;
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

// Why each suggestion is suggested, from the server's ranking; shown when it is right-clicked.
function requireSuggestionReasons(reasonsByTag, tag) {
    if (typeof tag !== 'string' || tag.length === 0) {
        throw new Error('Suggestion tag missing from dataset');
    }
    if (!Object.hasOwn(reasonsByTag, tag)) {
        throw new Error(`Search suggestion ${tag} has no reasons`);
    }
    const reasons = reasonsByTag[tag];
    if (!Array.isArray(reasons) || reasons.length === 0) {
        throw new Error(`Search suggestion ${tag} needs at least one reason`);
    }
    for (const reason of reasons) {
        if (typeof reason !== 'string' || reason.trim() === '') {
            throw new Error(`Search suggestion ${tag} has an empty reason`);
        }
    }
    return reasons;
}

// What the list shows: a tag as it is, a property's name or unit alone (miles for
// exercise:miles, 5mg for drug:dosage>5mg), as the server labels it.
function requireSuggestionLabel(labelsBySuggestion, suggestion) {
    if (!Object.hasOwn(labelsBySuggestion, suggestion)) {
        throw new Error(`Search suggestion ${suggestion} has no label`);
    }
    const label = labelsBySuggestion[suggestion];
    if (typeof label !== 'string' || label.length === 0) {
        throw new Error(`Search suggestion ${suggestion} has an empty label`);
    }
    return label;
}

function renderSuggestions(searchInput, builtForText, suggestions, personalizedSuggestions, showWindowLabels, reasonsByTag, labelsBySuggestion) {
    if (typeof builtForText !== 'string') {
        throw new Error('renderSuggestions requires the text the list was built for');
    }
    const container = getSearchSuggestionsContainer();
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
        hideSuggestions();
        return;
    }
    if (!reasonsByTag || typeof reasonsByTag !== 'object') {
        throw new Error('Search suggestions require their reasons');
    }

    const presentation = buildSearchSuggestionPresentation(
        suggestions,
        personalizedSuggestions,
        showWindowLabels,
    );
    const items = presentation
        .map(({ tag, windowLabel }) => {
            let labelHtml = '';
            if (windowLabel !== '') {
                labelHtml = `<span class="search-suggestion-window-label">${escapeHtml(windowLabel)}</span>`;
            }
            const shown = requireSuggestionLabel(labelsBySuggestion, tag);
            return `<button type="button" class="search-suggestion" data-tag="${escapeHtml(tag)}"><span class="search-suggestion-tag">${escapeHtml(shown)}</span>${labelHtml}</button>`;
        })
        .join('');

    container.innerHTML = items;
    // The same text can be suggested for again (the box was clicked).
    if (moduleState.listBuiltForText !== builtForText) moduleState.listBuiltForText = builtForText;
    container.hidden = false;
    container.style.display = 'flex';
    // A new result snapshot can retain the first-item selection index.
    if (moduleState.selectedIndex !== 0) moduleState.selectedIndex = 0;
    updateSelectedSuggestion(container);

    container.querySelectorAll('.search-suggestion').forEach((button) => {
        const tag = button.dataset.tag;
        button.dataset.reasons = JSON.stringify(requireSuggestionReasons(reasonsByTag, tag));
        button.addEventListener('mousedown', async (event) => {
            // Any button keeps the cursor in the search box, so the list stays
            // open: a right-click (Control-click on a Mac) opens the tag menu
            // for this suggestion and does not pick it.
            event.preventDefault();
            if (event.button !== 0 || isMacControlClick(event)) {
                return;
            }
            await applySearchSuggestion(searchInput, tag);
        });
    });
}

function normalizeUpdateOptions(options) {
    if (options === undefined) {
        return { source: 'programmatic' };
    }
    if (options === null || typeof options !== 'object') {
        throw new Error('updateSearchSuggestions options must be an object');
    }
    const source = options.source;
    if (source === undefined) {
        return { source: 'programmatic' };
    }
    if (typeof source !== 'string' || source.length === 0) {
        throw new Error('updateSearchSuggestions source must be a non-empty string');
    }
    return { source };
}

function doesUpdateSourceResumeSuggestions(source) {
    if (source === 'input') {
        return true;
    }
    if (source === 'search-input-click') {
        return true;
    }
    if (source === 'search-input-focus') {
        return true;
    }
    return false;
}

export function updateSearchSuggestions(searchInput, options) {
    if (!searchInput || typeof searchInput.value !== 'string') {
        throw new Error('updateSearchSuggestions requires search input element');
    }
    const updateOptions = normalizeUpdateOptions(options);
    if (doesUpdateSourceResumeSuggestions(updateOptions.source)) {
        // Browser input can arrive without a preceding hover suppression.
        if (moduleState.suppressSuggestionsUntilInputInteraction) moduleState.suppressSuggestionsUntilInputInteraction = false;
    }
    if (document.activeElement !== searchInput) {
        if (moduleState.pendingTimer) {
            clearTimeout(moduleState.pendingTimer);
            moduleState.pendingTimer = null;
        }
        moduleState.requestSerial += 1;
        hideSuggestions();
        return;
    }
    if (moduleState.suppressSuggestionsUntilInputInteraction) {
        clearPendingSuggestionRequest();
        hideSuggestions();
        return;
    }

    const rawValue = searchInput.value;
    const analysis = analyzeSearchQueryInput(rawValue);
    if (!analysis.isComplete && typeof analysis.warningMessage === 'string') {
        if (moduleState.pendingTimer) {
            clearTimeout(moduleState.pendingTimer);
            moduleState.pendingTimer = null;
        }
        moduleState.requestSerial += 1;
        hideSuggestions();
        return;
    }
    if (!Number.isInteger(searchInput.selectionStart)) {
        throw new Error('searchInput.selectionStart missing');
    }
    const cursorIndex = searchInput.selectionStart;
    const context = parseSuggestionContext(rawValue, cursorIndex);
    if (!context) {
        if (moduleState.pendingTimer) {
            clearTimeout(moduleState.pendingTimer);
            moduleState.pendingTimer = null;
        }
        moduleState.requestSerial += 1;
        hideSuggestions();
        return;
    }

    if (moduleState.pendingTimer) {
        clearTimeout(moduleState.pendingTimer);
    }

    const requestId = ++moduleState.requestSerial;
    moduleState.pendingTimer = setTimeout(async () => {
        moduleState.pendingTimer = null;
        const response = await NotesAPI.fetchSearchSuggestions(
            rawValue,
            getSearchSuggestionWindowDays(),
        );
        if (!response || typeof response !== 'object') {
            throw new Error('Search suggestions response missing');
        }
        if (!Array.isArray(response.suggestions)) {
            throw new Error('Search suggestions response requires suggestions array');
        }
        if (!Array.isArray(response.personalizedSuggestions)) {
            throw new Error('Search suggestions response requires personalizedSuggestions array');
        }
        if (!response.reasons || typeof response.reasons !== 'object') {
            throw new Error('Search suggestions response requires reasons');
        }
        if (!response.labels || typeof response.labels !== 'object') {
            throw new Error('Search suggestions response requires labels');
        }
        if (requestId !== moduleState.requestSerial) {
            return;
        }
        if (moduleState.suppressSuggestionsUntilInputInteraction) {
            return;
        }
        renderSuggestions(
            searchInput,
            rawValue,
            response.suggestions,
            response.personalizedSuggestions,
            getShowSearchSuggestionWindowLabels(),
            response.reasons,
            response.labels,
        );
    }, SUGGESTION_DEBOUNCE_MS);
}

export function initializeSearchSuggestions() {
    const searchInput = document.getElementById('search-input');
    if (!searchInput || typeof searchInput.addEventListener !== 'function') {
        throw new Error('search-input element missing for suggestions');
    }

    const container = getSearchSuggestionsContainer();

    document.addEventListener('mousedown', (event) => {
        if (container.hidden) {
            return;
        }
        const target = event.target;
        if (!target || typeof target.closest !== 'function') {
            return;
        }
        if (target.closest('.search-controls')) {
            return;
        }
        hideSuggestions();
    }, true);

    searchInput.addEventListener('blur', () => {
        if (!container.hidden) {
            hideSuggestions();
        }
    });

    searchInput.addEventListener('focus', () => {
        updateSearchSuggestions(searchInput, { source: 'search-input-focus' });
    });

    searchInput.addEventListener('mousedown', () => {
        updateSearchSuggestions(searchInput, { source: 'search-input-click' });
    });

    searchInput.addEventListener('keydown', async (event) => {
        if (container.hidden) {
            return;
        }
        const items = Array.from(container.querySelectorAll('.search-suggestion'));
        if (items.length === 0) {
            return;
        }
        // Only a list built for the text in the box is acted on: Enter on an older
        // list searches what was typed, and the arrows wait for the new list.
        const isListForOlderText = searchInput.value !== moduleState.listBuiltForText;
        if (isListForOlderText && event.key === 'Enter') {
            clearPendingSuggestionRequest();
            hideSuggestions();
            return;
        }
        if (isListForOlderText && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
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
            await applySearchSuggestion(searchInput, tag);
        }
    });
}
