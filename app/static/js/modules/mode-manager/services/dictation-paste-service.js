import { ApplicationState } from '../../application-state.js';
import { CONFIG } from '../../config.js';
import { HttpRequestError } from '../../expected-errors.js';
import { buildSessionHeaders } from '../../session-auth.js';
import { padForInsertion } from './dictation-paste-padding.js';
import {
    DEFAULT_DICTATION_NEGATE,
    DEFAULT_DICTATION_QUOTE_CLOSE,
    DEFAULT_DICTATION_QUOTE_OPEN,
    DEFAULT_DICTATION_TAG_PHRASE,
    isValidDictationTagPhrase,
    splitDictatedNotePaste,
} from './dictation-note-paste.js';
import { validateAndRenderTagBar } from './tag-bar-service.js';
import { findOpenQuoteAtIndex, quotePastedSearchText } from './search-syntax-service.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';

// Pasting into the search bar or the tag bar turns dictated text (for example
// from Superwhisper: "Neural network, neural network. Neural-Dash Network.")
// into the user's tags. The server holds the tag list, so it does the cleanup
// (app/services/dictation_cleanup.py, docs/ui/dictation-paste.md). Typing is
// never changed, only pastes.
//
// The pasted text is first inserted as is, then replaced with the cleaned text,
// as two native edits: one Cmd+Z brings back exactly what was pasted.
const moduleState = ApplicationState.createFields('dictation-paste-service', {
    rawInsertInProgress: false,
    // Pastes whose cleanup has been asked for and whose text is not yet inserted.
    cleanupsInProgress: 0,
    // In a paste into a note, this phrase starts the tags (Dictation settings).
    tagPhrase: DEFAULT_DICTATION_TAG_PHRASE,
    // Spoken around a quoted phrase (Dictation settings).
    quoteOpen: DEFAULT_DICTATION_QUOTE_OPEN,
    quoteClose: DEFAULT_DICTATION_QUOTE_CLOSE,
    // Spoken before a search term to exclude it (Dictation settings).
    negate: DEFAULT_DICTATION_NEGATE,
    // The last paste into a note that added tags, so one undo also removes them:
    // { noteId, tagBarBefore, tagBarAfter, contentInserted }. Any later edit ends it.
    notePasteUndo: null,
    // An edit happened after a note paste started (its tags arrive later).
    editedSinceNotePaste: false,
});

// The dictation phrases from preferences (Dictation settings).
export function receiveDictationPhrases({ tagPhrase, quoteOpen, quoteClose, negate }) {
    for (const phrase of [tagPhrase, quoteOpen, quoteClose, negate]) {
        if (!isValidDictationTagPhrase(phrase)) {
            throw new Error(`Invalid dictation phrase: ${phrase}`);
        }
    }
    const distinctPhrases = [quoteOpen, quoteClose, negate];
    if (new Set(distinctPhrases.map((phrase) => phrase.toLowerCase())).size !== distinctPhrases.length) {
        throw new Error('The quote and exclusion phrases must differ');
    }
    if (moduleState.tagPhrase !== tagPhrase) moduleState.tagPhrase = tagPhrase;
    if (moduleState.quoteOpen !== quoteOpen) moduleState.quoteOpen = quoteOpen;
    if (moduleState.quoteClose !== quoteClose) moduleState.quoteClose = quoteClose;
    if (moduleState.negate !== negate) moduleState.negate = negate;
}

// A paste is still being cleaned up: its text is not in the field yet. The cleanup
// runs outside CommandGate, so this is how waiting for an idle app sees it.
export function isDictationCleanupInProgress() {
    return moduleState.cleanupsInProgress > 0;
}

// Counts the paste as in progress from the cleanup request until its text is inserted.
function whileCleaningUp(insertCleanedText) {
    moduleState.cleanupsInProgress += 1;
    return insertCleanedText().finally(() => {
        moduleState.cleanupsInProgress -= 1;
    });
}

// The server holds the tag list, so it cleans the text. Called with fetch, not
// api-client.js, so dialogs that load before the app (and their tests) can use it.
async function cleanDictation(text, target, currentValue) {
    const response = await fetch(CONFIG.API.NOTES.DICTATION_PASTE, {
        method: 'POST',
        headers: buildSessionHeaders(true),
        body: JSON.stringify({
            text, target, current_value: currentValue,
            quote_open: moduleState.quoteOpen, quote_close: moduleState.quoteClose,
            negate_phrase: moduleState.negate,
        }),
    });
    if (!response.ok) {
        throw new HttpRequestError(`Cleaning up the pasted text failed (${response.status})`);
    }
    return response.json();
}

// True while the pasted text is being inserted as is: input handlers leave it
// alone (no enforcement rewrite, which would break native undo, and no search).
export function isDictationRawInsertInProgress() {
    return moduleState.rawInsertInProgress;
}

// Paste targets: the server's cleanup mode, and how the result joins the text
// around it. `tag-lines` is a tag list with one tag per line (privacy lists).
const PASTE_TARGETS = {
    search: { mode: 'search', separator: ' ' },
    tags: { mode: 'tags', separator: ' ' },
    tag: { mode: 'tag', separator: '' },
    'tag-lines': { mode: 'tags', separator: '\n' },
};

function requireTarget(target) {
    if (!Object.prototype.hasOwnProperty.call(PASTE_TARGETS, target)) {
        throw new Error(`Unknown dictation paste target: ${target}`);
    }
    return PASTE_TARGETS[target];
}

function insertAsNativeEdit(text) {
    let inserted;
    if (text === '') {
        inserted = document.execCommand('delete', false);
    } else {
        inserted = document.execCommand('insertText', false, text);
    }
    if (!inserted) {
        throw new Error('The browser refused to insert pasted text');
    }
}

export async function pasteDictatedText(input, target, pastedText) {
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
        throw new TypeError('pasteDictatedText requires an input or textarea element');
    }
    const { mode, separator } = requireTarget(target);
    if (typeof pastedText !== 'string') {
        throw new TypeError('pasteDictatedText requires the pasted text');
    }
    // An input holds one line; so does a single dictated phrase.
    const raw = pastedText.replace(/[\r\n]+/g, ' ');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (typeof start !== 'number' || typeof end !== 'number') {
        throw new Error('Paste target input has no selection');
    }
    // The field without the text being replaced: tags already there are not added again.
    const response = await cleanDictation(raw, mode, `${input.value.slice(0, start)} ${input.value.slice(end)}`);
    if (!response || typeof response.text !== 'string') {
        throw new Error('Dictation paste cleanup returned no text');
    }
    input.focus();
    // Insert where the selection is now (the user may have moved it meanwhile).
    const insertStart = input.selectionStart;
    const textBefore = input.value.slice(0, insertStart);
    const textAfter = input.value.slice(input.selectionEnd);
    const rawPadded = padForInsertion(raw, textBefore, textAfter, separator);
    // A failed insert throws (fatal), so the flag needs no other reset.
    moduleState.rawInsertInProgress = true;
    insertAsNativeEdit(rawPadded);
    moduleState.rawInsertInProgress = false;
    input.setSelectionRange(insertStart, insertStart + rawPadded.length);
    let cleaned = response.text;
    if (separator === '\n') cleaned = cleaned.split(' ').join('\n');
    insertAsNativeEdit(padForInsertion(cleaned, textBefore, textAfter, separator));
}

// Paste listener for the search input and the tag bar input.
export function handleDictationPasteEvent(event, target) {
    if (!event || !event.clipboardData) {
        throw new Error('Dictation paste requires a paste event with clipboard data');
    }
    requireTarget(target);
    const pastedText = event.clipboardData.getData('text/plain');
    if (pastedText === '') {
        return;
    }
    event.preventDefault();
    if (target === 'search') {
        // Inside a quoted phrase the paste is text to find, inserted as copied.
        const quoteChar = findOpenQuoteAtIndex(event.target.value, event.target.selectionStart);
        if (quoteChar !== '') {
            insertAsNativeEdit(quotePastedSearchText(pastedText, quoteChar));
            return;
        }
    }
    void whileCleaningUp(() => pasteDictatedText(event.target, target, pastedText));
}

// Any edit in a note or its tag bar: an undo is no longer about the last paste.
export function noteDictationEditSeen() {
    if (!moduleState.editedSinceNotePaste) moduleState.editedSinceNotePaste = true;
    if (moduleState.notePasteUndo !== null) moduleState.notePasteUndo = null;
}

// A paste into the note being edited whose text holds the tag phrase ("start
// tags"): the text before it is inserted as one native edit, the text after it becomes
// tags added to the tag bar. Returns false (leaving the paste alone) otherwise.
export function handleDictatedNotePaste(event, noteElement, plainText) {
    if (!(noteElement instanceof HTMLElement) || typeof plainText !== 'string') {
        throw new TypeError('handleDictatedNotePaste requires the note element and pasted text');
    }
    const split = splitDictatedNotePaste(plainText, moduleState.tagPhrase);
    if (split === null) {
        return false;
    }
    event.preventDefault();
    const contentInserted = split.content !== '';
    if (contentInserted) {
        insertAsNativeEdit(split.content);
    }
    if (moduleState.editedSinceNotePaste) moduleState.editedSinceNotePaste = false;
    if (moduleState.notePasteUndo !== null) moduleState.notePasteUndo = null;
    if (split.tagText !== '') {
        void whileCleaningUp(() => addDictatedTags(noteElement, split.tagText, contentInserted));
    }
    return true;
}

async function addDictatedTags(noteElement, tagText, contentInserted) {
    const tagBar = noteElement.querySelector('.note-tag-bar-input');
    if (!(tagBar instanceof HTMLInputElement)) {
        throw new Error('The note being edited has no tag bar');
    }
    const response = await cleanDictation(tagText, 'tags', tagBar.value);
    if (!response || typeof response.text !== 'string') {
        throw new Error('Dictation paste cleanup returned no text');
    }
    if (response.text === '') {
        return;
    }
    const tagBarBefore = tagBar.value;
    tagBar.value = tagBarBefore + padForInsertion(response.text, tagBarBefore, '', ' ');
    validateAndRenderTagBar(noteElement);
    if (!ModeContext.editSessionHasEdits) ModeContext.markEditSessionHasEdits();
    if (!ModeContext.isDirty) ModeContext.setDirty(true);
    // Paired with the pasted text for undo only if nothing was edited meanwhile.
    if (!moduleState.editedSinceNotePaste) {
        moduleState.notePasteUndo = {
            noteId: noteElement.dataset.noteId, tagBarBefore, tagBarAfter: tagBar.value, contentInserted,
        };
    }
}

// Cmd/Ctrl+Z right after such a paste: put the tag bar back as it was. Returns
// true when the undo is complete (the paste inserted no text); otherwise the
// note's own undo then removes the pasted text.
export function undoDictatedNotePasteTags(event) {
    const link = moduleState.notePasteUndo;
    if (link === null || !ModeContext.isEditingNote(link.noteId)) {
        return false;
    }
    moduleState.notePasteUndo = null;
    const noteElement = document.querySelector(`[data-note-id="${link.noteId}"]`);
    const tagBar = noteElement.querySelector('.note-tag-bar-input');
    if (tagBar.value !== link.tagBarAfter) {
        return false;
    }
    tagBar.value = link.tagBarBefore;
    validateAndRenderTagBar(noteElement);
    if (link.contentInserted) {
        return false;
    }
    event.preventDefault();
    return true;
}
