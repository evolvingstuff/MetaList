import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// A tag bar that is closing (its note no longer edited) shrinks away over
// ~200 ms. It must not keep the keyboard: typing into it would reach a tag bar
// whose note is not being edited (the "Tag bar input fired while not editing"
// fatal, seen once with quick taps).
const source = readFileSync(new URL('../../app/static/js/modules/mode-manager/services/tag-bar-service.js', import.meta.url), 'utf8');
const releaseSource = source.slice(source.indexOf('function releaseClosingTagBarInput('), source.indexOf('function removeTagBarElement('));

function harness({ focused }) {
    const document = { activeElement: null };
    const input = {
        disabled: false,
        blur() { if (document.activeElement === input) document.activeElement = null; },
    };
    if (focused) document.activeElement = input;
    const tagBar = { querySelector: (selector) => (selector === '.note-tag-bar-input' ? input : null) };
    const release = new Function('document', 'TAG_BAR_INPUT_CLASS', `${releaseSource}\nreturn releaseClosingTagBarInput;`)(document, 'note-tag-bar-input');
    return { document, input, tagBar, release };
}

test('a closing tag bar gives up the keyboard and cannot be typed into', () => {
    const h = harness({ focused: true });
    h.release(h.tagBar);
    assert.equal(h.document.activeElement, null);
    assert.equal(h.input.disabled, true);
});

test('a closing tag bar without the focus is still made untypeable', () => {
    const h = harness({ focused: false });
    h.release(h.tagBar);
    assert.equal(h.input.disabled, true);
});

test('the tag bar is released when it starts closing, and re-enabled when reused', () => {
    const removeSource = source.slice(source.indexOf('function removeTagBarElement('), source.indexOf('function ensureTagBarElement('));
    assert.match(removeSource, /^function removeTagBarElement\(tagBar\) \{[\s\S]*?releaseClosingTagBarInput\(tagBar\);[\s\S]*?if \(!areAnimatedTransitionsEnabled\(\)\)/);
    const syncSource = source.slice(source.indexOf('export function syncTagBar('), source.indexOf('export function clearTagBar('));
    assert.match(syncSource, /const input = getTagBarInput\(tagBar\);\s*\n\s*\/\/[^\n]*\n\s*if \(input && input\.disabled\) input\.disabled = false;/);
});
