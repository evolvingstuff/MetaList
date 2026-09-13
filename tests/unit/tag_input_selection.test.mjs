import assert from 'node:assert/strict';
import test from 'node:test';
import { selectTagOnDoubleClick } from '../../app/static/js/modules/mode-manager/services/tag-input-selection-service.js';

class Input {
    constructor(value, start, end, kind) {
        this.value = value;
        this.selectionStart = start;
        this.selectionEnd = end;
        this.id = kind === 'search' ? 'search-input' : '';
        this.classList = { contains: name => kind === 'tags' && name === 'note-tag-bar-input' };
    }
    setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
    }
}

for (const kind of ['search', 'tags']) {
    for (const [value, start, end, expected] of [
        ['foo-bar next', 0, 3, 'foo-bar'],
        ['foo-bar next', 4, 7, 'foo-bar'],
        ['foo-bar next', 3, 4, 'foo-bar'],
        ['before @red after', 8, 11, '@red'],
        ['before @red after', 7, 8, '@red'],
        ['alpha_beta next', 6, 10, 'alpha_beta'],
        ['a/b.c next', 4, 5, 'a/b.c'],
    ]) {
        test(`${kind}: expands native selection ${start}:${end} in ${value}`, t => {
            globalThis.HTMLInputElement = Input;
            t.after(() => { delete globalThis.HTMLInputElement; });
            const input = new Input(value, start, end, kind);
            const event = { target:input, button:0, preventDefault() {} };
            selectTagOnDoubleClick(event);
            assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), expected);
            assert.equal(input.value, value);
            selectTagOnDoubleClick(event);
            assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), expected);
        });
    }
}

test('scoped tags select only the individual tag and assignments include their value', t => {
    globalThis.HTMLInputElement = Input;
    t.after(() => { delete globalThis.HTMLInputElement; });
    const input = new Input('{{foo-bar @red}} @size=2.0', 2, 5, 'tags');
    selectTagOnDoubleClick({target:input, button:0, preventDefault() {}});
    assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), 'foo-bar');
    input.setSelectionRange(22, 23);
    selectTagOnDoubleClick({target:input, button:0, preventDefault() {}});
    assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), '@size=2.0');
});

test('search modifiers stay with their tag', t => {
    globalThis.HTMLInputElement = Input;
    t.after(() => { delete globalThis.HTMLInputElement; });
    const input = new Input('-foo-bar +@red', 1, 4, 'search');
    selectTagOnDoubleClick({target:input, button:0, preventDefault() {}});
    assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), '-foo-bar');
});

test('non-tags retain native selection', t => {
    globalThis.HTMLInputElement = Input;
    t.after(() => { delete globalThis.HTMLInputElement; });
    for (const [value, start, end, kind] of [
        ['"foo-bar"', 1, 4, 'search'], ['foo OR bar', 4, 6, 'search'],
        ['/* foo-bar */', 3, 6, 'tags'], ['foo  bar', 3, 5, 'tags'],
        ['', 0, 0, 'tags'], ['foo-bar', 0, 3, 'other'],
    ]) {
        const input = new Input(value, start, end, kind);
        selectTagOnDoubleClick({target:input, button:0, preventDefault() { assert.fail('Non-tag selection must be unchanged'); }});
        assert.deepEqual([input.selectionStart, input.selectionEnd], [start, end]);
    }
});
