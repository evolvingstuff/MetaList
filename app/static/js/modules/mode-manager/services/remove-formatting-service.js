import {
    ADD_STYLE_OPTIONS,
    chooseStyleScope,
} from './add-style-service.js';
import { COMMENT_CLOSE, COMMENT_OPEN, MAX_WRAPPER_DEPTH } from './tag-syntax-service.js';

const WRAPPER_TYPES = Object.freeze([
    Object.freeze({ opener: '{', closer: '}' }),
    Object.freeze({ opener: '[', closer: ']' }),
    Object.freeze({ opener: '(', closer: ')' }),
]);
const WRAPPER_BY_OPENER = new Map(WRAPPER_TYPES.map((wrapper) => [wrapper.opener, wrapper]));
const STYLE_TAGS = new Set(ADD_STYLE_OPTIONS.map((option) => option.tag.toLowerCase()));

function requireText(value, name) {
    if (typeof value !== 'string') {
        throw new Error(`${name} must be a string`);
    }
}

function requireSelectionOffset(value, name, contentLength) {
    if (!Number.isInteger(value) || value < 0 || value > contentLength) {
        throw new Error(`${name} must be an in-bounds integer`);
    }
}

function isStyleTag(token) {
    return typeof token === 'string' && STYLE_TAGS.has(token.toLowerCase());
}

function scanTopLevelTokens(tagBarText) {
    const tokens = [];
    let index = 0;
    while (index < tagBarText.length) {
        while (index < tagBarText.length && /\s/.test(tagBarText[index])) {
            index += 1;
        }
        if (index >= tagBarText.length) {
            break;
        }

        const start = index;
        if (tagBarText.startsWith(COMMENT_OPEN, index)) {
            const commentEnd = tagBarText.indexOf(COMMENT_CLOSE, index + COMMENT_OPEN.length);
            index = commentEnd === -1 ? tagBarText.length : commentEnd + COMMENT_CLOSE.length;
            tokens.push(tagBarText.slice(start, index));
            continue;
        }

        const wrapper = WRAPPER_BY_OPENER.get(tagBarText[index]);
        if (wrapper) {
            let depth = 1;
            while (depth < MAX_WRAPPER_DEPTH && tagBarText[index + depth] === wrapper.opener) {
                depth += 1;
            }
            const closeToken = wrapper.closer.repeat(depth);
            const closeAt = tagBarText.indexOf(closeToken, index + depth);
            if (closeAt !== -1) {
                index = closeAt + depth;
                tokens.push(tagBarText.slice(start, index));
                continue;
            }
        }

        while (index < tagBarText.length && !/\s/.test(tagBarText[index])) {
            index += 1;
        }
        tokens.push(tagBarText.slice(start, index));
    }
    return tokens;
}

function parseWrappedToken(rawToken) {
    const wrapper = WRAPPER_BY_OPENER.get(rawToken[0]);
    if (!wrapper) {
        return null;
    }
    let depth = 1;
    while (depth < rawToken.length && rawToken[depth] === wrapper.opener) {
        depth += 1;
    }
    if (depth > MAX_WRAPPER_DEPTH || rawToken.slice(-depth) !== wrapper.closer.repeat(depth)) {
        return null;
    }
    const innerText = rawToken.slice(depth, -depth);
    if (innerText.length === 0) {
        return null;
    }
    return {
        opener: wrapper.opener,
        closer: wrapper.closer,
        depth,
        openToken: wrapper.opener.repeat(depth),
        closeToken: wrapper.closer.repeat(depth),
        innerTokens: innerText.split(/\s+/).filter(Boolean),
    };
}

function parseTagBar(tagBarText) {
    return scanTopLevelTokens(tagBarText).map((rawToken, index) => {
        const wrapped = rawToken.startsWith(COMMENT_OPEN) ? null : parseWrappedToken(rawToken);
        return { index, rawToken, wrapped };
    });
}

function wrapperKey(wrapper) {
    return `${wrapper.opener}:${wrapper.depth}`;
}

function buildScopedGroups(parsedTokens) {
    const groups = new Map();
    for (const token of parsedTokens) {
        if (!token.wrapped) {
            continue;
        }
        const key = wrapperKey(token.wrapped);
        if (!groups.has(key)) {
            groups.set(key, {
                wrapper: token.wrapped,
                tokenIndexes: [],
                styleTags: [],
                hasOrdinaryTags: false,
            });
        }
        const group = groups.get(key);
        const styleTags = token.wrapped.innerTokens.filter(isStyleTag);
        if (styleTags.length > 0) {
            group.tokenIndexes.push(token.index);
        }
        for (const styleTag of styleTags) {
            if (!group.styleTags.some((candidate) => candidate.toLowerCase() === styleTag.toLowerCase())) {
                group.styleTags.push(styleTag);
            }
        }
        if (token.wrapped.innerTokens.some((innerToken) => !isStyleTag(innerToken))) {
            group.hasOrdinaryTags = true;
        }
    }
    return new Map(
        [...groups.entries()].filter(([, group]) => group.styleTags.length > 0),
    );
}

function countRun(text, index, character) {
    let length = 1;
    while (index + length < text.length && text[index + length] === character) {
        length += 1;
    }
    return length;
}

function findScopeRegions(contentText, wrapper) {
    const stack = [];
    const regions = [];
    let index = 0;
    while (index < contentText.length) {
        const character = contentText[index];
        if (character !== wrapper.opener && character !== wrapper.closer) {
            index += 1;
            continue;
        }
        const runLength = countRun(contentText, index, character);
        if (runLength === wrapper.depth && character === wrapper.opener) {
            stack.push(index);
        } else if (runLength === wrapper.depth && character === wrapper.closer && stack.length > 0) {
            const openStart = stack.pop();
            regions.push({
                openStart,
                openEnd: openStart + wrapper.depth,
                closeStart: index,
                closeEnd: index + wrapper.depth,
            });
        }
        index += runLength;
    }
    regions.sort((left, right) => left.openStart - right.openStart);
    return regions;
}

function regionIntersectsSelection(region, selectionStart, selectionEnd) {
    return Math.max(region.openEnd, selectionStart) < Math.min(region.closeStart, selectionEnd);
}

function outsideSegments(region, selectionStart, selectionEnd) {
    if (!regionIntersectsSelection(region, selectionStart, selectionEnd)) {
        return [{ start: region.openEnd, end: region.closeStart }];
    }
    const segments = [];
    if (region.openEnd < selectionStart) {
        segments.push({ start: region.openEnd, end: Math.min(selectionStart, region.closeStart) });
    }
    if (selectionEnd < region.closeStart) {
        segments.push({ start: Math.max(selectionEnd, region.openEnd), end: region.closeStart });
    }
    return segments.filter((segment) => segment.end > segment.start);
}

function createEditAccumulator() {
    return {
        removalKeys: new Set(),
        removals: [],
        insertionsByPosition: new Map(),
    };
}

function addRemoval(edits, start, end) {
    const key = `${start}:${end}`;
    if (edits.removalKeys.has(key)) {
        return;
    }
    edits.removalKeys.add(key);
    edits.removals.push({ start, end });
}

function insertionBucket(edits, position) {
    if (!edits.insertionsByPosition.has(position)) {
        edits.insertionsByPosition.set(position, { closes: [], opens: [] });
    }
    return edits.insertionsByPosition.get(position);
}

function wrapSegment(edits, segment, wrapper) {
    if (segment.end <= segment.start) {
        return;
    }
    insertionBucket(edits, segment.start).opens.push(wrapper.openToken);
    insertionBucket(edits, segment.end).closes.unshift(wrapper.closeToken);
}

function removeRegionDelimiters(edits, region) {
    addRemoval(edits, region.openStart, region.openEnd);
    addRemoval(edits, region.closeStart, region.closeEnd);
}

function removeStylesFromWrappedToken(parsedToken) {
    const retained = parsedToken.wrapped.innerTokens.filter((innerToken) => !isStyleTag(innerToken));
    if (retained.length === 0) {
        return null;
    }
    return `${parsedToken.wrapped.openToken}${retained.join(' ')}${parsedToken.wrapped.closeToken}`;
}

function buildTagBarText(parsedTokens, replacements, appendedTokens) {
    const retained = [];
    for (const token of parsedTokens) {
        const replacement = replacements.has(token.index) ? replacements.get(token.index) : token.rawToken;
        if (typeof replacement === 'string' && replacement.length > 0) {
            retained.push(replacement);
        }
    }
    retained.push(...appendedTokens);
    return retained.join(' ');
}

function allocateScope(contentText, parsedTokens, replacements, appendedTokens) {
    const currentTags = buildTagBarText(parsedTokens, replacements, appendedTokens);
    const scope = chooseStyleScope(contentText, currentTags);
    return {
        opener: scope.opener,
        closer: scope.closer,
        depth: scope.depth,
        openToken: scope.openToken,
        closeToken: scope.closeToken,
    };
}

function appendScopedStyleTag(appendedTokens, wrapper, styleTags) {
    appendedTokens.push(`${wrapper.openToken}${styleTags.join(' ')}${wrapper.closeToken}`);
}

function processSimpleScopedGroup(options) {
    const { group, regions, selectionStart, selectionEnd, edits } = options;
    const retainedSegments = regions.flatMap((region) => outsideSegments(region, selectionStart, selectionEnd));
    if (retainedSegments.length === 0) {
        for (const region of regions) {
            removeRegionDelimiters(edits, region);
        }
        return false;
    }
    for (const region of regions) {
        if (!regionIntersectsSelection(region, selectionStart, selectionEnd)) {
            continue;
        }
        removeRegionDelimiters(edits, region);
        for (const segment of outsideSegments(region, selectionStart, selectionEnd)) {
            wrapSegment(edits, segment, group.wrapper);
        }
    }
    return true;
}

function processMixedScopedGroup(options) {
    const {
        contentText,
        parsedTokens,
        replacements,
        appendedTokens,
        group,
        regions,
        selectionStart,
        selectionEnd,
        edits,
    } = options;
    const retainedSegments = regions.flatMap((region) => outsideSegments(region, selectionStart, selectionEnd));
    if (retainedSegments.length === 0) {
        return;
    }
    const replacementScope = allocateScope(contentText, parsedTokens, replacements, appendedTokens);
    for (const segment of retainedSegments) {
        wrapSegment(edits, segment, replacementScope);
    }
    appendScopedStyleTag(appendedTokens, replacementScope, group.styleTags);
}

function processScopedGroups(options) {
    const {
        contentText,
        parsedTokens,
        replacements,
        appendedTokens,
        selectionStart,
        selectionEnd,
        edits,
    } = options;
    for (const group of buildScopedGroups(parsedTokens).values()) {
        const regions = findScopeRegions(contentText, group.wrapper);
        if (!regions.some((region) => regionIntersectsSelection(region, selectionStart, selectionEnd))) {
            continue;
        }
        if (group.hasOrdinaryTags) {
            for (const tokenIndex of group.tokenIndexes) {
                replacements.set(tokenIndex, removeStylesFromWrappedToken(parsedTokens[tokenIndex]));
            }
            processMixedScopedGroup({
                contentText,
                parsedTokens,
                replacements,
                appendedTokens,
                group,
                regions,
                selectionStart,
                selectionEnd,
                edits,
            });
            continue;
        }
        const styleRemains = processSimpleScopedGroup({
            group,
            regions,
            selectionStart,
            selectionEnd,
            edits,
        });
        if (!styleRemains) {
            for (const tokenIndex of group.tokenIndexes) {
                replacements.set(tokenIndex, null);
            }
        }
    }
}

function processGlobalStyles(options) {
    const {
        contentText,
        parsedTokens,
        replacements,
        appendedTokens,
        selectionStart,
        selectionEnd,
        edits,
    } = options;
    const globalStyles = [];
    for (const token of parsedTokens) {
        if (token.wrapped || token.rawToken.startsWith('/*') || !isStyleTag(token.rawToken)) {
            continue;
        }
        replacements.set(token.index, null);
        if (!globalStyles.some((styleTag) => styleTag.toLowerCase() === token.rawToken.toLowerCase())) {
            globalStyles.push(token.rawToken);
        }
    }
    if (globalStyles.length === 0) {
        return;
    }
    const retainedSegments = [
        { start: 0, end: selectionStart },
        { start: selectionEnd, end: contentText.length },
    ].filter((segment) => segment.end > segment.start);
    if (retainedSegments.length === 0) {
        return;
    }
    const replacementScope = allocateScope(contentText, parsedTokens, replacements, appendedTokens);
    for (const segment of retainedSegments) {
        wrapSegment(edits, segment, replacementScope);
    }
    appendScopedStyleTag(appendedTokens, replacementScope, globalStyles);
}

function finalizeEdits(edits) {
    const removals = [...edits.removals].sort((left, right) => left.start - right.start);
    const insertions = [...edits.insertionsByPosition.entries()]
        .map(([position, bucket]) => ({
            position,
            text: `${bucket.closes.join('')}${bucket.opens.join('')}`,
        }))
        .filter((insertion) => insertion.text.length > 0)
        .sort((left, right) => left.position - right.position);
    return { removals, insertions };
}

function buildEditedContent(options) {
    const { contentText, selectionStart, selectionEnd, removals, insertions } = options;
    const removedIndexes = new Set();
    for (const removal of removals) {
        for (let index = removal.start; index < removal.end; index += 1) {
            removedIndexes.add(index);
        }
    }
    const insertionByPosition = new Map(insertions.map((insertion) => [insertion.position, insertion.text]));
    let output = '';
    let nextSelectionStart = null;
    let nextSelectionEnd = null;
    for (let index = 0; index <= contentText.length; index += 1) {
        const insertionText = insertionByPosition.has(index)
            ? insertionByPosition.get(index)
            : '';
        const bucket = insertionText.length > 0 ? insertionText : '';
        const closeLength = (() => {
            const rawBucket = options.insertionBuckets.get(index);
            return rawBucket ? rawBucket.closes.join('').length : 0;
        })();
        output += bucket.slice(0, closeLength);
        if (index === selectionStart) {
            nextSelectionStart = output.length;
        }
        if (index === selectionEnd) {
            nextSelectionEnd = output.length;
        }
        output += bucket.slice(closeLength);
        if (index < contentText.length && !removedIndexes.has(index)) {
            output += contentText[index];
        }
    }
    if (!Number.isInteger(nextSelectionStart) || !Number.isInteger(nextSelectionEnd)) {
        throw new Error('Selected formatting removal failed to map selection');
    }
    return { contentText: output, selectionStart: nextSelectionStart, selectionEnd: nextSelectionEnd };
}

export function buildSelectedFormattingRemovalPlan(options) {
    if (!options || typeof options !== 'object') {
        throw new Error('buildSelectedFormattingRemovalPlan requires options');
    }
    const { contentText, tagBarText, selectionStart, selectionEnd } = options;
    requireText(contentText, 'contentText');
    requireText(tagBarText, 'tagBarText');
    requireSelectionOffset(selectionStart, 'selectionStart', contentText.length);
    requireSelectionOffset(selectionEnd, 'selectionEnd', contentText.length);
    if (selectionEnd <= selectionStart) {
        throw new Error('Selected formatting removal requires a non-empty selection');
    }

    const parsedTokens = parseTagBar(tagBarText);
    const replacements = new Map();
    const appendedTokens = [];
    const edits = createEditAccumulator();
    processGlobalStyles({
        contentText,
        parsedTokens,
        replacements,
        appendedTokens,
        selectionStart,
        selectionEnd,
        edits,
    });
    processScopedGroups({
        contentText,
        parsedTokens,
        replacements,
        appendedTokens,
        selectionStart,
        selectionEnd,
        edits,
    });

    const { removals, insertions } = finalizeEdits(edits);
    const updated = buildEditedContent({
        contentText,
        selectionStart,
        selectionEnd,
        removals,
        insertions,
        insertionBuckets: edits.insertionsByPosition,
    });
    return {
        contentText: updated.contentText,
        tagBarText: buildTagBarText(parsedTokens, replacements, appendedTokens),
        selectionStart: updated.selectionStart,
        selectionEnd: updated.selectionEnd,
        removals,
        insertions,
    };
}
