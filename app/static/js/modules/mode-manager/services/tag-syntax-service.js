const TAG_CONTAINS_DISALLOWED = new Set([
    ':',
    ',',
    '"',
    '\\',
    '>',
    '<',
    '=',
    '[',
    ']',
    '{',
    '}',
    '(',
    ')',
    '*',
    '|',
    ';',
    '~',
    '`',
]);

const TOKEN_START_DISALLOWED = new Set(['-', '+', '/']);

const TAG_WRAPPER_OPENERS = new Set(['[', '{', '(']);
const TAG_WRAPPER_PAIRS = new Map([
    ['[', ']'],
    ['{', '}'],
    ['(', ')'],
]);
const TAG_WRAPPER_CHARS = new Set(['[', ']', '{', '}', '(', ')']);

function isAsciiPrintable(char) {
    if (typeof char !== 'string' || char.length === 0) {
        return false;
    }
    const code = char.charCodeAt(0);
    return code >= 0x20 && code <= 0x7e;
}

function isWhitespace(char) {
    return typeof char === 'string' && char.length === 1 && /\s/.test(char);
}

function enforceTagTokenInternal(rawToken, allowTrailingAssignmentSeparator) {
    if (typeof rawToken !== 'string') {
        throw new Error('enforceTagTokenInternal expects a string');
    }
    if (typeof allowTrailingAssignmentSeparator !== 'boolean') {
        throw new Error('enforceTagTokenInternal expects allowTrailingAssignmentSeparator boolean');
    }

    let token = rawToken;
    while (token.length > 0 && TOKEN_START_DISALLOWED.has(token[0])) {
        token = token.slice(1);
    }

    const assignmentSeparatorCount = Array.from(token).filter((char) => char === '=').length;
    const assignmentSeparatorIndex = token.indexOf('=');
    const canPreserveAssignmentSeparator = (
        assignmentSeparatorCount === 1
        && assignmentSeparatorIndex > 0
        && (
            assignmentSeparatorIndex < token.length - 1
            || (allowTrailingAssignmentSeparator && assignmentSeparatorIndex === token.length - 1)
        )
    );
    let out = '';
    for (const char of token) {
        if (!isAsciiPrintable(char)) {
            continue;
        }
        if (char === '=' && canPreserveAssignmentSeparator) {
            out += char;
            continue;
        }
        if (TAG_CONTAINS_DISALLOWED.has(char)) {
            continue;
        }
        out += char;
    }
    return out;
}

function enforceTagToken(rawToken) {
    return enforceTagTokenInternal(rawToken, false);
}

function enforceWrappedTagTokenInternal(
    rawToken,
    preserveTrailingSpaceWhenUnclosed,
    allowTrailingAssignmentSeparator,
) {
    if (typeof rawToken !== 'string') {
        throw new Error('enforceWrappedTagToken expects a string');
    }
    if (typeof preserveTrailingSpaceWhenUnclosed !== 'boolean') {
        throw new Error('enforceWrappedTagTokenInternal expects preserveTrailingSpaceWhenUnclosed boolean');
    }
    if (typeof allowTrailingAssignmentSeparator !== 'boolean') {
        throw new Error('enforceWrappedTagTokenInternal expects allowTrailingAssignmentSeparator boolean');
    }

    if (rawToken.length === 0) {
        return '';
    }

    const opener = rawToken[0];
    if (!TAG_WRAPPER_OPENERS.has(opener)) {
        return enforceTagTokenInternal(rawToken, allowTrailingAssignmentSeparator);
    }

    const closer = TAG_WRAPPER_PAIRS.get(opener);
    if (typeof closer !== 'string') {
        throw new Error(`Unknown tag wrapper opener: ${opener}`);
    }

    let openerCount = 0;
    while (openerCount < rawToken.length && rawToken[openerCount] === opener && openerCount < 3) {
        openerCount += 1;
    }

    let remainder = rawToken.slice(openerCount);

    const remainderHadTrailingWhitespace = /\s$/.test(remainder);

    while (remainder.length > 0 && TAG_WRAPPER_CHARS.has(remainder[remainder.length - 1]) && remainder[remainder.length - 1] !== closer) {
        remainder = remainder.slice(0, -1);
    }

    let closerCount = 0;
    while (closerCount < openerCount && remainder.endsWith(closer)) {
        closerCount += 1;
        remainder = remainder.slice(0, -1);
    }

    const wrapperIsUnclosed = closerCount < openerCount;
    const rawInnerParts = remainder.split(/\s+/).filter((part) => part.length > 0);
    const innerParts = rawInnerParts
        .map((part, partIndex) => enforceTagTokenInternal(
            part,
            allowTrailingAssignmentSeparator
                && wrapperIsUnclosed
                && !remainderHadTrailingWhitespace
                && partIndex === rawInnerParts.length - 1,
        ))
        .filter((part) => part.length > 0);
    let sanitizedInner = innerParts.join(' ');
    if (preserveTrailingSpaceWhenUnclosed && wrapperIsUnclosed && remainderHadTrailingWhitespace && sanitizedInner.length > 0) {
        sanitizedInner += ' ';
    }
    if (sanitizedInner.length === 0) {
        if (openerCount > closerCount) {
            return opener.repeat(openerCount);
        }
        return '';
    }

    const prefix = opener.repeat(openerCount);
    const suffix = closer.repeat(closerCount);
    return `${prefix}${sanitizedInner}${suffix}`;
}

function enforceWrappedTagToken(rawToken) {
    return enforceWrappedTagTokenInternal(rawToken, false, false);
}

function enforceWrappedTagTokenForEditing(rawToken, allowTrailingAssignmentSeparator) {
    return enforceWrappedTagTokenInternal(rawToken, true, allowTrailingAssignmentSeparator);
}

function analyzeUnclosedWrapperTokenInfo(token) {
    if (typeof token !== 'string') {
        throw new Error('analyzeUnclosedWrapperTokenInfo expects a string');
    }

    if (token.length === 0) {
        return null;
    }

    const opener = token[0];
    if (!TAG_WRAPPER_OPENERS.has(opener)) {
        return null;
    }

    const closer = TAG_WRAPPER_PAIRS.get(opener);
    if (typeof closer !== 'string') {
        throw new Error(`Unknown tag wrapper opener: ${opener}`);
    }

    let openerCount = 0;
    while (openerCount < token.length && token[openerCount] === opener && openerCount < 3) {
        openerCount += 1;
    }

    let closerCount = 0;
    while (
        closerCount < token.length
        && token[token.length - 1 - closerCount] === closer
        && closerCount < openerCount
    ) {
        closerCount += 1;
    }

    if (closerCount >= openerCount) {
        return null;
    }

    const inner = token.slice(openerCount, token.length - closerCount);
    const innerParts = inner
        .split(/\s+/)
        .map((part) => enforceTagToken(part))
        .filter((part) => part.length > 0);
    const shouldWarn = innerParts.length > 0 && /\s/.test(inner.trimStart());

    return {
        missingSuffix: closer.repeat(openerCount - closerCount),
        shouldWarn,
        inner,
        depth: openerCount,
    };
}

function enforceTagBarInputInternal(rawInput, options) {
    if (typeof rawInput !== 'string') {
        throw new Error('enforceTagBarInputInternal expects a string');
    }

    const allowTrailingCommentStart = Boolean(options && options.allowTrailingCommentStart);

    let output = '';
    let currentToken = '';
    let inComment = false;
    let wrapper = null;

    const flushToken = ({ isFinal }) => {
        if (currentToken.length === 0) {
            return;
        }

        if (allowTrailingCommentStart && currentToken === '/') {
            output += currentToken;
        } else {
            if (allowTrailingCommentStart) {
                output += enforceWrappedTagTokenForEditing(currentToken, isFinal);
            } else {
                output += enforceWrappedTagToken(currentToken);
            }
        }
        currentToken = '';
    };

    for (let index = 0; index < rawInput.length; index += 1) {
        const char = rawInput[index];
        const nextChar = index + 1 < rawInput.length ? rawInput[index + 1] : '';

        if (!inComment && char === '/' && nextChar === '*') {
            flushToken({ isFinal: false });
            output += '/*';
            inComment = true;
            index += 1;
            continue;
        }

        if (inComment) {
            if (char === '*' && nextChar === '/') {
                output += '*/';
                inComment = false;
                index += 1;
                continue;
            }
            if (!isAsciiPrintable(char)) {
                continue;
            }
            output += char;
            continue;
        }

        if (!wrapper && currentToken.length === 0 && TAG_WRAPPER_OPENERS.has(char)) {
            const opener = char;
            const closer = TAG_WRAPPER_PAIRS.get(opener);
            if (typeof closer !== 'string') {
                throw new Error(`Unknown tag wrapper opener: ${opener}`);
            }
            let openerCount = 0;
            while (openerCount < rawInput.length - index && rawInput[index + openerCount] === opener && openerCount < 3) {
                openerCount += 1;
            }
            wrapper = { opener, closer, openerCount };
            currentToken += opener.repeat(openerCount);
            index += openerCount - 1;
            continue;
        }

        if (isWhitespace(char) && !wrapper) {
            flushToken({ isFinal: false });
            if (output.length > 0 && output[output.length - 1] !== ' ') {
                output += ' ';
            }
            continue;
        }

        currentToken += char;

        if (wrapper && currentToken.endsWith(wrapper.closer.repeat(wrapper.openerCount))) {
            wrapper = null;
        }
    }

    flushToken({ isFinal: true });
    return output;
}

export function enforceTagBarInput(rawInput) {
    return enforceTagBarInputInternal(rawInput, { allowTrailingCommentStart: false });
}

export function enforceTagBarInputForEditing(rawInput) {
    return enforceTagBarInputInternal(rawInput, { allowTrailingCommentStart: true });
}

function scanTagBarSegments(rawInput) {
    if (typeof rawInput !== 'string') {
        throw new Error('scanTagBarSegments expects a string');
    }

    const segments = [];
    let currentToken = '';
    let index = 0;
    let wrapper = null;
    while (index < rawInput.length) {
        if (rawInput.startsWith('/*', index)) {
            if (currentToken.length > 0) {
                segments.push({ type: 'token', text: currentToken });
                currentToken = '';
            }

            const closeIndex = rawInput.indexOf('*/', index + 2);
            if (closeIndex === -1) {
                return { segments, unclosedCommentText: rawInput.slice(index) };
            }

            segments.push({ type: 'comment', text: rawInput.slice(index, closeIndex + 2) });
            index = closeIndex + 2;
            continue;
        }

        const char = rawInput[index];
        if (!wrapper && currentToken.length === 0 && TAG_WRAPPER_OPENERS.has(char)) {
            const opener = char;
            const closer = TAG_WRAPPER_PAIRS.get(opener);
            if (typeof closer !== 'string') {
                throw new Error(`Unknown tag wrapper opener: ${opener}`);
            }
            let openerCount = 0;
            while (openerCount < rawInput.length - index && rawInput[index + openerCount] === opener && openerCount < 3) {
                openerCount += 1;
            }
            wrapper = { opener, closer, openerCount };
            currentToken += opener.repeat(openerCount);
            index += openerCount;
            continue;
        }

        if (isWhitespace(char) && !wrapper) {
            if (currentToken.length > 0) {
                segments.push({ type: 'token', text: currentToken });
                currentToken = '';
            }
            index += 1;
            continue;
        }

        currentToken += char;
        index += 1;

        if (wrapper && currentToken.endsWith(wrapper.closer.repeat(wrapper.openerCount))) {
            wrapper = null;
        }
    }

    if (currentToken.length > 0) {
        segments.push({ type: 'token', text: currentToken });
    }

    return { segments, unclosedCommentText: null };
}

function scanTagBarTokensWithPositions(rawInput) {
    const tokens = [];
    const commentRanges = [];
    let index = 0;

    while (index < rawInput.length) {
        while (index < rawInput.length && isWhitespace(rawInput[index])) {
            index += 1;
        }
        if (index >= rawInput.length) {
            break;
        }

        if (rawInput.startsWith('/*', index)) {
            const end = rawInput.indexOf('*/', index + 2);
            if (end === -1) {
                break;
            }
            commentRanges.push({ start: index, end: end + 2 });
            index = end + 2;
            continue;
        }

        const start = index;
        const opener = rawInput[index];
        if (TAG_WRAPPER_OPENERS.has(opener)) {
            let openerCount = 1;
            while (index + openerCount < rawInput.length && rawInput[index + openerCount] === opener && openerCount < 3) {
                openerCount += 1;
            }
            if (openerCount <= 3) {
                const closer = TAG_WRAPPER_PAIRS.get(opener);
                if (typeof closer !== 'string') {
                    throw new Error(`Unknown tag wrapper opener: ${opener}`);
                }
                const needle = closer.repeat(openerCount);
                const closeAt = rawInput.indexOf(needle, index + openerCount);
                if (closeAt !== -1) {
                    index = closeAt + openerCount;
                } else {
                    index = rawInput.length;
                }
                tokens.push({ text: rawInput.slice(start, index), start, end: index });
                continue;
            }
        }

        while (index < rawInput.length && !isWhitespace(rawInput[index])) {
            index += 1;
        }
        tokens.push({ text: rawInput.slice(start, index), start, end: index });
    }

    return { tokens, commentRanges };
}

function unwrapWrapperToken(token) {
    if (!token) {
        return null;
    }

    const opener = token[0];
    if (!TAG_WRAPPER_OPENERS.has(opener)) {
        return null;
    }

    let openerCount = 1;
    while (openerCount < token.length && token[openerCount] === opener) {
        openerCount += 1;
    }
    if (openerCount > 3) {
        return null;
    }

    const closer = TAG_WRAPPER_PAIRS.get(opener);
    if (typeof closer !== 'string') {
        throw new Error(`Unknown tag wrapper opener: ${opener}`);
    }

    if (token.length < openerCount * 2) {
        return null;
    }

    if (!token.endsWith(closer.repeat(openerCount))) {
        return null;
    }

    let closerCount = 0;
    while (closerCount < token.length && token[token.length - 1 - closerCount] === closer) {
        closerCount += 1;
    }
    if (closerCount !== openerCount) {
        return null;
    }

    const inner = token.slice(openerCount, token.length - openerCount);
    if (!inner) {
        return null;
    }

    return { inner, depth: openerCount };
}

export function analyzeTagBarInput(rawInput) {
    if (typeof rawInput !== 'string') {
        throw new Error('analyzeTagBarInput expects a string');
    }

    const enforcedText = enforceTagBarInput(rawInput);
    const { segments, unclosedCommentText } = scanTagBarSegments(enforcedText);


    let unclosedWrapperSuffix = null;
    // Keep the typed trailing space for warning timing; persisted tokens still
    // use the strict enforcement and sanitization path below.
    const editingSegments = scanTagBarSegments(enforceTagBarInputForEditing(rawInput)).segments;
    for (const segment of editingSegments) {
        if (segment.type !== 'token') {
            continue;
        }
        const wrapperInfo = analyzeUnclosedWrapperTokenInfo(segment.text);
        if (wrapperInfo && wrapperInfo.shouldWarn) {
            unclosedWrapperSuffix = wrapperInfo.missingSuffix;
            break;
        }
    }
    let hasReservedOrTag = false;

    const sanitizedSegments = [];
    const normalizedSegments = [];
    for (const segment of segments) {
        normalizedSegments.push(segment.text);
        if (segment.type === 'token') {
            const wrapperInfo = analyzeUnclosedWrapperTokenInfo(segment.text);
            if (wrapperInfo) {
                continue;
            }
            const closedWrapperInfo = unwrapWrapperToken(segment.text);
            const tagTerms = closedWrapperInfo
                ? closedWrapperInfo.inner.split(/\s+/).filter(Boolean)
                : [segment.text];
            if (tagTerms.includes('OR')) {
                hasReservedOrTag = true;
                continue;
            }
        }
        sanitizedSegments.push(segment.text);
    }

    const sanitizedText = sanitizedSegments.join(' ').trim();

    if (unclosedCommentText) {
        normalizedSegments.push(unclosedCommentText);
    }
    const normalizedText = normalizedSegments.join(' ').trim();

    const shouldWarnUnclosedComment = Boolean(unclosedCommentText) && unclosedCommentText.length > 2;

    const errorMessage = shouldWarnUnclosedComment
        ? 'Close comment with */'
        : (hasReservedOrTag ? 'OR is reserved for search' : null);
    const reminderMessage = unclosedWrapperSuffix
        ? `Close scope with ${unclosedWrapperSuffix}`
        : '';

    return {
        isValid: errorMessage === null,
        errorMessage,
        reminderMessage,
        sanitizedText,
        normalizedText,
    };
}

export function normalizeTagBarInput(rawInput) {
    if (typeof rawInput !== 'string') {
        throw new Error('normalizeTagBarInput expects a string');
    }

    return analyzeTagBarInput(rawInput).normalizedText;
}

export function parseTagBarSuggestionContext(rawInput, cursorIndex) {
    if (typeof rawInput !== 'string') {
        throw new Error('parseTagBarSuggestionContext expects a string');
    }
    if (!Number.isInteger(cursorIndex)) {
        throw new Error('parseTagBarSuggestionContext expects cursorIndex integer');
    }
    if (cursorIndex < 0 || cursorIndex > rawInput.length) {
        throw new Error('parseTagBarSuggestionContext cursorIndex out of bounds');
    }

    const analysis = analyzeTagBarInput(rawInput);
    if (!analysis.isValid) {
        return null;
    }

    const { tokens, commentRanges } = scanTagBarTokensWithPositions(rawInput);
    for (const range of commentRanges) {
        if (cursorIndex >= range.start && cursorIndex < range.end) {
            return null;
        }
    }

    const atoms = [];
    for (const token of tokens) {
        let wrapperInfo = unwrapWrapperToken(token.text);
        if (wrapperInfo === null) {
            wrapperInfo = analyzeUnclosedWrapperTokenInfo(token.text);
        }
        if (wrapperInfo) {
            const inner = wrapperInfo.inner;
            let innerIndex = 0;
            while (innerIndex < inner.length) {
                while (innerIndex < inner.length && isWhitespace(inner[innerIndex])) {
                    innerIndex += 1;
                }
                if (innerIndex >= inner.length) {
                    break;
                }
                const start = innerIndex;
                while (innerIndex < inner.length && !isWhitespace(inner[innerIndex])) {
                    innerIndex += 1;
                }
                const text = inner.slice(start, innerIndex);
                if (text.length > 0) {
                    const absoluteStart = token.start + wrapperInfo.depth + start;
                    const absoluteEnd = token.start + wrapperInfo.depth + innerIndex;
                    atoms.push({ text, start: absoluteStart, end: absoluteEnd });
                }
            }
            continue;
        }
        if (token.text.length > 0) {
            atoms.push({ text: token.text, start: token.start, end: token.end });
        }
    }

    let currentAtom = null;
    for (const atom of atoms) {
        if (cursorIndex >= atom.start && cursorIndex <= atom.end) {
            currentAtom = atom;
            break;
        }
    }

    const explicitTags = [];
    for (const atom of atoms) {
        if (atom.text.length > 0) {
            explicitTags.push(atom.text);
        }
    }

    const anchors = [];
    for (const atom of atoms) {
        if (currentAtom && atom === currentAtom) {
            continue;
        }
        if (atom.text.length > 0) {
            anchors.push(atom.text);
        }
    }

    let prefix = '';
    let replaceStart = cursorIndex;
    let replaceEnd = cursorIndex;
    if (currentAtom) {
        prefix = rawInput.slice(currentAtom.start, cursorIndex);
        replaceStart = currentAtom.start;
        replaceEnd = cursorIndex;
    }

    return {
        anchors,
        explicitTags,
        prefix,
        replaceStart,
        replaceEnd
    };
}

export function findTagAtIndexInTagBar(rawInput, cursorIndex) {
    if (typeof rawInput !== 'string') {
        throw new Error('findTagAtIndexInTagBar expects a string');
    }
    if (!Number.isInteger(cursorIndex)) {
        throw new Error('findTagAtIndexInTagBar expects cursorIndex integer');
    }
    if (cursorIndex < 0 || cursorIndex > rawInput.length) {
        throw new Error('findTagAtIndexInTagBar cursorIndex out of bounds');
    }

    const analysis = analyzeTagBarInput(rawInput);
    if (!analysis.isValid) {
        return null;
    }

    const { tokens, commentRanges } = scanTagBarTokensWithPositions(rawInput);
    for (const range of commentRanges) {
        if (cursorIndex >= range.start && cursorIndex < range.end) {
            return null;
        }
    }

    const atoms = [];
    for (const token of tokens) {
        const wrapperInfo = unwrapWrapperToken(token.text);
        if (wrapperInfo) {
            const inner = wrapperInfo.inner;
            let innerIndex = 0;
            while (innerIndex < inner.length) {
                while (innerIndex < inner.length && isWhitespace(inner[innerIndex])) {
                    innerIndex += 1;
                }
                if (innerIndex >= inner.length) {
                    break;
                }
                const start = innerIndex;
                while (innerIndex < inner.length && !isWhitespace(inner[innerIndex])) {
                    innerIndex += 1;
                }
                const text = inner.slice(start, innerIndex);
                const enforced = enforceTagToken(text);
                if (enforced.length > 0) {
                    const absoluteStart = token.start + wrapperInfo.depth + start;
                    const absoluteEnd = token.start + wrapperInfo.depth + innerIndex;
                    atoms.push({ text: enforced, start: absoluteStart, end: absoluteEnd });
                }
            }
            continue;
        }

        const enforced = enforceTagToken(token.text);
        if (enforced.length > 0) {
            atoms.push({ text: enforced, start: token.start, end: token.end });
        }
    }

    for (const atom of atoms) {
        if (cursorIndex >= atom.start && cursorIndex <= atom.end) {
            return atom;
        }
    }

    return null;
}
