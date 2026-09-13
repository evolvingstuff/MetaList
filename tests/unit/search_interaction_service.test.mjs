import { ApplicationState } from '../../app/static/js/modules/application-state.js';
import assert from 'node:assert/strict';
import test from 'node:test';

function createStorage() {
    const entries = new Map();
    return {
        getItem: (key) => entries.has(key) ? entries.get(key) : null,
        setItem: (key, value) => entries.set(key, String(value)),
        removeItem: (key) => entries.delete(key),
    };
}

globalThis.sessionStorage = createStorage();
globalThis.localStorage = createStorage();
globalThis.window = {};

const { NotesAPI } = await import('../../app/static/js/modules/api-client.js');
const { ModeContextInstance: ModeContext } = await import(
    '../../app/static/js/modules/mode-manager/mode-context.js'
);
const {
    primeActiveSearchInteractionState,
    recordNoteInteractionIfNew,
    recordStructuralNoteInteractionIfMoved,
    resetNoteInteractionStateForTests,
} = await import('../../app/static/js/modules/mode-manager/services/search-interaction-service.js');
const {
    setLimitNoteCreditsPerSearchContextValue,
    receiveSearchSuggestionPreferences,
} = await import('../../app/static/js/modules/mode-manager/services/search-suggestion-windows-service.js');


test('default limit credits each note once across the complete search context', async (t) => {
    const originalRecordNoteInteraction = NotesAPI.recordNoteInteraction;
    const originalQuery = ModeContext._tabExecutedSearchQuery['0'];
    const calls = [];
    NotesAPI.recordNoteInteraction = async (noteId, interactionType) => {
        calls.push({ noteId, interactionType });
        return { credited: true };
    };
    ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': 'shortcut'}});
    resetNoteInteractionStateForTests();
    receiveSearchSuggestionPreferences({windows: '[1,7,30]', showLabels: true, limitCredits: true});
    t.after(() => {
        NotesAPI.recordNoteInteraction = originalRecordNoteInteraction;
        ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': originalQuery}});
        resetNoteInteractionStateForTests();
        receiveSearchSuggestionPreferences({windows: '[1,7,30]', showLabels: true, limitCredits: true});
    });

    assert.equal(await recordNoteInteractionIfNew('note-1', 'edit'), true);
    assert.equal(await recordNoteInteractionIfNew('note-1', 'expand'), false);
    assert.equal(await recordNoteInteractionIfNew('note-1', 'command'), false);
    assert.equal(await recordNoteInteractionIfNew('note-1', 'fullscreen'), false);
    assert.deepEqual(calls, [{ noteId: 'note-1', interactionType: 'edit' }]);

    assert.equal(await recordNoteInteractionIfNew('note-2', 'expand'), true);
    assert.equal(await recordNoteInteractionIfNew('note-1', 'command'), false);
    assert.deepEqual(calls, [
        { noteId: 'note-1', interactionType: 'edit' },
        { noteId: 'note-2', interactionType: 'expand' },
    ]);
});


test('disabled limit credits every qualifying interaction', async (t) => {
    const originalRecordNoteInteraction = NotesAPI.recordNoteInteraction;
    const originalQuery = ModeContext._tabExecutedSearchQuery['0'];
    const calls = [];
    NotesAPI.recordNoteInteraction = async (noteId, interactionType) => {
        calls.push({ noteId, interactionType });
        return { credited: true };
    };
    ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': ''}});
    resetNoteInteractionStateForTests();
    setLimitNoteCreditsPerSearchContextValue('false');
    t.after(() => {
        NotesAPI.recordNoteInteraction = originalRecordNoteInteraction;
        ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': originalQuery}});
        resetNoteInteractionStateForTests();
        receiveSearchSuggestionPreferences({windows: '[1,7,30]', showLabels: true, limitCredits: true});
    });

    assert.equal(await recordNoteInteractionIfNew('note-1', 'edit'), true);
    assert.equal(await recordNoteInteractionIfNew('note-1', 'expand'), true);
    assert.equal(await recordNoteInteractionIfNew('note-1', 'command'), true);
    assert.deepEqual(calls, [
        { noteId: 'note-1', interactionType: 'edit' },
        { noteId: 'note-1', interactionType: 'expand' },
        { noteId: 'note-1', interactionType: 'command' },
    ]);
});


test('successful structural actions participate in the per-context note limit', async (t) => {
    const originalRecordNoteInteraction = NotesAPI.recordNoteInteraction;
    const originalQuery = ModeContext._tabExecutedSearchQuery['0'];
    const calls = [];
    NotesAPI.recordNoteInteraction = async (noteId, interactionType) => {
        calls.push({ noteId, interactionType });
        return { credited: true };
    };
    ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': ''}});
    resetNoteInteractionStateForTests();
    receiveSearchSuggestionPreferences({windows: '[1,7,30]', showLabels: true, limitCredits: true});
    t.after(() => {
        NotesAPI.recordNoteInteraction = originalRecordNoteInteraction;
        ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': originalQuery}});
        resetNoteInteractionStateForTests();
        receiveSearchSuggestionPreferences({windows: '[1,7,30]', showLabels: true, limitCredits: true});
    });

    assert.equal(await recordNoteInteractionIfNew('brainstorm-note', 'edit'), true);
    assert.equal(
        await recordStructuralNoteInteractionIfMoved(
            'brainstorm-note',
            'outdent',
            { status: 'moved' },
        ),
        false,
    );
    assert.equal(
        await recordStructuralNoteInteractionIfMoved(
            'other-note',
            'move',
            { status: 'moved' },
        ),
        true,
    );
    assert.equal(
        await recordStructuralNoteInteractionIfMoved(
            'noop-note',
            'indent',
            { status: 'noop' },
        ),
        false,
    );
    assert.deepEqual(calls, [
        { noteId: 'brainstorm-note', interactionType: 'edit' },
        { noteId: 'other-note', interactionType: 'move' },
    ]);
});


test('a new executed search starts a new engagement flow for the same note', async (t) => {
    const originalRecordNoteInteraction = NotesAPI.recordNoteInteraction;
    const originalQuery = ModeContext._tabExecutedSearchQuery['0'];
    let callCount = 0;
    NotesAPI.recordNoteInteraction = async () => {
        callCount += 1;
        return { credited: true };
    };
    ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': 'shortcut'}});
    resetNoteInteractionStateForTests();
    t.after(() => {
        NotesAPI.recordNoteInteraction = originalRecordNoteInteraction;
        ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': originalQuery}});
        resetNoteInteractionStateForTests();
    });

    await recordNoteInteractionIfNew('note-1', 'command');
    ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': 'shortcut @shell'}});
    primeActiveSearchInteractionState();
    await recordNoteInteractionIfNew('note-1', 'command');

    assert.equal(callCount, 2);
});


test('returning to a prior tab context starts a new engagement flow', async (t) => {
    const originalRecordNoteInteraction = NotesAPI.recordNoteInteraction;
    const originalActiveTabId = ModeContext._activeTabId;
    const originalQuery0 = ModeContext._tabExecutedSearchQuery['0'];
    const originalQuery1 = ModeContext._tabExecutedSearchQuery['1'];
    let callCount = 0;
    NotesAPI.recordNoteInteraction = async () => {
        callCount += 1;
        return { credited: true };
    };
    ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': 'shortcut'}});
    ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '1': 'journal'}});
    ApplicationState.receiveOwnerSnapshot(ModeContext, {_activeTabId: '0'});
    resetNoteInteractionStateForTests();
    t.after(() => {
        NotesAPI.recordNoteInteraction = originalRecordNoteInteraction;
        ApplicationState.receiveOwnerSnapshot(ModeContext, {_activeTabId: originalActiveTabId});
        ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '0': originalQuery0}});
        if (typeof originalQuery1 === 'undefined') {
            delete ModeContext._tabExecutedSearchQuery['1'];
        } else {
            ApplicationState.receiveOwnerSnapshot(ModeContext, {_tabExecutedSearchQuery: {...ModeContext._tabExecutedSearchQuery, '1': originalQuery1}});
        }
        resetNoteInteractionStateForTests();
    });

    await recordNoteInteractionIfNew('shell-note', 'command');
    ApplicationState.receiveOwnerSnapshot(ModeContext, {_activeTabId: '1'});
    primeActiveSearchInteractionState();
    ApplicationState.receiveOwnerSnapshot(ModeContext, {_activeTabId: '0'});
    primeActiveSearchInteractionState();
    await recordNoteInteractionIfNew('shell-note', 'command');

    assert.equal(callCount, 2);
});
