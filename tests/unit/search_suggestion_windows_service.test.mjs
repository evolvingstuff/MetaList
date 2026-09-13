import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_SEARCH_SUGGESTION_WINDOWS_VALUE,
    getSearchSuggestionWindowsValidationError,
    getSearchSuggestionWindowDays,
    getLimitNoteCreditsPerSearchContext,
    getShowSearchSuggestionWindowLabels,
    parseSearchSuggestionWindowsValue,
    serializeSearchSuggestionWindows,
    setSearchSuggestionWindowsValue,
    setLimitNoteCreditsPerSearchContextValue,
    setShowSearchSuggestionWindowLabelsValue,
} from '../../app/static/js/modules/mode-manager/services/search-suggestion-windows-service.js';


test('search suggestion windows preserve configured order and slot count', (t) => {
    t.after(() => setSearchSuggestionWindowsValue(DEFAULT_SEARCH_SUGGESTION_WINDOWS_VALUE));

    setSearchSuggestionWindowsValue('[30,7,1]');
    assert.deepEqual(getSearchSuggestionWindowDays(), [30, 7, 1]);

    setSearchSuggestionWindowsValue('[1,30]');
    assert.deepEqual(getSearchSuggestionWindowDays(), [1, 30]);

    setSearchSuggestionWindowsValue('[]');
    assert.deepEqual(getSearchSuggestionWindowDays(), []);
});


test('per-context note credit limiting is enabled by default and parses persisted booleans', (t) => {
    t.after(() => assert.throws(() => setLimitNoteCreditsPerSearchContextValue('true'), /Redundant/));

    assert.equal(getLimitNoteCreditsPerSearchContext(), true);
    setLimitNoteCreditsPerSearchContextValue('false');
    assert.equal(getLimitNoteCreditsPerSearchContext(), false);
    setLimitNoteCreditsPerSearchContextValue('true');
    assert.equal(getLimitNoteCreditsPerSearchContext(), true);
    assert.throws(
        () => setLimitNoteCreditsPerSearchContextValue('yes'),
        /must be true or false/,
    );
});


test('search suggestion windows validate range, duplicates, and canonical persistence', () => {
    assert.equal(serializeSearchSuggestionWindows([1, 7, 365]), '[1,7,365]');
    assert.deepEqual(parseSearchSuggestionWindowsValue('[365,1]'), [365, 1]);
    assert.equal(getSearchSuggestionWindowsValidationError([1, 7, 30]), '');
    assert.match(getSearchSuggestionWindowsValidationError([0]), /between 1 and 365/);
    assert.match(getSearchSuggestionWindowsValidationError([7, 7]), /duplicates/);
    assert.throws(() => parseSearchSuggestionWindowsValue('[0]'), /between 1 and 365/);
    assert.throws(() => parseSearchSuggestionWindowsValue('[366]'), /between 1 and 365/);
    assert.throws(() => parseSearchSuggestionWindowsValue('[7,7]'), /duplicates/);
});


test('search suggestion window labels are enabled by default and parse persisted booleans', (t) => {
    t.after(() => assert.throws(() => setShowSearchSuggestionWindowLabelsValue('true'), /Redundant/));

    assert.equal(getShowSearchSuggestionWindowLabels(), true);
    setShowSearchSuggestionWindowLabelsValue('false');
    assert.equal(getShowSearchSuggestionWindowLabels(), false);
    setShowSearchSuggestionWindowLabelsValue('true');
    assert.equal(getShowSearchSuggestionWindowLabels(), true);
    assert.throws(
        () => setShowSearchSuggestionWindowLabelsValue('yes'),
        /must be true or false/,
    );
});
