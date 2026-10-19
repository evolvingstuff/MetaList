import assert from 'node:assert/strict';
import test from 'node:test';

import {
    analyzeSearchQueryInput,
    enforceSearchQueryInputForEditing,
    normalizeSearchQueryInput,
    findOpenQuoteAtIndex,
    findSearchTagAtIndex,
    quotePastedSearchText,
} from '../../app/static/js/modules/mode-manager/services/search-syntax-service.js';

test('uppercase OR separates complete implicit-AND clauses', () => {
    const analysis = analyzeSearchQueryInput('A B C OR D E OR "some text"');

    assert.equal(analysis.isComplete, true);
    assert.equal(analysis.warningMessage, null);
    assert.equal(analysis.normalizedText, 'A B C OR D E OR "some text"');
    assert.equal(analysis.sanitizedText, 'A B C OR D E OR "some text"');
});

test('leading trailing and consecutive OR operators are incomplete', () => {
    for (const query of ['OR A', 'A OR', 'A OR OR B']) {
        const analysis = analyzeSearchQueryInput(query);
        assert.equal(analysis.isComplete, false, query);
        assert.match(analysis.warningMessage, /OR/);
    }
});

test('lowercase or and quoted OR remain searchable terms', () => {
    assert.equal(analyzeSearchQueryInput('or').isComplete, true);
    assert.equal(analyzeSearchQueryInput('"OR"').isComplete, true);
});

test('a tag token normalized to uppercase OR is rejected as reserved', () => {
    const analysis = analyzeSearchQueryInput('A OR:');

    assert.equal(analysis.isComplete, false);
    assert.match(analysis.warningMessage, /reserved/);
    assert.equal(analysis.sanitizedText, 'A');
});

test('OR operator is not exposed as a tag suggestion target', () => {
    assert.equal(findSearchTagAtIndex('A OR B', 3), null);
    assert.deepEqual(findSearchTagAtIndex('A OR B', 6), {
        tag: 'B',
        start: 5,
        end: 6,
        prefix: null,
    });
});

const SPACED_PREFIX_WARNING = 'In a search, + or - must be directly followed by the tag or quoted text, with no space (for example -tag)';

test('a space after a prefix is explained as you type and never searched with the opposite meaning', () => {
    for (const [query, sanitized] of [
        ['foo - bar', 'foo'],
        ['- tag', ''],
        ['foo + bar baz', 'foo baz'],
        ['foo - "bad phrase" baz', 'foo baz'],
    ]) {
        const analysis = analyzeSearchQueryInput(query);
        assert.equal(analysis.isComplete, false, query);
        assert.equal(analysis.warningMessage, SPACED_PREFIX_WARNING, query);
        // The term after the stray prefix is left out, so "- tag" never runs as "tag".
        assert.equal(analysis.sanitizedText, sanitized, query);
        // The typed text is kept as typed.
        assert.equal(analysis.normalizedText, query, query);
    }
});

test('a lone prefix at the end is still being typed: no warning yet', () => {
    const analysis = analyzeSearchQueryInput('foo -');
    assert.equal(analysis.isComplete, false);
    assert.equal(analysis.warningMessage, null);
    assert.equal(analysis.sanitizedText, 'foo');
});


test('a cursor inside a quoted phrase is found, open or closed, with either quote mark', () => {
    assert.equal(findOpenQuoteAtIndex('"', 1), '"');
    assert.equal(findOpenQuoteAtIndex('tag "youtube.com/', 17), '"');
    assert.equal(findOpenQuoteAtIndex('"abcdef"', 4), '"');
    assert.equal(findOpenQuoteAtIndex("-'abc", 5), "'");
    assert.equal(findOpenQuoteAtIndex('"say \\"hi', 9), '"');
});

test('a cursor outside quoted text is not inside a phrase', () => {
    assert.equal(findOpenQuoteAtIndex('', 0), '');
    assert.equal(findOpenQuoteAtIndex('tag ', 4), '');
    assert.equal(findOpenQuoteAtIndex('"done" ', 7), '');
    assert.equal(findOpenQuoteAtIndex('"done"', 0), '');
    assert.equal(findOpenQuoteAtIndex("it's", 4), '');
    assert.throws(() => findOpenQuoteAtIndex('abc', 4), /cursor index/);
});

test('text pasted into a phrase stays as copied, on one line, without ending the phrase', () => {
    assert.equal(quotePastedSearchText('This is a test', '"'), 'This is a test');
    assert.equal(quotePastedSearchText('https://www.youtube.com/watch?v=abc', '"'), 'https://www.youtube.com/watch?v=abc');
    assert.equal(quotePastedSearchText('line one\nline two', '"'), 'line one line two');
    assert.equal(quotePastedSearchText('say "hi"', '"'), 'say \\"hi\\"');
    assert.equal(quotePastedSearchText("it's", "'"), "it\\'s");
    assert.equal(quotePastedSearchText('a\\b', '"'), 'a\\\\b');
    const pasted = analyzeSearchQueryInput(`"${quotePastedSearchText('say "hi"', '"')}"`);
    assert.equal(pasted.isComplete, true);
    assert.equal(pasted.sanitizedText, '"say \\"hi\\""');
});

test('a tag in a search keeps one = as typed, as the tag bar does (@code=python)', () => {
    assert.equal(enforceSearchQueryInputForEditing('@code=python'), '@code=python');
    assert.equal(enforceSearchQueryInputForEditing('@code='), '@code=');
    assert.equal(enforceSearchQueryInputForEditing('-@code=python recipes'), '-@code=python recipes');
    assert.equal(normalizeSearchQueryInput('@size=2'), '@size=2');
    // One = only, and never as the tag's first character.
    assert.equal(enforceSearchQueryInputForEditing('@code==py'), '@code=py');
    assert.equal(enforceSearchQueryInputForEditing('a=b=c'), 'a=bc');
    assert.equal(enforceSearchQueryInputForEditing('=code'), 'code');
});
