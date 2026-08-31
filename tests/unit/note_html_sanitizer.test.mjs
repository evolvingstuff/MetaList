import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    initializeNoteHtmlSanitizer,
    sanitizeNoteAttribute,
    sanitizeNoteHtmlForStorage,
} from '../../app/static/js/modules/note-html-sanitizer.js';

const policy = JSON.parse(
    await readFile(new URL('../../app/static/note-html-policy.json', import.meta.url), 'utf8'),
);

test('note attribute policy removes executable attributes and URLs', () => {
    assert.equal(sanitizeNoteAttribute('img', 'onerror', 'alert(1)', policy), null);
    assert.equal(sanitizeNoteAttribute('a', 'href', 'javascript:alert(1)', policy), null);
    assert.equal(sanitizeNoteAttribute('div', 'class', 'trusted-looking', policy), null);
    assert.equal(sanitizeNoteAttribute('img', 'src', 'data:text/html;base64,AAAA', policy), null);
});

test('note attribute policy preserves supported formatting', () => {
    assert.equal(
        sanitizeNoteAttribute('a', 'href', 'https://example.com/path?q=1', policy),
        'https://example.com/path?q=1',
    );
    assert.equal(
        sanitizeNoteAttribute('div', 'style', 'position: absolute; margin-left: 12px;', policy),
        'margin-left: 12px;',
    );
    assert.equal(sanitizeNoteAttribute('td', 'colspan', '2', policy), '2');
});

test('note attribute policy preserves only generated AI reference attributes', () => {
    const noteId = '75193dae-9e05-4a4e-94bf-417ffde18957';

    assert.equal(
        sanitizeNoteAttribute(
            'div',
            'class',
            'hostile ai-chat-message-content meta-markdown',
            policy,
        ),
        'ai-chat-message-content meta-markdown',
    );
    assert.equal(sanitizeNoteAttribute('div', 'data-markdown-rendered', 'true', policy), 'true');
    assert.equal(sanitizeNoteAttribute('a', 'data-ref-note-id', noteId, policy), noteId);
    assert.equal(
        sanitizeNoteAttribute('li', 'data-ref-query', `${noteId} OR ${noteId}`, policy),
        `${noteId} OR ${noteId}`,
    );
    assert.equal(sanitizeNoteAttribute('section', 'aria-label', 'References', policy), 'References');
    assert.equal(sanitizeNoteAttribute('sup', 'aria-label', 'Reference 3', policy), 'Reference 3');
    assert.equal(sanitizeNoteAttribute('div', 'data-markdown-rendered', 'false', policy), null);
    assert.equal(sanitizeNoteAttribute('a', 'data-ref-note-id', 'not-a-uuid', policy), null);
    assert.equal(sanitizeNoteAttribute('li', 'data-ref-query', 'javascript:alert(1)', policy), null);
});

test('initialized sanitizer passes the shared policy to DOMPurify', async () => {
    const captured = { hooks: [], options: null };
    const fakePurifier = {
        addHook(name, hook) {
            captured.hooks.push([name, hook]);
        },
        sanitize(content, options) {
            captured.options = options;
            return `clean:${content}`;
        },
    };

    await initializeNoteHtmlSanitizer({ policy, purifier: fakePurifier });
    const sanitized = sanitizeNoteHtmlForStorage('<div>safe</div>');

    assert.equal(sanitized, 'clean:<div>safe</div>');
    assert.equal(captured.hooks.length, 1);
    assert.equal(captured.hooks[0][0], 'uponSanitizeAttribute');
    assert.deepEqual(captured.options.ALLOWED_TAGS, policy.allowed_tags);
    assert.deepEqual(captured.options.FORBID_TAGS, policy.clean_content_tags);
    assert.equal(captured.options.ALLOW_DATA_ATTR, false);
    assert.equal(captured.options.ALLOW_ARIA_ATTR, false);
});
