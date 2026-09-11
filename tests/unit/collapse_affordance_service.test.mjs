import assert from 'node:assert/strict';
import test from 'node:test';

function installBrowserStorage(t) {
    const originalSessionStorage = globalThis.sessionStorage;
    const originalLocalStorage = globalThis.localStorage;
    const originalWindow = globalThis.window;

    function createStorage() {
        const entries = new Map();
        return {
            getItem(key) {
                return entries.has(key) ? entries.get(key) : null;
            },
            setItem(key, value) {
                entries.set(key, String(value));
            },
            removeItem(key) {
                entries.delete(key);
            },
            clear() {
                entries.clear();
            },
        };
    }

    globalThis.sessionStorage = createStorage();
    globalThis.localStorage = createStorage();
    globalThis.window = {};

    t.after(() => {
        globalThis.sessionStorage = originalSessionStorage;
        globalThis.localStorage = originalLocalStorage;
        globalThis.window = originalWindow;
    });
}

function createClassList(initialClasses = []) {
    const classes = new Set(initialClasses);
    return {
        add(className) {
            classes.add(className);
        },
        remove(className) {
            classes.delete(className);
        },
        contains(className) {
            return classes.has(className);
        },
    };
}

function createMeasuredContent({ rectHeight, scrollHeight }) {
    return {
        scrollHeight,
        getBoundingClientRect() {
            return { height: rectHeight };
        },
    };
}

function installComputedStyle(t, styles) {
    const originalWindow = globalThis.window;
    globalThis.window = {
        ...(originalWindow || {}),
        getComputedStyle() {
            return styles;
        },
    };

    t.after(() => {
        globalThis.window = originalWindow;
    });
}

function installRangeRects(t, rects) {
    const originalDocument = globalThis.document;
    globalThis.document = {
        createRange() {
            return {
                selectNodeContents() {},
                getClientRects() {
                    return rects;
                },
                detach() {},
            };
        },
    };

    t.after(() => {
        globalThis.document = originalDocument;
    });
}

function installRangeRectsBySelectedNode(t, rectsByNode) {
    const originalDocument = globalThis.document;
    globalThis.document = {
        createRange() {
            let selectedNode = null;
            return {
                selectNodeContents(node) {
                    selectedNode = node;
                },
                getClientRects() {
                    return rectsByNode.get(selectedNode) || [];
                },
                detach() {},
            };
        },
    };

    t.after(() => {
        globalThis.document = originalDocument;
    });
}

test('resolveCanCollapseFromDataset trusts only server isCollapsible flag', async (t) => {
    installBrowserStorage(t);
    const { resolveCanCollapseFromDataset } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    assert.equal(resolveCanCollapseFromDataset({ isCollapsible: 'true' }), true);
    assert.equal(resolveCanCollapseFromDataset({ isCollapsible: 'false' }), false);
    assert.equal(resolveCanCollapseFromDataset({}), false);
});

test('rendered multi-line content promotes server non-collapsible notes', async (t) => {
    installBrowserStorage(t);
    installComputedStyle(t, { lineHeight: '20px', fontSize: '16px' });
    const { updateCollapseAffordanceForNote } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    const contentElement = createMeasuredContent({ rectHeight: 41, scrollHeight: 41 });
    const collapseToggle = {
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        removeAttribute(name) {
            delete this.attributes[name];
        },
    };
    const noteElement = {
        classList: createClassList(['note']),
        dataset: {
            isCollapsed: 'false',
            isCollapsible: 'false',
            searchRedacted: 'false',
        },
        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return contentElement;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return collapseToggle;
            }
            throw new Error(`Unexpected selector: ${selector}`);
        },
    };

    updateCollapseAffordanceForNote(noteElement);

    assert.equal(noteElement.dataset.canCollapse, 'true');
    assert.equal(collapseToggle.attributes['aria-label'], 'Collapse note');
});

test('single rendered line box does not promote collapse despite tall element box', async (t) => {
    installBrowserStorage(t);
    installComputedStyle(t, { lineHeight: '20px', fontSize: '16px' });
    installRangeRects(t, [{ top: 10, width: 320, height: 24 }]);
    const { updateCollapseAffordanceForNote } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    const contentElement = createMeasuredContent({ rectHeight: 36, scrollHeight: 36 });
    const noteElement = {
        classList: createClassList(['note']),
        dataset: {
            isCollapsed: 'false',
            isCollapsible: 'false',
            searchRedacted: 'false',
        },
        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return contentElement;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return null;
            }
            throw new Error(`Unexpected selector: ${selector}`);
        },
    };

    updateCollapseAffordanceForNote(noteElement);

    assert.equal(noteElement.dataset.canCollapse, 'false');
});

test('same-line title and smaller domain boxes do not promote collapse', async (t) => {
    installBrowserStorage(t);
    installComputedStyle(t, { lineHeight: '20px', fontSize: '16px' });
    installRangeRects(t, [
        { top: 10, width: 310, height: 24 },
        { top: 14, width: 120, height: 18 },
    ]);
    const { updateCollapseAffordanceForNote } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    const contentElement = createMeasuredContent({ rectHeight: 36, scrollHeight: 36 });
    const noteElement = {
        classList: createClassList(['note']),
        dataset: {
            isCollapsed: 'false',
            isCollapsible: 'false',
            searchRedacted: 'false',
        },
        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return contentElement;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return null;
            }
            throw new Error(`Unexpected selector: ${selector}`);
        },
    };

    updateCollapseAffordanceForNote(noteElement);

    assert.equal(noteElement.dataset.canCollapse, 'false');
});

test('single-line status wrapper control does not promote collapse', async (t) => {
    installBrowserStorage(t);
    installComputedStyle(t, { lineHeight: '20px', fontSize: '16px' });
    const statusTextElement = createMeasuredContent({ rectHeight: 20, scrollHeight: 20 });
    const contentElement = {
        ...createMeasuredContent({ rectHeight: 36, scrollHeight: 36 }),
        querySelector(selector) {
            if (selector === ':scope > .meta-status > .meta-status-text, :scope > .note-with-backlinks > .meta-status > .meta-status-text') {
                return statusTextElement;
            }
            throw new Error(`Unexpected content selector: ${selector}`);
        },
    };
    installRangeRectsBySelectedNode(t, new Map([
        [
            contentElement,
            [
                { top: 10, width: 18, height: 18 },
                { top: 34, width: 180, height: 24 },
            ],
        ],
        [statusTextElement, [{ top: 34, width: 180, height: 24 }]],
    ]));
    const { updateCollapseAffordanceForNote } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    const noteElement = {
        classList: createClassList(['note']),
        dataset: {
            isCollapsed: 'false',
            hasChildren: 'false',
            isCollapsible: 'false',
            searchRedacted: 'false',
        },
        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return contentElement;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return null;
            }
            throw new Error(`Unexpected selector: ${selector}`);
        },
    };

    updateCollapseAffordanceForNote(noteElement);

    assert.equal(noteElement.dataset.canCollapse, 'false');
});

test('multi-line status wrapper text still promotes collapse', async (t) => {
    installBrowserStorage(t);
    installComputedStyle(t, { lineHeight: '20px', fontSize: '16px' });
    const statusTextElement = createMeasuredContent({ rectHeight: 44, scrollHeight: 44 });
    const contentElement = {
        ...createMeasuredContent({ rectHeight: 48, scrollHeight: 48 }),
        querySelector(selector) {
            if (selector === ':scope > .meta-status > .meta-status-text, :scope > .note-with-backlinks > .meta-status > .meta-status-text') {
                return statusTextElement;
            }
            throw new Error(`Unexpected content selector: ${selector}`);
        },
    };
    installRangeRectsBySelectedNode(t, new Map([
        [
            statusTextElement,
            [
                { top: 34, width: 180, height: 24 },
                { top: 58, width: 120, height: 24 },
            ],
        ],
    ]));
    const { updateCollapseAffordanceForNote } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    const noteElement = {
        classList: createClassList(['note']),
        dataset: {
            isCollapsed: 'false',
            hasChildren: 'false',
            isCollapsible: 'false',
            searchRedacted: 'false',
        },
        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return contentElement;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return null;
            }
            throw new Error(`Unexpected selector: ${selector}`);
        },
    };

    updateCollapseAffordanceForNote(noteElement);

    assert.equal(noteElement.dataset.canCollapse, 'true');
});

test('multiple rendered line boxes promote collapse', async (t) => {
    installBrowserStorage(t);
    installComputedStyle(t, { lineHeight: '20px', fontSize: '16px' });
    installRangeRects(t, [
        { top: 10, width: 320, height: 24 },
        { top: 34, width: 180, height: 24 },
    ]);
    const { updateCollapseAffordanceForNote } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    const contentElement = createMeasuredContent({ rectHeight: 36, scrollHeight: 36 });
    const noteElement = {
        classList: createClassList(['note']),
        dataset: {
            isCollapsed: 'false',
            isCollapsible: 'false',
            searchRedacted: 'false',
        },
        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return contentElement;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return null;
            }
            throw new Error(`Unexpected selector: ${selector}`);
        },
    };

    updateCollapseAffordanceForNote(noteElement);

    assert.equal(noteElement.dataset.canCollapse, 'true');
});

test('rendered collapse promotion preserves saved collapsed state', async (t) => {
    installBrowserStorage(t);
    installComputedStyle(t, { lineHeight: '20px', fontSize: '16px' });
    const { updateCollapseAffordanceForNote } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    const contentElement = createMeasuredContent({ rectHeight: 41, scrollHeight: 41 });
    const noteClassList = createClassList(['note', 'collapsed']);
    const collapseToggle = {
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        removeAttribute(name) {
            delete this.attributes[name];
        },
    };
    const noteElement = {
        classList: noteClassList,
        dataset: {
            isCollapsed: 'true',
            isCollapsible: 'false',
            searchRedacted: 'false',
        },
        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return contentElement;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return collapseToggle;
            }
            throw new Error(`Unexpected selector: ${selector}`);
        },
    };

    updateCollapseAffordanceForNote(noteElement);

    assert.equal(noteElement.dataset.canCollapse, 'true');
    assert.equal(noteClassList.contains('collapsed'), true);
    assert.equal(collapseToggle.attributes['aria-label'], 'Expand note');
});

test('editing childless note ignores content-only collapse promotion', async (t) => {
    installBrowserStorage(t);
    installComputedStyle(t, { lineHeight: '20px', fontSize: '16px' });
    const { updateCollapseAffordanceForNote } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    const contentElement = createMeasuredContent({ rectHeight: 48, scrollHeight: 48 });
    const noteClassList = createClassList(['note', 'editing']);
    const collapseToggle = {
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        removeAttribute(name) {
            delete this.attributes[name];
        },
    };
    const noteElement = {
        classList: noteClassList,
        dataset: {
            isCollapsed: 'false',
            hasChildren: 'false',
            isCollapsible: 'true',
            searchRedacted: 'false',
        },
        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return contentElement;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return collapseToggle;
            }
            throw new Error(`Unexpected selector: ${selector}`);
        },
    };

    updateCollapseAffordanceForNote(noteElement);

    assert.equal(noteElement.dataset.canCollapse, 'false');
    assert.equal(noteClassList.contains('collapsed'), false);
    assert.equal(collapseToggle.attributes['aria-label'], 'Collapse note');
});

test('editing note with children keeps collapse affordance', async (t) => {
    installBrowserStorage(t);
    installComputedStyle(t, { lineHeight: '20px', fontSize: '16px' });
    const { updateCollapseAffordanceForNote } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    const contentElement = createMeasuredContent({ rectHeight: 20, scrollHeight: 20 });
    const noteClassList = createClassList(['note', 'editing', 'collapsed']);
    const collapseToggle = {
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        removeAttribute(name) {
            delete this.attributes[name];
        },
    };
    const noteElement = {
        classList: noteClassList,
        dataset: {
            isCollapsed: 'true',
            hasChildren: 'true',
            isCollapsible: 'true',
            searchRedacted: 'false',
        },
        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return contentElement;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return collapseToggle;
            }
            throw new Error(`Unexpected selector: ${selector}`);
        },
    };

    updateCollapseAffordanceForNote(noteElement);

    assert.equal(noteElement.dataset.canCollapse, 'true');
    assert.equal(noteClassList.contains('collapsed'), true);
    assert.equal(collapseToggle.attributes['aria-label'], 'Expand note');
});

test('search redaction blocks rendered-height collapse promotion', async (t) => {
    installBrowserStorage(t);
    installComputedStyle(t, { lineHeight: '20px', fontSize: '16px' });
    const { updateCollapseAffordanceForNote } = await import(
        '../../app/static/js/modules/mode-manager/services/collapse-affordance-service.js'
    );

    const contentElement = createMeasuredContent({ rectHeight: 41, scrollHeight: 41 });
    const noteElement = {
        classList: createClassList(['note']),
        dataset: {
            isCollapsed: 'false',
            isCollapsible: 'false',
            searchRedacted: 'true',
        },
        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return contentElement;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return null;
            }
            throw new Error(`Unexpected selector: ${selector}`);
        },
    };

    updateCollapseAffordanceForNote(noteElement);

    assert.equal(noteElement.dataset.canCollapse, 'false');
});
