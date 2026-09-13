import { ApplicationState } from '../../app/static/js/modules/application-state.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isViewModeNoteLink, resolveNonContentNoteSelectionTarget } from '../../app/static/js/modules/mode-manager/services/note-click-target-service.js';

const source = readFileSync(new URL(
    '../../app/static/js/modules/mode-manager/events/mouse-events.js', import.meta.url,
), 'utf8').replace(/^import[\s\S]*?from '[^']+';\s*/gm, '').replace(/^export /gm, '');

function harness(isEditing) {
    class Element {
        closest() { return null; }
    }
    const note = new Element();
    note.dataset = { noteId: 'note-1' };
    note.classList = { contains: (name) => name === 'editing' && isEditing };
    const content = new Element();
    content.closest = (selector) => selector === '.note' ? note : null;
    const anchor = new Element();
    anchor.closest = (selector) => ({ '.note': note, '.note-content': content })[selector] ?? null;
    const label = new Element();
    label.closest = (selector) => ({ 'a[href]': anchor, '.note': note, '.note-content': content })[selector] ?? null;
    const events = [];
    const dependencies = {
        Element, isViewModeNoteLink, resolveNonContentNoteSelectionTarget,
        ModeContext: { isEditing, currentNoteId: isEditing ? 'note-1' : null, isConnected: true, isLoading: false },
        isContextMenuInteractionTarget: () => false,
        Logger: { logNoop() {}, logDebug() {} },
        performance: { now: () => 100 },
        CommandGate: { run: (name) => events.push(name) },
        SHELL_SELECTOR: '.meta-shell', SHELL_CLOSE_SELECTOR: '.meta-shell-close',
    };
    const handlers = new Function('ApplicationState', ...Object.keys(dependencies), `${source}\nreturn {
        handleImmediateMouseDown, handleMoveDragMouseDown, handleClick,
        dragContext: () => moduleState.moveDragContext,
    };`).bind(null, ApplicationState)(...Object.values(dependencies));
    return { handlers, events, label, anchor, event: {
        target: label, clientX: 10, clientY: 10, button: 0, type: 'click',
        preventDefault() { events.push('prevent-default'); },
        stopPropagation() { events.push('stop-propagation'); },
    } };
}

test('clicking nested title/domain markup preserves browser navigation and view mode', () => {
    const h = harness(false);
    h.handlers.handleImmediateMouseDown(h.event);
    h.handlers.handleMoveDragMouseDown(h.event);
    h.handlers.handleClick(h.event);
    assert.deepEqual(h.events, []);
    assert.equal(h.handlers.dragContext(), null);
});

test('link guard distinguishes view links from editor links and non-link content', () => {
    assert.equal(isViewModeNoteLink(harness(false).label), true);
    assert.equal(isViewModeNoteLink(harness(true).label), false);
    assert.equal(isViewModeNoteLink({ closest: () => null }), false);
    assert.equal(isViewModeNoteLink(null), false);
});
