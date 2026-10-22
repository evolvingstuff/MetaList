import { ApplicationState, stateValuesEqual } from '../../application-state.js';
import { CONFIG } from '../../config.js';
import { findPhraseMatches } from './search-highlight-matching.js';

// The search's quoted phrases, marked where they occur in the notes list
// (docs/ui/search-semantics.md). Principle 5 of docs/ui/interaction-principles.md: the
// user typed the phrase but cannot know where it occurs in each note. Marks are painted
// with the CSS Custom Highlight API, so nothing in the page changes: no layout, scroll,
// caret, copy or saved HTML is touched (principle 1). The note being edited, full
// screen, floating windows, export and print are not marked.

const HIGHLIGHT_NAME = 'metalist-search';
const NOTES_CONTAINER_ID = 'notes-container';
const TAG_COMMENT_CLASS = 'note-tag--comment';
// Elements whose start and end break the text the way the search reads it: one space.
const TEXT_BREAKING_ELEMENTS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
    'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT',
    'TH', 'THEAD', 'TR', 'UL',
]);
const WHITESPACE = /\s/;

const moduleState = ApplicationState.createFields('search-highlight-service', {
    phrases: [],
    observer: null,
    isPaintRequested: false,
});

function validatePhrases(phrases) {
    if (!Array.isArray(phrases)) {
        throw new Error('searchHighlightPhrases must be an array');
    }
    for (const phrase of phrases) {
        if (typeof phrase !== 'string' || phrase.trim() === '') {
            throw new Error('searchHighlightPhrases must hold non-blank strings');
        }
    }
    return phrases;
}

// One element's text as the search reads it, with the text node and offset of each
// character: every run of whitespace, and every break between blocks or lines, is one
// space (a break has no node of its own).
function readVisibleText(root) {
    const reading = { text: '', nodes: [], offsets: [] };
    const addSpace = (node, offset) => {
        if (reading.text === '' || reading.text.endsWith(' ')) {
            return;
        }
        reading.text += ' ';
        reading.nodes.push(node);
        reading.offsets.push(offset);
    };
    const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const data = node.data;
            for (let offset = 0; offset < data.length; offset += 1) {
                if (WHITESPACE.test(data[offset])) {
                    addSpace(node, offset);
                } else {
                    reading.text += data[offset];
                    reading.nodes.push(node);
                    reading.offsets.push(offset);
                }
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
        }
        const breaksText = TEXT_BREAKING_ELEMENTS.has(node.tagName);
        if (breaksText) {
            addSpace(null, 0);
        }
        for (const child of node.childNodes) {
            visit(child);
        }
        if (breaksText) {
            addSpace(null, 0);
        }
    };
    visit(root);
    return reading;
}

// The ranges where phrases occur in an element's text, in text order (find uses them too).
export function phraseRangesIn(root, phrases) {
    const reading = readVisibleText(root);
    return findPhraseMatches(reading.text, phrases).map(([start, end]) => {
        // A phrase is trimmed before matching, so it starts and ends on real text.
        const startNode = reading.nodes[start];
        const endNode = reading.nodes[end - 1];
        if (!(startNode instanceof Text) || !(endNode instanceof Text)) {
            throw new Error('A search highlight must start and end in text');
        }
        const range = document.createRange();
        range.setStart(startNode, reading.offsets[start]);
        range.setEnd(endNode, reading.offsets[end - 1] + 1);
        return range;
    });
}

function isInEditedNote(element) {
    const note = element.closest(`.${CONFIG.CLASSES.NOTE}`);
    if (note === null) {
        throw new Error('A highlighted element must be inside a note');
    }
    return note.classList.contains(CONFIG.CLASSES.EDITING);
}

// Each note's own content (an embed is read with the note it is in) and each tag-bar
// comment, outside the note being edited.
function highlightedElements(container) {
    const contents = Array.from(container.querySelectorAll(`.${CONFIG.CLASSES.NOTE_CONTENT}`))
        .filter(content => content.parentElement.closest(`.${CONFIG.CLASSES.NOTE_CONTENT}`) === null);
    const comments = Array.from(container.querySelectorAll(`.${TAG_COMMENT_CLASS}`));
    return [...contents, ...comments].filter(element => !isInEditedNote(element));
}

function notesContainer() {
    const container = document.getElementById(NOTES_CONTAINER_ID);
    if (!(container instanceof HTMLElement)) {
        throw new Error('Search highlighting requires the notes container');
    }
    return container;
}

function paint() {
    moduleState.isPaintRequested = false;
    if (moduleState.phrases.length === 0) {
        CSS.highlights.delete(HIGHLIGHT_NAME);
        return;
    }
    const ranges = highlightedElements(notesContainer()).flatMap(element => phraseRangesIn(element, moduleState.phrases));
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

function requestPaint() {
    if (moduleState.isPaintRequested) {
        return;
    }
    moduleState.isPaintRequested = true;
    requestAnimationFrame(paint);
}

// The phrases of the search the notes list now shows (the server's reading of it);
// none clears the marks. Painting follows every later change to the list.
export function setSearchHighlightPhrases(phrases) {
    const nextPhrases = [...validatePhrases(phrases)];
    if (stateValuesEqual(moduleState.phrases, nextPhrases)) {
        return;
    }
    moduleState.phrases = nextPhrases;
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) {
        throw new Error('Search highlighting requires the CSS Custom Highlight API (Firefox 140, Chrome 105 or later)');
    }
    if (moduleState.phrases.length === 0) {
        if (moduleState.observer !== null) {
            moduleState.observer.disconnect();
            moduleState.observer = null;
        }
        requestPaint();
        return;
    }
    if (moduleState.observer === null) {
        moduleState.observer = new MutationObserver(requestPaint);
        moduleState.observer.observe(notesContainer(), {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class'],
        });
    }
    requestPaint();
}
