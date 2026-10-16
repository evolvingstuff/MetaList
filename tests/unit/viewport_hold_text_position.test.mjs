import assert from 'node:assert/strict';
import test from 'node:test';
import { findTextPosition } from '../../app/static/js/modules/mode-manager/services/viewport-hold-service.js';

function anchorAt(text, offset) {
    return {
        textOffset: offset,
        textLength: text.length,
        before: text.slice(Math.max(0, offset - 30), offset),
        after: text.slice(offset, offset + 30),
        affinity: 'backward',
        atRunEnd: false,
        // No run of its own unless a test gives one (see the short list item test).
        runText: '',
        runOffset: 0,
    };
}

// Position and exactness only (the line-boundary affinity has its own test).
function match(text, anchor) {
    const { position, exact } = findTextPosition(text, anchor);
    return { position, exact };
}

const editText = 'Alpha paragraph one. Beta paragraph two. Gamma paragraph three. Delta paragraph four.';

test('an unchanged text maps exactly to the same position', () => {
    const offset = editText.indexOf('Gamma');
    assert.deepEqual(match(editText, anchorAt(editText, offset)), { position: offset, exact: true });
});

test('text added or removed before the anchor shifts the position by the surrounding text', () => {
    const offset = editText.indexOf('Gamma');
    const viewText = 'Title. ' + editText.replace('{{x}}', '');
    assert.deepEqual(match(viewText, anchorAt(editText, offset)), { position: offset + 7, exact: true });
});

test('a space typed at the caret and dropped by rendering still matches exactly', () => {
    const typed = editText + ' ';
    const anchor = anchorAt(typed, typed.length);
    assert.deepEqual(match(editText, anchor), { position: editText.length, exact: true });
});

test('repeated text picks the occurrence nearest the old position', () => {
    const repeated = 'same words here. same words here. same words here.';
    const offset = repeated.lastIndexOf('same');
    assert.equal(findTextPosition(repeated, anchorAt(repeated, offset)).position, offset);
});

test('text that changed shape falls back to the same proportion, marked approximate', () => {
    const offset = Math.floor(editText.length / 2);
    const rendered = 'x'.repeat(editText.length * 2);
    assert.deepEqual(match(rendered, anchorAt(editText, offset)), { position: offset * 2, exact: false });
});

test('an empty note maps to its start without looping', () => {
    assert.deepEqual(match('', anchorAt('', 0)), { position: 0, exact: false });
});

test('findTextPosition matches a clicked list item although the source adds list markers on both sides', () => {
    // Rendered Markdown runs list items together; the source keeps "- " markers.
    const viewText = 'there is text below your caret as well as above it.A short list itemAnother list itemA final list itemThe last paragraph ends the note.';
    const sourceText = 'there is text below your caret as well as above it.- A short list item- Another list item- A final list itemThe last paragraph ends the note.';
    for (const item of ['A short list item', 'Another list item']) {
        const clicked = viewText.indexOf(item);
        assert.deepEqual(match(sourceText, anchorAt(viewText, clicked)), { position: sourceText.indexOf(item), exact: true }, item);
    }
});

test('findTextPosition finds a short list item by its own text when too little surrounds it', () => {
    // "item two" leaves under eight matching characters either side once the
    // source adds "- ": the clicked run, whole, still finds its line.
    const viewText = 'HeadingA paragraph of Markdown textitem oneitem two';
    const sourceText = '# HeadingA paragraph of Markdown text- item one- item two';
    const clicked = viewText.indexOf('item two') + 'item'.length;
    const anchor = { ...anchorAt(viewText, clicked), runText: 'item two', runOffset: 'item'.length };
    assert.deepEqual(match(sourceText, anchor), { position: sourceText.indexOf('item two') + 'item'.length, exact: true });
});

test('findTextPosition keeps the side of a line boundary', () => {
    // Line breaks add no text: "end of line one" and "start of line two" are one position.
    const text = 'First line of the note.Second line of the note.';
    const boundary = text.indexOf('Second');
    // Clicked at the start of the second line: it stays on the second line.
    assert.equal(findTextPosition(text, { ...anchorAt(text, boundary), affinity: 'forward' }).affinity, 'forward');
    // Caret left at the end of the first line: it stays at that line's end.
    assert.equal(findTextPosition(text, anchorAt(text, boundary)).affinity, 'backward');
    // Matched only by the text after it: that text's line.
    const changedBefore = { ...anchorAt(text, boundary), before: '- something else entirely here' };
    assert.equal(findTextPosition(text, changedBefore).affinity, 'forward');
});

test('findTextPosition keeps a point past a line end on that line when the source adds markers', () => {
    // Rendered Markdown runs list items together: the end of one item is the
    // start of the next. The source's "- " markers break the exact match, and
    // the click was past the first item's end (the end of its text run).
    const viewText = 'A paragraph.A short list itemAnother list itemThe last paragraph.';
    const sourceText = 'A paragraph.- A short list item- Another list itemThe last paragraph.';
    const end = viewText.indexOf('Another');
    const pastEnd = { ...anchorAt(viewText, end), atRunEnd: true };
    assert.deepEqual(findTextPosition(sourceText, pastEnd),
        { position: sourceText.indexOf('- Another'), exact: true, affinity: 'backward' });
    // At the start of the next item instead: that item.
    const atStart = { ...anchorAt(viewText, end), affinity: 'forward' };
    assert.equal(findTextPosition(sourceText, atStart).position, sourceText.indexOf('Another'));
});
