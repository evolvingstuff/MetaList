import assert from 'node:assert/strict';
import test from 'node:test';

const STORAGE_KEY = 'metalist_reference_navigation_stack';

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
    };
}

function createTab(searchQuery) {
    return { searchQuery, scrollY: 0, scrollAnchor: null, sortMode: 'normal' };
}

const ORIGIN_SCOPE = {
    scopeTabId: 'original',
    searchQuery: 'project',
    sortMode: 'normal',
    isUntaggedView: false,
};

test('reference tabs keep their hidden query and label across a page reload', async (t) => {
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalSessionStorage = globalThis.sessionStorage;
    class FakeHTMLElement {
        constructor() {
            this.hidden = true;
            this.textContent = '';
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

        querySelectorAll() {
            return [];
        }
    }
    const indicator = new FakeHTMLElement();
    const label = new FakeHTMLElement();
    const elements = {
        'reference-source-indicator': indicator,
        'reference-source-indicator-label': label,
        'reference-view-chip-back': new FakeHTMLElement(),
        'notes-container': new FakeHTMLElement(),
    };
    globalThis.HTMLElement = FakeHTMLElement;
    const storage = createStorage();
    globalThis.sessionStorage = storage;
    globalThis.document = {
        body: { classList: { add() {}, remove() {} } },
        getElementById(id) {
            return elements[id] === undefined ? null : elements[id];
        },
    };
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.HTMLElement = originalHTMLElement;
        globalThis.sessionStorage = originalSessionStorage;
    });

    const { ModeContextInstance: ModeContext } = await import(
        '../../app/static/js/modules/mode-manager/mode-context.js'
    );
    const {
        getActiveReferenceSourceQuery,
        isViewingReferenceSource,
        popReferenceNavigationEntryForActiveTab,
        pushReferenceNavigationEntry,
        restoreReferenceNavigationFromSession,
    } = await import(
        '../../app/static/js/modules/mode-manager/services/reference-source-navigation-service.js'
    );

    const openAllQuery = 'id-1 OR id-2 OR id-3 OR id-4 OR id-5 OR id-6 OR id-7';
    // What the previous page load left behind: one live entry, one whose tab was
    // searched for something else, and one whose tab no longer exists.
    storage.setItem(STORAGE_KEY, JSON.stringify([
        { fromTabId: 'original', toTabId: 'refs', referenceQuery: openAllQuery,
            originScope: ORIGIN_SCOPE, viewKind: 'references' },
        { fromTabId: 'original', toTabId: 'edited', referenceQuery: 'id-9',
            originScope: ORIGIN_SCOPE, viewKind: 'source' },
        { fromTabId: 'original', toTabId: 'closed', referenceQuery: 'id-8',
            originScope: ORIGIN_SCOPE, viewKind: 'backlinks' },
    ]));
    const serverTabs = {
        original: createTab('project'),
        refs: createTab(openAllQuery),
        edited: createTab('typed by the user'),
    };
    ModeContext.hydrateTabState({
        activeTabId: 'refs',
        tabs: serverTabs,
        tabOrder: ['original', 'refs', 'edited'],
    }, { emitUpdate: false });

    restoreReferenceNavigationFromSession(serverTabs);

    assert.equal(isViewingReferenceSource(), true);
    assert.equal(getActiveReferenceSourceQuery(), openAllQuery);
    assert.equal(indicator.classList.contains('is-shown'), true);
    assert.equal(label.textContent, 'All references');
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).map((entry) => entry.toTabId), ['refs']);

    ModeContext.hydrateTabState({
        activeTabId: 'edited',
        tabs: serverTabs,
        tabOrder: ['original', 'refs', 'edited'],
    }, { emitUpdate: false });
    assert.equal(isViewingReferenceSource(), false);

    pushReferenceNavigationEntry('original', 'edited', 'id-10', ORIGIN_SCOPE, 'source');
    assert.deepEqual(
        JSON.parse(storage.getItem(STORAGE_KEY)).map((entry) => entry.toTabId),
        ['refs', 'edited'],
    );
    popReferenceNavigationEntryForActiveTab();
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).map((entry) => entry.toTabId), ['refs']);

    assert.throws(() => restoreReferenceNavigationFromSession(serverTabs), /only once/);
});

test('a missing reference navigation record restores nothing', async (t) => {
    const originalSessionStorage = globalThis.sessionStorage;
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;
    t.after(() => {
        globalThis.sessionStorage = originalSessionStorage;
        globalThis.document = originalDocument;
        globalThis.HTMLElement = originalHTMLElement;
    });
    // Module state is shared per file, so this only checks the storage parser directly.
    const { parseStoredReferenceNavigationStack } = await import(
        '../../app/static/js/modules/mode-manager/services/reference-source-navigation-service.js'
    );
    assert.deepEqual(parseStoredReferenceNavigationStack(null), []);
    assert.throws(() => parseStoredReferenceNavigationStack('{"not":"a list"}'), /must be a list/);
    // Only known kinds of view are kept; a known kind with missing fields is still a bug.
    assert.deepEqual(parseStoredReferenceNavigationStack('[{"toTabId":"x"}]'), []);
    assert.throws(() => parseStoredReferenceNavigationStack('[{"toTabId":"x","viewKind":"source"}]'), /fromTabId/);
});
