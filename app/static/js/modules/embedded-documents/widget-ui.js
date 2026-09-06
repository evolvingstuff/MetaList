import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import { documentRequest, DocumentRequestError } from './document-api.js';
import { CommandGate } from '../mode-manager/services/command-gate-service.js';
import { actionDeselectNote, actionSelectNote } from '../mode-manager/actions/selection-actions.js';
import { actionRefreshAndMaybeSelect } from '../mode-manager/actions/ui-actions.js';
import { sanitizeNoteHtmlForStorage } from '../note-html-sanitizer.js';
import { emptyDiagram, mountDiagramEditor } from './diagram-editor.js';

const editors = new Map([['diagram', { create: emptyDiagram, mount: mountDiagramEditor }]]);
const INSERT_MARKER = '![[NEW-DOCUMENT]]';
let initialized = false;

function fragmentHtml(fragment) {
    const container = document.createElement('div');
    container.append(fragment);
    return sanitizeNoteHtmlForStorage(container.innerHTML);
}

export function captureDocumentInsertion() {
    const noteId = ModeContext.currentNoteId;
    if (!noteId) return { note_id: '', expected_content: '', content: `<div>${INSERT_MARKER}</div>` };
    const content = document.querySelector(`.note[data-note-id="${noteId}"] > .note-content`);
    if (!content) throw new Error('Current note content is missing');
    const expected = sanitizeNoteHtmlForStorage(content.innerHTML);
    const selection = window.getSelection();
    if (selection.rangeCount && content.contains(selection.getRangeAt(0).endContainer)) {
        const caret = selection.getRangeAt(0).cloneRange();
        caret.collapse(false);
        const caretElement = caret.endContainer.nodeType === Node.ELEMENT_NODE
            ? caret.endContainer : caret.endContainer.parentElement;
        const widget = caretElement.closest('.embedded-document');
        if (widget) caret.setStartAfter(widget);
        caret.collapse(true);
        const before = document.createRange();
        before.selectNodeContents(content);
        before.setEnd(caret.endContainer, caret.endOffset);
        const after = document.createRange();
        after.selectNodeContents(content);
        after.setStart(caret.endContainer, caret.endOffset);
        return { note_id: noteId, expected_content: expected,
            content: `${fragmentHtml(before.cloneContents())}<div>${INSERT_MARKER}</div>${fragmentHtml(after.cloneContents())}` };
    }
    return { note_id: noteId, expected_content: expected, content: `${expected}<div>${INSERT_MARKER}</div>` };
}

async function prepareEditor(load) {
    const resumeNoteId = ModeContext.currentNoteId;
    const scrollY = window.scrollY;
    const prepared = await CommandGate.run('document.prepare', async () => {
        if (ModeContext.isEditing) await actionDeselectNote();
        if (ModeContext.isSearching) ModeContext.setSearching(false);
        return { loaded: await load() };
    });
    if (prepared === null) return null;
    return { resumeNoteId, scrollY, loaded: prepared.loaded };
}

export async function insertDiagram(insertion) {
    const returnContext = await prepareEditor(async () => null);
    if (!returnContext) return;
    showDocumentEditor({ documentId: '', noteId: insertion.note_id, document: editors.get('diagram').create(),
        insertion, returnContext });
}

export async function insertDiagramInNote(noteId) {
    const returnContext = await prepareEditor(() => documentRequest(`note-source/${noteId}`, 'GET', null));
    if (!returnContext) return;
    const { content } = returnContext.loaded;
    showDocumentEditor({ documentId: '', noteId, document: editors.get('diagram').create(),
        insertion: { note_id: noteId, expected_content: content, content: `${content}<div>${INSERT_MARKER}</div>` }, returnContext });
}

async function editDocument(block) {
    const note = block.closest('.note[data-note-id]');
    if (!note) throw new Error('Diagram is missing its containing note');
    const noteId = note.dataset.noteId;
    const documentId = block.dataset.documentId;
    const returnContext = await prepareEditor(() => documentRequest(documentId, 'GET', null));
    if (!returnContext) return;
    showDocumentEditor({ documentId, noteId, document: returnContext.loaded, insertion: null, returnContext });
}

function showDocumentEditor({ documentId, noteId, document: source, insertion, returnContext }) {
    const adapter = editors.get(source.kind);
    if (!adapter) throw new Error(`Unsupported embedded document type: ${source.kind}`);
    const dialog = document.createElement('dialog');
    dialog.className = 'modal embedded-document-editor';
    dialog.setAttribute('aria-label', 'Diagram editor');
    dialog.innerHTML = `<div class="modal-content">
        <header class="document-editor-header"><h2>Diagram</h2>
            <div class="document-editor-actions"><button type="button" data-cancel>Cancel</button>
                <button type="button" data-save class="primary-btn">Save</button></div></header>
        <div class="document-editor-body"></div><p class="document-editor-error" role="alert"></p>
        </div>`;
    const state = { draft: structuredClone(source), saving: false };
    if (!ModeContext.modalState) ModeContext.modalState = {};
    ModeContext.modalState.embeddedDocument = state;
    ModeContext.pushModal('embeddedDocument');
    document.body.append(dialog);
    const editor = adapter.mount(dialog.querySelector('.document-editor-body'), state);
    const close = async (savedNoteId) => {
        editor.destroy();
        dialog.close();
        dialog.remove();
        delete ModeContext.modalState.embeddedDocument;
        ModeContext.removeModal('embeddedDocument');
        await CommandGate.run('document.return', async () => {
            if (returnContext.resumeNoteId) {
                await actionSelectNote(returnContext.resumeNoteId, { initialCaretVisibility: 'visible', recordEditInteraction: false });
            } else if (savedNoteId && !documentId && !noteId) {
                await actionSelectNote(savedNoteId, { initialCaretVisibility: 'visible', recordEditInteraction: false });
            } else {
                await actionRefreshAndMaybeSelect({});
            }
            window.scrollTo({ top: returnContext.scrollY, behavior: 'instant' });
        });
    };
    const cancel = () => { if (!state.saving) void close(''); };
    dialog.querySelector('[data-cancel]').addEventListener('click', cancel);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); cancel(); });
    dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            cancel();
        }
        // Enter belongs to canvas/text tools; only an explicit Save commits the draft.
        event.stopPropagation();
    });
    dialog.querySelector('[data-save]').addEventListener('click', async () => {
        if (state.saving) return;
        editor.flush();
        state.saving = true;
        const buttons = Array.from(dialog.querySelectorAll('button'));
        const disabled = buttons.map(button => button.disabled);
        const restoreButtons = () => buttons.forEach((button, index) => { button.disabled = disabled[index]; });
        for (const button of buttons) button.disabled = true;
        dialog.querySelector('.document-editor-body').inert = true;
        const outcome = await CommandGate.run('document.save', async () => {
            const payload = { note_id: noteId, document: state.draft };
            let path = documentId;
            if (documentId) payload.expected_document = source;
            else {
                Object.assign(payload, insertion, { search_query: ModeContext.searchQuery });
                path = 'in-note';
            }
            return await documentRequest(path, documentId ? 'PUT' : 'POST', payload);
        }).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
        if (!outcome.ok) {
            state.saving = false;
            restoreButtons();
            dialog.querySelector('.document-editor-body').inert = false;
            dialog.querySelector('[role="alert"]').textContent = outcome.error.message;
            // Network/HTTP failures are recoverable. Internal errors must still surface.
            if (!(outcome.error instanceof DocumentRequestError)) throw outcome.error;
            return;
        }
        state.saving = false;
        if (outcome.value === null) {
            restoreButtons();
            dialog.querySelector('.document-editor-body').inert = false;
            return;
        }
        await close(outcome.value.note_id);
    });
    dialog.showModal();
    editor.focus();
}

export function initializeDocumentInteractions() {
    if (initialized) return;
    initialized = true;
    // Register before ordinary note mouse handlers; diagram clicks own this gesture.
    document.addEventListener('mousedown', event => {
        if (event.button === 0 && event.target.closest('.embedded-document') && !ModeContext.modalStack.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    document.addEventListener('click', event => {
        const block = event.target.closest('.embedded-document');
        if (!block || ModeContext.modalStack.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void editDocument(block);
    }, true);
    document.addEventListener('keydown', event => {
        const block = event.target.closest('.embedded-document');
        if (block && ['Enter', ' '].includes(event.key) && !ModeContext.modalStack.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
            void editDocument(block);
        }
    }, true);
}
