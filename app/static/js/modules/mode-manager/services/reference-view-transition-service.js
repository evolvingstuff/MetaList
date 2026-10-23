import { ApplicationState } from '../../application-state.js';

// Moving between a search and its reference views (docs/ui/references.md): the
// column of notes slides as one piece, the old one out and the new one in, while
// the chip in the search bar grows in or out. Going deeper slides left, coming back
// slides right. Where the new view lands is decided by the navigation itself; the
// slide is a transform only and never moves the scroll position.
//
// The navigation renders the new view behind a still copy of the old column, so the
// user sees the old notes until the slide starts. While a transition is pending the
// chip and the search input keep showing the old view.

const SLIDE_DURATION_MS = 250;
const SLIDE_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
// With the system's Reduce Motion on, the views cross-fade quickly instead.
const REDUCED_MOTION_FADE_MS = 120;
// The chip's grow (CSS, main.css) finishes inside the slide; the class that enables
// its transition stays on until both are done.
const CHIP_ANIMATING_CLASS = 'is-chip-animating';
const GHOST_CLASS = 'reference-slide-ghost';
const SLIDING_ROOT_CLASS = 'reference-sliding';

const DIRECTIONS = new Set(['forward', 'back']);
// Which way the old column leaves: left when going deeper, right when coming back.
const OUTGOING_SIGN_BY_DIRECTION = Object.freeze({ forward: -1, back: 1 });

const moduleState = ApplicationState.createFields('reference-view-transition-service', {
    pending: null,
});

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isMotionEnabled() {
    return document.body.classList.contains('pref-animated-transitions');
}

function requireNotesContainer() {
    const notesContainer = document.getElementById('notes-container');
    if (!(notesContainer instanceof HTMLElement)) {
        throw new Error('notes-container element missing');
    }
    return notesContainer;
}

function requireSearchInputRow() {
    const row = document.querySelector('.controls .search-input-row');
    if (!(row instanceof HTMLElement)) {
        throw new Error('search input row missing');
    }
    return row;
}

// A still copy of the column, fixed where it is on screen, with nothing in it that
// code looking for the live notes could find.
function buildColumnGhost(notesContainer) {
    const rect = notesContainer.getBoundingClientRect();
    const ghost = notesContainer.cloneNode(true);
    ghost.removeAttribute('id');
    for (const element of ghost.querySelectorAll('[id]')) {
        element.removeAttribute('id');
    }
    for (const element of ghost.querySelectorAll('[data-note-id]')) {
        element.removeAttribute('data-note-id');
    }
    for (const element of ghost.querySelectorAll('[contenteditable]')) {
        element.removeAttribute('contenteditable');
    }
    ghost.classList.add(GHOST_CLASS);
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.style.top = `${rect.top}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.minHeight = `${Math.max(0, window.innerHeight - rect.top)}px`;
    notesContainer.after(ghost);
    return ghost;
}

export function isReferenceViewTransitionPending() {
    return moduleState.pending !== null;
}

/**
 * Freeze what the user sees before a reference navigation changes the view:
 * the column stays as it is (a still copy over the live one) and so do the chip
 * and the search input, until playReferenceViewTransition shows the new view.
 */
export function beginReferenceViewTransition(direction) {
    if (!DIRECTIONS.has(direction)) {
        throw new Error(`Unknown reference view transition direction: ${direction}`);
    }
    if (moduleState.pending !== null) {
        throw new Error('A reference view transition is already pending');
    }
    const notesContainer = requireNotesContainer();
    const isAnimated = isMotionEnabled();
    let ghost = null;
    if (isAnimated) {
        ghost = buildColumnGhost(notesContainer);
        notesContainer.style.visibility = 'hidden';
        document.documentElement.classList.add(SLIDING_ROOT_CLASS);
    }
    moduleState.pending = { direction, ghost, isAnimated };
    document.documentElement.dataset.referenceTransition = 'pending';
}

function releasePending() {
    const pending = moduleState.pending;
    if (pending === null) {
        throw new Error('No reference view transition is pending');
    }
    moduleState.pending = null;
    requireNotesContainer().style.visibility = '';
    return pending;
}

function finishTransition() {
    document.documentElement.classList.remove(SLIDING_ROOT_CLASS);
    delete document.documentElement.dataset.referenceTransition;
}

/** Drop a pending transition without playing it: the navigation did not happen. */
export function cancelReferenceViewTransition() {
    const pending = releasePending();
    if (pending.ghost !== null) {
        pending.ghost.remove();
    }
    finishTransition();
}

function slideKeyframes(fromX, toX) {
    return [
        { transform: `translateX(${fromX}px)` },
        { transform: `translateX(${toX}px)` },
    ];
}

function startColumnAnimations(pending, notesContainer) {
    if (prefersReducedMotion()) {
        const fade = { duration: REDUCED_MOTION_FADE_MS, easing: 'linear', fill: 'both' };
        return [
            pending.ghost.animate([{ opacity: 1 }, { opacity: 0 }], fade),
            notesContainer.animate([{ opacity: 0 }, { opacity: 1 }], fade),
        ];
    }
    // One distance for both, the window's width, so the two move as one piece and
    // each is fully out of sight at its far end.
    const distance = window.innerWidth;
    const outgoingX = OUTGOING_SIGN_BY_DIRECTION[pending.direction] * distance;
    const slide = { duration: SLIDE_DURATION_MS, easing: SLIDE_EASING, fill: 'both' };
    return [
        pending.ghost.animate(slideKeyframes(0, outgoingX), slide),
        notesContainer.animate(slideKeyframes(-outgoingX, 0), slide),
    ];
}

/**
 * Show the view the navigation rendered: the chip and input change (showChange
 * applies them, with their CSS transition enabled) and the columns slide or fade.
 * Resolves once everything has settled.
 */
export async function playReferenceViewTransition(showChange) {
    if (typeof showChange !== 'function') {
        throw new Error('playReferenceViewTransition requires showChange');
    }
    const pending = releasePending();
    if (!pending.isAnimated) {
        showChange();
        finishTransition();
        return;
    }
    const notesContainer = requireNotesContainer();
    const row = requireSearchInputRow();
    document.documentElement.dataset.referenceTransition = 'playing';
    row.classList.add(CHIP_ANIMATING_CLASS);
    showChange();
    const animations = startColumnAnimations(pending, notesContainer);
    await Promise.all(animations.map((animation) => animation.finished));
    for (const animation of animations) {
        animation.cancel();
    }
    pending.ghost.remove();
    row.classList.remove(CHIP_ANIMATING_CLASS);
    finishTransition();
}
