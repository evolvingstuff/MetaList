const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function restoreDocumentTokens(root) {
    for (const block of root.querySelectorAll('[data-document-id]')) {
        const id = block.dataset.documentId;
        const token = block.dataset.documentToken;
        if (!UUID.test(id) || ![`![[${id}]]`, `[[${id}]]`].includes(token)) {
            throw new Error('Invalid embedded document identity');
        }
        block.replaceWith(root.ownerDocument.createTextNode(token));
    }
}
