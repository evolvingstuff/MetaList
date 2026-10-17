// Before and after the caret.
const COLLAPSED_SPLIT_SEGMENT_COUNT = 2;
// Before, selected and after.
const RANGE_SPLIT_SEGMENT_COUNT = 3;

function assertNormalizedSegment(segment, index) {
    if (!segment || typeof segment !== 'object') {
        throw new Error(`Split segment ${index} must be an object`);
    }
    if (typeof segment.html !== 'string') {
        throw new Error(`Split segment ${index} html must be a string`);
    }
    if (typeof segment.hasText !== 'boolean') {
        throw new Error(`Split segment ${index} hasText must be a boolean`);
    }
}

function segmentHtml(segment) {
    assertNormalizedSegment(segment, 0);
    return segment.hasText ? segment.html : '';
}

export function selectSplitSegmentHtmls(normalizedSegments, isCollapsedSelection) {
    if (!Array.isArray(normalizedSegments)) {
        throw new Error('selectSplitSegmentHtmls requires an array of normalized segments');
    }
    if (typeof isCollapsedSelection !== 'boolean') {
        throw new Error('selectSplitSegmentHtmls requires boolean isCollapsedSelection');
    }

    normalizedSegments.forEach((segment, index) => assertNormalizedSegment(segment, index));

    if (isCollapsedSelection) {
        if (normalizedSegments.length !== COLLAPSED_SPLIT_SEGMENT_COUNT) {
            throw new Error('Collapsed split requires before and after segments');
        }
        const [beforeSegment, afterSegment] = normalizedSegments;
        if (!beforeSegment.hasText && !afterSegment.hasText) {
            return [];
        }
        return [segmentHtml(beforeSegment), segmentHtml(afterSegment)];
    }

    if (normalizedSegments.length !== RANGE_SPLIT_SEGMENT_COUNT) {
        throw new Error('Range split requires before, selected, and after segments');
    }

    const [beforeSegment, selectedSegment, afterSegment] = normalizedSegments;
    if (!selectedSegment.hasText) {
        return [];
    }
    if (!beforeSegment.hasText && !afterSegment.hasText) {
        return [];
    }

    return [segmentHtml(beforeSegment), selectedSegment.html, segmentHtml(afterSegment)];
}
