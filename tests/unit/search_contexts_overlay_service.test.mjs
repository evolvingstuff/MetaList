import assert from 'node:assert/strict';
import test from 'node:test';

function createClassList(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        add(name) {
            classes.add(name);
        },
        remove(name) {
            classes.delete(name);
        },
        contains(name) {
            return classes.has(name);
        },
    };
}

function createFakeElement({
    classNames = [],
    innerHTML = '',
    rect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 },
} = {}) {
    const listeners = new Map();
    return {
        classList: createClassList(classNames),
        innerHTML,
        style: {},
        getBoundingClientRect() {
            return rect;
        },
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        dispatchEvent(event) {
            listeners.get(event.type)?.(event);
        },
    };
}

function installOverlayDom(t, {
    isTabUiEnabled,
    tabRowsHtml = '<button>Default</button>',
    searchContextsRect = { left: 0, right: 220, top: 0, bottom: 160, width: 220, height: 160 },
    hoverZoneRect = { left: 20, right: 100, top: 10, bottom: 44, width: 80, height: 34 },
    controlsRect = { left: 120, right: 680, top: 0, bottom: 60, width: 560, height: 60 },
} = {}) {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalHTMLElement = globalThis.HTMLElement;

    class FakeHTMLElement {}

    const body = new FakeHTMLElement();
    Object.assign(body, createFakeElement({
        classNames: isTabUiEnabled ? ['pref-show-tab-ui'] : [],
    }));
    const searchContextsList = new FakeHTMLElement();
    Object.assign(searchContextsList, createFakeElement({
        innerHTML: tabRowsHtml,
        rect: searchContextsRect,
    }));
    const hoverZone = new FakeHTMLElement();
    Object.assign(hoverZone, createFakeElement({ rect: hoverZoneRect }));
    const controls = new FakeHTMLElement();
    Object.assign(controls, createFakeElement({ rect: controlsRect }));

    globalThis.HTMLElement = FakeHTMLElement;
    globalThis.document = {
        body,
        querySelector(selector) {
            if (selector === '#search-contexts-list') {
                return searchContextsList;
            }
            if (selector === '#tab-hover-zone') {
                return hoverZone;
            }
            if (selector === '.controls') {
                return controls;
            }
            return null;
        },
    };
    globalThis.window = {
        innerWidth: 1024,
        getComputedStyle() {
            return { display: searchContextsList.style.display || 'none' };
        },
    };

    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.HTMLElement = originalHTMLElement;
    });

    return { searchContextsList, hoverZone };
}

test('showSearchContextsOverlay positions visible tab popover from controls and hover zone', async (t) => {
    const { searchContextsList } = installOverlayDom(t, { isTabUiEnabled: true });

    const {
        isSearchContextsOverlayBottomLeft,
        showSearchContextsOverlay,
    } = await import('../../app/static/js/modules/mode-manager/services/search-contexts-overlay-service.js');

    assert.equal(showSearchContextsOverlay(), true);
    assert.equal(searchContextsList.style.display, 'block');
    assert.equal(searchContextsList.style.left, '120px');
    assert.equal(searchContextsList.style.top, '50px');
    assert.equal(searchContextsList.style.right, 'auto');
    assert.equal(searchContextsList.style.bottom, 'auto');
    assert.equal(searchContextsList.classList.contains('search-contexts-list--hover'), true);
    assert.equal(isSearchContextsOverlayBottomLeft(), false);
});

test('updateSearchContextsOverlayPlacement hides tab popover when tab UI is disabled', async (t) => {
    const { searchContextsList } = installOverlayDom(t, { isTabUiEnabled: false });
    searchContextsList.style.display = 'block';

    const {
        isSearchContextsOverlayBottomLeft,
        updateSearchContextsOverlayPlacement,
    } = await import('../../app/static/js/modules/mode-manager/services/search-contexts-overlay-service.js');

    assert.equal(updateSearchContextsOverlayPlacement(), false);
    assert.equal(searchContextsList.style.display, 'none');
    assert.equal(isSearchContextsOverlayBottomLeft(), false);
});

test('isSearchContextsKeyboardCreateActive is true while pointer is over tab hover zone', async (t) => {
    installOverlayDom(t, { isTabUiEnabled: true });

    const {
        hideSearchContextsOverlayForPointerMove,
        isSearchContextsKeyboardCreateActive,
        showSearchContextsOverlay,
    } = await import('../../app/static/js/modules/mode-manager/services/search-contexts-overlay-service.js');

    assert.equal(showSearchContextsOverlay(), true);
    assert.equal(hideSearchContextsOverlayForPointerMove({
        pointerClientX: 50,
        pointerClientY: 25,
    }), false);
    assert.equal(isSearchContextsKeyboardCreateActive(), true);
});

test('isSearchContextsKeyboardCreateActive is true while pointer is over search context list', async (t) => {
    installOverlayDom(t, { isTabUiEnabled: true });

    const {
        hideSearchContextsOverlayForPointerMove,
        isSearchContextsKeyboardCreateActive,
        showSearchContextsOverlay,
    } = await import('../../app/static/js/modules/mode-manager/services/search-contexts-overlay-service.js');

    assert.equal(showSearchContextsOverlay(), true);
    assert.equal(hideSearchContextsOverlayForPointerMove({
        pointerClientX: 200,
        pointerClientY: 100,
    }), false);
    assert.equal(isSearchContextsKeyboardCreateActive(), true);
});

test('isSearchContextsKeyboardCreateActive is false outside exact hover and list bounds', async (t) => {
    installOverlayDom(t, { isTabUiEnabled: true });

    const {
        hideSearchContextsOverlayForPointerMove,
        isSearchContextsKeyboardCreateActive,
        showSearchContextsOverlay,
    } = await import('../../app/static/js/modules/mode-manager/services/search-contexts-overlay-service.js');

    assert.equal(showSearchContextsOverlay(), true);
    assert.equal(hideSearchContextsOverlayForPointerMove({
        pointerClientX: 230,
        pointerClientY: 170,
    }), false);
    assert.equal(isSearchContextsKeyboardCreateActive(), false);
});

test('isSearchContextsKeyboardCreateActive is false after overlay hides', async (t) => {
    installOverlayDom(t, { isTabUiEnabled: true });

    const {
        hideSearchContextsOverlay,
        hideSearchContextsOverlayForPointerMove,
        isSearchContextsKeyboardCreateActive,
        showSearchContextsOverlay,
    } = await import('../../app/static/js/modules/mode-manager/services/search-contexts-overlay-service.js');

    assert.equal(showSearchContextsOverlay(), true);
    assert.equal(hideSearchContextsOverlay(), true);
    assert.equal(hideSearchContextsOverlayForPointerMove({
        pointerClientX: 50,
        pointerClientY: 25,
    }), false);
    assert.equal(isSearchContextsKeyboardCreateActive(), false);
});

test('startup pointer observations allow unchanged axes and repeated positions while hidden', async (t) => {
    installOverlayDom(t, { isTabUiEnabled: true });
    const { hideSearchContextsOverlayForPointerMove } = await import(
        '../../app/static/js/modules/mode-manager/services/search-contexts-overlay-service.js?startup-pointer-regression'
    );
    for (const [pointerClientX, pointerClientY] of [[50, 25], [50, 26], [51, 26], [51, 26]]) {
        assert.equal(hideSearchContextsOverlayForPointerMove({ pointerClientX, pointerClientY }), false);
    }
});

test('hover and document handlers can observe the same pointer event and still dismiss on one-axis movement', async (t) => {
    const { searchContextsList, hoverZone } = installOverlayDom(t, { isTabUiEnabled: true });
    const {
        initializeSearchContextsHover,
        hideSearchContextsOverlayForPointerMove,
        isSearchContextsKeyboardCreateActive,
    } = await import('../../app/static/js/modules/mode-manager/services/search-contexts-overlay-service.js?hover-pointer-regression');
    initializeSearchContextsHover();
    hoverZone.dispatchEvent({ type: 'mouseenter', clientX: 50, clientY: 25 });
    hoverZone.dispatchEvent({ type: 'mousemove', clientX: 50, clientY: 25 });
    assert.equal(hideSearchContextsOverlayForPointerMove({ pointerClientX: 50, pointerClientY: 25 }), false);
    assert.equal(isSearchContextsKeyboardCreateActive(), true);

    // Remain in the dismissal buffer, but leave the exact keyboard-create bounds.
    assert.equal(hideSearchContextsOverlayForPointerMove({ pointerClientX: 50, pointerClientY: 170 }), false);
    assert.equal(isSearchContextsKeyboardCreateActive(), false);
    assert.equal(hideSearchContextsOverlayForPointerMove({ pointerClientX: 50, pointerClientY: 200 }), true);
    assert.equal(searchContextsList.style.display, 'none');
});
