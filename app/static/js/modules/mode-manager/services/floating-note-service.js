import { ApplicationState, stateValuesEqual } from '../../application-state.js';
import { NotesAPI } from '../../api-client.js';
import { rethrowUnexpectedError } from '../../expected-errors.js';
import { CommandGate } from './command-gate-service.js';
import { createFloatingNoteElements, applyFloatingNoteRect, getFloatingNoteTitle } from './floating-note-dom.js';
import { constrainFloatingNoteRect, moveFloatingNoteRect } from './floating-note-layout.js';
import { hydrateImageFilePreviews } from './file-image-preview-service.js';
import { ensureAnchorsOpenInNewTabs } from './markdown-render-service.js';
import { queueMermaidDiagramRendering } from './mermaid-render-service.js';
import { hydrateRemoteImageProxies } from './remote-image-proxy-service.js';
import { downloadFileReference } from './file-reference-service.js';
import { copyTextToClipboard, normalizeCopyableText } from '../events/mouse-events.js';
import { openReferenceInNewTab } from '../events/keyboard-events.js';

const moduleState = ApplicationState.createFields('floating-note-service', {
    windows: Object.create(null),
    order: [],
    timer: null,
    refreshing: false,
    gesture: null,
    listening: false,
});
const ISOLATED_EVENTS = Object.freeze([
    'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup',
    'mousemove', 'mouseover', 'mouseout', 'click', 'dblclick', 'contextmenu',
    'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy', 'dragstart',
]);

function viewport() {
    return {width: window.innerWidth, height: window.innerHeight};
}

function bringToFront(id) {
    if (moduleState.order.at(-1) === id) return;
    moduleState.order = [...moduleState.order.filter(existing => existing !== id), id];
    moduleState.order.forEach((windowId, index) => {
        moduleState.windows[windowId].element.style.zIndex = String(2500 + index);
    });
}

function setRect(entry, rect) {
    if (stateValuesEqual(entry.rect, rect)) return;
    entry.rect = rect;
    applyFloatingNoteRect(entry.element, rect);
}

function finishGesture() {
    if (moduleState.gesture === null) return;
    const {id, pointerId} = moduleState.gesture;
    moduleState.gesture = null;
    const entry = moduleState.windows[id];
    if (entry && entry.element.hasPointerCapture(pointerId)) entry.element.releasePointerCapture(pointerId);
}

export function closeFloatingNote(id) {
    if (!Object.hasOwn(moduleState.windows, id)) return;
    if (moduleState.gesture?.id === id) finishGesture();
    moduleState.windows[id].element.remove();
    delete moduleState.windows[id];
    moduleState.order = moduleState.order.filter(existing => existing !== id);
    if (moduleState.order.length === 0) {
        window.clearInterval(moduleState.timer);
        moduleState.timer = null;
        for (const type of ISOLATED_EVENTS) window.removeEventListener(type, handleWindowEvent, true);
        window.removeEventListener('resize', fitWindows);
        window.removeEventListener('blur', finishGesture);
        moduleState.listening = false;
    }
}

export function closeAllFloatingNotes() {
    for (const id of [...moduleState.order]) closeFloatingNote(id);
}

function fitWindows() {
    for (const entry of Object.values(moduleState.windows)) {
        setRect(entry, constrainFloatingNoteRect(entry.rect, viewport()));
    }
}

function startWindowEvents() {
    if (moduleState.listening) return;
    for (const type of ISOLATED_EVENTS) window.addEventListener(type, handleWindowEvent, true);
    window.addEventListener('resize', fitWindows);
    window.addEventListener('blur', finishGesture);
    moduleState.listening = true;
    moduleState.timer = window.setInterval(() => { void refreshFloatingNotes(); }, 500);
}

export async function openFloatingNote(noteId) {
    if (typeof noteId !== 'string' || noteId.length === 0) throw new Error('Floating note requires noteId');
    const mainApp = document.getElementById('main-app');
    if (!(mainApp instanceof HTMLElement)) throw new Error('Floating note requires main app');
    const id = crypto.randomUUID();
    const elements = createFloatingNoteElements(id);
    const offset = (moduleState.order.length % 8) * 28;
    const rect = constrainFloatingNoteRect({x: 80 + offset, y: 90 + offset, width: 460, height: 380}, viewport());
    moduleState.windows[id] = {...elements, noteId, rect, revision: '', markup: ''};
    applyFloatingNoteRect(elements.element, rect);
    mainApp.appendChild(elements.element);
    bringToFront(id);
    startWindowEvents();
    elements.element.focus({preventScroll: true});
    await refreshWindow(id);
    return id;
}

function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object'
        || typeof snapshot.revision !== 'string' || snapshot.revision.length === 0
        || typeof snapshot.html !== 'string'
        || !['ready', 'unchanged', 'deleted'].includes(snapshot.status)) {
        throw new Error('Invalid floating note response');
    }
    if ((snapshot.status === 'ready') !== (snapshot.html.length > 0)) {
        throw new Error('Floating note markup does not match response status');
    }
}

async function refreshWindow(id) {
    const entry = moduleState.windows[id];
    if (!entry) return;
    const snapshot = await NotesAPI.getFloatingNote(entry.noteId, entry.revision).catch(error => {
        rethrowUnexpectedError(error);
        if (Object.hasOwn(moduleState.windows, id)) entry.status.textContent = 'Unable to refresh. Retrying…';
        return null;
    });
    // Closing/logging out during a request must never republish its content.
    if (snapshot === null || !Object.hasOwn(moduleState.windows, id)) return;
    validateSnapshot(snapshot);
    if (entry.revision !== snapshot.revision) entry.revision = snapshot.revision;
    entry.status.textContent = snapshot.status === 'deleted' ? 'This note was deleted.' : '';
    if (snapshot.status === 'deleted') {
        entry.title.textContent = 'Deleted note';
        entry.title.setAttribute('aria-disabled', 'true');
    }
    if (snapshot.status === 'unchanged' || entry.markup === snapshot.html) return;
    entry.markup = snapshot.html;
    const scrollTop = entry.scroll.scrollTop;
    entry.tree.innerHTML = snapshot.html;
    entry.scroll.scrollTop = scrollTop;
    if (snapshot.status === 'ready') {
        entry.title.textContent = `↗ ${getFloatingNoteTitle(entry.tree)}`;
        entry.title.setAttribute('aria-disabled', 'false');
    }
    for (const editable of entry.tree.querySelectorAll('[contenteditable]')) editable.setAttribute('contenteditable', 'false');
    for (const control of entry.tree.querySelectorAll('.meta-status-toggle, .note-shell-run, input, textarea, select')) {
        control.setAttribute('disabled', '');
    }
    ensureAnchorsOpenInNewTabs(entry.tree);
    hydrateImageFilePreviews(entry.tree);
    hydrateRemoteImageProxies(entry.tree);
    await queueMermaidDiagramRendering(entry.tree);
}

export async function refreshFloatingNotes() {
    if (moduleState.refreshing || CommandGate.isBusy() || moduleState.order.length === 0) return;
    moduleState.refreshing = true;
    await Promise.all([...moduleState.order].map(refreshWindow)).finally(() => {
        moduleState.refreshing = false;
    });
}

function handleWindowClick(event, target, id) {
    const title = target.closest('.floating-note-title');
    if (title) {
        event.preventDefault();
        if (title.getAttribute('aria-disabled') === 'true') return;
        void CommandGate.run('floatingNote.source', () => openReferenceInNewTab(moduleState.windows[id].noteId));
        return;
    }
    if (target.closest('.floating-note-close')) {
        event.preventDefault();
        closeFloatingNote(id);
        return;
    }
    const credential = target.closest('.meta-credential-value');
    const copyable = target.closest('.meta-copyable');
    if (credential) {
        event.preventDefault();
        void copyTextToClipboard(credential.dataset.copyValue, credential, 'meta-credential-copied');
        return;
    }
    if (copyable && !target.closest('a') && window.getSelection()?.isCollapsed) {
        event.preventDefault();
        const value = typeof copyable.dataset.copyValue === 'string' ? copyable.dataset.copyValue : copyable.textContent;
        void copyTextToClipboard(normalizeCopyableText(value), copyable, 'meta-copyable-copied');
        return;
    }
    const reference = target.closest('.note-reference-link');
    if (reference) {
        event.preventDefault();
        const container = reference.closest('[data-ref-note-id]');
        if (!container) throw new Error('Floating reference missing target');
        void CommandGate.run('floatingNote.reference', () => openFloatingNote(container.dataset.refNoteId));
        return;
    }
    const file = target.closest('.note-file-reference-link, .note-file-image-download-link');
    if (file) {
        event.preventDefault();
        void CommandGate.run('floatingNote.download', () => downloadFileReference(file.dataset.fileRefId));
    }
}

function handleWindowEvent(event) {
    const path = event.composedPath();
    const host = path.find(node => node instanceof HTMLElement && node.classList.contains('floating-note-window'));
    if (!host) return;
    const id = host.dataset.floatingNoteId;
    const entry = moduleState.windows[id];
    if (!entry) return;
    // Stop main-editor delegates at the window capture phase. Native selection,
    // copying, scrolling and external-link activation retain their defaults.
    event.stopPropagation();
    const target = path.find(node => node instanceof Element);
    if (!target) return;
    if (event.type === 'pointerdown') {
        bringToFront(id);
        if (event.button !== 0 || target.closest('.floating-note-close, .floating-note-title')) return;
        const kind = target.closest('.floating-note-resize') ? 'resize' : 'move';
        if (kind === 'move' && !target.closest('.floating-note-header')) return;
        finishGesture();
        moduleState.gesture = {id, pointerId: event.pointerId, kind, x: event.clientX, y: event.clientY, rect: {...entry.rect}};
        host.setPointerCapture(event.pointerId);
        host.focus({preventScroll: true});
        event.preventDefault();
    } else if (event.type === 'pointermove' && moduleState.gesture?.pointerId === event.pointerId) {
        setRect(entry, moveFloatingNoteRect(moduleState.gesture, event.clientX, event.clientY, viewport()));
    } else if (event.type === 'pointerup' || event.type === 'pointercancel') {
        finishGesture();
    } else if (event.type === 'click') {
        handleWindowClick(event, target, id);
    } else if (event.type === 'keydown') {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeFloatingNote(id);
        } else if (target.closest('.floating-note-resize') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            const width = entry.rect.width + (event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0);
            const height = entry.rect.height + (event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0);
            setRect(entry, constrainFloatingNoteRect({...entry.rect, width, height}, viewport()));
        }
    } else if (['beforeinput', 'paste', 'cut', 'dragstart'].includes(event.type)) {
        event.preventDefault();
    }
}
