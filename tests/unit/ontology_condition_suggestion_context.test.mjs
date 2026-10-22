// A condition field suggests tags only where a tag can be: where a new word could start,
// or in a tag-like word being typed; never inside or right after "quoted text" or a
// /regex/ (2026-10-22: right after /reg(ex)?/ it asked for tags starting with "?/").
import assert from 'node:assert/strict';
import test from 'node:test';

// The modal reads the tab's session identity when it loads.
const sessionValues = new Map();
globalThis.sessionStorage = {
    getItem(key) { return sessionValues.has(key) ? sessionValues.get(key) : null; },
    setItem(key, value) { sessionValues.set(key, String(value)); },
};
const { parseDialogSuggestionContext } = await import('../../app/static/js/modules/modals/ontology-modal.js');

const PASTED = 'tag-one new-tag "some text" /reg(ex)?/';

function queryAt(text, caret) {
    const context = parseDialogSuggestionContext(text, caret);
    if (context === null) return null;
    return context.partialPrefix;
}

test('a condition suggests tags where a tag can be, and nowhere else', () => {
    const cases = [
        [0, ''], [3, 'tag'], [7, 'tag-one'], [8, ''], [12, 'new-'], [16, ''],
        [20, null], [27, null], [28, ''], [31, null], [33, null], [36, null], [PASTED.length, null],
    ];
    for (const [caret, expected] of cases) {
        assert.equal(queryAt(PASTED, caret), expected, `caret after ${JSON.stringify(PASTED.slice(0, caret))}`);
    }
});

test('a grouped condition suggests after its opening parenthesis', () => {
    assert.equal(queryAt('(tag-one ', '(tag-one '.length), '');
    assert.equal(queryAt('(tag-one new', '(tag-one new'.length), 'new');
});

test('a word that starts as a quote stays a quote after it closes', () => {
    assert.equal(queryAt('"x"y', '"x"y'.length), null);
});
