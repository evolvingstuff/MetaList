import { ApplicationState } from '../application-state.js';
import { BaseModal } from './base-modal.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';


function escapeHtml(value) {
    if (typeof value !== 'string') {
        throw new Error('escapeHtml requires string');
    }
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}


export class AlphabetizeRootNotesModal extends BaseModal {
    constructor() {
        super('alphabetizeRootNotesModal', 'alphabetize-root-notes-modal');
        this._pendingResolve = null;
        this._context = null;
        this._decision = null;

        ApplicationState.own(this, 'AlphabetizeRootNotesModal', new.target === AlphabetizeRootNotesModal);
    }

    getInitialModalState() {
        if (this._context === null) {
            throw new Error('AlphabetizeRootNotesModal requires context before initialization');
        }
        return {
            direction: this._context.direction,
            searchQuery: this._context.searchQuery,
        };
    }

    shouldCloseOnClickOutside() {
        return true;
    }

    validateCleanState() {
        if (ModeContext.isLoading) {
            throw new Error('Cannot open alphabetize confirmation while application is loading');
        }
        if (ModeContext.modalStack && ModeContext.modalStack.length > 0) {
            const topModal = ModeContext.topModal;
            throw new Error(`Cannot open alphabetize confirmation while ${topModal} is open`);
        }
    }

    showModalElement() {
        let modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            modalElement = document.createElement('div');
            modalElement.id = this.modalElementId;
            modalElement.className = 'modal';
            modalElement.style.display = 'none';
            document.body.appendChild(modalElement);
        }
        this.renderModalContent();
        modalElement.style.display = 'block';
    }

    openForDirection(context) {
        if (!context || typeof context !== 'object') {
            throw new Error('AlphabetizeRootNotesModal.openForDirection requires context object');
        }
        if (context.direction !== 'asc' && context.direction !== 'desc') {
            throw new Error("AlphabetizeRootNotesModal direction must be 'asc' or 'desc'");
        }
        if (typeof context.searchQuery !== 'string') {
            throw new Error('AlphabetizeRootNotesModal searchQuery must be a string');
        }
        if (this.isOpen) {
            throw new Error('AlphabetizeRootNotesModal is already open');
        }
        if (this._pendingResolve !== null) {
            throw new Error('AlphabetizeRootNotesModal already has a pending promise');
        }

        this._context = {
            direction: context.direction,
            searchQuery: context.searchQuery,
        };
        this._decision = { result: false };
        this.open();
        return new Promise((resolve) => {
            this._pendingResolve = resolve;
        });
    }

    onClose() {
        const resolve = this._pendingResolve;
        const result = this._decision.result;
        this._pendingResolve = null;
        this._decision = null;
        this._context = null;
        if (resolve !== null) {
            resolve(result);
        }
    }

    onKeyDown(event) {
        if (!(event instanceof KeyboardEvent)) {
            throw new Error('AlphabetizeRootNotesModal.onKeyDown requires KeyboardEvent');
        }
        if (event.key !== 'Enter') {
            return;
        }
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLButtonElement) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.submit();
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Alphabetize root notes modal element missing');
        }

        const state = this.getModalState();
        const direction = state.direction;
        if (direction !== 'asc' && direction !== 'desc') {
            throw new Error('Alphabetize root notes modal state missing direction');
        }
        const searchQuery = typeof state.searchQuery === 'string' ? state.searchQuery : '';
        const directionLabel = direction === 'asc' ? 'A-Z' : 'Z-A';
        const scopeLabel = searchQuery.trim() === ''
            ? 'current unfiltered view'
            : `"${searchQuery}" search context`;

        modalElement.innerHTML = `
            <div class="modal-content alphabetize-root-notes-modal-content">
                <div class="prioritize-modal-header">
                    <p class="prioritize-modal-eyebrow">Current View</p>
                    <h3>Alphabetize Root Notes ${directionLabel}</h3>
                    <p class="prioritize-modal-description">
                        Reorder only root-level notes in the ${escapeHtml(scopeLabel)} by note content.
                    </p>
                </div>

                <div class="alphabetize-root-notes-warning">
                    <p>This permanently rearranges stored root note order.</p>
                    <p>Cmd+Z cannot undo this action. The undo/redo queue will be cleared.</p>
                    <p>Child notes and notes outside this view are not reordered.</p>
                </div>

                <div class="form-actions alphabetize-root-notes-actions">
                    <button type="button" class="secondary-btn" id="alphabetize-root-notes-cancel-btn">Cancel</button>
                    <button type="button" class="danger-btn" id="alphabetize-root-notes-submit-btn">Alphabetize ${directionLabel}</button>
                </div>
            </div>
        `;

        const cancelButton = document.getElementById('alphabetize-root-notes-cancel-btn');
        if (cancelButton instanceof HTMLButtonElement) {
            cancelButton.onclick = () => {
                this.close();
            };
        }
        const submitButton = document.getElementById('alphabetize-root-notes-submit-btn');
        if (submitButton instanceof HTMLButtonElement) {
            submitButton.onclick = () => this.submit();
        }
    }

    submit() {
        this._decision.result = true;
        this.close();
    }
}
