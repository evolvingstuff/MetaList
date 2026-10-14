import assert from 'node:assert/strict';
import test from 'node:test';

import {
    consumePlainPasteRequest,
    detectClipboardFormat,
    detectPastedFormat,
    planFormatPaste,
    rememberDetectedPaste,
    requestPlainPaste,
    takeDetectedPasteUndo,
} from '../../app/static/js/modules/mode-manager/services/paste-format-detection-service.js';

// Pasting an unambiguous format tags the note for it (docs/ui/content-formatting.md,
// "Paste format detection"). A miss costs nothing; a wrong guess is annoying, so
// near-misses must stay plain.

const tagOf = (text) => {
    const detected = detectPastedFormat(text);
    return detected === null ? null : detected.tag;
};

test('JSON objects and arrays are detected; JSON-looking prose and broken JSON are not', () => {
    assert.equal(tagOf('{\n  "title": "Weekend trip",\n  "budget": 650.0,\n  "booked": true,\n  "stops": [{ "notes": null }]\n}'), '@json');
    assert.equal(tagOf('[1, 2.5e3, "three", false]'), '@json');
    assert.equal(tagOf('{}'), '@json');
    assert.equal(tagOf('{ "title": "Broken", "booked": true, nights: 2, }'), null);
    assert.equal(tagOf('{see the notes above}'), null);
    assert.equal(tagOf('[citation needed]'), null);
    assert.equal(tagOf('"just a string"'), null);
    assert.equal(tagOf('42'), null);
});

test('a chess FEN is detected; slash-separated text is not', () => {
    assert.equal(tagOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), '@chess');
    assert.equal(tagOf('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1'), '@chess');
    assert.equal(tagOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'), '@chess');
    assert.equal(tagOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w'), null);
    assert.equal(tagOf('a/b/c/d/e/f/g/h'), null);
    assert.equal(tagOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1'), null);
});

test('a unified diff is detected; dash lists are not', () => {
    assert.equal(tagOf('--- a/shopping.txt\n+++ b/shopping.txt\n@@ -1,3 +1,3 @@\n eggs\n-milk\n+oat milk\n bread'), '@diff');
    assert.equal(tagOf('@@ -10,2 +10,2 @@\n-old\n+new'), '@diff');
    assert.equal(tagOf('diff --git a/x b/x\n-old\n+new'), '@diff');
    assert.equal(tagOf('- milk\n- eggs\n- bread'), null);
    assert.equal(tagOf('Pros and cons:\n+ cheap\n- slow'), null);
});

test('Mermaid is detected on its own and inside a fenced block', () => {
    assert.equal(tagOf('graph TD\n  A[Start] --> B[End]'), '@mermaid');
    assert.equal(tagOf('sequenceDiagram\n  Alice->>Bob: Hi'), '@mermaid');
    assert.equal(tagOf('```mermaid\ngraph LR\n  A --> B\n```'), '@markdown');
    assert.equal(tagOf('graph TD'), null);
    assert.equal(tagOf('The graph TD shows growth\nover time'), null);
});

test('a pure LaTeX block is detected; text with a dollar amount is not', () => {
    assert.equal(tagOf('$$\\frac{a}{b} = \\sum_{i=1}^{n} x_i$$'), '@LaTeX');
    assert.equal(tagOf('\\[ e^{i\\pi} + 1 = 0 \\]'), '@LaTeX');
    assert.equal(tagOf('\\begin{align}\nx &= 1 \\\\\ny &= 2\n\\end{align}'), '@LaTeX');
    assert.equal(tagOf('It costs $5 and $10'), null);
    assert.equal(tagOf('Euler wrote $e^{i\\pi}+1=0$ in his notebook'), null);
});

test('ordinary text, code and CSV are left alone for now', () => {
    assert.equal(tagOf('Remember to call Henry about the trip on Friday.'), null);
    assert.equal(tagOf('def area(r):\n    return 3.14 * r * r'), null);
    assert.equal(tagOf('name,age\nAda,36\nAlan,41'), null);
    assert.equal(tagOf('   \n  '), null);
});

test('the pasted text is inserted without blank lines around it', () => {
    assert.deepEqual(detectPastedFormat('\n\n{"a": 1}\n\n'), { tag: '@json', text: '{"a": 1}' });
    assert.deepEqual(detectPastedFormat('{"a": 1}\r\n'), { tag: '@json', text: '{"a": 1}' });
});

const json = { tag: '@json', text: '{"a": 1}' };

test('into an otherwise empty note the plain tag is added', () => {
    assert.deepEqual(planFormatPaste({ detected: json, tags: '', noteIsEmpty: true, textBeforeCaret: '' }),
        { insertText: '{"a": 1}', nextTags: '@json' });
    assert.deepEqual(planFormatPaste({ detected: json, tags: 'scratchpad', noteIsEmpty: true, textBeforeCaret: '' }),
        { insertText: '{"a": 1}', nextTags: 'scratchpad @json' });
});

test('into a note with content the paste is wrapped and the wrapped tag added', () => {
    assert.deepEqual(planFormatPaste({ detected: json, tags: 'scratchpad', noteIsEmpty: false, textBeforeCaret: 'Config: ' }),
        { insertText: '(({"a": 1}))', nextTags: 'scratchpad ((@json))' });
});

test('an already formatted note, a wrapped region, or "((" in use pastes normally', () => {
    assert.equal(planFormatPaste({ detected: json, tags: 'topic @markdown', noteIsEmpty: true, textBeforeCaret: '' }), null);
    assert.equal(planFormatPaste({ detected: json, tags: 'topic @code=python', noteIsEmpty: false, textBeforeCaret: 'x' }), null);
    assert.equal(planFormatPaste({ detected: json, tags: '[@red]', noteIsEmpty: false, textBeforeCaret: 'see [the ' }), null);
    assert.equal(planFormatPaste({ detected: json, tags: '((@csv))', noteIsEmpty: false, textBeforeCaret: 'a ((x)) b ' }), null);
    // Outside a closed wrapped region, with another delimiter, detection still applies.
    assert.deepEqual(planFormatPaste({ detected: json, tags: '[@red]', noteIsEmpty: false, textBeforeCaret: 'see [this] and ' }),
        { insertText: '(({"a": 1}))', nextTags: '[@red] ((@json))' });
    // A formatting tag that is not a renderer does not block it.
    assert.deepEqual(planFormatPaste({ detected: json, tags: '@bold', noteIsEmpty: true, textBeforeCaret: '' }),
        { insertText: '{"a": 1}', nextTags: '@bold @json' });
    assert.equal(planFormatPaste({ detected: null, tags: '', noteIsEmpty: true, textBeforeCaret: '' }), null);
});

test('⌘Z right after the paste restores the tags once, only if nothing changed since', () => {
    rememberDetectedPaste({ noteId: 'n1', tagsBefore: 'scratchpad', tagsAfter: 'scratchpad @json', contentAfter: '<p>{}</p>' });
    assert.equal(takeDetectedPasteUndo({ noteId: 'n1', tags: 'scratchpad @json', content: '<p>{}</p>' }), 'scratchpad');
    assert.equal(takeDetectedPasteUndo({ noteId: 'n1', tags: 'scratchpad @json', content: '<p>{}</p>' }), null);
    rememberDetectedPaste({ noteId: 'n1', tagsBefore: '', tagsAfter: '@json', contentAfter: '<p>{}</p>' });
    assert.equal(takeDetectedPasteUndo({ noteId: 'n1', tags: '@json', content: '<p>{} typed more</p>' }), null);
});

test('a plain-text paste request is used by the next paste only', () => {
    assert.equal(consumePlainPasteRequest(), false);
    requestPlainPaste();
    assert.equal(consumePlainPasteRequest(), true);
    assert.equal(consumePlainPasteRequest(), false);
});


test('a fenced block naming a language is Markdown; a bare or unclosed fence is not', () => {
    assert.equal(tagOf('```python\ndef f():\n    return 1\n```'), '@markdown');
    assert.equal(tagOf('Some notes.\n\n```js\nconst x = 1;\n```\n\nMore text.'), '@markdown');
    assert.equal(tagOf('```mermaid\ngraph LR\n  A --> B\n```'), '@markdown');
    assert.equal(tagOf('```\nplain\n```'), null);
    assert.equal(tagOf('```python\nnever closed'), null);
    // A diff of a Markdown file stays a diff.
    assert.equal(tagOf('--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n-```python\n+```py'), '@diff');
});

const clipboard = (fields) => {
    const detected = detectClipboardFormat({ plainText: '', html: '', vscodeEditorData: '', ...fields });
    return detected === null ? null : detected;
};
const vscode = (mode) => JSON.stringify({ version: 1, isFromEmptySelection: false, multicursorText: null, mode });

test('code copied from VS Code is tagged with its language; one line is not', () => {
    const python = 'def f(x):\n    return x';
    assert.deepEqual(clipboard({ plainText: python, vscodeEditorData: vscode('python') }), { tag: '@code=python', text: python });
    assert.equal(clipboard({ plainText: 'echo hi\nls', vscodeEditorData: vscode('shellscript') }).tag, '@code=bash');
    assert.equal(clipboard({ plainText: '# Title\n\ntext', vscodeEditorData: vscode('markdown') }).tag, '@markdown');
    // JSON that parses keeps the @json view; JSON with comments is code.
    assert.equal(clipboard({ plainText: '{\n  "a": 1\n}', vscodeEditorData: vscode('json') }).tag, '@json');
    assert.equal(clipboard({ plainText: '{\n  // note\n  "a": 1\n}', vscodeEditorData: vscode('jsonc') }).tag, '@code=json');
    assert.equal(clipboard({ plainText: 'someIdentifier', vscodeEditorData: vscode('python') }), null);
    assert.equal(clipboard({ plainText: 'a\nb', vscodeEditorData: vscode('plaintext') }), null);
    assert.equal(clipboard({ plainText: 'a\nb', vscodeEditorData: vscode('brainfuck') }), null);
});

test('cells copied from a spreadsheet become CSV tagged @csv', () => {
    const html = '<table><tr><td>name</td><td>age</td></tr></table>';
    assert.deepEqual(clipboard({ plainText: 'name\tage\nAda\t36\n', html }), { tag: '@csv', text: 'name,age\nAda,36' });
    // Commas, quotes and line breaks inside a cell are quoted as CSV quotes them.
    assert.equal(
        clipboard({ plainText: 'city\tnote\nLondon, UK\t"said ""hi""\nthen left"\n', html }).text,
        'city,note\n"London, UK","said ""hi""\nthen left"',
    );
    // Tab-separated text without a table, or rows of different lengths, are not cells.
    assert.equal(clipboard({ plainText: 'a\tb\nc\td' }), null);
    assert.equal(clipboard({ plainText: 'a\tb\nc', html }), null);
});
