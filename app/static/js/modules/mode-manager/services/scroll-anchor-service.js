import { NOT_FOUND } from '../../not-found.js';
import { clampNumber, distanceToLine, getViewportReferenceY, getViewportTopInset } from './viewport-reference.js';
import { half } from '../../half.js';

const DEFAULT_BELT_SIZE = 4;
const MAX_BELT_SIZE = 10;
// A root note whose top is this close to the viewport top is pinned there as the anchor.
const PINNED_TOP_ANCHOR_MAX_DISTANCE_PX = 80;

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

function findAnchorIndex(noteElements, anchorBias) {
    const lineY = getViewportReferenceY(anchorBias);
    let bestIndex = NOT_FOUND;
    let bestDistance = Infinity;
    let bestCenterDistance = Infinity;

    for (let i = 0; i < noteElements.length; i += 1) {
        const noteElement = noteElements[i];
        if (!noteElement) continue;
        const blockElement = getNoteContentElement(noteElement);
        const rect = blockElement.getBoundingClientRect();
        if (rect.height <= 0) continue;

        const dist = distanceToLine(rect, lineY);
        const centerDist = Math.abs(half(rect.top + rect.bottom) - lineY);
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
    let anchorIndex = NOT_FOUND;
    if (requestedBias === 'auto') {
        const topRef = getViewportReferenceY('top');
        let bestPinnedIndex = NOT_FOUND;
        let bestPinnedDistance = Infinity;
        for (let i = 0; i < noteElements.length; i += 1) {
            const element = noteElements[i];
            if (!element) continue;
            const rect = element.getBoundingClientRect();
            if (rect.bottom <= topRef) continue;
            const dist = Math.abs(rect.top - topRef);
            if (dist <= PINNED_TOP_ANCHOR_MAX_DISTANCE_PX && dist < bestPinnedDistance) {
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
