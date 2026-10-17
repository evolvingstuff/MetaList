const MARKER_ATTR = 'data-selection-marker';
const ZERO_WIDTH_CHAR = '\u200b';
// Math.random().toString(36) starts with this before the random digits.
const RANDOM_FRACTION_PREFIX = '0.';

function createMarker(id) {
    const span = document.createElement('span');
    span.setAttribute(MARKER_ATTR, id);
    span.style.display = 'inline';
    span.style.padding = '0';
    span.style.margin = '0';
    span.style.lineHeight = '0';
    span.style.fontSize = '0';
    span.style.pointerEvents = 'none';
    span.textContent = ZERO_WIDTH_CHAR;
    return span;
}

export function insertSelectionMarkers(container) {
    if (!container) {
        throw new Error('container is required for selection markers');
    }

    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return null;
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer) ||
        !container.contains(range.endContainer)) {
        return null;
    }

    const baseId = `rt-marker-${Date.now()}-${Math.random().toString(36).slice(RANDOM_FRACTION_PREFIX.length, 7)}`;
    const startId = `${baseId}-start`;
    const endId = `${baseId}-end`;
    const startMarker = createMarker(startId);
    const endMarker = createMarker(endId);

    const endRange = range.cloneRange();
    endRange.collapse(false);
    endRange.insertNode(endMarker);

    const startRange = range.cloneRange();
    startRange.collapse(true);
    startRange.insertNode(startMarker);

    return { startId, endId };
}

export function restoreSelectionFromMarkers(container, markers) {
    if (!container || !markers) {
        return false;
    }

    const selection = document.getSelection();
    if (!selection) {
        return false;
    }

    const startMarker = container.querySelector(`[${MARKER_ATTR}="${markers.startId}"]`);
    const endMarker = container.querySelector(`[${MARKER_ATTR}="${markers.endId}"]`);
    if (!startMarker || !endMarker) {
        return false;
    }

    const range = document.createRange();
    range.setStartAfter(startMarker);
    range.setEndBefore(endMarker);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
}

export function removeMarkers(container, markers) {
    if (!container || !markers) {
        return;
    }
    const startMarker = container.querySelector(`[${MARKER_ATTR}="${markers.startId}"]`);
    const endMarker = container.querySelector(`[${MARKER_ATTR}="${markers.endId}"]`);
    if (startMarker) {
        startMarker.remove();
    }
    if (endMarker) {
        endMarker.remove();
    }
}
