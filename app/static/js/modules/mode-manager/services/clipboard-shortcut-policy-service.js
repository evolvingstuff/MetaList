const NOTE_CLIPBOARD_HTML_MARKER = 'data-metalist-note-clipboard="true"';

function assertClipboardMode(clipboardMode) {
    if (clipboardMode !== 'system' && clipboardMode !== 'note') {
        throw new Error(`Invalid clipboard mode: ${clipboardMode}`);
    }
}

export function clipboardHtmlContainsNoteContent(clipboardHtml) {
    if (typeof clipboardHtml !== 'string') {
        throw new Error('clipboardHtml must be a string');
    }
    return clipboardHtml.includes(NOTE_CLIPBOARD_HTML_MARKER);
}

export function shouldAllowBrowserPasteForShortcut({
    clipboardMode,
    noteClipboardRequiresBrowserValidation,
    isEditing,
    currentNoteId,
}) {
    assertClipboardMode(clipboardMode);
    if (typeof noteClipboardRequiresBrowserValidation !== 'boolean') {
        throw new Error('noteClipboardRequiresBrowserValidation must be a boolean');
    }
    if (typeof isEditing !== 'boolean') {
        throw new Error('isEditing must be a boolean');
    }

    const hasCurrentNoteId = typeof currentNoteId === 'string' && currentNoteId.length > 0;

    if (clipboardMode === 'system') {
        return true;
    }
    if (noteClipboardRequiresBrowserValidation) {
        return true;
    }
    if (!isEditing) {
        return true;
    }
    if (!hasCurrentNoteId) {
        return true;
    }
    return false;
}

export function shouldCreateTopNoteForPaste({
    isEditing,
    currentNoteId,
    hasNativePasteTarget,
    hasClipboardPayload,
    isModalOpen,
}) {
    if (typeof isEditing !== 'boolean') {
        throw new Error('isEditing must be a boolean');
    }
    if (currentNoteId !== null && typeof currentNoteId !== 'string') {
        throw new Error('currentNoteId must be a string or null');
    }
    if (typeof hasNativePasteTarget !== 'boolean') {
        throw new Error('hasNativePasteTarget must be a boolean');
    }
    if (typeof hasClipboardPayload !== 'boolean') {
        throw new Error('hasClipboardPayload must be a boolean');
    }
    if (typeof isModalOpen !== 'boolean') {
        throw new Error('isModalOpen must be a boolean');
    }

    const hasActiveNote = isEditing && typeof currentNoteId === 'string' && currentNoteId.length > 0;
    return !hasActiveNote
        && !hasNativePasteTarget
        && hasClipboardPayload
        && !isModalOpen;
}

export function resolveClipboardTrackingAfterPasteEvent({
    clipboardMode,
    noteClipboardRequiresBrowserValidation,
    clipboardHtml,
}) {
    assertClipboardMode(clipboardMode);
    if (typeof noteClipboardRequiresBrowserValidation !== 'boolean') {
        throw new Error('noteClipboardRequiresBrowserValidation must be a boolean');
    }
    if (typeof clipboardHtml !== 'string') {
        throw new Error('clipboardHtml must be a string');
    }

    const hasNoteClipboardHtml = clipboardHtmlContainsNoteContent(clipboardHtml);
    if (clipboardMode === 'note' && noteClipboardRequiresBrowserValidation) {
        if (hasNoteClipboardHtml) {
            return {
                clipboardMode: 'note',
                noteClipboardRequiresBrowserValidation: false,
                hasNoteClipboardHtml: true,
            };
        }
        return {
            clipboardMode: 'system',
            noteClipboardRequiresBrowserValidation: false,
            hasNoteClipboardHtml: false,
        };
    }

    return {
        clipboardMode,
        noteClipboardRequiresBrowserValidation,
        hasNoteClipboardHtml,
    };
}

export function resolveNotePasteResponse(response) {
    if (!response || typeof response !== 'object') {
        throw new Error('Note paste response must be an object');
    }
    if (response.status === 'clipboard_empty') {
        return null;
    }
    if (response.status !== 'pasted') {
        throw new Error(`Unexpected note paste status: ${response.status}`);
    }
    if (typeof response.id !== 'string' || response.id.length === 0) {
        throw new Error('Completed note paste response missing note id');
    }
    return response.id;
}
