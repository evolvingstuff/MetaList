import { ApplicationState } from '../../application-state.js';
import { ModeContextInstance as ModeContext } from '../mode-context.js';

// The card offering a guessed format for a paste: "Apply as Markdown" (or a
// few languages for code) and "Skip" (docs/ui/content-formatting.md, "Paste
// format guesses"). It sits just below where the paste ended, or above it near
// the window's bottom, and never moves the page. Its buttons never take the
// keyboard: typing goes on in the note, and any key, a click elsewhere,
// scrolling by the user (wheel, touch, scrollbar, keys), Escape (which closes
// only the card) or leaving edit mode closes it. When MetaList itself scrolls
// (a new note settling into view), the card moves with the end of the paste.

const CARD_GAP_PX = 6;
const VIEWPORT_MARGIN_PX = 8;
const EDIT_CHECK_INTERVAL_MS = 300;
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

const moduleState = ApplicationState.createFields('paste-format-offer-service', {
    card: null,
    noteId: null,
    contentElement: null,
    editCheckTimer: null,
});

export function isPasteFormatOfferOpen() {
    return moduleState.card !== null;
}

export function closePasteFormatOffer() {
    if (moduleState.card === null) {
        return;
    }
    moduleState.card.remove();
    moduleState.card = null;
    moduleState.noteId = null;
    moduleState.contentElement = null;
    clearInterval(moduleState.editCheckTimer);
    moduleState.editCheckTimer = null;
    window.removeEventListener('keydown', handleKeyDown, { capture: true });
    document.removeEventListener('mousedown', handleMouseDown, { capture: true });
    document.removeEventListener('wheel', closePasteFormatOffer, { capture: true });
    document.removeEventListener('touchmove', closePasteFormatOffer, { capture: true });
    document.removeEventListener('scroll', followPaste, { capture: true });
    window.removeEventListener('resize', closePasteFormatOffer);
}

// MetaList scrolled (the user's own scrolling closes the card first): keep the card at the paste.
function followPaste() {
    if (moduleState.card === null) {
        return;
    }
    placeCard(moduleState.card, caretRect(moduleState.contentElement));
}

// Escape closes only the card; any other key (typing, ⌘Z) closes it and goes on as usual.
function handleKeyDown(event) {
    if (MODIFIER_KEYS.has(event.key)) {
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
    }
    closePasteFormatOffer();
}

function handleMouseDown(event) {
    if (moduleState.card !== null && event.target instanceof Node && moduleState.card.contains(event.target)) {
        return;
    }
    closePasteFormatOffer();
}

function checkStillEditing() {
    if (!ModeContext.isEditing || ModeContext.currentNoteId !== moduleState.noteId) {
        closePasteFormatOffer();
    }
}

// Where the paste ended: the caret, or the edited note's content when the caret has no box.
function caretRect(contentElement) {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0).cloneRange();
        range.collapse(false);
        const rects = range.getClientRects();
        if (rects.length > 0) {
            return rects[rects.length - 1];
        }
        const box = range.getBoundingClientRect();
        if (box.width > 0 || box.height > 0) {
            return box;
        }
    }
    const content = contentElement.getBoundingClientRect();
    return { left: content.left, right: content.left, top: content.bottom, bottom: content.bottom };
}

function buildButton(label, className, onActivate) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.tabIndex = -1;
    button.textContent = label;
    // Pressing a button keeps the caret in the note.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
    });
    return button;
}

// Where the card goes: just below where the paste ended, or above it when it
// would run past the window's bottom; kept inside the window either way.
export function placePasteFormatOffer({ anchor, width, height, viewportWidth, viewportHeight }) {
    let left = Math.min(anchor.left, viewportWidth - width - VIEWPORT_MARGIN_PX);
    left = Math.max(VIEWPORT_MARGIN_PX, left);
    let top = anchor.bottom + CARD_GAP_PX;
    if (top + height > viewportHeight - VIEWPORT_MARGIN_PX) {
        top = Math.max(VIEWPORT_MARGIN_PX, anchor.top - height - CARD_GAP_PX);
    }
    return { left: Math.round(left), top: Math.round(top) };
}

function placeCard(card, anchor) {
    const { left, top } = placePasteFormatOffer({
        anchor, width: card.offsetWidth, height: card.offsetHeight,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    });
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
}

// Offer the guessed formats for the paste just made into noteId.
// options: [{ tag, label }]; onApply(tag) applies the chosen one.
export function offerPasteFormat({ noteId, contentElement, kind, options, onApply }) {
    if (typeof noteId !== 'string' || noteId === '' || !(contentElement instanceof HTMLElement)) {
        throw new Error('offerPasteFormat requires noteId and contentElement');
    }
    if (!['csv', 'markdown', 'code'].includes(kind) || !Array.isArray(options) || options.length === 0) {
        throw new Error('offerPasteFormat requires a kind and options');
    }
    if (typeof onApply !== 'function') {
        throw new Error('offerPasteFormat requires onApply');
    }
    closePasteFormatOffer();
    const card = document.createElement('div');
    card.className = 'paste-format-offer';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Format the pasted text');
    if (options.length > 1) {
        const prompt = document.createElement('span');
        prompt.className = 'paste-format-offer-prompt';
        prompt.textContent = 'Looks like code:';
        card.appendChild(prompt);
    }
    for (const option of options) {
        if (!option || typeof option.tag !== 'string' || typeof option.label !== 'string') {
            throw new Error('offerPasteFormat options require tag and label');
        }
        const label = options.length > 1 ? option.label : `Apply as ${option.label}`;
        card.appendChild(buildButton(label, 'paste-format-offer-apply', () => {
            closePasteFormatOffer();
            onApply(option.tag);
        }));
    }
    card.appendChild(buildButton('Skip', 'paste-format-offer-skip', closePasteFormatOffer));
    card.style.left = '0px';
    card.style.top = '0px';
    document.body.appendChild(card);
    placeCard(card, caretRect(contentElement));

    moduleState.card = card;
    moduleState.noteId = noteId;
    moduleState.contentElement = contentElement;
    moduleState.editCheckTimer = setInterval(checkStillEditing, EDIT_CHECK_INTERVAL_MS);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    document.addEventListener('mousedown', handleMouseDown, { capture: true });
    document.addEventListener('wheel', closePasteFormatOffer, { capture: true, passive: true });
    document.addEventListener('touchmove', closePasteFormatOffer, { capture: true, passive: true });
    document.addEventListener('scroll', followPaste, { capture: true });
    window.addEventListener('resize', closePasteFormatOffer);
}
