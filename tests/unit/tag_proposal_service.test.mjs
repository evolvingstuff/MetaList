import assert from 'node:assert/strict';
import test from 'node:test';

// The proposals row's height is observed so the tag bar can float above it.
globalThis.ResizeObserver = class FakeResizeObserver {
    observe() {}
    unobserve() {}
};

class FakeClassList {
    constructor() {
        this.values = new Set();
    }

    add(...classNames) {
        for (const className of classNames) {
            this.values.add(className);
        }
    }

    contains(className) {
        return this.values.has(className);
    }
}

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.classList = new FakeClassList();
        this.dataset = {};
        this.attributes = {};
        this.textContent = '';
        this.type = '';
        this.style = {
            values: {},
            setProperty(name, value) { this.values[name] = value; },
            removeProperty(name) { delete this.values[name]; },
        };
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    insertBefore(child, reference) {
        const index = this.children.indexOf(reference);
        if (index < 0) {
            throw new Error('Reference child missing');
        }
        child.parentElement = this;
        this.children.splice(index, 0, child);
        return child;
    }

    after(child) {
        if (this.parentElement === null) {
            throw new Error('Cannot insert after detached element');
        }
        const index = this.parentElement.children.indexOf(this);
        if (index < 0) {
            throw new Error('Element parent relationship is inconsistent');
        }
        child.parentElement = this.parentElement;
        this.parentElement.children.splice(index + 1, 0, child);
    }

    remove() {
        if (this.parentElement === null) {
            return;
        }
        const index = this.parentElement.children.indexOf(this);
        if (index < 0) {
            throw new Error('Element parent relationship is inconsistent');
        }
        this.parentElement.children.splice(index, 1);
        this.parentElement = null;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    addEventListener(type, listener) {
        this.listeners = { ...this.listeners, [type]: listener };
    }
}

function directChild(noteElement, className) {
    return noteElement.children.find((child) => child.classList.contains(className)) || null;
}

test('proposal presentation shows editable chips and one rolled-up robot count', async (t) => {
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;
    globalThis.HTMLElement = FakeElement;
    globalThis.document = {
        createElement(tagName) {
            return new FakeElement(tagName);
        },
    };
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.HTMLElement = originalHTMLElement;
    });

    const { syncTagProposalEditingState, syncTagProposalPresentation } = await import(
        '../../app/static/js/modules/mode-manager/services/tag-proposal-service.js'
    );
    const note = new FakeElement('div');
    note.dataset.noteId = 'note-1';
    const content = new FakeElement('div');
    content.classList.add('note-content');
    note.appendChild(content);
    const tags = new FakeElement('div');
    tags.classList.add('note-tags');
    note.appendChild(tags);

    syncTagProposalPresentation(note, {
        proposedTags: 'robot-one robot-two',
        newProposedTags: '',
        proposalCount: 4,
        isEditing: true,
    });

    const row = directChild(note, 'note-tag-proposals');
    assert.ok(row);
    assert.ok(note.children.indexOf(row) > note.children.indexOf(tags));
    assert.equal(row.children.length, 2);
    assert.equal(row.children[0].children[0].textContent, 'robot-one');
    assert.equal(row.children[0].children[1].dataset.proposalAction, 'accept');
    assert.equal(row.children[0].children[2].dataset.proposalAction, 'reject');
    const indicator = directChild(note, 'note-proposal-indicator');
    assert.ok(indicator);
    assert.equal(indicator.textContent, '🤖 4');

    syncTagProposalPresentation(note, {
        proposedTags: 'robot-one robot-two',
        newProposedTags: '',
        proposalCount: 4,
        isEditing: false,
    });

    assert.equal(directChild(note, 'note-tag-proposals'), null);
    assert.equal(directChild(note, 'note-proposal-indicator').textContent, '🤖 4');

    const editingTagBar = new FakeElement('div');
    editingTagBar.classList.add('note-tag-bar');
    note.appendChild(editingTagBar);
    syncTagProposalEditingState(note, true);

    const restoredRow = directChild(note, 'note-tag-proposals');
    assert.ok(restoredRow);
    assert.equal(restoredRow.children.length, 2);
    assert.equal(note.children.indexOf(restoredRow), note.children.indexOf(editingTagBar) + 1);
});

test('new-tag proposals sit together on the right, each with a new badge', async (t) => {
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;
    globalThis.HTMLElement = FakeElement;
    globalThis.document = {
        createElement(tagName) {
            return new FakeElement(tagName);
        },
    };
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.HTMLElement = originalHTMLElement;
    });

    const { syncTagProposalEditingState, syncTagProposalPresentation } = await import(
        '../../app/static/js/modules/mode-manager/services/tag-proposal-service.js'
    );
    const note = new FakeElement('div');
    note.dataset.noteId = 'note-2';
    const editingTagBar = new FakeElement('div');
    editingTagBar.classList.add('note-tag-bar');
    note.appendChild(editingTagBar);

    syncTagProposalPresentation(note, {
        proposedTags: 'Cherry-Blossoms japan sakura kyoto',
        newProposedTags: 'cherry-blossoms sakura',
        proposalCount: 4,
        isEditing: true,
    });

    const describeRow = () => directChild(note, 'note-tag-proposals').children.map((pill) => ({
        label: pill.children[0].textContent,
        isNew: pill.classList.contains('note-tag-proposal-is-new'),
        parts: pill.children.map((part) => [...part.classList.values].join(' ')),
        accept: pill.children.find((part) => part.dataset.proposalAction === 'accept').attributes['aria-label'],
    }));
    const expected = [
        { label: 'japan', isNew: false, parts: ['note-tag-proposal-label', 'note-tag-proposal-action note-tag-proposal-accept', 'note-tag-proposal-action note-tag-proposal-reject'], accept: 'Accept proposed tag japan' },
        { label: 'kyoto', isNew: false, parts: ['note-tag-proposal-label', 'note-tag-proposal-action note-tag-proposal-accept', 'note-tag-proposal-action note-tag-proposal-reject'], accept: 'Accept proposed tag kyoto' },
        { label: 'Cherry-Blossoms', isNew: true, parts: ['note-tag-proposal-label', 'note-tag-proposal-new', 'note-tag-proposal-action note-tag-proposal-accept', 'note-tag-proposal-action note-tag-proposal-reject'], accept: 'Accept proposed new tag Cherry-Blossoms' },
        { label: 'sakura', isNew: true, parts: ['note-tag-proposal-label', 'note-tag-proposal-new', 'note-tag-proposal-action note-tag-proposal-accept', 'note-tag-proposal-action note-tag-proposal-reject'], accept: 'Accept proposed new tag sakura' },
    ];
    assert.deepEqual(describeRow(), expected);
    const badge = directChild(note, 'note-tag-proposals').children[2].children[1];
    assert.equal(badge.textContent, 'new');
    assert.equal(badge.attributes.title, 'Not on any of your notes yet');

    // Leaving and re-entering edit mode rebuilds the same row from the note's data.
    syncTagProposalEditingState(note, false);
    assert.equal(directChild(note, 'note-tag-proposals'), null);
    syncTagProposalEditingState(note, true);
    assert.deepEqual(describeRow(), expected);

    assert.throws(() => syncTagProposalPresentation(note, {
        proposedTags: 'japan kyoto',
        newProposedTags: 'sakura',
        proposalCount: 2,
        isEditing: true,
    }), /New proposal sakura is not one of the note's proposals/);
});

function fakeEventTarget() {
    const listeners = new Map();
    return {
        listeners,
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        removeEventListener(type, listener) {
            if (listeners.get(type) === listener) {
                listeners.delete(type);
            }
        },
    };
}

test('Suggest Tags with AI status floats on a card in the tag bar, never in the row', async (t) => {
    const originalDocument = globalThis.document;
    const originalHTMLElement = globalThis.HTMLElement;
    const originalWindow = globalThis.window;
    const fakeWindow = fakeEventTarget();
    const fakeDocument = { ...fakeEventTarget(), createElement: (tagName) => new FakeElement(tagName) };
    globalThis.HTMLElement = FakeElement;
    globalThis.document = fakeDocument;
    globalThis.window = fakeWindow;
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.HTMLElement = originalHTMLElement;
        globalThis.window = originalWindow;
    });

    const { isAskingAiForTags, setAiTagSuggestionStatus, syncTagProposalEditingState, syncTagProposalPresentation } = await import(
        '../../app/static/js/modules/mode-manager/services/tag-proposal-service.js'
    );
    const note = new FakeElement('div');
    note.dataset.noteId = 'note-3';
    const editingTagBar = new FakeElement('div');
    editingTagBar.classList.add('note-tag-bar');
    note.appendChild(editingTagBar);
    syncTagProposalPresentation(note, { proposedTags: '', newProposedTags: '', proposalCount: 0, isEditing: true });

    const card = () => directChild(editingTagBar, 'note-tag-bar-ai-status');
    const setStatus = (status) => setAiTagSuggestionStatus({ noteId: 'note-3', status, noteElement: note, isEditing: true });

    // Asking: a card in the tag bar; the note gets no row for it.
    setStatus('asking');
    assert.equal(isAskingAiForTags('note-3'), true);
    assert.equal(card().textContent, 'Asking the AI…');
    assert.equal(card().attributes.role, 'status');
    assert.equal(directChild(note, 'note-tag-proposals'), null, 'nothing is written into the note');

    // The proposals arrive (the view refreshes) while the card still shows, then it goes.
    syncTagProposalPresentation(note, { proposedTags: 'kyoto', newProposedTags: '', proposalCount: 1, isEditing: true });
    assert.equal(directChild(note, 'note-tag-proposals').children.length, 1);
    assert.equal(card().textContent, 'Asking the AI…');
    setStatus('');
    assert.equal(card(), null);
    assert.equal(isAskingAiForTags('note-3'), false);

    // Nothing new: a bare modifier key keeps it; the next key or click dismisses it.
    setStatus('asking');
    setStatus('nothing-new');
    assert.equal(card().textContent, 'No new tags to suggest');
    fakeWindow.listeners.get('keydown')({ key: 'Shift' });
    assert.equal(card().textContent, 'No new tags to suggest');
    fakeWindow.listeners.get('keydown')({ key: 'a' });
    assert.equal(card(), null);
    assert.equal(fakeWindow.listeners.has('keydown'), false, 'stops listening once dismissed');
    assert.equal(fakeDocument.listeners.has('mousedown'), false);

    setStatus('asking');
    setStatus('nothing-new');
    fakeDocument.listeners.get('mousedown')({});
    assert.equal(card(), null);

    // Or the end of editing; editing again shows nothing.
    setStatus('asking');
    setStatus('nothing-new');
    syncTagProposalEditingState(note, false);
    assert.equal(card(), null);
    assert.equal(fakeWindow.listeners.has('keydown'), false);
    syncTagProposalEditingState(note, true);
    assert.equal(card(), null);

    assert.throws(() => setStatus('thinking'), /Unknown Suggest Tags with AI status/);

    // A note off the page: the status still changes, so the item is offered again.
    setAiTagSuggestionStatus({ noteId: 'note-away', status: 'asking', noteElement: null, isEditing: false });
    assert.equal(isAskingAiForTags('note-away'), true);
    setAiTagSuggestionStatus({ noteId: 'note-away', status: '', noteElement: null, isEditing: false });
    assert.equal(isAskingAiForTags('note-away'), false);
});
