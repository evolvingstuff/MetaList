import { getTagBarValue, setTagBarValue } from './tag-bar-service.js';
import { buildSelectedFormattingRemovalPlan } from './remove-formatting-service.js';

const LINE_BREAK_PRESERVING_WHITE_SPACE_VALUES = new Set([
    'break-spaces',
    'pre',
    'pre-line',
    'pre-wrap',
]);
const BLOCK_STRUCTURE_TAGS = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'caption',
    'dd',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'li',
    'main',
    'nav',
    'ol',
    'p',
    'pre',
    'section',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
]);
const INLINE_FORMATTING_TAGS = new Set([
    'b',
    'bdi',
    'bdo',
    'big',
    'cite',
    'code',
    'dfn',
    'em',
    'font',
    'i',
    'ins',
    'kbd',
    'mark',
    'nobr',
    'q',
    's',
    'samp',
    'small',
    'span',
    'strike',
    'strong',
    'sub',
    'sup',
    'tt',
    'u',
    'var',
]);
const PRESENTATIONAL_BLOCK_TAGS = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote', 'address',
]);
const PRESENTATIONAL_ATTRIBUTES = Object.freeze([
    'align',
    'bgcolor',
    'color',
    'face',
    'size',
    'style',
]);

function textLengthForRange(range) {
    if (!(range instanceof Range)) {
        throw new Error('textLengthForRange requires Range');
    }
    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    const text = container.textContent;
    return typeof text === 'string' ? text.length : 0;
}

function resolveSelectionOffsets(noteContent, selectedRange) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('resolveSelectionOffsets requires note content element');
    }
    if (!(selectedRange instanceof Range) || selectedRange.collapsed) {
        throw new Error('resolveSelectionOffsets requires non-collapsed Range');
    }
    if (!noteContent.contains(selectedRange.startContainer) || !noteContent.contains(selectedRange.endContainer)) {
        throw new Error('Selected formatting range must stay inside note content');
    }

    const beforeRange = document.createRange();
    beforeRange.selectNodeContents(noteContent);
    beforeRange.setEnd(selectedRange.startContainer, selectedRange.startOffset);
    const selectionStart = textLengthForRange(beforeRange);
    const selectionLength = textLengthForRange(selectedRange);
    return {
        selectionStart,
        selectionEnd: selectionStart + selectionLength,
    };
}

export function findImagesIntersectingFormattingRemovalRange(noteContent, selectedRange) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('findImagesIntersectingFormattingRemovalRange requires note content element');
    }
    if (!(selectedRange instanceof Range) || selectedRange.collapsed) {
        throw new Error('findImagesIntersectingFormattingRemovalRange requires non-collapsed Range');
    }
    return [...noteContent.querySelectorAll('img')].filter(
        (image) => selectedRange.intersectsNode(image),
    );
}

export function findPreservedLineBreakOffsetsInText({
    text,
    textStart,
    selectionStart,
    selectionEnd,
}) {
    if (typeof text !== 'string') {
        throw new Error('findPreservedLineBreakOffsetsInText requires text string');
    }
    if (!Number.isInteger(textStart) || textStart < 0) {
        throw new Error('findPreservedLineBreakOffsetsInText requires non-negative textStart');
    }
    if (!Number.isInteger(selectionStart) || selectionStart < 0) {
        throw new Error('findPreservedLineBreakOffsetsInText requires non-negative selectionStart');
    }
    if (!Number.isInteger(selectionEnd) || selectionEnd < selectionStart) {
        throw new Error('findPreservedLineBreakOffsetsInText requires ordered selectionEnd');
    }

    const localSelectionStart = Math.max(0, selectionStart - textStart);
    const localSelectionEnd = Math.min(text.length, selectionEnd - textStart);
    if (localSelectionEnd <= localSelectionStart) {
        return [];
    }

    const offsets = [];
    const lineBreakPattern = /\r\n|\r|\n/g;
    let match = lineBreakPattern.exec(text);
    while (match) {
        const lineBreakStart = match.index;
        const lineBreakEnd = lineBreakStart + match[0].length;
        if (lineBreakStart >= localSelectionStart && lineBreakEnd <= localSelectionEnd) {
            offsets.push(textStart + lineBreakStart);
        }
        match = lineBreakPattern.exec(text);
    }
    return offsets;
}

export function buildSelectedTextFormattingSegments({
    textNodeLengths,
    selectionStart,
    selectionEnd,
}) {
    if (!Array.isArray(textNodeLengths)) {
        throw new Error('buildSelectedTextFormattingSegments requires text node lengths');
    }
    if (!Number.isInteger(selectionStart) || selectionStart < 0) {
        throw new Error('buildSelectedTextFormattingSegments requires non-negative selectionStart');
    }
    if (!Number.isInteger(selectionEnd) || selectionEnd < selectionStart) {
        throw new Error('buildSelectedTextFormattingSegments requires ordered selectionEnd');
    }

    const segments = [];
    let textStart = 0;
    for (const textLength of textNodeLengths) {
        if (!Number.isInteger(textLength) || textLength < 0) {
            throw new Error('Text node length must be a non-negative integer');
        }
        const textEnd = textStart + textLength;
        const segmentStart = Math.max(textStart, selectionStart);
        const segmentEnd = Math.min(textEnd, selectionEnd);
        if (segmentEnd > segmentStart) {
            segments.push({ start: segmentStart, end: segmentEnd });
        }
        textStart = textEnd;
    }
    if (selectionEnd > textStart) {
        throw new Error('Selected formatting range exceeds note text length');
    }
    return segments;
}

function findSelectedTextFormattingSegments(noteContent, offsets) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('findSelectedTextFormattingSegments requires note content element');
    }
    const walker = document.createTreeWalker(noteContent, NodeFilter.SHOW_TEXT);
    const textNodeLengths = [];
    let textNode = walker.nextNode();
    while (textNode) {
        textNodeLengths.push(textNode.data.length);
        textNode = walker.nextNode();
    }
    return buildSelectedTextFormattingSegments({
        textNodeLengths,
        selectionStart: offsets.selectionStart,
        selectionEnd: offsets.selectionEnd,
    });
}

function findSelectedCssRenderedLineBreakOffsets(noteContent, selectedRange, offsets) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('findSelectedCssRenderedLineBreakOffsets requires note content element');
    }
    if (!(selectedRange instanceof Range) || selectedRange.collapsed) {
        throw new Error('findSelectedCssRenderedLineBreakOffsets requires non-collapsed Range');
    }
    if (typeof window.getComputedStyle !== 'function') {
        throw new Error('Computed style API unavailable before Remove Formatting');
    }

    const walker = document.createTreeWalker(noteContent, NodeFilter.SHOW_TEXT);
    const lineBreakOffsets = [];
    let textStart = 0;
    let textNode = walker.nextNode();
    while (textNode) {
        const text = textNode.data;
        const parentElement = textNode.parentElement;
        if (!(parentElement instanceof HTMLElement)) {
            throw new Error('Remove Formatting text node requires parent element');
        }
        const whiteSpace = window.getComputedStyle(parentElement).whiteSpace;
        if (LINE_BREAK_PRESERVING_WHITE_SPACE_VALUES.has(whiteSpace)) {
            lineBreakOffsets.push(...findPreservedLineBreakOffsetsInText({
                text,
                textStart,
                selectionStart: offsets.selectionStart,
                selectionEnd: offsets.selectionEnd,
            }));
        }
        textStart += text.length;
        textNode = walker.nextNode();
    }
    return lineBreakOffsets;
}

function resolveTextBoundary(noteContent, textOffset, preferNextAtBoundary) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('resolveTextBoundary requires note content element');
    }
    if (!Number.isInteger(textOffset) || textOffset < 0) {
        throw new Error('resolveTextBoundary requires non-negative integer offset');
    }

    const walker = document.createTreeWalker(noteContent, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let textNode = walker.nextNode();
    while (textNode) {
        const length = textNode.data.length;
        const textEnd = consumed + length;
        if (textOffset < textEnd || (textOffset === textEnd && !preferNextAtBoundary)) {
            return { node: textNode, offset: textOffset - consumed };
        }
        consumed = textEnd;
        textNode = walker.nextNode();
        if (textOffset === consumed && preferNextAtBoundary && textNode) {
            return { node: textNode, offset: 0 };
        }
    }
    if (textOffset !== consumed) {
        throw new Error(`Text offset ${textOffset} exceeds note content length ${consumed}`);
    }
    return { node: noteContent, offset: noteContent.childNodes.length };
}

function moveSiblingsIntoClone(parent, branch, clone, direction) {
    if (!(parent instanceof HTMLElement)) {
        throw new Error('moveSiblingsIntoClone requires parent element');
    }
    if (!(clone instanceof HTMLElement)) {
        throw new Error('moveSiblingsIntoClone requires clone element');
    }
    if (direction !== 'before' && direction !== 'after') {
        throw new Error('moveSiblingsIntoClone requires before or after direction');
    }

    if (direction === 'before') {
        while (parent.firstChild && parent.firstChild !== branch) {
            clone.appendChild(parent.firstChild);
        }
        return;
    }
    while (branch.nextSibling) {
        clone.appendChild(branch.nextSibling);
    }
}

function isolateInlineBranch(parent, branch, shouldUnwrapParent) {
    if (!(parent instanceof HTMLElement)) {
        throw new Error('isolateInlineBranch requires parent element');
    }
    if (typeof shouldUnwrapParent !== 'boolean') {
        throw new Error('isolateInlineBranch requires unwrap decision');
    }
    if (branch.parentNode !== parent) {
        throw new Error('Inline formatting branch must be a direct child of its parent');
    }
    const container = parent.parentNode;
    if (!container) {
        throw new Error('Inline formatting parent must be attached');
    }

    const beforeClone = parent.cloneNode(false);
    const afterClone = parent.cloneNode(false);
    if (!(beforeClone instanceof HTMLElement) || !(afterClone instanceof HTMLElement)) {
        throw new Error('Inline formatting clone must be an element');
    }
    moveSiblingsIntoClone(parent, branch, beforeClone, 'before');
    moveSiblingsIntoClone(parent, branch, afterClone, 'after');

    if (beforeClone.hasChildNodes()) {
        container.insertBefore(beforeClone, parent);
    }
    if (shouldUnwrapParent) {
        container.insertBefore(branch, parent);
        if (afterClone.hasChildNodes()) {
            container.insertBefore(afterClone, parent);
        }
        parent.remove();
        return branch;
    }
    if (afterClone.hasChildNodes()) {
        container.insertBefore(afterClone, parent.nextSibling);
    }
    return parent;
}

function removePresentationalAttributes(element) {
    if (!(element instanceof HTMLElement)) {
        throw new Error('removePresentationalAttributes requires element');
    }
    for (const attributeName of PRESENTATIONAL_ATTRIBUTES) {
        element.removeAttribute(attributeName);
    }
}

function removeFullySelectedBlockFormatting(noteContent, offsets) {
    // Track non-whitespace text extents once. Dragging across a title commonly
    // omits the source HTML's leading/trailing whitespace inside its heading.
    const extents = new Map();
    const walker = document.createTreeWalker(noteContent, NodeFilter.SHOW_TEXT);
    let textOffset = 0;
    let textNode = walker.nextNode();
    while (textNode) {
        const firstVisibleOffset = textNode.data.search(/\S/);
        if (firstVisibleOffset !== -1) {
            const start = textOffset + firstVisibleOffset;
            const end = textOffset + textNode.data.trimEnd().length;
            let parent = textNode.parentElement;
            while (parent && parent !== noteContent) {
                if (BLOCK_STRUCTURE_TAGS.has(parent.tagName.toLowerCase())) {
                    if (!extents.has(parent)) extents.set(parent, { start, end });
                    else extents.get(parent).end = end;
                }
                parent = parent.parentElement;
            }
        }
        textOffset += textNode.data.length;
        textNode = walker.nextNode();
    }

    for (const [block, extent] of extents) {
        if (extent.start < offsets.selectionStart || extent.end > offsets.selectionEnd) continue;
        removePresentationalAttributes(block);
        block.removeAttribute('class');
        if (PRESENTATIONAL_BLOCK_TAGS.has(block.tagName.toLowerCase())) {
            // A neutral block preserves its line boundary without the heading,
            // quotation, or preformatted block's default presentation.
            const replacement = document.createElement('div');
            while (block.firstChild) replacement.appendChild(block.firstChild);
            block.replaceWith(replacement);
        }
    }
}

function applyPlainTextToSelectedBlockFragments(noteContent, formattingSegments) {
    for (const segment of [...formattingSegments].sort((left, right) => right.start - left.start)) {
        const selectedTextNode = isolateSelectedTextNode(noteContent, segment);
        let parent = selectedTextNode.parentElement;
        let hasInheritedBlockFormatting = false;
        while (parent && parent !== noteContent) {
            const tag = parent.tagName.toLowerCase();
            if (BLOCK_STRUCTURE_TAGS.has(tag)
                && (PRESENTATIONAL_BLOCK_TAGS.has(tag) || parent.hasAttribute('style'))) {
                hasInheritedBlockFormatting = true;
                break;
            }
            parent = parent.parentElement;
        }
        if (!hasInheritedBlockFormatting) continue;
        // Preserve the shared heading/block and its unselected text. This
        // allowlisted span cancels inherited typography only for the selection.
        const plain = document.createElement('span');
        plain.className = 'note-unformatted-text';
        selectedTextNode.parentNode.insertBefore(plain, selectedTextNode);
        plain.appendChild(selectedTextNode);
    }
}

function isolateSelectedTextNode(noteContent, segment) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('isolateSelectedTextNode requires note content element');
    }
    const startBoundary = resolveTextBoundary(noteContent, segment.start, true);
    const endBoundary = resolveTextBoundary(noteContent, segment.end, false);
    if (startBoundary.node !== endBoundary.node) {
        throw new Error('Selected formatting segment must stay inside one text node');
    }

    let selectedTextNode = startBoundary.node;
    if (endBoundary.offset < selectedTextNode.data.length) {
        selectedTextNode.splitText(endBoundary.offset);
    }
    if (startBoundary.offset > 0) {
        selectedTextNode = selectedTextNode.splitText(startBoundary.offset);
    }
    return selectedTextNode;
}

function removeInlineFormattingAroundTextNode(noteContent, selectedTextNode) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('removeInlineFormattingAroundTextNode requires note content element');
    }

    let branch = selectedTextNode;
    let parent = branch.parentElement;
    while (parent && parent !== noteContent) {
        const tagName = parent.tagName.toLowerCase();
        if (BLOCK_STRUCTURE_TAGS.has(tagName)) {
            return;
        }
        const shouldUnwrapParent = INLINE_FORMATTING_TAGS.has(tagName);
        branch = isolateInlineBranch(parent, branch, shouldUnwrapParent);
        if (!shouldUnwrapParent) {
            removePresentationalAttributes(branch);
        }
        parent = branch.parentElement;
    }
}

export function removeInlineFormattingFromTextSegments(noteContent, formattingSegments) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('removeInlineFormattingFromTextSegments requires note content element');
    }
    if (!Array.isArray(formattingSegments)) {
        throw new Error('removeInlineFormattingFromTextSegments requires formatting segments');
    }

    const descendingSegments = [...formattingSegments].sort(
        (left, right) => right.start - left.start,
    );
    for (const segment of descendingSegments) {
        const selectedTextNode = isolateSelectedTextNode(noteContent, segment);
        removeInlineFormattingAroundTextNode(noteContent, selectedTextNode);
    }
}

function deleteTextRange(noteContent, start, end) {
    const startBoundary = resolveTextBoundary(noteContent, start, false);
    const endBoundary = resolveTextBoundary(noteContent, end, false);
    const range = document.createRange();
    range.setStart(startBoundary.node, startBoundary.offset);
    range.setEnd(endBoundary.node, endBoundary.offset);
    range.deleteContents();
}

function adjustedInsertionPosition(position, removals) {
    let removedBefore = 0;
    for (const removal of removals) {
        if (removal.start < position && position < removal.end) {
            throw new Error('Formatting insertion cannot land inside a removed delimiter');
        }
        if (removal.end <= position) {
            removedBefore += removal.end - removal.start;
        }
    }
    return position - removedBefore;
}

function applyDelimiterEdits(noteContent, plan) {
    const descendingRemovals = [...plan.removals].sort((left, right) => right.start - left.start);
    for (const removal of descendingRemovals) {
        deleteTextRange(noteContent, removal.start, removal.end);
    }

    const adjustedInsertions = new Map();
    for (const insertion of plan.insertions) {
        const position = adjustedInsertionPosition(insertion.position, plan.removals);
        const existing = adjustedInsertions.has(position)
            ? adjustedInsertions.get(position)
            : '';
        adjustedInsertions.set(position, `${existing}${insertion.text}`);
    }
    const descendingInsertions = [...adjustedInsertions.entries()].sort(
        ([leftPosition], [rightPosition]) => rightPosition - leftPosition,
    );
    for (const [position, text] of descendingInsertions) {
        const boundary = resolveTextBoundary(noteContent, position, false);
        const range = document.createRange();
        range.setStart(boundary.node, boundary.offset);
        range.collapse(true);
        range.insertNode(document.createTextNode(text));
    }
}

function insertExplicitLineBreaks(noteContent, lineBreakOffsets) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('insertExplicitLineBreaks requires note content element');
    }
    if (!Array.isArray(lineBreakOffsets)) {
        throw new Error('insertExplicitLineBreaks requires line break offset array');
    }

    const descendingOffsets = [...new Set(lineBreakOffsets)].sort((left, right) => right - left);
    for (const position of descendingOffsets) {
        if (!Number.isInteger(position) || position < 0) {
            throw new Error('Explicit line break position must be a non-negative integer');
        }
        const boundary = resolveTextBoundary(noteContent, position, false);
        const range = document.createRange();
        range.setStart(boundary.node, boundary.offset);
        range.collapse(true);
        range.insertNode(document.createElement('br'));
    }
}

export function restoreFormattingRemovalSelection(noteContent, selectionStart, selectionEnd) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('restoreFormattingRemovalSelection requires note content element');
    }
    const startBoundary = resolveTextBoundary(noteContent, selectionStart, false);
    const endBoundary = resolveTextBoundary(noteContent, selectionEnd, false);
    const range = document.createRange();
    range.setStart(startBoundary.node, startBoundary.offset);
    range.setEnd(endBoundary.node, endBoundary.offset);

    noteContent.focus();
    const selection = window.getSelection();
    if (!selection) {
        throw new Error('Selection API unavailable after Remove Formatting');
    }
    selection.removeAllRanges();
    selection.addRange(range);
    return range.cloneRange();
}

export function resolveActiveFormattingRemovalRange(noteContent) {
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('resolveActiveFormattingRemovalRange requires note content element');
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
        return null;
    }
    const range = selection.getRangeAt(0);
    if (range.collapsed) {
        return null;
    }
    if (!noteContent.contains(range.startContainer) || !noteContent.contains(range.endContainer)) {
        return null;
    }
    const offsets = resolveSelectionOffsets(noteContent, range);
    const selectedImages = findImagesIntersectingFormattingRemovalRange(noteContent, range);
    if (offsets.selectionEnd <= offsets.selectionStart && selectedImages.length === 0) {
        return null;
    }
    return range.cloneRange();
}

export function removeFormattingFromSelectedRange(noteElement, noteContent, selectedRange) {
    if (!(noteElement instanceof HTMLElement)) {
        throw new Error('removeFormattingFromSelectedRange requires note element');
    }
    if (!(noteContent instanceof HTMLElement)) {
        throw new Error('removeFormattingFromSelectedRange requires note content element');
    }
    if (!(selectedRange instanceof Range) || selectedRange.collapsed) {
        throw new Error('removeFormattingFromSelectedRange requires non-collapsed Range');
    }

    const offsets = resolveSelectionOffsets(noteContent, selectedRange);
    const contentText = noteContent.textContent;
    if (typeof contentText !== 'string') {
        throw new Error('Remove Formatting note content text is unavailable');
    }
    const originalTags = getTagBarValue(noteElement);
    const selectedImages = findImagesIntersectingFormattingRemovalRange(
        noteContent,
        selectedRange,
    );
    const cssRenderedLineBreakOffsets = findSelectedCssRenderedLineBreakOffsets(
        noteContent,
        selectedRange,
        offsets,
    );
    const formattingSegments = findSelectedTextFormattingSegments(noteContent, offsets);
    const hasSelectedText = offsets.selectionEnd > offsets.selectionStart;
    const plan = hasSelectedText
        ? buildSelectedFormattingRemovalPlan({
            contentText,
            tagBarText: originalTags,
            selectionStart: offsets.selectionStart,
            selectionEnd: offsets.selectionEnd,
        })
        : {
            contentText,
            tagBarText: originalTags,
            selectionStart: offsets.selectionStart,
            selectionEnd: offsets.selectionEnd,
            removals: [],
            insertions: [],
        };

    const originalHtml = noteContent.innerHTML;
    removeFullySelectedBlockFormatting(noteContent, offsets);
    removeInlineFormattingFromTextSegments(noteContent, formattingSegments);
    applyPlainTextToSelectedBlockFragments(noteContent, formattingSegments);
    insertExplicitLineBreaks(noteContent, cssRenderedLineBreakOffsets);
    for (const image of selectedImages) {
        if (noteContent.contains(image)) {
            image.remove();
        }
    }
    applyDelimiterEdits(noteContent, plan);
    setTagBarValue(noteElement, plan.tagBarText);

    if (noteContent.textContent !== plan.contentText) {
        throw new Error('Remove Formatting delimiter edits diverged from the removal plan');
    }
    let changed = noteContent.innerHTML !== originalHtml;
    if (plan.tagBarText !== originalTags) {
        changed = true;
    }
    restoreFormattingRemovalSelection(
        noteContent,
        plan.selectionStart,
        plan.selectionEnd,
    );
    return {
        changed,
        selectionStart: plan.selectionStart,
        selectionEnd: plan.selectionEnd,
    };
}
