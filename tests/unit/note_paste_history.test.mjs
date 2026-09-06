import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { shouldUseApplicationHistory } from '../../app/static/js/modules/mode-manager/services/history-shortcut-policy-service.js';

// Execute the actual action with its transport/view dependencies replaced.
const source = readFileSync(new URL('../../app/static/js/modules/mode-manager/actions/note-actions.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function actionPasteNoteSibling()');
const end = source.indexOf('export async function actionPasteNoteChild()', start);
assert.ok(start >= 0 && end > start);
const actionSource = source.slice(start, end).replace('export ', '');

function harness({ priorEdits, failPaste }) {
    const events = [];
    const ModeContext = {
        currentNoteId: 'blank-note', isEditing: true, isDirty: priorEdits,
        editSessionHasEdits: priorEdits, editSessionStartedCollapsed: false,
        currentContent: '<div><br></div>',
        markEditSessionHasEdits() { this.editSessionHasEdits = true; },
        resetEditSessionState() { this.editSessionHasEdits = false; },
        setCurrentContent(content) { this.currentContent = content; },
        setDirty(value) { this.isDirty = value; },
    };
    const preview = '<span class="embedded-document" contenteditable="false" data-document-id="clone-id"><img src="data:image/svg+xml;base64,AAAA"></span>';
    const dependencies = {
        ModeContext,
        Logger: { logAction() {} },
        NotesAPI: { async pasteNoteSibling() {
            events.push('paste');
            if (failPaste) throw new Error('paste rejected');
            return { status: 'pasted', id: 'blank-note' };
        } },
        async actionSaveNote() { events.push('save'); ModeContext.isDirty = false; },
        resolveNotePasteResponse(response) { return response.id; },
        async actionRefreshAndMaybeSelect() { events.push('refresh'); return preview; },
        async actionSwitchNotes() { throw new Error('Same-note paste must not switch notes'); },
        scrollNoteIntoView() {},
        window: { requestAnimationFrame(callback) { callback(); } },
        ErrorHandler: { showErrorBanner() { throw new Error('Unexpected banner'); } },
    };
    const run = new Function(...Object.keys(dependencies), `${actionSource}\nreturn actionPasteNoteSibling;`)(...Object.values(dependencies));
    return { run, ModeContext, events, preview };
}

for (const priorEdits of [false, true]) {
    test(`saved diagram paste routes the next undo to application history (prior edits: ${priorEdits})`, async () => {
        const { run, ModeContext, events, preview } = harness({ priorEdits, failPaste: false });
        assert.equal(await run(), true);
        assert.equal(ModeContext.currentContent, preview);
        assert.equal(ModeContext.isDirty, false);
        assert.equal(shouldUseApplicationHistory(ModeContext), true);
        assert.deepEqual(events.slice(-2), ['paste', 'refresh']);
        if (priorEdits) assert.equal(events[0], 'save');
        // Actual typing after the paste must continue to use local editor undo.
        ModeContext.markEditSessionHasEdits();
        ModeContext.isDirty = true;
        assert.equal(shouldUseApplicationHistory(ModeContext), false);
    });
}

test('a rejected paste preserves the existing local edit history', async () => {
    const { run, ModeContext, events } = harness({ priorEdits: true, failPaste: true });
    await assert.rejects(run, /paste rejected/);
    assert.equal(ModeContext.editSessionHasEdits, true);
    assert.deepEqual(events, ['save', 'paste']);
});

const keyboardSource = readFileSync(new URL('../../app/static/js/modules/mode-manager/events/keyboard-events.js', import.meta.url), 'utf8');
const referenceStart = keyboardSource.indexOf('function handleInsertEmbedReferenceShortcut(event)');
const referenceEnd = keyboardSource.indexOf('async function handleSplitNoteShortcut(event)', referenceStart);
assert.ok(referenceStart >= 0 && referenceEnd > referenceStart);

function referenceHarness({ isEditing, clipboardNoteId }) {
    const events = [];
    const pending = [];
    const ModeContext = {
        isEditing, clipboardNoteId, currentNoteId: null,
        resetEditSessionState() { events.push('reset'); },
    };
    if (isEditing) ModeContext.currentNoteId = 'selected';
    const dependencies = {
        ModeContext,
        Logger: { logNoop() {} },
        CommandGate: { run(_name, callback) { const promise = callback(); pending.push(promise); return promise; } },
        async createNoteAtTop() { events.push('top'); ModeContext.isEditing = true; ModeContext.currentNoteId = 'new-top'; return 'new-top'; },
        async createChildNote() { events.push('child'); },
        insertReferenceTokenIntoActiveEditor(token) { events.push(token); },
        async actionSaveNote(id) { events.push(`save:${id}`); },
    };
    const run = new Function(...Object.keys(dependencies), `${keyboardSource.slice(referenceStart, referenceEnd)}\nreturn handleInsertEmbedReferenceShortcut;`)(...Object.values(dependencies));
    const event = { shiftKey: false, preventDefault() { events.push('prevent'); }, stopPropagation() {} };
    return { run, event, events, pending };
}

test('reference paste with no selected note creates and saves a top note', async () => {
    const { run, event, events, pending } = referenceHarness({ isEditing: false, clipboardNoteId: 'original-note' });
    run(event);
    await Promise.all(pending);
    assert.deepEqual(events, ['prevent', 'top', '![[original-note]]', 'save:new-top', 'reset']);
});

test('reference paste without a copied note does not create an empty note', async () => {
    const { run, event, events, pending } = referenceHarness({ isEditing: false, clipboardNoteId: null });
    run(event);
    await Promise.all(pending);
    assert.deepEqual(events, ['prevent']);
});

test('shift-reference paste still creates a child of the selected note', async () => {
    const { run, event, events, pending } = referenceHarness({ isEditing: true, clipboardNoteId: 'original-note' });
    event.shiftKey = true;
    run(event);
    await Promise.all(pending);
    assert.deepEqual(events, ['prevent', 'child', '![[original-note]]']);
});
