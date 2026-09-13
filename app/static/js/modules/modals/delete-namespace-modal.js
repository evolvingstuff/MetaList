import { ApplicationState } from '../application-state.js';
import { HttpRequestError } from '../expected-errors.js';
import { BaseModal } from './base-modal.js';
import { CONFIG } from '../config.js';
import { ModeContextInstance as ModeContext } from '../mode-manager/mode-context.js';
import {
    extractDeletableNamespaceNames,
    validateNamespaceDeletionSubmission,
} from './delete-namespace-validation.js';
import { settleResult } from '../async-result.js';
import { rewriteNamespaceUrlPreservingCurrentHost } from '../login-namespace-picker.js';
import { buildSessionHeaders } from '../session-auth.js';


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


function parseResponseError(responseBody, statusCode) {
    if (responseBody && typeof responseBody === 'object') {
        if (typeof responseBody.detail === 'string' && responseBody.detail.length > 0) {
            return `Request failed (${statusCode}): ${responseBody.detail}`;
        }
        if (typeof responseBody.message === 'string' && responseBody.message.length > 0) {
            return `Request failed (${statusCode}): ${responseBody.message}`;
        }
    }
    return `Request failed (${statusCode})`;
}


export class DeleteNamespaceModal extends BaseModal {
    constructor() {
        super('deleteNamespaceModal', 'delete-namespace-modal');
        this.apiEndpoints = {
            list: CONFIG.API.AUTH.NAMESPACES.LIST,
            preflight: CONFIG.API.AUTH.NAMESPACES.DELETE_PREFLIGHT,
            deleteNamespace: CONFIG.API.AUTH.NAMESPACES.DELETE,
        };

        ApplicationState.own(this, 'DeleteNamespaceModal', new.target === DeleteNamespaceModal);
    }

    getInitialModalState() {
        return {
            loading: true,
            deleting: false,
            confirming: false,
            deleted: false,
            namespace: '',
            selectableNamespaces: [],
            targetNamespaceText: '',
            confirmationText: '',
            activeNamespaceDeleted: false,
            redirectNamespaces: [],
            redirectNamespace: '',
            recreatesDefault: false,
            error: '',
            status: 'Loading namespaces...',
            successMessage: '',
        };
    }

    shouldCloseOnClickOutside() {
        return true;
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

    async onOpen() {
        const catalogResult = await settleResult(async () => {
            const catalog = await this._authRequest(this.apiEndpoints.list, 'GET', null);
            const selectableNamespaces = extractDeletableNamespaceNames(catalog);
            this.updateModalState({
                loading: false,
                selectableNamespaces,
                status: '',
                error: '',
            });
        });
        if (!catalogResult.ok) {
            const error = catalogResult.error;
            const message = error instanceof Error ? error.message : 'Failed to load namespaces';
            this.updateModalState({
                loading: false,
                error: message,
                status: '',
            });
        }
        this.renderModalContent();
    }

    onClose() {
    }

    requestClose() {
        const state = this.getModalState();
        if (state.deleted === true) {
            window.location.reload();
            return;
        }
        super.requestClose();
    }

    handleKeyDown(event) {
        const topModal = ModeContext.topModal;
        if (topModal !== this.modalName) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.requestClose();
            return;
        }

        this.onKeyDown(event);
    }

    onKeyDown(event) {
        if (!(event instanceof KeyboardEvent)) {
            throw new Error('DeleteNamespaceModal.onKeyDown requires KeyboardEvent');
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
        const state = this.getModalState();
        if (state && state.confirming) {
            void this.handleSubmit();
            return;
        }
        void this.prepareDeletionConfirmation();
    }

    renderModalContent() {
        const modalElement = document.getElementById(this.modalElementId);
        if (!modalElement) {
            throw new Error(`Modal element missing: ${this.modalElementId}`);
        }

        const state = this.getModalState();
        const loading = Boolean(state.loading);
        const deleting = Boolean(state.deleting);
        const confirming = Boolean(state.confirming);
        const deleted = Boolean(state.deleted);
        const namespace = typeof state.namespace === 'string' ? state.namespace : '';
        const selectableNamespaces = Array.isArray(state.selectableNamespaces) ? state.selectableNamespaces : [];
        const targetNamespaceText = typeof state.targetNamespaceText === 'string' ? state.targetNamespaceText : '';
        const confirmationText = typeof state.confirmationText === 'string' ? state.confirmationText : '';
        const activeNamespaceDeleted = state.activeNamespaceDeleted === true;
        const redirectNamespaces = Array.isArray(state.redirectNamespaces) ? state.redirectNamespaces : [];
        const redirectNamespace = typeof state.redirectNamespace === 'string' ? state.redirectNamespace : '';
        const recreatesDefault = state.recreatesDefault === true;
        const error = typeof state.error === 'string' ? state.error : '';
        const status = typeof state.status === 'string' ? state.status : '';
        const successMessage = typeof state.successMessage === 'string' ? state.successMessage : '';

        if (deleted) {
            if (successMessage.length === 0) {
                throw new Error('Deleted namespace confirmation missing success message');
            }
            modalElement.innerHTML = `
                <div class="modal-content namespace-delete-modal-content">
                    <h3>Delete namespace</h3>
                    <p>${escapeHtml(successMessage)}</p>
                </div>
            `;
            return;
        }

        if (loading) {
            modalElement.innerHTML = `
                <div class="modal-content namespace-delete-modal-content">
                    <h3>Delete namespace</h3>
                    <p class="namespace-delete-status">${escapeHtml(status)}</p>
                    <div class="form-actions">
                        <button type="button" class="secondary-btn" id="delete-namespace-cancel-loading-btn">Cancel</button>
                    </div>
                    <p class="error-message" ${error.length === 0 ? 'style="display:none;"' : ''}>${escapeHtml(error)}</p>
                </div>
            `;
            const cancelButton = document.getElementById('delete-namespace-cancel-loading-btn');
            if (cancelButton instanceof HTMLButtonElement) {
                cancelButton.onclick = () => this.close();
            }
            return;
        }

        if (!confirming) {
            if (selectableNamespaces.length === 0 && error.length === 0) {
                throw new Error('Delete namespace modal has no namespace choices');
            }
            modalElement.innerHTML = `
                <div class="modal-content namespace-delete-modal-content">
                    <h3>Delete namespace</h3>
                    <p>Select the namespace to delete.</p>
                    <div class="form-group">
                        <label for="delete-namespace-target">Namespace</label>
                        <select
                            id="delete-namespace-target"
                        >
                            <option value="">Choose namespace</option>
                            ${selectableNamespaces.map((candidate) => `
                                <option value="${escapeHtml(candidate)}" ${candidate === targetNamespaceText ? 'selected' : ''}>${escapeHtml(candidate)}</option>
                            `).join('')}
                        </select>
                    </div>
                    <div class="form-actions">
                        <button type="button" class="danger-btn" id="delete-namespace-continue-btn">Continue</button>
                        <button type="button" class="secondary-btn" id="delete-namespace-cancel-btn">Cancel</button>
                    </div>
                    <p class="namespace-delete-status">${escapeHtml(status)}</p>
                    <p class="error-message" ${error.length === 0 ? 'style="display:none;"' : ''}>${escapeHtml(error)}</p>
                </div>
            `;
            this.setupFormEventListeners();
            return;
        }

        if (namespace.length === 0) {
            throw new Error('Delete namespace confirmation missing namespace');
        }
        modalElement.innerHTML = `
            <div class="modal-content namespace-delete-modal-content">
                <h3>Delete namespace</h3>
                <div class="namespace-delete-warning">
                    <p>This permanently deletes the namespace, its notes database, file database, backups, and saved ports.</p>
                    <p class="namespace-delete-namespace">Namespace: <strong>${escapeHtml(namespace)}</strong></p>
                    ${activeNamespaceDeleted ? '<p>Because this is the active namespace, choose where MetaList should redirect after deletion.</p>' : ''}
                    <p>Type <span class="namespace-delete-phrase">${escapeHtml(namespace)}</span> to confirm.</p>
                </div>

                ${activeNamespaceDeleted ? `
                    <div class="form-group">
                        <label for="delete-namespace-redirect">Redirect after deletion</label>
                        ${recreatesDefault ? `
                            <p>A fresh <strong>default</strong> namespace will be created because this is the final namespace.</p>
                            <input id="delete-namespace-redirect" type="hidden" value="default" />
                        ` : `
                            <select id="delete-namespace-redirect" ${deleting ? 'disabled' : ''}>
                                ${redirectNamespaces.map((candidate) => `
                                    <option value="${escapeHtml(candidate)}" ${candidate === redirectNamespace ? 'selected' : ''}>${escapeHtml(candidate)}</option>
                                `).join('')}
                            </select>
                        `}
                    </div>
                ` : ''}

                <div class="form-group">
                    <label for="delete-namespace-confirmation">Namespace name</label>
                    <input
                        id="delete-namespace-confirmation"
                        type="text"
                        value="${escapeHtml(confirmationText)}"
                        placeholder="${escapeHtml(namespace)}"
                        autocomplete="off"
                        autocorrect="off"
                        autocapitalize="off"
                        spellcheck="false"
                        ${deleting ? 'disabled' : ''}
                    />
                </div>

                <div class="form-actions">
                    <button type="button" class="danger-btn" id="delete-namespace-submit-btn" ${deleting ? 'disabled' : ''}>
                        Delete namespace
                    </button>
                    <button type="button" class="secondary-btn" id="delete-namespace-back-btn" ${deleting ? 'disabled' : ''}>Back</button>
                </div>

                <p class="namespace-delete-status">${escapeHtml(status)}</p>
                <p class="error-message" ${error.length === 0 ? 'style="display:none;"' : ''}>${escapeHtml(error)}</p>
            </div>
        `;

        this.setupFormEventListeners();
    }

    setupFormEventListeners() {
        const targetInput = document.getElementById('delete-namespace-target');
        if (targetInput instanceof HTMLSelectElement) {
            targetInput.onchange = () => {
                this.updateModalState({
                    targetNamespaceText: targetInput.value,
                    error: '',
                    status: '',
                });
            };
        }

        const continueButton = document.getElementById('delete-namespace-continue-btn');
        if (continueButton instanceof HTMLButtonElement) {
            continueButton.onclick = async () => {
                await this.prepareDeletionConfirmation();
            };
        }

        const confirmationInput = document.getElementById('delete-namespace-confirmation');
        if (confirmationInput instanceof HTMLInputElement) {
            confirmationInput.oninput = () => {
                this.updateModalState({
                    confirmationText: confirmationInput.value,
                    error: '',
                    status: '',
                });
            };
        }

        const redirectInput = document.getElementById('delete-namespace-redirect');
        if (redirectInput instanceof HTMLSelectElement) {
            redirectInput.onchange = () => {
                this.updateModalState({
                    redirectNamespace: redirectInput.value,
                    error: '',
                    status: '',
                });
            };
        }

        const submitButton = document.getElementById('delete-namespace-submit-btn');
        if (submitButton instanceof HTMLButtonElement) {
            submitButton.onclick = async () => {
                await this.handleSubmit();
            };
        }

        const backButton = document.getElementById('delete-namespace-back-btn');
        if (backButton instanceof HTMLButtonElement) {
            backButton.onclick = () => {
                this.updateModalState({
                    confirming: false,
                    namespace: '',
                    confirmationText: '',
                    activeNamespaceDeleted: false,
                    redirectNamespaces: [],
                    redirectNamespace: '',
                    recreatesDefault: false,
                    error: '',
                    status: '',
                });
                this.renderModalContent();
            };
        }

        const cancelButton = document.getElementById('delete-namespace-cancel-btn');
        if (cancelButton instanceof HTMLButtonElement) {
            cancelButton.onclick = () => {
                this.close();
            };
        }
    }

    async prepareDeletionConfirmation() {
        const state = this.getModalState();
        const targetNamespace = typeof state.targetNamespaceText === 'string'
            ? state.targetNamespaceText.trim()
            : '';
        if (targetNamespace.length === 0) {
            this.updateModalState({
                error: 'Enter a namespace to delete',
                status: '',
            });
            this.renderModalContent();
            return;
        }
        this.updateModalState({
            loading: true,
            error: '',
            status: 'Checking namespace...',
        });
        this.renderModalContent();

        const preflightResult = await settleResult(async () => {
            const preflight = await this._authRequest(this.apiEndpoints.preflight, 'POST', {
                target_namespace: targetNamespace,
            });
            if (!preflight || typeof preflight !== 'object') {
                throw new Error('Namespace delete preflight response missing body');
            }
            if (typeof preflight.target_namespace !== 'string' || preflight.target_namespace.length === 0) {
                throw new Error('Namespace delete preflight response missing target_namespace');
            }
            if (typeof preflight.target_exists !== 'boolean') {
                throw new Error('Namespace delete preflight response missing target_exists');
            }
            if (typeof preflight.is_current_namespace !== 'boolean') {
                throw new Error('Namespace delete preflight response missing is_current_namespace');
            }
            if (!Array.isArray(preflight.redirect_namespaces) || preflight.redirect_namespaces.length === 0) {
                throw new Error('Namespace delete preflight response missing redirect_namespaces');
            }
            for (const candidate of preflight.redirect_namespaces) {
                if (typeof candidate !== 'string' || candidate.length === 0) {
                    throw new Error('Namespace delete redirect options must be non-empty strings');
                }
            }
            if (typeof preflight.recreates_default !== 'boolean') {
                throw new Error('Namespace delete preflight response missing recreates_default');
            }
            if (!preflight.target_exists) {
                throw new Error(`Namespace ${preflight.target_namespace} is unavailable`);
            }
            this.updateModalState({
                loading: false,
                confirming: true,
                namespace: preflight.target_namespace,
                targetNamespaceText: preflight.target_namespace,
                confirmationText: '',
                activeNamespaceDeleted: preflight.is_current_namespace,
                redirectNamespaces: preflight.redirect_namespaces,
                redirectNamespace: preflight.redirect_namespaces[0],
                recreatesDefault: preflight.recreates_default,
                error: '',
                status: '',
            });
        });
        if (!preflightResult.ok) {
            const error = preflightResult.error;
            const message = error instanceof Error ? error.message : 'Failed to check namespace';
            this.updateModalState({
                loading: false,
                confirming: false,
                error: message,
                status: '',
            });
        }
        this.renderModalContent();
    }

    async handleSubmit() {
        const state = this.getModalState();
        const payloadResult = await settleResult(() => {
            return validateNamespaceDeletionSubmission({
                namespace: state.namespace,
                confirmationText: state.confirmationText,
                isCurrentNamespace: state.activeNamespaceDeleted === true,
                redirectNamespace: state.redirectNamespace,
            });
        });
        if (!payloadResult.ok) {
            const error = payloadResult.error;
            const message = error instanceof Error ? error.message : 'Invalid namespace deletion request';
            this.updateModalState({
                error: message,
                status: '',
            });
            this.renderModalContent();
            return;
        }
        const payload = {
            ...payloadResult.value,
            target_namespace: state.namespace,
        };

        this.updateModalState({
            deleting: true,
            error: '',
            status: 'Deleting namespace...',
        });
        this.renderModalContent();

        const deleteResult = await settleResult(async () => {
            const response = await this._authRequest(this.apiEndpoints.deleteNamespace, 'POST', payload);
            if (!response || typeof response !== 'object') {
                throw new Error('Namespace delete response missing body');
            }
            if (typeof response.active_namespace_deleted !== 'boolean') {
                throw new Error('Namespace delete response missing active_namespace_deleted');
            }
            if (typeof response.message !== 'string' || response.message.length === 0) {
                throw new Error('Namespace delete response missing message');
            }
            if (!response.active_namespace_deleted) {
                this.updateModalState({
                    deleting: false,
                    confirming: false,
                    deleted: true,
                    namespace: response.deleted_namespace,
                    successMessage: response.message,
                    error: '',
                    status: '',
                });
                this.renderModalContent();
                return;
            }
            if (typeof response.delete_job_id !== 'string' || response.delete_job_id.length === 0) {
                throw new Error('Namespace delete response missing delete_job_id');
            }
            if (typeof response.redirect_url !== 'string' || response.redirect_url.length === 0) {
                throw new Error('Namespace delete response missing redirect_url');
            }
            if (!response.redirect_url.includes(response.delete_job_id)) {
                throw new Error('Namespace delete response missing job redirect state');
            }
            const redirectUrl = rewriteNamespaceUrlPreservingCurrentHost(
                response.redirect_url,
                window.location,
            );
            window.location.replace(redirectUrl);
        });
        if (!deleteResult.ok) {
            const error = deleteResult.error;
            const message = error instanceof Error ? error.message : 'Failed to delete namespace';
            this.updateModalState({
                deleting: false,
                error: message,
                status: '',
            });
            this.renderModalContent();
        }
    }

    _buildAuthHeaders(includeContentType) {
        return buildSessionHeaders(includeContentType);
    }

    async _authRequest(url, method, bodyObject) {
        if (typeof url !== 'string' || url.length === 0) {
            throw new Error('_authRequest requires url string');
        }
        if (typeof method !== 'string' || method.length === 0) {
            throw new Error('_authRequest requires method string');
        }
        if (bodyObject !== null && typeof bodyObject !== 'object') {
            throw new Error('_authRequest bodyObject must be object or null');
        }

        const hasBody = bodyObject !== null;
        const response = await fetch(url, {
            method,
            headers: this._buildAuthHeaders(hasBody),
            body: hasBody ? JSON.stringify(bodyObject) : undefined,
        });

        let payload = null;
        const contentType = response.headers.get('content-type');
        if (typeof contentType === 'string' && contentType.includes('application/json')) {
            payload = await response.json();
        }

        if (!response.ok) {
            throw new HttpRequestError(parseResponseError(payload, response.status));
        }
        return payload;
    }
}
