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


export class ResetUpdatedAtModal extends BaseModal {
    constructor() {
        super('resetUpdatedAtModal', 'reset-updated-at-modal');
        this._pendingResolve = null;
        this._context = null;
        this._decision = null;

        ApplicationState.own(this, 'ResetUpdatedAtModal', new.target === ResetUpdatedAtModal);
    }

    getInitialModalState() {
        if (this._context === null) {
            throw new Error('ResetUpdatedAtModal requires context before initialization');
        }
        return {
            searchQuery: this._context.searchQuery,
        };
    }

    shouldCloseOnClickOutside() {
        return true;
    }

    validateCleanState() {
        if (ModeContext.isLoading) {
            throw new Error('Cannot open timestamp repair confirmation while application is loading');
        }
        if (ModeContext.modalStack && ModeContext.modalStack.length > 0) {
            const topModal = ModeContext.topModal;
            throw new Error(`Cannot open timestamp repair confirmation while ${topModal} is open`);
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

    openForSearchContext(context) {
        if (!context || typeof context !== 'object') {
            throw new Error('ResetUpdatedAtModal.openForSearchContext requires context object');
        }
        if (typeof context.searchQuery !== 'string') {
            throw new Error('ResetUpdatedAtModal searchQuery must be a string');
        }
        if (this.isOpen) {
            throw new Error('ResetUpdatedAtModal is already open');
        }
        if (this._pendingResolve !== null) {
            throw new Error('ResetUpdatedAtModal already has a pending promise');
        }

        this._context = {
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
            throw new Error('ResetUpdatedAtModal.onKeyDown requires KeyboardEvent');
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
            throw new Error('Reset updated-at modal element missing');
        }

        const state = this.getModalState();
        const searchQuery = typeof state.searchQuery === 'string' ? state.searchQuery : '';
        const scopeLabel = searchQuery.trim() === ''
            ? 'current unfiltered view'
            : `"${searchQuery}" search context`;

        modalElement.innerHTML = `
            <div class="modal-content alphabetize-root-notes-modal-content">
                <div class="prioritize-modal-header">
                    <p class="prioritize-modal-eyebrow">Repair</p>
                    <h3>Set Updated Time to Created Time</h3>
                    <p class="prioritize-modal-description">
                        Reset updated timestamps in the ${escapeHtml(scopeLabel)}.
                    </p>
                </div>

                <div class="alphabetize-root-notes-warning">
                    <p>This overwrites each affected note's updated time with its created time.</p>
                    <p>Cmd+Z cannot undo this action. The undo/redo queue will be cleared.</p>
                    <p>All notes inside matching root subtrees are changed. Notes outside this view are not changed.</p>
                </div>

                <div class="form-actions alphabetize-root-notes-actions">
                    <button type="button" class="secondary-btn" id="reset-updated-at-cancel-btn">Cancel</button>
                    <button type="button" class="danger-btn" id="reset-updated-at-submit-btn">Reset Timestamps</button>
                </div>
            </div>
        `;

        const cancelButton = document.getElementById('reset-updated-at-cancel-btn');
        if (cancelButton instanceof HTMLButtonElement) {
            cancelButton.onclick = () => {
                this.close();
            };
        }
        const submitButton = document.getElementById('reset-updated-at-submit-btn');
        if (submitButton instanceof HTMLButtonElement) {
            submitButton.onclick = () => this.submit();
        }
    }

    submit() {
        this._decision.result = true;
        this.close();
    }
}
