const DEFAULT_BELT_SIZE = 4;
const MAX_BELT_SIZE = 10;
// Divisor for the midpoint between two edges.
const HALF = 2;

const ROOT_PARENT_SENTINELS = new Set(['', 'null', 'undefined', 'none']);

function arraysMatch(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
        throw new Error('arraysMatch requires arrays');
    }
    if (left.length !== right.length) {
        return false;
    }
    let index = 0;
    while (index < left.length) {
        if (left[index] !== right[index]) {
            return false;
        }
        index += 1;
    }
    return true;
}

export function areScrollAnchorsEqual(left, right) {
    if (left === right) {
        return true;
    }
    if (left === null || right === null) {
        return false;
    }
    if (typeof left !== 'object' || typeof right !== 'object') {
        throw new Error('scroll anchors must be objects or null');
    }
    if (!left.anchorSortKey || typeof left.anchorSortKey !== 'object') {
        throw new Error('left scroll anchor missing anchorSortKey');
    }
    if (!right.anchorSortKey || typeof right.anchorSortKey !== 'object') {
        throw new Error('right scroll anchor missing anchorSortKey');
    }
    return (
        left.anchorId === right.anchorId
        && left.anchorBias === right.anchorBias
        && left.intraOffset === right.intraOffset
        && left.anchorSortKey.domIndex === right.anchorSortKey.domIndex
        && arraysMatch(left.beltPrev, right.beltPrev)
        && arraysMatch(left.beltNext, right.beltNext)
    );
}

function clampNumber(value, min, max) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new Error('clampNumber requires a number');
    }
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

function getViewportReferenceY(anchorBias) {
    const topInset = getViewportTopInset();
    if (anchorBias === 'center') {
        return topInset + (window.innerHeight - topInset) / HALF;
    }
    if (anchorBias === 'top') {
        return topInset;
    }
    throw new Error(`Unsupported anchorBias: ${anchorBias}`);
}

function getViewportTopInset() {
    const controls = document.querySelector('.controls');
    if (!controls) {
        return 0;
    }
    const rect = controls.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) {
        return 0;
    }
    if (rect.bottom <= 0) {
        return 0;
    }
    // Add a small buffer so restored anchors don't end up tucked under the sticky search bar.
    const bufferPx = 8;
    return Math.max(0, Math.round(rect.bottom + bufferPx));
}

function requireNotesContainer() {
    const container = document.getElementById('notes-container');
    if (!container) {
        throw new Error('notes-container not found');
    }
    return container;
}

function isRootNoteElement(element) {
    const rawParent = element?.getAttribute('data-parent-id');
    const normalized = (typeof rawParent === 'string' ? rawParent : '').trim().toLowerCase();
    return ROOT_PARENT_SENTINELS.has(normalized);
}

function getNoteId(element) {
    return element.dataset.noteId;
}

function collectRootNotesInDomOrder(container) {
    const noteElements = [];
    const noteIds = [];
    const allNotes = Array.from(container.querySelectorAll('.note[data-note-id]'));
    for (const element of allNotes) {
        if (!isRootNoteElement(element)) continue;
        const noteId = getNoteId(element);
        if (!noteId) continue;
        noteElements.push(element);
        noteIds.push(noteId);
    }
    return { noteElements, noteIds };
}

function getNoteContentElement(noteElement) {
    if (!noteElement || typeof noteElement.querySelector !== 'function') {
        throw new Error('noteElement must be a DOM element');
    }
    return noteElement;
}

function distanceToLine(rect, lineY) {
    if (lineY >= rect.top && lineY <= rect.bottom) {
        return 0;
    }
    return Math.min(Math.abs(rect.top - lineY), Math.abs(rect.bottom - lineY));
}

function findAnchorIndex(noteElements, anchorBias) {
    const lineY = getViewportReferenceY(anchorBias);
    let bestIndex = -1;
    let bestDistance = Infinity;
    let bestCenterDistance = Infinity;

    for (let i = 0; i < noteElements.length; i += 1) {
        const noteElement = noteElements[i];
        if (!noteElement) continue;
        const blockElement = getNoteContentElement(noteElement);
        const rect = blockElement.getBoundingClientRect();
        if (rect.height <= 0) continue;

        const dist = distanceToLine(rect, lineY);
        const centerDist = Math.abs((rect.top + rect.bottom) / HALF - lineY);
        if (dist < bestDistance || (dist === bestDistance && centerDist < bestCenterDistance)) {
            bestIndex = i;
            bestDistance = dist;
            bestCenterDistance = centerDist;
        }
    }

    return bestIndex;
}

export function computeScrollAnchor(options) {
    if (options === null || typeof options !== 'object') {
        throw new Error('computeScrollAnchor requires options object');
    }

    let requestedBias = options.anchorBias;
    if (typeof requestedBias === 'undefined') {
        requestedBias = 'center';
    }
    const beltSize = typeof options.beltSize === 'number' ? options.beltSize : DEFAULT_BELT_SIZE;
    if (!Number.isInteger(beltSize) || beltSize < 0 || beltSize > MAX_BELT_SIZE) {
        throw new Error(`beltSize must be an integer between 0 and ${MAX_BELT_SIZE}`);
    }

    let container = options.container;
    if (!container) {
        container = requireNotesContainer();
    }
    const { noteElements, noteIds } = collectRootNotesInDomOrder(container);
    if (noteIds.length === 0) {
        return null;
    }

    let anchorBias = requestedBias;
    let anchorIndex = -1;
    if (requestedBias === 'auto') {
        const topRef = getViewportReferenceY('top');
        let bestPinnedIndex = -1;
        let bestPinnedDistance = Infinity;
        for (let i = 0; i < noteElements.length; i += 1) {
            const element = noteElements[i];
            if (!element) continue;
            const rect = element.getBoundingClientRect();
            if (rect.bottom <= topRef) continue;
            const dist = Math.abs(rect.top - topRef);
            if (dist <= 80 && dist < bestPinnedDistance) {
                bestPinnedIndex = i;
                bestPinnedDistance = dist;
            }
        }
        if (bestPinnedIndex >= 0) {
            anchorBias = 'top';
            anchorIndex = bestPinnedIndex;
        } else {
            anchorBias = 'center';
            anchorIndex = findAnchorIndex(noteElements, anchorBias);
        }
    } else {
        if (anchorBias !== 'center' && anchorBias !== 'top') {
            throw new Error(`Unsupported anchorBias: ${anchorBias}`);
        }
        anchorIndex = findAnchorIndex(noteElements, anchorBias);
    }

    if (anchorIndex < 0 || anchorIndex >= noteIds.length) {
        return null;
    }

    const anchorElement = noteElements[anchorIndex];
    const anchorId = noteIds[anchorIndex];
    if (!anchorElement || !anchorId) {
        return null;
    }

    const blockElement = getNoteContentElement(anchorElement);
    const rect = blockElement.getBoundingClientRect();
    const referenceY = getViewportReferenceY(anchorBias);
    const rawOffset = referenceY - rect.top;
    const intraOffset = Math.round(clampNumber(rawOffset, 0, Math.max(0, rect.height)));

    const prevSlice = noteIds.slice(Math.max(0, anchorIndex - beltSize), anchorIndex);
    const nextSlice = noteIds.slice(anchorIndex + 1, anchorIndex + 1 + beltSize);

    return {
        anchorId,
        anchorBias,
        intraOffset,
        beltPrev: prevSlice.reverse(),
        beltNext: nextSlice,
        anchorSortKey: { domIndex: anchorIndex },
    };
}
