import assert from 'node:assert/strict';
import test from 'node:test';

import { findPhraseMatches } from '../../app/static/js/modules/mode-manager/services/search-highlight-matching.js';

// The highlighted spans are exactly what the search matches (app/services/search_text.py
// text_term_matches): anywhere, in any case, also inside words; an edge space limits a
// match to a word edge on that side.

test('a phrase is found everywhere, in any case, also inside words', () => {
    assert.deepEqual(findPhraseMatches('Fat cats and the father', ['fat']), [[0, 3], [17, 20]]);
});

test('an edge space limits the match to a word edge on that side', () => {
    const text = 'fat father; fat. defat';
    assert.deepEqual(findPhraseMatches(text, ['fat ']), [[0, 3], [12, 15], [19, 22]]);
    assert.deepEqual(findPhraseMatches(text, [' fat']), [[0, 3], [4, 7], [12, 15]]);
    assert.deepEqual(findPhraseMatches(text, [' fat ']), [[0, 3], [12, 15]]);
});

test('a phrase with inner spaces matches across them', () => {
    assert.deepEqual(findPhraseMatches('a fat cat sat', ['fat cat']), [[2, 9]]);
});

test('every phrase is found, overlapping matches included', () => {
    assert.deepEqual(findPhraseMatches('banana', ['ana']), [[1, 4], [3, 6]]);
    assert.deepEqual(findPhraseMatches('fat cat', ['cat', 'fat']), [[0, 3], [4, 7]]);
});

test('no phrase, or no occurrence, finds nothing', () => {
    assert.deepEqual(findPhraseMatches('fat cat', []), []);
    assert.deepEqual(findPhraseMatches('fat cat', ['dog']), []);
    assert.deepEqual(findPhraseMatches('', ['fat']), []);
});

test('letters and digits of any script are word characters', () => {
    assert.deepEqual(findPhraseMatches('été2 été', ['été ']), [[5, 8]]);
});

test('a blank phrase is a bug, not a match', () => {
    assert.throws(() => findPhraseMatches('fat', ['  ']), /blank/);
    assert.throws(() => findPhraseMatches('fat', 'fat'), /array/);
});
