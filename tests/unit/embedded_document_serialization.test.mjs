import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreDocumentTokens } from '../../app/static/js/modules/embedded-documents/serialization.js';

test('saving diagram previews restores only their exact UUID tokens', () => {
    const first = 'cd5a219e-39cc-42d1-8d20-4c56d312d8e1';
    const second = 'f9898ca0-3723-4f6d-9f24-18ebc7e321a6';
    const replaced = [];
    const blocks = [
        { dataset: { documentId: first, documentToken: `![[${first}]]` }, replaceWith: node => replaced.push(node) },
        { dataset: { documentId: second, documentToken: `[[${second}]]` }, replaceWith: node => replaced.push(node) },
    ];
    const root = {
        querySelectorAll: selector => {
            assert.equal(selector, '[data-document-id]');
            return blocks;
        },
        ownerDocument: { createTextNode: value => ({ nodeType: 3, textContent: value }) },
    };
    restoreDocumentTokens(root);
    assert.deepEqual(replaced.map(node => node.textContent), [`![[${first}]]`, `[[${second}]]`]);
    assert.ok(replaced.every(node => node.nodeType === 3));
});

test('mismatched widget identity cannot silently rewrite a reference', () => {
    const root = {
        querySelectorAll: () => [{ dataset: {
            documentId: 'cd5a219e-39cc-42d1-8d20-4c56d312d8e1',
            documentToken: '![[f9898ca0-3723-4f6d-9f24-18ebc7e321a6]]',
        } }],
    };
    assert.throws(() => restoreDocumentTokens(root), /Invalid embedded document identity/);
});
