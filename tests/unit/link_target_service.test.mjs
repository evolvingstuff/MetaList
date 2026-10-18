import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ensureAnchorOpensInNewTab,
    ensureAnchorsOpenInNewTabs,
} from '../../app/static/js/modules/mode-manager/services/link-target-service.js';

function createFakeAnchor(initialAttributes = {}) {
    const attributes = new Map(Object.entries(initialAttributes));
    return {
        getAttribute(name) {
            return attributes.has(name) ? attributes.get(name) : null;
        },
        setAttribute(name, value) {
            attributes.set(name, value);
        },
        snapshot() {
            return Object.fromEntries(attributes.entries());
        },
    };
}

test('ensureAnchorOpensInNewTab normalizes external anchors', () => {
    const anchor = createFakeAnchor({
        href: 'https://example.com',
        rel: 'nofollow',
        target: '_self',
    });

    ensureAnchorOpensInNewTab(anchor);

    assert.deepEqual(anchor.snapshot(), {
        href: 'https://example.com',
        rel: 'nofollow noopener noreferrer',
        target: '_blank',
    });
});

test('ensureAnchorOpensInNewTab leaves hash anchors alone', () => {
    const anchor = createFakeAnchor({
        href: '#note-123',
        rel: 'nofollow',
    });

    ensureAnchorOpensInNewTab(anchor);

    assert.deepEqual(anchor.snapshot(), {
        href: '#note-123',
        rel: 'nofollow',
    });
});

test('ensureAnchorsOpenInNewTabs updates every external anchor in a root element', () => {
    const externalAnchor = createFakeAnchor({ href: 'https://example.com' });
    const relativeAnchor = createFakeAnchor({ href: '/docs' });
    const hashAnchor = createFakeAnchor({ href: '#note-123' });
    const rootElement = {
        querySelectorAll(selector) {
            assert.equal(selector, 'a[href]');
            return [externalAnchor, relativeAnchor, hashAnchor];
        },
    };

    ensureAnchorsOpenInNewTabs(rootElement);

    assert.deepEqual(externalAnchor.snapshot(), {
        href: 'https://example.com',
        rel: 'noopener noreferrer',
        target: '_blank',
    });
    assert.deepEqual(relativeAnchor.snapshot(), {
        href: '/docs',
        rel: 'noopener noreferrer',
        target: '_blank',
    });
    assert.deepEqual(hashAnchor.snapshot(), {
        href: '#note-123',
    });
});
