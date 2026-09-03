import assert from 'node:assert/strict';
import test from 'node:test';

function installBrowserEnvironment(t, options = {}) {
    const animatedTransitions = Boolean(options.animatedTransitions);
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalHTMLImageElement = globalThis.HTMLImageElement;
    const originalSessionStorage = globalThis.sessionStorage;
    const originalLocalStorage = globalThis.localStorage;
    let querySelectorAllCalls = 0;

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

    class FakeClassList {
        constructor(initialClasses = []) {
            this.classes = new Set(initialClasses);
        }

        add(...classNames) {
            for (const className of classNames) {
                this.classes.add(className);
            }
        }

        remove(...classNames) {
            for (const className of classNames) {
                this.classes.delete(className);
            }
        }

        contains(className) {
            return this.classes.has(className);
        }

        toggle(className, force) {
            const shouldHaveClass = typeof force === 'boolean' ? force : !this.classes.has(className);
            if (shouldHaveClass) {
                this.classes.add(className);
            } else {
                this.classes.delete(className);
            }
            return shouldHaveClass;
        }
    }

    class FakeElement {
        constructor(tagName) {
            this.tagName = tagName.toUpperCase();
            this.children = [];
            this.dataset = {};
            this.attributes = {};
            this.classList = new FakeClassList();
            this.parentElement = null;
            this.isConnected = false;
            this.contentEditable = 'false';
            this.textContent = '';
            this.type = '';
            this.style = {};
            this.listeners = new Map();
            this._innerHTML = '';
        }

        get firstChild() {
            return this.children.length > 0 ? this.children[0] : null;
        }

        get innerHTML() {
            return this._innerHTML;
        }

        set innerHTML(value) {
            this._innerHTML = String(value);
        }

        appendChild(child) {
            if (child.parentElement) {
                child.remove();
            }
            child.parentElement = this;
            setTreeConnection(child, this.isConnected);
            this.children.push(child);
            return child;
        }

        insertBefore(child, reference) {
            if (child.parentElement) {
                child.remove();
            }
            child.parentElement = this;
            setTreeConnection(child, this.isConnected);
            if (reference === null || typeof reference === 'undefined') {
                this.children.push(child);
                return child;
            }
            const index = this.children.indexOf(reference);
            if (index === -1) {
                throw new Error('insertBefore reference is not a child');
            }
            this.children.splice(index, 0, child);
            return child;
        }

        after(child) {
            if (!this.parentElement) {
                throw new Error('Cannot insert after detached element');
            }
            const nextIndex = this.parentElement.children.indexOf(this) + 1;
            const nextSibling = this.parentElement.children[nextIndex] || null;
            this.parentElement.insertBefore(child, nextSibling);
        }

        remove() {
            if (!this.parentElement) {
                return;
            }
            const siblings = this.parentElement.children;
            const index = siblings.indexOf(this);
            if (index !== -1) {
                siblings.splice(index, 1);
            }
            this.parentElement = null;
            setTreeConnection(this, false);
        }

        cloneNode(deep = false) {
            const clone = new FakeElement(this.tagName);
            clone.dataset = { ...this.dataset };
            clone.attributes = { ...this.attributes };
            clone.classList = new FakeClassList(Array.from(this.classList.classes));
            clone.contentEditable = this.contentEditable;
            clone.textContent = this.textContent;
            clone.type = this.type;
            clone.style = { ...this.style };
            clone._innerHTML = this._innerHTML;
            if (deep) {
                for (const child of this.children) {
                    clone.appendChild(child.cloneNode(true));
                }
            }
            return clone;
        }

        setAttribute(name, value) {
            this.attributes[name] = String(value);
        }

        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name)
                ? this.attributes[name]
                : null;
        }

        removeAttribute(name) {
            delete this.attributes[name];
        }

        querySelector(selector) {
            if (selector === ':scope > .note-content') {
                return this.children.find((child) => child.classList.contains('note-content')) || null;
            }
            if (selector === ':scope > .note-collapse-toggle') {
                return this.children.find((child) => child.classList.contains('note-collapse-toggle')) || null;
            }
            if (selector === ':scope > .note-children') {
                return this.children.find((child) => child.classList.contains('note-children')) || null;
            }
            return null;
        }

        querySelectorAll(selector) {
            querySelectorAllCalls += 1;
            if (selector === 'a[href]' || selector === '.note-file-image-embed[data-file-ref-id]') {
                return [];
            }
            if (selector === '[data-note-id]') {
                const matches = [];
                const visit = (node) => {
                    for (const child of node.children) {
                        if (child.dataset && typeof child.dataset.noteId === 'string') {
                            matches.push(child);
                        }
                        visit(child);
                    }
                };
                visit(this);
                return matches;
            }
            return [];
        }

        getBoundingClientRect() {
            if (!this.classList.contains('note')) {
                return { height: 20 };
            }
            if (this.classList.contains('collapsed')) {
                return { height: 20 };
            }
            const childContainer = this.children.find((child) => child.classList.contains('note-children'));
            const visibleChildCount = childContainer
                ? childContainer.children.filter((child) => child.style.display !== 'none').length
                : 0;
            const childHeight = visibleChildCount * 60;
            return { height: 20 + childHeight };
        }

        get scrollHeight() {
            return 20;
        }

        addEventListener(eventName, handler) {
            if (typeof eventName !== 'string' || typeof handler !== 'function') {
                throw new Error('FakeElement.addEventListener requires eventName and handler');
            }
            this.listeners.set(eventName, handler);
        }

        dispatchTransitionEnd(propertyName) {
            const handler = this.listeners.get('transitionend');
            if (typeof handler !== 'function') {
                throw new Error('transitionend handler missing');
            }
            handler({ propertyName });
        }
    }

    class FakeImageElement extends FakeElement {}

    function setTreeConnection(element, isConnected) {
        element.isConnected = isConnected;
        for (const child of element.children) {
            setTreeConnection(child, isConnected);
        }
    }

    const elementByNoteId = new Map();
    const body = new FakeElement('body');
    body.isConnected = true;
    if (animatedTransitions) {
        body.classList.add('pref-animated-transitions');
    }
    const notesContainer = new FakeElement('div');
    notesContainer.isConnected = true;
    const animationFrames = [];
    const timeouts = [];

    const document = {
        createElement(tagName) {
            return tagName.toLowerCase() === 'img'
                ? new FakeImageElement(tagName)
                : new FakeElement(tagName);
        },
        createRange() {
            return {
                selectNodeContents() {},
                getClientRects() {
                    return [{ top: 0, width: 100, height: 20 }];
                },
                detach() {},
            };
        },
        getElementById(id) {
            return id === 'notes-container' ? notesContainer : null;
        },
        querySelector(selector) {
            const match = selector.match(/^\[data-note-id="([^"]+)"\]$/);
            if (!match) {
                return null;
            }
            const element = elementByNoteId.get(match[1]) || null;
            if (!element || !element.isConnected || element.dataset.noteId !== match[1]) {
                return null;
            }
            return element;
        },
        querySelectorAll() {
            return [];
        },
        body,
    };

    globalThis.HTMLElement = FakeElement;
    globalThis.HTMLImageElement = FakeImageElement;
    globalThis.document = document;
    globalThis.window = {
        addEventListener() {},
        getComputedStyle() {
            return { lineHeight: '20px', fontSize: '16px' };
        },
        requestAnimationFrame(callback) {
            if (typeof callback !== 'function') {
                throw new Error('requestAnimationFrame requires callback');
            }
            animationFrames.push(callback);
        },
        setTimeout(callback) {
            if (typeof callback !== 'function') {
                throw new Error('setTimeout requires callback');
            }
            timeouts.push(callback);
        },
    };
    globalThis.sessionStorage = createStorage();
    globalThis.localStorage = createStorage();

    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.HTMLElement = originalHTMLElement;
        globalThis.HTMLImageElement = originalHTMLImageElement;
        globalThis.sessionStorage = originalSessionStorage;
        globalThis.localStorage = originalLocalStorage;
    });

    return {
        createElement: (tagName) => document.createElement(tagName),
        elementByNoteId,
        notesContainer,
        getQuerySelectorAllCalls() {
            return querySelectorAllCalls;
        },
        runAnimationFrame() {
            const callback = animationFrames.shift();
            if (typeof callback !== 'function') {
                throw new Error('animation frame callback missing');
            }
            callback();
        },
        runTimeout() {
            const callback = timeouts.shift();
            if (typeof callback !== 'function') {
                throw new Error('timeout callback missing');
            }
            callback();
        },
    };
}

test('empty server diff avoids full-tree media scans', async (t) => {
    const env = installBrowserEnvironment(t);
    const { applyDifferentialView } = await import(
        '../../app/static/js/modules/mode-manager/services/differential-view-service.js'
    );

    const result = applyDifferentialView({
        currentClientId: 'client-1',
        editingNoteId: null,
        diffOps: [],
        locks: {},
        lockDiffs: {},
        notes: {},
    }, {});

    assert.equal(result.vdomOperations, 0);
    assert.equal(env.getQuerySelectorAllCalls(), 0);
});

test('lock-only server diff avoids full-tree media scans', async (t) => {
    const env = installBrowserEnvironment(t);
    const { applyDifferentialView } = await import(
        '../../app/static/js/modules/mode-manager/services/differential-view-service.js'
    );

    const result = applyDifferentialView({
        currentClientId: 'client-1',
        editingNoteId: null,
        diffOps: [],
        locks: {},
        lockDiffs: { missing: 'client-2' },
        notes: {},
    }, {});

    assert.equal(result.vdomOperations, 0);
    assert.equal(env.getQuerySelectorAllCalls(), 0);
});

test('diff refresh preserves current editor content after edit-session changes', async (t) => {
    const env = installBrowserEnvironment(t);
    const { ModeContextInstance: ModeContext } = await import(
        '../../app/static/js/modules/mode-manager/mode-context.js'
    );
    const { applyDifferentialView } = await import(
        '../../app/static/js/modules/mode-manager/services/differential-view-service.js'
    );

    ModeContext._editing = true;
    ModeContext._dirty = false;
    ModeContext._currentNoteId = 'parent-note';
    ModeContext._editSessionHasEdits = true;

    const noteElement = env.createElement('div');
    noteElement.classList.add('note', 'editing', 'interactive');
    noteElement.dataset.noteId = 'parent-note';
    noteElement.dataset.parentId = '';
    noteElement.dataset.contentHash = 'hash-before-child-toggle';
    noteElement.dataset.snapshotHash = 'hash-before-child-toggle';
    noteElement.dataset.lockOwner = 'client-1';
    noteElement.dataset.isCollapsed = 'false';
    noteElement.dataset.hasChildren = 'true';
    noteElement.dataset.isCollapsible = 'true';
    noteElement.dataset.noteTags = '';
    noteElement.dataset.searchRedacted = 'false';

    const collapseToggle = env.createElement('button');
    collapseToggle.classList.add('note-collapse-toggle');
    noteElement.appendChild(collapseToggle);

    const contentElement = env.createElement('div');
    contentElement.classList.add('note-content');
    contentElement.innerHTML = 'server content plus typed edit';
    noteElement.appendChild(contentElement);

    const tagsElement = env.createElement('div');
    tagsElement.classList.add('note-tags');
    noteElement.appendChild(tagsElement);

    env.notesContainer.appendChild(noteElement);
    env.elementByNoteId.set('parent-note', noteElement);

    const result = applyDifferentialView({
        currentClientId: 'client-1',
        editingNoteId: 'parent-note',
        diffOps: [],
        locks: {
            'parent-note': 'client-1',
        },
        lockDiffs: {},
        notes: {
            'parent-note': {
                content: 'server content',
                hash: 'hash-after-child-toggle',
                tags: '',
                proposedTags: '',
                flags: {
                    isEditing: true,
                    isCollapsed: false,
                    hasChildren: true,
                    isCollapsible: true,
                    proposalCount: 0,
                },
            },
        },
    }, {});

    assert.equal(contentElement.innerHTML, 'server content plus typed edit');
    assert.equal(result.vdomOperations, 0);
    assert.equal(noteElement.dataset.snapshotHash, 'hash-after-child-toggle');
    assert.equal(noteElement.dataset.contentHash, 'hash-before-child-toggle');
});

test('editing payload renders direct proposals without requiring a lock entry', async (t) => {
    const env = installBrowserEnvironment(t);
    const { ModeContextInstance: ModeContext } = await import(
        '../../app/static/js/modules/mode-manager/mode-context.js'
    );
    const { applyDifferentialView } = await import(
        '../../app/static/js/modules/mode-manager/services/differential-view-service.js'
    );

    ModeContext._editing = true;
    ModeContext._dirty = false;
    ModeContext._currentNoteId = 'proposal-note';
    ModeContext._editSessionHasEdits = false;

    const noteElement = env.createElement('div');
    noteElement.classList.add('note', 'interactive');
    noteElement.dataset.noteId = 'proposal-note';
    noteElement.dataset.parentId = '';
    noteElement.dataset.contentHash = 'before-proposals';
    noteElement.dataset.snapshotHash = 'before-proposals';
    noteElement.dataset.lockOwner = '';
    noteElement.dataset.isCollapsed = 'false';
    noteElement.dataset.hasChildren = 'false';
    noteElement.dataset.isCollapsible = 'false';
    noteElement.dataset.noteTags = 'scratchpad';
    noteElement.dataset.searchRedacted = 'false';

    const collapseToggle = env.createElement('button');
    collapseToggle.classList.add('note-collapse-toggle');
    noteElement.appendChild(collapseToggle);
    const contentElement = env.createElement('div');
    contentElement.classList.add('note-content');
    noteElement.appendChild(contentElement);
    const tagsElement = env.createElement('div');
    tagsElement.classList.add('note-tags');
    noteElement.appendChild(tagsElement);

    env.notesContainer.appendChild(noteElement);
    env.elementByNoteId.set('proposal-note', noteElement);

    applyDifferentialView({
        currentClientId: 'client-1',
        editingNoteId: 'proposal-note',
        diffOps: [],
        locks: {},
        lockDiffs: {},
        notes: {
            'proposal-note': {
                content: 'baz',
                hash: 'with-proposals',
                tags: 'scratchpad',
                proposedTags: 'robot-one robot-two robot-three',
                flags: {
                    isEditing: true,
                    isCollapsed: false,
                    hasChildren: false,
                    isCollapsible: false,
                    proposalCount: 3,
                },
            },
        },
    }, {});

    const proposalRow = noteElement.children.find(
        (child) => child.classList.contains('note-tag-proposals'),
    );
    assert.ok(proposalRow);
    assert.equal(proposalRow.children.length, 3);
});

test('diff refresh animates note collapse from pre-diff height', async (t) => {
    const env = installBrowserEnvironment(t, { animatedTransitions: true });
    const { applyDifferentialView } = await import(
        '../../app/static/js/modules/mode-manager/services/differential-view-service.js'
    );

    const parentElement = env.createElement('div');
    parentElement.classList.add('note', 'interactive');
    parentElement.dataset.noteId = 'parent-note';
    parentElement.dataset.parentId = '';
    parentElement.dataset.contentHash = 'parent-expanded';
    parentElement.dataset.snapshotHash = 'parent-expanded';
    parentElement.dataset.lockOwner = '';
    parentElement.dataset.isCollapsed = 'false';
    parentElement.dataset.hasChildren = 'true';
    parentElement.dataset.isCollapsible = 'true';
    parentElement.dataset.noteTags = '';
    parentElement.dataset.searchRedacted = 'false';

    const parentToggle = env.createElement('button');
    parentToggle.classList.add('note-collapse-toggle');
    parentElement.appendChild(parentToggle);

    const parentContent = env.createElement('div');
    parentContent.classList.add('note-content');
    parentContent.innerHTML = 'expanded parent';
    parentElement.appendChild(parentContent);

    const parentTags = env.createElement('div');
    parentTags.classList.add('note-tags');
    parentElement.appendChild(parentTags);

    const childContainer = env.createElement('div');
    childContainer.classList.add('note-children');
    parentElement.appendChild(childContainer);

    const childElement = env.createElement('div');
    childElement.classList.add('note', 'interactive');
    childElement.dataset.noteId = 'child-note';
    childElement.dataset.parentId = 'parent-note';
    childElement.dataset.isCollapsed = 'false';
    childContainer.appendChild(childElement);

    env.notesContainer.appendChild(parentElement);
    env.elementByNoteId.set('parent-note', parentElement);
    env.elementByNoteId.set('child-note', childElement);

    assert.equal(parentElement.getBoundingClientRect().height, 80);

    applyDifferentialView({
        currentClientId: 'client-1',
        editingNoteId: null,
        diffOps: [
            { type: 'remove', noteId: 'child-note', parentId: 'parent-note' },
        ],
        locks: {},
        lockDiffs: {},
        notes: {
            'parent-note': {
                content: 'collapsed parent',
                hash: 'parent-collapsed',
                tags: '',
                proposedTags: '',
                flags: {
                    isEditing: false,
                    isCollapsed: true,
                    hasChildren: true,
                    isCollapsible: true,
                    proposalCount: 0,
                },
            },
        },
    }, {});

    assert.equal(env.notesContainer.children.includes(parentElement), true);
    assert.equal(env.notesContainer.children.length, 1);
    assert.equal(childContainer.children.includes(childElement), true);
    assert.equal(childElement.style.pointerEvents, 'none');
    assert.equal(childElement.style.display, '');
    assert.equal(parentElement.classList.contains('is-collapse-transitioning'), true);
    assert.equal(parentElement.style.height, '80px');
    assert.equal(parentElement.style.boxSizing, 'border-box');
    assert.equal(parentElement.style.overflow, 'hidden');

    env.runAnimationFrame();

    assert.equal(parentElement.style.height, '20px');

    parentElement.dispatchTransitionEnd('height');

    assert.equal(env.notesContainer.children.includes(parentElement), true);
    assert.equal(childContainer.children.includes(childElement), false);
    assert.equal(parentElement.classList.contains('is-collapse-transitioning'), false);
    assert.equal(parentElement.style.height, '');
    assert.equal(parentElement.style.boxSizing, '');
    assert.equal(parentElement.style.overflow, '');

    env.runTimeout();
});

test('diff refresh removes collapsed descendants immediately when note animations are disabled', async (t) => {
    const env = installBrowserEnvironment(t, { animatedTransitions: true });
    const { applyDifferentialView } = await import(
        '../../app/static/js/modules/mode-manager/services/differential-view-service.js'
    );

    const parentElement = env.createElement('div');
    parentElement.classList.add('note', 'interactive');
    parentElement.dataset.noteId = 'parent-note';
    parentElement.dataset.parentId = '';
    parentElement.dataset.contentHash = 'parent-expanded';
    parentElement.dataset.snapshotHash = 'parent-expanded';
    parentElement.dataset.lockOwner = '';
    parentElement.dataset.isCollapsed = 'false';
    parentElement.dataset.hasChildren = 'true';
    parentElement.dataset.isCollapsible = 'true';
    parentElement.dataset.noteTags = '';
    parentElement.dataset.searchRedacted = 'false';

    const parentToggle = env.createElement('button');
    parentToggle.classList.add('note-collapse-toggle');
    parentElement.appendChild(parentToggle);

    const parentContent = env.createElement('div');
    parentContent.classList.add('note-content');
    parentContent.innerHTML = 'expanded parent';
    parentElement.appendChild(parentContent);

    const parentTags = env.createElement('div');
    parentTags.classList.add('note-tags');
    parentElement.appendChild(parentTags);

    const childContainer = env.createElement('div');
    childContainer.classList.add('note-children');
    parentElement.appendChild(childContainer);

    const childElement = env.createElement('div');
    childElement.classList.add('note', 'interactive');
    childElement.dataset.noteId = 'child-note';
    childElement.dataset.parentId = 'parent-note';
    childElement.dataset.isCollapsed = 'false';
    childContainer.appendChild(childElement);

    env.notesContainer.appendChild(parentElement);
    env.elementByNoteId.set('parent-note', parentElement);
    env.elementByNoteId.set('child-note', childElement);

    applyDifferentialView({
        currentClientId: 'client-1',
        editingNoteId: null,
        diffOps: [
            { type: 'remove', noteId: 'child-note', parentId: 'parent-note' },
        ],
        locks: {},
        lockDiffs: {},
        notes: {
            'parent-note': {
                content: 'collapsed parent',
                hash: 'parent-collapsed',
                tags: '',
                proposedTags: '',
                flags: {
                    isEditing: false,
                    isCollapsed: true,
                    hasChildren: true,
                    isCollapsible: true,
                    proposalCount: 0,
                },
            },
        },
    }, { animateNoteChanges: false });

    assert.equal(childContainer.children.includes(childElement), false);
    assert.equal(parentElement.classList.contains('is-collapse-transitioning'), false);
    assert.equal(parentElement.style.height, undefined);
});

test('diff remove animates disappearing note while clearing cached identity immediately', async (t) => {
    const env = installBrowserEnvironment(t, { animatedTransitions: true });
    const { ModeContextInstance: ModeContext } = await import(
        '../../app/static/js/modules/mode-manager/mode-context.js'
    );
    const { applyDifferentialView } = await import(
        '../../app/static/js/modules/mode-manager/services/differential-view-service.js'
    );

    ModeContext.clearNoteHashes();
    ModeContext.setNoteHash('deleted-note', 'deleted-hash');

    const noteElement = env.createElement('div');
    noteElement.classList.add('note', 'interactive');
    noteElement.dataset.noteId = 'deleted-note';
    noteElement.dataset.parentId = '';
    noteElement.dataset.contentHash = 'deleted-hash';
    noteElement.dataset.snapshotHash = 'deleted-hash';
    noteElement.dataset.lockOwner = '';
    noteElement.dataset.isCollapsed = 'false';
    noteElement.dataset.hasChildren = 'false';
    noteElement.dataset.isCollapsible = 'false';
    noteElement.dataset.noteTags = '';
    noteElement.dataset.searchRedacted = 'false';
    env.notesContainer.appendChild(noteElement);
    env.elementByNoteId.set('deleted-note', noteElement);

    applyDifferentialView({
        currentClientId: 'client-1',
        editingNoteId: null,
        diffOps: [
            { type: 'remove', noteId: 'deleted-note', parentId: null },
        ],
        locks: {},
        lockDiffs: {},
        notes: {},
    }, {});

    assert.equal(env.notesContainer.children.includes(noteElement), false);
    assert.equal(noteElement.dataset.noteId, 'deleted-note');
    assert.equal(globalThis.document.querySelector('[data-note-id="deleted-note"]'), noteElement);
    assert.equal(ModeContext.hasNoteHash('deleted-note'), false);
    assert.equal(env.notesContainer.children.length, 1);
    const removalWrapper = env.notesContainer.children[0];
    assert.notEqual(removalWrapper, noteElement);
    assert.equal(removalWrapper.children.includes(noteElement), true);
    assert.equal(noteElement.parentElement, removalWrapper);
    assert.equal(noteElement.dataset.noteId, 'deleted-note');
    assert.equal(removalWrapper.classList.contains('is-removal-collapsing'), true);
    assert.equal(removalWrapper.style.height, '20px');

    env.runAnimationFrame();

    assert.equal(removalWrapper.style.height, '0px');
    assert.equal(noteElement.style.transform, 'scaleY(0.04)');
    assert.equal(noteElement.style.opacity, undefined);

    removalWrapper.dispatchTransitionEnd('height');

    assert.equal(env.notesContainer.children.includes(removalWrapper), false);
    assert.equal(globalThis.document.querySelector('[data-note-id="deleted-note"]'), null);

    env.runTimeout();
    ModeContext.clearNoteHashes();
});
