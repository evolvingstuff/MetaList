import assert from 'node:assert/strict';
import test from 'node:test';

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
