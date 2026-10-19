import assert from 'node:assert/strict';
import test from 'node:test';

import { CONFIG } from '../../app/static/js/modules/config.js';
import {
    getCustomPasteElementPolicy,
    hasImmediateLineBreakBefore,
    normalizeSoftWrappedTextLineBreaks,
    shouldInsertLineBreakBeforeTimestampAnchor,
    shouldPreserveTimestampSiblingLineBreaks,
    shouldRemoveStandaloneCitationMarker,
    splitMeaningfulTextLineBreaks,
    sanitizePastedImageSourceUrl,
    sanitizeStyleAttributeValue,
    sanitizeUrlAttributeValue,
} from '../../app/static/js/modules/mode-manager/services/html-paste-sanitizer-service.js';

class FakeElement {
    constructor(tagName, children = []) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.parentNode = null;
        this.previousSibling = null;
        this.lastChild = null;

        let previousChild = null;
        let i = 0;
        while (i < children.length) {
            const child = children[i];
            child.parentNode = this;
            child.previousSibling = previousChild;
            previousChild = child;
            i += 1;
        }
        this.lastChild = previousChild;
    }
}

test('sanitizeUrlAttributeValue keeps safe https href', () => {
    const value = sanitizeUrlAttributeValue('https://example.com/path?q=1', 'href');
    assert.equal(value, 'https://example.com/path?q=1');
});

test('sanitizeUrlAttributeValue strips javascript href', () => {
    const value = sanitizeUrlAttributeValue('javascript:alert(1)', 'href');
    assert.equal(value, null);
});

test('sanitizeUrlAttributeValue strips percent-encoded javascript href', () => {
    const value = sanitizeUrlAttributeValue('j%61vascript:alert(1)', 'href');
    assert.equal(value, null);
});

test('sanitizeUrlAttributeValue allows safe data image src under byte limit', () => {
    const value = sanitizeUrlAttributeValue('data:image/png;base64,AAAA', 'src');
    assert.equal(value, 'data:image/png;base64,AAAA');
});

test('sanitizeUrlAttributeValue rejects over-limit data image src', () => {
    const maxBytes = CONFIG.PASTE.MAX_DATA_IMAGE_BYTES;
    const payloadLength = Math.ceil(((maxBytes + 1) * 4) / 3);
    const payload = 'A'.repeat(payloadLength);
    const value = sanitizeUrlAttributeValue(`data:image/png;base64,${payload}`, 'src');
    assert.equal(value, null);
});

test('sanitizePastedImageSourceUrl keeps oversized data image src for later recompression', () => {
    const maxBytes = CONFIG.PASTE.MAX_DATA_IMAGE_BYTES;
    const payloadLength = Math.ceil(((maxBytes + 1) * 4) / 3);
    const payload = 'A'.repeat(payloadLength);
    const value = sanitizePastedImageSourceUrl(`data:image/png;base64,${payload}`);
    assert.equal(value, `data:image/png;base64,${payload}`);
});

test('sanitizePastedImageSourceUrl rejects non-image data urls', () => {
    const value = sanitizePastedImageSourceUrl('data:text/html;base64,AAAA');
    assert.equal(value, null);
});

test('sanitizeStyleAttributeValue keeps safe block indentation styles', () => {
    const value = sanitizeStyleAttributeValue('margin-left: 24px; text-indent: 0px;', 'div');
    assert.equal(value, 'margin-left: 24px; text-indent: 0px;');
});

test('sanitizeStyleAttributeValue keeps numeric vertical align for copied math superscripts', () => {
    const value = sanitizeStyleAttributeValue('vertical-align: 0.5em; color: red;', 'span');
    assert.equal(value, 'vertical-align: 0.5em;');
});

test('sanitizeStyleAttributeValue strips unsafe styles and disallowed properties', () => {
    const value = sanitizeStyleAttributeValue('position: absolute; color: red; margin-left: 12px; background-image: url(https://x);', 'div');
    assert.equal(value, 'margin-left: 12px;');
});

test('sanitizeStyleAttributeValue removes encoded entity payloads', () => {
    const value = sanitizeStyleAttributeValue('margin-left: &#x31;2px;', 'div');
    assert.equal(value, null);
});

test('getCustomPasteElementPolicy unwraps Distill citation components', () => {
    assert.equal(getCustomPasteElementPolicy('d-cite'), 'unwrap');
});

test('getCustomPasteElementPolicy removes Distill footnote bodies', () => {
    assert.equal(getCustomPasteElementPolicy('d-footnote'), 'remove');
});

test('getCustomPasteElementPolicy keeps normal inline elements', () => {
    assert.equal(getCustomPasteElementPolicy('a'), 'keep');
});

test('splitMeaningfulTextLineBreaks preserves YouTube literal timestamp newlines', () => {
    const parts = splitMeaningfulTextLineBreaks('\n\nTimestamps:\n(0:00) - Intro\r\n(0:18) - Rule');
    assert.deepEqual(parts, [
        '',
        '',
        'Timestamps:',
        '(0:00) - Intro',
        '(0:18) - Rule',
    ]);
});

test('splitMeaningfulTextLineBreaks ignores formatting-only HTML whitespace', () => {
    const parts = splitMeaningfulTextLineBreaks('\n    \n  ');
    assert.equal(parts, null);
});

test('normalizeSoftWrappedTextLineBreaks joins wrapped arXiv abstract prose', () => {
    const input = 'formal languages in the complexity class AC0,\n'
        + 'the class of languages recognizable by families of Boolean circuits of\n'
        + 'constant depth and polynomial size. In contrast, the non-\n'
        + 'AC0 languages MAJORITY and DYCK-1 are recognizable.';

    const normalized = normalizeSoftWrappedTextLineBreaks(input);

    assert.equal(
        normalized,
        'formal languages in the complexity class AC0, the class of languages recognizable by families of Boolean circuits of constant depth and polynomial size. In contrast, the non-AC0 languages MAJORITY and DYCK-1 are recognizable.',
    );
});

test('normalizeSoftWrappedTextLineBreaks keeps real arXiv abstract paragraph breaks', () => {
    const input = 'heads.\n\nOur results feature several implications unique to the attention structure.';

    const normalized = normalizeSoftWrappedTextLineBreaks(input);

    assert.equal(normalized, input);
});

test('normalizeSoftWrappedTextLineBreaks keeps timestamp lists as explicit line breaks', () => {
    const input = 'Timestamps:\n(0:00) - Intro\n(0:18) - Rule';

    const normalized = normalizeSoftWrappedTextLineBreaks(input);

    assert.equal(normalized, input);
});

test('normalizeSoftWrappedTextLineBreaks keeps bare YouTube timestamp links as explicit line breaks', () => {
    const input = 'Time Stamps:\n'
        + '00:00 Why eating less stops working (in practical terms)\n'
        + '01:07 How visceral fat protects itself\n'
        + '01:39 Visceral Fat Protocol Roadmap';

    const normalized = normalizeSoftWrappedTextLineBreaks(input);

    assert.equal(normalized, input);
});

test('normalizeSoftWrappedTextLineBreaks keeps unbulleted YouTube description lists', () => {
    const input = 'Why chronic stress and nervous system tension push the voice higher\n'
        + 'How the tongue lifting blocks access to the lower register\n'
        + 'The yawn-sigh technique for opening the lower register\n'
        + "Jaw drop and chin elevation — the emperor's pose\n"
        + 'Hands on the chest to feel chest voice vibrations\n'
        + 'Sternum pressure points — the sea of tranquility\n'
        + 'Pectoral muscle sweep to release chest tension\n'
        + 'Vocal fry — what it is, why to avoid leaning on it\n'
        + 'How to practice throughout the day without setting aside time\n'
        + 'Journal prompt — finding your natural note';

    const normalized = normalizeSoftWrappedTextLineBreaks(input);

    assert.equal(normalized, input);
});

test('shouldPreserveTimestampSiblingLineBreaks keeps YouTube anchor timestamp sibling breaks', () => {
    assert.equal(
        shouldPreserveTimestampSiblingLineBreaks(
            ' Why eating less stops working (in practical terms)\n',
            '00:00',
            '01:07',
        ),
        true,
    );
});

test('shouldInsertLineBreakBeforeTimestampAnchor breaks flattened YouTube chapter link runs', () => {
    assert.equal(
        shouldInsertLineBreakBeforeTimestampAnchor(
            '01:07',
            1,
            'Time Stamps: 00:00 Why eating less stops working (in practical terms) ',
        ),
        true,
    );
});

test('hasImmediateLineBreakBefore sees a YouTube newline across adjacent inline wrappers', () => {
    const originalElement = globalThis.Element;
    globalThis.Element = FakeElement;

    try {
        const firstTimestampLink = new FakeElement('a');
        const firstTimestampWrapper = new FakeElement('span', [firstTimestampLink]);
        const existingLineBreak = new FakeElement('br');
        const firstDescriptionWrapper = new FakeElement('span', [existingLineBreak]);
        const secondTimestampLink = new FakeElement('a');
        const secondTimestampWrapper = new FakeElement('span', [secondTimestampLink]);
        const timestampContainer = new FakeElement('div', [
            firstTimestampWrapper,
            firstDescriptionWrapper,
            secondTimestampWrapper,
        ]);

        assert.equal(
            hasImmediateLineBreakBefore(secondTimestampLink, timestampContainer),
            true,
        );
    } finally {
        globalThis.Element = originalElement;
    }
});

test('shouldInsertLineBreakBeforeTimestampAnchor breaks first chapter after timestamp label', () => {
    assert.equal(
        shouldInsertLineBreakBeforeTimestampAnchor(
            '00:00',
            0,
            'Time Stamps: ',
        ),
        true,
    );
});

test('shouldInsertLineBreakBeforeTimestampAnchor ignores non-timestamp inline links', () => {
    assert.equal(
        shouldInsertLineBreakBeforeTimestampAnchor(
            'visceral fat protocol',
            1,
            'Time Stamps: 00:00 Why eating less stops working ',
        ),
        false,
    );
});

test('shouldRemoveStandaloneCitationMarker handles invisible-character wrapped markers', () => {
    assert.equal(shouldRemoveStandaloneCitationMarker('\u200b[7]\u200b'), true);
});

test('shouldRemoveStandaloneCitationMarker ignores model notation', () => {
    assert.equal(shouldRemoveStandaloneCitationMarker('[A] [B]'), false);
});
