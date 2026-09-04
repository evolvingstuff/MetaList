import assert from 'node:assert/strict';
import test from 'node:test';

function installFakeElementDom(t) {
    const originalHTMLElement = globalThis.HTMLElement;

    class FakeElement {
        constructor({ selectors = [], tag = null, referenceNoteId = null } = {}) {
            this._selectors = new Set(selectors);
            this.dataset = {};
            if (tag !== null) {
                this.dataset.tag = tag;
            }
            if (referenceNoteId !== null) {
                this.dataset.refNoteId = referenceNoteId;
            }
        }

        closest(selector) {
            return this._selectors.has(selector) ? this : null;
        }
    }

    globalThis.HTMLElement = FakeElement;
    t.after(() => {
        globalThis.HTMLElement = originalHTMLElement;
    });

    return { FakeElement };
}

test('reference context resolves the closest rendered reference source', async (t) => {
    const { FakeElement } = installFakeElementDom(t);
    const { resolveReferenceContextFromElement } = await importTargetService();
    const reference = new FakeElement({
        selectors: ['.note-reference-note[data-ref-note-id]'],
        referenceNoteId: 'source-note-456',
    });

    assert.deepEqual(resolveReferenceContextFromElement(reference), {
        referenceNoteId: 'source-note-456',
    });
});

async function importTargetService() {
    return await import(
        '../../app/static/js/modules/mode-manager/services/context-menu-target-service.js'
    );
}

test('search input wins over an overlapping left rail', async (t) => {
    const { FakeElement } = installFakeElementDom(t);
    const { resolvePriorityContextMenuTarget } = await importTargetService();
    const searchInput = new FakeElement({ selectors: ['#search-input'] });

    assert.deepEqual(
        resolvePriorityContextMenuTarget(searchInput, {
            isInLeftRail: true,
            isInRightRail: false,
        }),
        { kind: 'search-input', element: searchInput },
    );
});

test('tag-bar input wins over an overlapping side rail', async (t) => {
    const { FakeElement } = installFakeElementDom(t);
    const { resolvePriorityContextMenuTarget } = await importTargetService();
    const tagBarInput = new FakeElement({ selectors: ['.note-tag-bar-input'] });

    assert.deepEqual(
        resolvePriorityContextMenuTarget(tagBarInput, {
            isInLeftRail: false,
            isInRightRail: true,
        }),
        { kind: 'tag-bar-input', element: tagBarInput },
    );
});

test('search and tag-bar suggestion tags win over overlapping rails', async (t) => {
    const { FakeElement } = installFakeElementDom(t);
    const { resolvePriorityContextMenuTarget } = await importTargetService();
    const searchSuggestion = new FakeElement({
        selectors: ['.search-suggestion'],
        tag: 'Sarah-Hayes',
    });
    const tagBarSuggestion = new FakeElement({
        selectors: ['.note-tag-suggestion'],
        tag: 'project-alpha',
    });

    assert.deepEqual(
        resolvePriorityContextMenuTarget(searchSuggestion, {
            isInLeftRail: true,
            isInRightRail: false,
        }),
        {
            kind: 'tag-suggestion',
            tag: 'Sarah-Hayes',
            source: 'search',
        },
    );
    assert.deepEqual(
        resolvePriorityContextMenuTarget(tagBarSuggestion, {
            isInLeftRail: false,
            isInRightRail: true,
        }),
        {
            kind: 'tag-suggestion',
            tag: 'project-alpha',
            source: 'tag-bar',
        },
    );
});

test('blank side-rail targets retain the rail context menus', async (t) => {
    const { FakeElement } = installFakeElementDom(t);
    const { resolvePriorityContextMenuTarget } = await importTargetService();
    const blankTarget = new FakeElement();

    assert.deepEqual(
        resolvePriorityContextMenuTarget(blankTarget, {
            isInLeftRail: true,
            isInRightRail: false,
        }),
        { kind: 'tabs-rail' },
    );
    assert.deepEqual(
        resolvePriorityContextMenuTarget(blankTarget, {
            isInLeftRail: false,
            isInRightRail: true,
        }),
        { kind: 'view-rail' },
    );
});

test('note content wins over an overlapping coordinate-only rail', async (t) => {
    const { FakeElement } = installFakeElementDom(t);
    const { resolvePriorityContextMenuTarget } = await importTargetService();
    const noteContent = new FakeElement({ selectors: ['.note-content'] });

    assert.equal(
        resolvePriorityContextMenuTarget(noteContent, {
            isInLeftRail: true,
            isInRightRail: false,
        }),
        null,
    );
});
