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


export class ConfirmationModal extends BaseModal {
    constructor() {
        super('confirmationModal', 'confirmation-modal');
        this._pendingResolve = null;
        this._context = null;
        this._decision = null;

        ApplicationState.own(this, 'ConfirmationModal', new.target === ConfirmationModal);
    }

    getInitialModalState() {
        if (this._context === null) {
            throw new Error('ConfirmationModal requires context before initialization');
        }
        return { ...this._context };
    }

    validateCleanState() {
        if (ModeContext.isLoading) {
            throw new Error('Cannot open confirmation while application is loading');
        }
        if (ModeContext.modalStack && ModeContext.modalStack.length > 0) {
            throw new Error(`Cannot open confirmation while ${ModeContext.topModal} is open`);
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

    openForConfirmation(context) {
        if (context === null || typeof context !== 'object') {
            throw new Error('ConfirmationModal.openForConfirmation requires context object');
        }
        for (const fieldName of ['eyebrow', 'title', 'description', 'confirmLabel']) {
            if (typeof context[fieldName] !== 'string' || context[fieldName].length === 0) {
                throw new Error(`ConfirmationModal requires non-empty ${fieldName}`);
            }
        }
        if (typeof context.isDangerous !== 'boolean') {
            throw new Error('ConfirmationModal requires boolean isDangerous');
        }
        if (this.isOpen || this._pendingResolve !== null) {
            throw new Error('ConfirmationModal already has an active confirmation');
        }
        this._context = {
            eyebrow: context.eyebrow,
            title: context.title,
            description: context.description,
            confirmLabel: context.confirmLabel,
            isDangerous: context.isDangerous,
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

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!(modalElement instanceof HTMLElement)) {
            throw new Error('Confirmation modal element missing');
        }
        const state = this.getModalState();
        for (const fieldName of ['eyebrow', 'title', 'description', 'confirmLabel']) {
            if (typeof state[fieldName] !== 'string' || state[fieldName].length === 0) {
                throw new Error(`Confirmation modal state requires ${fieldName}`);
            }
        }
        if (typeof state.isDangerous !== 'boolean') {
            throw new Error('Confirmation modal state requires isDangerous');
        }
        let confirmClass = 'primary-btn';
        if (state.isDangerous) {
            confirmClass = 'danger-btn';
        }
        modalElement.innerHTML = `
            <div class="modal-content alphabetize-root-notes-modal-content">
                <div class="prioritize-modal-header">
                    <p class="prioritize-modal-eyebrow">${escapeHtml(state.eyebrow)}</p>
                    <h3>${escapeHtml(state.title)}</h3>
                </div>
                <div class="alphabetize-root-notes-warning">
                    <p>${escapeHtml(state.description)}</p>
                </div>
                <div class="form-actions alphabetize-root-notes-actions">
                    <button type="button" class="secondary-btn" id="confirmation-cancel-btn">Cancel</button>
                    <button type="button" class="${confirmClass}" id="confirmation-submit-btn" data-modal-enter-action>${escapeHtml(state.confirmLabel)}</button>
                </div>
            </div>
        `;
        const cancelButton = document.getElementById('confirmation-cancel-btn');
        if (!(cancelButton instanceof HTMLButtonElement)) {
            throw new Error('Confirmation cancel button missing');
        }
        cancelButton.onclick = () => {
            this.close();
        };
        const submitButton = document.getElementById('confirmation-submit-btn');
        if (!(submitButton instanceof HTMLButtonElement)) {
            throw new Error('Confirmation submit button missing');
        }
        submitButton.onclick = () => {
            this._decision.result = true;
            this.close();
        };
    }
}
