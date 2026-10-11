// The up and down arrows go to the top and bottom of the list. A click first
// leaves edit mode as Escape does (saved, place kept). With roots unloaded
// beyond the loaded band, pixel 0 (or the page bottom) is only the band's
// edge, so the arrow rebuilds the view from the first (or last) root instead
// of scrolling. An arrow is dimmed when the list is already at that end.

import { DELIBERATE_SCROLL_EVENT } from './animated-scroll-service.js';

const SCROLL_PIXELS_PER_MS = 20;
const MIN_SCROLL_DURATION_MS = 120;
const MAX_SCROLL_DURATION_MS = 240;

// Each scroll the arrow makes is deliberate: a viewport hold keeping the place
// the user left (after leaving edit mode, or a refresh that lands meanwhile)
// stands down instead of scrolling back.
function scrollDeliberatelyTo(y) {
    window.dispatchEvent(new Event(DELIBERATE_SCROLL_EVENT));
    window.scrollTo(0, y);
}

function maxScrollY() {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
}

const LIST_EDGES = Object.freeze({
    top: Object.freeze({
        buttonId: 'scroll-to-top-button',
        isPageAtEdge: () => window.scrollY <= 0,
        targetY: () => 0,
    }),
    bottom: Object.freeze({
        buttonId: 'scroll-to-bottom-button',
        // Within a pixel: scroll positions can be fractional.
        isPageAtEdge: () => window.scrollY >= maxScrollY() - 1,
        targetY: () => maxScrollY(),
    }),
});

function initializeListEdgeButton(edge, { hasRootsBeyondWindow, jumpBeyondWindow, leaveEditMode }) {
    const button = document.getElementById(edge.buttonId);
    if (!button) {
        throw new Error(`${edge.buttonId} not found`);
    }
    if (typeof hasRootsBeyondWindow !== 'function' || typeof jumpBeyondWindow !== 'function' || typeof leaveEditMode !== 'function') {
        throw new Error(`${edge.buttonId} requires band callbacks and leaveEditMode`);
    }

    let activeAnimationFrame = null;
    let pendingFrame = null;
    let lastDisabled = null;

    const syncVisibility = () => {
        const shouldDisable = edge.isPageAtEdge() && !hasRootsBeyondWindow();
        if (shouldDisable === lastDisabled) {
            return;
        }
        lastDisabled = shouldDisable;
        button.disabled = shouldDisable;
    };

    const scheduleSyncVisibility = () => {
        if (pendingFrame !== null) {
            return;
        }
        pendingFrame = window.requestAnimationFrame(() => {
            pendingFrame = null;
            syncVisibility();
        });
    };

    window.addEventListener('scroll', scheduleSyncVisibility, { passive: true });
    window.addEventListener('resize', scheduleSyncVisibility, { passive: true });
    // Notes added, expanded or loaded change where the bottom is without scrolling.
    new ResizeObserver(scheduleSyncVisibility).observe(document.body);

    const scrollToEdge = () => {
        const startY = window.scrollY;
        const targetY = edge.targetY();
        if (Math.abs(targetY - startY) < 1) {
            syncVisibility();
            return;
        }
        if (activeAnimationFrame !== null) {
            window.cancelAnimationFrame(activeAnimationFrame);
            activeAnimationFrame = null;
        }
        const prefersReducedMotion = window.matchMedia
            ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
            : false;
        if (prefersReducedMotion) {
            scrollDeliberatelyTo(targetY);
            syncVisibility();
            return;
        }

        const distance = Math.abs(Math.round(targetY - startY));
        const durationMs = Math.max(
            MIN_SCROLL_DURATION_MS,
            Math.min(MAX_SCROLL_DURATION_MS, Math.round(distance / SCROLL_PIXELS_PER_MS))
        );
        const startTime = performance.now();
        const tick = (now) => {
            const elapsed = now - startTime;
            const t = Math.max(0, Math.min(1, elapsed / durationMs));
            const eased = 1 - Math.pow(1 - t, 3);
            scrollDeliberatelyTo(Math.round(startY + (targetY - startY) * eased));
            if (t < 1) {
                activeAnimationFrame = window.requestAnimationFrame(tick);
            } else {
                activeAnimationFrame = null;
                syncVisibility();
            }
        };
        activeAnimationFrame = window.requestAnimationFrame(tick);
    };

    const goToEdge = async () => {
        await leaveEditMode();
        // Leaving edit mode holds the user's place; going to the end is a
        // deliberate scroll, so that hold stands down.
        window.dispatchEvent(new Event(DELIBERATE_SCROLL_EVENT));
        if (hasRootsBeyondWindow()) {
            await jumpBeyondWindow();
            syncVisibility();
            return;
        }
        scrollToEdge();
    };

    button.addEventListener('click', () => {
        button.blur();
        void goToEdge();
    });

    syncVisibility();
}

export function initializeScrollToTopButton({ hasRootsAboveWindow, jumpToListTop, leaveEditMode }) {
    initializeListEdgeButton(LIST_EDGES.top, {
        hasRootsBeyondWindow: hasRootsAboveWindow,
        jumpBeyondWindow: jumpToListTop,
        leaveEditMode,
    });
}

export function initializeScrollToBottomButton({ hasRootsBelowWindow, jumpToListBottom, leaveEditMode }) {
    initializeListEdgeButton(LIST_EDGES.bottom, {
        hasRootsBeyondWindow: hasRootsBelowWindow,
        jumpBeyondWindow: jumpToListBottom,
        leaveEditMode,
    });
}
