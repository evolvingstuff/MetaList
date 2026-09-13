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
        removeItem(key) {
            entries.delete(key);
        },
        clear() {
            entries.clear();
        },
    };
}

function installModeContextGlobals(t) {
    const originalSessionStorage = globalThis.sessionStorage;
    const originalDocument = globalThis.document;
    const originalPerformance = globalThis.performance;

    globalThis.sessionStorage = createStorage();
    globalThis.document = {
        body: {
            classList: {
                add() {},
                remove() {},
            },
        },
    };
    globalThis.performance = {
        now() {
            return 0;
        },
    };

    t.after(() => {
        globalThis.sessionStorage = originalSessionStorage;
        globalThis.document = originalDocument;
        globalThis.performance = originalPerformance;
    });
}

test('nested tab records cannot change state through getters', async (t) => {
    installModeContextGlobals(t);
    const { ModeContextInstance: state } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const previous = state.tabs[state.activeTabId].searchQuery;
    assert.throws(() => { state.tabs[state.activeTabId].searchQuery = 'bypass'; }, TypeError);
    assert.equal(state.tabs[state.activeTabId].searchQuery, previous);
});

test('hash writes reject an unchanged value', async (t) => {
    installModeContextGlobals(t);
    const { ModeContextInstance: state } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    state.setNoteHash('strict-hash', 'one');
    assert.throws(() => state.setNoteHash('strict-hash', 'one'), /Redundant state change/);
});

test('modal state requires a lifecycle and rejects repeated updates and getter mutation', async (t) => {
    installModeContextGlobals(t);
    const { BaseModal } = await import('../../app/static/js/modules/modals/base-modal.js');
    const modal = new BaseModal('strict-state-probe', 'probe');
    assert.throws(() => modal.updateModalState({ isSaving: false }), /not initialized/);
    modal.getInitialModalState = () => ({ isSaving: false, nested: { count: 1 } });
    modal.initializeModalState();
    assert.throws(() => modal.updateModalState({ isSaving: false }), /Redundant state change/);
    assert.throws(() => { modal.getModalState().nested.count = 2; }, TypeError);
    modal.updateModalState({ isSaving: true });
    assert.equal(modal.getModalState().isSaving, true);
    modal.removeModalState();
    assert.throws(() => modal.getModalState(), /not initialized/);
});

test('CommandGate detects a command clearing gate-owned loading state', async (t) => {
    installModeContextGlobals(t);
    const { ModeContextInstance: state } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const { CommandGate } = await import('../../app/static/js/modules/mode-manager/services/command-gate-service.js');
    await assert.rejects(CommandGate.run('invalid-owner', async () => state.setLoading(false)), /Redundant state change|ownership/);
});

test('ModeContext scalar setters reject same-value writes', async (t) => {
    installModeContextGlobals(t);
    const { ModeContextInstance: ModeContext } = await import('../../app/static/js/modules/mode-manager/mode-context.js');

    ModeContext.setSearchQuery('strict-state-test');
    assert.throws(
        () => ModeContext.setSearchQuery('strict-state-test'),
        /Redundant state change: searchQuery is already strict-state-test/
    );

    ModeContext.setLastUpdateUUID('uuid-strict-state-test');
    assert.throws(
        () => ModeContext.setLastUpdateUUID('uuid-strict-state-test'),
        /Redundant state change: lastUpdateUUID is already uuid-strict-state-test/
    );
});

test('ModeContext notifies listeners when an executable search query is committed', async (t) => {
    installModeContextGlobals(t);
    const { ModeContextInstance: ModeContext } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const notifications = [];
    const listener = (property, value) => {
        notifications.push({ property, value });
    };
    ModeContext.addListener(listener);
    t.after(() => {
        ModeContext.removeListener(listener);
    });

    ModeContext.setExecutedSearchQuery('committed-search-test');

    assert.deepEqual(notifications, [
        { property: 'executedSearchQuery', value: 'committed-search-test' },
    ]);
});

test('ModeContext modal stack uses strict mutators instead of direct array mutation', async (t) => {
    installModeContextGlobals(t);
    const { ModeContextInstance: ModeContext } = await import('../../app/static/js/modules/mode-manager/mode-context.js');

    ModeContext.pushModal('strictModal');
    assert.equal(ModeContext.topModal, 'strictModal');
    assert.deepEqual(ModeContext.modalStack, ['strictModal']);
    assert.throws(
        () => ModeContext.pushModal('strictModal'),
        /Redundant state change: modalStack already has strictModal on top/
    );
    assert.throws(
        () => ModeContext.modalStack.push('directMutation'),
        /Cannot add property/
    );

    ModeContext.removeModal('strictModal');
    assert.equal(ModeContext.topModal, null);
    assert.deepEqual(ModeContext.modalStack, []);
    assert.throws(
        () => ModeContext.removeModal('strictModal'),
        /Redundant state change: modalStack does not contain strictModal/
    );
});

test('ModeContext keeps the untagged view outside persisted tab state', async (t) => {
    installModeContextGlobals(t);
    const { ModeContextInstance: ModeContext } = await import('../../app/static/js/modules/mode-manager/mode-context.js');

    ModeContext.setUntaggedView(true);
    t.after(() => {
        if (ModeContext.isUntaggedView) {
            ModeContext.setUntaggedView(false);
        }
    });

    const serializedTabState = ModeContext.getTabStatePayload();

    assert.equal(ModeContext.isUntaggedView, true);
    assert.equal(Object.hasOwn(serializedTabState, 'isUntaggedView'), false);
    for (const tab of Object.values(serializedTabState.tabs)) {
        assert.equal(Object.hasOwn(tab, 'isUntaggedView'), false);
    }
});

test('distinct edits in one clock tick remain valid while duplicate content and edit markers throw', async (t) => {
    installModeContextGlobals(t);
    const { ModeContextInstance: state } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const now = Date.now;
    t.after(() => { Date.now = now; });
    Date.now = () => 12345;
    state.setCurrentContent('first edit in one tick');
    state.setCurrentContent('second edit in one tick');
    assert.equal(state.currentContent, 'second edit in one tick');
    assert.throws(() => state.setCurrentContent('second edit in one tick'), /Redundant/);
    state.resetEditSessionState({startedCollapsed: false});
    state.markEditSessionHasEdits();
    assert.throws(() => state.markEditSessionHasEdits(), /Redundant/);
    state.markEditSessionExpandedPersisted();
    assert.throws(() => state.markEditSessionExpandedPersisted(), /Redundant/);
});

test('confirmation decisions have distinct pending and closed lifecycles', async (t) => {
    installModeContextGlobals(t);
    const { ConfirmationModal } = await import('../../app/static/js/modules/modals/confirmation-modal.js');
    const modal = new ConfirmationModal();
    modal.open = () => { modal.isOpen = true; };
    const context = {eyebrow: 'Test', title: 'Confirm', description: 'Test lifecycle', confirmLabel: 'Yes', isDangerous: false};
    for (const accepted of [false, false, true]) {
        const result = modal.openForConfirmation(context);
        if (accepted) modal._decision.result = true;
        modal.onClose();
        modal.isOpen = false;
        assert.equal(await result, accepted);
        assert.equal(modal._decision, null);
        assert.equal(modal._pendingResolve, null);
    }
});

test('root count pairs allow either component to change but reject an unchanged pair', async (t) => {
    installModeContextGlobals(t);
    const { ModeContextInstance } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const state = new ModeContextInstance.constructor();
    state.setRootCountTotals(10, 5, '0');
    state.setRootCountTotals(10, 6, '0');
    state.setRootCountTotals(11, 6, '0');
    assert.deepEqual(state.getRootCountTotals('0'), {rootCountTotal: 11, searchRootCountTotal: 6});
    assert.throws(() => state.setRootCountTotals(11, 6, '0'), /Redundant/);
});

test('tab hydration and switching preserve unchanged query and scroll observations', async (t) => {
    installModeContextGlobals(t);
    const previousWindow = globalThis.window;
    globalThis.window = {scrollY: 0};
    t.after(() => { globalThis.window = previousWindow; });
    const { ModeContextInstance } = await import('../../app/static/js/modules/mode-manager/mode-context.js');
    const state = new ModeContextInstance.constructor();
    state._notifyInfiniteScrollTabSwitch = () => {};
    const payload = {
        activeTabId: '0', tabOrder: ['0', '1'],
        tabs: Object.fromEntries(['0', '1'].map(id => [id, {
            searchQuery: '', scrollY: 0, scrollAnchor: null, sortMode: 'normal',
        }])),
    };
    state.hydrateTabState(payload, {preserveActiveRootTracking: true});
    state.hydrateTabState(payload, {preserveActiveRootTracking: true});
    state.switchToTab('1', {force: true});
    assert.equal(state.activeTabId, '1');
    assert.equal(state.searchQuery, '');
    assert.throws(() => state.switchToTab('1', {force: true}), /Redundant/);
    state.switchToTab('0', {});
    assert.equal(state.activeTabId, '0');
});
