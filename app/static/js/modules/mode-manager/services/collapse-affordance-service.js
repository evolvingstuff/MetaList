import { NotesAPI } from '../../api-client.js';

const NOTE_SELECTOR = '.note';
const NOTE_CONTENT_SELECTOR = '.note-content';
const META_STATUS_TEXT_SELECTOR = ':scope > .meta-status > .meta-status-text, :scope > .note-with-backlinks > .meta-status > .meta-status-text';
const COLLAPSED_DATA_KEY = 'isCollapsed';
const CAN_COLLAPSE_DATA_KEY = 'canCollapse';
const MULTILINE_HEIGHT_TOLERANCE = 1.35;
const LINE_BOX_TOP_TOLERANCE_PX = 1.5;
const SAME_LINE_VERTICAL_OVERLAP_RATIO = 0.5;
// A `line-height: normal` is taken as this multiple of the font size.
const NORMAL_LINE_HEIGHT_FONT_SIZE_RATIO = 1.2;
// Rects this thin or thinner hold no visible text and are not line boxes.
const MAX_EMPTY_RECT_EXTENT_PX = 0.5;
// Counting rendered lines stops here: enough to tell one line from several.
const RENDERED_LINE_COUNT_LIMIT = 2;

function parsePixelValue(value) {
    if (typeof value !== 'string') {
        throw new Error('parsePixelValue requires a string');
    }
    if (!value.endsWith('px')) {
        return null;
    }
    const numeric = Number.parseFloat(value);
    if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid CSS pixel value: ${value}`);
    }
    return numeric;
}

function resolveLineHeightPx(contentElement) {
    if (!contentElement) {
        throw new Error('resolveLineHeightPx requires content element');
    }
    if (!globalThis.window || typeof globalThis.window.getComputedStyle !== 'function') {
        throw new Error('window.getComputedStyle is required for collapse affordance measurement');
    }

    const styles = globalThis.window.getComputedStyle(contentElement);
    const lineHeight = parsePixelValue(styles.lineHeight);
    if (lineHeight !== null) {
        return lineHeight;
    }

    const fontSize = parsePixelValue(styles.fontSize);
    if (fontSize === null) {
        throw new Error(`Cannot resolve collapse line height from font-size: ${styles.fontSize}`);
    }
    return fontSize * NORMAL_LINE_HEIGHT_FONT_SIZE_RATIO;
}

function rectsShareRenderedLine(firstRect, secondRect) {
    if (Math.abs(firstRect.top - secondRect.top) <= LINE_BOX_TOP_TOLERANCE_PX) {
        return true;
    }
    const firstBottom = firstRect.top + firstRect.height;
    const secondBottom = secondRect.top + secondRect.height;
    const overlapHeight = Math.max(
        0,
        Math.min(firstBottom, secondBottom) - Math.max(firstRect.top, secondRect.top),
    );
    const shorterRectHeight = Math.min(firstRect.height, secondRect.height);
    return overlapHeight >= shorterRectHeight * SAME_LINE_VERTICAL_OVERLAP_RATIO;
}

// Returns the number of rendered line boxes, stopping at 2: callers only ask
// whether content spans more than one line, and line groups never merge.
function countRenderedLineBoxesUpToTwo(contentElement) {
    if (!globalThis.document || typeof globalThis.document.createRange !== 'function') {
        return null;
    }

    const range = globalThis.document.createRange();
    range.selectNodeContents(contentElement);
    const rects = Array.from(range.getClientRects()).filter((rect) => {
        return rect
            && typeof rect.width === 'number'
            && typeof rect.height === 'number'
            && rect.width > MAX_EMPTY_RECT_EXTENT_PX
            && rect.height > MAX_EMPTY_RECT_EXTENT_PX;
    });
    if (typeof range.detach === 'function') {
        range.detach();
    }

    const renderedLines = [];
    for (const rect of rects) {
        if (typeof rect.top !== 'number') {
            throw new Error('Range rect missing top value');
        }
        const matchingLineIndex = renderedLines.findIndex((lineRects) => {
            return lineRects.some((lineRect) => rectsShareRenderedLine(lineRect, rect));
        });
        if (matchingLineIndex >= 0) {
            renderedLines[matchingLineIndex].push(rect);
        } else {
            renderedLines.push([rect]);
            if (renderedLines.length === RENDERED_LINE_COUNT_LIMIT) {
                return RENDERED_LINE_COUNT_LIMIT;
            }
        }
    }
    return renderedLines.length;
}

function getCollapseMeasurementElement(contentElement) {
    if (!contentElement || typeof contentElement.querySelector !== 'function') {
        return contentElement;
    }
    const metaStatusText = contentElement.querySelector(META_STATUS_TEXT_SELECTOR);
    if (metaStatusText !== null) {
        return metaStatusText;
    }
    return contentElement;
}

export function doesRenderedContentNeedCollapse(contentElement) {
    if (!contentElement) {
        throw new Error('doesRenderedContentNeedCollapse requires content element');
    }

    const measurementElement = getCollapseMeasurementElement(contentElement);
    const renderedLineBoxCount = countRenderedLineBoxesUpToTwo(measurementElement);
    if (renderedLineBoxCount !== null) {
        return renderedLineBoxCount > 1;
    }

    const lineHeightPx = resolveLineHeightPx(measurementElement);
    const rect = measurementElement.getBoundingClientRect();
    if (!rect || typeof rect.height !== 'number') {
        throw new Error('content element must provide a bounding rect height');
    }
    if (typeof measurementElement.scrollHeight !== 'number') {
        throw new Error('content element must provide scrollHeight');
    }

    const measuredHeight = Math.max(rect.height, measurementElement.scrollHeight);
    return measuredHeight > lineHeightPx * MULTILINE_HEIGHT_TOLERANCE;
}

export function resolveCanCollapseFromDataset(dataset) {
    if (!dataset) {
        throw new Error('resolveCanCollapseFromDataset requires dataset');
    }
    return dataset.isCollapsible === 'true';
}

export function updateCollapseAffordances(root) {
    if (!root) {
        throw new Error('updateCollapseAffordances requires root node');
    }
    const noteElements = root.querySelectorAll(NOTE_SELECTOR);
    noteElements.forEach((note) => {
        updateCollapseAffordanceForNote(note);
    });
}

export function updateCollapseAffordancesForNotes(noteElements) {
    if (!noteElements) {
        throw new Error('updateCollapseAffordancesForNotes requires note elements');
    }
    for (const noteElement of noteElements) {
        updateCollapseAffordanceForNote(noteElement);
    }
}

export function updateCollapseAffordanceForNote(noteElement) {
    if (!noteElement) {
        throw new Error('updateCollapseAffordanceForNote called without a note element');
    }
    if (!noteElement.classList || !noteElement.classList.contains('note')) {
        throw new Error('updateCollapseAffordanceForNote requires an element with class note');
    }
    const contentElement = noteElement.querySelector(':scope > ' + NOTE_CONTENT_SELECTOR);
    if (!contentElement) {
        setDatasetValue(noteElement, CAN_COLLAPSE_DATA_KEY, 'false');
        return;
    }

    const isCollapsed = noteElement.dataset[COLLAPSED_DATA_KEY] === 'true';
    const isEditing = noteElement.classList.contains('editing');
    const hasChildren = noteElement.dataset.hasChildren === 'true';
    const isSearchRedacted = noteElement.dataset.searchRedacted === 'true';
    const serverCanCollapse = resolveCanCollapseFromDataset(noteElement.dataset);
    // The rendered measurement decides only when nothing else does. Skipping it
    // otherwise also skips its forced layout, which dominated page inserts.
    let canCollapse = false;
    if (!isSearchRedacted) {
        if (isEditing) {
            canCollapse = hasChildren;
        } else if (serverCanCollapse) {
            canCollapse = true;
        } else {
            canCollapse = measureRenderedContentNeedsCollapse(noteElement, contentElement);
        }
    }

    setDatasetValue(noteElement, CAN_COLLAPSE_DATA_KEY, canCollapse ? 'true' : 'false');
    const shouldApplyCollapsedClass = isCollapsed && canCollapse;

    // Ensure the DOM class matches the dataset for consistent styling. Writes
    // happen only on change: redundant writes still invalidate style and make
    // the next note's measurement relayout the whole page.
    if (noteElement.classList.contains('collapsed') !== shouldApplyCollapsedClass) {
        if (shouldApplyCollapsedClass) {
            noteElement.classList.add('collapsed');
        } else {
            noteElement.classList.remove('collapsed');
        }
    }

    const collapseToggle = noteElement.querySelector(':scope > .note-collapse-toggle');
    if (collapseToggle) {
        // No stylesheet selects on these attributes, so writing them never
        // invalidates style.
        collapseToggle.setAttribute('aria-label', shouldApplyCollapsedClass ? 'Expand note' : 'Collapse note');
        collapseToggle.removeAttribute('title');
    }
}

function measureRenderedContentNeedsCollapse(noteElement, contentElement) {
    // Measure the note as it would render expanded.
    const wasCollapsed = noteElement.classList.contains('collapsed');
    if (wasCollapsed) {
        noteElement.classList.remove('collapsed');
    }
    const renderedContentNeedsCollapse = doesRenderedContentNeedCollapse(contentElement);
    if (wasCollapsed) {
        noteElement.classList.add('collapsed');
    }
    return renderedContentNeedsCollapse;
}

function setDatasetValue(element, key, value) {
    if (element.dataset[key] !== value) {
        element.dataset[key] = value;
    }
}

export function setNoteCollapsedLocally(noteElement, collapsed) {
    if (!(noteElement instanceof HTMLElement) || !noteElement.classList.contains('note')) {
        throw new Error('setNoteCollapsedLocally requires note element');
    }
    if (typeof collapsed !== 'boolean') {
        throw new Error('setNoteCollapsedLocally requires collapsed boolean');
    }

    noteElement.dataset[COLLAPSED_DATA_KEY] = collapsed ? 'true' : 'false';
    updateCollapseAffordanceForNote(noteElement);
}

export function ensureNoteExpandedLocally(noteId) {
    if (!noteId) {
        throw new Error('ensureNoteExpandedLocally requires a noteId');
    }

    const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
    if (!noteElement) {
        throw new Error(`Cannot ensure local expanded state: note ${noteId} not found`);
    }

    setNoteCollapsedLocally(noteElement, false);
}

export async function ensureNoteExpanded(noteId) {
    if (!noteId) {
        throw new Error('ensureNoteExpanded requires a noteId');
    }

    const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
    if (!noteElement) {
        throw new Error(`Cannot ensure expanded state: note ${noteId} not found`);
    }

    const isCollapsed = noteElement.dataset[COLLAPSED_DATA_KEY] === 'true';
    if (!isCollapsed) {
        return;
    }

    await NotesAPI.expandNote(noteId);
    noteElement.dataset[COLLAPSED_DATA_KEY] = 'false';
    noteElement.classList.remove('collapsed');

    updateCollapseAffordanceForNote(noteElement);
}
