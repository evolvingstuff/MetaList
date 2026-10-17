export const MAX_SELECTED_TEXT_TAG_CHARACTERS = 25;

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
// A default tag keeps only printable ASCII: space (0x20) through tilde (0x7e).
const FIRST_PRINTABLE_ASCII_CODE_POINT = ' '.codePointAt(0);
const LAST_PRINTABLE_ASCII_CODE_POINT = '~'.codePointAt(0);

function buildDefaultTagCandidate(normalizedSelectedText) {
    const spacesJoined = normalizedSelectedText.replace(/\s+/g, '-');
    let candidate = '';
    for (const char of spacesJoined) {
        const codePoint = char.codePointAt(0);
        if (!Number.isInteger(codePoint)) {
            throw new Error('Selected-text tag character missing code point');
        }
        if (codePoint < FIRST_PRINTABLE_ASCII_CODE_POINT || codePoint > LAST_PRINTABLE_ASCII_CODE_POINT) {
            continue;
        }
        if (TAG_CONTAINS_DISALLOWED.has(char)) {
            continue;
        }
        candidate += char;
    }
    while (candidate.length > 0 && TOKEN_START_DISALLOWED.has(candidate[0])) {
        candidate = candidate.slice(1);
    }
    return candidate;
}

export function normalizeSelectedTextForTagAction(selectedText) {
    if (typeof selectedText !== 'string') {
        throw new Error('normalizeSelectedTextForTagAction expects selectedText string');
    }
    if (selectedText.length === 0 || selectedText.length > MAX_SELECTED_TEXT_TAG_CHARACTERS) {
        return null;
    }

    const normalizedSelectedText = selectedText.replace(/\s+/g, ' ').trim();
    if (normalizedSelectedText.length === 0) {
        return null;
    }
    const candidate = buildDefaultTagCandidate(normalizedSelectedText);
    if (candidate.length === 0 || candidate === 'OR') {
        return null;
    }
    return normalizedSelectedText;
}
