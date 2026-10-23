import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeSessionIdentity } from '../../app/static/js/modules/session-auth.js';

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

function installSearchEventsDom(t) {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalSessionStorage = globalThis.sessionStorage;
    const originalLocalStorage = globalThis.localStorage;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalHTMLButtonElement = globalThis.HTMLButtonElement;

    class FakeHTMLElement {
        constructor() {
            const classes = new Set();
            this.classList = {
                contains: (name) => classes.has(name),
                remove: (name) => classes.delete(name),
                toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
            };
        }

        removeAttribute(name) {
            delete this[name];
        }
    }

    const referenceSourceIndicator = new FakeHTMLElement();
    const referenceSourceLabel = new FakeHTMLElement();
    const referenceChipBack = new FakeHTMLElement();
    const searchSuggestions = {
        hidden: true,
        style: {},
        innerHTML: '',
    };
    const searchValidationMessage = {
        hidden: true,
        textContent: '',
    };
    const notesContainer = {
        childNodes: [{ nodeType: 1 }],
        querySelectorAll() {
            return [];
        },
        get firstChild() {
            return this.childNodes.length > 0 ? this.childNodes[0] : null;
        },
        replaceChildren() {
            this.childNodes = [];
        },
        removeChild(node) {
            const index = this.childNodes.indexOf(node);
            if (index >= 0) {
                this.childNodes.splice(index, 1);
            }
        },
    };

    Object.setPrototypeOf(notesContainer, FakeHTMLElement.prototype);

    globalThis.document = {
        activeElement: null,
        body: {
            classList: {
                add() {},
                remove() {},
            },
        },
        getElementById(id) {
            if (id === 'search-suggestions') {
                return searchSuggestions;
            }
            if (id === 'search-validation-message') {
                return searchValidationMessage;
            }
            if (id === 'notes-container') {
                return notesContainer;
            }
            if (id === 'reference-source-indicator') {
                return referenceSourceIndicator;
            }
            if (id === 'reference-source-indicator-label') {
                return referenceSourceLabel;
            }
            if (id === 'reference-view-chip-back') {
                return referenceChipBack;
            }
            return null;
        },
        addEventListener() {},
        removeEventListener() {},
    };
    globalThis.window = {
        addEventListener() {},
        removeEventListener() {},
        scrollTo() {},
    };
    globalThis.sessionStorage = createStorage();
    globalThis.localStorage = createStorage();
    globalThis.HTMLElement = FakeHTMLElement;
    globalThis.HTMLButtonElement = class FakeHTMLButtonElement extends globalThis.HTMLElement {};

    const restore = () => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.sessionStorage = originalSessionStorage;
        globalThis.localStorage = originalLocalStorage;
        globalThis.HTMLElement = originalHTMLElement;
        globalThis.HTMLButtonElement = originalHTMLButtonElement;
    };
    restore.notesContainer = notesContainer;
    return restore;
}

function createSearchInput(value) {
    return {
        value,
        selectionStart: value.length,
        selectionEnd: value.length,
        classList: {
            toggle() {},
        },
        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        },
    };
}

test('handleSearchInput updates search query even while loading', async (t) => {
    const restoreDom = installSearchEventsDom(t);

    const [{ handleSearchInput }, { cancelDebouncedSearchExecution }, { ModeContextInstance: ModeContext }] = await Promise.all([
        import('../../app/static/js/modules/mode-manager/events/search-events.js'),
        import('../../app/static/js/modules/mode-manager/services/search-debounce-service.js'),
        import('../../app/static/js/modules/mode-manager/mode-context.js'),
    ]);

    ModeContext.setSearchQuery('ML');
    ModeContext.setLoading(true);

    t.after(() => {
        cancelDebouncedSearchExecution();
        if (ModeContext.isLoading) {
            ModeContext.setLoading(false);
        }
        ModeContext.setSearchQuery('');
        restoreDom();
    });

    handleSearchInput({
        target: createSearchInput('ML3'),
    });

    assert.equal(ModeContext.searchQuery, 'ML3');
});

test('fresh search input dismisses the temporary untagged view', async (t) => {
    const restoreDom = installSearchEventsDom(t);

    const [{ handleSearchInput }, { cancelDebouncedSearchExecution }, { ModeContextInstance: ModeContext }] = await Promise.all([
        import('../../app/static/js/modules/mode-manager/events/search-events.js'),
        import('../../app/static/js/modules/mode-manager/services/search-debounce-service.js'),
        import('../../app/static/js/modules/mode-manager/mode-context.js'),
    ]);

    ModeContext.setSearchQuery('journal');
    ModeContext.setUntaggedView(true);

    t.after(() => {
        cancelDebouncedSearchExecution();
        if (ModeContext.isUntaggedView) {
            ModeContext.setUntaggedView(false);
        }
        ModeContext.setSearchQuery('');
        restoreDom();
    });

    handleSearchInput({
        target: createSearchInput('journal entry'),
    });

    assert.equal(ModeContext.searchQuery, 'journal entry');
    assert.equal(ModeContext.isUntaggedView, false);
});

test('typing in search dismisses reference source mode without leaving the active tab', async (t) => {
    const restoreDom = installSearchEventsDom(t);

    const [
        { handleSearchInput },
        { cancelDebouncedSearchExecution },
        { ModeContextInstance: ModeContext },
        { isViewingReferenceSource, pushReferenceNavigationEntry },
    ] = await Promise.all([
        import('../../app/static/js/modules/mode-manager/events/search-events.js'),
        import('../../app/static/js/modules/mode-manager/services/search-debounce-service.js'),
        import('../../app/static/js/modules/mode-manager/mode-context.js'),
        import('../../app/static/js/modules/mode-manager/services/reference-source-navigation-service.js'),
    ]);

    const originalTabState = ModeContext.getTabStatePayload();
    const sourceTabState = structuredClone(originalTabState);
    const originalTabId = sourceTabState.activeTabId;
    const sourceTabId = 'reference-source-search-test';
    sourceTabState.tabs[sourceTabId] = structuredClone(sourceTabState.tabs[originalTabId]);
    sourceTabState.tabs[sourceTabId].searchQuery = 'reference-uuid';
    sourceTabState.tabOrder.push(sourceTabId);
    sourceTabState.activeTabId = sourceTabId;
    ModeContext.hydrateTabState(sourceTabState, { emitUpdate: false });
    pushReferenceNavigationEntry(
        originalTabId,
        sourceTabId,
        'reference-uuid',
        {
            scopeTabId: originalTabId,
            searchQuery: ModeContext.getExecutedSearchQuery(originalTabId),
            sortMode: ModeContext.getTabSortMode(originalTabId),
            isUntaggedView: false,
        },
        'source',
    );

    t.after(async () => {
        cancelDebouncedSearchExecution();
        ModeContext.hydrateTabState(originalTabState, { emitUpdate: false });
        await import('../../app/static/js/modules/mode-manager/services/infinite-scroll-service.js');
        await Promise.resolve();
        restoreDom();
    });

    handleSearchInput({
        target: createSearchInput('project notes'),
    });

    assert.equal(ModeContext.activeTabId, sourceTabId);
    assert.equal(ModeContext.searchQuery, 'project notes');
    assert.equal(isViewingReferenceSource(), false);
});

test('pasting the preserved tab query into untagged search still dismisses the view', async (t) => {
    const restoreDom = installSearchEventsDom(t);

    const [{ handleSearchInput }, { cancelDebouncedSearchExecution }, { ModeContextInstance: ModeContext }] = await Promise.all([
        import('../../app/static/js/modules/mode-manager/events/search-events.js'),
        import('../../app/static/js/modules/mode-manager/services/search-debounce-service.js'),
        import('../../app/static/js/modules/mode-manager/mode-context.js'),
    ]);

    ModeContext.setSearchQuery('journal');
    ModeContext.setUntaggedView(true);

    t.after(() => {
        cancelDebouncedSearchExecution();
        if (ModeContext.isUntaggedView) {
            ModeContext.setUntaggedView(false);
        }
        ModeContext.setSearchQuery('');
        restoreDom();
    });

    handleSearchInput({
        target: createSearchInput('journal'),
    });

    assert.equal(ModeContext.searchQuery, 'journal');
    assert.equal(ModeContext.isUntaggedView, false);
});

test('fresh search input resets the active tab sort without losing the typed query', async (t) => {
    const restoreDom = installSearchEventsDom(t);
    const originalFetch = globalThis.fetch;

    const [{ handleSearchInput }, { cancelDebouncedSearchExecution }, { ModeContextInstance: ModeContext }] = await Promise.all([
        import('../../app/static/js/modules/mode-manager/events/search-events.js'),
        import('../../app/static/js/modules/mode-manager/services/search-debounce-service.js'),
        import('../../app/static/js/modules/mode-manager/mode-context.js'),
    ]);

    const originalTabState = ModeContext.getTabStatePayload();
    const activeTabId = originalTabState.activeTabId;
    const sortedTabState = structuredClone(originalTabState);
    sortedTabState.tabs[activeTabId].searchQuery = 'journal';
    sortedTabState.tabs[activeTabId].sortMode = 'updated';
    ModeContext.hydrateTabState(sortedTabState, { emitUpdate: false });
    sessionStorage.setItem('metalist_tab_id', 'search-events-test');
    initializeSessionIdentity();

    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        const responseState = structuredClone(sortedTabState);
        responseState.tabs[activeTabId].sortMode = 'normal';
        return {
            ok: true,
            async json() {
                return responseState;
            },
        };
    };

    t.after(() => {
        cancelDebouncedSearchExecution();
        globalThis.fetch = originalFetch;
        ModeContext.hydrateTabState(originalTabState, { emitUpdate: false });
        restoreDom();
    });

    handleSearchInput({
        target: createSearchInput('journal entry'),
    });
    cancelDebouncedSearchExecution();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.sortMode, 'normal');
    assert.equal(ModeContext.activeTabSortMode, 'normal');
    assert.equal(ModeContext.searchQuery, 'journal entry');
});

test('fresh search input clears same-query render cache and active DOM', async (t) => {
    const restoreDom = installSearchEventsDom(t);

    const [{ resetActiveTabForSearchExecution }, { ModeContextInstance: ModeContext }] = await Promise.all([
        import('../../app/static/js/modules/mode-manager/events/search-events.js'),
        import('../../app/static/js/modules/mode-manager/mode-context.js'),
    ]);
    const tabId = ModeContext.activeTabId;
    const originalTabState = ModeContext.getTabStatePayload();

    t.after(() => {
        ModeContext.hydrateTabState(originalTabState, { emitUpdate: false });
        restoreDom();
    });

    ModeContext.setExecutedSearchQuery('journal', tabId);
    ModeContext.seedTabNoteHashes(tabId, new Map([
        ['root-a', 'hash-a'],
        ['root-b', 'hash-b'],
    ]));

    resetActiveTabForSearchExecution('journal', { isFreshSearchInput: false });
    assert.equal(ModeContext.getTabNoteHashCount(tabId), 2);
    assert.equal(restoreDom.notesContainer.childNodes.length, 1);

    resetActiveTabForSearchExecution('journal', { isFreshSearchInput: true });
    assert.equal(ModeContext.getTabNoteHashCount(tabId), 0);
    assert.equal(restoreDom.notesContainer.childNodes.length, 0);
});

// Browser suites wait for an idle MetaList (scripts/browser-app-idle.mjs); a search
// still in its typing delay is not idle.
test('a search waiting for its typing delay is pending until it is cancelled', async (t) => {
    const restoreDom = installSearchEventsDom(t);

    const [{ handleSearchInput }, { cancelDebouncedSearchExecution, isDebouncedSearchPending }, { ModeContextInstance: ModeContext }] = await Promise.all([
        import('../../app/static/js/modules/mode-manager/events/search-events.js'),
        import('../../app/static/js/modules/mode-manager/services/search-debounce-service.js'),
        import('../../app/static/js/modules/mode-manager/mode-context.js'),
    ]);

    t.after(() => {
        cancelDebouncedSearchExecution();
        ModeContext.setSearchQuery('');
        restoreDom();
    });

    assert.equal(isDebouncedSearchPending(), false);
    handleSearchInput({
        target: createSearchInput('journal'),
    });
    assert.equal(isDebouncedSearchPending(), true);
    cancelDebouncedSearchExecution();
    assert.equal(isDebouncedSearchPending(), false);
});

// Event-loop turns for the answered cleanup to insert its text (it needs a few).
const CLEANUP_SETTLE_TICKS = 20;

// The dictation cleanup runs outside CommandGate, so the idle wait asks for it:
// in progress from the paste until the cleaned text is in the field.
test('a dictation paste is in progress until its cleaned text is inserted', async (t) => {
    const restoreDom = installSearchEventsDom(t);
    const originalFetch = globalThis.fetch;
    const originalHTMLInputElement = globalThis.HTMLInputElement;
    const originalHTMLTextAreaElement = globalThis.HTMLTextAreaElement;
    initializeSessionIdentity();
    class FakeHTMLInputElement extends globalThis.HTMLElement {}
    globalThis.HTMLInputElement = FakeHTMLInputElement;
    globalThis.HTMLTextAreaElement = class FakeHTMLTextAreaElement extends globalThis.HTMLElement {};
    const input = Object.assign(new FakeHTMLInputElement(), createSearchInput(''), { focus() {} });
    globalThis.document.execCommand = (command, showUi, text) => {
        assert.equal(command, 'insertText');
        input.value = input.value.slice(0, input.selectionStart) + text + input.value.slice(input.selectionEnd);
        input.selectionStart = input.selectionStart + text.length;
        input.selectionEnd = input.selectionStart;
        return true;
    };
    let answerCleanup;
    globalThis.fetch = () => new Promise((resolve) => {
        answerCleanup = () => resolve({ ok: true, json: async () => ({ text: 'neural-network' }) });
    });
    t.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.HTMLInputElement = originalHTMLInputElement;
        globalThis.HTMLTextAreaElement = originalHTMLTextAreaElement;
        restoreDom();
    });

    const { handleDictationPasteEvent, isDictationCleanupInProgress } = await import(
        '../../app/static/js/modules/mode-manager/services/dictation-paste-service.js');
    assert.equal(isDictationCleanupInProgress(), false);
    handleDictationPasteEvent({
        clipboardData: { getData: () => 'Neural network.' },
        target: input,
        preventDefault() {},
    }, 'tags');
    assert.equal(isDictationCleanupInProgress(), true);
    answerCleanup();
    for (let tick = 0; tick < CLEANUP_SETTLE_TICKS && isDictationCleanupInProgress(); tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(input.value, 'neural-network');
    assert.equal(isDictationCleanupInProgress(), false);
});
