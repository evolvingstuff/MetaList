import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_SEARCH_SUGGESTION_WINDOWS_VALUE,
    getSearchSuggestionWindowsValidationError,
    getSearchSuggestionWindowDays,
    parseSearchSuggestionWindowsValue,
    serializeSearchSuggestionWindows,
    receiveSearchSuggestionPreferences,
} from '../../app/static/js/modules/mode-manager/services/search-suggestion-windows-service.js';


test('search suggestion windows preserve configured order and slot count', (t) => {
    const receiveWindows = (windows) => receiveSearchSuggestionPreferences({ windows, showLabels: true, limitCredits: true });
    t.after(() => receiveWindows(DEFAULT_SEARCH_SUGGESTION_WINDOWS_VALUE));

    receiveWindows('[30,7,1]');
    assert.deepEqual(getSearchSuggestionWindowDays(), [30, 7, 1]);

    receiveWindows('[1,30]');
    assert.deepEqual(getSearchSuggestionWindowDays(), [1, 30]);

    receiveWindows('[]');
    assert.deepEqual(getSearchSuggestionWindowDays(), []);
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
