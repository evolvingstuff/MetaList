import { ApplicationState } from '../../app/static/js/modules/application-state.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { clearEditingStateForHiddenFilteredNote } from '../../app/static/js/modules/mode-manager/services/filtered-refresh-selection-service.js';

// Exercise the real refresh action while modeling the diff renderer's delayed DOM removal.
const uiSource = readFileSync(new URL(
    '../../app/static/js/modules/mode-manager/actions/ui-actions.js', import.meta.url,
), 'utf8');
const refreshStart = uiSource.indexOf('export async function actionRefreshAndMaybeSelect(options)');
assert.ok(refreshStart >= 0);
const refreshSource = uiSource.slice(refreshStart).replace('export ', '');

function refreshHarness({ isRemoved, isAnimated, isFullSnapshot }) {
    const calls = [];
    const noteElement = { id: 'edited-note' };
    const hashes = new Set(['edited-note']);
    let isElementPresent = true;
    const snapshot = { notes: {}, rootCountTotal: 1, searchRootCountTotal: 1 };
    if (isFullSnapshot) {
        snapshot.structure = isRemoved ? [] : [{ id: 'edited-note', hash: 'new' }];
    } else {
        snapshot.diffOps = isRemoved ? [{ type: 'remove', noteId: 'edited-note' }] : [];
    }
    const ModeContext = {
        isEditing: true, currentNoteId: 'edited-note', currentContent: '<p>saved</p>',
        activeTabId: 'tab', isInitialPageLoad: false, isCaretHidden: false,
        knownRootCount: 1, seenRootCount: 1, noteCount: 1,
        getExecutedSearchQuery: () => 'implied-tag',
        getRootAnchorId: () => 'edited-note',
        getNoteHashPayload: () => ({ 'edited-note': 'old' }),
        getRootCountTotals: () => ({ rootCountTotal: 1, searchRootCountTotal: 1 }),
        hasNoteHash: (id) => hashes.has(id),
        syncNoteHashesFromSnapshot(value) {
            hashes.clear();
            value.structure.forEach(({ id }) => hashes.add(id));
        },
        setCurrentContent(value) { this.currentContent = value; },
        setEditing(value) { this.isEditing = value; },
        setCurrentNoteId(value) { this.currentNoteId = value; },
    };
    const dependencies = {
        ModeContext,
        moduleState: ApplicationState.createFields("test.refresh", { viewRequestInFlight: false }),
        Logger: { logAction() {}, logDebug() {} },
        NotesAPI: { async fetchView() { return { snapshot }; } },
        CONFIG: { DEBUG: { LOG_API_CALLS: false }, EDITOR: { DEFAULT_CURSOR_POSITION: 'START' } },
        document: { querySelector: () => isElementPresent ? noteElement : null },
        console: { log() {} },
        applyDifferentialView() {
            if (isRemoved) {
                hashes.delete('edited-note');
                isElementPresent = isAnimated;
            }
            return { notesContainer: {}, editingNoteElement: isElementPresent ? noteElement : null };
        },
        syncTagBar(element) { if (element) calls.push('sync-editor'); },
        clearTagBar() { calls.push('clear-tags'); },
        detachEditorSurface() { calls.push('detach-editor'); },
        attachEditorSurface() { calls.push('attach-editor'); },
        clearEditingStateForHiddenFilteredNote,
        initializeEditSessionCollapseStateFromNoteElement() {},
        DOMUtils: {
            getNoteContentHTML: () => '<p>saved</p>', getNoteContent: () => ({}),
            setNoteEditable() {}, revealCaret() {}, focusNoteEdge() {},
        },
        updateSearchResultsCount() {}, updateRootSortIndicator() {}, updateUntaggedViewIndicator() {},
        rebuildRootDateSeparators() {}, updatePerfOverlay() {}, async refreshBacklinksPanel() {},
    };
    const refresh = new Function(...Object.keys(dependencies),
        `let viewRequestInFlight = false;\n${refreshSource}\nreturn actionRefreshAndMaybeSelect;`,
    )(...Object.values(dependencies));
    return { refresh, ModeContext, calls };
}

for (const isFullSnapshot of [false, true]) {
    for (const isAnimated of [false, true]) {
        test(`refresh clears removed edit selection before animation completes (full=${isFullSnapshot}, animated=${isAnimated})`, async () => {
            const { refresh, ModeContext, calls } = refreshHarness({
                isRemoved: true, isAnimated, isFullSnapshot,
            });
            assert.equal(await refresh({}), null);
            assert.equal(ModeContext.isEditing, false);
            assert.equal(ModeContext.currentNoteId, null);
            assert.equal(ModeContext.currentContent, null);
            assert.deepEqual(calls, ['detach-editor', 'clear-tags']);
        });
    }

    test(`refresh preserves editing when the note remains in context (full=${isFullSnapshot})`, async () => {
        const { refresh, ModeContext, calls } = refreshHarness({
            isRemoved: false, isAnimated: true, isFullSnapshot,
        });
        assert.equal(await refresh({}), '<p>saved</p>');
        assert.equal(ModeContext.isEditing, true);
        assert.equal(ModeContext.currentNoteId, 'edited-note');
        assert.ok(calls.includes('attach-editor'));
        assert.ok(!calls.includes('detach-editor'));
    });
}

test('clearEditingStateForHiddenFilteredNote clears editing selection and editor chrome', () => {
    const calls = [];
    const modeContext = {
        isEditing: true,
        currentNoteId: 'note-1',
        currentContent: '<p>draft</p>',
        setCurrentContent(value) {
            calls.push(['setCurrentContent', value]);
            this.currentContent = value;
        },
        setEditing(value) {
            calls.push(['setEditing', value]);
            this.isEditing = value;
        },
        setCurrentNoteId(value) {
            calls.push(['setCurrentNoteId', value]);
            this.currentNoteId = value;
        },
    };

    clearEditingStateForHiddenFilteredNote({
        modeContext,
        detachEditorSurfaceFn() {
            calls.push(['detachEditorSurface']);
        },
        clearTagBarFn() {
            calls.push(['clearTagBar']);
        },
    });

    assert.equal(modeContext.isEditing, false);
    assert.equal(modeContext.currentNoteId, null);
    assert.equal(modeContext.currentContent, null);
    assert.deepEqual(calls, [
        ['setCurrentContent', null],
        ['detachEditorSurface'],
        ['clearTagBar'],
        ['setEditing', false],
        ['setCurrentNoteId', null],
    ]);
});
