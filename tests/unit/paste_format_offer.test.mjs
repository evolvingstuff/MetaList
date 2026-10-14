import assert from 'node:assert/strict';
import test from 'node:test';

// The module reads MetaList's mode state, which keeps its client id in browser storage.
function memoryStorage() {
    const entries = new Map();
    return {
        getItem: (key) => (entries.has(key) ? entries.get(key) : null),
        setItem: (key, value) => entries.set(key, String(value)),
        removeItem: (key) => entries.delete(key),
        clear: () => entries.clear(),
    };
}
globalThis.sessionStorage = memoryStorage();
globalThis.localStorage = memoryStorage();
const { placePasteFormatOffer } = await import('../../app/static/js/modules/mode-manager/services/paste-format-offer-service.js');

// The card for a guessed paste format sits just below where the paste ended,
// or above it near the window's bottom, always inside the window.
const viewport = { viewportWidth: 1000, viewportHeight: 800 };

test('the card opens just below the end of the paste', () => {
    const anchor = { left: 120, top: 300, bottom: 320 };
    assert.deepEqual(placePasteFormatOffer({ anchor, width: 260, height: 40, ...viewport }), { left: 120, top: 326 });
});

test('near the bottom of the window the card opens above the paste instead', () => {
    const anchor = { left: 120, top: 760, bottom: 780 };
    assert.deepEqual(placePasteFormatOffer({ anchor, width: 260, height: 40, ...viewport }), { left: 120, top: 714 });
});

test('the card stays inside the window at its edges', () => {
    const atRightEdge = { left: 950, top: 300, bottom: 320 };
    assert.equal(placePasteFormatOffer({ anchor: atRightEdge, width: 260, height: 40, ...viewport }).left, 1000 - 260 - 8);
    const tooTallAbove = { left: 10, top: 20, bottom: 790 };
    assert.equal(placePasteFormatOffer({ anchor: tooTallAbove, width: 260, height: 40, ...viewport }).top, 8);
});
