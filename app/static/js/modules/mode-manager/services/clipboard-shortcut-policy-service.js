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

// Line endings may change on their way through the system clipboard.
function sameClipboardText(left, right) {
    return left.replace(/\r\n?/g, '\n') === right.replace(/\r\n?/g, '\n');
}

// Whether a paste is the note MetaList copied. A paste with HTML says so with the
// note marker. ⇧⌘V is the browser's Paste and Match Style, whose paste carries the
// plain text only: it is the copied note when that text is exactly what the copy
// put on the clipboard, while MetaList's clipboard holds a note.
function isCopiedNotePaste({ clipboardMode, clipboardHtml, clipboardPlainText, copiedNotePlainText }) {
    if (clipboardHtml !== '') return clipboardHtmlContainsNoteContent(clipboardHtml);
    return clipboardMode === 'note'
        && copiedNotePlainText !== ''
        && sameClipboardText(clipboardPlainText, copiedNotePlainText);
}

export function resolveClipboardTrackingAfterPasteEvent({
    clipboardMode,
    noteClipboardRequiresBrowserValidation,
    clipboardHtml,
    clipboardPlainText,
    copiedNotePlainText,
}) {
    assertClipboardMode(clipboardMode);
    if (typeof noteClipboardRequiresBrowserValidation !== 'boolean') {
        throw new Error('noteClipboardRequiresBrowserValidation must be a boolean');
    }
    if (typeof clipboardHtml !== 'string') {
        throw new Error('clipboardHtml must be a string');
    }
    if (typeof clipboardPlainText !== 'string' || typeof copiedNotePlainText !== 'string') {
        throw new Error('clipboardPlainText and copiedNotePlainText must be strings');
    }

    const hasNoteClipboardHtml = isCopiedNotePaste({ clipboardMode, clipboardHtml, clipboardPlainText, copiedNotePlainText });
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
