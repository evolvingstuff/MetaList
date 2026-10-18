import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml } from '../../app/static/js/modules/html-escape.js';


test('escapes the five characters that matter in text and quoted attributes', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>R&D</a>`),
        '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;R&amp;D&lt;/a&gt;');
});

test('escapes an ampersand once, so escaped text is not escaped again by accident', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('leaves other text as it is', () => {
    assert.equal(escapeHtml('café 🔔 tag-name'), 'café 🔔 tag-name');
    assert.equal(escapeHtml(''), '');
});

test('a value that is not a string is a bug, not something to show as nothing', () => {
    for (const value of [null, undefined, 3, {}]) {
        assert.throws(() => escapeHtml(value), TypeError);
    }
});
