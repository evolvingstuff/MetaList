// Keeps what the user is looking at still while the page changes under it:
// view diffs adding or removing roots above the viewport (the loaded band of
// roots moving), or a note leaving edit mode (re-rendering, re-collapsing).
//
// A hold anchors either a text position inside a note ("text": the caret, or
// the line the user was reading) or a note's top edge ("top"). While a hold is
// active, every layout change of the notes container is corrected from a
// ResizeObserver callback, which runs after layout and before paint, so the
// anchored text never visibly jumps. The browser's own scroll anchoring is
// switched off meanwhile so the two never fight. The hold ends on any user
// input or scroll, once the layout has been still for a moment, or after a
// maximum time.

import { ApplicationState } from '../../application-state.js';
import { getViewportTopInset } from './scroll-restoration-service.js';
import { DELIBERATE_SCROLL_EVENT } from './animated-scroll-service.js';

// How much of a kept-visible note must remain below the search controls.
const MIN_VISIBLE_PX = 24;
const QUIET_MS = 700;
const MAX_HOLD_MS = 4000;
// Characters of context recorded on each side of an anchored text position.
const CONTEXT_CHARS = 30;
const USER_INPUT_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown', 'pointerdown'];
// Shorter text fragments match too easily to count as the same place.
const MIN_MATCH_CHARS = 8;
// The longest LaTeX delimiter ($$, \\[, \\( and their closers).
const FORMULA_DELIMITER_CHARS = 2;

const moduleState = ApplicationState.createFields('viewport-hold-service', {
    session: null,
});

// A note being edited keeps its `collapsed` class but shows its content.
function isShownCollapsed(element) {
    return element.classList.contains('collapsed') && !element.classList.contains('editing');
}

function notesContainer() {
    const container = document.getElementById('notes-container');
    if (!container) {
        throw new Error('notes-container not found');
    }
    return container;
}

function findNoteElement(noteId) {
    return notesContainer().querySelector(`.note[data-note-id="${CSS.escape(noteId)}"]`);
}

function noteContent(noteElement) {
    const content = noteElement.querySelector(':scope > .note-content');
    if (!(content instanceof HTMLElement)) {
        throw new Error(`Note ${noteElement.dataset.noteId} has no content element`);
    }
    return content;
}

export function captureViewportRoot() {
    for (const element of notesContainer().querySelectorAll(':scope > .note[data-note-id]')) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > 0) {
            return { kind: 'top', noteId: element.dataset.noteId, top: rect.top, keepVisible: false };
        }
    }
    return null;
}

// --- Text positions -------------------------------------------------------

function textOffsetOf(content, node, offset) {
    const range = document.createRange();
    range.setStart(content, 0);
    range.setEnd(node, offset);
    return range.toString().length;
}

// Screen Y of the character position `position` in content's text, or null.
// The text node and offset of character position `position` in content's
// text. Line breaks add no text, so the end of one line and the start of the
// next are the same position: `affinity` 'forward' picks the next line's
// start (a click on a line, a source line), 'backward' the previous line's
// end (a caret left after typing at a line's end).
export function textPositionToNodePoint(content, position, affinity) {
    if (affinity !== 'forward' && affinity !== 'backward') {
        throw new Error(`Unknown text affinity: ${affinity}`);
    }
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let last = null;
    let node = walker.nextNode();
    while (node !== null) {
        const end = consumed + node.data.length;
        if (position < end || (affinity === 'backward' && position === end)) {
            return { node, offset: position - consumed };
        }
        consumed = end;
        last = node;
        node = walker.nextNode();
    }
    if (last !== null && position === consumed) {
        return { node: last, offset: last.data.length };
    }
    return null;
}

// Character position of a DOM point within content's text.
export function textOffsetOfPoint(content, node, offset) {
    const range = document.createRange();
    range.setStart(content, 0);
    range.setEnd(node, offset);
    return range.toString().length;
}

// Where the user is working in the note being edited, so a redraw puts it back
// exactly (interaction principle 1): the tag bar's caret, or the caret or
// selection in the text, by node (when the redraw keeps it) and by text
// position. null when focus is elsewhere.
export function captureEditingFocus(noteElement) {
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error('captureEditingFocus requires note element');
    }
    const input = noteElement.querySelector(':scope > .note-tag-bar .note-tag-bar-input');
    if (input instanceof HTMLInputElement && document.activeElement === input) {
        return { kind: 'tag-bar', start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
    }
    const content = noteElement.querySelector(':scope > .note-content');
    const selection = window.getSelection();
    if (!(content instanceof HTMLElement) || selection.rangeCount === 0
        || !content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) {
        return null;
    }
    return {
        kind: 'content',
        anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode, focusOffset: selection.focusOffset,
        anchorPosition: textOffsetOfPoint(content, selection.anchorNode, selection.anchorOffset),
        focusPosition: textOffsetOfPoint(content, selection.focusNode, selection.focusOffset),
    };
}

// The node, while it is still in the content; else the text position (a focus
// recorded as positions only has no node).
function restoredPoint(content, node, offset, position) {
    if (node !== null && node.isConnected && content.contains(node)) {
        return { node, offset };
    }
    const point = textPositionToNodePoint(content, position, 'backward');
    if (point !== null) {
        return point;
    }
    return { node: content, offset: content.childNodes.length };
}

export function restoreEditingFocus(noteElement, captured) {
    if (!(noteElement instanceof HTMLElement) || captured === null || typeof captured !== 'object') {
        throw new Error('restoreEditingFocus requires note element and captured focus');
    }
    if (captured.kind === 'tag-bar') {
        const input = noteElement.querySelector(':scope > .note-tag-bar .note-tag-bar-input');
        if (!(input instanceof HTMLInputElement)) {
            throw new Error('restoreEditingFocus: the edited note lost its tag bar');
        }
        input.focus({ preventScroll: true });
        input.setSelectionRange(captured.start, captured.end, captured.direction);
        return;
    }
    if (captured.kind !== 'content') {
        throw new Error(`Unknown captured focus: ${captured.kind}`);
    }
    const content = noteElement.querySelector(':scope > .note-content');
    if (!(content instanceof HTMLElement)) {
        throw new Error('restoreEditingFocus: note content missing');
    }
    const anchor = restoredPoint(content, captured.anchorNode, captured.anchorOffset, captured.anchorPosition);
    const focus = restoredPoint(content, captured.focusNode, captured.focusOffset, captured.focusPosition);
    content.focus({ preventScroll: true });
    window.getSelection().setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

// Screen Y of character position `position` in content's text, or null.
function textPositionToY(content, position, affinity) {
    const point = textPositionToNodePoint(content, position, affinity);
    if (point === null) {
        return null;
    }
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.collapse(true);
    const rects = range.getClientRects();
    if (rects.length > 0) {
        return rects[0].top;
    }
    const parentRect = point.node.parentElement.getBoundingClientRect();
    return parentRect.height > 0 ? parentRect.top : null;
}

// Screen Y of the content's first line of text (its box top when it has no text).
function firstLineTop(content) {
    const y = textPositionToY(content, 0, 'forward');
    if (y === null) {
        return content.getBoundingClientRect().top;
    }
    return y;
}

// Where an anchored text position is in `text` (the note's text after it
// re-rendered): the surrounding text matched nearest to the old offset, or,
// when the text changed shape, the same proportion of the way through.
// `exact` is false when only an approximate position could be found.
export function findTextPosition(text, anchor) {
    if (typeof text !== 'string') {
        throw new Error('findTextPosition requires text');
    }
    const nearest = (needle, shift) => {
        if (needle.length === 0) {
            return null;
        }
        let best = null;
        let index = text.indexOf(needle);
        while (index !== -1) {
            const position = index + shift;
            if (best === null || Math.abs(position - anchor.textOffset) < Math.abs(best - anchor.textOffset)) {
                best = position;
            }
            index = text.indexOf(needle, index + 1);
        }
        return best;
    };
    const trimmedBefore = anchor.before.trimEnd();
    const trimmedAfter = anchor.after.trimStart();
    for (const [needle, shift] of [
        [anchor.before + anchor.after, anchor.before.length],
        // Rendering can drop whitespace the user just typed next to the caret.
        [trimmedBefore + trimmedAfter, trimmedBefore.length],
    ]) {
        if (needle.length >= MIN_MATCH_CHARS) {
            const position = nearest(needle, shift);
            if (position !== null) {
                return { position, exact: true, affinity: anchor.affinity };
            }
        }
    }
    // Source and rendering differ in markup next to the place (list markers,
    // heading hashes, emphasis): match the longest run of the text on one side
    // of it that survives. The side the place belongs to goes first: at the end
    // of a line (backward), the text before it, so a click past a line's end
    // stays on that line instead of the next one starting at the same offset.
    const matchAfter = () => {
        for (let length = trimmedAfter.length; length >= MIN_MATCH_CHARS; length -= 1) {
            const position = nearest(trimmedAfter.slice(0, length), 0);
            if (position !== null) {
                return { position, exact: true, affinity: 'forward' };
            }
        }
        return null;
    };
    const matchBefore = () => {
        for (let length = trimmedBefore.length; length >= MIN_MATCH_CHARS; length -= 1) {
            const position = nearest(trimmedBefore.slice(trimmedBefore.length - length), length);
            if (position !== null) {
                return { position, exact: true, affinity: 'backward' };
            }
        }
        return null;
    };
    let sides = [matchAfter, matchBefore];
    if (anchor.atRunEnd === true) {
        sides = [matchBefore, matchAfter];
    }
    for (const matchSide of sides) {
        const found = matchSide();
        if (found !== null) {
            return found;
        }
    }
    const proportional = Math.round(anchor.textOffset * text.length / Math.max(1, anchor.textLength));
    // Too little text either side to match (a short Markdown list item, whose
    // "- " the rendering drops): the run of text the place is in, whole, where
    // it occurs nearest to the same proportion of the way through.
    if (anchor.runText.trim() !== '') {
        let best = null;
        let index = text.indexOf(anchor.runText);
        while (index !== -1) {
            if (best === null || Math.abs(index - proportional) < Math.abs(best - proportional)) {
                best = index;
            }
            index = text.indexOf(anchor.runText, index + 1);
        }
        if (best !== null) {
            return { position: best + anchor.runOffset, exact: true, affinity: anchor.affinity };
        }
    }
    return { position: Math.min(text.length, Math.max(0, proportional)), exact: false, affinity: anchor.affinity };
}

// The text node a DOM point is in, whole, and the point's offset in it; empty
// when the point is not in a text node.
function runOf(node, offset) {
    if (node.nodeType !== Node.TEXT_NODE) {
        return { runText: '', runOffset: 0 };
    }
    return { runText: node.data, runOffset: offset };
}

// Whether a DOM point is at the very end of its text node: in rendered
// Markdown, the end of a line (a click past it, or on the border beside it).
function isAtRunEnd(node, offset) {
    return node.nodeType === Node.TEXT_NODE && offset === node.length;
}

// A DOM point at the very start of a text node belongs to that line; any
// other point (e.g. the end of a line just typed) to the text before it.
function affinityOfDomPoint(node, offset) {
    if (node.nodeType === Node.TEXT_NODE && offset === 0) {
        return 'forward';
    }
    return 'backward';
}

export function caretPositionAt(x, y) {
    if (typeof document.caretPositionFromPoint === 'function') {
        const position = document.caretPositionFromPoint(x, y);
        return position === null ? null : { node: position.offsetNode, offset: position.offset };
    }
    if (typeof document.caretRangeFromPoint === 'function') {
        const range = document.caretRangeFromPoint(x, y);
        return range === null ? null : { node: range.startContainer, offset: range.startOffset };
    }
    return null;
}

// What to keep in place when this note leaves edit mode: the caret if it is
// on screen, otherwise the text at the reading line (a third of the way down
// the usable viewport), otherwise the note's top. `keepVisible` keeps a note
// that collapses or shrinks in view.
export function captureNoteAnchor(noteElement) {
    const noteId = noteElement.dataset.noteId;
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('captureNoteAnchor requires a note element with an id');
    }
    const content = noteContent(noteElement);
    const noteTop = noteElement.getBoundingClientRect().top;
    // Where the note's first line of text is: a note that collapses again
    // keeps its (first-line) row there.
    const contentTop = firstLineTop(content);
    const inset = getViewportTopInset();
    const viewportBottom = window.innerHeight;
    const textAnchorAt = (node, offset) => {
        const text = content.textContent;
        const textOffset = textOffsetOf(content, node, offset);
        const affinity = affinityOfDomPoint(node, offset);
        const screenY = textPositionToY(content, textOffset, affinity);
        if (screenY === null) {
            return null;
        }
        return {
            kind: 'text', noteId, screenY, textOffset, textLength: text.length,
            before: text.slice(Math.max(0, textOffset - CONTEXT_CHARS), textOffset),
            after: text.slice(textOffset, textOffset + CONTEXT_CHARS),
            noteTop, contentTop, keepVisible: true, affinity, atRunEnd: isAtRunEnd(node, offset), editText: text,
            ...runOf(node, offset),
        };
    };

    const selection = window.getSelection();
    if (selection !== null && selection.rangeCount > 0 && content.contains(selection.focusNode)) {
        const caret = textAnchorAt(selection.focusNode, selection.focusOffset);
        if (caret !== null && caret.screenY >= inset && caret.screenY <= viewportBottom) {
            return caret;
        }
    }

    const readingLineY = inset + (viewportBottom - inset) / 3;
    const contentRect = content.getBoundingClientRect();
    if (contentRect.top <= readingLineY && contentRect.bottom >= readingLineY) {
        const position = caretPositionAt(contentRect.left + Math.min(40, contentRect.width / 2), readingLineY);
        if (position !== null && content.contains(position.node)) {
            const reading = textAnchorAt(position.node, position.offset);
            if (reading !== null) {
                return reading;
            }
        }
    }

    return { kind: 'top', noteId, top: noteTop, contentTop, keepVisible: true };
}

// What to keep in place when a click enters edit mode: the clicked text (it
// stays under the pointer once the note shows its editable source), or the
// note's top when the click was not on text (e.g. a rendered diagram).
export function captureClickAnchor(noteElement, x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') {
        throw new Error('captureClickAnchor requires click coordinates');
    }
    const noteId = noteElement.dataset.noteId;
    if (typeof noteId !== 'string' || noteId.length === 0) {
        throw new Error('captureClickAnchor requires a note element with an id');
    }
    const noteTop = noteElement.getBoundingClientRect().top;
    const content = noteContent(noteElement);
    const formulaAnchor = captureFormulaClickAnchor({ content, noteId, noteTop, x, y });
    if (formulaAnchor !== null) {
        return formulaAnchor;
    }
    const diagramAnchor = captureDiagramClickAnchor({ content, noteId, noteTop, x, y });
    if (diagramAnchor !== null) {
        return diagramAnchor;
    }
    const topAnchor = { kind: 'top', noteId, top: noteTop, keepVisible: false, clickX: x, clickY: y };
    const position = caretPositionAt(x, y);
    let textAnchor = null;
    if (position !== null && position.node.nodeType === Node.TEXT_NODE && content.contains(position.node)) {
        const text = content.textContent;
        const textOffset = textOffsetOf(content, position.node, position.offset);
        const affinity = affinityOfDomPoint(position.node, position.offset);
        const screenY = textPositionToY(content, textOffset, affinity);
        if (screenY !== null) {
            textAnchor = {
                kind: 'text', noteId, screenY, textOffset, textLength: text.length,
                before: text.slice(Math.max(0, textOffset - CONTEXT_CHARS), textOffset),
                after: text.slice(textOffset, textOffset + CONTEXT_CHARS),
                noteTop, keepVisible: false, clickX: x, clickY: y, affinity,
                atRunEnd: isAtRunEnd(position.node, position.offset),
                ...runOf(position.node, position.offset),
            };
        }
    }
    const referenceAnchor = captureReferenceClickAnchor({ content, noteId, x, y, position, textAnchor, topAnchor });
    if (referenceAnchor !== null) {
        return referenceAnchor;
    }
    if (textAnchor !== null) {
        return textAnchor;
    }
    return topAnchor;
}

// --- Note references --------------------------------------------------------

// The rendering shows a referenced note (its first line, or all of it
// embedded) where the source has its [[UUID]] or ![[UUID]] token, so the text
// around a click past a reference is not in the source. A click on one of the
// note's references, or in its text after one, is placed relative to that
// reference: by which reference it is, and the exact text between its end and
// the click, which follows the token in the source too.

const REFERENCE_BLOCK_SELECTOR = '.note-reference-block[data-ref-note-id][data-ref-mode]';

// The note's own references (not those inside a note it embeds), in order.
function referenceBlocksOf(content, noteId) {
    return [...content.querySelectorAll(REFERENCE_BLOCK_SELECTOR)]
        .filter((block) => block.dataset.refHostNoteId === noteId);
}

function referenceToken(referenceId, mode) {
    if (mode === 'embed') {
        return `![[${referenceId}]]`;
    }
    if (mode === 'link') {
        return `[[${referenceId}]]`;
    }
    throw new Error(`Unknown reference mode: ${mode}`);
}

// Which reference a block is: its note, its mode, and how many references to
// that note in that mode come before it.
function referenceIdentity(blocks, block) {
    const referenceId = block.dataset.refNoteId;
    const mode = block.dataset.refMode;
    const occurrence = blocks.slice(0, blocks.indexOf(block))
        .filter((earlier) => earlier.dataset.refNoteId === referenceId && earlier.dataset.refMode === mode).length;
    return { referenceId, mode, occurrence };
}

function captureReferenceClickAnchor({ content, noteId, x, y, position, textAnchor, topAnchor }) {
    const blocks = referenceBlocksOf(content, noteId);
    if (blocks.length === 0) {
        return null;
    }
    const base = { kind: 'reference', noteId, noteTop: topAnchor.top, keepVisible: false, clickX: x, clickY: y };
    // On the reference itself (the embedded note): the start of its token,
    // which goes where the reference's top was.
    const hit = document.elementFromPoint(x, y);
    if (hit !== null) {
        const clickedBlock = blocks.find((block) => block.contains(hit));
        if (clickedBlock !== undefined) {
            return {
                ...base, ...referenceIdentity(blocks, clickedBlock), onReference: true, gapText: '',
                affinity: 'forward', screenY: clickedBlock.getBoundingClientRect().top, fallback: topAnchor,
            };
        }
    }
    if (textAnchor === null) {
        return null;
    }
    const preceding = blocks.filter((block) => !block.contains(position.node)
        && (block.compareDocumentPosition(position.node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    if (preceding.length === 0) {
        return null;
    }
    const block = preceding[preceding.length - 1];
    const gap = document.createRange();
    gap.setStartAfter(block);
    gap.setEnd(position.node, position.offset);
    return {
        ...base, ...referenceIdentity(blocks, block), onReference: false, gapText: gap.toString(),
        affinity: textAnchor.affinity, screenY: textAnchor.screenY, fallback: textAnchor,
    };
}

// Where the reference's token starts in the source text; null when absent
// (e.g. still the rendered view).
function referenceTokenStart(text, reference) {
    const token = referenceToken(reference.referenceId, reference.mode);
    const pattern = new RegExp(token.replace(/[![\]]/g, '\\$&'), 'g');
    let seen = 0;
    for (const match of text.matchAll(pattern)) {
        // [[UUID]] inside ![[UUID]] is the embed's token, not a link.
        const isEmbedTail = reference.mode === 'link' && text.slice(0, match.index).endsWith('!');
        if (!isEmbedTail) {
            if (seen === reference.occurrence) {
                return match.index;
            }
            seen += 1;
        }
    }
    return null;
}

// The source position a reference anchor names: the start of the token for a
// click on the reference, else the end of the token plus the text the click
// followed it by, when exactly that text follows it. null otherwise.
function findReferencePosition(text, reference) {
    const start = referenceTokenStart(text, reference);
    if (start === null) {
        return null;
    }
    if (reference.onReference) {
        return start;
    }
    const end = start + referenceToken(reference.referenceId, reference.mode).length;
    if (text.slice(end, end + reference.gapText.length) !== reference.gapText) {
        return null;
    }
    return end + reference.gapText.length;
}

const MERMAID_BLOCK_SELECTOR = '.meta-mermaid-diagram, pre.meta-mermaid-source';
const FORMULA_SELECTOR = '.meta-latex[data-latex-source]';

// Rendered formulas in `content`, each with its TeX source and which repeat of
// that same source it is (the server renders them in source order).
function formulasIn(content) {
    const seen = new Map();
    return [...content.querySelectorAll(FORMULA_SELECTOR)].map((element) => {
        const source = element.dataset.latexSource;
        let occurrence = 0;
        if (seen.has(source)) {
            occurrence = seen.get(source) + 1;
        }
        seen.set(source, occurrence);
        return { element, source, occurrence };
    });
}

// A click on a rendered formula: its math has no text in common with its TeX
// source, so the formula's own source (carried by the server) says where to
// go: that source goes under the pointer, with the caret at its start.
function captureFormulaClickAnchor({ content, noteId, noteTop, x, y }) {
    const hit = document.elementFromPoint(x, y);
    if (hit === null) {
        return null;
    }
    const element = hit.closest(FORMULA_SELECTOR);
    if (element === null || !content.contains(element) || element.dataset.latexSource.length === 0) {
        return null;
    }
    const formula = formulasIn(content).find((candidate) => candidate.element === element);
    return {
        kind: 'source', noteId, noteTop, keepVisible: false, clickX: x, clickY: y,
        needles: [{ text: formula.source, shift: 0 }], occurrence: formula.occurrence,
        screenY: element.getBoundingClientRect().top,
    };
}

// Leaving edit mode with the caret inside a formula's TeX source: the rendered
// formula whose source contains the caret (found in the text as it was being
// edited), or null.
function formulaAtEditedOffset(content, editText, textOffset) {
    for (const formula of formulasIn(content)) {
        let index = -1;
        for (let repeat = 0; repeat <= formula.occurrence; repeat += 1) {
            index = editText.indexOf(formula.source, index + 1);
            if (index === -1) {
                break;
            }
        }
        // The delimiters around the source ($$, \( …) count as the formula too.
        if (index !== -1 && textOffset >= index - FORMULA_DELIMITER_CHARS
            && textOffset <= index + formula.source.length + FORMULA_DELIMITER_CHARS) {
            return formula.element;
        }
    }
    return null;
}

// How a Mermaid node's label can appear in its source: A[label], C{label},
// D(label), quoted labels, and the other bracket shapes.
function mermaidLabelNeedles(label) {
    const needles = [];
    for (const [open, close] of [
        ['[', ']'], ['{', '}'], ['(', ')'], ['["', '"]'], ['{"', '"}'], ['("', '")'],
        ['[[', ']]'], ['((', '))'], ['([', '])'], ['{{', '}}'], ['>', ']'],
    ]) {
        needles.push({ text: `${open}${label}${close}`, shift: open.length });
    }
    return needles;
}

// A click on a rendered Mermaid diagram: the browser's text hit-testing is
// unreliable inside it and its text is in drawing order, so the diagram's own
// structure says what was clicked. A box maps to its label in the source (that
// source line goes under the pointer); anywhere else maps to the diagram's
// ```mermaid line, held where the diagram's top was. Null when the click was
// not on a diagram.
function captureDiagramClickAnchor({ content, noteId, noteTop, x, y }) {
    const hit = document.elementFromPoint(x, y);
    if (hit === null) {
        return null;
    }
    const block = hit.closest(MERMAID_BLOCK_SELECTOR);
    if (block === null || !content.contains(block)) {
        return null;
    }
    const base = { kind: 'source', noteId, noteTop, keepVisible: false, clickX: x, clickY: y };
    const node = hit.closest('g.node');
    if (node !== null) {
        const labelElement = node.querySelector('.nodeLabel');
        if (labelElement !== null && labelElement.textContent.trim().length > 0) {
            return {
                ...base, needles: mermaidLabelNeedles(labelElement.textContent.trim()), occurrence: 0,
                screenY: labelElement.getBoundingClientRect().top,
            };
        }
    }
    const blocks = [...content.querySelectorAll(MERMAID_BLOCK_SELECTOR)];
    return {
        ...base, needles: [{ text: '```mermaid', shift: 0 }], occurrence: blocks.indexOf(block),
        screenY: block.getBoundingClientRect().top,
    };
}

// The text position a source anchor names: the `occurrence`-th match, in text
// order, of any of its needles; null when absent (e.g. still the rendered view).
function findSourcePosition(text, reference) {
    const positions = [];
    for (const needle of reference.needles) {
        let index = text.indexOf(needle.text);
        while (index !== -1) {
            positions.push(index + needle.shift);
            index = text.indexOf(needle.text, index + 1);
        }
    }
    positions.sort((first, second) => first - second);
    if (reference.occurrence >= positions.length) {
        return null;
    }
    return positions[reference.occurrence];
}


// Puts the caret of the now-editable note where the user clicked, never
// scrolling: at the clicked text when it is found exactly, otherwise at
// whatever is under the pointer now that the view is held (e.g. the source of
// a clicked diagram), otherwise at the start of the note.
export function placeCaretAtClickAnchor(noteElement, reference) {
    validateReference(reference);
    if (typeof reference.clickX !== 'number' || typeof reference.clickY !== 'number') {
        throw new Error('placeCaretAtClickAnchor requires a click anchor');
    }
    const content = noteContent(noteElement);
    if (reference.kind === 'reference') {
        const position = findReferencePosition(content.textContent, reference);
        if (position === null) {
            placeCaretAtClickAnchor(noteElement, reference.fallback);
            return;
        }
        placeCaretAtNodePoint(content, textPositionToNodePoint(content, position, reference.affinity));
        return;
    }
    let point = null;
    if (reference.kind === 'text') {
        const found = findTextPosition(content.textContent, reference);
        if (found.exact) {
            point = textPositionToNodePoint(content, found.position, found.affinity);
        }
    }
    if (reference.kind === 'source') {
        const position = findSourcePosition(content.textContent, reference);
        if (position !== null) {
            point = textPositionToNodePoint(content, position, 'forward');
        }
    }
    if (point === null) {
        const underPointer = caretPositionAt(reference.clickX, reference.clickY);
        if (underPointer !== null && content.contains(underPointer.node)) {
            point = underPointer;
        }
    }
    if (point === null) {
        point = { node: content, offset: 0 };
    }
    placeCaretAtNodePoint(content, point);
}

function placeCaretAtNodePoint(content, point) {
    if (point === null) {
        throw new Error('A found text position must map to a point in the note');
    }
    const range = document.createRange();
    range.setStart(point.node, point.offset);
    range.collapse(true);
    content.focus({ preventScroll: true });
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

// --- Sorted tabs ----------------------------------------------------------

function rootElementOf(noteElement) {
    const container = notesContainer();
    let element = noteElement;
    while (element.parentElement !== container) {
        const parentNote = element.parentElement.closest('.note[data-note-id]');
        if (parentNote === null) {
            throw new Error('Note is not inside a root note of the notes container');
        }
        element = parentNote;
    }
    return element;
}

// The id of the root note right before or after `rootElement`, or null.
function siblingInDirection(element, direction) {
    if (direction === 'previous') {
        return element.previousElementSibling;
    }
    if (direction === 'next') {
        return element.nextElementSibling;
    }
    throw new Error(`Unknown direction: ${direction}`);
}

function adjacentRootId(rootElement, direction) {
    let element = siblingInDirection(rootElement, direction);
    while (element !== null && !element.matches('.note[data-note-id]')) {
        element = siblingInDirection(element, direction);
    }
    if (element === null) {
        return null;
    }
    return element.dataset.noteId;
}

// Leaving edit mode in a sorted tab moves the edited note's root to its sorted
// place. While that root keeps its neighbours, hold the caret/reading-line
// anchor as usual; once it has moved, hold the root that was below it (or
// above, at the end of the list) so the surrounding notes stay on screen.
export function captureSortedExitAnchor(noteElement) {
    const primary = captureNoteAnchor(noteElement);
    const root = rootElementOf(noteElement);
    const previousRootId = adjacentRootId(root, 'previous');
    const nextRootId = adjacentRootId(root, 'next');
    let neighbourId = nextRootId;
    if (neighbourId === null) {
        neighbourId = previousRootId;
    }
    if (neighbourId === null) {
        return primary;
    }
    const neighbourTop = findNoteElement(neighbourId).getBoundingClientRect().top;
    return {
        kind: 'sorted',
        noteId: primary.noteId,
        keepVisible: false,
        primary,
        rootId: root.dataset.noteId,
        previousRootId,
        nextRootId,
        neighbour: { kind: 'top', noteId: neighbourId, top: neighbourTop, keepVisible: false },
    };
}

function sortedRootMoved(reference) {
    const root = findNoteElement(reference.rootId);
    if (root === null) {
        return true;
    }
    if (adjacentRootId(root, 'previous') !== reference.previousRootId) {
        return true;
    }
    return adjacentRootId(root, 'next') !== reference.nextRootId;
}

// --- Holding --------------------------------------------------------------

function validateReference(reference) {
    if (reference === null || typeof reference !== 'object' || typeof reference.noteId !== 'string'
        || typeof reference.keepVisible !== 'boolean') {
        throw new Error('A viewport hold needs { kind, noteId, keepVisible, ... }');
    }
    if (reference.kind === 'top') {
        if (typeof reference.top !== 'number') {
            throw new Error('A top hold needs a numeric top');
        }
        return;
    }
    if (reference.kind === 'source') {
        if (!Array.isArray(reference.needles) || reference.needles.length === 0
            || !reference.needles.every((needle) => typeof needle.text === 'string' && needle.text.length > 0
                && Number.isInteger(needle.shift))) {
            throw new Error('A source hold needs needles');
        }
        if (!Number.isInteger(reference.occurrence) || reference.occurrence < 0) {
            throw new Error('A source hold needs an occurrence index');
        }
        for (const field of ['screenY', 'noteTop']) {
            if (typeof reference[field] !== 'number') {
                throw new Error(`A source hold needs a numeric ${field}`);
            }
        }
        return;
    }
    if (reference.kind === 'sorted') {
        if (typeof reference.rootId !== 'string') {
            throw new Error('A sorted hold needs the edited root id');
        }
        for (const field of ['previousRootId', 'nextRootId']) {
            if (reference[field] !== null && typeof reference[field] !== 'string') {
                throw new Error(`A sorted hold needs ${field} as a string or null`);
            }
        }
        validateReference(reference.primary);
        validateReference(reference.neighbour);
        if (reference.primary.kind === 'sorted' || reference.neighbour.kind !== 'top') {
            throw new Error('A sorted hold needs a primary anchor and a neighbour top');
        }
        return;
    }
    if (reference.kind === 'text') {
        for (const field of ['screenY', 'textOffset', 'textLength', 'noteTop']) {
            if (typeof reference[field] !== 'number') {
                throw new Error(`A text hold needs a numeric ${field}`);
            }
        }
        if (typeof reference.before !== 'string' || typeof reference.after !== 'string') {
            throw new Error('A text hold needs its surrounding text');
        }
        if (reference.affinity !== 'forward' && reference.affinity !== 'backward') {
            throw new Error('A text hold needs its affinity');
        }
        if (typeof reference.atRunEnd !== 'boolean') {
            throw new Error('A text hold needs atRunEnd');
        }
        if (typeof reference.runText !== 'string' || !Number.isInteger(reference.runOffset)) {
            throw new Error('A text hold needs the run of text it is in');
        }
        if (Object.prototype.hasOwnProperty.call(reference, 'editText') && typeof reference.editText !== 'string') {
            throw new Error('A text hold editText must be a string');
        }
        return;
    }
    if (reference.kind === 'reference') {
        if (typeof reference.referenceId !== 'string' || reference.referenceId.length === 0) {
            throw new Error('A reference hold needs the referenced note id');
        }
        referenceToken(reference.referenceId, reference.mode);
        if (!Number.isInteger(reference.occurrence) || reference.occurrence < 0) {
            throw new Error('A reference hold needs an occurrence index');
        }
        if (typeof reference.onReference !== 'boolean' || typeof reference.gapText !== 'string') {
            throw new Error('A reference hold needs onReference and gapText');
        }
        if (reference.affinity !== 'forward' && reference.affinity !== 'backward') {
            throw new Error('A reference hold needs its affinity');
        }
        for (const field of ['screenY', 'noteTop']) {
            if (typeof reference[field] !== 'number') {
                throw new Error(`A reference hold needs a numeric ${field}`);
            }
        }
        if (reference.fallback === null || typeof reference.fallback !== 'object'
            || !['text', 'top'].includes(reference.fallback.kind)) {
            throw new Error('A reference hold needs a text or top fallback');
        }
        validateReference(reference.fallback);
        return;
    }
    throw new Error(`Unknown viewport hold kind: ${reference.kind}`);
}

// The scroll delta that puts the reference back in place; null when its note is gone.
function locateReference(reference) {
    if (reference.kind === 'sorted') {
        if (sortedRootMoved(reference)) {
            return locateReference(reference.neighbour);
        }
        return locateReference(reference.primary);
    }
    const element = findNoteElement(reference.noteId);
    if (!element) {
        return null;
    }
    if (reference.kind === 'reference') {
        if (!isShownCollapsed(element)) {
            const content = noteContent(element);
            const position = findReferencePosition(content.textContent, reference);
            if (position !== null) {
                const y = textPositionToY(content, position, reference.affinity);
                if (y !== null) {
                    return { delta: y - reference.screenY };
                }
            }
        }
        return locateReference(reference.fallback);
    }
    if (reference.kind === 'source' && !isShownCollapsed(element)) {
        const content = noteContent(element);
        const position = findSourcePosition(content.textContent, reference);
        if (position !== null) {
            const y = textPositionToY(content, position, 'forward');
            if (y !== null) {
                return { delta: y - reference.screenY };
            }
        }
    }
    // Only a real text match places the view: a proportional guess (the text
    // did not survive rendering, e.g. Mermaid source or Markdown syntax) can
    // land anywhere in a formatted note, so the note's top is held instead.
    if (reference.kind === 'text' && Object.prototype.hasOwnProperty.call(reference, 'editText')
        && !isShownCollapsed(element)) {
        const content = noteContent(element);
        const formula = formulaAtEditedOffset(content, reference.editText, reference.textOffset);
        if (formula !== null) {
            return { delta: formula.getBoundingClientRect().top - reference.screenY };
        }
    }
    if (reference.kind === 'text') {
        const content = noteContent(element);
        const found = findTextPosition(content.textContent, reference);
        if (found.exact) {
            const y = textPositionToY(content, found.position, found.affinity);
            if (y !== null && !isShownCollapsed(element)) {
                return { delta: y - reference.screenY };
            }
        }
    }
    const rect = element.getBoundingClientRect();
    // A note that collapsed again: its first line of text stays where the
    // note's first line was while editing, keeping the row in view.
    if (isShownCollapsed(element) && Object.prototype.hasOwnProperty.call(reference, 'contentTop')) {
        if (typeof reference.contentTop !== 'number') {
            throw new Error('A hold contentTop must be a number');
        }
        let delta = firstLineTop(noteContent(element)) - reference.contentTop;
        if (reference.keepVisible) {
            const inset = getViewportTopInset();
            if (rect.top - delta + rect.height < inset + MIN_VISIBLE_PX) {
                delta = rect.top - inset;
            }
        }
        return { delta };
    }
    // Unmatched text has no place, and a hold without a first line to keep
    // holds the note's top, keeping it in view.
    let target = reference.kind === 'top' ? reference.top : reference.noteTop;
    if (reference.keepVisible) {
        const inset = getViewportTopInset();
        if (target + rect.height < inset + MIN_VISIBLE_PX) {
            target = inset;
        }
    }
    return { delta: rect.top - target };
}

function endHold() {
    if (moduleState.session === null) {
        return;
    }
    const { end } = moduleState.session;
    moduleState.session = null;
    end();
}

export function holdViewportRoot(reference) {
    if (reference === null) {
        return;
    }
    validateReference(reference);
    endHold();

    const root = document.documentElement;
    const previousOverflowAnchor = root.style.overflowAnchor;
    root.style.overflowAnchor = 'none';
    let expectedScrollY = window.scrollY;
    let quietTimer = null;

    // Runs before paint (ResizeObserver), so the corrected view is the first one shown.
    const correct = () => {
        const located = locateReference(reference);
        if (located === null) {
            endHold();
            return;
        }
        if (Math.abs(located.delta) >= 1) {
            window.scrollBy(0, located.delta);
        }
        expectedScrollY = window.scrollY;
    };
    const scheduleQuietEnd = () => {
        window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(endHold, QUIET_MS);
    };
    const observer = new ResizeObserver(() => {
        correct();
        scheduleQuietEnd();
    });
    const onUserInput = () => endHold();
    // A scroll we did not cause (scrollbar drag, keyboard) is the user's.
    const onScroll = () => {
        if (Math.abs(window.scrollY - expectedScrollY) >= 1) {
            endHold();
        }
    };
    const maxTimer = window.setTimeout(endHold, MAX_HOLD_MS);

    for (const type of USER_INPUT_EVENTS) {
        window.addEventListener(type, onUserInput, { capture: true, passive: true });
    }
    window.addEventListener(DELIBERATE_SCROLL_EVENT, onUserInput);
    window.addEventListener('scroll', onScroll, { passive: true });
    observer.observe(notesContainer());

    moduleState.session = {
        end: () => {
            observer.disconnect();
            for (const type of USER_INPUT_EVENTS) {
                window.removeEventListener(type, onUserInput, { capture: true });
            }
            window.removeEventListener(DELIBERATE_SCROLL_EVENT, onUserInput);
            window.removeEventListener('scroll', onScroll);
            window.clearTimeout(quietTimer);
            window.clearTimeout(maxTimer);
            root.style.overflowAnchor = previousOverflowAnchor;
        },
    };
    correct();
    scheduleQuietEnd();
}
