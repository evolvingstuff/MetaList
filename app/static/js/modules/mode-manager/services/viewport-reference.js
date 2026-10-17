// Where the usable viewport is and how far the page can scroll, for every service
// that keeps or restores the user's point of attention (docs/ui/interaction-principles.md:
// "the usable screen starts below the search controls").

import { half } from '../../half.js';

// Space kept between the sticky search controls and the first visible note.
export const VIEWPORT_TOP_BUFFER_PX = 8;

export function clampNumber(value, min, max) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new Error('clampNumber requires a number');
    }
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

// Top of the usable viewport: just below the sticky search controls.
export function getViewportTopInset() {
    const controls = document.querySelector('.controls');
    if (!controls) {
        return 0;
    }
    const rect = controls.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0 || rect.bottom <= 0) {
        return 0;
    }
    return Math.max(0, Math.round(rect.bottom + VIEWPORT_TOP_BUFFER_PX));
}

// The line a note is anchored to: the top of the usable viewport, or its middle.
export function getViewportReferenceY(anchorBias) {
    const topInset = getViewportTopInset();
    if (anchorBias === 'center') {
        return topInset + half(window.innerHeight - topInset);
    }
    if (anchorBias === 'top') {
        return topInset;
    }
    throw new Error(`Unsupported anchorBias: ${anchorBias}`);
}

export function getScrollMaxY() {
    const doc = document.documentElement;
    return Math.max(0, Math.round(doc.scrollHeight - window.innerHeight));
}

// How far a rect is from a horizontal line: zero when the line crosses it.
export function distanceToLine(rect, lineY) {
    if (lineY >= rect.top && lineY <= rect.bottom) {
        return 0;
    }
    return Math.min(Math.abs(rect.top - lineY), Math.abs(rect.bottom - lineY));
}
