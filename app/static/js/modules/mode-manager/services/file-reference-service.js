import { NOT_FOUND } from '../../not-found.js';
import { FilesAPI } from '../../api-client.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';
import { captureSelectionSnapshot, getActiveEditable, getActiveNoteId, restoreSelection } from '../../editor-selection.js';
import { createNote, createNoteAtTop } from '../actions/note-actions.js';
import { requireCreatedNoteId } from './root-note-creation-service.js';
import { actionSaveNote } from '../actions/content-actions.js';
import { actionSelectNote, actionSwitchNotes } from '../actions/selection-actions.js';

// After the window regains focus from the file picker, how often and how many
// times to look for the chosen file before treating the picker as cancelled.
const FILE_PICKER_FOCUS_POLL_INTERVAL_MS = 50;
const FILE_PICKER_FOCUS_POLL_MAX_ATTEMPTS = 20;

function getFilePickerInput() {
    const input = document.getElementById('file-reference-input');
    if (!(input instanceof HTMLInputElement)) {
        throw new Error('file-reference-input element missing from DOM');
    }
    if (input.type !== 'file') {
        throw new Error('file-reference-input must be type=file');
    }
    return input;
}

function ensureSelectionInsideEditableContent(contentElement) {
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('ensureSelectionInsideEditableContent requires content element');
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable');
    }

    const hasRangeInContent = (
        selection.rangeCount > 0
        && contentElement.contains(selection.anchorNode)
        && contentElement.contains(selection.focusNode)
    );
    if (hasRangeInContent) {
        return;
    }

    const range = document.createRange();
    range.selectNodeContents(contentElement);
    range.collapse(false);
    contentElement.focus();
    selection.removeAllRanges();
    selection.addRange(range);
}

function linePrefixText(fullText) {
    if (typeof fullText !== 'string') {
        throw new Error('linePrefixText requires string');
    }
    const lastLf = fullText.lastIndexOf('\n');
    const lastCr = fullText.lastIndexOf('\r');
    const boundary = Math.max(lastLf, lastCr);
    if (boundary === NOT_FOUND) {
        return fullText;
    }
    return fullText.slice(boundary + 1);
}

function lineSuffixText(fullText) {
    if (typeof fullText !== 'string') {
        throw new Error('lineSuffixText requires string');
    }
    const lf = fullText.indexOf('\n');
    const cr = fullText.indexOf('\r');
    let boundary = NOT_FOUND;
    if (lf === NOT_FOUND) {
        boundary = cr;
    } else if (cr === NOT_FOUND) {
        boundary = lf;
    } else {
        boundary = Math.min(lf, cr);
    }
    if (boundary === NOT_FOUND) {
        return fullText;
    }
    return fullText.slice(0, boundary);
}

function lineHasVisibleText(text) {
    if (typeof text !== 'string') {
        throw new Error('lineHasVisibleText requires string');
    }
    return text.replace(/\u00a0/g, ' ').trim().length > 0;
}

function findDirectLineContainer(contentElement, node) {
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('findDirectLineContainer requires content element');
    }
    let current = node;
    while (current && current !== contentElement) {
        if (current.parentNode === contentElement) {
            return current instanceof HTMLElement ? current : null;
        }
        current = current.parentNode;
    }
    return null;
}

function lineElementIsVisuallyEmpty(lineElement) {
    if (!(lineElement instanceof HTMLElement)) {
        throw new Error('lineElementIsVisuallyEmpty requires HTMLElement');
    }
    if (
        lineElement.querySelector(
            'img,video,audio,iframe,svg,math,canvas,input,textarea,button,table,hr',
        )
    ) {
        return false;
    }
    const text = typeof lineElement.textContent === 'string' ? lineElement.textContent : '';
    return text.replace(/\u00a0/g, ' ').trim().length === 0;
}

function isSelectionCollapsedOnEmptyVisualLine(contentElement, range) {
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('isSelectionCollapsedOnEmptyVisualLine requires content element');
    }
    if (!(range instanceof Range)) {
        throw new Error('isSelectionCollapsedOnEmptyVisualLine requires range');
    }
    if (!range.collapsed) {
        return false;
    }

    const lineElement = findDirectLineContainer(contentElement, range.startContainer);
    if (lineElement) {
        return lineElementIsVisuallyEmpty(lineElement);
    }

    if (range.startContainer === contentElement) {
        if (contentElement.childNodes.length === 0) {
            return true;
        }
        if (contentElement.childNodes.length === 1) {
            const onlyChild = contentElement.childNodes[0];
            if (onlyChild instanceof HTMLBRElement) {
                return true;
            }
            if (onlyChild instanceof Text) {
                return !(lineHasVisibleText(onlyChild.data));
            }
        }
    }

    return false;
}

function getSelectionLineContext(contentElement) {
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('getSelectionLineContext requires content element');
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable');
    }
    if (selection.rangeCount === 0) {
        throw new Error('Selection range missing');
    }

    const range = selection.getRangeAt(0);
    if (!contentElement.contains(range.startContainer) || !contentElement.contains(range.endContainer)) {
        throw new Error('Selection is outside editable content');
    }

    if (isSelectionCollapsedOnEmptyVisualLine(contentElement, range)) {
        return {
            hasTextBeforeOnLine: false,
            hasTextAfterOnLine: false,
        };
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(contentElement);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const beforeText = beforeRange.toString();

    const afterRange = document.createRange();
    afterRange.selectNodeContents(contentElement);
    afterRange.setStart(range.endContainer, range.endOffset);
    const afterText = afterRange.toString();

    return {
        hasTextBeforeOnLine: lineHasVisibleText(linePrefixText(beforeText)),
        hasTextAfterOnLine: lineHasVisibleText(lineSuffixText(afterText)),
    };
}

function insertPlainTextAtCurrentSelection(text) {
    if (typeof text !== 'string') {
        throw new Error('insertPlainTextAtCurrentSelection requires text string');
    }

    const inserted = document.execCommand('insertText', false, text);
    if (inserted) {
        captureSelectionSnapshot();
        return;
    }

    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable while inserting text');
    }
    if (selection.rangeCount === 0) {
        throw new Error('Selection range missing while inserting text');
    }

    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    captureSelectionSnapshot();
}

// The editable content of the note being edited; throws when none is.
function requireActiveEditable(referenceToken) {
    if (typeof referenceToken !== 'string' || referenceToken.length === 0) {
        throw new Error('Reference insertion requires referenceToken');
    }

    if (!ModeContext.isEditing) {
        throw new Error('Reference insertion requires an actively edited note');
    }

    const activeNoteId = getActiveNoteId();
    const currentNoteId = ModeContext.currentNoteId;
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        throw new Error('Reference insertion requires current note id');
    }
    if (activeNoteId !== currentNoteId) {
        throw new Error('Active editable note mismatch while inserting reference');
    }

    const contentElement = getActiveEditable();
    if (!(contentElement instanceof HTMLElement)) {
        throw new Error('Reference insertion requires an active editable content element');
    }
    return contentElement;
}

// Inserts the token at the selection on its own line: a line is split around
// it, and nothing is added on an empty line. Native insertText: one undo step.
function insertReferenceTokenAtSelection(contentElement, referenceToken) {
    const lineContext = getSelectionLineContext(contentElement);

    let insertionText = referenceToken;
    if (lineContext.hasTextBeforeOnLine) {
        insertionText = `\n${insertionText}`;
    }
    if (lineContext.hasTextAfterOnLine) {
        insertionText = `${insertionText}\n`;
    }

    insertPlainTextAtCurrentSelection(insertionText);
    if (!ModeContext.isDirty) {
        ModeContext.setDirty(true);
    }
}

export function insertReferenceTokenIntoActiveEditor(referenceToken) {
    const contentElement = requireActiveEditable(referenceToken);
    contentElement.focus();
    restoreSelection();
    ensureSelectionInsideEditableContent(contentElement);
    insertReferenceTokenAtSelection(contentElement, referenceToken);
}

// Paste Reference Into Note: the token at `range` (a point, or text it replaces) in
// the note being edited.
export function insertReferenceTokenAtRange(referenceToken, range) {
    const contentElement = requireActiveEditable(referenceToken);
    if (!(range instanceof Range) || !contentElement.contains(range.startContainer) || !contentElement.contains(range.endContainer)) {
        throw new Error('Paste Reference Into Note requires a range in the edited note');
    }
    contentElement.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    insertReferenceTokenAtSelection(contentElement, referenceToken);
}

async function ensureAttachTargetNote(preferredNoteId, options) {
    if (preferredNoteId !== null && typeof preferredNoteId !== 'string') {
        throw new Error('ensureAttachTargetNote preferredNoteId must be string or null');
    }
    if (typeof options === 'undefined') {
        options = {};
    }
    if (options === null || typeof options !== 'object') {
        throw new Error('ensureAttachTargetNote options must be object');
    }
    const createAtTop = options.createAtTop === true;

    if (createAtTop) {
        requireCreatedNoteId(await createNoteAtTop(), 'attachFileNewTopNote');
    } else if (typeof preferredNoteId === 'string' && preferredNoteId.length > 0) {
        if (ModeContext.isEditing) {
            const currentNoteId = ModeContext.currentNoteId;
            if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
                throw new Error('Attach file requires current note id while editing');
            }
            if (currentNoteId === preferredNoteId) {
                return currentNoteId;
            }
            await actionSwitchNotes(preferredNoteId, { initialCaretVisibility: 'visible' });
        } else {
            await actionSelectNote(preferredNoteId, { initialCaretVisibility: 'visible' });
        }
    } else if (!ModeContext.isEditing) {
        requireCreatedNoteId(await createNote(), 'attachFileNewNote');
    }

    if (!ModeContext.isEditing) {
        throw new Error('Attach file failed to enter editing mode after note creation');
    }
    const currentNoteId = ModeContext.currentNoteId;
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        throw new Error('Attach file failed to select created note');
    }
    return currentNoteId;
}

function pickSingleFile() {
    const input = getFilePickerInput();

    return new Promise((resolve) => {
        let settled = false;
        let focusPollTimeoutId = null;

        const cleanup = () => {
            input.removeEventListener('change', handleChange);
            window.removeEventListener('focus', handleFocus, true);
            if (focusPollTimeoutId !== null) {
                window.clearTimeout(focusPollTimeoutId);
                focusPollTimeoutId = null;
            }
        };

        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(value);
        };

        const handleChange = () => {
            const file = input.files && input.files.length > 0 ? input.files[0] : null;
            finish(file);
        };

        const pollForSelectionAfterFocus = (attemptCount) => {
            if (settled) {
                return;
            }
            const file = input.files && input.files.length > 0 ? input.files[0] : null;
            if (file !== null) {
                finish(file);
                return;
            }
            if (!Number.isInteger(attemptCount) || attemptCount <= 0) {
                throw new Error('pollForSelectionAfterFocus requires positive attemptCount');
            }
            if (attemptCount >= FILE_PICKER_FOCUS_POLL_MAX_ATTEMPTS) {
                if (input.value === '') {
                    finish(null);
                    return;
                }
                throw new Error('File picker did not resolve selection state after focus');
            }
            if (input.value !== '') {
                focusPollTimeoutId = window.setTimeout(() => {
                    pollForSelectionAfterFocus(attemptCount + 1);
                }, FILE_PICKER_FOCUS_POLL_INTERVAL_MS);
                return;
            }
            focusPollTimeoutId = window.setTimeout(() => {
                pollForSelectionAfterFocus(attemptCount + 1);
            }, FILE_PICKER_FOCUS_POLL_INTERVAL_MS);
        };

        const handleFocus = () => {
            focusPollTimeoutId = window.setTimeout(() => {
                pollForSelectionAfterFocus(1);
            }, FILE_PICKER_FOCUS_POLL_INTERVAL_MS);
        };

        input.value = '';
        input.addEventListener('change', handleChange);
        window.addEventListener('focus', handleFocus, true);
        input.click();
    });
}

export async function pickFileForAttachment() {
    return await pickSingleFile();
}

export async function attachPickedFileToCurrentNote(file, preferredNoteId, options) {
    if (!(file instanceof File)) {
        throw new Error('attachPickedFileToCurrentNote requires File');
    }
    if (typeof preferredNoteId !== 'undefined' && preferredNoteId !== null && typeof preferredNoteId !== 'string') {
        throw new Error('attachPickedFileToCurrentNote preferredNoteId must be string or null');
    }
    if (typeof options === 'undefined') {
        options = {};
    }
    if (options === null || typeof options !== 'object') {
        throw new Error('attachPickedFileToCurrentNote options must be object');
    }

    const payload = await FilesAPI.uploadFile(file);
    if (!payload || typeof payload !== 'object') {
        throw new Error('File upload response missing body');
    }
    if (typeof payload.reference_token !== 'string' || payload.reference_token.length === 0) {
        throw new Error('File upload response missing reference_token');
    }

    const targetNoteId = typeof preferredNoteId === 'string' && preferredNoteId.length > 0
        ? preferredNoteId
        : null;
    await ensureAttachTargetNote(targetNoteId, options);
    insertReferenceTokenIntoActiveEditor(payload.reference_token);
    const currentNoteId = ModeContext.currentNoteId;
    if (typeof currentNoteId !== 'string' || currentNoteId.length === 0) {
        throw new Error('Attach file cannot save because current note id is missing');
    }
    await actionSaveNote(currentNoteId);
    return payload;
}

export async function downloadFileReference(fileId) {
    if (typeof fileId !== 'string' || fileId.length === 0) {
        throw new Error('downloadFileReference requires fileId');
    }

    const payload = await FilesAPI.downloadFile(fileId);
    if (!payload || typeof payload !== 'object') {
        throw new Error('File download response missing body');
    }
    if (!(payload.blob instanceof Blob)) {
        throw new Error('File download response missing blob');
    }
    if (typeof payload.filename !== 'string' || payload.filename.length === 0) {
        throw new Error('File download response missing filename');
    }

    const objectUrl = URL.createObjectURL(payload.blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = payload.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 0);
}
