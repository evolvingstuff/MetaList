// Where a search's quoted phrases occur in a note's visible text: the same rule the
// search matches by (app/services/search_text.py text_term_matches). A phrase matches
// anywhere, in any case, also inside words; a space at its edge limits the match to a
// word edge on that side ("fat " not in "father").

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

// Lowercase, one character for one, so a position in the result is the same position
// in the text (a letter whose lowercase is longer, such as İ, stays as it is).
function lowercaseInPlace(text) {
    let lowered = '';
    for (const character of text) {
        const lower = character.toLowerCase();
        if (lower.length === character.length) {
            lowered += lower;
        } else {
            lowered += character;
        }
    }
    return lowered;
}

function isWordEdge(text, index, isRequired) {
    if (!isRequired) {
        return true;
    }
    if (index < 0 || index >= text.length) {
        return true;
    }
    return !WORD_CHARACTER.test(text[index]);
}

// [start, end) of every occurrence of each phrase in text, overlapping ones included,
// in text order.
export function findPhraseMatches(text, phrases) {
    if (typeof text !== 'string') {
        throw new Error('findPhraseMatches requires text');
    }
    if (!Array.isArray(phrases)) {
        throw new Error('findPhraseMatches requires an array of phrases');
    }
    const loweredText = lowercaseInPlace(text);
    const matches = [];
    for (const phrase of phrases) {
        if (typeof phrase !== 'string') {
            throw new Error('A search highlight phrase must be a string');
        }
        const core = lowercaseInPlace(phrase.trim());
        if (core === '') {
            throw new Error('A search highlight phrase must not be blank');
        }
        const wordStarts = phrase.startsWith(' ');
        const wordEnds = phrase.endsWith(' ');
        let start = loweredText.indexOf(core);
        while (start !== -1) {
            const end = start + core.length;
            if (isWordEdge(loweredText, start - 1, wordStarts) && isWordEdge(loweredText, end, wordEnds)) {
                matches.push([start, end]);
            }
            start = loweredText.indexOf(core, start + 1);
        }
    }
    return matches.sort((first, second) => {
        if (first[0] !== second[0]) {
            return first[0] - second[0];
        }
        return first[1] - second[1];
    });
}
