import assert from 'node:assert/strict';
import test from 'node:test';

import {
    hideContextMenu,
    showContextMenu,
} from '../../app/static/js/modules/context-menu/context-menu-service.js';

test('context menus without close callbacks support repeated open and dismissal lifecycles', async () => {
    const { hideContextMenu, showContextMenu } = await import('../../app/static/js/modules/context-menu/context-menu-service.js?null-close');
    const dom = installFakeDom();
    try {
        for (let count = 0; count < 2; count += 1) {
            showContextMenu({ items: [{ id: 'clear', label: 'Remove Formatting', enabled: true, onSelect() {} }], position: {x: 20, y: 20}, onClose: null });
            hideContextMenu();
            hideContextMenu();
        }
    } finally {
        hideContextMenu();
        dom.restore();
    }
});


class FakeClassList {
    constructor() {
        this.values = new Set();
    }

    add(...classNames) {
        classNames.forEach((className) => this.values.add(className));
    }

    remove(...classNames) {
        classNames.forEach((className) => this.values.delete(className));
    }

    contains(className) {
        return this.values.has(className);
    }
}


class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.id = '';
        this.classList = new FakeClassList();
        this._className = '';
        this.style = {};
        this.dataset = {};
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.listeners = new Map();
        this.disabled = false;
        this.focusCount = 0;
        this.textContent = '';
    }

    set className(value) {
        this._className = value;
        this.classList = new FakeClassList();
        value.split(/\s+/).filter(Boolean).forEach((className) => this.classList.add(className));
    }

    get className() {
        return this._className;
    }

    set innerHTML(value) {
        assert.equal(value, '');
        this.children = [];
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    dispatch(type) {
        const listener = this.listeners.get(type);
        assert.equal(typeof listener, 'function');
        listener({ target: this });
    }

    contains(candidate) {
        if (candidate === this) {
            return true;
        }
        return this.children.some((child) => child.contains(candidate));
    }

    querySelector(selector) {
        assert.equal(selector, '.context-menu-item:not(:disabled)');
        return this.children.find((child) => (
            child.classList.contains('context-menu-item') && !child.disabled
        )) ?? null;
    }

    getBoundingClientRect() {
        if (this.classList.contains('context-menu-item')) {
            return { left: 100, right: 300, top: 100, width: 200, height: 32 };
        }
        return { left: 100, right: 300, top: 100, width: 200, height: 240 };
    }

    focus() {
        this.focusCount += 1;
        this.ownerDocument.activeElement = this;
    }
}


class FakeButtonElement extends FakeElement {
    constructor(ownerDocument) {
        super('button', ownerDocument);
        this.type = 'button';
    }
}


function installFakeDom() {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalElement = globalThis.Element;
    const originalHtmlButtonElement = globalThis.HTMLButtonElement;

    const fakeDocument = {
        activeElement: null,
        listeners: new Map(),
        addEventListener(type, listener) {
            this.listeners.set(type, listener);
        },
        createElement(tagName) {
            if (tagName === 'button') {
                return new FakeButtonElement(this);
            }
            return new FakeElement(tagName, this);
        },
        createElementNS(_namespace, tagName) {
            return new FakeElement(tagName, this);
        },
    };
    fakeDocument.body = new FakeElement('body', fakeDocument);

    globalThis.document = fakeDocument;
    globalThis.window = {
        innerWidth: 1200,
        innerHeight: 800,
        addEventListener() {},
    };
    globalThis.Element = FakeElement;
    globalThis.HTMLButtonElement = FakeButtonElement;

    return {
        fakeDocument,
        restore() {
            globalThis.document = originalDocument;
            globalThis.window = originalWindow;
            globalThis.Element = originalElement;
            globalThis.HTMLButtonElement = originalHtmlButtonElement;
        },
    };
}


test('context menu renders submenu actions and a non-interactive info footer', () => {
    const dom = installFakeDom();
    try {
        showContextMenu({
            items: [{
                id: 'add-style',
                label: 'Add Style',
                enabled: true,
                submenu: [{
                    id: 'add-style-highlighter',
                    label: 'Highlighter',
                    enabled: true,
                    onSelect() {},
                }],
            }],
            position: { x: 100, y: 100 },
        });

        const rootMenu = dom.fakeDocument.body.children.find(
            (element) => element.id === 'context-menu',
        );
        assert.ok(rootMenu);
        assert.equal(rootMenu.children.length, 1);

        rootMenu.children[0].dispatch('mouseenter');

        const submenu = dom.fakeDocument.body.children.find(
            (element) => element.id === 'context-submenu',
        );
        assert.ok(submenu);
        assert.equal(submenu.style.display, 'block');
        assert.equal(submenu.children.length, 1);
        assert.equal(submenu.children[0].focusCount, 0);
        assert.equal(dom.fakeDocument.activeElement, null);

        rootMenu.children[0].dispatch('focus');

        assert.equal(submenu.children.length, 1);
        assert.equal(submenu.children[0].focusCount, 1);
        assert.equal(dom.fakeDocument.activeElement, submenu.children[0]);

        hideContextMenu();
        showContextMenu({
            items: [
                {
                    id: 'copy-note',
                    label: 'Copy Note',
                    enabled: true,
                    onSelect() {},
                },
                {
                    id: 'note-timestamps',
                    kind: 'info',
                    label: 'Note timestamps',
                    rows: [
                        { label: 'Created', value: 'Aug 17, 2026, 11:00 AM' },
                        { label: 'Updated', value: 'Aug 17, 2026, 12:45 PM' },
                    ],
                },
            ],
            position: { x: 100, y: 100 },
        });

        assert.equal(rootMenu.children.length, 2);
        const footer = rootMenu.children[1];
        assert.equal(footer.tagName, 'DIV');
        assert.equal(footer.classList.contains('context-menu-info'), true);
        assert.equal(footer.attributes.get('role'), 'group');
        assert.equal(footer.attributes.get('aria-label'), 'Note timestamps');
        assert.equal(footer.children.length, 2);
        assert.deepEqual(
            footer.children.map((row) => row.children.map((cell) => cell.textContent)),
            [
                ['Created', 'Aug 17, 2026, 11:00 AM'],
                ['Updated', 'Aug 17, 2026, 12:45 PM'],
            ],
        );
    } finally {
        hideContextMenu();
        dom.restore();
    }
});
