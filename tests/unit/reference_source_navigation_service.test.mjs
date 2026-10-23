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
    };
}

function createTab(searchQuery = '') {
    return {
        searchQuery,
        scrollY: 0,
        scrollAnchor: null,
        sortMode: 'normal',
    };
}

test('nested reference source entries expose and dismiss one temporary context at a time', async (t) => {
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
    const backButton = new FakeHTMLElement();
    const elements = {
        'reference-source-indicator': indicator,
        'reference-source-indicator-label': label,
        'reference-view-chip-icon': new FakeHTMLElement(),
        'reference-view-chip-back': backButton,
        'notes-container': new FakeHTMLElement(),
    };
    globalThis.HTMLElement = FakeHTMLElement;
    globalThis.sessionStorage = createStorage();
    globalThis.document = {
        body: {
            classList: {
                add() {},
                remove() {},
            },
        },
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
        getActiveReferenceOriginScope,
        isViewingReferenceSource,
        getActiveReferenceChain,
        getReferenceNavigationLabelForTab,
        getActiveReferenceSourceQuery,
        popReferenceNavigationEntryForActiveTab,
        pushReferenceNavigationEntry,
        replaceActiveReferenceNavigationQuery,
        updateReferenceSourceIndicator,
    } = await import(
        '../../app/static/js/modules/mode-manager/services/reference-source-navigation-service.js'
    );

    const originScope = {
        scopeTabId: 'original',
        searchQuery: 'project',
        sortMode: 'normal',
        isUntaggedView: false,
    };

    ModeContext.hydrateTabState({
        activeTabId: 'source-1',
        tabs: {
            original: createTab('project'),
            'source-1': createTab('uuid-1'),
            'source-2': createTab('uuid-2'),
        },
        tabOrder: ['original', 'source-1', 'source-2'],
    }, { emitUpdate: false });
    pushReferenceNavigationEntry('original', 'source-1', 'uuid-1', originScope, 'backlinks');
    assert.equal(isViewingReferenceSource(), true);
    assert.equal(getReferenceNavigationLabelForTab('original'), '');
    assert.equal(getReferenceNavigationLabelForTab('source-1'), 'Referenced by');
    assert.equal(getActiveReferenceSourceQuery(), 'uuid-1');
    assert.equal(label.textContent, 'Referenced by');
    assert.deepEqual(getActiveReferenceOriginScope(), originScope);
    assert.equal(indicator.classList.contains('is-shown'), true);
    assert.equal(backButton.hidden, true, 'the first level has no back arrow');

    ModeContext.hydrateTabState({
        activeTabId: 'source-2',
        tabs: {
            original: createTab('project'),
            'source-1': createTab('uuid-1'),
            'source-2': createTab('uuid-2'),
        },
        tabOrder: ['original', 'source-1', 'source-2'],
    }, { emitUpdate: false });
    pushReferenceNavigationEntry('source-1', 'source-2', 'uuid-2', originScope, 'source');
    assert.equal(getReferenceNavigationLabelForTab('source-2'), 'Source note');
    assert.deepEqual(getActiveReferenceOriginScope(), originScope);
    assert.deepEqual(getActiveReferenceChain().map((entry) => entry.toTabId), ['source-1', 'source-2']);
    assert.equal(backButton.hidden, false, 'a second level shows the back arrow');
    replaceActiveReferenceNavigationQuery('uuid-3', 'source');
    assert.equal(getActiveReferenceSourceQuery(), 'uuid-3');
    // A source view's chip says Source note; its first line is the tooltip.
    assert.equal(label.textContent, 'Source note');
    assert.deepEqual(popReferenceNavigationEntryForActiveTab(), {
        fromTabId: 'source-1',
        toTabId: 'source-2',
        referenceQuery: 'uuid-3',
        viewKind: 'source',
        originScope,
    });
    assert.equal(indicator.classList.contains('is-shown'), false);

    ModeContext.hydrateTabState({
        activeTabId: 'source-1',
        tabs: {
            original: createTab('project'),
            'source-1': createTab('uuid-1'),
        },
        tabOrder: ['original', 'source-1'],
    }, { emitUpdate: false });
    updateReferenceSourceIndicator();
    assert.equal(indicator.classList.contains('is-shown'), true);
    assert.equal(label.textContent, 'Referenced by');
    assert.deepEqual(popReferenceNavigationEntryForActiveTab(), {
        fromTabId: 'original',
        toTabId: 'source-1',
        referenceQuery: 'uuid-1',
        viewKind: 'backlinks',
        originScope,
    });
    assert.equal(indicator.classList.contains('is-shown'), false);

    ModeContext.syncRootIds(['root-1', 'root-2']);
    ModeContext.hydrateTabState({
        activeTabId: 'source-1',
        tabs: {
            original: createTab('project'),
            'source-1': createTab('uuid-1'),
        },
        tabOrder: ['original', 'source-1'],
    }, { emitUpdate: false, preserveActiveRootTracking: true });
    assert.equal(ModeContext.knownRootCount, 2);

    await import('../../app/static/js/modules/mode-manager/services/infinite-scroll-service.js');
    await Promise.resolve();
});
