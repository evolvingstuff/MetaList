import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationState } from '../../app/static/js/modules/application-state.js';


const browserSessionValues = new Map();
globalThis.sessionStorage = {
    getItem(key) {
        return browserSessionValues.has(key) ? browserSessionValues.get(key) : null;
    },
    setItem(key, value) {
        browserSessionValues.set(key, String(value));
    },
};

const { OntologyModal } = await import('../../app/static/js/modules/modals/ontology-modal.js');

for (const operation of ['refreshTagSearch', 'setFocusTag']) {
    test(`ontology ${operation} retries preserve the server error instead of throwing a redundant state error`, async (t) => {
        const originalDocument = globalThis.document;
        globalThis.document = { getElementById: () => null };
        t.after(() => { globalThis.document = originalDocument; browserSessionValues.delete('metalist_tab_id'); });
        browserSessionValues.set('metalist_tab_id', 'test-tab');
        t.mock.method(globalThis, 'fetch', async () => ({ok:false, json:async () => ({detail:'Request rejected'})}));
        const modal = new OntologyModal();
        const state = ApplicationState.createFields(`ontology-error-${operation}`, {error:null});
        modal.getModalState = () => state;
        modal.updateModalState = updates => { state.error = updates.error; };
        modal.clearSearchInput = () => {};
        modal.renderFocusView = () => {};
        modal.renderTagSearchResults = () => {};
        for (let count = 0; count < 2; count += 1) {
            if (operation === 'setFocusTag') {
                await assert.rejects(modal[operation]('test-tag'), {message:'Request rejected'});
            } else {
                await modal[operation]('test-tag');
            }
        }
        assert.equal(state.error, 'Request rejected');
    });
}

test('closing untouched ontology suggestions consumes only pending navigation state', () => {
    const modal = new OntologyModal();
    modal._resetDialogSuggestionState();
    modal._resetDialogSuggestionState();
    assert.equal(modal._dialogSelectedIndex, -1);
    assert.equal(modal._dialogSuggestionContext, null);
});

test('ontology dialog typing clears pending navigation without redundant resets', (t) => {
    class Input {}
    globalThis.HTMLInputElement = Input;
    t.after(() => { delete globalThis.HTMLInputElement; });
    const modal = new OntologyModal();
    modal._dialogState = { showInput: true };
    modal._clearDialogError = () => {};
    let requests = 0;
    modal._updateDialogSuggestions = () => { requests += 1; };
    const event = { target: new Input() };
    modal._handleDialogInput(event);
    modal._handleDialogInput(event);
    modal._dialogSuggestionWasExplicitlyNavigated = true;
    modal._dialogPointerSelectionPendingEnter = true;
    modal._handleDialogInput(event);
    assert.equal(requests, 3);
    assert.equal(modal._dialogSuggestionWasExplicitlyNavigated, false);
    assert.equal(modal._dialogPointerSelectionPendingEnter, false);
});

test('ontology search arrow repeats at the first and last suggestion do not request a transition', (t) => {
    class Element {
        style = { display: 'flex' };
        querySelectorAll() { return [{}]; }
    }
    const container = new Element();
    globalThis.HTMLElement = Element;
    globalThis.document = { getElementById: () => ({ querySelector: () => container }) };
    t.after(() => { delete globalThis.HTMLElement; delete globalThis.document; });
    const modal = new OntologyModal();
    modal._searchSelectedIndex = 0;
    modal._updateSearchSelection = () => {};
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp']) {
        modal._handleSearchKeydown(buildKeyboardEvent(key));
    }
    assert.equal(modal._searchSelectedIndex, 0);
});


function buildKeyboardEvent(key) {
    return {
        key,
        preventDefaultCallCount: 0,
        stopPropagationCallCount: 0,
        stopImmediatePropagationCallCount: 0,
        preventDefault() {
            this.preventDefaultCallCount += 1;
        },
        stopPropagation() {
            this.stopPropagationCallCount += 1;
        },
        stopImmediatePropagation() {
            this.stopImmediatePropagationCallCount += 1;
        },
    };
}


test('ontology relationship dialog Enter submits while suggestions are visible', () => {
    const modal = new OntologyModal();
    modal._dialogState = {
        mode: 'single-tag',
        autoSubmitOnSuggestion: false,
    };
    modal._getDialogElements = () => ({
        suggestions: {
            classList: {
                contains: () => false,
            },
            querySelectorAll: () => [{ dataset: { tag: 'highlighted-suggestion' } }],
        },
    });

    let submitCallCount = 0;
    let applySuggestionCallCount = 0;
    modal._submitDialog = () => {
        submitCallCount += 1;
    };
    modal._applyDialogSuggestion = () => {
        applySuggestionCallCount += 1;
    };

    const event = buildKeyboardEvent('Enter');
    modal._handleDialogKeydown(event);

    assert.equal(submitCallCount, 1);
    assert.equal(applySuggestionCallCount, 0);
    assert.equal(event.preventDefaultCallCount, 1);
    assert.equal(event.stopPropagationCallCount, 1);
    assert.equal(event.stopImmediatePropagationCallCount, 1);
});


test('ontology relationship dialog Enter accepts an arrowed suggestion without submitting', () => {
    const modal = new OntologyModal();
    modal._dialogState = {
        mode: 'single-tag',
        autoSubmitOnSuggestion: false,
    };
    const suggestions = [
        { dataset: { tag: 'first-suggestion' } },
        { dataset: { tag: 'second-suggestion' } },
    ];
    modal._getDialogElements = () => ({
        suggestions: {
            classList: {
                contains: () => false,
            },
            querySelectorAll: () => suggestions,
        },
    });
    modal._updateDialogSuggestionSelection = () => {};

    const appliedSuggestions = [];
    let submitCallCount = 0;
    modal._applyDialogSuggestion = (tag) => {
        appliedSuggestions.push(tag);
    };
    modal._submitDialog = () => {
        submitCallCount += 1;
    };

    modal._handleDialogKeydown(buildKeyboardEvent('ArrowDown'));
    modal._handleDialogKeydown(buildKeyboardEvent('Enter'));

    assert.deepEqual(appliedSuggestions, ['first-suggestion']);
    assert.equal(submitCallCount, 0);
});


test('ontology relationship dialog Enter preserves a pointer-chosen suggestion boundary', () => {
    const modal = new OntologyModal();
    modal._dialogState = {
        mode: 'single-tag',
        autoSubmitOnSuggestion: false,
    };
    const suggestionHandlers = {};
    const suggestionButton = {
        dataset: { tag: 'pointer-suggestion' },
        addEventListener(eventName, handler) {
            suggestionHandlers[eventName] = handler;
        },
    };
    const suggestionsContainer = {
        innerHTML: '',
        classList: {
            add() {},
            remove() {},
            contains: () => false,
        },
        querySelectorAll: () => [suggestionButton],
    };
    modal._getDialogElements = () => ({
        suggestions: suggestionsContainer,
    });
    modal._updateDialogSuggestionSelection = () => {};

    const appliedSuggestions = [];
    let submitCallCount = 0;
    modal._applyDialogSuggestion = (tag) => {
        appliedSuggestions.push(tag);
    };
    modal._submitDialog = () => {
        submitCallCount += 1;
    };

    modal._renderDialogSuggestions(['pointer-suggestion']);
    assert.equal(modal._dialogSelectedIndex, -1);
    assert.equal(typeof suggestionHandlers.mousedown, 'function');
    suggestionHandlers.mousedown({
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {},
    });
    modal._handleDialogKeydown(buildKeyboardEvent('Enter'));

    assert.deepEqual(appliedSuggestions, ['pointer-suggestion']);
    assert.equal(submitCallCount, 0);
    assert.equal(modal._dialogPointerSelectionPendingEnter, false);
});


test('ontology relationship dialog retains its submit button', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
        new URL('../../app/static/js/modules/modals/ontology-modal.js', import.meta.url),
        'utf8',
    );

    assert.match(
        source,
        /<button class="ontology-dialog-primary" data-action="dialog-submit">Save<\/button>/,
    );
    assert.match(source, /if \(action === 'dialog-submit'\) \{\s*this\._submitDialog\(\);/);
});


test('focused tag editor offers confirmed whole-tag deletion', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
        new URL('../../app/static/js/modules/modals/ontology-modal.js', import.meta.url),
        'utf8',
    );

    assert.match(source, /data-action="dialog-delete-tag"/);
    assert.match(source, /data-action="rename-focus" aria-label="Edit tag"/);
    assert.match(source, /Delete tag…/);
    assert.match(source, /This removes the tag from all note tag bars and deletes every ontology relationship that references it\./);
    assert.match(source, /fetchJson\(`\$\{ONTOLOGY_BASE\}\/delete-tag`/);
    assert.match(source, /body: JSON\.stringify\(\{ tag: focusTag \}\)/);
});


test('add-new-tag dialog omits redundant description and field label', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
        new URL('../../app/static/js/modules/modals/ontology-modal.js', import.meta.url),
        'utf8',
    );
    const addTagStart = source.indexOf("if (action === 'add-tag')");
    const addTagEnd = source.indexOf("if (action === 'remove')", addTagStart);
    assert.notEqual(addTagStart, -1);
    assert.notEqual(addTagEnd, -1);
    const addTagSource = source.slice(addTagStart, addTagEnd);

    assert.match(addTagSource, /description: ''/);
    assert.match(addTagSource, /label: ''/);
    assert.doesNotMatch(addTagSource, /Create a tag to focus/);
});


test('tag suggestions are anchored to the search input instead of the whole action row', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
        new URL('../../app/static/js/modules/modals/ontology-modal.js', import.meta.url),
        'utf8',
    );
    const css = await readFile(
        new URL('../../app/static/css/main.css', import.meta.url),
        'utf8',
    );

    assert.match(
        source,
        /<div class="ontology-search-input-wrap">[\s\S]*id="ontology-search-input"[\s\S]*id="ontology-search-results"[\s\S]*<\/div>[\s\S]*data-action="add-tag"/,
    );
    assert.match(css, /\.ontology-search-input-wrap\s*\{[\s\S]*position:\s*relative;[\s\S]*flex:\s*1;/);
    assert.match(css, /#ontology-search-input\s*\{[\s\S]*margin:\s*0;/);
    assert.match(css, /#ontology-dialog-input\s*\{[\s\S]*margin:\s*0;/);
});


test('ontology footer reports catalog size without redundant keyboard hints', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
        new URL('../../app/static/js/modules/modals/ontology-modal.js', import.meta.url),
        'utf8',
    );

    assert.match(source, /`\$\{total\.toLocaleString\(\)\} total unique tags`/);
    assert.doesNotMatch(source, /esc to cancel/);
    assert.doesNotMatch(source, /enter to focus/);
    assert.doesNotMatch(source, /Showing \$\{shown\}/);
});
