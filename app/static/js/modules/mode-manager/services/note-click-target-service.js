function supportsClosest(target) {
    return target !== null && typeof target === 'object' && typeof target.closest === 'function';
}

export function isViewModeNoteLink(target) {
    if (!supportsClosest(target)) {
        return false;
    }
    const anchor = target.closest('a[href]');
    if (!anchor || !anchor.closest('.note-content')) {
        return false;
    }
    const note = anchor.closest('.note');
    return note !== null && !note.classList.contains('editing');
}

export function resolveNonContentNoteSelectionTarget(target) {
    if (!supportsClosest(target)) {
        return null;
    }

    if (target.closest('.note-content')) {
        return null;
    }

    if (target.closest('.note-tag-bar')) {
        return null;
    }

    if (target.closest('.note-collapse-toggle')) {
        return null;
    }

    if (target.closest('.note-collapsed-children-indicator')) {
        return null;
    }

    return target.closest('.note');
}
