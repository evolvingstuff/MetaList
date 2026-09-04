import assert from 'node:assert/strict';
import test from 'node:test';


function installScrollButtonDom(t, { initialScrollY, prefersReducedMotion }) {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const buttonListeners = new Map();
    const windowListeners = new Map();
    const animationFrames = [];
    const scrollCalls = [];

    const button = {
        disabled: false,
        blurCount: 0,
        addEventListener(type, listener) {
            buttonListeners.set(type, listener);
        },
        blur() {
            this.blurCount += 1;
        },
        click() {
            if (this.disabled) {
                return;
            }
            const listener = buttonListeners.get('click');
            if (typeof listener === 'function') {
                listener();
            }
        },
    };

    globalThis.window = {
        scrollY: initialScrollY,
        addEventListener(type, listener) {
            windowListeners.set(type, listener);
        },
        requestAnimationFrame(callback) {
            animationFrames.push(callback);
            return animationFrames.length;
        },
        cancelAnimationFrame() {},
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
        getElementById(id) {
            return id === 'scroll-to-top-button' ? button : null;
        },
    };

    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    });

    return {
        animationFrames,
        button,
        emitWindowScroll() {
            const listener = windowListeners.get('scroll');
            assert.equal(typeof listener, 'function');
            listener();
        },
        scrollCalls,
    };
}


test('scroll-to-top button starts disabled at the page top and enables after scrolling', async (t) => {
    const harness = installScrollButtonDom(t, {
        initialScrollY: 0,
        prefersReducedMotion: true,
    });
    const { initializeScrollToTopButton } = await import(
        '../../app/static/js/modules/mode-manager/services/scroll-to-top-service.js'
    );

    initializeScrollToTopButton();

    assert.equal(harness.button.disabled, true);
    globalThis.window.scrollY = 240;
    harness.emitWindowScroll();
    assert.equal(harness.animationFrames.length, 1);
    harness.animationFrames.shift()(0);
    assert.equal(harness.button.disabled, false);
});


test('scroll-to-top button immediately reaches the top when reduced motion is preferred', async (t) => {
    const harness = installScrollButtonDom(t, {
        initialScrollY: 640,
        prefersReducedMotion: true,
    });
    const { initializeScrollToTopButton } = await import(
        '../../app/static/js/modules/mode-manager/services/scroll-to-top-service.js'
    );

    initializeScrollToTopButton();
    assert.equal(harness.button.disabled, false);

    harness.button.click();

    assert.deepEqual(harness.scrollCalls, [[0, 0]]);
    assert.equal(globalThis.window.scrollY, 0);
    assert.equal(harness.button.disabled, true);
    assert.equal(harness.button.blurCount, 1);
});
