import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ApplicationState, stateValuesEqual } from '../../app/static/js/modules/application-state.js';

const source = readFileSync(new URL('../../app/static/js/modules/mode-manager/actions/history-actions.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('function applyScrollRestore('), source.indexOf('function _applyHistorySelectionState('));

test('history scroll snapshots reconcile unchanged anchors and restore them after a changed scroll offset', () => {
    const state = ApplicationState.createFields('history-test', { scrollY: 0, anchor: null });
    const context = {
        activeTabId: '0',
        getTabScrollPosition: () => state.scrollY,
        getTabScrollAnchor: () => state.anchor,
        updateActiveTabScroll(value) {
            state.scrollY = value;
            if (state.anchor !== null) state.anchor = null;
        },
        updateActiveTabScrollAnchor(value) { state.anchor = value; },
    };
    const restore = new Function('ModeContext', 'stateValuesEqual', `${helper}\nreturn applyScrollRestore;`)(context, stateValuesEqual);
    const payload = {scrollY: 0, scrollAnchor: null, viewAnchorRootId: '', focusNoteId: '', opType: 'edit'};
    restore(payload, 'undo');
    payload.scrollAnchor = {anchorId: 'note-1', beltPrev: [], beltNext: []};
    restore(payload, 'undo');
    restore(structuredClone(payload), 'redo');
    restore({...payload, scrollY: 20}, 'undo');
    assert.equal(state.scrollY, 20);
    assert.deepEqual(state.anchor, payload.scrollAnchor);
    assert.throws(() => context.updateActiveTabScrollAnchor(payload.scrollAnchor), /Redundant/);
});
