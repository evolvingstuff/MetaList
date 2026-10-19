const TAG_CONTAINS_DISALLOWED = new Set([
    ':',
    '"',
    '\\',
    '>',
    '<',
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
// A tag's name and value: @code=python (app/services/search_index.py TAG_VALUE_SEPARATOR).
const TAG_VALUE_SEPARATOR = '=';
// Same wording as the server's rejection (app/services/search_query.py).
const SPACED_PREFIX_WARNING = 'In a search, + or - must be directly followed by the tag or quoted text, with no space (for example -tag)';

const QUOTE_CHARS = new Set(['"', "'" ]);
const OR_OPERATOR = 'OR';
// A backslash and the character it escapes.
const ESCAPE_SEQUENCE_LENGTH = 2;
// Printable ASCII runs from the space through the tilde.
const FIRST_PRINTABLE_ASCII_CODE = ' '.charCodeAt(0);
const LAST_PRINTABLE_ASCII_CODE = '~'.charCodeAt(0);

function isAsciiPrintable(char) {
    if (typeof char !== 'string' || char.length === 0) {
        return false;
    }
    const code = char.charCodeAt(0);
    return code >= FIRST_PRINTABLE_ASCII_CODE && code <= LAST_PRINTABLE_ASCII_CODE;
}

function isWhitespace(char) {
    return typeof char === 'string' && char.length === 1 && /\s/.test(char);
}

function enforceTagToken(rawToken) {
    if (typeof rawToken !== 'string') {
        throw new Error('enforceTagToken expects a string');
    }

    let token = rawToken;
    while (token.length > 0 && TOKEN_START_DISALLOWED.has(token[0])) {
        token = token.slice(1);
    }

    // One = joins a tag's name and value (@code=python), as in the tag bar; it is
    // never the first character, and any further = is dropped.
    let output = '';
    let hasValueSeparator = false;
    for (const char of token) {
        if (!isAsciiPrintable(char)) {
            continue;
        }
        if (char === TAG_VALUE_SEPARATOR) {
            if (output !== '' && !hasValueSeparator) {
                output += char;
                hasValueSeparator = true;
            }
            continue;
        }
        if (TAG_CONTAINS_DISALLOWED.has(char)) {
            continue;
        }
        output += char;
    }

    return output;
}

function readQuotedInner(rawInput, startIndex, quoteChar) {
    if (typeof rawInput !== 'string') {
        throw new Error('readQuotedInner expects rawInput string');
    }
    if (!Number.isInteger(startIndex) || startIndex < 0) {
        throw new Error('readQuotedInner expects startIndex integer');
    }
    if (quoteChar !== '"' && quoteChar !== "'") {
        throw new Error('readQuotedInner expects quoteChar to be " or \'');
    }

    let index = startIndex;
    let normalizedInner = '';
    let closed = false;

    while (index < rawInput.length) {
        const char = rawInput[index];

        if (char === quoteChar) {
            closed = true;
            index += 1;
            break;
        }

        if (char === '\\') {
            if (index + 1 < rawInput.length) {
                const nextChar = rawInput[index + 1];
                if (nextChar === quoteChar || nextChar === '\\') {
                    normalizedInner += `\\${nextChar}`;
                    index += ESCAPE_SEQUENCE_LENGTH;
                    continue;
                }
            }

            if (isAsciiPrintable(char)) {
                normalizedInner += char;
            }
            index += 1;
            continue;
        }

        if (isAsciiPrintable(char)) {
            normalizedInner += char;
        }
        index += 1;
    }

    return { normalizedInner, closed, nextIndex: index };
}

export function analyzeSearchQueryInput(rawInput) {
    if (typeof rawInput !== 'string') {
        throw new Error('analyzeSearchQueryInput expects a string');
    }

    const normalizedTerms = [];
    const sanitizedTerms = [];

    const hasTrailingWhitespace = rawInput.length > 0 && isWhitespace(rawInput[rawInput.length - 1]);

    let isComplete = true;
    let warningMessage = null;
    let currentClauseTermCount = 0;
    let endsWithOrOperator = false;
    // A prefix followed by a space ("- tag"): invalid. The term after it is
    // explained and left out of the searched text, so it never runs with the
    // opposite meaning ("tag"). A lone prefix at the end is still being typed.
    let spacedPrefixPending = false;

    let index = 0;
    while (index < rawInput.length) {
        while (index < rawInput.length && isWhitespace(rawInput[index])) {
            index += 1;
        }
        if (index >= rawInput.length) {
            break;
        }

        let prefix = '';
        const firstChar = rawInput[index];
        if (firstChar === '+' || firstChar === '-') {
            prefix = firstChar;
            index += 1;
            if (index >= rawInput.length || isWhitespace(rawInput[index])) {
                normalizedTerms.push(prefix);
                isComplete = false;
                spacedPrefixPending = true;
                continue;
            }
        }
        // This term follows a prefix and a space: keep it as typed, explain,
        // and do not search for it.
        if (spacedPrefixPending) {
            spacedPrefixPending = false;
            if (!warningMessage) {
                warningMessage = SPACED_PREFIX_WARNING;
            }
            const termStart = index;
            const isQuoted = QUOTE_CHARS.has(rawInput[index]);
            if (isQuoted) {
                const quoteChar = rawInput[index];
                const { nextIndex } = readQuotedInner(rawInput, index + 1, quoteChar);
                index = nextIndex;
            } else {
                while (index < rawInput.length && !isWhitespace(rawInput[index])) {
                    index += 1;
                }
            }
            normalizedTerms.push(rawInput.slice(termStart, index));
            continue;
        }

        const nextChar = rawInput[index];
        const isQuoteStart = QUOTE_CHARS.has(nextChar);
        if (isQuoteStart && prefix === '+') {
            // `+` is a tag-term modifier only. Drop it for quoted text.
            prefix = '';
        }

        if (isQuoteStart && (prefix === '' || prefix === '-')) {
            const quoteChar = nextChar;
            index += 1;
            const { normalizedInner, closed, nextIndex } = readQuotedInner(rawInput, index, quoteChar);
            index = nextIndex;

            const normalized = `${prefix}${quoteChar}${normalizedInner}`;

            if (!closed) {
                normalizedTerms.push(normalized);
                isComplete = false;
                if (!warningMessage && normalizedInner.length > 0) {
                    warningMessage = `Close quote with ${quoteChar}`;
                }
                continue;
            }

            const closedToken = `${normalized}${quoteChar}`;
            normalizedTerms.push(closedToken);

            if (normalizedInner.length === 0) {
                isComplete = false;
                if (!warningMessage) {
                    warningMessage = 'Enter text inside quotes';
                }
                continue;
            }

            sanitizedTerms.push(closedToken);
            currentClauseTermCount += 1;
            endsWithOrOperator = false;
            continue;
        }

        let rawToken = '';
        while (index < rawInput.length && !isWhitespace(rawInput[index])) {
            rawToken += rawInput[index];
            index += 1;
        }

        if (rawToken === OR_OPERATOR) {
            normalizedTerms.push(`${prefix}${OR_OPERATOR}`);
            if (prefix !== '') {
                isComplete = false;
                if (!warningMessage) {
                    warningMessage = 'OR is reserved and cannot be used as a tag';
                }
                endsWithOrOperator = false;
                continue;
            }
            if (currentClauseTermCount === 0) {
                isComplete = false;
                if (!warningMessage) {
                    warningMessage = 'OR requires a term before it';
                }
                endsWithOrOperator = true;
                continue;
            }
            sanitizedTerms.push(OR_OPERATOR);
            currentClauseTermCount = 0;
            endsWithOrOperator = true;
            continue;
        }

        const enforcedToken = enforceTagToken(rawToken);
        if (enforcedToken.length === 0) {
            if (prefix) {
                normalizedTerms.push(prefix);
                isComplete = false;
            }
            continue;
        }
        if (enforcedToken === OR_OPERATOR) {
            normalizedTerms.push(OR_OPERATOR);
            isComplete = false;
            if (!warningMessage) {
                warningMessage = 'OR is reserved and cannot be used as a tag';
            }
            endsWithOrOperator = false;
            continue;
        }

        const normalizedTag = `${prefix}${enforcedToken}`;
        normalizedTerms.push(normalizedTag);
        sanitizedTerms.push(normalizedTag);
        currentClauseTermCount += 1;
        endsWithOrOperator = false;
    }

    if (endsWithOrOperator) {
        isComplete = false;
        if (!warningMessage) {
            warningMessage = 'OR requires a term after it';
        }
        while (sanitizedTerms[sanitizedTerms.length - 1] === OR_OPERATOR) {
            sanitizedTerms.pop();
        }
    }

    const normalizedText = normalizedTerms.join(' ').trim();
    const sanitizedText = sanitizedTerms.join(' ').trim();

    const enforcedText = hasTrailingWhitespace && normalizedText.length > 0
        ? `${normalizedText} `
        : normalizedText;

    return {
        normalizedText,
        enforcedText,
        sanitizedText,
        isComplete,
        warningMessage,
    };
}

/**
 * The quote mark of the quoted phrase the cursor is inside (" or '), or '' when
 * the cursor is outside quoted text. Inside a phrase a paste is text as copied,
 * not dictation (docs/ui/dictation-paste.md).
 */
export function findOpenQuoteAtIndex(rawInput, cursorIndex) {
    if (typeof rawInput !== 'string') {
        throw new Error('findOpenQuoteAtIndex expects a string');
    }
    if (!Number.isInteger(cursorIndex) || cursorIndex < 0 || cursorIndex > rawInput.length) {
        throw new Error('findOpenQuoteAtIndex expects a cursor index within the input');
    }
    const before = rawInput.slice(0, cursorIndex);
    let index = 0;
    while (index < before.length) {
        if (isWhitespace(before[index])) {
            index += 1;
            continue;
        }
        if (before[index] === '+' || before[index] === '-') {
            index += 1;
        }
        if (index < before.length && QUOTE_CHARS.has(before[index])) {
            const quoteChar = before[index];
            const { closed, nextIndex } = readQuotedInner(before, index + 1, quoteChar);
            if (!closed) {
                return quoteChar;
            }
            index = nextIndex;
            continue;
        }
        while (index < before.length && !isWhitespace(before[index])) {
            index += 1;
        }
    }
    return '';
}

/** Pasted text for inside a quoted phrase: one line, its quote marks and backslashes escaped. */
export function quotePastedSearchText(pastedText, quoteChar) {
    if (typeof pastedText !== 'string') {
        throw new Error('quotePastedSearchText expects the pasted text');
    }
    if (!QUOTE_CHARS.has(quoteChar)) {
        throw new Error('quotePastedSearchText expects " or \'');
    }
    return pastedText
        .replace(/[\r\n]+/g, ' ')
        .replaceAll('\\', '\\\\')
        .replaceAll(quoteChar, `\\${quoteChar}`);
}

export function enforceSearchQueryInputForEditing(rawInput) {
    return analyzeSearchQueryInput(rawInput).enforcedText;
}

export function normalizeSearchQueryInput(rawInput) {
    return analyzeSearchQueryInput(rawInput).normalizedText;
}

export function findSearchTagAtIndex(rawInput, cursorIndex) {
    if (typeof rawInput !== 'string') {
        throw new Error('findSearchTagAtIndex expects a string');
    }
    if (!Number.isInteger(cursorIndex)) {
        throw new Error('findSearchTagAtIndex expects cursorIndex integer');
    }
    if (cursorIndex < 0 || cursorIndex > rawInput.length) {
        throw new Error('findSearchTagAtIndex cursorIndex out of bounds');
    }

    let index = 0;
    while (index < rawInput.length) {
        while (index < rawInput.length && isWhitespace(rawInput[index])) {
            index += 1;
        }
        if (index >= rawInput.length) {
            break;
        }

        const tokenStart = index;
        let prefix = null;
        const firstChar = rawInput[index];
        if (firstChar === '+' || firstChar === '-') {
            prefix = firstChar;
            index += 1;
            if (index >= rawInput.length || isWhitespace(rawInput[index])) {
                continue;
            }
        }

        const nextChar = rawInput[index];
        const isQuoteStart = QUOTE_CHARS.has(nextChar);
        if (isQuoteStart) {
            if (prefix === '+') {
                prefix = null;
            }
            if (prefix === null || prefix === '-') {
                const quoteChar = nextChar;
                index += 1;
                const { nextIndex } = readQuotedInner(rawInput, index, quoteChar);
                index = nextIndex;
                continue;
            }
        }

        while (index < rawInput.length && !isWhitespace(rawInput[index])) {
            index += 1;
        }
        const tokenEnd = index;
        if (cursorIndex >= tokenStart && cursorIndex <= tokenEnd) {
            let tokenText = rawInput.slice(tokenStart, tokenEnd);
            if (prefix) {
                tokenText = tokenText.slice(1);
            }
            const enforced = enforceTagToken(tokenText);
            if (enforced === OR_OPERATOR) {
                return null;
            }
            if (enforced.length > 0) {
                return {
                    tag: enforced,
                    start: tokenStart,
                    end: tokenEnd,
                    prefix,
                };
            }
            return null;
        }
    }

    return null;
}
