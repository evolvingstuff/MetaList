import { ApplicationState } from '../../application-state.js';
export const DEFAULT_SEARCH_SUGGESTION_WINDOWS_VALUE = '[1,7,30]';
export const MAX_SEARCH_SUGGESTION_WINDOW_DAYS = 365;
export const MAX_SEARCH_SUGGESTION_WINDOW_SLOTS = 20;

const moduleState = ApplicationState.createFields('search-suggestion-windows-service', {
    currentWindowDays: Object.freeze([1, 7, 30]),
    shouldShowWindowLabels: true,
    shouldLimitNoteCreditsPerSearchContext: true,
});


export function getSearchSuggestionWindowsValidationError(windowDays) {
    if (!Array.isArray(windowDays)) {
        return 'Search suggestion windows must be an array';
    }
    if (windowDays.length > MAX_SEARCH_SUGGESTION_WINDOW_SLOTS) {
        return `Search suggestion windows cannot contain more than ${MAX_SEARCH_SUGGESTION_WINDOW_SLOTS} slots`;
    }
    const seen = new Set();
    for (const dayCount of windowDays) {
        if (!Number.isInteger(dayCount)) {
            return 'Search suggestion windows must contain integers';
        }
        if (dayCount < 1 || dayCount > MAX_SEARCH_SUGGESTION_WINDOW_DAYS) {
            return `Search suggestion windows must be between 1 and ${MAX_SEARCH_SUGGESTION_WINDOW_DAYS} days`;
        }
        if (seen.has(dayCount)) {
            return 'Search suggestion windows cannot contain duplicates';
        }
        seen.add(dayCount);
    }
    return '';
}

export function validateSearchSuggestionWindows(windowDays) {
    const validationError = getSearchSuggestionWindowsValidationError(windowDays);
    if (validationError !== '') {
        throw new Error(validationError);
    }
    return windowDays.slice();
}

export function parseSearchSuggestionWindowsValue(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('Search suggestion windows preference must be a non-empty string');
    }
    const parsed = JSON.parse(value);
    return validateSearchSuggestionWindows(parsed);
}

export function serializeSearchSuggestionWindows(windowDays) {
    return JSON.stringify(validateSearchSuggestionWindows(windowDays));
}

export function setSearchSuggestionWindowsValue(value) {
    moduleState.currentWindowDays = Object.freeze(parseSearchSuggestionWindowsValue(value));
}

export function getSearchSuggestionWindowDays() {
    return moduleState.currentWindowDays.slice();
}

export function setShowSearchSuggestionWindowLabelsValue(value) {
    if (value !== 'true' && value !== 'false') {
        throw new Error('Search suggestion window labels value must be true or false');
    }
    moduleState.shouldShowWindowLabels = value === 'true';
}

export function getShowSearchSuggestionWindowLabels() {
    return moduleState.shouldShowWindowLabels;
}

export function setLimitNoteCreditsPerSearchContextValue(value) {
    if (value !== 'true' && value !== 'false') {
        throw new Error('Search-context note credit limit value must be true or false');
    }
    moduleState.shouldLimitNoteCreditsPerSearchContext = value === 'true';
}

export function getLimitNoteCreditsPerSearchContext() {
    return moduleState.shouldLimitNoteCreditsPerSearchContext;
}

// Called only when applying the authoritative persisted preference snapshot.
export function receiveSearchSuggestionPreferences({ windows, showLabels, limitCredits }) {
    if (typeof showLabels !== 'boolean' || typeof limitCredits !== 'boolean') {
        throw new TypeError('Search suggestion preference snapshot requires boolean flags');
    }
    ApplicationState.receiveOwnerSnapshot(moduleState, {
        currentWindowDays: parseSearchSuggestionWindowsValue(windows),
        shouldShowWindowLabels: showLabels,
        shouldLimitNoteCreditsPerSearchContext: limitCredits,
    });
}
