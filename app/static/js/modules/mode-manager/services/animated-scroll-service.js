import { clampNumber, getScrollMaxY } from './viewport-reference.js';
import { ApplicationState } from '../../application-state.js';
const SCROLL_PIXELS_PER_MS = 60;
const MIN_SCROLL_DURATION_MS = 70;
const MAX_SCROLL_DURATION_MS = 160;
// Cubic ease-out.
const EASE_OUT_EXPONENT = 3;
// Announced before the app scrolls on purpose (e.g. up to a new note), so a
// viewport hold keeping the user's place stops instead of scrolling back.
export const DELIBERATE_SCROLL_EVENT = 'metalist:deliberate-scroll';

const moduleState = ApplicationState.createFields('animated-scroll-service', {
    activeAnimationFrame: null,
});

function prefersReducedMotion() {
    if (!window.matchMedia) {
        return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function cancelActiveScroll() {
    if (moduleState.activeAnimationFrame === null) {
        return;
    }
    window.cancelAnimationFrame(moduleState.activeAnimationFrame);
    moduleState.activeAnimationFrame = null;
}

export function scrollWindowToYFastAnimated(targetScrollY) {
    if (typeof targetScrollY !== 'number' || Number.isNaN(targetScrollY)) {
        throw new Error('scrollWindowToYFastAnimated requires a targetScrollY number');
    }

    window.dispatchEvent(new Event(DELIBERATE_SCROLL_EVENT));
    const clampedTarget = Math.round(clampNumber(targetScrollY, 0, getScrollMaxY()));
    const startY = Math.max(0, Math.round(window.scrollY));
    const distance = Math.abs(clampedTarget - startY);

    if (distance === 0) {
        cancelActiveScroll();
        return { scrolled: false, animated: false, reason: 'already_there' };
    }

    cancelActiveScroll();

    if (prefersReducedMotion()) {
        window.scrollTo(0, clampedTarget);
        return { scrolled: true, animated: false, reason: 'reduced_motion' };
    }

    const durationMs = Math.max(
        MIN_SCROLL_DURATION_MS,
        Math.min(MAX_SCROLL_DURATION_MS, Math.round(distance / SCROLL_PIXELS_PER_MS))
    );
    const startTime = performance.now();

    const tick = (now) => {
        const elapsed = now - startTime;
        const t = Math.max(0, Math.min(1, elapsed / durationMs));
        const eased = 1 - Math.pow(1 - t, EASE_OUT_EXPONENT);
        const nextY = Math.round(startY + (clampedTarget - startY) * eased);
        window.scrollTo(0, nextY);

        if (t < 1) {
            moduleState.activeAnimationFrame = window.requestAnimationFrame(tick);
            return;
        }
        moduleState.activeAnimationFrame = null;
    };

    moduleState.activeAnimationFrame = window.requestAnimationFrame(tick);
    return { scrolled: true, animated: true, reason: 'animated' };
}
