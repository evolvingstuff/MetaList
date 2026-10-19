import assert from 'node:assert/strict';
import test from 'node:test';

function installBrowserEnvironment(t, { animatedTransitions, webAnimations = false }) {
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
            this.attributes = new Map();
            this.children = [];
            this.parentElement = null;
            this.isConnected = false;
            this.top = 10;
            this.left = 20;
            this.width = 240;
            this.height = 20;
            this.listeners = new Map();
            this.animations = [];
            if (webAnimations) {
                this.animate = (keyframes, options) => {
                    const animation = {
                        keyframes,
                        options,
                        onfinish: null,
                    };
                    this.animations.push(animation);
                    return animation;
                };
            }
        }

        getBoundingClientRect() {
            return {
                top: this.top,
                left: this.left,
                width: this.width,
                height: this.height,
            };
        }

        appendChild(child) {
            return this.insertBefore(child, null);
        }

        insertBefore(child, reference) {
            if (!(child instanceof FakeElement)) {
                throw new Error('insertBefore requires FakeElement child');
            }
            if (child.parentElement) {
                child.parentElement.children = child.parentElement.children.filter((existingChild) => existingChild !== child);
            }
            if (reference === null) {
                this.children.push(child);
            } else {
                this.children.splice(this.children.indexOf(reference), 0, child);
            }
            child.parentElement = this;
            child.isConnected = this.isConnected;
            return child;
        }

        remove() {
            if (!this.parentElement) {
                return;
            }
            this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
            this.parentElement = null;
            this.isConnected = false;
        }

        cloneNode() {
            const clone = new FakeElement(Array.from(this.classList.classes));
            clone.dataset = { ...this.dataset };
            clone.top = this.top;
            clone.left = this.left;
            clone.width = this.width;
            clone.height = this.height;
            return clone;
        }

        querySelectorAll() {
            return [];
        }

        setAttribute(name, value) {
            this.attributes.set(name, value);
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
    body.isConnected = true;
    if (animatedTransitions) {
        body.classList.add('pref-animated-transitions');
    }

    const animationFrames = [];
    const timeouts = [];

    globalThis.HTMLElement = FakeElement;
    globalThis.document = {
        body,
        createElement() {
            return new FakeElement();
        },
    };
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
        createConnectedNote() {
            const parent = new FakeElement();
            parent.isConnected = true;
            const note = new FakeElement(['note']);
            note.dataset.noteId = 'note-a';
            note.height = 80;
            parent.appendChild(note);
            return { parent, note };
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
        finishAnimation(element, index) {
            const animation = element.animations[index];
            if (!animation) {
                throw new Error(`animation ${index} missing`);
            }
            if (typeof animation.onfinish !== 'function') {
                throw new Error(`animation ${index} missing onfinish`);
            }
            animation.onfinish();
        },
    };
}

test('animateNoteRemovalAndRemove collapses the removal row to zero height before removal', async (t) => {
    const env = installBrowserEnvironment(t, { animatedTransitions: true });
    const {
        animateNoteRemovalAndRemove,
        captureNoteRemovalAnimation,
    } = await import(
        '../../app/static/js/modules/mode-manager/services/note-reposition-animation-service.js'
    );

    const { parent, note } = env.createConnectedNote();
    note.dataset.parentId = 'parent-note';

    const capture = captureNoteRemovalAnimation(note);
    const removalWrapper = animateNoteRemovalAndRemove(capture);

    assert.notEqual(removalWrapper, note);
    assert.equal(parent.children.includes(note), false);
    assert.equal(parent.children.includes(removalWrapper), true);
    assert.equal(removalWrapper.children.includes(note), true);
    assert.equal(note.dataset.noteId, 'note-a');
    assert.equal(note.dataset.parentId, 'parent-note');
    assert.equal(removalWrapper.classList.contains('is-removal-collapsing'), true);
    assert.equal(removalWrapper.style.height, '80px');
    assert.equal(removalWrapper.style.overflow, 'hidden');
    assert.equal(note.style.pointerEvents, 'none');

    env.runAnimationFrame();

    assert.equal(removalWrapper.style.height, '0px');
    assert.equal(note.style.transform, 'scaleY(0.04)');
    assert.equal(note.style.opacity, undefined);

    removalWrapper.dispatchTransitionEnd('height');

    assert.equal(parent.children.includes(removalWrapper), false);

    env.runTimeout();
});
