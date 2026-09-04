function requireRailFlag(value, name) {
    if (typeof value !== 'boolean') {
        throw new Error(`resolvePriorityContextMenuTarget requires boolean ${name}`);
    }
}

function resolveSuggestionTarget(element, selector, source) {
    const suggestion = element.closest(selector);
    if (!suggestion) {
        return null;
    }

    const tag = suggestion.dataset.tag;
    if (typeof tag !== 'string' || tag.trim() === '') {
        throw new Error(`${selector} context-menu target missing data-tag`);
    }

    return {
        kind: 'tag-suggestion',
        tag,
        source,
    };
}

export function resolveReferenceContextFromElement(element) {
    if (!(element instanceof HTMLElement)) {
        return null;
    }

    const reference = element.closest('.note-reference-note[data-ref-note-id]');
    if (!(reference instanceof HTMLElement)) {
        return null;
    }
    const referenceNoteId = reference.dataset.refNoteId;
    if (typeof referenceNoteId !== 'string' || referenceNoteId.trim() === '') {
        throw new Error('Reference context-menu target missing data-ref-note-id');
    }
    return { referenceNoteId };
}

export function resolvePriorityContextMenuTarget(element, options) {
    if (!(element instanceof HTMLElement)) {
        throw new Error('resolvePriorityContextMenuTarget requires HTMLElement');
    }
    if (!options || typeof options !== 'object') {
        throw new Error('resolvePriorityContextMenuTarget requires options object');
    }

    const { isInLeftRail, isInRightRail } = options;
    requireRailFlag(isInLeftRail, 'isInLeftRail');
    requireRailFlag(isInRightRail, 'isInRightRail');

    const searchSuggestion = resolveSuggestionTarget(element, '.search-suggestion', 'search');
    if (searchSuggestion) {
        return searchSuggestion;
    }

    const tagBarSuggestion = resolveSuggestionTarget(
        element,
        '.note-tag-suggestion',
        'tag-bar',
    );
    if (tagBarSuggestion) {
        return tagBarSuggestion;
    }

    const tagBarInput = element.closest('.note-tag-bar-input');
    if (tagBarInput) {
        return { kind: 'tag-bar-input', element: tagBarInput };
    }

    const searchInput = element.closest('#search-input');
    if (searchInput) {
        return { kind: 'search-input', element: searchInput };
    }

    if (element.closest('#search-contexts-list')) {
        return { kind: 'tabs-rail' };
    }

    if (element.closest('.note-content')) {
        return null;
    }

    if (isInRightRail) {
        return { kind: 'view-rail' };
    }

    if (isInLeftRail) {
        return { kind: 'tabs-rail' };
    }

    return null;
}
