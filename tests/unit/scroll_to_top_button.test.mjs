import assert from 'node:assert/strict';
import test from 'node:test';

// The up and down arrows (docs/ui/controls.md): dimmed at their end of the
// list, a click leaves edit mode first, then scrolls to that end, or rebuilds
// the view from the first or last root when roots are unloaded beyond the band.

const PAGE_HEIGHT = 5000;
const WINDOW_HEIGHT = 800;
const BOTTOM_Y = PAGE_HEIGHT - WINDOW_HEIGHT;

function makeButton() {
    const listeners = new Map();
    return {
        disabled: false,
        blurCount: 0,
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        blur() {
            this.blurCount += 1;
        },
        click() {
            if (this.disabled) {
                return;
            }
            listeners.get('click')();
        },
    };
}

function installScrollButtonDom(t, { initialScrollY, prefersReducedMotion }) {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalResizeObserver = globalThis.ResizeObserver;
    const windowListeners = new Map();
    const animationFrames = [];
    const scrollCalls = [];
    const dispatchedEvents = [];
    const buttons = { 'scroll-to-top-button': makeButton(), 'scroll-to-bottom-button': makeButton() };

    globalThis.window = {
        scrollY: initialScrollY,
        innerHeight: WINDOW_HEIGHT,
        addEventListener(type, listener) {
            windowListeners.set(type, listener);
        },
        requestAnimationFrame(callback) {
            animationFrames.push(callback);
            return animationFrames.length;
        },
        cancelAnimationFrame() {},
        dispatchEvent(event) {
            dispatchedEvents.push(event.type);
        },
        matchMedia(query) {
            assert.equal(query, '(prefers-reduced-motion: reduce)');
            return { matches: prefersReducedMotion };
        },
        scrollTo(x, y) {
            scrollCalls.push([x, y]);
            this.scrollY = y;
        },
    };
    globalThis.document = {
        body: {},
        documentElement: { scrollHeight: PAGE_HEIGHT },
        getElementById(id) {
            return buttons[id];
        },
    };
    globalThis.ResizeObserver = class {
        observe() {}
    };

    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.ResizeObserver = originalResizeObserver;
    });

    return {
        animationFrames,
        top: buttons['scroll-to-top-button'],
        bottom: buttons['scroll-to-bottom-button'],
        emitWindowScroll() {
            windowListeners.get('scroll')();
        },
        scrollCalls,
        dispatchedEvents,
    };
}

async function importService() {
    return import('../../app/static/js/modules/mode-manager/services/scroll-to-top-service.js');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('scroll-to-top button starts disabled at the page top and enables after scrolling', async (t) => {
    const harness = installScrollButtonDom(t, { initialScrollY: 0, prefersReducedMotion: true });
    const { initializeScrollToTopButton } = await importService();

    initializeScrollToTopButton({ hasRootsAboveWindow: () => false, jumpToListTop: async () => {}, leaveEditMode: async () => {} });

    assert.equal(harness.top.disabled, true);
    globalThis.window.scrollY = 240;
    harness.emitWindowScroll();
    assert.equal(harness.animationFrames.length, 1);
    harness.animationFrames.shift()(0);
    assert.equal(harness.top.disabled, false);
});

test('scroll-to-top button leaves edit mode, then reaches the top (reduced motion)', async (t) => {
    const harness = installScrollButtonDom(t, { initialScrollY: 640, prefersReducedMotion: true });
    const { initializeScrollToTopButton } = await importService();
    const steps = [];

    initializeScrollToTopButton({
        hasRootsAboveWindow: () => false,
        jumpToListTop: async () => steps.push('jump'),
        leaveEditMode: async () => steps.push(`leave at ${globalThis.window.scrollY}`),
    });
    assert.equal(harness.top.disabled, false);

    harness.top.click();
    await settle();

    assert.deepEqual(steps, ['leave at 640']);
    // A hold keeping the place left behind stands down: once after leaving edit
    // mode, and with each scroll the arrow makes.
    assert.deepEqual(harness.dispatchedEvents, ['metalist:deliberate-scroll', 'metalist:deliberate-scroll']);
    assert.deepEqual(harness.scrollCalls, [[0, 0]]);
    assert.equal(harness.top.disabled, true);
    assert.equal(harness.top.blurCount, 1);
});

test('scroll-to-top button rebuilds from the first root when roots are unloaded above', async (t) => {
    const harness = installScrollButtonDom(t, { initialScrollY: 0, prefersReducedMotion: true });
    const { initializeScrollToTopButton } = await importService();
    const steps = [];
    let rootsAbove = true;

    initializeScrollToTopButton({
        hasRootsAboveWindow: () => rootsAbove,
        jumpToListTop: async () => {
            steps.push('jump');
            rootsAbove = false;
        },
        leaveEditMode: async () => steps.push('leave'),
    });
    // At pixel 0 but not at the list's top: not dimmed.
    assert.equal(harness.top.disabled, false);

    harness.top.click();
    await settle();

    assert.deepEqual(steps, ['leave', 'jump']);
    assert.deepEqual(harness.scrollCalls, []);
    assert.equal(harness.top.disabled, true);
});

test('scroll-to-bottom button is dimmed at the page bottom and enabled above it', async (t) => {
    const harness = installScrollButtonDom(t, { initialScrollY: BOTTOM_Y, prefersReducedMotion: true });
    const { initializeScrollToBottomButton } = await importService();

    initializeScrollToBottomButton({ hasRootsBelowWindow: () => false, jumpToListBottom: async () => {}, leaveEditMode: async () => {} });

    assert.equal(harness.bottom.disabled, true);
    globalThis.window.scrollY = BOTTOM_Y - 300;
    harness.emitWindowScroll();
    harness.animationFrames.shift()(0);
    assert.equal(harness.bottom.disabled, false);
});

test('scroll-to-bottom button leaves edit mode, then reaches the page bottom (reduced motion)', async (t) => {
    const harness = installScrollButtonDom(t, { initialScrollY: 200, prefersReducedMotion: true });
    const { initializeScrollToBottomButton } = await importService();
    const steps = [];

    initializeScrollToBottomButton({
        hasRootsBelowWindow: () => false,
        jumpToListBottom: async () => steps.push('jump'),
        leaveEditMode: async () => steps.push('leave'),
    });

    harness.bottom.click();
    await settle();

    assert.deepEqual(steps, ['leave']);
    assert.deepEqual(harness.scrollCalls, [[0, BOTTOM_Y]]);
    assert.equal(harness.bottom.disabled, true);
});

test('scroll-to-bottom button animates to the bottom', async (t) => {
    const harness = installScrollButtonDom(t, { initialScrollY: 200, prefersReducedMotion: false });
    const { initializeScrollToBottomButton } = await importService();

    initializeScrollToBottomButton({ hasRootsBelowWindow: () => false, jumpToListBottom: async () => {}, leaveEditMode: async () => {} });
    harness.bottom.click();
    await settle();

    // Part way through it is between the start and the bottom; it ends at the bottom.
    harness.animationFrames.shift()(performance.now() + 60);
    const [, midY] = harness.scrollCalls[harness.scrollCalls.length - 1];
    assert.ok(midY > 200 && midY < BOTTOM_Y, `part way through, y=${midY}`);
    harness.animationFrames.shift()(performance.now() + 1000);
    assert.deepEqual(harness.scrollCalls[harness.scrollCalls.length - 1], [0, BOTTOM_Y]);
    assert.equal(harness.bottom.disabled, true);
});

test('scroll-to-bottom button rebuilds from the last root when roots are unloaded below', async (t) => {
    const harness = installScrollButtonDom(t, { initialScrollY: BOTTOM_Y, prefersReducedMotion: true });
    const { initializeScrollToBottomButton } = await importService();
    const steps = [];
    let rootsBelow = true;

    initializeScrollToBottomButton({
        hasRootsBelowWindow: () => rootsBelow,
        jumpToListBottom: async () => {
            steps.push('jump');
            rootsBelow = false;
        },
        leaveEditMode: async () => steps.push('leave'),
    });
    // At the page bottom but not at the list's end: not dimmed.
    assert.equal(harness.bottom.disabled, false);

    harness.bottom.click();
    await settle();

    assert.deepEqual(steps, ['leave', 'jump']);
    assert.deepEqual(harness.scrollCalls, []);
    assert.equal(harness.bottom.disabled, true);
});
