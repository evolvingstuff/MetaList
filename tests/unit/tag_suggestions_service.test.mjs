import assert from 'node:assert/strict';
import test from 'node:test';

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

function matchesClassSelector(element, selector) {
    if (!(element instanceof globalThis.HTMLElement)) {
        return false;
    }
    const match = /^\.([a-z0-9-]+)$/i.exec(selector);
    if (!match) {
        throw new Error(`Unsupported selector in tag suggestions service test: ${selector}`);
    }
    return element.classList.contains(match[1]);
}

function installTagSuggestionsDom(t) {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalEvent = globalThis.Event;
    const originalSessionStorage = globalThis.sessionStorage;
    const originalLocalStorage = globalThis.localStorage;

    class FakeClassList {
        constructor(owner) {
            this._owner = owner;
        }

        add(...classNames) {
            for (const className of classNames) {
                this._owner._classNames.add(className);
            }
        }

        remove(...classNames) {
            for (const className of classNames) {
                this._owner._classNames.delete(className);
            }
        }

        contains(className) {
            return this._owner._classNames.has(className);
        }

        toggle(className, force) {
            if (force === true) {
                this._owner._classNames.add(className);
                return true;
            }
            if (force === false) {
                this._owner._classNames.delete(className);
                return false;
            }
            if (this._owner._classNames.has(className)) {
                this._owner._classNames.delete(className);
                return false;
            }
            this._owner._classNames.add(className);
            return true;
        }
    }

    class FakeElement {
        constructor(tagName = 'div', classNames = []) {
            this.tagName = String(tagName).toUpperCase();
            this._classNames = new Set(classNames);
            this.classList = new FakeClassList(this);
            this.children = [];
            this.parentNode = null;
            this.dataset = {};
            this.style = {};
            this.hidden = false;
            this.textContent = '';
            this.type = '';
            this.placeholder = '';
            this.autocomplete = '';
            this.spellcheck = false;
            this.value = '';
            this.selectionStart = 0;
            this.selectionEnd = 0;
            this.scrollTop = 0;
            this._innerHTML = '';
            this._listeners = new Map();
            this._rect = {
                top: 100,
                bottom: 140,
                left: 0,
                right: 400,
            };
        }

        get scrollHeight() {
            return this.children.length * 48;
        }

        get className() {
            return Array.from(this._classNames).join(' ');
        }

        set className(value) {
            this._classNames = new Set(
                String(value)
                    .split(/\s+/)
                    .map((item) => item.trim())
                    .filter((item) => item.length > 0)
            );
            this.classList = new FakeClassList(this);
        }

        get innerHTML() {
            return this._innerHTML;
        }

        set innerHTML(value) {
            this._innerHTML = String(value);
            if (this._innerHTML === '') {
                this.children = [];
            }
        }

        appendChild(child) {
            if (!(child instanceof FakeElement)) {
                throw new Error('appendChild expects FakeElement child');
            }
            child.parentNode = this;
            this.children.push(child);
            return child;
        }

        querySelector(selector) {
            const matches = this.querySelectorAll(selector);
            return matches.length > 0 ? matches[0] : null;
        }

        querySelectorAll(selector) {
            const matches = [];
            for (const child of this.children) {
                if (matchesClassSelector(child, selector)) {
                    matches.push(child);
                }
                matches.push(...child.querySelectorAll(selector));
            }
            return matches;
        }

        closest(selector) {
            let current = this;
            while (current) {
                if (matchesClassSelector(current, selector)) {
                    return current;
                }
                current = current.parentNode;
            }
            return null;
        }

        addEventListener(type, handler) {
            if (!this._listeners.has(type)) {
                this._listeners.set(type, []);
            }
            this._listeners.get(type).push(handler);
        }

        dispatchEvent(event) {
            if (!event || typeof event.type !== 'string') {
                throw new Error('dispatchEvent requires event with type');
            }
            const listeners = this._listeners.get(event.type) || [];
            for (const listener of listeners) {
                listener.call(this, event);
            }
            return true;
        }

        focus() {
            globalThis.document.activeElement = this;
        }

        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        }

        getBoundingClientRect() {
            return this._rect;
        }
    }

    globalThis.HTMLElement = FakeElement;
    globalThis.Event = class FakeEvent {
        constructor(type) {
            this.type = type;
        }
    };
    globalThis.document = {
        activeElement: null,
        createElement(tagName) {
            return new FakeElement(tagName);
        },
        addEventListener() {},
        removeEventListener() {},
    };
    globalThis.window = {
        innerHeight: 1200,
        addEventListener() {},
        removeEventListener() {},
    };
    globalThis.sessionStorage = createStorage();
    globalThis.localStorage = createStorage();

    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.HTMLElement = originalHTMLElement;
        globalThis.Event = originalEvent;
        globalThis.sessionStorage = originalSessionStorage;
        globalThis.localStorage = originalLocalStorage;
    });

    return { FakeElement };
}

function buildTagSuggestionsFixture(FakeElement) {
    const note = new FakeElement('div', ['note']);
    note.dataset.noteId = 'note-1';

    const content = new FakeElement('div', ['note-content']);
    content.innerHTML = '<p>scratchpad</p>';
    note.appendChild(content);

    const tagBar = new FakeElement('div', ['note-tag-bar']);
    const input = new FakeElement('input', ['note-tag-bar-input']);
    input.value = 'scratchpad';
    input.selectionStart = input.value.length;
    input.selectionEnd = input.value.length;
    tagBar.appendChild(input);

    const container = new FakeElement('div', ['note-tag-suggestions']);
    container.hidden = true;
    container.style.display = 'none';
    tagBar.appendChild(container);

    note.appendChild(tagBar);
    return {
        note,
        content,
        tagBar,
        input,
        container,
    };
}

async function flushSuggestionWork() {
    await new Promise((resolve) => {
        setTimeout(resolve, 80);
    });
    await Promise.resolve();
    await Promise.resolve();
}

test('re-entering the tag bar resets suggestions scroll to top', async (t) => {
    const { FakeElement } = installTagSuggestionsDom(t);
    const { NotesAPI } = await import('../../app/static/js/modules/api-client.js');
    const { ModeContextInstance: ModeContext } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const { updateTagSuggestions } = await import('../../app/static/js/modules/mode-manager/services/tag-suggestions-service.js');

    const originalFetchTagSuggestions = NotesAPI.fetchTagSuggestions;
    const originalEditing = ModeContext._editing;
    const originalCurrentNoteId = ModeContext._currentNoteId;

    t.after(() => {
        NotesAPI.fetchTagSuggestions = originalFetchTagSuggestions;
        ModeContext._editing = originalEditing;
        ModeContext._currentNoteId = originalCurrentNoteId;
    });

    NotesAPI.fetchTagSuggestions = async () => ({
        suggestions: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
    });
    ModeContext._editing = true;
    ModeContext._currentNoteId = 'note-1';

    const { input, content, container } = buildTagSuggestionsFixture(FakeElement);

    input.focus();
    updateTagSuggestions(input);
    await flushSuggestionWork();

    assert.equal(container.hidden, false);
    assert.equal(container.querySelectorAll('.note-tag-suggestion').length, 6);

    container.scrollTop = 120;

    globalThis.document.activeElement = content;
    updateTagSuggestions(input);
    assert.equal(container.hidden, true);
    assert.equal(container.scrollTop, 120);

    input.focus();
    updateTagSuggestions(input);
    await flushSuggestionWork();

    assert.equal(container.hidden, false);
    assert.equal(container.scrollTop, 0);
});

test('upward-opening suggestions keep best suggestion at the top', async (t) => {
    const { FakeElement } = installTagSuggestionsDom(t);
    const { NotesAPI } = await import('../../app/static/js/modules/api-client.js');
    const { ModeContextInstance: ModeContext } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const { updateTagSuggestions } = await import('../../app/static/js/modules/mode-manager/services/tag-suggestions-service.js');

    const originalFetchTagSuggestions = NotesAPI.fetchTagSuggestions;
    const originalEditing = ModeContext._editing;
    const originalCurrentNoteId = ModeContext._currentNoteId;

    t.after(() => {
        NotesAPI.fetchTagSuggestions = originalFetchTagSuggestions;
        ModeContext._editing = originalEditing;
        ModeContext._currentNoteId = originalCurrentNoteId;
    });

    NotesAPI.fetchTagSuggestions = async () => ({
        suggestions: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'],
    });
    ModeContext._editing = true;
    ModeContext._currentNoteId = 'note-1';

    const { input, tagBar, container } = buildTagSuggestionsFixture(FakeElement);
    tagBar._rect = {
        top: 1080,
        bottom: 1120,
        left: 0,
        right: 400,
    };

    input.focus();
    updateTagSuggestions(input);
    await flushSuggestionWork();

    assert.equal(container.hidden, false);
    assert.equal(container.classList.contains('is-up'), true);
    assert.equal(container.scrollTop, 0);
    assert.deepEqual(
        container.querySelectorAll('.note-tag-suggestion').map((element) => element.textContent),
        ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
    );
    assert.equal(container.querySelectorAll('.note-tag-suggestion')[0].classList.contains('is-selected'), true);
});

test('starting a new tag suggestion request aborts the previous in-flight request', async (t) => {
    const { FakeElement } = installTagSuggestionsDom(t);
    const { NotesAPI } = await import('../../app/static/js/modules/api-client.js');
    const { ModeContextInstance: ModeContext } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const { updateTagSuggestions } = await import('../../app/static/js/modules/mode-manager/services/tag-suggestions-service.js');

    const originalFetchTagSuggestions = NotesAPI.fetchTagSuggestions;
    const originalEditing = ModeContext._editing;
    const originalCurrentNoteId = ModeContext._currentNoteId;

    t.after(() => {
        NotesAPI.fetchTagSuggestions = originalFetchTagSuggestions;
        ModeContext._editing = originalEditing;
        ModeContext._currentNoteId = originalCurrentNoteId;
    });

    const requests = [];
    NotesAPI.fetchTagSuggestions = async (_noteId, _anchors, _explicitTags, _prefix, _contentHtml, signal) => {
        assert.equal(typeof signal, 'object');
        assert.equal(typeof signal.aborted, 'boolean');
        return new Promise((resolve, reject) => {
            requests.push({ signal, resolve });
            signal.addEventListener('abort', () => {
                const error = new DOMException('aborted', 'AbortError');
                reject(error);
            });
        });
    };
    ModeContext._editing = true;
    ModeContext._currentNoteId = 'note-1';

    const { input, container } = buildTagSuggestionsFixture(FakeElement);

    input.focus();
    updateTagSuggestions(input);
    await flushSuggestionWork();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, false);

    input.value = 'scratchpad-next';
    input.selectionStart = input.value.length;
    input.selectionEnd = input.value.length;
    updateTagSuggestions(input);

    assert.equal(requests[0].signal.aborted, true);

    await flushSuggestionWork();
    assert.equal(requests.length, 2);
    requests[1].resolve({ suggestions: ['scratchpad-next'] });
    await flushSuggestionWork();

    assert.equal(container.hidden, false);
    assert.deepEqual(
        container.querySelectorAll('.note-tag-suggestion').map((element) => element.textContent),
        ['scratchpad-next']
    );
});

test('typing an open meta-tag scope fetches suggestions and accepting one preserves its brackets', async (t) => {
    const { FakeElement } = installTagSuggestionsDom(t);
    const { NotesAPI } = await import('../../app/static/js/modules/api-client.js');
    const { ModeContextInstance: ModeContext } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const { validateAndRenderTagBar } = await import('../../app/static/js/modules/mode-manager/services/tag-bar-service.js');
    const { updateTagSuggestions } = await import('../../app/static/js/modules/mode-manager/services/tag-suggestions-service.js');
    const originalFetch = NotesAPI.fetchTagSuggestions;
    const originalEditing = ModeContext._editing;
    const originalNoteId = ModeContext._currentNoteId;
    t.after(() => {
        NotesAPI.fetchTagSuggestions = originalFetch;
        ModeContext._editing = originalEditing;
        ModeContext._currentNoteId = originalNoteId;
    });
    const prefixes = [];
    NotesAPI.fetchTagSuggestions = async (_id, anchors, explicitTags, prefix) => {
        prefixes.push(prefix);
        if (prefixes.length === 1) {
            assert.deepEqual(anchors, ['ML3']);
            assert.deepEqual(explicitTags, ['ML3', '@']);
        } else {
            assert.deepEqual(anchors, ['ML3', '@footnote']);
        }
        return { suggestions: ['@footnote', '@bold'] };
    };
    ModeContext._editing = true;
    ModeContext._currentNoteId = 'note-1';
    const { note, tagBar, input, container } = buildTagSuggestionsFixture(FakeElement);
    const message = new FakeElement('div', ['note-tag-bar-validation-message']);
    tagBar.appendChild(message);
    input.value = 'ML3 {{@';
    input.setSelectionRange(input.value.length, input.value.length);
    input.focus();
    updateTagSuggestions(input);
    await flushSuggestionWork();
    assert.deepEqual(prefixes, ['@']);
    assert.equal(container.hidden, false);
    container.querySelectorAll('.note-tag-suggestion')[0].dispatchEvent({
        type: 'mousedown', button: 0, preventDefault() {},
    });
    assert.equal(input.value, 'ML3 {{@footnote');
    assert.equal(input.selectionStart, input.value.length);
    assert.equal(container.hidden, true);
    input.value += ' ';
    input.setSelectionRange(input.value.length, input.value.length);
    updateTagSuggestions(input);
    await flushSuggestionWork();
    assert.deepEqual(prefixes, ['@', '']);
    assert.equal(container.hidden, false);
    validateAndRenderTagBar(note);
    assert.equal(message.textContent, 'Close scope with }}');
    assert.equal(message.classList.contains('is-reminder'), true);
    input.value += '@bo';
    input.setSelectionRange(input.value.length, input.value.length);
    updateTagSuggestions(input);
    await flushSuggestionWork();
    assert.deepEqual(prefixes, ['@', '', '@bo']);
    container.querySelectorAll('.note-tag-suggestion')[1].dispatchEvent({
        type: 'mousedown', button: 0, preventDefault() {},
    });
    assert.equal(input.value, 'ML3 {{@footnote @bold');
    input.value += '}}';
    validateAndRenderTagBar(note);
    assert.equal(message.hidden, true);
    input.value = 'OR';
    validateAndRenderTagBar(note);
    assert.equal(message.classList.contains('is-reminder'), false);
    assert.equal(message.textContent, 'OR is reserved for search');
});
