import assert from 'node:assert/strict';
import test from 'node:test';

import { computeScrollYToRevealRect, restoreScrollFromAnchor } from '../../app/static/js/modules/mode-manager/services/scroll-restoration-service.js';

test('restoring the top ignores a note anchor a few pixels below the sticky controls', (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    });
    const scrollPositions = [];
    const note = {
        dataset: { noteId: 'root' },
        getAttribute: () => '',
        getBoundingClientRect: () => ({ top: 112, height: 40 }),
    };
    globalThis.document = {
        documentElement: { scrollHeight: 2000 },
        getElementById: () => ({ querySelectorAll: () => [note] }),
        querySelector: (selector) => selector === '.controls'
            ? { getBoundingClientRect: () => ({ bottom: 100, height: 40, width: 600 }) }
            : note,
    };
    globalThis.window = {
        scrollY: 0,
        innerHeight: 800,
        scrollTo: (_x, y) => scrollPositions.push(y),
    };
    restoreScrollFromAnchor({ anchorId: 'root', anchorBias: 'top', intraOffset: 0 }, { scrollYFallback: 0 });
    assert.deepEqual(scrollPositions, [0]);
});

test('computeScrollYToRevealRect uses bottom alignment for below-viewport nearest scrolling', () => {
    const target = computeScrollYToRevealRect({
        rectTop: 700,
        rectBottom: 760,
        currentScrollY: 1000,
        viewportTop: 100,
        viewportBottom: 600,
        scrollMaxY: 5000,
        align: 'nearest',
    });

    assert.equal(target, 1160);
});

test('a new view cancels deferred scroll restoration from the previous view', async (t) => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalStorage = globalThis.sessionStorage;
    const callbacks = [];
    const scrollPositions = [];
    globalThis.sessionStorage = { getItem: () => null, setItem() {} };
    globalThis.window = {
        scrollY: 0, innerHeight: 800,
        requestAnimationFrame: (callback) => callbacks.push(callback),
        setTimeout: (callback) => callbacks.push(callback),
        scrollTo: (_x, y) => scrollPositions.push(y),
    };
    globalThis.document = {
        documentElement: { scrollHeight: 2000 },
        body: { classList: { add() {}, remove() {} } },
        getElementById: () => ({ querySelectorAll: () => [] }),
    };
    const { ModeContextInstance: context } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const originalTabs = context.getTabStatePayload();
    t.after(async () => {
        context.hydrateTabState(originalTabs, { emitUpdate: false });
        await new Promise(setImmediate);
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
        globalThis.sessionStorage = originalStorage;
    });
    context.hydrateTabState({
        activeTabId: 'scroll-test',
        tabOrder: ['scroll-test'],
        tabs: { 'scroll-test': { searchQuery: '', sortMode: 'normal', scrollY: 100, scrollAnchor: null } },
    }, { emitUpdate: false });
    context.restoreScrollForActiveTab();
    assert.equal(callbacks.length, 1);
    context.resetTabDiffCache('scroll-test', { preserveRootAnchor: false });
    while (callbacks.length) {
        callbacks.shift()();
        await Promise.resolve();
    }
    assert.deepEqual(scrollPositions, []);
    context.updateTabScroll('scroll-test', 0, false);
    context.restoreScrollForActiveTab();
    assert.equal(callbacks.length, 0, 'top restoration must not schedule later adjustments');
    await Promise.resolve();
    assert.deepEqual(scrollPositions, [0]);
    await import('../../app/static/js/modules/mode-manager/services/search-interaction-service.js');
    await import('../../app/static/js/modules/mode-manager/services/infinite-scroll-service.js');
    await Promise.resolve();
});

test('computeScrollYToRevealRect uses top alignment for above-viewport nearest scrolling', () => {
    const target = computeScrollYToRevealRect({
        rectTop: 40,
        rectBottom: 120,
        currentScrollY: 1000,
        viewportTop: 100,
        viewportBottom: 600,
        scrollMaxY: 5000,
        align: 'nearest',
    });

    assert.equal(target, 940);
});

test('computeScrollYToRevealRect preserves top alignment when explicitly requested', () => {
    const target = computeScrollYToRevealRect({
        rectTop: 700,
        rectBottom: 760,
        currentScrollY: 1000,
        viewportTop: 100,
        viewportBottom: 600,
        scrollMaxY: 5000,
        align: 'top',
    });

    assert.equal(target, 1600);
});
