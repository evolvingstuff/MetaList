import assert from 'node:assert/strict';
import test from 'node:test';

function installBrowserEnvironment(t, { animatedTransitions }) {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalHTMLElement = globalThis.HTMLElement;

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
    }

    class FakeElement {
        constructor(initialClasses = []) {
            this.classList = new FakeClassList(initialClasses);
            this.dataset = {};
            this.style = {};
            this.isConnected = true;
            this.height = 20;
            this.listeners = new Map();
            this.children = [];
            this.parentElement = null;
            this.attributes = new Map();
        }

        getBoundingClientRect() {
            return { height: this.height };
        }

        remove() {
            if (!this.parentElement) {
                return;
            }
            this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
            this.parentElement = null;
            this.isConnected = false;
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

    const body = new FakeElement();
    if (animatedTransitions) {
        body.classList.add('pref-animated-transitions');
    }

    const animationFrames = [];
    const timeouts = [];

    globalThis.HTMLElement = FakeElement;
    globalThis.document = { body };
    globalThis.window = {
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

    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.HTMLElement = originalHTMLElement;
    });

    return {
        createNote() {
            const parent = new FakeElement();
            const note = new FakeElement(['note']);
            note.dataset.noteId = 'note-a';
            parent.children.push(note);
            note.parentElement = parent;
            return note;
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

test('captureNoteCollapseAnimation returns null when animated transitions are disabled', async (t) => {
    const env = installBrowserEnvironment(t, { animatedTransitions: false });
    const { captureNoteCollapseAnimation } = await import(
        '../../app/static/js/modules/mode-manager/services/note-collapse-animation-service.js'
    );

    const note = env.createNote();
    note.dataset.isCollapsed = 'false';
    note.height = 80;

    assert.equal(captureNoteCollapseAnimation(note, true), null);
});

test('animateNoteCollapseChanges collapses the real expanded note', async (t) => {
    const env = installBrowserEnvironment(t, { animatedTransitions: true });
    const {
        animateNoteCollapseChanges,
        captureNoteCollapseAnimation,
    } = await import(
        '../../app/static/js/modules/mode-manager/services/note-collapse-animation-service.js'
    );

    const note = env.createNote();
    note.dataset.isCollapsed = 'false';
    note.height = 80;
    const capture = captureNoteCollapseAnimation(note, true);

    note.dataset.isCollapsed = 'true';
    note.height = 20;
    animateNoteCollapseChanges([capture]);

    const parent = note.parentElement;
    assert.equal(parent.children.includes(note), true);
    assert.equal(parent.children.length, 1);
    assert.equal(note.classList.contains('is-collapse-transitioning'), true);
    assert.equal(note.style.height, '80px');
    assert.equal(note.style.boxSizing, 'border-box');
    // Clipping comes from the class (clip-path, sparing the arrow's gutter), never inline overflow.
    assert.equal(note.style.overflow, undefined);

    env.runAnimationFrame();

    assert.equal(note.style.height, '20px');

    note.dispatchTransitionEnd('height');

    assert.equal(parent.children.includes(note), true);
    assert.equal(note.classList.contains('is-collapse-transitioning'), false);
    assert.equal(note.style.height, '');
    assert.equal(note.style.boxSizing, '');
    assert.equal(note.style.overflow, undefined);

    env.runTimeout();
});

test('animateNoteCollapseChanges expands the real collapsed note', async (t) => {
    const env = installBrowserEnvironment(t, { animatedTransitions: true });
    const {
        animateNoteCollapseChanges,
        captureNoteCollapseAnimation,
    } = await import(
        '../../app/static/js/modules/mode-manager/services/note-collapse-animation-service.js'
    );

    const note = env.createNote();
    note.dataset.isCollapsed = 'true';
    note.height = 20;
    const capture = captureNoteCollapseAnimation(note, false);

    note.dataset.isCollapsed = 'false';
    note.height = 80;
    animateNoteCollapseChanges([capture]);

    assert.equal(note.classList.contains('is-collapse-transitioning'), true);
    assert.equal(note.style.height, '20px');
    assert.equal(note.style.boxSizing, 'border-box');
    // Clipping comes from the class (clip-path, sparing the arrow's gutter), never inline overflow.
    assert.equal(note.style.overflow, undefined);

    env.runAnimationFrame();

    assert.equal(note.style.height, '80px');

    note.dispatchTransitionEnd('height');

    assert.equal(note.classList.contains('is-collapse-transitioning'), false);
    assert.equal(note.style.height, '');
    assert.equal(note.style.boxSizing, '');
    assert.equal(note.style.overflow, undefined);

    env.runTimeout();
});

test('animateNoteCollapseChanges removes deferred children after the parent collapse', async (t) => {
    const env = installBrowserEnvironment(t, { animatedTransitions: true });
    const {
        animateNoteCollapseChanges,
        captureNoteCollapseAnimation,
    } = await import(
        '../../app/static/js/modules/mode-manager/services/note-collapse-animation-service.js'
    );

    const note = env.createNote();
    const child = new globalThis.HTMLElement(['note']);
    note.children.push(child);
    child.parentElement = note;
    note.dataset.isCollapsed = 'false';
    note.height = 80;
    const capture = captureNoteCollapseAnimation(note, true);
    capture.deferredRemovalElements.push(child);

    note.dataset.isCollapsed = 'true';
    note.height = 20;
    animateNoteCollapseChanges([capture]);

    assert.equal(note.children.includes(child), true);
    assert.equal(child.style.display, '');
    assert.equal(note.style.height, '80px');

    env.runAnimationFrame();

    assert.equal(note.style.height, '20px');

    note.dispatchTransitionEnd('height');

    assert.equal(note.children.includes(child), false);
    assert.equal(child.parentElement, null);

    env.runTimeout();
});

test('animateNoteCollapseChanges removes deferred children when no height transition runs', async (t) => {
    const env = installBrowserEnvironment(t, { animatedTransitions: true });
    const {
        animateNoteCollapseChanges,
        captureNoteCollapseAnimation,
    } = await import(
        '../../app/static/js/modules/mode-manager/services/note-collapse-animation-service.js'
    );

    const note = env.createNote();
    const child = new globalThis.HTMLElement(['note']);
    note.children.push(child);
    child.parentElement = note;
    note.dataset.isCollapsed = 'false';
    note.height = 20;
    const capture = captureNoteCollapseAnimation(note, true);
    capture.deferredRemovalElements.push(child);

    note.dataset.isCollapsed = 'true';
    animateNoteCollapseChanges([capture]);

    assert.equal(note.children.includes(child), false);
    assert.equal(child.parentElement, null);
    assert.equal(note.classList.contains('is-collapse-transitioning'), false);
});
