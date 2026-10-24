import assert from 'node:assert/strict';
import test from 'node:test';

import { checkFormattedPaste } from '../../app/static/js/modules/mode-manager/services/formatted-paste-format-service.js';

function offered({ visibleText, plainText }) {
    const offer = checkFormattedPaste({ visibleText, plainText });
    if (offer === null) {
        return null;
    }
    return { kind: offer.kind, tags: offer.options.map((option) => option.tag), text: offer.text };
}

// A Copilot answer: code spans came rendered, the headings stayed Markdown.
const HALF_RENDERED = '## Plan\n\nRun npm test first.\n\n## Then\n\nShip it.';

test('Markdown left in a formatted paste is offered, with the clipboard plain text', () => {
    const plainText = '## Plan\n\nRun `npm test` first.\n\n## Then\n\nShip it.\n';
    assert.deepEqual(offered({ visibleText: HALF_RENDERED, plainText }), {
        kind: 'markdown', tags: ['@markdown'], text: '## Plan\n\nRun `npm test` first.\n\n## Then\n\nShip it.',
    });
});

test('the visible text is applied when the plain text does not read as that format', () => {
    assert.deepEqual(offered({ visibleText: HALF_RENDERED, plainText: 'Plan Run npm test first.' }), {
        kind: 'markdown', tags: ['@markdown'], text: HALF_RENDERED,
    });
});

test('a fully rendered paste offers nothing', () => {
    const visibleText = 'ShockHarness rule for this one: flag any check of the form “is this note empty” '
        + 'that strips whitespace (Python’s strip(), JavaScript’s trim()) without first removing zero-width characters.';
    assert.equal(offered({ visibleText, plainText: visibleText }), null);
});

test('formats that are certain in plain text are offered from formatted text', () => {
    assert.deepEqual(offered({ visibleText: '$$\\frac{1}{2}$$', plainText: '$$\\frac{1}{2}$$' }), {
        kind: 'format', tags: ['@LaTeX'], text: '$$\\frac{1}{2}$$',
    });
    assert.deepEqual(offered({ visibleText: '{"a": 1}', plainText: '' }), { kind: 'format', tags: ['@json'], text: '{"a": 1}' });
});

test('CSV and code in formatted text are offered as for a plain paste', () => {
    const csv = 'name,age\nAda,36\nAlan,41';
    assert.deepEqual(offered({ visibleText: csv, plainText: csv }), { kind: 'csv', tags: ['@csv'], text: csv });
    const python = 'def greet(name):\n    return f"Hello, {name}!"';
    assert.equal(offered({ visibleText: python, plainText: python }).tags[0], '@code=python');
});
