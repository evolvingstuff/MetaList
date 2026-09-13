import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApplicationState } from '../../app/static/js/modules/application-state.js';

const source = readFileSync(new URL('../../app/static/js/modules/mode-manager/events/keyboard-events.js', import.meta.url), 'utf8');
const stateDeclaration = source.slice(source.indexOf('const moduleState ='), source.indexOf('function isTagBarNoteShortcut('));
const shortcut = source.slice(source.indexOf('function handleToggleTagBarFocusShortcut('), source.indexOf('function revealCaretForCurrentNote('));

function harness() {
    const document = { activeElement: null };
    const context = { isEditing: true, currentNoteId: 'first' };
    const restored = [];
    class TextNode {}
    class Range {
        constructor(node) {
            this.startContainer = node;
            this.endContainer = node;
            this.commonAncestorContainer = node;
        }
        cloneRange() { return new Range(this.startContainer); }
    }
    const notes = new Map(['first', 'second'].map(id => {
        const node = new TextNode();
        const content = {
            classList: { contains: () => false },
            contains: candidate => candidate === node && !content.replaced,
            focus: () => { document.activeElement = content; },
        };
        const input = {
            value: 'tag', classList: { contains: name => name === 'note-tag-bar-input' },
            focus: () => { document.activeElement = input; }, setSelectionRange() {},
        };
        return [id, { id, node, content, input, querySelector: () => input }];
    }));
    let range;
    const selection = {
        rangeCount: 1, anchorNode: null,
        getRangeAt: () => range,
        removeAllRanges() {},
        addRange: saved => { restored.push(['range', saved.startContainer]); },
    };
    const dependencies = {
        ApplicationState, document, ModeContext: context,
        window: { getSelection: () => selection },
        DOMUtils: {
            getNoteById: id => notes.get(id), getNoteContent: note => note.content,
            getCursorOffset: () => 7,
            focusNote: (note, offset) => restored.push(['offset', note.id, offset]),
            focusNoteEdge: (note, edge) => restored.push(['edge', note.id, edge]),
        },
        sanitizeTags: value => value, setTagBarValue() {}, syncTagBar() {}, normalizeTagBarForNewTag() {},
    };
    const handlers = new Function(...Object.keys(dependencies), `${stateDeclaration}\n${shortcut}\nreturn {toggle: handleToggleTagBarFocusShortcut, state: moduleState};`)(...Object.values(dependencies));
    function select(id) {
        context.currentNoteId = id;
        const note = notes.get(id);
        note.content.focus();
        range = new Range(note.node);
        selection.anchorNode = note.node;
        selection.rangeCount = 1;
    }
    select('first');
    return {
        ...handlers, notes, document, context, selection, restored, select,
        press: () => handlers.toggle({ preventDefault() {}, stopPropagation() {} }),
    };
}

test('first and repeated editor/tag-bar round trips restore the selection without redundant writes', () => {
    const h = harness();
    for (let count = 0; count < 3; count += 1) {
        h.press();
        assert.equal(h.document.activeElement, h.notes.get('first').input);
        h.press();
        assert.equal(h.document.activeElement, h.notes.get('first').content);
        assert.deepEqual(h.restored.at(-1), ['range', h.notes.get('first').node]);
    }
    assert.equal(h.state.savedEditingSelection, null);
    assert.throws(() => { h.state.savedEditingSelection = null; }, /Redundant/);
    h.notes.get('first').input.focus();
    h.press();
    assert.deepEqual(h.restored.at(-1), ['edge', 'first', 'end']);
});

test('replaced editor nodes restore the saved cursor offset', () => {
    const h = harness();
    h.press();
    h.notes.get('first').content.replaced = true;
    h.press();
    assert.deepEqual(h.restored, [['offset', 'first', 7]]);
});

test('a fresh transfer without a selection discards an unconsumed old range', () => {
    const h = harness();
    h.press();
    h.notes.get('first').content.focus(); // Click back instead of using Tab.
    h.selection.rangeCount = 0;
    h.press();
    h.press();
    assert.deepEqual(h.restored, [['edge', 'first', 'end']]);
});

test('a selection from another note is never restored into the active note', () => {
    const h = harness();
    h.press();
    h.context.currentNoteId = 'second';
    h.notes.get('second').input.focus();
    h.press();
    assert.deepEqual(h.restored, [['edge', 'second', 'end']]);
    h.select('second');
    h.press();
    h.press();
    assert.deepEqual(h.restored.at(-1), ['range', h.notes.get('second').node]);
});

test('a detached range without an editor anchor restores the end of content', () => {
    const h = harness();
    h.selection.anchorNode = null;
    h.press();
    h.notes.get('first').content.replaced = true;
    h.press();
    assert.deepEqual(h.restored, [['edge', 'first', 'end']]);
});
